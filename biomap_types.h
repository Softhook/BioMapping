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
#define GPS_HDOP_GATE    5.0f
// GPS logging rate — rows per second in the CSV.
// 2 Hz = 500 ms between fixes; clean alignment with 10 Hz tick rate (every 5th tick).
// Phase 2: change to 5 for 5 Hz (every 2nd tick).
#define GPS_CSV_HZ       2
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

// ── Sub-structs (owned by BioMapApp) ───────────────────────────────────

typedef struct {
    float    smooth_iir;         // output of the 3 Hz post-decimation smoothing IIR
    bool     smooth_iir_primed;
    float    smoothed;           // output of the display EMA (fed by smooth_iir)
    bool     primed;
    float    last_displayed;
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
} RecordingState;

// Extracted GPS position snapshot (returned by value from get_gps_position).
// .valid is true only when GPS has a fix and lat/lon are set.
typedef struct {
    bool  valid;
    float lat;
    float lon;
    float alt;
    float hdop;      // Horizontal Dilution of Precision; 99.9 = unknown
    float vdop;      // Vertical Dilution of Precision; 99.9 = unknown
    float wdop;      // Weighted DOP from GSV elevations; 99.9 = unknown
    float speed_kts; // Speed over ground in knots (RMC); NaN = unknown
    float course_deg;// Course over ground in degrees true (RMC); NaN = unknown
    int   sats;
    int   fix;       // fix_quality from GGA: 0=none, 1=GPS, 2=DGPS
    int   fix_type;  // fix_type from GSA: 1=none, 2=2D, 3=3D
} GpsPosition;

// ── Inline helpers ─────────────────────────────────────────────────────

static inline bool has_gps(int mode) {
    return mode == BioMapModeGpsGsr || mode == BioMapModeGpsOnly;
}

static inline bool has_gsr(int mode) {
    return mode == BioMapModeGpsGsr || mode == BioMapModeGsrOnly;
}

// Expand a 2-digit NMEA year to a 4-digit calendar year (Y2K pivot at 80).
static inline int gps_year_expand(int y) {
    return y + (y < 80 ? 2000 : 1900);
}
