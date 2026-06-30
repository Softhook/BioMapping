#pragma once

// Bio Mapping shared utilities.

#include <stdbool.h>
#include <string.h>

// Parse the numeric index from a "biomap_xxx.csv" filename.
// Returns the index on success, or -1 if the name doesn't match the pattern
// or contains non-numeric characters in the index portion.
// Both sd_logger.c and gpx_converter.c use this to coordinate file numbering.
static inline int biomap_parse_file_index(const char* name) {
    size_t len = strlen(name);
    if(len < 12) return -1;                           // "biomap_001.csv" is 14 chars
    if(strncmp(name, "biomap_", 7) != 0) return -1;
    if(strcmp(name + len - 4, ".csv") != 0) return -1;

    int idx = 0;
    const char* p = name + 7;
    while(p < name + len - 4) {
        if(*p < '0' || *p > '9') return -1;
        if(idx > 99999) return -1;                    // overflow protection
        idx = idx * 10 + (*p - '0');
        p++;
    }
    return idx;
}

// Derive a GPX filename from a CSV filename by replacing the ".csv" suffix
// with ".gpx".  Writes to out (max out_sz bytes).  Returns false if the
// input doesn't end with ".csv".
static inline bool gpx_name_from_csv(const char* csv_name, char* out, size_t out_sz) {
    size_t len = strlen(csv_name);
    if(len < 4 || strcmp(csv_name + len - 4, ".csv") != 0) return false;
    size_t copy = (len < out_sz - 1) ? len : out_sz - 1;
    memcpy(out, csv_name, copy);
    out[copy - 3] = 'g';
    out[copy - 2] = 'p';
    out[copy - 1] = 'x';
    out[copy] = '\0';
    return true;
}
