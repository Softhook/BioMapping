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
#define GRAPH_LEVELS     5   // time scales of 1, 2, 4, 8 and 16 ticks per sample
#define TICK_HZ          10
#define EVENT_QUEUE_DEPTH 64   // FuriMessageQueue capacity
#define ZOOM_FACTOR      1.5f    // multiplicative step for manual Up/Down zoom
#define ZOOM_MIN         0.25f
#define ZOOM_MAX         16.0f

// GPS logging rate — rows per second in the CSV.
// 10 Hz = 100 ms between fixes; matches TICK_HZ so every tick logs GPS+GSR
// (tick_counter % 1 == 0 always).  With the M10Q at 10 Hz each row gets a
// fresh fix.
#define GPS_CSV_HZ       10
#define SMOOTH_IIR_A     0.848f  // α for 3 Hz post-decimation smoothing IIR at 10 Hz
#define SMOOTH_IIR_B     (1.0f - SMOOTH_IIR_A)
#define DISPLAY_EMA_A    0.2f
#define DISPLAY_EMA_B    (1.0f - DISPLAY_EMA_A)

// Live Stream (BLE) send cadence. If real hardware shows 300 ms is too
// aggressive, this is a one-line change. Must divide evenly into 1000/TICK_HZ
// ms per tick (300 / 100 = 3 ticks).
#define BT_STREAM_INTERVAL_MS    300
#define BT_STREAM_INTERVAL_TICKS (BT_STREAM_INTERVAL_MS * TICK_HZ / 1000)

// ── Auto-zoom tuning (pipeline_update_graph) ──────────────────────────
#define ZOOM_PEAK_DECAY   0.997f  // multiplicative decay of peak per tick
#define ZOOM_LERP_RATE    0.02f   // zoom level lerp toward target per tick
#define ZOOM_TARGET_DIV   80.0f   // numerator: target zoom = ZOOM_TARGET_DIV / peak
#define ZOOM_PEAK_FLOOR   0.5f    // minimum peak floor for auto-zoom
#define GRAPH_RATE_SCALE  0.2f    // rate → graph-buffer scaling factor
#define REFRESH_EVERY     5       // display-refresh counter threshold
#define MANUAL_ZOOM_TIMEOUT 30    // ticks before auto-zoom re-engages after manual zoom (3 s)
#define FLUSH_INTERVAL    10      // seconds between SD batch flushes (LED blinks at 1 Hz)

// Consecutive failed SD flushes tolerated before a recording is ended as
// unrecoverable (see flush_file() in core/biomap_session.c). Flush attempts are ~FLUSH_INTERVAL seconds apart, so ~6 is about a
// minute of retrying while the batch buffer holds the un-flushed rows in RAM
// — a batch buffer that fills first ends it sooner regardless.
#define SD_FLUSH_FAIL_STREAK_LIMIT 6

// ── Sub-structs (owned by BioMapApp) ───────────────────────────────────

typedef struct {
    float    smooth_iir;         // output of the 3 Hz post-decimation smoothing IIR
    bool     smooth_iir_primed;
    float    smoothed;           // output of the display EMA (fed by smooth_iir)
    bool     primed;
    float    last_displayed;     // IIR-filtered value (drives graph, auto-zoom)
    float    raw_sample_ns;      // true raw single-sample nS (no filtering)
    float    filtered_ns;        // ~100 ms window mean nS (no IIR/EMA)
    int32_t  raw_sample_count;   // raw normalized ADC count (pre-TIA, for diag)
    int      refresh_counter;
} DisplayState;

// One ring of graph samples at one time scale.
typedef struct {
    float    buf[GRAPH_N];
    int      head;
    float    last_smoothed;
} GraphRing;

// The graph keeps a ring at every time scale all the time, so Left/Right
// shows real history at the new scale straight away instead of a half
// empty graph. ring[k] takes one sample every 2^k ticks.
typedef struct {
    GraphRing ring[GRAPH_LEVELS];
    uint32_t  ticks;   // graph ticks so far; ring k steps when ticks is a multiple of 2^k
    int       level;   // the ring on screen
} GraphState;

// Ticks per sample of the ring on screen.
static inline int graph_divider(const GraphState* g) {
    return 1 << g->level;
}

static inline const GraphRing* graph_shown(const GraphState* g) {
    return &g->ring[g->level];
}

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
    // ── GPS/RF mutex-contention diagnostics ────────────────────────────
    // total_ticks above (and the `rel` CSV column derived from it) is a
    // sequence counter — it stays perfectly uniform even if the main loop
    // stalls, so it can't prove contention is or isn't happening.
    // last_tick_wall_ms/tick_dt_ms are the
    // real clock measurement instead (SessionPlatform.now_ms): updated every
    // tick in session_core_tick(), regardless of recording.active.
    uint32_t last_tick_wall_ms; // bookkeeping only — previous now_ms() reading
    uint32_t tick_dt_ms;        // real elapsed ms since the previous Tick event; 0 on the first tick

    // ── SD write-failure ride-out (flush_file(), core/biomap_session.c) ────
    // A failed batch flush doesn't end the recording at once:
    // sd_logger_batch_flush() keeps the un-flushed rows in its buffer and new
    // rows keep appending onto them, so the next successful flush writes the
    // accumulated old + new rows in one go (one storage_file_write, CRC folds
    // exactly the confirmed bytes — no corruption).
    //   flush_fail_streak — consecutive failed flushes; 0 = healthy. >0 while
    //     riding out a failure (batch buffer holds un-flushed rows); reset to
    //     0 on the first success. The renderer blinks the recording indicator
    //     while this is >0 and `active`.
    //   write_stopped — latched true when the recording was terminated by an
    //     unrecoverable SD failure (streak reached SD_FLUSH_FAIL_STREAK_LIMIT,
    //     or the batch buffer filled while still failing) rather than a normal
    //     user stop. Kept set after `active` clears so the renderer holds the
    //     "REC STOPPED - SD ERROR" banner up. session_core_init() zeroes both per
    //     session; start_recording() clears both on restart.
    uint32_t flush_fail_streak;
    bool     write_stopped;
} RecordingState;

