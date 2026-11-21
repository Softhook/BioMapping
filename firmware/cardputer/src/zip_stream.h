#pragma once

// Standalone Store-mode (uncompressed) ZIP32 streamer in plain C.
//
// Streams files in a single pass with CRC-32 data descriptors (general purpose
// bit 3 + 0x08074b50 signature), requiring zero compression memory and zero
// temporary SD card space. Because every header has a fixed size, the exact
// archive byte length can be calculated up front from filenames and file sizes
// alone (for an exact HTTP Content-Length header).

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "wifi_files_rules.h"  // WIFI_FILES_MAX_NAME

#ifdef __cplusplus
extern "C" {
#endif

typedef bool (*ZipStreamWriteFn)(void* ctx, const uint8_t* data, size_t len);

typedef struct {
    char     name[WIFI_FILES_MAX_NAME];
    uint32_t size;
    uint32_t crc32;
    uint32_t local_header_offset;
    uint16_t dos_date;
    uint16_t dos_time;
} ZipStreamEntry;

typedef struct {
    ZipStreamWriteFn write_fn;
    void*            write_ctx;
    ZipStreamEntry*  entries;
    size_t           capacity;
    size_t           count;
    uint32_t         bytes_written;
    bool             in_file;
    uint32_t         cur_crc;
    uint32_t         cur_size;
    uint32_t         cur_expected_size;
} ZipStream;

// Calculates the exact total byte length of the ZIP archive that will be
// produced for `entries[0..count-1]` (reading only each entry's `name` and
// `size`). Returns 22 for an empty archive (count == 0).
uint64_t zip_stream_calc_total_size(const ZipStreamEntry* entries, size_t count);

// True if `total_size` and `count` fit safely within 32-bit ZIP and HTTP
// Content-Length limits (capped at 2 GiB - 1 to avoid 32-bit sentinel values).
bool zip_stream_fits_zip32(uint64_t total_size, size_t count);

// Initialises a streaming ZIP writer. `entries` must remain valid until
// zip_stream_finish() returns and have room for at least `capacity` files.
void zip_stream_init(ZipStream* z,
                     ZipStreamWriteFn write_fn,
                     void* write_ctx,
                     ZipStreamEntry* entries,
                     size_t capacity);

// Writes the Local File Header for one file. `expected_size` is the exact
// number of payload bytes that will be fed via zip_stream_write_data().
bool zip_stream_begin_file(ZipStream* z,
                           const char* name,
                           uint32_t expected_size,
                           uint16_t dos_date,
                           uint16_t dos_time);

// Streams a chunk of raw file bytes and folds them into the file's CRC-32.
bool zip_stream_write_data(ZipStream* z, const uint8_t* data, size_t len);

// Finishes the current file by writing its 16-byte CRC-32 Data Descriptor.
// Returns false if the total bytes written do not match `expected_size`.
bool zip_stream_end_file(ZipStream* z);

// Writes the Central Directory and End of Central Directory (EOCD) records.
bool zip_stream_finish(ZipStream* z);

#ifdef __cplusplus
}
#endif
