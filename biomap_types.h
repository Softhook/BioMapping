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
typedef struct {
    uint32_t tick_dt_ms;     // real furi_get_tick() delta since the previous Tick event
    uint32_t gps_rx_drops;   // cumulative UART bytes dropped (gps_uart's rx_stream was full)
    uint32_t nmea_fail;      // cumulative NMEA sentences that failed checksum/parse
    float    gsr_hz;         // GSR worker's real achieved sample rate (gsr_sensor_get_worker_hz)
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
