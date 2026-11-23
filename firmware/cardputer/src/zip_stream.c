#include "zip_stream.h"
#include "biomap_format.h"

#include <string.h>

// ZIP32 format constants (APPNOTE 6.3.x):
//   Local File Header:          30 + name_len
//   Data Descriptor (with sig): 16
//   Central Directory Header:   46 + name_len
//   End of Central Directory:   22
#define ZIP_LFH_FIXED_BYTES 30u
#define ZIP_DD_BYTES        16u
#define ZIP_CDH_FIXED_BYTES 46u
#define ZIP_EOCD_BYTES      22u

#define ZIP_SIG_LFH  0x04034B50u
#define ZIP_SIG_DD   0x08074B50u
#define ZIP_SIG_CDH  0x02014B50u
#define ZIP_SIG_EOCD 0x06054B50u

// Version 2.0, Store (method 0), bit 3 (Data Descriptor) + bit 11 (UTF-8).
#define ZIP_VERSION 20u
#define ZIP_FLAGS   0x0808u

static void put_le16(uint8_t* dst, uint16_t v) {
    dst[0] = (uint8_t)(v & 0xFFu);
    dst[1] = (uint8_t)((v >> 8) & 0xFFu);
}

static void put_le32(uint8_t* dst, uint32_t v) {
    dst[0] = (uint8_t)(v & 0xFFu);
    dst[1] = (uint8_t)((v >> 8) & 0xFFu);
    dst[2] = (uint8_t)((v >> 16) & 0xFFu);
    dst[3] = (uint8_t)((v >> 24) & 0xFFu);
}

static bool emit(ZipStream* z, const uint8_t* data, size_t len) {
    if(len == 0) return true;
    if(!z->write_fn || !z->write_fn(z->write_ctx, data, len)) return false;
    z->bytes_written += (uint32_t)len;
    return true;
}

uint64_t zip_stream_calc_total_size(const ZipStreamEntry* entries, size_t count) {
    uint64_t total = ZIP_EOCD_BYTES;
    if(!entries && count > 0) return 0;
    for(size_t i = 0; i < count; i++) {
        uint64_t name_len = (uint64_t)strlen(entries[i].name);
        total += (uint64_t)ZIP_LFH_FIXED_BYTES + name_len;
        total += (uint64_t)entries[i].size;
        total += (uint64_t)ZIP_DD_BYTES;
        total += (uint64_t)ZIP_CDH_FIXED_BYTES + name_len;
    }
    return total;
}

// Capped at 2 GiB - 1 so total_size never collides with signed 32-bit file
// offsets or Arduino WebServer's CONTENT_LENGTH_UNKNOWN / _NOT_SET sentinels.
#define ZIP_MAX_ARCHIVE_BYTES 0x7FFFFFFFULL

bool zip_stream_fits_zip32(uint64_t total_size, size_t count) {
    return total_size >= ZIP_EOCD_BYTES &&
           total_size <= ZIP_MAX_ARCHIVE_BYTES &&
           count <= 0xFFFFu;
}

void zip_stream_init(ZipStream* z,
                     ZipStreamWriteFn write_fn,
                     void* write_ctx,
                     ZipStreamEntry* entries,
                     size_t capacity) {
    memset(z, 0, sizeof(*z));
    z->write_fn = write_fn;
    z->write_ctx = write_ctx;
    z->entries = entries;
    z->capacity = capacity;
}

