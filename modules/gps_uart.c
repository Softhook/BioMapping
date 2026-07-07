// GPS UART — NMEA parser for Bio Mapping.
// Single-byte-per-IRQ RX pattern, adapted from ezod/flipperzero-gps.

#include "gps_uart.h"
#include "../biomap_events.h"

#include <furi.h>
#include <furi_hal.h>
#include <notification/notification_messages.h>
#include <expansion/expansion.h>
#include <math.h>
#include <string.h>

#define RX_LINE_BUF  1024      // max NMEA line length (~80 in practice)

struct GpsUart {
    GpsStatus            status;
    FuriMutex*           status_mutex;  // protects status field
    FuriHalSerialHandle* serial_handle;
    FuriStreamBuffer*    rx_stream;
    uint8_t              rx_buf[RX_LINE_BUF];
    size_t               rx_offset;
    FuriMessageQueue*    event_queue;
    NotificationApp*     notifications;   // caller-owned
    bool                 ready;
    volatile bool        rx_pending;
    uint32_t             last_valid_nmea_tick;  // watchdog: last successful $Gx parse
};

// UART IRQ — fires per received byte (ISR context).
// Posts a single EventTypeUart to the main queue; subsequent bytes are
// drained in gps_uart_process_rx() so the queue doesn't overflow.
static void gps_uart_irq_cb(
    FuriHalSerialHandle* handle,
    FuriHalSerialRxEvent event,
    void* context) {
    UNUSED(handle);
    GpsUart* g = (GpsUart*)context;
    if(event == FuriHalSerialRxEventData) {
        uint8_t data = furi_hal_serial_async_rx(handle);
        furi_stream_buffer_send(g->rx_stream, &data, 1, 0);
        if(!g->rx_pending) {
            g->rx_pending = true;
            PluginEvent ev = {.type = EventTypeUart};
            furi_message_queue_put(g->event_queue, &ev, 0);
        }
    }
}

// ── WDOP helper: compute Weighted DOP from active PRN elevations. ────────
// WDOP = sqrt(Σ 1/sin²(elevationᵢ)) for all active satellites.
// Satellites near the horizon (low elevation) are up to 4× noisier than
// overhead ones.  WDOP captures this; HDOP is blind to it.
//
// Tries each active PRN against three constellation offsets to handle the
// case where GPS (offset 0), BeiDou (offset 64), and GLONASS (offset 128)
// PRNs overlap in GNGSA.  Uses the first offset that has elevation data.
// If no elevation data is available, WDOP stays at 99.9 (sentinel).
static void gps_compute_wdop(GpsUart* g) {
    float sum_inv_sin2 = 0.0f;
    int   used = 0;

    for(int i = 0; i < g->status.active_prn_count && i < 12; i++) {
        int prn = g->status.active_prns[i];
        int8_t elev = 0;

        // Try GPS offset (0), BeiDou offset (64), GLONASS offset (128)
        if(prn < 64 && g->status.sat_elevation[prn]) {
            elev = g->status.sat_elevation[prn];
        } else if(prn < 64 && g->status.sat_elevation[prn + 64]) {
            elev = g->status.sat_elevation[prn + 64];
        } else if(g->status.sat_elevation[prn + 128]) {
            elev = g->status.sat_elevation[prn + 128];
        }

        if(elev > 0) {
            float sin_e = sinf((float)elev * (float)M_PI / 180.0f);
            if(sin_e > 0.01f) {
                sum_inv_sin2 += 1.0f / (sin_e * sin_e);
                used++;
            }
        }
    }
    g->status.wdop = (used > 0) ? sqrtf(sum_inv_sin2) : 99.9f;
}

