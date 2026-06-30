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

bool        sd_logger_start(SdLogger* logger, const char* header);
void        sd_logger_stop(SdLogger* logger);

// GSR batch write API — accumulate formatted rows in memory and flush
// to SD in a single storage_file_write at the 1‑second boundary.
// The internal buffer (512 bytes) holds ~10 rows at 10 Hz.
//   sd_logger_batch_append  — append a pre-formatted row (returns false on overflow)
//   sd_logger_batch_flush   — flush buffer to SD, returns >0 on success (bytes
//                             written), 0 if buffer was empty, <0 on error.
int         sd_logger_batch_flush(SdLogger* logger);
bool        sd_logger_batch_append(SdLogger* logger, const char* data, size_t len);

const char* sd_logger_get_filename(const SdLogger* logger);

bool sd_logger_write_row(
    SdLogger*   logger,
    const char* timestamp,
    float       lat, float lon, float alt,
    int         sats, int fix,
    int32_t     gsr_raw);
