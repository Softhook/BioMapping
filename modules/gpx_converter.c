// GPX Converter — CSV → GPX with GSR elevation.

#include "gpx_converter.h"
#include <furi.h>
#include <storage/storage.h>
#include <string.h>
#include <stdio.h>
#include <math.h>

#define TAG "GpxConverter"

struct GpxConverter {
    Storage* storage;
    char     filenames[GPX_MAX_CSV_FILES][32];
    int      file_count;
};

GpxConverter* gpx_converter_alloc(Storage* storage) {
    GpxConverter* c = malloc(sizeof(GpxConverter));
    memset(c, 0, sizeof(*c));
    c->storage = storage;
    return c;
}

void gpx_converter_free(GpxConverter* c) { furi_assert(c); free(c); }

int gpx_converter_scan(GpxConverter* c) {
    furi_assert(c);
    c->file_count = 0;

    File* dir = storage_file_alloc(c->storage);
    if(!storage_dir_open(dir, "/ext/biomapping")) {
        FURI_LOG_E(TAG, "Cannot open /ext/biomapping");
        storage_file_free(dir);
        return 0;
    }

    FileInfo info;
    char     name[64];
    while(storage_dir_read(dir, &info, name, sizeof(name))) {
        if(info.flags & FSF_DIRECTORY) continue;
        size_t len = strlen(name);
        if(len < 12) continue;
        if(strncmp(name, "biomap_", 7) != 0) continue;
        if(strcmp(name + len - 4, ".csv") != 0) continue;
        if(c->file_count < GPX_MAX_CSV_FILES) {
            strncpy(c->filenames[c->file_count], name, 31);
            c->filenames[c->file_count][31] = '\0';
            c->file_count++;
        }
    }
    storage_dir_close(dir);
    storage_file_free(dir);
    FURI_LOG_I(TAG, "%d CSV file(s) found", c->file_count);
    return c->file_count;
}

const char* gpx_converter_get_name(const GpxConverter* c, int index) {
    furi_assert(c);
    return (index >= 0 && index < c->file_count) ? c->filenames[index] : NULL;
}

// Simple string-to-float (avoids atof which is disabled in Flipper API)
static float str_to_float(const char* s) {
    float r = 0, sign = 1, frac = 0, div = 1;
    if(*s == '-') { sign = -1; s++; }
    while(*s >= '0' && *s <= '9') { r = r * 10 + (*s++ - '0'); }
    if(*s == '.') {
        s++;
        while(*s >= '0' && *s <= '9') { frac = frac * 10 + (*s++ - '0'); div *= 10; }
    }
    return sign * (r + frac / div);
}

// Simple string-to-int
static int str_to_int(const char* s) {
    int r = 0, sign = 1;
    if(*s == '-') { sign = -1; s++; }
    while(*s >= '0' && *s <= '9') { r = r * 10 + (*s++ - '0'); }
    return sign * r;
}

// Read one line, stripping \r, stopping at \n or EOF
static bool read_csv_line(File* f, char* buf, size_t sz) {
    size_t pos = 0;
    uint8_t ch;
    while(pos < sz - 1 && storage_file_read(f, &ch, 1) == 1) {
        if(ch == '\n') { buf[pos] = '\0'; return true; }
        if(ch == '\r') continue;
        buf[pos++] = (char)ch;
    }
    buf[pos] = '\0';
    return pos > 0;
}

// Write string to file with error check
static bool file_write_str(File* f, const char* s) {
    size_t len = strlen(s);
    return storage_file_write(f, s, len) == len;
}

