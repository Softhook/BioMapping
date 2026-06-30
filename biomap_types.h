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
#define TICK_HZ          10
#define ZOOM_FACTOR      1.5f    // multiplicative step for manual Up/Down zoom
#define ZOOM_MIN         0.25f
#define ZOOM_MAX         16.0f
#define DISPLAY_EMA_A    0.2f
#define DISPLAY_EMA_B    0.8f   // (1.0f - DISPLAY_EMA_A), precomputed

// ── Sub-structs (owned by BioMapApp) ───────────────────────────────────

typedef struct {
    float    smoothed;
    bool     primed;
    int32_t  last_displayed;
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
} ZoomState;

typedef struct {
    bool     active;
    char     filename[64];
    int      tick_counter;
} RecordingState;

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
