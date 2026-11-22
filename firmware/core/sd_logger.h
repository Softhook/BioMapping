#pragma once

// SD Logger — CSV writer, one file per recording, named by start time.
// Shared by every device; plain C with no device code.
//
// Files: biomapping/biomap_2026-11-19_14-32-05.csv on the card (the caller
// passes the "2026-11-19_14-32-05" part; see biomap_format_file_stamp()).
// If that name is already taken, "_2", "_3" … is added before ".csv".
// Files are only ever created new, never opened over an existing one, so an
// older recording is never overwritten.
// Column layout varies by mode (GSR-only / GPS+GSR / GPS+GSR+RF) — see the
// BIOMAP_CSV_COLS_* headers in biomap_config.h for the authoritative,
// currently-in-force column lists, and docs/csv_schema.md for the
// field-by-field specification.
//
// Everything that touches the card (opening, writing, saving, closing, the
// clock) goes through the SdPlatform functions the device hands to
// sd_logger_create(). The Flipper's are in flipper/sd_logger_flipper.c.
// One logger has at most one file open at a time.
//
// Threads: none. Every call comes from the device's main thread.

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct SdLogger SdLogger;

typedef enum {
    SdOpenOk,         // created and open for writing
    SdOpenNameTaken,  // a file of that name already exists: try the next suffix
    SdOpenFailed,     // anything else (no card, card full, faulty): give up
} SdOpenResult;

typedef enum {
    SdLogInfo,
    SdLogWarning,
    SdLogError,
} SdLogLevel;

// ── What each device supplies ───────────────────────────────────────────
// Every function gets `ctx` back as its first argument. All are required
// except `log`.
typedef struct {
    void* ctx;
    // Create `name` (e.g. "biomap_2026-11-19_14-32-05.csv") in the card's
    // biomapping folder and open it for writing, refusing if it already
    // exists. Only called with no file open.
    SdOpenResult (*open_new)(void* ctx, const char* name);
    // Write `len` bytes at the current position. Returns how many the card
    // took: `len` on success, fewer (maybe 0) if it failed part-way.
    size_t (*write)(void* ctx, const void* data, size_t len);
    // Make what has been written so far safe on the card (FatFs f_sync).
    bool (*sync)(void* ctx);
    // Move to `pos` bytes from the start. A position past the end grows
    // the file (its new space holds whatever was on the card before).
    bool (*seek)(void* ctx, uint32_t pos);
    // Cut the file off at the current position.
    bool (*truncate)(void* ctx);
    void (*close)(void* ctx);
    // A millisecond clock that counts up and wraps at 2^32 (for the
    // flush and pre-allocation timings).
    uint32_t (*now_ms)(void* ctx);
    // Optional (may be NULL): one log line.
    void (*log)(void* ctx, SdLogLevel level, const char* line);
} SdPlatform;

// `platform` is copied. `block_bytes` 0 writes every row at each flush (the
// Flipper). A device whose card stalls on writes that end part-way through
// a block (the Cardputer: 512) passes the block size, and each flush then
// writes only up to the last whole block of the file, keeping the rest
// (less than one block) for the next flush; the stop writes everything.
// Stops (core_fatal) if `platform` lacks a required function or memory
// runs out.
SdLogger* sd_logger_create(const SdPlatform* platform, uint32_t block_bytes);

// Stops an active recording first (with no end time).
void sd_logger_destroy(SdLogger* logger);

// The `ctx` given in the platform, for the device's own wrappers.
void* sd_logger_platform_ctx(const SdLogger* logger);

// `stamp` is the start-time part of the file name, e.g.
// "2026-11-19_14-32-05".
bool        sd_logger_start(SdLogger* logger, const char* header, const char* stamp);

// Flush any buffered rows, append the "# Integrity: crc32 v1" file's
// matching "# End …" trailer (row count, CRC32 over marker+header+rows,
// continuity counters, and end_time when known), trim the pre-allocated
// tail, and close. end_epoch is the clock time at stop in Unix seconds;
// pass 0 when no reading is available and the end_time token is omitted.
// A file with no trailer did not stop cleanly; a trailer whose CRC or row
// count disagrees with the data was truncated or altered after writing.
void        sd_logger_stop(SdLogger* logger, uint32_t end_epoch);

// GSR batch write API — accumulate formatted rows in memory and flush
// to SD in a single write every FLUSH_INTERVAL seconds.
// The internal buffer (24576 bytes, sd_logger.c) holds the ~100 rows/flush
// at the 10 Hz rate with real headroom over worst-case row length — see
// gsr_batch's doc comment (sd_logger.c) for the sizing rationale.
//   sd_logger_batch_append  — append a pre-formatted row (returns false on overflow)
//   sd_logger_batch_flush   — flush buffer to SD, returns >0 on success (bytes
//                             written), 0 if there was nothing to write (an
//                             empty buffer, or with block_bytes less than a
//                             whole block), <0 on error.
int         sd_logger_batch_flush(SdLogger* logger);
// The same, but writes the whole buffer even with block_bytes set: the
// final write before a stop, so the caller can retry it and warn if it
// fails. On the Flipper (block_bytes 0) the two are the same.
int         sd_logger_batch_flush_all(SdLogger* logger);
bool        sd_logger_batch_append(SdLogger* logger, const char* data, size_t len);

const char* sd_logger_get_filename(const SdLogger* logger);

// Worst single sd_logger_batch_flush() call ever seen (write + sync
// together, real platform-clock delta), in ms.
// Lifetime max, never reset — pairs with gsr_sensor.h's peak-ms accessors:
// real tick_dt_ms stalls (up to ~950 ms) have landed exactly on the
// once-per-FLUSH_INTERVAL flush tick while those GSR-worker columns stayed
// near zero, pointing at the SD write/sync itself (main thread, ~20-60 ms
// normally, occasionally much longer on real SD cards) rather than any
// GSR/RF hardware call.
uint32_t    sd_logger_get_flush_peak_ms(const SdLogger* logger);

// How long sd_logger_start()'s one-shot log-file pre-allocation took, in ms.
// Set once per recording, not a lifetime-max like flush_peak_ms above — see
// sd_logger.c's SD_LOGGER_PREALLOC_BYTES / preallocate_log_file(). Growing
// the file to its expected full size once, up front, keeps the
// once-per-FLUSH_INTERVAL SD-flush stall (flush_peak_ms above) from getting
// worse across a long recording.
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

#ifdef __cplusplus
}
#endif
