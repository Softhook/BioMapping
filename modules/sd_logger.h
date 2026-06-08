#pragma once

// SD Logger Module for BioMapping 3.0
// Writes GPS + GSR data as a GPX tracklog to the Flipper SD card.
//
// Files are auto-incremented: biomap_001.gpx, biomap_002.gpx, …
// up to biomap_999.gpx. After that, it wraps (but warns via log).
//
// GPX format:
//   <trkpt lat="…" lon="…">
//     <ele>…</ele>      ← GSR elevation × zoom (0.0 when GSR disabled)
//     <time>…</time>    ← ISO 8601 UTC from GPS RMC/GGA sentence
//   </trkpt>
//
// Only writes points when GPS has a valid fix.

#include <furi.h>
#include <storage/storage.h>
#include <stdbool.h>

struct GpsStatus;
typedef struct GpsStatus GpsStatus;

typedef struct SdLogger SdLogger;

// Lifecycle. Storage should already be open (app lifetime ownership).
SdLogger* sd_logger_alloc(Storage* storage);
void      sd_logger_free(SdLogger* logger);

// Opens the next auto-incremented file and writes the GPX header.
// Returns false if the file could not be created.
bool sd_logger_start(SdLogger* logger);

// Writes the GPX footer and closes the file safely.
void sd_logger_stop(SdLogger* logger);

// Returns true while a file is open and recording.
bool sd_logger_is_active(const SdLogger* logger);

// Returns the filename of the currently open file (empty string if none).
const char* sd_logger_get_filename(const SdLogger* logger);

// Write one trackpoint. Call once per second from the main tick accumulator.
// Only writes if gps->fix_valid || gps->fix_quality > 0.
// elevation_zoomed = elevation_base × zoom_level (caller applies zoom).
void sd_logger_write_point(
    SdLogger*        logger,
    const GpsStatus* gps,
    float            elevation_zoomed);
