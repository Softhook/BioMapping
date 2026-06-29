#pragma once

// GPX Converter — biomap_*.csv → biomap_*.gpx
//
// Encodes GSR rate‑of‑change as GPX elevation (0–255).
//   • 0   = calm / steady GSR
//   • 255 = biggest GSR change in the recording
//
// Configurable SMA window (GPX_RATE_WINDOW) controls smoothing.
// Two‑pass, O(1) memory, buffered I/O, watchdog‑safe.
// See gpx_converter.c for full design notes.

#include <storage/storage.h>
#include <stdbool.h>

/* ── Tunable constants (experiment with these!) ──────────────────────── */

#define GPX_RATE_WINDOW     8     // SMA samples → bigger = smoother rate
#define GPX_MAX_ABS_RATE    2000.0f // cap |rate| — limit to 2000 nS/sec for physiological scaling
#define GPX_MAX_CSV_FILES   32

typedef struct GpxConverter GpxConverter;

GpxConverter* gpx_converter_alloc(Storage* storage);
void          gpx_converter_free(GpxConverter* conv);

int         gpx_converter_scan(GpxConverter* conv);
const char* gpx_converter_get_name(const GpxConverter* conv, int index);
int         gpx_converter_run(GpxConverter* conv, const char* csv_filename,
                               void* progress_vp);   // optional ViewPort* for spinner
