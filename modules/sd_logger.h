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
// gsr_batch's doc comment (sd_logger.c) for the 2026-08-05 sizing rationale.
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
// Lifetime max, never reset — added 2026-08-03 alongside gsr_sensor.h's
// i2c_peak_ms/rf_rssi_peak_ms/rf_retune_peak_ms: tracks 116 and 117 both
// showed real tick_dt_ms stalls (up to ~950 ms) landing exactly on the
// once-per-FLUSH_INTERVAL flush tick while those three GSR-worker-thread
// columns stayed near zero, pointing at the SD write/sync itself (main
// thread, ~20-60 ms normally, occasionally much longer on real SD cards)
// rather than any GSR/RF hardware call. See docs/gps_rf_mutex_status.md.
uint32_t    sd_logger_get_flush_peak_ms(const SdLogger* logger);

// Duration of the most recent completed batch flush (write+sync), in ms.
// 0 until the first successful flush completes.
uint32_t    sd_logger_get_flush_last_ms(const SdLogger* logger);

// Max flush duration observed since the previous call, in ms.
// Calling this function resets the windowed max back to 0.
uint32_t    sd_logger_take_flush_window_max_ms(SdLogger* logger);

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
