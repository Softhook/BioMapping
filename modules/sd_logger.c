// SD Logger — auto-incrementing CSV writer.

#include "sd_logger.h"
#include "biomap_config.h"
#include "util.h"
#include <furi.h>
#include <storage/storage.h>
#include <string.h>
#include <stdio.h>
#include <stdarg.h>

#define LOGGER_DIR      "biomapping"
#define LOGGER_BASENAME "biomap_"
#define LOGGER_EXT       ".csv"
#define LOGGER_MAX_INDEX 999

// Always real FURI_LOG_* calls (2026-08-05): previously compiled out under
// BIOMAP_DEBUG_FIELDS=0, but that macro is gone — debug CSV *fields* are
// now a runtime Options-menu toggle (BioMapApp::debug_fields_enabled),
// unrelated to whether these serial logs exist. SdLogger has no app-level
// context to gate on anyway; Flipper's own runtime log level already
// controls what's actually visible on a given build/session.
#define SD_LOG_I(tag, fmt, ...) FURI_LOG_I(tag, fmt, ##__VA_ARGS__)
#define SD_LOG_W(tag, fmt, ...) FURI_LOG_W(tag, fmt, ##__VA_ARGS__)
#define SD_LOG_E(tag, fmt, ...) FURI_LOG_E(tag, fmt, ##__VA_ARGS__)

struct SdLogger {
    Storage* storage;
    File*    file;
    bool     active;
    char     filename[64];
    int      last_index;

    // GPS+GSR+RF batch buffer: accumulate formatted rows each tick,
    // flush to SD in one storage_file_write every FLUSH_INTERVAL seconds.
    //
    // Sized against a worst-case row, not the ~110-125 byte typical case the
    // previous 12288-byte size assumed (2026-08-05, track 015 investigation
    // — docs/gps_rf_mutex_status.md). With debug fields on (now an Options-
    // menu runtime toggle, biomap_config.h), several
    // of the 12 debug columns are lifetime peak-hold/cumulative counters
    // (log_fill_peak_bytes, flush_peak_ms, log_overflow_count, etc.)
    // formatted as bare %u — they gain digits as a recording runs longer,
    // permanently costing the shared buffer bytes on every subsequent row.
    // The old size left only ~5 bytes/row of headroom over its own typical-
    // case estimate, so a long enough recording reliably grew into it:
    // track 015 crossed the 12288 cap at t=1009s (66% into a 1515s walk)
    // and stayed over budget for the rest of the recording, silently
    // dropping one row every FLUSH_INTERVAL from then on — overflow_count
    // itself growing a digit made this self-reinforcing, not self-correcting.
    // ~169 bytes/row worst case (generous per-field digit bounds, not
    // absolute type limits) × 100 rows = ~16900 bytes; doubling the old
    // size to 24576 clears that with real margin to spare for future
    // columns. Also the same total footprint as the double-buffered
    // gsr_batch[2][12288] tried and reverted earlier (7e4bc3a) — already
    // proven to fit comfortably in the Flipper's RAM.
    char gsr_batch[24576];
    int  gsr_batch_len;

    // Worst single batch_flush() (write+sync) real duration ever seen —
    // see sd_logger_get_flush_peak_ms()'s doc comment (sd_logger.h).
    uint32_t flush_peak_ms;

    // Continuity-pressure metrics: current/peak batch occupancy and
    // cumulative failures that indicate logging risk under load.
    uint32_t batch_fill_peak_bytes;
    uint32_t overflow_count;
    uint32_t flush_fail_count;
};

SdLogger* sd_logger_alloc(Storage* storage) {
    furi_check(storage, "SdLogger: NULL storage in alloc()");
    SdLogger* l = malloc(sizeof(SdLogger));
    furi_check(l, "SdLogger: NULL logger alloc");
    *l = (SdLogger){.storage = storage};
    return l;
}

void sd_logger_free(SdLogger* l) {
    furi_check(l, "SdLogger: NULL in free()");
    if(l->active) sd_logger_stop(l);
    free(l);
}

// Single-pass scan for the next unused index
static int find_next_index(SdLogger* l) {
    File* dir = storage_file_alloc(l->storage);
    if(!storage_dir_open(dir, EXT_PATH(LOGGER_DIR))) {
        storage_file_free(dir);
        l->last_index = 1;
        return 1;
    }

    int max_idx = 0;
    FileInfo info;
    char name[64];
    while(storage_dir_read(dir, &info, name, sizeof(name))) {
        if(info.flags & FSF_DIRECTORY) continue;
        // biomap_parse_file_index() already validates the "biomap_" prefix,
        // ".csv" suffix, and numeric body in one place — no need to
        // re-check the prefix/suffix here too (util.h is the single
        // source of truth for the filename format).
        int idx = biomap_parse_file_index(name);
        if(idx > max_idx && idx <= LOGGER_MAX_INDEX) {
            max_idx = idx;
        }
    }
    storage_dir_close(dir);
    storage_file_free(dir);

    int next_idx = max_idx + 1;
    if(next_idx > LOGGER_MAX_INDEX) {
        SD_LOG_W("SdLogger", "All %d slots used — wrapping to 001", LOGGER_MAX_INDEX);
        next_idx = 1;
    }
    l->last_index = next_idx;
    return next_idx;
}

