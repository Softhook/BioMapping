// GPS UART — NMEA parser for Bio Mapping.
// Single-byte-per-IRQ RX pattern, adapted from ezod/flipperzero-gps.

#include "gps_uart.h"
#include "../biomap_config.h"
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
    struct minmea_time   last_epoch_time;
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

// ── Constellation offset helper: maps a talker ID + raw PRN to the internal elevation array index ─────
static int gps_get_constellation_offset(const char* talker_id, int prn) {
    // GPS / SBAS / QZSS: GP talker (spec Table 2)
    // QZSS always uses GP talker with PRNs 193-197 (Table 16)
    if(talker_id[0] == 'G' && talker_id[1] == 'P') return 0;

    // GLONASS: GL — spec Table 16: IDs 65-88
    if(talker_id[0] == 'G' && talker_id[1] == 'L') return 300 - 65;

    // BeiDou: BD or GB — spec Table 16: IDs 1-63
    if((talker_id[0] == 'B' && talker_id[1] == 'D') ||
       (talker_id[0] == 'G' && talker_id[1] == 'B')) {
        return 210;
    }

    // Galileo: GA — spec Table 16: IDs 1-36
    // Offset 350 places Galileo indices at 351-386, clear of all other bands.
    if(talker_id[0] == 'G' && talker_id[1] == 'A') return 350;

    // Combined / Multi-constellation fallback: GN
    // Per spec §2.2.3, GSV never uses GN talker on L76K — each constellation
    // gets its own talker (GP/GL/BD/GA). This branch only fires for GSA on GN
    // talker without a SystemID field (shouldn't happen on L76K/M10Q firmware
    // because we explicitly map SystemID to a talker before calling here).
    // GPS (1-32) and BeiDou (1-63) overlap — cannot be resolved here, so
    // PRNs 1-32 are treated as GPS in this fallback. Use SystemID for accuracy.
    if(talker_id[0] == 'G' && talker_id[1] == 'N') {
        if(prn >= 193 && prn <= 197) return 0;         // QZSS (spec Table 16: 193-197, GP-offset)
        if(prn >= 120 && prn <= 158) return 0;         // SBAS (treat as GPS offset)
        if(prn >= 65  && prn <= 88)  return 300 - 65;  // GLONASS (spec Table 16: 65-88)
        if(prn >= 33  && prn <= 63)  return 210;        // BeiDou unambiguous range (33-63)
        if(prn >= 1   && prn <= 32)  return 0;          // GPS/BeiDou overlap: default to GPS
    }
    return 0;
}

