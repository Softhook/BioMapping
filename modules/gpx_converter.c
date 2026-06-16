// GPX Converter Module for BioMapping 3.0
// Post-processing: reads a biomap_*.csv file and produces a biomap_*.gpx file.
//
// Signal processing (EMA smoothing + derivative) is applied to the raw GSR
// data during conversion, so tuning parameters can be changed without
// re-recording.

#include "gpx_converter.h"

#include <furi.h>
#include <storage/storage.h>
#include <string.h>
#include <stdio.h>

#define TAG "GpxConverter"

// ---------------------------------------------------------------------------
// Internal structure
// ---------------------------------------------------------------------------

struct GpxConverter {
    Storage* storage;
    char filenames[GPX_MAX_CSV_FILES][32]; // stored basenames like "biomap_042.csv"
    int file_count;
};

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

GpxConverter* gpx_converter_alloc(Storage* storage) {
    GpxConverter* conv = malloc(sizeof(GpxConverter));
    memset(conv, 0, sizeof(GpxConverter));
    conv->storage = storage;
    return conv;
}

void gpx_converter_free(GpxConverter* conv) {
    furi_assert(conv);
    free(conv);
}

// ---------------------------------------------------------------------------
// Directory scan — find biomap_*.csv files on /ext/
// ---------------------------------------------------------------------------

int gpx_converter_scan(GpxConverter* conv) {
    furi_assert(conv);
    conv->file_count = 0;

    File* dir = storage_file_alloc(conv->storage);
    if(!storage_dir_open(dir, EXT_PATH(""))) {
        FURI_LOG_E(TAG, "Failed to open /ext/ directory");
        storage_file_free(dir);
        return 0;
    }

    FileInfo info;
    char name[64];
    while(storage_dir_read(dir, &info, name, sizeof(name))) {
        // Skip directories
        if(info.flags & FSF_DIRECTORY) continue;

        // Check for "biomap_" prefix and ".csv" suffix
        size_t len = strlen(name);
        if(len < 12) continue; // "biomap_X.csv" is the minimum length
        if(strncmp(name, "biomap_", 7) != 0) continue;
        if(len < 4 || strcmp(name + len - 4, ".csv") != 0) continue;

        // Store the basename
        if(conv->file_count < GPX_MAX_CSV_FILES) {
            strncpy(conv->filenames[conv->file_count], name, 31);
            conv->filenames[conv->file_count][31] = '\0';
            conv->file_count++;
            FURI_LOG_I(TAG, "Found CSV: %s", name);
        }
    }

    storage_dir_close(dir);
    storage_file_free(dir);

    FURI_LOG_I(TAG, "Scan complete: %d CSV file(s) found", conv->file_count);
    return conv->file_count;
}

// ---------------------------------------------------------------------------
// Get filename at index
// ---------------------------------------------------------------------------

const char* gpx_converter_get_name(const GpxConverter* conv, int index) {
    furi_assert(conv);
    if(index < 0 || index >= conv->file_count) return NULL;
    return conv->filenames[index];
}

// ---------------------------------------------------------------------------
// Helper — read one line from a CSV file, byte by byte
// ---------------------------------------------------------------------------

static bool read_csv_line(File* file, char* buf, size_t buf_size) {
    size_t pos = 0;
    uint8_t ch;
    while(pos < buf_size - 1) {
        if(storage_file_read(file, &ch, 1) != 1) {
            if(pos > 0) {
                buf[pos] = '\0';
                return true;
            }
            return false;
        }
        if(ch == '\n') {
            buf[pos] = '\0';
            return true;
        }
        if(ch == '\r') continue;
        buf[pos++] = (char)ch;
    }
    buf[pos] = '\0';
    return true;
}

// ---------------------------------------------------------------------------
// Convert a CSV file to GPX
// ---------------------------------------------------------------------------