int gpx_converter_run(GpxConverter* c, const char* csv_filename) {
    furi_assert(c);
    furi_assert(csv_filename);

    char csv_path[128];
    snprintf(csv_path, sizeof(csv_path), EXT_PATH("biomapping/%s"), csv_filename);

    // Derive GPX path by swapping .csv → .gpx
    char gpx_path[128];
    strncpy(gpx_path, csv_path, sizeof(gpx_path) - 1);
    gpx_path[sizeof(gpx_path) - 1] = '\0';
    size_t plen = strlen(gpx_path);
    if(plen < 4 || strcmp(gpx_path + plen - 4, ".csv") != 0) {
        FURI_LOG_E(TAG, "Not a .csv: %s", csv_filename);
        return 0;
    }
    gpx_path[plen - 3] = 'g'; gpx_path[plen - 2] = 'p'; gpx_path[plen - 1] = 'x';
    FURI_LOG_I(TAG, "%s → %s", csv_path, gpx_path);

    File* csv_file = storage_file_alloc(c->storage);
    if(!storage_file_open(csv_file, csv_path, FSAM_READ, FSOM_OPEN_EXISTING)) {
        FURI_LOG_E(TAG, "Cannot open %s", csv_path);
        storage_file_free(csv_file);
        return 0;
    }

    File* gpx_file = storage_file_alloc(c->storage);
    if(!storage_file_open(gpx_file, gpx_path, FSAM_WRITE, FSOM_CREATE_ALWAYS)) {
        FURI_LOG_E(TAG, "Cannot create %s", gpx_path);
        storage_file_close(csv_file);
        storage_file_free(csv_file);
        storage_file_free(gpx_file);
        return 0;
    }

    int points = 0;

    if(!file_write_str(gpx_file,
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
        "<gpx version=\"1.1\" creator=\"FlipperZero Bio Mapping\">\n"
        "  <trk>\n"
        "    <name>BioMapping Walk</name>\n"
        "    <trkseg>\n")) {
        FURI_LOG_E(TAG, "GPX header write failed");
        goto done;
    }

    // Skip CSV header
    char line[256];
    read_csv_line(csv_file, line, sizeof(line));

    float smoothed = 0.0f;
    bool  primed   = false;
    int   lines_read = 0, lines_skipped = 0;

    while(read_csv_line(csv_file, line, sizeof(line))) {
        if(!line[0]) continue;
        lines_read++;

        char  ts[32] = "";
        float lat = 0, lon = 0;
        int   fix = 0, raw = 0;

        // Manual comma-split parse — avoids sscanf field-alignment issues
        char* tok[7];
        int nt = 0;
        tok[nt++] = line;
        for(char* p = line; *p && nt < 7; p++) {
            if(*p == ',') { *p = '\0'; tok[nt++] = p + 1; }
        }
        if(nt < 7) {
            FURI_LOG_W(TAG, "Skip line #%d: only %d fields", lines_read, nt);
            lines_skipped++;
            continue;
        }
        strncpy(ts, tok[0], sizeof(ts) - 1);
        lat  = str_to_float(tok[1]);
        lon  = str_to_float(tok[2]);
        fix  = str_to_int(tok[5]);
        raw  = str_to_int(tok[6]);

        float raw_f = (float)raw;
        if(!primed) { smoothed = raw_f; primed = true; }
        float new_smoothed = GPX_EMA_ALPHA * raw_f + (1.0f - GPX_EMA_ALPHA) * smoothed;
        float rate         = new_smoothed - smoothed;
        smoothed           = new_smoothed;
        float elevation    = -(rate) * GPX_ELEVATION_SCALE;

        if(fix > 0 && fabsf(lat) > 0.0001f && fabsf(lon) > 0.0001f) {
            char pt[256];
            snprintf(pt, sizeof(pt),
                "      <trkpt lat=\"%.6f\" lon=\"%.6f\">\n"
                "        <ele>%.2f</ele>\n"
                "        <time>%s</time>\n"
                "      </trkpt>\n",
                (double)lat, (double)lon, (double)elevation, ts);
            file_write_str(gpx_file, pt);
            points++;
        } else {
            FURI_LOG_W(TAG, "Filtered: fix=%d lat=%.6f lon=%.6f", fix, (double)lat, (double)lon);
        }
    }

    file_write_str(gpx_file,
        "    </trkseg>\n"
        "  </trk>\n"
        "</gpx>\n");

    FURI_LOG_I(TAG, "%d pts, %d lines read, %d skipped", points, lines_read, lines_skipped);

done:
    storage_file_close(csv_file);
    storage_file_free(csv_file);
    storage_file_close(gpx_file);
    storage_file_free(gpx_file);
    return points;
}