// ── WDOP helper: compute Weighted DOP from active PRN elevations. ────────
// WDOP = sqrt(Σ 1/sin²(elevationᵢ)) for all active satellites.
// Satellites near the horizon (low elevation) are up to 4× noisier than
// overhead ones.  WDOP captures this; HDOP is blind to it.
//
// Since active_prns now stores constellation-offset PRNs directly,
// we can do a direct single lookup in sat_elevation.
static void gps_compute_wdop(GpsUart* g) {
    float sum_inv_sin2 = 0.0f;
    int   used = 0;

    for(int i = 0; i < g->status.active_prn_count && i < 32; i++) {
        int prn = g->status.active_prns[i];
        int8_t elev = 0;

        if(prn >= 0 && prn < 512) {
            elev = g->status.sat_elevation[prn];
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
    // Log proprietary PCAS messages for configuration debugging.
    if(strncmp(line, "$PCAS", 5) == 0) {
        FURI_LOG_D("GpsUart", "PCAS Response: %s", line);
        return;
    }

    switch(minmea_sentence_id(line, false)) {
    case MINMEA_SENTENCE_RMC: {
        struct minmea_sentence_rmc frame;
        if(minmea_parse_rmc(&frame, line)) {
            g->status.fix_valid = frame.valid;
            // Trust coordinates only when:
            //   - RMC Status = 'A' (data valid)
            //   - ModeInd is NOT 'E' (dead-reckoning/estimated) or 'N' (no fix)
            // ModeInd 'E' means the position is calculated from motion model,
            // not satellite observations — logging it would corrupt the track.
            // ModeInd '\0' means field absent (older NMEA 2.1) — treat as OK.
            // Spec §2.2.1: A=autonomous, D=differential, E=estimated, N=no fix.
            char mi = frame.mode_indicator;
            bool position_ok = frame.valid && (mi != 'E') && (mi != 'N');
            if(position_ok) {
                g->status.latitude  = minmea_tocoord(&frame.latitude);
                g->status.longitude = minmea_tocoord(&frame.longitude);
                g->status.speed     = minmea_tofloat(&frame.speed);
                g->status.course    = minmea_tofloat(&frame.course);
            }
            g->status.time = frame.time;
            g->status.date = frame.date;
            g->last_valid_nmea_tick = furi_get_tick();

            // Clear active PRNs for the new epoch if time has changed
            if(frame.time.hours != g->last_epoch_time.hours ||
               frame.time.minutes != g->last_epoch_time.minutes ||
               frame.time.seconds != g->last_epoch_time.seconds ||
               frame.time.microseconds != g->last_epoch_time.microseconds) {
                g->last_epoch_time = frame.time;
                g->status.active_prn_count = 0;
            }
        }
    } break;

    case MINMEA_SENTENCE_GGA: {
        struct minmea_sentence_gga frame;
        if(minmea_parse_gga(&frame, line)) {
            // Only trust GGA position when we actually have a fix.
            // Without this guard, a GGA arriving before RMC in a new
            // epoch would overwrite good coordinates with 0.0.
            if(frame.fix_quality > 0) {
                g->status.latitude  = minmea_tocoord(&frame.latitude);
                g->status.longitude = minmea_tocoord(&frame.longitude);
                g->status.altitude  = minmea_tofloat(&frame.altitude);
            }
            g->status.satellites_tracked = frame.satellites_tracked;
            g->status.fix_quality        = frame.fix_quality;
            // Only overwrite HDOP when the field is present — minmea_tofloat
            // returns NaN for empty fields, which would clobber a good reading
            // from a prior GSA sentence.
            float gga_hdop = minmea_tofloat(&frame.hdop);
            if(!isnan(gga_hdop)) g->status.hdop = gga_hdop;
            g->status.time               = frame.time;
            g->last_valid_nmea_tick = furi_get_tick();

            // Clear active PRNs for the new epoch if time has changed
            if(frame.time.hours != g->last_epoch_time.hours ||
               frame.time.minutes != g->last_epoch_time.minutes ||
               frame.time.seconds != g->last_epoch_time.seconds ||
               frame.time.microseconds != g->last_epoch_time.microseconds) {
                g->last_epoch_time = frame.time;
                g->status.active_prn_count = 0;
            }
        }
    } break;

    case MINMEA_SENTENCE_GSA: {
        struct minmea_sentence_gsa frame;
        if(minmea_parse_gsa(&frame, line)) {
            // Log SystemID on first sighting — both L76K and u-blox M10Q emit
            // one $GNGSA per constellation per epoch, distinguished by the trailing
            // SystemID field (1=GPS, 2=GLONASS, 3=Galileo, 4=BeiDou, 5=QZSS)
            // rather than by TalkerID.
            static bool gsa_talker_logged = false;
            if(!gsa_talker_logged) {
                gsa_talker_logged = true;
                FURI_LOG_I("GpsUart", "First GSA talker: %c%c SystemID=%d",
                           line[1], line[2], frame.system_id);
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

            // Map PRNs to constellation-offset indices using SystemID — this is
            // authoritative on both L76K and u-blox M10Q:
            //   1=GPS, 2=GLONASS, 3=Galileo, 4=BeiDou, 5=QZSS.
            // Fall back to TalkerID heuristic only when SystemID is absent (=0).
            // QZSS (SystemID=5) uses GP talker with PRNs 193-197 — same offset as GPS.
            // IMPORTANT: Galileo PRNs (1-36) overlap GPS PRNs (1-32). Without the
            // explicit system_id==3 branch, GN-talker fallback would map Galileo
            // satellites to GPS offset 0, silently corrupting sat_elevation and WDOP.
            char talker_id[2];
            if(frame.system_id == 2) {
                talker_id[0] = 'G'; talker_id[1] = 'L'; // GLONASS
            } else if(frame.system_id == 3) {
                talker_id[0] = 'G'; talker_id[1] = 'A'; // Galileo — offset 350
            } else if(frame.system_id == 4) {
                talker_id[0] = 'B'; talker_id[1] = 'D'; // BeiDou
            } else {
                // GPS (SystemID=1), QZSS (SystemID=5), or unknown (0).
                // Both GPS and QZSS use GP talker — offset function returns 0 for both.
                talker_id[0] = line[1]; talker_id[1] = line[2];
            }

            for(int i = 0; i < 12 && frame.sats[i]; i++) {
                int raw_prn = frame.sats[i];
                int offset = gps_get_constellation_offset(talker_id, raw_prn);
                int prn_with_offset = raw_prn + offset;

                // Add to active_prns list if not already present
                bool found = false;
                for(int k = 0; k < g->status.active_prn_count; k++) {
                    if(g->status.active_prns[k] == prn_with_offset) {
                        found = true;
                        break;
                    }
                }
                if(!found && g->status.active_prn_count < 32) {
                    g->status.active_prns[g->status.active_prn_count++] = prn_with_offset;
                }
            }
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

            // Determine constellation offset. Uses talker prefix and PRN range.
            char talker_id[2] = {line[1], line[2]};

            for(int i = 0; i < 4; i++) {
                int prn = frame.sats[i].nr;
                if(prn > 0) {
                    int offset = gps_get_constellation_offset(talker_id, prn);
                    int idx = offset + prn;
                    if(idx >= 0 && idx < 512) {
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

#if GPS_MODULE == GPS_MODULE_L76K
// ---------------------------------------------------------------------------
// Helper — send a PCAS command over the GPS UART (L76K only)
// ---------------------------------------------------------------------------
static void pcas_tx(GpsUart* g, const char* cmd) {
    furi_hal_serial_tx(g->serial_handle, (const uint8_t*)cmd, strlen(cmd));
    furi_delay_ms(100);
}
#endif

#if GPS_MODULE == GPS_MODULE_M10Q
// ---------------------------------------------------------------------------
// Helper — send a binary UBX packet over the GPS UART (M10Q only)
// ---------------------------------------------------------------------------
static void ubx_tx(GpsUart* g, const uint8_t* data, size_t len) {
    furi_hal_serial_tx(g->serial_handle, data, len);
    furi_delay_ms(100);
}
#endif

#if GPS_MODULE == GPS_MODULE_M10Q
// ── Binary UBX configuration packets for M10Q ──────────────────────────────
static const uint8_t ubx_cfg_rate_5hz[] = {
    0xB5, 0x62, 0x06, 0x08, 0x06, 0x00, 0xC8, 0x00, 0x01, 0x00, 0x01, 0x00, 0xDE, 0x6A
};
static const uint8_t ubx_cfg_msg_gll_off[] = {
    0xB5, 0x62, 0x06, 0x01, 0x03, 0x00, 0xF0, 0x03, 0x00, 0xFD, 0x15
};
static const uint8_t ubx_cfg_msg_vtg_off[] = {
    0xB5, 0x62, 0x06, 0x01, 0x03, 0x00, 0xF0, 0x09, 0x00, 0x03, 0x21
};
static const uint8_t ubx_cfg_msg_gsv_1hz[] = {
    0xB5, 0x62, 0x06, 0x01, 0x03, 0x00, 0xF0, 0x07, 0x05, 0x06, 0x22
};
static const uint8_t ubx_cfg_nav5_pedestrian[] = {
    0xB5, 0x62, 0x06, 0x24, 0x28, 0x00, 0x01, 0x00, 0x03, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x56, 0x3E
};
static const uint8_t ubx_cfg_rst_hot[] = {
    0xB5, 0x62, 0x06, 0x04, 0x04, 0x00, 0x00, 0x00, 0x02, 0x00, 0x10, 0x68
};
#endif

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
            FURI_LOG_W("GpsUart", "RX buffer full — reconfiguring");
            g->rx_offset = 0;
            // Full reconfiguration (same as watchdog): switch host
            // back to 9600, then re-run the module init sequence.
            // A plain hot-start would leave the module at default
            // baud rate (9600 on M10Q) while the host is at 115200.
            furi_hal_serial_async_rx_stop(g->serial_handle);
            furi_hal_serial_deinit(g->serial_handle);
            furi_hal_serial_init(g->serial_handle, GPS_BAUD_RATE);
            furi_stream_buffer_reset(g->rx_stream);
            furi_hal_serial_async_rx_start(g->serial_handle, gps_uart_irq_cb, g, false);
            furi_delay_ms(100);
            gps_uart_configure(g);
            g->last_valid_nmea_tick = 0;
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
    // the GPS module may be disconnected or malfunctioning.  A hot-start
    // reset reverts the module to factory defaults (9600 baud on M10Q;
    // L76K retains persisted baud).  Switch the host back to 9600 and
    // re-run the full configure sequence to restore 115200 + settings.
    if(g->last_valid_nmea_tick > 0) {
        uint32_t elapsed = furi_get_tick() - g->last_valid_nmea_tick;
        if(elapsed > furi_kernel_get_tick_frequency() * 5) {
            FURI_LOG_W("GpsUart", "NMEA watchdog: no valid sentence in 5 s — reconfiguring");
            // Switch host back to 9600 (module default after reset)
            furi_hal_serial_async_rx_stop(g->serial_handle);
            furi_hal_serial_deinit(g->serial_handle);
            furi_hal_serial_init(g->serial_handle, GPS_BAUD_RATE);
            g->rx_offset = 0;
            furi_stream_buffer_reset(g->rx_stream);
            furi_hal_serial_async_rx_start(g->serial_handle, gps_uart_irq_cb, g, false);
            furi_delay_ms(100);
            gps_uart_configure(g);
            g->last_valid_nmea_tick = 0;
        }
    }
}

// ---------------------------------------------------------------------------
// Send init sequence: switch to 115200 baud and apply module-specific config.
// Module type is selected at compile-time via GPS_MODULE in biomap_config.h.
// ---------------------------------------------------------------------------
static void gps_uart_configure(GpsUart* g) {
    furi_assert(g);
    if(!g->ready || !g->serial_handle) return;

#if GPS_MODULE == GPS_MODULE_L76K
    // ── Quectel L76K ──────────────────────────────────────────────────
    FURI_LOG_I("GpsUart", "Configuring Quectel L76K");

    pcas_tx(g, "$PCAS10,0*1C\r\n");                             // Hot start
    furi_delay_ms(200);
    pcas_tx(g, "$PCAS04,7*1E\r\n");                             // GPS+BeiDou+GLONASS
    pcas_tx(g, "$PCAS03,1,0,1,0,1,0,0,0,0,0,,,0,0*03\r\n");   // GGA+GSA+RMC only

    // Switch module to 115200 baud
    FURI_LOG_I("GpsUart", "Switching GPS to 115200 baud");
    furi_delay_ms(200);
    pcas_tx(g, "$PCAS01,5*19\r\n");
    furi_delay_ms(300);

    // Switch host UART to match
    furi_hal_serial_async_rx_stop(g->serial_handle);
    furi_hal_serial_deinit(g->serial_handle);
    furi_hal_serial_init(g->serial_handle, GPS_BAUD_RATE_FAST);
    g->rx_offset = 0;
    furi_stream_buffer_reset(g->rx_stream);
    furi_hal_serial_async_rx_start(g->serial_handle, gps_uart_irq_cb, g, false);
    furi_delay_ms(100);

    pcas_tx(g, "$PCAS02,200*1D\r\n");                           // 5 Hz
    pcas_tx(g, "$PCAS03,1,0,1,5,1,0,0,0,0,0,,,0,0*06\r\n");   // GGA+GSA+RMC@5Hz, GSV@1Hz
    FURI_LOG_I("GpsUart", "L76K running at 115200 baud, 5 Hz, GSV@1Hz");

#elif GPS_MODULE == GPS_MODULE_M10Q
    // ── u-blox SAM-M10Q ───────────────────────────────────────────────
    FURI_LOG_I("GpsUart", "Configuring u-blox SAM-M10Q");

    // Switch module to 115200 baud (ASCII at 9600)
    FURI_LOG_I("GpsUart", "Switching GPS to 115200 baud");
    furi_hal_serial_tx(g->serial_handle,
        (const uint8_t*)"$PUBX,41,1,0007,0001,115200,0*1A\r\n", 38);
    furi_delay_ms(300);

    // Switch host UART to match
    furi_hal_serial_async_rx_stop(g->serial_handle);
    furi_hal_serial_deinit(g->serial_handle);
    furi_hal_serial_init(g->serial_handle, GPS_BAUD_RATE_FAST);
    g->rx_offset = 0;
    furi_stream_buffer_reset(g->rx_stream);
    furi_hal_serial_async_rx_start(g->serial_handle, gps_uart_irq_cb, g, false);
    furi_delay_ms(100);

    // Send binary UBX configuration packets
    ubx_tx(g, ubx_cfg_rate_5hz, sizeof(ubx_cfg_rate_5hz));
    ubx_tx(g, ubx_cfg_msg_gll_off, sizeof(ubx_cfg_msg_gll_off));
    ubx_tx(g, ubx_cfg_msg_vtg_off, sizeof(ubx_cfg_msg_vtg_off));
    ubx_tx(g, ubx_cfg_msg_gsv_1hz, sizeof(ubx_cfg_msg_gsv_1hz));
    ubx_tx(g, ubx_cfg_nav5_pedestrian, sizeof(ubx_cfg_nav5_pedestrian));

    FURI_LOG_I("GpsUart", "M10Q running at 115200 baud, 5 Hz, GSV@1Hz");

#else
    #error "GPS_MODULE must be GPS_MODULE_L76K or GPS_MODULE_M10Q"
#endif
}

// ---------------------------------------------------------------------------
// Hot Start reset — module-specific via compile-time GPS_MODULE.
// ---------------------------------------------------------------------------
void gps_uart_send_hot_start(GpsUart* g) {
    furi_assert(g);
    if(!g->ready || !g->serial_handle) return;
    FURI_LOG_I("GpsUart", "Hot Start reset");
#if GPS_MODULE == GPS_MODULE_L76K
    pcas_tx(g, "$PCAS10,0*1C\r\n");
#elif GPS_MODULE == GPS_MODULE_M10Q
    ubx_tx(g, ubx_cfg_rst_hot, sizeof(ubx_cfg_rst_hot));
#endif
}