// NMEA sentence dispatcher
static void gps_uart_parse_line(GpsUart* g, char* line) {
    // Log proprietary PCAS messages for configuration debugging (SBAS status, etc.)
    if(strncmp(line, "$PCAS", 5) == 0) {
        FURI_LOG_D("GpsUart", "PCAS Response: %s", line);
        return;
    }

    switch(minmea_sentence_id(line, false)) {
    case MINMEA_SENTENCE_RMC: {
        struct minmea_sentence_rmc frame;
        if(minmea_parse_rmc(&frame, line)) {
            g->status.fix_valid = frame.valid;
            // Only trust coordinates, speed, and course when the RMC
            // validity flag is 'A'.  Void RMC sentences have empty
            // fields that minmea_tofloat/mimmea_tocoord turn into NaN,
            // which would overwrite good values from a prior GGA sentence.
            // Time and date are still set — they're useful for timestamp
            // fallback even on void frames.
            if(frame.valid) {
                g->status.latitude  = minmea_tocoord(&frame.latitude);
                g->status.longitude = minmea_tocoord(&frame.longitude);
                g->status.speed     = minmea_tofloat(&frame.speed);
                g->status.course    = minmea_tofloat(&frame.course);
            }
            g->status.time = frame.time;
            g->status.date = frame.date;
            g->last_valid_nmea_tick = furi_get_tick();
        }
    } break;

    case MINMEA_SENTENCE_GGA: {
        struct minmea_sentence_gga frame;
        if(minmea_parse_gga(&frame, line)) {
            g->status.latitude           = minmea_tocoord(&frame.latitude);
            g->status.longitude          = minmea_tocoord(&frame.longitude);
            g->status.altitude           = minmea_tofloat(&frame.altitude);
            g->status.satellites_tracked = frame.satellites_tracked;
            g->status.fix_quality        = frame.fix_quality;
            // Only overwrite HDOP when the field is present — minmea_tofloat
            // returns NaN for empty fields, which would clobber a good reading
            // from a prior GSA sentence.
            float gga_hdop = minmea_tofloat(&frame.hdop);
            if(!isnan(gga_hdop)) g->status.hdop = gga_hdop;
            g->status.time               = frame.time;
            g->last_valid_nmea_tick = furi_get_tick();
        }
    } break;

    case MINMEA_SENTENCE_GSA: {
        struct minmea_sentence_gsa frame;
        if(minmea_parse_gsa(&frame, line)) {
            // Log GSA talker prefix on first sighting to confirm whether
            // the L76K emits individual ($GPGSA/$BDGSA) or combined
            // ($GNGSA).  Individual GSA eliminates PRN collision.
            static bool gsa_talker_logged = false;
            if(!gsa_talker_logged) {
                gsa_talker_logged = true;
                FURI_LOG_I("GpsUart", "First GSA talker: %c%c",
                           line[1], line[2]);
            }
            // GSA gives the authoritative DOP values and distinguishes
            // 2D (fix_type=2) from 3D (fix_type=3).  GGA HDOP is kept
            // as primary when GSA hasn't arrived yet; GSA overwrites only
            // when the field is present (non-NaN) to avoid clobbering a
            // good reading from a previous sentence.
            g->status.fix_type = frame.fix_type;
            float gsa_hdop = minmea_tofloat(&frame.hdop);
            float gsa_vdop = minmea_tofloat(&frame.vdop);
            if(!isnan(gsa_hdop)) g->status.hdop = gsa_hdop;
            if(!isnan(gsa_vdop)) g->status.vdop = gsa_vdop;
            g->last_valid_nmea_tick = furi_get_tick();

            // Check if any tracked satellite is an SBAS bird (PRN >= 120).
            g->status.sbas_active = false;
            for(int i = 0; i < 12 && frame.sats[i]; i++) {
                if(frame.sats[i] >= 120) {
                    g->status.sbas_active = true;
                    break;
                }
            }

            // Store active PRNs for WDOP recomputation when the next GSV
            // cycle completes.  PRNs can be up to 197 (QZSS) or 158 (SBAS)
            // so use int, not int8_t.
            int j = 0;
            for(int i = 0; i < 12 && frame.sats[i] && j < 12; i++) {
                g->status.active_prns[j++] = frame.sats[i];
            }
            g->status.active_prn_count = j;
            gps_compute_wdop(g);
        }
    } break;

    case MINMEA_SENTENCE_GSV: {
        // ── Parse GSV for per-satellite elevation angles ──────────────
        struct minmea_sentence_gsv frame;
        if(minmea_parse_gsv(&frame, line)) {
            // Log the GSV talker prefix on first sighting so we can
            // confirm the L76K emits constellation-specific GSV
            // ($GPGSV / $BDGSV / $GLGSV) rather than $GNGSV.
            static bool gsv_talker_logged = false;
            if(!gsv_talker_logged) {
                gsv_talker_logged = true;
                FURI_LOG_I("GpsUart", "First GSV talker: %c%c",
                           line[1], line[2]);
            }
            g->last_valid_nmea_tick = furi_get_tick();

            // Determine constellation offset from talker prefix.
            // $GPGSV → GPS (0), $BDGSV/$GBGSV → BeiDou (64),
            // $GLGSV → GLONASS (128), $GAGSV → Galileo (192).
            int offset = 0;
            if(line[1] == 'G') {
                if(line[2] == 'P')      offset = 0;    // GPS
                else if(line[2] == 'L') offset = 128;  // GLONASS
                else if(line[2] == 'B' || line[2] == 'D')
                                        offset = 64;   // BeiDou
                else if(line[2] == 'A') offset = 192;  // Galileo
            }

            for(int i = 0; i < 4; i++) {
                int prn = frame.sats[i].nr;
                if(prn > 0) {
                    int idx = offset + prn;
                    if(idx >= 0 && idx < 256) {
                        g->status.sat_elevation[idx] =
                            (int8_t)frame.sats[i].elevation;
                    }
                }
            }

            // When the GSV cycle completes, recompute WDOP from the
            // fresh elevations and the stored active PRN set.  This
            // handles the race where GSA arrives between GSV messages.
            if(frame.msg_nr == frame.total_msgs) {
                g->status.gsv_fresh = true;
                gps_compute_wdop(g);
            }
        }
    } break;

    case MINMEA_SENTENCE_GLL: {
        // GLL is disabled in the current PCAS config, but guard the validity
        // flag here so stale/void sentences never overwrite good coordinates.
        struct minmea_sentence_gll gll_frame;
        if(minmea_parse_gll(&gll_frame, line) && gll_frame.status == MINMEA_GLL_STATUS_DATA_VALID) {
            g->status.latitude  = minmea_tocoord(&gll_frame.latitude);
            g->status.longitude = minmea_tocoord(&gll_frame.longitude);
            g->status.time      = gll_frame.time;
        }
    } break;

    default:
        break;
    }
}

