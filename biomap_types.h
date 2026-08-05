// biomap_types.h — Core sub-structs, constants, and inline helpers.
//
// Lightweight: no Flipper Zero SDK, no module headers.  Safe to include
// from any translation unit.  BioMapApp itself lives in biomap.h where
// the full SDK types are available.

#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "biomap_config.h"

// ── Constants ──────────────────────────────────────────────────────────

#define GRAPH_N          126
#define GRAPH_HALF       63    // GRAPH_N / 2, precomputed
#define TICK_HZ          10
#define EVENT_QUEUE_DEPTH 64   // FuriMessageQueue capacity
#define ZOOM_FACTOR      1.5f    // multiplicative step for manual Up/Down zoom
#define ZOOM_MIN         0.25f
#define ZOOM_MAX         16.0f

// GPS quality gate — positions with HDOP >= this value are treated as
// too imprecise to log.  Empty GPS columns are written instead, which
// the analyser treats as a gap rather than a noisy position.
// Also used by the LED indicator: blue blinks until HDOP drops below this.
// DOP terminology: < 2 = excellent, < 5 = good, < 10 = moderate, ≥ 10 = poor.
// 5.0 is appropriate for urban use (canyons/trees regularly push HDOP to 3–5).
// Lower to 3.0 for open-sky environments where higher precision is achievable.
//
// NOTE: The JS web analyser (constants.js GPS_DEFAULT.maxHdop) defaults to 2.0.
// This firmware gate is intentionally MORE permissive: we log everything that
// has a plausible fix so the analyser can apply a tighter filter in post-processing.
// Logging at 5.0 and filtering at 2.0 gives maximum flexibility; logging at 2.0
// would silently discard data in urban canyons that the analyser could have kept.
#define GPS_HDOP_GATE    5.0f
// GPS logging rate — rows per second in the CSV.
// 10 Hz = 100 ms between fixes; matches TICK_HZ so every tick logs GPS+GSR
// (tick_counter % 1 == 0 always).  With M10Q at 10 Hz each row gets a fresh
// fix.  With L76K at 5 Hz, odd ticks repeat the previous fix — harmless.
#define GPS_CSV_HZ       10
#define SMOOTH_IIR_A     0.848f  // α for 3 Hz post-decimation smoothing IIR at 10 Hz
#define SMOOTH_IIR_B     0.152f  // 1 - α, precomputed
#define DISPLAY_EMA_A    0.2f
#define DISPLAY_EMA_B    0.8f   // (1.0f - DISPLAY_EMA_A), precomputed

// ── Auto-zoom tuning (update_graph_pipeline) ──────────────────────────
#define ZOOM_PEAK_DECAY   0.997f  // multiplicative decay of peak per tick
#define ZOOM_LERP_RATE    0.02f   // zoom level lerp toward target per tick
#define ZOOM_TARGET_DIV   80.0f   // numerator: target zoom = ZOOM_TARGET_DIV / peak
#define ZOOM_PEAK_FLOOR   0.5f    // minimum peak floor for auto-zoom
#define GRAPH_RATE_SCALE  0.2f    // rate → graph-buffer scaling factor
#define REFRESH_EVERY     5       // display-refresh counter threshold
#define MANUAL_ZOOM_TIMEOUT 30    // ticks before auto-zoom re-engages after manual zoom (3 s)
#define FLUSH_INTERVAL    10      // seconds between SD batch flushes (LED blinks at 1 Hz)

// ── Sub-structs (owned by BioMapApp) ───────────────────────────────────

typedef struct {
    float    smooth_iir;         // output of the 3 Hz post-decimation smoothing IIR
    bool     smooth_iir_primed;
    float    smoothed;           // output of the display EMA (fed by smooth_iir)
    bool     primed;
    float    last_displayed;     // IIR-filtered value (drives graph, auto-zoom)
    float    raw_sample_ns;      // true raw single-sample nS (no filtering)
    float    filtered_ns;        // 100-sample decimated nS (no IIR/EMA)
    int32_t  raw_sample_count;   // raw normalized ADC count (pre-TIA, for diag)
    int      refresh_counter;
} DisplayState;

typedef struct {
    float    buf[GRAPH_N];
    int      head;
    int      tick_counter;
    float    last_smoothed;
    int      scroll_divider;
} GraphState;

typedef struct {
    float    level;
    float    peak;
    bool     enabled;
    int      manual_timeout;   // ticks remaining before auto-zoom re-engages
} ZoomState;

