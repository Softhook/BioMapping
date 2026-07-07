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

    // GSR batch buffer: accumulate formatted rows each tick,
    // flush to SD in one storage_file_write at the 1‑second boundary.
    // 10 rows × ~85 bytes (max GPS+GSR row) + safety = 1024 bytes.
    char gsr_batch[1024];
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
        size_t len = strlen(name);
        if(len < 12) continue; // "biomap_001.csv" is 14 chars
        if(strncmp(name, LOGGER_BASENAME, sizeof(LOGGER_BASENAME) - 1) == 0 && strcmp(name + len - 4, LOGGER_EXT) == 0) {
            int idx = biomap_parse_file_index(name);
            if(idx < 0) idx = 0; // fallback for non-numeric names
            if(idx > max_idx && idx <= LOGGER_MAX_INDEX) {
                max_idx = idx;
            }
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
int sd_logger_batch_flush(SdLogger* l) {
    furi_assert(l);
    if(!l->active || !l->file) return 0;
    if(l->gsr_batch_len == 0) return 0;

    uint16_t written = storage_file_write(l->file, l->gsr_batch,
                                          (size_t)l->gsr_batch_len);
    int flushed = l->gsr_batch_len;
    l->gsr_batch_len = 0;

    if(written != (uint16_t)flushed) {
        FURI_LOG_E("SdLogger", "Batch flush error: %d/%d",
                   written, flushed);
        return -1;
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
        FURI_LOG_W("SdLogger", "Batch printf truncated (%d >= %d)",
                   n, remaining);
        l->gsr_batch_len = (int)sizeof(l->gsr_batch);
        return 0;
    }
    l->gsr_batch_len += n;
    return n;
}

const char* sd_logger_get_filename(const SdLogger* l) { return l->filename; }
