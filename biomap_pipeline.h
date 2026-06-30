// biomap_pipeline.h — Data-processing pipeline for Bio Mapping
//
// Extracted from biomap.c: display smoothing (EMA), graph buffer management,
// batch CSV row construction, graph rescaling, GPS position extraction,
// and second-boundary SD logging.
//
// All functions require the app mutex to be held by the caller.

#pragma once

#include "biomap_config.h"
#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>

typedef struct BioMapApp BioMapApp;

// ── Graph rescaling (time-axis zoom) ───────────────────────────────────────
// Called on Left/Right key during GSR recording sessions.
// zoom_out=true  → average adjacent pairs, halving resolution
// zoom_out=false → interpolate, doubling resolution
void rescale_graph_buf(BioMapApp* app, bool zoom_out);

// ── Display pipeline ───────────────────────────────────────────────────────
// EMA smoothing of raw GSR readings for on-screen display.
void update_display_pipeline(BioMapApp* app, int32_t raw);

// ── Graph pipeline ─────────────────────────────────────────────────────────
// Build the graph ring buffer from smoothed GSR derivative rate.
// Handles auto-zoom peak tracking and zoom-level lerp.
void update_graph_pipeline(BioMapApp* app);

// ── Batch CSV ──────────────────────────────────────────────────────────────
// Accumulate a formatted CSV row into the SD logger's internal batch buffer.
// Rows are flushed to SD at the 1‑second boundary by handle_second_boundary().
void batch_csv_row(BioMapApp* app, BioMapMode mode, int32_t raw);

// ── Second boundary ────────────────────────────────────────────────────────
// Called once per second.  For GSR modes: flushes the batch buffer to SD.
// For GPS-only mode: writes a single row directly to SD.
// On write failure: stops recording and signals with red LED.
void handle_second_boundary(BioMapApp* app, BioMapMode mode);

// ── Write failure ──────────────────────────────────────────────────────────
// Stop the logger, clear recording state, and signal with red LED.
void handle_write_failure(BioMapApp* app);

// ── GPS position ───────────────────────────────────────────────────────────
// Extract lat, lon, alt, sats, fix from app->gps state.
// Output params are only written when GPS has a valid fix.
void get_gps_position(BioMapApp* app, float* lat, float* lon,
                      float* alt, int* sats, int* fix);