// Extracted GPS position snapshot (returned by value from get_gps_position).
// .valid is true only when GPS has a fix and lat/lon are set.
typedef struct {
    bool   valid;
    double lat;        // double for sub-metre precision (float loses ~0.4 m jitter)
    double lon;
    float  hdop;       // Horizontal Dilution of Precision; 99.9 = unknown
    float  pdop;       // Position DOP from GSA (chip-computed); 99.9 = unknown
    float  hacc;       // Estimated horizontal accuracy in metres (PUBX 00); 99.9 = unknown
    float  speed_kts;  // Speed over ground in knots (RMC); NaN = unknown
    float  course_deg; // Course over ground in degrees true (RMC); NaN = unknown
    int    sats;       // satellites tracked — diagnostic aid for DOP interpretation
    int    fix_type;   // fix_type from GSA: 1=none, 2=2D, 3=3D
} GpsPosition;

// Per-row contention diagnostics (from the GPS/RF mutex investigation). Built
// by the caller (core/biomap_session.c) from real, measured sources — never
// inferred — and threaded into biomap_format_gps_row() alongside GpsPosition so
// a track can answer "was the main loop or the GPS UART actually stalled"
// directly rather than by inference from GPS accuracy after the fact.
//
// The *_peak_ms columns go one level deeper: given a stall in tick_dt_ms,
// which of the worker's candidate blocking calls caused it? Each is a
// lifetime-max clock delta measured immediately around one
// specific hardware call — see gsr_sensor_get_i2c_peak_ms() (gsr_sensor.h),
// em_scan_sampler_get_*_peak_ms() (em_scan_sampler.h) and
// sd_logger_get_flush_peak_ms() (sd_logger.h)
// for exactly what each one times. Like gps_rx_drops/nmea_fail they are
// never reset, so a track's later rows show which one first jumped and when.
//
// The log_* columns are continuity-pressure telemetry read straight from
// sd_logger.c: current batch occupancy, lifetime high-water mark, rows
// rejected under batch-capacity pressure, and flush write/sync failures.
// prealloc_ms is set once at recording start and stays constant for the
// whole file.
typedef struct {
    uint32_t tick_dt_ms;     // real clock delta since the previous tick
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
    uint32_t pga_change_count;   // GSR auto-ranging PGA gain switches in the last ~1 s window, not cumulative (gain-change artefact marker)
    uint32_t i2c_consec_fail;    // current run length of consecutive GSR I2C failures (0 = healthy)
    uint32_t prealloc_ms;        // one-shot file pre-allocation duration at recording start
    float    gsr_spread_ns;      // standard deviation of the readings inside this row's 100 ms GSR window (gsr_sensor_get_window_spread_ns)
} RowDiag;

// ── Inline helpers ─────────────────────────────────────────────────────

// Note: BioMapModeLiveStream is deliberately excluded from has_gps(),
// has_gsr(), and has_rf() because these gate the shared CSV-writing tick
// and render paths. Live Stream captures GPS/GSR but routes it to BLE
// directly via bt_stream instead of the SD logger (and does not use RF).

static inline bool has_gps(int mode) {
    return mode == BioMapModeGpsGsrRf || mode == BioMapModeGpsGsr || mode == BioMapModeGpsOnly;
}

static inline bool has_gsr(int mode) {
    return mode == BioMapModeGpsGsrRf || mode == BioMapModeGpsGsr || mode == BioMapModeGsrOnly
        || mode == BioMapModeDiagnostics;
}

// RF scanning gating — purely a function of which main-menu mode was chosen
// (GpsGsrRf/GpsOnly), always on whenever the mode includes it. Includes
// Diagnostics (which has no GPS at all) as a deliberate exception to the
// "RF is only useful alongside GPS" rule below: Diagnostics already surfaces
// the GSR worker's
// real measured throughput (gsr_sensor_get_worker_hz(), success/duplicate/
// stale rates, window P2P) — the only place in the app that does — so
// running the RF worker there too makes it a live instrument for RF/GSR
// thread-contention impact. Everywhere else, RF is gated identically to
// has_gps() (RF readings are only spatially useful, so only active
// alongside GPS). Live Stream mode does not support RF.
static inline bool has_rf(int mode) {
    return mode == BioMapModeGpsGsrRf || mode == BioMapModeGpsOnly
        || mode == BioMapModeDiagnostics;
}

// Clamp a float to the inclusive [lo, hi] range. Callers pass finite values
// (NaN would pass straight through).
static inline float clampf(float v, float lo, float hi) {
    return v < lo ? lo : (v > hi ? hi : v);
}
