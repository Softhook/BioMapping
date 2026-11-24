// biomap_pipeline.h — Pure math pipeline functions for GSR signal processing.
//
// Platform-independent: includes only biomap_types.h.  No Flipper SDK,
// no module headers.  All functions operate on Pipeline* or individual
// sub-struct pointers.  Designed to be testable with a stack-allocated
// Pipeline on any C99 host compiler.
//
// This file declares the Pipeline struct (bundle of DisplayState +
// GraphState + ZoomState) and the pure-math functions extracted from
// core/biomap_session.c.

#pragma once

#include "biomap_types.h"

#ifdef __cplusplus
extern "C" {
#endif

// ── Pipeline — bundled signal-processing state ────────────────────────
//
// Owns display, graph, and zoom sub-structs.  All pure-math functions
// below operate on Pipeline* rather than Session* — zero Flipper SDK
// dependencies.  Session embeds this as `Pipeline pipeline`.

typedef struct {
    DisplayState  display;
    GraphState    graph;
    ZoomState     zoom;
} Pipeline;

// ── Time helpers ──────────────────────────────────────────────────────

// Convert calendar date/time to Unix epoch seconds (UTC).
// Returns 0 as sentinel when the RTC is unset or out of 32-bit range
// (year < 2020 or year > 2105, or invalid calendar date/time).
uint32_t pipeline_unix_epoch(uint16_t year, uint8_t month, uint8_t day,
                             uint8_t hour, uint8_t minute, uint8_t second);

// Relative session timestamp in seconds from a monotonic tick counter.
// Each tick = 100 ms at TICK_HZ=10.
double pipeline_rel_seconds(uint32_t total_ticks);

// ── GSR signal processing ─────────────────────────────────────────────

// Post-decimation smoothing IIR (first-order, fc ≈ 3 Hz, α ≈ 0.848).
// Primes on first call (returns raw); subsequent calls apply the IIR.
float pipeline_smooth_iir(DisplayState* d, float raw);

// Display pipeline: IIR → EMA smoothing → refresh-counter gating.
// Updates d->smoothed, d->last_displayed, d->refresh_counter, and
// every graph ring's last_smoothed on prime.
void pipeline_update_display(Pipeline* p, float raw);

// Graph pipeline: derivative rate → ring buffer → auto-zoom peak
// tracking + zoom-level lerp.  Handles manual zoom timeout.
void pipeline_update_graph(Pipeline* p);

// ── Graph line restart ────────────────────────────────────────────────
//
// Starts every ring's next sample from display.smoothed, so a jump in the
// reading (prime, fingers back on) isn't drawn as one tall spike.
void pipeline_graph_restart_line(Pipeline* p);

#ifdef __cplusplus
}
#endif
