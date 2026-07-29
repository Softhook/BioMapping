#pragma once

// SD Logger — auto-incrementing CSV writer.
// Files: /ext/biomapping/biomap_001.csv … biomap_999.csv (wraps at 999).
// Columns (10): timestamp,lat,lon,hdop,pdop,sats,fix_type,speed_kts,course_deg,gsr_raw
// See docs/csv_schema.md for the authoritative field-by-field specification.

#include <storage/storage.h>
#include <stdbool.h>
#include <stdint.h>

typedef struct SdLogger SdLogger;

SdLogger* sd_logger_alloc(Storage* storage);
void      sd_logger_free(SdLogger* logger);

bool        sd_logger_start(SdLogger* logger, const char* header);
void        sd_logger_stop(SdLogger* logger);

// GSR batch write API — accumulate formatted rows in memory and flush
// to SD in a single storage_file_write every FLUSH_INTERVAL seconds.
// The internal buffer (4096 bytes) holds up to 50 rows at the 10 Hz rate.
//   sd_logger_batch_append  — append a pre-formatted row (returns false on overflow)
//   sd_logger_batch_printf  — format a row directly into the batch buffer (no
//                             intermediate stack buffer).  Returns bytes written
//                             or 0 on overflow (logged internally).
//   sd_logger_batch_flush   — flush buffer to SD, returns >0 on success (bytes
//                             written), 0 if buffer was empty, <0 on error.
int         sd_logger_batch_flush(SdLogger* logger);
bool        sd_logger_batch_append(SdLogger* logger, const char* data, size_t len);
int         sd_logger_batch_printf(SdLogger* logger, const char* fmt, ...);

const char* sd_logger_get_filename(const SdLogger* logger);

// Worst-case storage_file_write()/storage_file_sync() latency (ms)
// observed so far this session — a running max, not the latest reading.
// Added 2026-07-29 to test whether real SD card flash GC/erase stalls
// (which can block the main thread for hundreds of ms) correlate with the
// ongoing furi_check crash investigation — see
// em_scan_rf_crash_investigation.md, "Theory 2."
uint32_t sd_logger_get_max_write_ms(const SdLogger* logger);
uint32_t sd_logger_get_max_sync_ms(const SdLogger* logger);