bool zip_stream_begin_file(ZipStream* z,
                           const char* name,
                           uint32_t expected_size,
                           uint16_t dos_date,
                           uint16_t dos_time) {
    if(!z || z->in_file || !name || name[0] == '\0') return false;
    if(!z->entries || z->count >= z->capacity || z->count >= 0xFFFFu) return false;

    size_t name_len = strlen(name);
    if(name_len >= WIFI_FILES_MAX_NAME) return false;

    ZipStreamEntry* e = &z->entries[z->count];
    memmove(e->name, name, name_len + 1);
    e->size = 0;
    e->crc32 = 0;
    e->local_header_offset = z->bytes_written;
    e->dos_date = dos_date;
    e->dos_time = dos_time;

    uint8_t hdr[ZIP_LFH_FIXED_BYTES];
    put_le32(hdr + 0,  ZIP_SIG_LFH);
    put_le16(hdr + 4,  ZIP_VERSION);
    put_le16(hdr + 6,  ZIP_FLAGS);
    put_le16(hdr + 8,  0u);  // Store (uncompressed)
    put_le16(hdr + 10, dos_time);
    put_le16(hdr + 12, dos_date);
    put_le32(hdr + 14, 0u);  // CRC-32 written in Data Descriptor
    put_le32(hdr + 18, 0u);  // Compressed size in Data Descriptor
    put_le32(hdr + 22, 0u);  // Uncompressed size in Data Descriptor
    put_le16(hdr + 26, (uint16_t)name_len);
    put_le16(hdr + 28, 0u);  // Extra field length

    if(!emit(z, hdr, sizeof(hdr))) return false;
    if(!emit(z, (const uint8_t*)name, name_len)) return false;

    z->in_file = true;
    z->cur_crc = 0xFFFFFFFFu;
    z->cur_size = 0;
    z->cur_expected_size = expected_size;
    return true;
}

bool zip_stream_write_data(ZipStream* z, const uint8_t* data, size_t len) {
    if(!z || !z->in_file) return false;
    if(len == 0) return true;
    if(!data) return false;
    if(len > (size_t)(z->cur_expected_size - z->cur_size)) return false;

    z->cur_crc = biomap_crc32_update(z->cur_crc, data, len);
    z->cur_size += (uint32_t)len;
    return emit(z, data, len);
}

bool zip_stream_end_file(ZipStream* z) {
    if(!z || !z->in_file) return false;
    if(z->cur_size != z->cur_expected_size) return false;

    uint32_t crc = z->cur_crc ^ 0xFFFFFFFFu;
    ZipStreamEntry* e = &z->entries[z->count];
    e->crc32 = crc;
    e->size = z->cur_size;

    uint8_t dd[ZIP_DD_BYTES];
    put_le32(dd + 0,  ZIP_SIG_DD);
    put_le32(dd + 4,  crc);
    put_le32(dd + 8,  z->cur_size);
    put_le32(dd + 12, z->cur_size);

    z->in_file = false;
    z->count++;
    return emit(z, dd, sizeof(dd));
}

bool zip_stream_finish(ZipStream* z) {
    if(!z || z->in_file) return false;

    uint32_t cd_offset = z->bytes_written;
    for(size_t i = 0; i < z->count; i++) {
        const ZipStreamEntry* e = &z->entries[i];
        size_t name_len = strlen(e->name);

        uint8_t cdh[ZIP_CDH_FIXED_BYTES];
        put_le32(cdh + 0,  ZIP_SIG_CDH);
        put_le16(cdh + 4,  ZIP_VERSION);  // version made by
        put_le16(cdh + 6,  ZIP_VERSION);  // version needed
        put_le16(cdh + 8,  ZIP_FLAGS);
        put_le16(cdh + 10, 0u);  // Store
        put_le16(cdh + 12, e->dos_time);
        put_le16(cdh + 14, e->dos_date);
        put_le32(cdh + 16, e->crc32);
        put_le32(cdh + 20, e->size);
        put_le32(cdh + 24, e->size);
        put_le16(cdh + 28, (uint16_t)name_len);
        put_le16(cdh + 30, 0u);  // extra length
        put_le16(cdh + 32, 0u);  // comment length
        put_le16(cdh + 34, 0u);  // disk number start
        put_le16(cdh + 36, 0u);  // internal attrs
        put_le32(cdh + 38, 0u);  // external attrs
        put_le32(cdh + 42, e->local_header_offset);

        if(!emit(z, cdh, sizeof(cdh))) return false;
        if(!emit(z, (const uint8_t*)e->name, name_len)) return false;
    }

    uint32_t cd_size = z->bytes_written - cd_offset;

    uint8_t eocd[ZIP_EOCD_BYTES];
    put_le32(eocd + 0,  ZIP_SIG_EOCD);
    put_le16(eocd + 4,  0u);  // disk number
    put_le16(eocd + 6,  0u);  // disk with CD
    put_le16(eocd + 8,  (uint16_t)z->count);
    put_le16(eocd + 10, (uint16_t)z->count);
    put_le32(eocd + 12, cd_size);
    put_le32(eocd + 16, cd_offset);
    put_le16(eocd + 20, 0u);  // comment length

    return emit(z, eocd, sizeof(eocd));
}
