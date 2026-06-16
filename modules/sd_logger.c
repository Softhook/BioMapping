// SD Logger — auto-incrementing CSV writer.

#include "sd_logger.h"
#include <storage/storage.h>
#include <string.h>
#include <stdio.h>

#define LOGGER_BASENAME  "biomap_"
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
    char path[64];
    for(int i = 1; i <= LOGGER_MAX_INDEX; i++) {
        snprintf(path, sizeof(path), EXT_PATH(LOGGER_BASENAME "%03d" LOGGER_EXT), i);
        if(!storage_file_exists(l->storage, path)) {
            l->last_index = i;
            return i;
        }
    }
    FURI_LOG_W("SdLogger", "All %d slots used — wrapping to 001", LOGGER_MAX_INDEX);
    l->last_index = 1;
    return 1;
}

bool sd_logger_start(SdLogger* l) {
    furi_assert(l);
    furi_assert(!l->active);

    int idx = find_next_index(l);
    snprintf(l->filename, sizeof(l->filename), LOGGER_BASENAME "%03d" LOGGER_EXT, idx);

    char full_path[80];
    snprintf(full_path, sizeof(full_path), EXT_PATH("%s"), l->filename);

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

void sd_logger_write_row(
    SdLogger*   l,
    const char* timestamp,
    float       lat, float lon, float alt,
    int         sats, int fix,
    int16_t     gsr_raw) {
    furi_assert(l);
    if(!l->active || !l->file) return;

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
    }
}
