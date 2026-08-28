#pragma once

// SD Logger — auto-incrementing CSV writer.
// Files: /ext/biomapping/biomap_001.csv … biomap_999.csv (wraps at 999).
// Column layout varies by mode (GSR-only / GPS+GSR / GPS+GSR+RF) — see the
// BIOMAP_CSV_COLS_* headers in biomap_config.h for the authoritative,
// currently-in-force column lists, and docs/csv_schema.md for the
// field-by-field specification.

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
// The internal buffer (24576 bytes, sd_logger.c) holds the ~100 rows/flush
// at the 10 Hz rate with real headroom over worst-case row length — see
// gsr_batch's doc comment (sd_logger.c) for the sizing rationale.
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

// Worst single sd_logger_batch_flush() call ever seen (storage_file_write()
// + storage_file_sync() together, real furi_get_tick() delta), in ms.
// Lifetime max, never reset — pairs with gsr_sensor.h's peak-ms accessors:
// real tick_dt_ms stalls (up to ~950 ms) have landed exactly on the
// once-per-FLUSH_INTERVAL flush tick while those GSR-worker columns stayed
// near zero, pointing at the SD write/sync itself (main thread, ~20-60 ms
// normally, occasionally much longer on real SD cards) rather than any
// GSR/RF hardware call. See docs/gps_rf_mutex_status.md.
uint32_t    sd_logger_get_flush_peak_ms(const SdLogger* logger);

// How long sd_logger_start()'s one-shot log-file pre-allocation took, in ms
// (0 if BIOMAP_SD_PREALLOC is off, biomap_config.h). Set once per recording,
// not a lifetime-max like flush_peak_ms above — see sd_logger.c's
// SD_LOGGER_PREALLOC_BYTES / preallocate_log_file() and docs/
// gps_rf_mutex_status.md's "option E" entries for why this exists: testing
// whether growing the file to its expected full size once, up front, via
// storage_file_seek() keeps the once-per-FLUSH_INTERVAL SD-flush stall
// (flush_peak_ms above) from getting worse across a long recording the way
// track 016 showed.
uint32_t    sd_logger_get_prealloc_ms(const SdLogger* logger);

// Current and worst-ever in-memory batch occupancy (bytes).
// These expose queue pressure directly: sustained high occupancy means
// producer (tick path) is outrunning consumer (flush cadence).
uint32_t    sd_logger_get_batch_fill_bytes(const SdLogger* logger);
uint32_t    sd_logger_get_batch_fill_peak_bytes(const SdLogger* logger);

// Cumulative continuity risk counters.
// overflow_count increments when a row cannot be appended/formatted into
// the batch buffer. flush_fail_count increments when a flush write or
// post-write sync fails.
uint32_t    sd_logger_get_overflow_count(const SdLogger* logger);
uint32_t    sd_logger_get_flush_fail_count(const SdLogger* logger);
