// SD Logger — auto-incrementing CSV writer.

#include "sd_logger.h"
#include "util.h"
#include <storage/storage.h>
#include <string.h>
#include <stdio.h>

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
    // 10 rows × ~45 bytes + safety = 512 bytes.
    char gsr_batch[512];
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
        if(strncmp(name, LOGGER_BASENAME, 7) == 0 && strcmp(name + len - 4, LOGGER_EXT) == 0) {
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

bool sd_logger_start(SdLogger* l) {
    furi_assert(l);
    furi_assert(!l->active);

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

    const char* header = "timestamp,lat,lon,alt,sats,fix,gsr_raw\n";
    uint16_t written = storage_file_write(l->file, header, strlen(header));
    if(written != strlen(header)) {
        FURI_LOG_E("SdLogger", "Header write failed (%d/%d)", written, (int)strlen(header));
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

void sd_logger_stop(SdLogger* l) {
    furi_assert(l);
    if(!l->file) return;
    storage_file_close(l->file);
    storage_file_free(l->file);
    l->file   = NULL;
    l->active = false;
    FURI_LOG_I("SdLogger", "Stopped %s", l->filename);
}

// ─────────────────────────────────────────────────────────────────────────────
// GSR-only logging — 2-column CSV: timestamp,gsr_raw (no GPS fields).
// Called at 10 Hz; rows are ~30 bytes.  A 1-hour session is ~1 MB.
// ─────────────────────────────────────────────────────────────────────────────
bool sd_logger_start_gsr(SdLogger* l) {
    furi_assert(l);
    furi_assert(!l->active);

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

    const char* header = "timestamp,gsr_raw\n";
    uint16_t written = storage_file_write(l->file, header, strlen(header));
    if(written != strlen(header)) {
        FURI_LOG_E("SdLogger", "GSR header write failed (%d/%d)", written, (int)strlen(header));
        storage_file_close(l->file);
        storage_file_free(l->file);
        l->file = NULL;
        l->filename[0] = '\0';
        return false;
    }

    l->active = true;
    FURI_LOG_I("SdLogger", "GSR-only recording to %s", full_path);
    return true;
}

bool sd_logger_write_row_gsr(SdLogger* l, const char* timestamp, int32_t gsr_raw) {
    furi_assert(l);
    if(!l->active || !l->file) return false;

    char row[64];
    int len = snprintf(row, sizeof(row), "%s,%ld\n",
        timestamp ? timestamp : "", (long)gsr_raw);

    if(len <= 0 || len >= (int)sizeof(row)) {
        FURI_LOG_E("SdLogger", "GSR row format overflow (%d) — row skipped", len);
        return true;
    }

    uint16_t written = storage_file_write(l->file, row, (size_t)len);
    if(written != (uint16_t)len) {
        FURI_LOG_E("SdLogger", "GSR write error: %d/%d", written, len);
        return false;
    }
    return true;
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

bool        sd_logger_is_active(const SdLogger* l)   { return l->active; }
const char* sd_logger_get_filename(const SdLogger* l) { return l->filename; }

bool sd_logger_write_row(
    SdLogger*   l,
    const char* timestamp,
    float       lat, float lon, float alt,
    int         sats, int fix,
    int32_t     gsr_raw) {
    furi_assert(l);
    if(!l->active || !l->file) return false;

    char row[256];
    int len = snprintf(
        row, sizeof(row),
        "%s,%.6f,%.6f,%.1f,%d,%d,%ld\n",
        timestamp ? timestamp : "",
        (double)lat, (double)lon, (double)alt,
        sats, fix, (long)gsr_raw);

    // snprintf returns the number of chars it *would* write; if >= sizeof(row)
    // the output was truncated.  Skip the row rather than writing garbage or
    // falsely signalling a write error that would stop the recording session.
    if(len <= 0 || len >= (int)sizeof(row)) {
        FURI_LOG_E("SdLogger", "Row format overflow (%d) — row skipped", len);
        return true;  // session continues
    }

    uint16_t written = storage_file_write(l->file, row, (size_t)len);
    if(written != (uint16_t)len) {
        FURI_LOG_E("SdLogger", "Write error: %d/%d", written, len);
        return false;
    }
    return true;
}
