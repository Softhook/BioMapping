#pragma once

// GPX Converter — reads biomap_*.csv, writes biomap_*.gpx.
// EMA + derivative applied to raw GSR; only fix>0 rows become trackpoints.

#include <storage/storage.h>
#include <stdbool.h>

#define GPX_EMA_ALPHA       0.2f
#define GPX_ELEVATION_SCALE 0.5f
#define GPX_MAX_CSV_FILES   32

typedef struct GpxConverter GpxConverter;

GpxConverter* gpx_converter_alloc(Storage* storage);
void          gpx_converter_free(GpxConverter* conv);

int         gpx_converter_scan(GpxConverter* conv);
const char* gpx_converter_get_name(const GpxConverter* conv, int index);
int         gpx_converter_run(GpxConverter* conv, const char* csv_filename);