// Open (or create) the next auto-indexed CSV file and write a header row.
// Returns true on success; on failure the logger is left inactive with no
// open file handle.
static bool open_log_file(SdLogger* l, const char* header) {
    int idx = find_next_index(l);
    snprintf(l->filename, sizeof(l->filename), LOGGER_BASENAME "%03d" LOGGER_EXT, idx);

#if BIOMAP_SD_DRY_RUN
    UNUSED(header);
    l->active = true;
    l->file = NULL;
    SD_LOG_W("SdLogger", "SD dry-run active: bypassing file I/O for %s", l->filename);
    return true;
#else
    char full_path[96];
    snprintf(full_path, sizeof(full_path), EXT_PATH(LOGGER_DIR "/%s"), l->filename);

    l->file = storage_file_alloc(l->storage);
    if(!l->file || !storage_file_open(l->file, full_path, FSAM_WRITE, FSOM_CREATE_ALWAYS)) {
        SD_LOG_E("SdLogger", "Failed to open %s", full_path);
        if(l->file) { storage_file_free(l->file); l->file = NULL; }
        l->filename[0] = '\0';
        return false;
    }

    size_t hlen = strlen(header);
    uint16_t written = storage_file_write(l->file, header, hlen);
    if(written != hlen) {
        SD_LOG_E("SdLogger", "Header write failed (%d/%d)", written, (int)hlen);
        storage_file_close(l->file);
        storage_file_free(l->file);
        l->file = NULL;
        l->filename[0] = '\0';
        return false;
    }
    // Sync immediately, same reasoning as sd_logger_batch_flush(): a
    // "successful" storage_file_write() only means FatFs accepted the
    // bytes into its cache, not that they reached physical media.
    bool header_synced = storage_file_sync(l->file);
    if(!header_synced) {
        SD_LOG_W("SdLogger", "Header sync failed (written, not yet confirmed durable)");
    }

    l->active = true;
    SD_LOG_I("SdLogger", "Recording to %s", full_path);
    return true;
#endif
}

bool sd_logger_start(SdLogger* l, const char* header) {
    furi_check(l, "SdLogger: NULL in start()");
    furi_check(!l->active, "SdLogger: already active in start()");
    bool ok = open_log_file(l, header);
    if(ok) {
        l->gsr_batch_len = 0;
        l->flush_peak_ms = 0;
        l->batch_fill_peak_bytes = 0;
        l->overflow_count = 0;
        l->flush_fail_count = 0;
    }
    return ok;
}

void sd_logger_stop(SdLogger* l) {
    furi_check(l, "SdLogger: NULL in stop()");
    if(!l->active && !l->file) return;
    if(l->gsr_batch_len > 0) {
        sd_logger_batch_flush(l);
    }
    if(l->file) {
        storage_file_close(l->file);
        storage_file_free(l->file);
        l->file = NULL;
    }
    l->active = false;
    SD_LOG_I("SdLogger", "Stopped %s", l->filename);
}


