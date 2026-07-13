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
    uint32_t             last_gsv_reset_tick;   // tick of last GSV total_sats reset
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

// ── Double-precision coordinate converter ───────────────────────────────
// minmea_tocoord() returns float, which loses ~0.4 m of precision at
// 6-7 decimal places.  This double version preserves full NMEA precision
// (~1 cm at the equator).  Formula: deg + min / (60 * scale).
// Uses integer literals (not 60.0/100.0) to avoid -Wdouble-promotion
// warnings when the toolchain uses -fsingle-precision-constant.
// Integer→double promotion is not flagged; only float→double is.
static inline double minmea_tocoord_double(const struct minmea_float* f) {
    if(f->scale == 0) return (double)NAN;
    if(f->scale > (INT_LEAST32_MAX / 100)) return (double)NAN;
    if(f->scale < (INT_LEAST32_MIN / 100)) return (double)NAN;
    int_least32_t scale100 = f->scale * 100;
    int_least32_t deg = f->value / scale100;
    int_least32_t min = f->value % scale100;
    return (double)deg + (double)min / ((double)f->scale * 60);
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

// ── PDOP helper: store GSA's chip-computed Position DOP. ───────────────
// PDOP comes from the GSA sentence and is computed by the M10Q firmware
// from ALL active satellites across ALL constellations — unlike our old
// computed DOP which only had GPS elevation data from GSV.
static void gps_store_pdop(GpsUart* g, float pdop) {
    if(!isnan(pdop)) {
        g->status.pdop = pdop;
    }
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
                g->status.latitude  = minmea_tocoord_double(&frame.latitude);
                g->status.longitude = minmea_tocoord_double(&frame.longitude);
                g->status.speed     = minmea_tofloat(&frame.speed);
                g->status.course    = minmea_tofloat(&frame.course);
            }
            g->status.time = frame.time;
            g->status.date = frame.date;
            g->last_valid_nmea_tick = furi_get_tick();

            // Clear per-epoch accumulators on whole-second boundary.
            // Sub-second (microsecond) differences are ignored so that
            // multi-constellation GSA sentences arriving within the same
            // second all accumulate into the same active_prns set.
            if(frame.time.hours   != g->last_epoch_time.hours ||
               frame.time.minutes != g->last_epoch_time.minutes ||
               frame.time.seconds != g->last_epoch_time.seconds) {
                g->last_epoch_time = frame.time;
                g->status.active_prn_count = 0;
                // NOTE: gsv_total_sats is NOT reset here — it is reset inside
                // the GSV handler on a tick-based threshold (see GSV case).
                // RMC-based reset failed at high update rates where sub-second
                // messages have identical hh:mm:ss fields, or when RMC is lost.
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
                g->status.latitude  = minmea_tocoord_double(&frame.latitude);
                g->status.longitude = minmea_tocoord_double(&frame.longitude);
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

            // NOTE: active_prn_count is NOT reset here (unlike RMC).
            // GGA arrives at 10 Hz with unique sub-second timestamps;
            // resetting here would clear the multi-constellation PRN
            // accumulation that GSA sentences build up between GGAs.
            // RMC handles the epoch-boundary reset on whole seconds.
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
            // satellites to GPS offset 0, silently corrupting sat_elevation.
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
            gps_store_pdop(g, minmea_tofloat(&frame.pdop));
            if(g->status.active_prn_count > g->status.satellites_tracked) {
                g->status.satellites_tracked = g->status.active_prn_count;
            }
            // GSV total_sats is the definitive count when available.
            // GGA caps at 12 on u-blox; GSV reports the true per-constellation
            // total.  Falls back to active_prn_count if GSV hasn't arrived yet.
            if(g->status.gsv_total_sats > g->status.satellites_tracked) {
                g->status.satellites_tracked = g->status.gsv_total_sats;
            }
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

            // Accumulate per-constellation total_sats on the first message
            // of each constellation's GSV cycle.  This gives the true
            // satellite-in-view count across all enabled constellations
            // (unlike GGA which caps at 12 on u-blox receivers).
            //
            // Reset the accumulator at the start of each multi-constellation
            // GSV cycle (~1 Hz).  A tick-based threshold is used instead of
            // RMC time-field comparison because at high GPS rates (10 Hz)
            // RMC hours:minutes:seconds may not change for sub-second messages,
            // and a lost RMC packet would skip the reset entirely, inflating
            // the count 2-4x over multiple cycles.
            if(frame.msg_nr == 1) {
                uint32_t now = furi_get_tick();
                if(now - g->last_gsv_reset_tick >
                   furi_kernel_get_tick_frequency() * 4 / 5) {
                    g->status.gsv_total_sats = 0;
                    g->last_gsv_reset_tick = now;
                }
                g->status.gsv_total_sats += frame.total_sats;
            }

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

            // When the GSV cycle completes, mark elevation data as fresh.
            // PDOP now comes directly from GSA — no WDOP recompute needed.
            if(frame.msg_nr == frame.total_msgs) {
                g->status.gsv_fresh = true;
            }
        }
    } break;

    case MINMEA_SENTENCE_GLL: {
        // GLL is disabled in the current PCAS config, but guard the validity
        // flag here so stale/void sentences never overwrite good coordinates.
        struct minmea_sentence_gll gll_frame;
        if(minmea_parse_gll(&gll_frame, line) && gll_frame.status == MINMEA_GLL_STATUS_DATA_VALID) {
            g->status.latitude  = minmea_tocoord_double(&gll_frame.latitude);
            g->status.longitude = minmea_tocoord_double(&gll_frame.longitude);
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
#if GPS_MODULE == GPS_MODULE_M10Q
// ---------------------------------------------------------------------------
// Helpers — send binary UBX packets over the GPS UART (M10Q only)
// ---------------------------------------------------------------------------
static void ubx_tx(GpsUart* g, const uint8_t* data, size_t len) {
    furi_hal_serial_tx(g->serial_handle, data, len);
    furi_delay_ms(100);
}
// Send without delay — for batching multiple packets before a single wait.
static void ubx_tx_raw(GpsUart* g, const uint8_t* data, size_t len) {
    furi_hal_serial_tx(g->serial_handle, data, len);
}

// ── Binary UBX configuration packets for M10Q ──────────────────────────────
static const uint8_t ubx_cfg_rate_10hz[] = {
    // 100 ms measRate = 10 Hz.  SAM-M10Q datasheet Table 1: 10 Hz is the
    // high-performance-mode maximum for the default 4-constellation config.
    // No separate HP-mode enable packet is required — setting the rate is
    // sufficient on M10 SPG 5.10 firmware.
    0xB5, 0x62, 0x06, 0x08, 0x06, 0x00, 0x64, 0x00, 0x01, 0x00, 0x01, 0x00, 0x7A, 0x12
};
static const uint8_t ubx_cfg_msg_gll_off[] = {
    0xB5, 0x62, 0x06, 0x01, 0x03, 0x00, 0xF0, 0x01, 0x00, 0xFB, 0x11
};
static const uint8_t ubx_cfg_msg_vtg_off[] = {
    0xB5, 0x62, 0x06, 0x01, 0x03, 0x00, 0xF0, 0x05, 0x00, 0xFF, 0x19
};
static const uint8_t ubx_cfg_msg_gsv_1hz[] = {
    // rate=10: every 10th epoch × 100 ms = 1 Hz
    0xB5, 0x62, 0x06, 0x01, 0x03, 0x00, 0xF0, 0x03, 0x0A, 0x07, 0x1F
};
static const uint8_t ubx_cfg_nav5_pedestrian[] = {
    0xB5, 0x62, 0x06, 0x24, 0x28, 0x00, 0x01, 0x00, 0x03, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x56, 0x3E
};
static const uint8_t ubx_cfg_assistnow_autonomous[] = {
    // VALSET packet enabling CFG-ANA-USE_ANA = 1 (true) for offline orbit predictions
    0xB5, 0x62, 0x06, 0x8A, 0x09, 0x00, 0x00, 0x01, 0x00, 0x00, 0x01, 0x00, 0x23, 0x10, 0x01, 0xCF, 0xC0
};
static const uint8_t ubx_rxm_pmreq_standby[] = {
    // Software Standby sleep packet (force=1, backup=0, duration=0 (infinite), wakeup=UART RX)
    0xB5, 0x62, 0x02, 0x41, 0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x56, 0x2F
};
static const uint8_t ubx_cfg_rst_hot[] = {
    0xB5, 0x62, 0x06, 0x04, 0x04, 0x00, 0x00, 0x00, 0x02, 0x00, 0x10, 0x68
};
#endif

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
        .pdop               = 99.9f,
        .gsv_fresh          = false,
        .active_prn_count   = 0,
        .gsv_total_sats     = 0,
        .time               = {0},
        .date               = {0},
    };
    memset(g->status.sat_elevation, 0, sizeof(g->status.sat_elevation));
    memset(g->status.active_prns, 0, sizeof(g->status.active_prns));
    // Arm watchdog at alloc so a botched initial baud-rate switch
    // triggers a one-shot recovery after 5 s instead of silently
    // leaving the host at 115200 while the module stays at 9600.
    g->last_valid_nmea_tick  = furi_get_tick();
    g->last_gsv_reset_tick   = furi_get_tick();

    g->rx_stream = furi_stream_buffer_alloc(GPS_RX_BUF_SIZE, 1);

    // Disable Expansion Service to free USART1 (re-enabled in free)
    Expansion* expansion = furi_record_open(RECORD_EXPANSION);
    expansion_disable(expansion);
    furi_record_close(RECORD_EXPANSION);

    g->serial_handle = furi_hal_serial_control_acquire(GPS_UART_CH);
    if(g->serial_handle) {
        furi_hal_serial_init(g->serial_handle, GPS_BAUD_RATE);
#if GPS_MODULE == GPS_MODULE_M10Q
        // Wake up module in case it was in Software Standby
        uint8_t dummy = 0xFF;
        furi_hal_serial_tx(g->serial_handle, &dummy, 1);
        furi_delay_ms(100);
#endif
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
#if GPS_MODULE == GPS_MODULE_M10Q
        // Put u-blox module into Software Standby sleep to save power
        ubx_tx(g, ubx_rxm_pmreq_standby, sizeof(ubx_rxm_pmreq_standby));
#endif
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
// Helpers — send PCAS commands over the GPS UART (L76K only)
// ---------------------------------------------------------------------------
static void pcas_tx(GpsUart* g, const char* cmd) {
    furi_hal_serial_tx(g->serial_handle, (const uint8_t*)cmd, strlen(cmd));
    furi_delay_ms(100);
}
// Send without delay — for batching multiple commands before a single wait.
static void pcas_tx_raw(GpsUart* g, const char* cmd) {
    furi_hal_serial_tx(g->serial_handle, (const uint8_t*)cmd, strlen(cmd));
}
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
    // All PCAS commands verified against Quectel L76K&L26K GNSS Protocol
    // Specification v1.2 (2021-12-16).  Checksums computed with NMEA XOR.
    //
    // NOTE: PCAS04 constellation setting is VOLATILE per Quectel HW manual
    // §3.4.1 ("掉电不保存") — module always boots as GPS+BeiDou.  We re-send
    // $PCAS04,7 on every configure() call.  PCAS01 baud rate IS persisted.
    //
    // NOTE: No PCAS06 (SBAS enable) command exists in the L76K protocol spec.
    // SBAS satellites (PRN 120-158) are handled automatically by the module
    // when visible; we detect them passively via GSA PRN ≥ 120.
    //
    // Delays are minimised by batching: commands before the baud switch are
    // sent back-to-back (pcas_tx_raw), followed by a single wait.  This
    // reduces the configure time from ~1700 ms to ~600 ms on L76K, which
    // avoids starving the 10 Hz GSR tick timer and UI event loop.
    FURI_LOG_I("GpsUart", "Configuring Quectel L76K");

    // Hot start
    pcas_tx(g, "$PCAS10,0*1C\r\n");
    furi_delay_ms(100);

    // Batch initial config (constellation + sentence type) — no delay between them.
    pcas_tx_raw(g, "$PCAS04,7*1E\r\n");                           // GPS+BeiDou+GLONASS (spec §2.3.4)
    pcas_tx_raw(g, "$PCAS03,1,0,1,0,1,0,0,0,0,0,,,0,0*03\r\n"); // GGA+GSA+RMC only (spec §2.3.3)
    furi_delay_ms(100);

    // Switch module to 115200 baud
    FURI_LOG_I("GpsUart", "Switching GPS to 115200 baud");
    pcas_tx_raw(g, "$PCAS01,5*19\r\n");
    furi_delay_ms(200);

    // Switch host UART to match
    furi_hal_serial_async_rx_stop(g->serial_handle);
    furi_hal_serial_deinit(g->serial_handle);
    furi_hal_serial_init(g->serial_handle, GPS_BAUD_RATE_FAST);
    g->rx_offset = 0;
    furi_stream_buffer_reset(g->rx_stream);
    furi_hal_serial_async_rx_start(g->serial_handle, gps_uart_irq_cb, g, false);
    furi_delay_ms(50);

    // Datasheet requirement (§2.3.2): Interval < 1000 ms → must use 115200
    // baud + single-sentence output mode.  We intentionally output GGA+GSA+RMC
    // (3 types per fix) for richer data; bandwidth at 115200 is ~11% utilised.
    // Batch post-baud commands — no delay between them.
    pcas_tx_raw(g, "$PCAS02,200*1D\r\n");                         // 5 Hz (spec §2.3.2)
    pcas_tx_raw(g, "$PCAS03,1,0,1,5,1,0,0,0,0,0,,,0,0*06\r\n"); // GGA+GSA+RMC@5Hz, GSV@1Hz
    furi_delay_ms(100);
    FURI_LOG_I("GpsUart", "L76K running at 115200 baud, 5 Hz, GSV@1Hz");

#elif GPS_MODULE == GPS_MODULE_M10Q
    // ── u-blox SAM-M10Q ───────────────────────────────────────────────
    // Delays are minimised by sending all six UBX packets back-to-back
    // (ubx_tx_raw) after the baud switch, with a single wait.  This reduces
    // the configure time from ~1100 ms to ~500 ms on M10Q.
    FURI_LOG_I("GpsUart", "Configuring u-blox SAM-M10Q");

    // Switch module to 115200 baud (ASCII at 9600).
    // outProto=0002 → NMEA only (0001=UBX would disable ASCII output).
    FURI_LOG_I("GpsUart", "Switching GPS to 115200 baud");
    const char* pubx_baud = "$PUBX,41,1,0007,0002,115200,0*19\r\n";
    furi_hal_serial_tx(g->serial_handle, (const uint8_t*)pubx_baud, strlen(pubx_baud));
    furi_delay_ms(200);

    // Switch host UART to match
    furi_hal_serial_async_rx_stop(g->serial_handle);
    furi_hal_serial_deinit(g->serial_handle);
    furi_hal_serial_init(g->serial_handle, GPS_BAUD_RATE_FAST);
    g->rx_offset = 0;
    furi_stream_buffer_reset(g->rx_stream);
    furi_hal_serial_async_rx_start(g->serial_handle, gps_uart_irq_cb, g, false);
    furi_delay_ms(50);

    // Send all six binary UBX configuration packets back-to-back.
    ubx_tx_raw(g, ubx_cfg_rate_10hz, sizeof(ubx_cfg_rate_10hz));
    ubx_tx_raw(g, ubx_cfg_msg_gll_off, sizeof(ubx_cfg_msg_gll_off));
    ubx_tx_raw(g, ubx_cfg_msg_vtg_off, sizeof(ubx_cfg_msg_vtg_off));
    ubx_tx_raw(g, ubx_cfg_msg_gsv_1hz, sizeof(ubx_cfg_msg_gsv_1hz));
    ubx_tx_raw(g, ubx_cfg_nav5_pedestrian, sizeof(ubx_cfg_nav5_pedestrian));
    ubx_tx_raw(g, ubx_cfg_assistnow_autonomous, sizeof(ubx_cfg_assistnow_autonomous));
    furi_delay_ms(100);

    FURI_LOG_I("GpsUart", "M10Q running at 115200 baud, 10 Hz, GSV@1Hz");

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

// ---------------------------------------------------------------------------
// Standalone standby — put GPS module into lowest-power sleep without a
// full GpsUart allocation.  Acquires USART1 just long enough to send the
// sleep command, then releases everything.  Used when entering GSR-only
// mode so the GPS board isn't left idle at full power.
// ---------------------------------------------------------------------------
void gps_uart_standby(void) {
    Expansion* expansion = furi_record_open(RECORD_EXPANSION);
    expansion_disable(expansion);
    furi_record_close(RECORD_EXPANSION);

    FuriHalSerialHandle* handle = furi_hal_serial_control_acquire(GPS_UART_CH);
    if(handle) {
        furi_hal_serial_init(handle, GPS_BAUD_RATE);
#if GPS_MODULE == GPS_MODULE_M10Q
        // Wake from possible standby, then send Software Standby command
        uint8_t dummy = 0xFF;
        furi_hal_serial_tx(handle, &dummy, 1);
        furi_delay_ms(100);
        furi_hal_serial_tx(handle, ubx_rxm_pmreq_standby,
                           sizeof(ubx_rxm_pmreq_standby));
        furi_delay_ms(100);
#elif GPS_MODULE == GPS_MODULE_L76K
        // PCAS11,0 = stop mode (L76K&L26K Protocol Spec §2.3.11)
        const char* stop_cmd = "$PCAS11,0*1C\r\n";
        furi_hal_serial_tx(handle, (const uint8_t*)stop_cmd, strlen(stop_cmd));
        furi_delay_ms(100);
#endif
        furi_hal_serial_deinit(handle);
        furi_hal_serial_control_release(handle);
    }

    expansion = furi_record_open(RECORD_EXPANSION);
    expansion_enable(expansion);
    furi_record_close(RECORD_EXPANSION);
}