// ---------------------------------------------------------------------------
// Alloc — acquire USART1, init serial, configure GPS
// ---------------------------------------------------------------------------
static void gps_uart_configure(GpsUart* g);
GpsUart* gps_uart_alloc(FuriMessageQueue* event_queue, NotificationApp* notifications) {
    GpsUart* g = malloc(sizeof(GpsUart));
    furi_assert(g);

    g->event_queue   = event_queue;
    g->notifications = notifications;
    g->rx_offset     = 0;
    g->ready         = false;
    g->rx_pending    = false;
    g->status_mutex  = furi_mutex_alloc(FuriMutexTypeNormal);
    furi_assert(g->status_mutex);

    g->status = (GpsStatus){
        .latitude           = NAN,
        .longitude          = NAN,
        .altitude           = 0.0f,
        .speed              = NAN,
        .course             = NAN,
        .hdop               = 99.9f,
        .vdop               = 99.9f,
        .fix_quality        = 0,
        .fix_type           = 1,
        .satellites_tracked = 0,
        .fix_valid          = false,
        .sbas_active        = false,
        .wdop               = 99.9f,
        .gsv_fresh          = false,
        .active_prn_count   = 0,
        .time               = {0},
        .date               = {0},
    };
    memset(g->status.sat_elevation, 0, sizeof(g->status.sat_elevation));
    memset(g->status.active_prns, 0, sizeof(g->status.active_prns));
    g->last_valid_nmea_tick = 0;

    g->rx_stream = furi_stream_buffer_alloc(GPS_RX_BUF_SIZE, 1);

    // Disable Expansion Service to free USART1 (re-enabled in free)
    Expansion* expansion = furi_record_open(RECORD_EXPANSION);
    expansion_disable(expansion);
    furi_record_close(RECORD_EXPANSION);

    g->serial_handle = furi_hal_serial_control_acquire(GPS_UART_CH);
    if(g->serial_handle) {
        furi_hal_serial_init(g->serial_handle, GPS_BAUD_RATE);
        furi_hal_serial_async_rx_start(g->serial_handle, gps_uart_irq_cb, g, false);
        g->ready = true;
        gps_uart_configure(g);
    } else {
        FURI_LOG_E("GpsUart", "Failed to acquire USART1");
    }

    return g;
}

// ---------------------------------------------------------------------------
// Free — release serial, re-enable Expansion Service
// ---------------------------------------------------------------------------
void gps_uart_free(GpsUart* g) {
    furi_assert(g);
    if(g->serial_handle) {
        furi_hal_serial_async_rx_stop(g->serial_handle);
        furi_hal_serial_deinit(g->serial_handle);
        furi_hal_serial_control_release(g->serial_handle);
    }
    Expansion* expansion = furi_record_open(RECORD_EXPANSION);
    expansion_enable(expansion);
    furi_record_close(RECORD_EXPANSION);
    furi_stream_buffer_free(g->rx_stream);
    furi_mutex_free(g->status_mutex);
    free(g);
}

// ---------------------------------------------------------------------------
// Status accessors
// ---------------------------------------------------------------------------
GpsStatus gps_uart_get_status(const GpsUart* g) {
    furi_assert(g);
    furi_mutex_acquire(g->status_mutex, FuriWaitForever);
    GpsStatus s = g->status;
    furi_mutex_release(g->status_mutex);
    return s;
}

bool gps_uart_is_ready(const GpsUart* g) {
    furi_assert(g);
    return g->ready;
}

