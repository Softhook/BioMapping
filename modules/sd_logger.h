#pragma once

// SD Logger — auto-incrementing CSV writer.
// Files: /ext/biomap_001.csv … biomap_999.csv (wraps at 999).
// Columns: timestamp,lat,lon,alt,sats,fix,gsr_raw

#include <storage/storage.h>
#include <stdbool.h>
#include <stdint.h>

typedef struct SdLogger SdLogger;

SdLogger* sd_logger_alloc(Storage* storage);
void      sd_logger_free(SdLogger* logger);

bool        sd_logger_start(SdLogger* logger);
void        sd_logger_stop(SdLogger* logger);

// GSR-only mode: 2-column CSV (timestamp,gsr_raw), no GPS fields.
// Use sd_logger_start_gsr + sd_logger_write_row_gsr as a matched pair.
// For batched writes, accumulate rows in memory and call sd_logger_flush_gsr
// once per second instead of sd_logger_write_row_gsr every tick.
bool        sd_logger_start_gsr(SdLogger* logger);
bool        sd_logger_write_row_gsr(SdLogger* logger, const char* timestamp, int32_t gsr_raw);
bool        sd_logger_flush_gsr(SdLogger* logger, const char* data, size_t len);

bool        sd_logger_is_active(const SdLogger* logger);
const char* sd_logger_get_filename(const SdLogger* logger);

bool sd_logger_write_row(
    SdLogger*   logger,
    const char* timestamp,
    float       lat, float lon, float alt,
    int         sats, int fix,
    int32_t     gsr_raw);
