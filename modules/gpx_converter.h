#pragma once

// GPX Converter Module for BioMapping 3.0
// Post-processing: reads a biomap_*.csv file and produces a biomap_*.gpx file.
//
// Signal processing (EMA smoothing + derivative) is applied to the raw GSR
// data during conversion, so tuning parameters can be changed without
// re-recording.
//
// Only rows with valid GPS data (fix > 0, lat != 0) are written to GPX.
// The GSR elevation is encoded in the <ele> tag.

#include <furi.h>
#include <storage/storage.h>
#include <stdbool.h>

#define GPX_EMA_ALPHA       0.2f
#define GPX_ELEVATION_SCALE 0.5f
#define GPX_MAX_CSV_FILES   32

typedef struct GpxConverter GpxConverter;

GpxConverter* gpx_converter_alloc(Storage* storage);
void          gpx_converter_free(GpxConverter* conv);

// Scan /ext/ for biomap_*.csv files. Returns the count found.
int gpx_converter_scan(GpxConverter* conv);

// Get filename at index (for building a selection menu). Index from 0 to scan_count-1.
const char* gpx_converter_get_name(const GpxConverter* conv, int index);

// Convert a CSV file to GPX. The GPX file is created alongside the CSV with .gpx extension.
// Returns true on success.
bool gpx_converter_run(GpxConverter* conv, const char* csv_filename);