// ---------------------------------------------------------------------------
// Helper — send a PCAS command over the GPS UART
// ---------------------------------------------------------------------------
static void pcas_tx(GpsUart* g, const char* cmd) {
    furi_hal_serial_tx(g->serial_handle, (const uint8_t*)cmd, strlen(cmd));
    furi_delay_ms(100);
}

// ---------------------------------------------------------------------------
// Drain RX stream, parse complete NMEA lines; run NMEA watchdog
// ---------------------------------------------------------------------------
void gps_uart_process_rx(GpsUart* g) {
    furi_assert(g);
    if(!g->ready) return;
    // Clear rx_pending BEFORE draining so that any new byte arriving from the
    // ISR mid-drain sets it true again and posts a fresh UART event to the queue.
    // If cleared AFTER the drain, an ISR byte arriving mid-drain would see
    // rx_pending=true (suppressing a new queue event) and then be left with no
    // event to trigger a follow-up drain — silently deferring until the next IRQ.
    g->rx_pending = false;

    size_t len;
    do {
        if(sizeof(g->rx_buf) - 1 - g->rx_offset == 0) {
            FURI_LOG_W("GpsUart", "RX buffer full — resetting");
            g->rx_offset = 0;
            gps_uart_send_hot_start(g);
        }

        len = furi_stream_buffer_receive(
            g->rx_stream,
            g->rx_buf + g->rx_offset,
            sizeof(g->rx_buf) - 1 - g->rx_offset,
            0);

        if(len > 0) {
            g->rx_offset += len;
            char* line = (char*)g->rx_buf;
            char* end  = (char*)g->rx_buf + g->rx_offset;

            // Parse each complete line, holding status_mutex only for the
            // brief status update — not for the entire drain.
            furi_mutex_acquire(g->status_mutex, FuriWaitForever);
            while(line < end) {
                char* nl = memchr(line, '\n', end - line);
                if(nl) {
                    *nl = '\0';
                    gps_uart_parse_line(g, line);
                    line = nl + 1;
                } else {
                    break;
                }
            }
            furi_mutex_release(g->status_mutex);

            if(line > (char*)g->rx_buf) {
                size_t remaining = end - line;
                memmove(g->rx_buf, line, remaining);
                g->rx_offset = remaining;
            }
        }
    } while(len > 0);

    // ── NMEA watchdog: if no valid sentence parsed in 5 seconds, ──────
    // the GPS module may be disconnected or malfunctioning.  Log a
    // warning and attempt a hot-start reset.  Baud recovery is deferred
    // to Phase 2 (when we actually switch to 115200 and know the correct
    // PCAS01 mapping for the L76K).
    if(g->last_valid_nmea_tick > 0) {
        uint32_t elapsed = furi_get_tick() - g->last_valid_nmea_tick;
        if(elapsed > furi_kernel_get_tick_frequency() * 5) {
            FURI_LOG_W("GpsUart", "NMEA watchdog: no valid sentence in 5 s");
            gps_uart_send_hot_start(g);
            g->last_valid_nmea_tick = 0;
        }
    }
}

// ---------------------------------------------------------------------------
// Send init sequence: constellations, NMEA filter, 2 Hz rate (9600 baud).
// Baud upgrade to 115200 is deferred to Phase 2 — 2 Hz at 9600 baud
// is only 44 % utilisation (GGA+RMC+GSA ≈ 210 bytes/epoch, 2 Hz = 420 B/s,
// 9600 baud ceiling ≈ 960 B/s).  Safe without the baud switch.
// ---------------------------------------------------------------------------
static void gps_uart_configure(GpsUart* g) {
    furi_assert(g);
    if(!g->ready || !g->serial_handle) return;
    FURI_LOG_I("GpsUart", "Configuring GPS at 9600 baud, 2 Hz");
    pcas_tx(g, "$PCAS04,7*1E\r\n");                             // GPS+BeiDou+GLONASS (L76KB-A58 supports all three)
    pcas_tx(g, "$PCAS03,1,0,1,0,1,1,0,0,0,0,,,0,0*02\r\n");   // GGA+GSA+RMC+GSV
    pcas_tx(g, "$PCAS02,500*1A\r\n");                           // 2 Hz update rate
    pcas_tx(g, "$PCAS06,1,1*07\r\n");                           // Force-enable SBAS corrections (WAAS/EGNOS)
}

// ---------------------------------------------------------------------------
// Hot Start reset
// ---------------------------------------------------------------------------
void gps_uart_send_hot_start(GpsUart* g) {
    furi_assert(g);
    if(!g->ready || !g->serial_handle) return;
    FURI_LOG_I("GpsUart", "Hot Start reset");
    pcas_tx(g, "$PCAS10,0*1C\r\n");
}