bool gpx_converter_run(GpxConverter* conv, const char* csv_filename) {
    furi_assert(conv);
    furi_assert(csv_filename);

    // Build full CSV path
    char csv_path[128];
    snprintf(csv_path, sizeof(csv_path), EXT_PATH("%s"), csv_filename);

    // Build GPX path by replacing .csv with .gpx
    char gpx_path[128];
    strncpy(gpx_path, csv_path, sizeof(gpx_path) - 1);
    gpx_path[sizeof(gpx_path) - 1] = '\0';
    size_t path_len = strlen(gpx_path);
    if(path_len >= 4 && strcmp(gpx_path + path_len - 4, ".csv") == 0) {
        gpx_path[path_len - 3] = 'g';
        gpx_path[path_len - 2] = 'p';
        gpx_path[path_len - 1] = 'x';
    } else {
        FURI_LOG_E(TAG, "Filename does not end in .csv: %s", csv_filename);
        return false;
    }

    FURI_LOG_I(TAG, "Converting %s -> %s", csv_path, gpx_path);

    // Open CSV for reading
    File* csv_file = storage_file_alloc(conv->storage);
    if(!storage_file_open(csv_file, csv_path, FSAM_READ, FSOM_OPEN_EXISTING)) {
        FURI_LOG_E(TAG, "Failed to open CSV: %s", csv_path);
        storage_file_free(csv_file);
        return false;
    }

    // Open GPX for writing
    File* gpx_file = storage_file_alloc(conv->storage);
    if(!storage_file_open(gpx_file, gpx_path, FSAM_WRITE, FSOM_CREATE_ALWAYS)) {
        FURI_LOG_E(TAG, "Failed to create GPX: %s", gpx_path);
        storage_file_close(csv_file);
        storage_file_free(csv_file);
        storage_file_free(gpx_file);
        return false;
    }

    // Write GPX header
    const char* header =
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
        "<gpx version=\"1.1\" creator=\"FlipperZero BioMapping\">\n"
        "  <trk>\n"
        "    <name>BioMapping Walk</name>\n"
        "    <trkseg>\n";
    storage_file_write(gpx_file, header, strlen(header));

    // Skip CSV header row
    char line[256];
    read_csv_line(csv_file, line, sizeof(line));

    // EMA state for signal processing
    float smoothed = 0.0f;
    bool primed = false;
    int points_written = 0;

    // Process each CSV row
    while(read_csv_line(csv_file, line, sizeof(line))) {
        if(strlen(line) == 0) continue;

        char timestamp[32];
        float lat = 0.0f, lon = 0.0f, alt = 0.0f;
        int sats = 0, fix = 0;
        short gsr_raw = 0;

        int parsed = sscanf(
            line,
            "%31[^,],%f,%f,%f,%d,%d,%hd",
            timestamp,
            &lat,
            &lon,
            &alt,
            &sats,
            &fix,
            &gsr_raw);

        if(parsed < 7) {
            FURI_LOG_W(TAG, "Skipping malformed CSV line: %s", line);
            continue;
        }

        // EMA smoothing + derivative
        float raw_f = (float)gsr_raw;
        if(!primed) {
            smoothed = raw_f;
            primed = true;
        }
        float new_smoothed = (GPX_EMA_ALPHA * raw_f) + ((1.0f - GPX_EMA_ALPHA) * smoothed);
        float rate = new_smoothed - smoothed;
        smoothed = new_smoothed;
        // Negate rate: TIA circuit inverts — stress drives raw ADC down,
        // so we flip sign so stress → positive elevation (mountains).
        float elevation = -(rate) * GPX_ELEVATION_SCALE;

        // Only write trackpoint if we have a valid GPS fix
        if(fix > 0 && lat != 0.0f && lon != 0.0f) {
            char point[256];
            snprintf(
                point,
                sizeof(point),
                "      <trkpt lat=\"%.6f\" lon=\"%.6f\">\n"
                "        <ele>%.2f</ele>\n"
                "        <time>%s</time>\n"
                "      </trkpt>\n",
                (double)lat,
                (double)lon,
                (double)elevation,
                timestamp);
            storage_file_write(gpx_file, point, strlen(point));
            points_written++;
        }
    }

    // Write GPX footer
    const char* footer =
        "    </trkseg>\n"
        "  </trk>\n"
        "</gpx>\n";
    storage_file_write(gpx_file, footer, strlen(footer));

    // Clean up
    storage_file_close(csv_file);
    storage_file_free(csv_file);
    storage_file_close(gpx_file);
    storage_file_free(gpx_file);

    FURI_LOG_I(TAG, "Conversion complete: %d trackpoints written to %s", points_written, gpx_path);
    return true;
}
