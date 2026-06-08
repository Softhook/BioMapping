// SD Logger Module for BioMapping 3.0
// Auto-incrementing GPX tracklog writer.
//
// Files created at: /ext/biomap_001.gpx, biomap_002.gpx, … biomap_999.gpx
// Scans for the next unused index at start time so existing walks are never
// overwritten.

#include "sd_logger.h"
#include "gps_uart.h"

#include <storage/storage.h>
#include <string.h>
#include <stdio.h>
#include <math.h>

#define LOGGER_DIR         ""         // store directly in /ext/
#define LOGGER_BASENAME    "biomap_"
#define LOGGER_EXT         ".gpx"
#define LOGGER_MAX_INDEX   999

struct SdLogger {
    Storage* storage;
    File*    file;
    bool     active;
    char     filename[64]; // e.g. "biomap_042.gpx"
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

    // GPX file header
    const char* header =
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
        "<gpx version=\"1.1\" creator=\"FlipperZero BioMapping\">\n"
        "  <trk>\n"
        "    <name>BioMapping Walk</name>\n"
        "    <trkseg>\n";
    storage_file_write(logger->file, header, strlen(header));

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

    const char* footer =
        "    </trkseg>\n"
        "  </trk>\n"
        "</gpx>\n";
    storage_file_write(logger->file, footer, strlen(footer));
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
// Write one trackpoint (call once per second)
// ---------------------------------------------------------------------------
void sd_logger_write_point(
    SdLogger*        logger,
    const GpsStatus* gps,
    float            elevation_zoomed) {
    furi_assert(logger);
    furi_assert(gps);

    if(!logger->active || !logger->file) return;

    // Require a valid fix before writing
    bool has_fix = gps->fix_valid || (gps->fix_quality > 0);
    if(!has_fix) return;

    // Guard against NaN coordinates
    if(isnan(gps->latitude) || isnan(gps->longitude)) return;

    // Build ISO 8601 timestamp from minmea date + time fields
    char time_str[32];
    if(gps->date.year != 0) {
        // minmea stores 2-digit years; values < 80 are 21st century
        int full_year = (gps->date.year < 80)
            ? 2000 + gps->date.year
            : 1900 + gps->date.year;
        snprintf(
            time_str, sizeof(time_str),
            "%04d-%02d-%02dT%02d:%02d:%02dZ",
            full_year,
            gps->date.month,
            gps->date.day,
            gps->time.hours,
            gps->time.minutes,
            gps->time.seconds);
    } else {
        // RMC date not yet received — use epoch date with real time
        snprintf(
            time_str, sizeof(time_str),
            "1970-01-01T%02d:%02d:%02dZ",
            gps->time.hours,
            gps->time.minutes,
            gps->time.seconds);
    }

    char point[256];
    snprintf(
        point, sizeof(point),
        "      <trkpt lat=\"%.6f\" lon=\"%.6f\">\n"
        "        <ele>%.2f</ele>\n"
        "        <time>%s</time>\n"
        "      </trkpt>\n",
        (double)gps->latitude,
        (double)gps->longitude,
        (double)elevation_zoomed,
        time_str);

    storage_file_write(logger->file, point, strlen(point));
}