typedef struct {
    bool     active;
    int      tick_counter;
    int      flush_counter;  // seconds since last SD flush; triggers at FLUSH_INTERVAL
    uint32_t total_ticks;    // monotonic tick count since recording start; used for
                             // relative centisecond timestamps (total_ticks * 0.1 s)
    // ── GPS/RF mutex-contention diagnostics (2026-07-31) ────────────────
    // total_ticks above (and the `rel` CSV column derived from it) is a
    // sequence counter — it stays perfectly uniform even if the main loop
    // stalls, so it can't prove contention is or isn't happening (see
    // docs/gps_rf_mutex_status.md). last_tick_wall_ms/tick_dt_ms are the
    // real furi_get_tick() measurement instead: updated every Tick event
    // in run_recording_session(), regardless of recording.active.
    uint32_t last_tick_wall_ms; // bookkeeping only — previous furi_get_tick() reading
    uint32_t tick_dt_ms;        // real elapsed ms since the previous Tick event; 0 on the first tick
    // tick_dt_max_ms/tick_over_{150,250,500}_count (2026-07-31 → removed
    // 2026-08-05, debug-field review): a windowed max and bucket counts
    // derived from tick_dt_ms, surfaced only on the serial-only 1 Hz
    // telemetry heartbeat — a channel this project has never actually used
    // to diagnose a real issue (docs/gps_rf_mutex_status.md is entirely
    // CSV-based). Fully redundant with the per-row tick_dt_ms column
    // already in the CSV, which gives strictly more information (exact
    // values at exact rows, not coarse buckets) and is the channel real
    // analysis has always used. Removed rather than kept as unused
    // bookkeeping.
} RecordingState;

// Extracted GPS position snapshot (returned by value from get_gps_position).
// .valid is true only when GPS has a fix and lat/lon are set.
typedef struct {
    bool   valid;
    double lat;        // double for sub-metre precision (float loses ~0.4 m jitter)
    double lon;
    float  hdop;       // Horizontal Dilution of Precision; 99.9 = unknown
    float  pdop;       // Position DOP from GSA (chip-computed); 99.9 = unknown
    float  hacc;       // Estimated horizontal accuracy in meters (PUBX 00); 99.9 = unknown
    float  speed_kts;  // Speed over ground in knots (RMC); NaN = unknown
    float  course_deg; // Course over ground in degrees true (RMC); NaN = unknown
    int    sats;       // satellites tracked — diagnostic aid for DOP interpretation
    int    fix_type;   // fix_type from GSA: 1=none, 2=2D, 3=3D
} GpsPosition;

