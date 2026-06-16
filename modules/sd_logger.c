// SD Logger Module for BioMapping 3.0
// Auto-incrementing CSV data writer.
//
// Files created at: /ext/biomap_001.csv, biomap_002.csv, … biomap_999.csv
// Scans for the next unused index at start time so existing logs are never
// overwritten.

#include "sd_logger.h"

#include <storage/storage.h>
#include <string.h>
#include <stdio.h>

#define LOGGER_DIR         ""         // store directly in /ext/
#define LOGGER_BASENAME    "biomap_"
#define LOGGER_EXT         ".csv"
#define LOGGER_MAX_INDEX   999

struct SdLogger {
    Storage* storage;
    File*    file;
    bool     active;
    char     filename[64]; // e.g. "biomap_042.csv"
    int      last_index;   // Cached last used index, 0 if not scanned yet
};

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
SdLogger* sd_logger_alloc(Storage* storage) {
    furi_assert(storage);
    SdLogger* logger = malloc(sizeof(SdLogger));
    furi_assert(logger);

    logger->storage  = storage;
    logger->file     = NULL;
    logger->active   = false;
    logger->filename[0] = '\0';
    logger->last_index  = 0;

    return logger;
}

void sd_logger_free(SdLogger* logger) {
    furi_assert(logger);
    if(logger->active) {
        sd_logger_stop(logger); // safety: close open file
    }
    free(logger);
}

// ---------------------------------------------------------------------------
// Find next unused file index
// ---------------------------------------------------------------------------
static int find_next_index(SdLogger* logger) {
    char path[64];
    int start_i = logger->last_index > 0 ? logger->last_index + 1 : 1;
    if(start_i > LOGGER_MAX_INDEX) {
        start_i = 1;
    }

    // Scan from start_i to LOGGER_MAX_INDEX
    for(int i = start_i; i <= LOGGER_MAX_INDEX; i++) {
        snprintf(path, sizeof(path), EXT_PATH(LOGGER_BASENAME "%03d" LOGGER_EXT), i);
        if(!storage_file_exists(logger->storage, path)) {
            logger->last_index = i;
            return i;
        }
    }

    // If we scanned from start_i > 1, wrap around and scan from 1 to start_i - 1
    if(start_i > 1) {
        for(int i = 1; i < start_i; i++) {
            snprintf(path, sizeof(path), EXT_PATH(LOGGER_BASENAME "%03d" LOGGER_EXT), i);
            if(!storage_file_exists(logger->storage, path)) {
                logger->last_index = i;
                return i;
            }
        }
    }

    // All slots used — fall back to overwriting slot 1
    FURI_LOG_W("SdLogger", "All %d log slots used, wrapping to 001", LOGGER_MAX_INDEX);
    logger->last_index = 1;
    return 1;
}

// ---------------------------------------------------------------------------
// Start recording
// ---------------------------------------------------------------------------
bool sd_logger_start(SdLogger* logger) {
    furi_assert(logger);
    furi_assert(!logger->active);

    int idx = find_next_index(logger);
    snprintf(
        logger->filename,
        sizeof(logger->filename),
        LOGGER_BASENAME "%03d" LOGGER_EXT,
        idx);

    char full_path[80];
    snprintf(full_path, sizeof(full_path), EXT_PATH("%s"), logger->filename);

    logger->file = storage_file_alloc(logger->storage);
    if(!logger->file || !storage_file_open(logger->file, full_path, FSAM_WRITE, FSOM_CREATE_ALWAYS)) {
        FURI_LOG_E("SdLogger", "Failed to open %s", full_path);
        if(logger->file) {
            storage_file_free(logger->file);
            logger->file = NULL;
        }
        logger->filename[0] = '\0';
        return false;
    }

    // CSV header
    const char* header = "timestamp,lat,lon,alt,sats,fix,gsr_raw\n";
    uint16_t hdr_written = storage_file_write(logger->file, header, strlen(header));
    if(hdr_written != strlen(header)) {
        FURI_LOG_E("SdLogger", "Failed to write CSV header (%d/%d bytes)", hdr_written, (int)strlen(header));
        storage_file_close(logger->file);
        storage_file_free(logger->file);
        logger->file = NULL;
        logger->filename[0] = '\0';
        return false;
    }

    logger->active = true;
    FURI_LOG_I("SdLogger", "Recording to %s", full_path);
    return true;
}

// ---------------------------------------------------------------------------
// Stop recording
// ---------------------------------------------------------------------------
void sd_logger_stop(SdLogger* logger) {
    furi_assert(logger);
    if(!logger->file) return;

    storage_file_close(logger->file);
    storage_file_free(logger->file);
    logger->file   = NULL;
    logger->active = false;
    FURI_LOG_I("SdLogger", "Stopped recording %s", logger->filename);
}

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------
bool sd_logger_is_active(const SdLogger* logger) {
    return logger->active;
}

const char* sd_logger_get_filename(const SdLogger* logger) {
    return logger->filename;
}

// ---------------------------------------------------------------------------
// Write one CSV row (call once per second)
// ---------------------------------------------------------------------------
void sd_logger_write_row(
    SdLogger*   logger,
    const char* timestamp,
    float       lat,
    float       lon,
    float       alt,
    int         sats,
    int         fix,
    int16_t     gsr_raw) {
    furi_assert(logger);

    if(!logger->active || !logger->file) return;

    char row[256];
    snprintf(
        row, sizeof(row),
        "%s,%.6f,%.6f,%.1f,%d,%d,%d\n",
        timestamp ? timestamp : "",
        (double)lat,
        (double)lon,
        (double)alt,
        sats,
        fix,
        (int)gsr_raw);

    uint16_t written = storage_file_write(logger->file, row, strlen(row));
    if(written != strlen(row)) {
        FURI_LOG_E("SdLogger", "Write error: %d/%d bytes", written, (int)strlen(row));
    }
}
