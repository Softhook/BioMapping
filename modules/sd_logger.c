// SD Logger — auto-incrementing CSV writer.

#include "sd_logger.h"
#include "util.h"
#include <storage/storage.h>
#include <string.h>
#include <stdio.h>
#include <stdarg.h>

#define LOGGER_DIR      "biomapping"
#define LOGGER_BASENAME "biomap_"
#define LOGGER_EXT       ".csv"
#define LOGGER_MAX_INDEX 999

struct SdLogger {
    Storage* storage;
    File*    file;
    bool     active;
    char     filename[64];
    int      last_index;

    // GPS+GSR batch buffer: accumulate formatted rows each tick,
    // flush to SD in one storage_file_write every FLUSH_INTERVAL seconds.
    // 50 rows × ~80 bytes (worst-case GPS+GSR row, 11 columns incl. hacc_m) = ~4000 bytes < 4096.
    char gsr_batch[4096];
    int  gsr_batch_len;
};

SdLogger* sd_logger_alloc(Storage* storage) {
    furi_assert(storage);
    SdLogger* l = malloc(sizeof(SdLogger));
    furi_assert(l);
    *l = (SdLogger){.storage = storage};
    return l;
}

void sd_logger_free(SdLogger* l) {
    furi_assert(l);
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
        FURI_LOG_W("SdLogger", "All %d slots used — wrapping to 001", LOGGER_MAX_INDEX);
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
    char full_path[96];
    snprintf(full_path, sizeof(full_path), EXT_PATH(LOGGER_DIR "/%s"), l->filename);

    l->file = storage_file_alloc(l->storage);
    if(!l->file || !storage_file_open(l->file, full_path, FSAM_WRITE, FSOM_CREATE_ALWAYS)) {
        FURI_LOG_E("SdLogger", "Failed to open %s", full_path);
        if(l->file) { storage_file_free(l->file); l->file = NULL; }
        l->filename[0] = '\0';
        return false;
    }

    size_t hlen = strlen(header);
    uint16_t written = storage_file_write(l->file, header, hlen);
    if(written != hlen) {
        FURI_LOG_E("SdLogger", "Header write failed (%d/%d)", written, (int)hlen);
        storage_file_close(l->file);
        storage_file_free(l->file);
        l->file = NULL;
        l->filename[0] = '\0';
        return false;
    }
    // Sync immediately, same reasoning as sd_logger_batch_flush(): a
    // "successful" storage_file_write() only means FatFs accepted the
    // bytes into its cache, not that they reached physical media. Without
    // this, a crash in the FLUSH_INTERVAL-seconds window before the first
    // batch flush loses the header too, leaving a literal 0-byte file on
    // disk — the exact signature seen on tracks 86 and 98. Best-effort:
    // a failed sync is logged but doesn't fail the start, since the bytes
    // are already (uncommitted) in FatFs and the next batch flush's sync
    // will very likely catch this file up regardless.
    if(!storage_file_sync(l->file)) {
        FURI_LOG_W("SdLogger", "Header sync failed (written, not yet confirmed durable)");
    }

    l->active = true;
    FURI_LOG_I("SdLogger", "Recording to %s", full_path);
    return true;
}

bool sd_logger_start(SdLogger* l, const char* header) {
    furi_assert(l);
    furi_assert(!l->active);
    return open_log_file(l, header);
}

void sd_logger_stop(SdLogger* l) {
    furi_assert(l);
    if(!l->file) return;
    storage_file_close(l->file);
    storage_file_free(l->file);
    l->file   = NULL;
    l->active = false;
    FURI_LOG_I("SdLogger", "Stopped %s", l->filename);
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
    furi_assert(l);
    if(!l->active || !l->file) return 0;
    if(l->gsr_batch_len == 0) return 0;

    uint16_t written = storage_file_write(l->file, l->gsr_batch,
                                          (size_t)l->gsr_batch_len);
    int flushed = l->gsr_batch_len;

    if(written != (uint16_t)flushed) {
        FURI_LOG_E("SdLogger", "Batch flush error: %d/%d",
                   written, flushed);
        return -1;
    }

    l->gsr_batch_len = 0;

    // Force the write through to physical media now, not just into the
    // filesystem's own cache. Without this, storage_file_write() "succeeding"
    // only means the bytes are handed to FatFs — they can still be lost
    // entirely on a hard crash/reset before the file is ever closed
    // (sd_logger_stop()'s storage_file_close(), the only other place that
    // would commit them). A failed sync here is NOT treated as a flush
    // failure: the bytes are already written and gsr_batch_len is already
    // cleared, so returning -1 (which callers treat as "retry the same
    // buffer") would duplicate this data on the next flush. Log it and
    // move on — the next flush's sync call will very likely catch up
    // regardless, since FatFs sync typically commits all outstanding
    // cached writes for the file, not just the most recent one.
    if(!storage_file_sync(l->file)) {
        FURI_LOG_W("SdLogger", "Batch flush: sync failed (written, not yet confirmed durable)");
    }

    return flushed;
}

// Append a pre-formatted row to the internal batch buffer.
// Returns false on overflow (data not appended, caller should log/drop).
bool sd_logger_batch_append(SdLogger* l, const char* data, size_t len) {
    furi_assert(l);
    if(len == 0) return true;
    if(l->gsr_batch_len + (int)len > (int)sizeof(l->gsr_batch)) {
        FURI_LOG_W("SdLogger", "Batch overflow (%d + %d > %d)",
                   l->gsr_batch_len, (int)len, (int)sizeof(l->gsr_batch));
        return false;
    }
    memcpy(l->gsr_batch + l->gsr_batch_len, data, len);
    l->gsr_batch_len += (int)len;
    return true;
}

// Format a row directly into the batch buffer, avoiding an intermediate
// stack buffer and the memcpy that sd_logger_batch_append would require.
// Returns bytes written to the buffer, or 0 on overflow/error.
int sd_logger_batch_printf(SdLogger* l, const char* fmt, ...) {
    furi_assert(l);
    if(!l->active) return 0;

    int remaining = (int)sizeof(l->gsr_batch) - l->gsr_batch_len;
    if(remaining <= 0) {
        FURI_LOG_W("SdLogger", "Batch printf overflow (buffer full)");
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
        FURI_LOG_W("SdLogger", "Batch printf truncated (%d >= %d) — row discarded",
                   n, remaining);
        return 0;
    }
    l->gsr_batch_len += n;
    return n;
}

const char* sd_logger_get_filename(const SdLogger* l) { return l->filename; }