// Flush the internal batch buffer to SD in one write.
// Returns: >0 bytes flushed, 0 if buffer was empty, -1 on error.
//
// On error the buffer is left untouched (NOT cleared) so a subsequent call
// retries the exact same bytes rather than silently discarding data the SD
// card never actually received — the caller decides whether to retry or
// give up. A partial write (0 < written < flushed) is treated the same as
// a total failure: the whole batch is retried next time, which may
// duplicate the already-written prefix on a genuine partial write. That's
// a deliberate simplification — FatFs writes at this size (<=4 KB) are
// effectively atomic in practice, so tracking a partial-write remainder
// with a memmove isn't worth the complexity for an edge case this rare.
int sd_logger_batch_flush(SdLogger* l) {
    furi_check(l, "SdLogger: NULL in batch_flush()");
    if(!l->active) return 0;
    if(l->gsr_batch_len == 0) return 0;

#if BIOMAP_SD_DRY_RUN
    int flushed = l->gsr_batch_len;
    l->gsr_batch_len = 0;
    return flushed;
#else
    if(!l->file) return 0;

    // Timed as one unit (write+sync) since they always run back to back
    // here and the caller (biomap_session.c's Tick handler) only cares
    // about the total real time this call held the main thread — see
    // sd_logger_get_flush_peak_ms()'s doc comment (sd_logger.h).
    uint32_t flush_start = furi_get_tick();

    uint16_t written = storage_file_write(l->file, l->gsr_batch,
                                          (size_t)l->gsr_batch_len);
    int flushed = l->gsr_batch_len;

    if(written != (uint16_t)flushed) {
        SD_LOG_E("SdLogger", "Batch flush error: %d/%d",
                 written, flushed);
        uint32_t flush_dur = furi_get_tick() - flush_start;
        if(flush_dur > l->flush_peak_ms) l->flush_peak_ms = flush_dur;
        l->flush_fail_count++;
        return -1;
    }

    l->gsr_batch_len = 0;

    bool batch_synced = storage_file_sync(l->file);
    if(!batch_synced) {
        SD_LOG_W("SdLogger", "Batch sync failed");
        l->flush_fail_count++;
    }

    uint32_t flush_dur = furi_get_tick() - flush_start;
    if(flush_dur > l->flush_peak_ms) l->flush_peak_ms = flush_dur;

    return flushed;
#endif
}

// Append a pre-formatted row to the internal batch buffer.
// Returns false on overflow (data not appended, caller should log/drop).
bool sd_logger_batch_append(SdLogger* l, const char* data, size_t len) {
    furi_check(l, "SdLogger: NULL in batch_append()");
    if(len == 0) return true;
    if(l->gsr_batch_len + (int)len > (int)sizeof(l->gsr_batch)) {
        SD_LOG_W("SdLogger", "Batch overflow (%d + %d > %d)",
                 l->gsr_batch_len, (int)len, (int)sizeof(l->gsr_batch));
        l->overflow_count++;
        return false;
    }
    memcpy(l->gsr_batch + l->gsr_batch_len, data, len);
    l->gsr_batch_len += (int)len;
    if((uint32_t)l->gsr_batch_len > l->batch_fill_peak_bytes) {
        l->batch_fill_peak_bytes = (uint32_t)l->gsr_batch_len;
    }
    return true;
}

// Format a row directly into the batch buffer, avoiding an intermediate
// stack buffer and the memcpy that sd_logger_batch_append would require.
// Returns bytes written to the buffer, or 0 on overflow/error.
int sd_logger_batch_printf(SdLogger* l, const char* fmt, ...) {
    furi_check(l, "SdLogger: NULL in batch_printf()");
    if(!l->active) return 0;

    int remaining = (int)sizeof(l->gsr_batch) - l->gsr_batch_len;
    if(remaining <= 0) {
        SD_LOG_W("SdLogger", "Batch printf overflow (buffer full)");
        l->overflow_count++;
        return 0;
    }

    va_list args;
    va_start(args, fmt);
    int n = vsnprintf(l->gsr_batch + l->gsr_batch_len,
                      (size_t)remaining, fmt, args);
    va_end(args);

    if(n <= 0) return 0;
    if(n >= remaining) {
        // vsnprintf truncated the row: it wrote only `remaining - 1` bytes
        // of real content (plus a NUL) into the buffer. Do NOT advance
        // gsr_batch_len past the last complete row — doing so would leave
        // a truncated/corrupt partial row in the buffer that the next
        // sd_logger_batch_flush() would write straight to the SD card,
        // corrupting the CSV. Roll back and let the caller's overflow
        // path (emergency flush) start the row fresh in a cleared buffer.
        SD_LOG_W("SdLogger", "Batch printf truncated (%d >= %d) — row discarded",
                 n, remaining);
        l->overflow_count++;
        return 0;
    }
    l->gsr_batch_len += n;
    if((uint32_t)l->gsr_batch_len > l->batch_fill_peak_bytes) {
        l->batch_fill_peak_bytes = (uint32_t)l->gsr_batch_len;
    }
    return n;
}

const char* sd_logger_get_filename(const SdLogger* l) { return l->filename; }

uint32_t sd_logger_get_flush_peak_ms(const SdLogger* l) { return l->flush_peak_ms; }
uint32_t sd_logger_get_batch_fill_bytes(const SdLogger* l) { return (uint32_t)l->gsr_batch_len; }
uint32_t sd_logger_get_batch_fill_peak_bytes(const SdLogger* l) { return l->batch_fill_peak_bytes; }
uint32_t sd_logger_get_overflow_count(const SdLogger* l) { return l->overflow_count; }
uint32_t sd_logger_get_flush_fail_count(const SdLogger* l) { return l->flush_fail_count; }
