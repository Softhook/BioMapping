// SD Logger — auto-incrementing CSV writer.

#include "sd_logger.h"
#include <storage/storage.h>
#include <string.h>
#include <stdio.h>

#define LOGGER_DIR      "biomapping/"
#define LOGGER_BASENAME "biomap_"
#define LOGGER_EXT       ".csv"
#define LOGGER_MAX_INDEX 999

struct SdLogger {
    Storage* storage;
    File*    file;
    bool     active;
    char     filename[64];
    int      last_index;
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
            int idx = 0;
            const char* p = name + 7;
            while(p < name + len - 4 && *p >= '0' && *p <= '9') {
                idx = idx * 10 + (*p - '0');
                p++;
            }
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
    snprintf(full_path, sizeof(full_path), EXT_PATH(LOGGER_DIR "%s"), l->filename);

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

bool        sd_logger_is_active(const SdLogger* l)   { return l->active; }
const char* sd_logger_get_filename(const SdLogger* l) { return l->filename; }

bool sd_logger_write_row(
    SdLogger*   l,
    const char* timestamp,
    float       lat, float lon, float alt,
    int         sats, int fix,
    int16_t     gsr_raw) {
    furi_assert(l);
    if(!l->active || !l->file) return false;

    char row[256];
    int len = snprintf(
        row, sizeof(row),
        "%s,%.6f,%.6f,%.1f,%d,%d,%d\n",
        timestamp ? timestamp : "",
        (double)lat, (double)lon, (double)alt,
        sats, fix, (int)gsr_raw);

    uint16_t written = storage_file_write(l->file, row, (size_t)len);
    if(written != (uint16_t)len) {
        FURI_LOG_E("SdLogger", "Write error: %d/%d", written, len);
        return false;
    }
    return true;
}