// Per-row contention diagnostics (2026-07-31, GPS/RF mutex investigation —
// see docs/gps_rf_mutex_status.md). Built by the caller (biomap_session.c)
// from real, measured sources — never inferred — and threaded into
// format_gps_csv_row() alongside GpsPosition so a future track can answer
// "was the main loop or the GPS UART actually stalled" directly instead of
// by inference from GPS accuracy after the fact.
//
// i2c_peak_ms/rf_rssi_peak_ms/rf_retune_peak_ms (2026-08-03, same
// investigation) go one level deeper: given a stall in tick_dt_ms above,
// which of the worker thread's three candidate blocking calls actually
// caused it? Each is a lifetime-max real furi_get_tick() delta measured
// immediately around one specific hardware call — see the matching
// gsr_sensor_get_*_peak_ms() accessors (gsr_sensor.h) for exactly which
// call site each one times. Never reset, same as gps_rx_drops/nmea_fail
// above, so a track's later rows show which one first jumped and when.
//
// flush_peak_ms (2026-08-03): tracks 116 and 117 both showed their only
// real tick_dt_ms stalls landing exactly on a once-per-FLUSH_INTERVAL SD
// flush tick, while the three columns above stayed near zero at that same
// row — ruling out the GSR worker thread and pointing at
// sd_logger_batch_flush() (main thread, write+sync) instead. Same
// lifetime-max-since-start convention; see sd_logger_get_flush_peak_ms()'s
// doc comment (sd_logger.h) for exactly what it times.
//
// log_fill_bytes/log_fill_peak_bytes/log_overflow_count/log_flush_fail_count
// (2026-08-03): continuity-pressure telemetry from sd_logger.c. These are
// intentionally logger-internal rather than inferred from timing:
// current batch occupancy, lifetime occupancy high-water mark, count of rows
// rejected due to batch-capacity pressure, and count of flush write/sync
// failures.
//
// gps_reinit_count/pga_change_count/i2c_consec_fail (2026-08-05, debug-field
// review): promoted from either a serial-only log line or a Diagnostics-
// screen-only reading (both invisible to post-hoc CSV analysis, which is
// how every real bug in this project has actually been diagnosed — see
// docs/gps_rf_mutex_status.md). gps_reinit_count mirrors gps_rx_drops/
// nmea_fail's pattern exactly (gps_uart.h). pga_change_count and
// i2c_consec_fail were already computed unconditionally in every mode with
// no extra cost — just never reached the file. Deliberately NOT included
// here: gsr_sensor's success/duplicate/stale rate (pre-averaged over a
// rolling window with no raw-count accessor to log instead — would repeat
// the "log the bucket, not the raw signal" mistake tick_over_*_count made,
// see RecordingState's doc comment) and mains_hum_mag (mode-gated for real
// CPU cost, and Diagnostics mode currently shares GPS_GSR_RF's header —
// logging it there would print a misleading 0.0 for every non-Diagnostics
// recording that never computes it). Both need a dedicated follow-up, not
// a same-pass bundling.
typedef struct {
    uint32_t tick_dt_ms;     // real furi_get_tick() delta since the previous Tick event
    uint32_t gps_rx_drops;   // cumulative UART bytes dropped (gps_uart's rx_stream was full)
    uint32_t nmea_fail;      // cumulative NMEA sentences that failed checksum/parse
    uint32_t gps_reinit_count; // cumulative full GPS module reconfigure cycles (gps_uart_get_reinit_count)
    float    gsr_hz;         // GSR worker's real achieved sample rate (gsr_sensor_get_worker_hz)
    uint32_t i2c_peak_ms;       // worst single GSR I2C call (read or PGA-change write) ever seen
    uint32_t rf_rssi_peak_ms;   // worst single RF RSSI-poll SPI call ever seen
    uint32_t rf_retune_peak_ms; // worst single RF band-retune SPI call ever seen
    uint32_t flush_peak_ms;     // worst single SD batch flush (write+sync) ever seen
    uint32_t log_fill_bytes;       // current SD batch occupancy in bytes
    uint32_t log_fill_peak_bytes;  // lifetime high-water occupancy in bytes
    uint32_t log_overflow_count;   // rows rejected due to batch-capacity pressure
    uint32_t log_flush_fail_count; // flush write/sync failures (batch preserved for retry)
    uint32_t pga_change_count;   // cumulative GSR auto-ranging PGA gain switches (gain-change artifact marker)
    uint32_t i2c_consec_fail;    // current run length of consecutive GSR I2C failures (0 = healthy)
} RowDiag;

// ── Inline helpers ─────────────────────────────────────────────────────

static inline bool has_gps(int mode) {
    return mode == BioMapModeGpsGsrRf || mode == BioMapModeGpsGsr || mode == BioMapModeGpsOnly;
}

static inline bool has_gsr(int mode) {
    return mode == BioMapModeGpsGsrRf || mode == BioMapModeGpsGsr || mode == BioMapModeGsrOnly
        || mode == BioMapModeDiagnostics;
}

// RF scanning gating. No longer a separate Options toggle — RF is now
// purely a function of which main-menu mode was chosen (GpsGsrRf/GpsOnly),
// always on whenever the mode includes it. Includes Diagnostics (which has
// no GPS at all) as a deliberate exception to the "RF is only useful
// alongside GPS" rule below: Diagnostics already surfaces the GSR worker's
// real measured throughput (gsr_sensor_get_worker_hz(), success/duplicate/
// stale rates, window P2P) — the only place in the app that does — so
// running the RF worker there too makes it a live instrument for RF/GSR
// thread-contention impact. Everywhere else, RF is gated identically to
// has_gps() (RF readings are only spatially useful, so only active
// alongside GPS).
static inline bool has_rf(int mode) {
    return mode == BioMapModeGpsGsrRf || mode == BioMapModeGpsOnly
        || mode == BioMapModeDiagnostics;
}

// Expand a 2-digit NMEA year to a 4-digit calendar year (Y2K pivot at 80).
static inline int gps_year_expand(int y) {
    return y + (y < 80 ? 2000 : 1900);
}
