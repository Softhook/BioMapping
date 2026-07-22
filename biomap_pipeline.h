// biomap_pipeline.h — Pure math pipeline functions for GSR signal processing.
//
// Platform-independent: includes only biomap_types.h.  No Flipper SDK,
// no module headers.  All functions operate on Pipeline* or individual
// sub-struct pointers.  Designed to be testable with a stack-allocated
// Pipeline on any C99 host compiler.
//
// This file declares the Pipeline struct (bundle of DisplayState +
// GraphState + ZoomState) and the pure-math functions extracted from
// biomap_session.c.

#pragma once

#include "biomap_types.h"

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
// Returns 0 as sentinel when the RTC is unset (year < 2020, or
// month/day out of range).
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
// p->graph.last_smoothed on prime.
void pipeline_update_display(Pipeline* p, float raw);

// Graph pipeline: derivative rate → ring buffer → auto-zoom peak
// tracking + zoom-level lerp.  Handles manual zoom timeout.
void pipeline_update_graph(Pipeline* p);

// ── Graph rescaling (time-axis zoom) ──────────────────────────────────
//
// zoom_out=true  → average adjacent pairs, halving resolution.
// zoom_out=false → interpolate, doubling resolution.
// O(N) one-time pass called on Left/Right key during GSR sessions.
void pipeline_rescale_graph(Pipeline* p, bool zoom_out);
