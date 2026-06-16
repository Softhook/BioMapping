#pragma once

// SD Logger Module for BioMapping 3.0
// Writes sensor data as CSV rows to the Flipper SD card.
//
// Files are auto-incremented: biomap_001.csv, biomap_002.csv, …
// up to biomap_999.csv. After that, it wraps (but warns via log).
//
// CSV columns:
//   timestamp,lat,lon,alt,sats,fix,gsr_raw
//
// All fields are written every second regardless of fix state.
// The GPX converter filters and processes the data later.

#include <furi.h>
#include <storage/storage.h>
#include <stdbool.h>
#include <stdint.h>

typedef struct SdLogger SdLogger;

// Lifecycle. Storage should already be open (app lifetime ownership).
SdLogger* sd_logger_alloc(Storage* storage);
void      sd_logger_free(SdLogger* logger);

// Opens the next auto-incremented file and writes the CSV header.
// Returns false if the file could not be created.
bool sd_logger_start(SdLogger* logger);

// Closes the file safely.
void sd_logger_stop(SdLogger* logger);

// Returns true while a file is open and recording.
bool sd_logger_is_active(const SdLogger* logger);

// Returns the filename of the currently open file (empty string if none).
const char* sd_logger_get_filename(const SdLogger* logger);

// Write one CSV row. Called once per second from the main tick accumulator.
// Pass 0 for unused fields (e.g. lat/lon when GPS disabled, gsr_raw when GSR disabled).
void sd_logger_write_row(
    SdLogger*   logger,
    const char* timestamp,    // ISO 8601 UTC string, e.g. "2026-06-05T13:33:12Z"
    float       lat,
    float       lon,
    float       alt,
    int         sats,
    int         fix,
    int16_t     gsr_raw);
