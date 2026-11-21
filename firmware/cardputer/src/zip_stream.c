#include "zip_stream.h"

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

// Standard reflected IEEE 802.3 / zlib CRC-32 table (polynomial 0xEDB88320).
static const uint32_t crc32_table[256] = {
    0x00000000u, 0x77073096u, 0xEE0E612Cu, 0x990951BAu, 0x076DC419u, 0x706AF48Fu, 0xE963A535u, 0x9E6495A3u,
    0x0EDB8832u, 0x79DCB8A4u, 0xE0D5E91Eu, 0x97D2D988u, 0x09B64C2Bu, 0x7EB17CBDu, 0xE7B82D07u, 0x90BF1D91u,
    0x1DB71064u, 0x6AB020F2u, 0xF3B97148u, 0x84BE41DEu, 0x1ADAD47Du, 0x6DDDE4EBu, 0xF4D4B551u, 0x83D385C7u,
    0x136C9856u, 0x646BA8C0u, 0xFD62F97Au, 0x8A65C9ECu, 0x14015C4Fu, 0x63066CD9u, 0xFA0F3D63u, 0x8D080DF5u,
    0x3B6E20C8u, 0x4C69105Eu, 0xD56041E4u, 0xA2677172u, 0x3C03E4D1u, 0x4B04D447u, 0xD20D85FDu, 0xA50AB56Bu,
    0x35B5A8FAu, 0x42B2986Cu, 0xDBBBC9D6u, 0xACBCF940u, 0x32D86CE3u, 0x45DF5C75u, 0xDCD60DCFu, 0xABD13D59u,
    0x26D930ACu, 0x51DE003Au, 0xC8D75180u, 0xBFD06116u, 0x21B4F4B5u, 0x56B3C423u, 0xCFBA9599u, 0xB8BDA50Fu,
    0x2802B89Eu, 0x5F058808u, 0xC60CD9B2u, 0xB10BE924u, 0x2F6F7C87u, 0x58684C11u, 0xC1611DABu, 0xB6662D3Du,
    0x76DC4190u, 0x01DB7106u, 0x98D220BCu, 0xEFD5102Au, 0x71B18589u, 0x06B6B51Fu, 0x9FBFE4A5u, 0xE8B8D433u,
    0x7807C9A2u, 0x0F00F934u, 0x9609A88Eu, 0xE10E9818u, 0x7F6A0DBBu, 0x086D3D2Du, 0x91646C97u, 0xE6635C01u,
    0x6B6B51F4u, 0x1C6C6162u, 0x856530D8u, 0xF262004Eu, 0x6C0695EDu, 0x1B01A57Bu, 0x8208F4C1u, 0xF50FC457u,
    0x65B0D9C6u, 0x12B7E950u, 0x8BBEB8EAu, 0xFCB9887Cu, 0x62DD1DDFu, 0x15DA2D49u, 0x8CD37CF3u, 0xFBD44C65u,
    0x4DB26158u, 0x3AB551CEu, 0xA3BC0074u, 0xD4BB30E2u, 0x4ADFA541u, 0x3DD895D7u, 0xA4D1C46Du, 0xD3D6F4FBu,
    0x4369E96Au, 0x346ED9FCu, 0xAD678846u, 0xDA60B8D0u, 0x44042D73u, 0x33031DE5u, 0xAA0A4C5Fu, 0xDD0D7CC9u,
    0x5005713Cu, 0x270241AAu, 0xBE0B1010u, 0xC90C2086u, 0x5768B525u, 0x206F85B3u, 0xB966D409u, 0xCE61E49Fu,
    0x5EDEF90Eu, 0x29D9C998u, 0xB0D09822u, 0xC7D7A8B4u, 0x59B33D17u, 0x2EB40D81u, 0xB7BD5C3Bu, 0xC0BA6CADu,
    0xEDB88320u, 0x9ABFB3B6u, 0x03B6E20Cu, 0x74B1D29Au, 0xEAD54739u, 0x9DD277AFu, 0x04DB2615u, 0x73DC1683u,
    0xE3630B12u, 0x94643B84u, 0x0D6D6A3Eu, 0x7A6A5AA8u, 0xE40ECF0Bu, 0x9309FF9Du, 0x0A00AE27u, 0x7D079EB1u,
    0xF00F9344u, 0x8708A3D2u, 0x1E01F268u, 0x6906C2FEu, 0xF762575Du, 0x806567CBu, 0x196C3671u, 0x6E6B06E7u,
    0xFED41B76u, 0x89D32BE0u, 0x10DA7A5Au, 0x67DD4ACCu, 0xF9B9DF6Fu, 0x8EBEEFF9u, 0x17B7BE43u, 0x60B08ED5u,
    0xD6D6A3E8u, 0xA1D1937Eu, 0x38D8C2C4u, 0x4FDFF252u, 0xD1BB67F1u, 0xA6BC5767u, 0x3FB506DDu, 0x48B2364Bu,
    0xD80D2BDAu, 0xAF0A1B4Cu, 0x36034AF6u, 0x41047A60u, 0xDF60EFC3u, 0xA867DF55u, 0x316E8EEFu, 0x4669BE79u,
    0xCB61B38Cu, 0xBC66831Au, 0x256FD2A0u, 0x5268E236u, 0xCC0C7795u, 0xBB0B4703u, 0x220216B9u, 0x5505262Fu,
    0xC5BA3BBEu, 0xB2BD0B28u, 0x2BB45A92u, 0x5CB36A04u, 0xC2D7FFA7u, 0xB5D0CF31u, 0x2CD99E8Bu, 0x5BDEAE1Du,
    0x9B64C2B0u, 0xEC63F226u, 0x756AA39Cu, 0x026D930Au, 0x9C0906A9u, 0xEB0E363Fu, 0x72076785u, 0x05005713u,
    0x95BF4A82u, 0xE2B87A14u, 0x7BB12BAEu, 0x0CB61B38u, 0x92D28E9Bu, 0xE5D5BE0Du, 0x7CDCEFB7u, 0x0BDBDF21u,
    0x86D3D2D4u, 0xF1D4E242u, 0x68DDB3F8u, 0x1FDA836Eu, 0x81BE16CDu, 0xF6B9265Bu, 0x6FB077E1u, 0x18B74777u,
    0x88085AE6u, 0xFF0F6A70u, 0x66063BCAu, 0x11010B5Cu, 0x8F659EFFu, 0xF862AE69u, 0x616BFFD3u, 0x166CCF45u,
    0xA00AE278u, 0xD70DD2EEu, 0x4E048354u, 0x3903B3C2u, 0xA7672661u, 0xD06016F7u, 0x4969474Du, 0x3E6E77DBu,
    0xAED16A4Au, 0xD9D65ADCu, 0x40DF0B66u, 0x37D83BF0u, 0xA9BCAE53u, 0xDEBB9EC5u, 0x47B2CF7Fu, 0x30B5FFE9u,
    0xBDBDF21Cu, 0xCABAC28Au, 0x53B39330u, 0x24B4A3A6u, 0xBAD03605u, 0xCDD70693u, 0x54DE5729u, 0x23D967BFu,
    0xB3667A2Eu, 0xC4614AB8u, 0x5D681B02u, 0x2A6F2B94u, 0xB40BBE37u, 0xC30C8EA1u, 0x5A05DF1Bu, 0x2D02EF8Du,
};

static uint32_t crc32_update(uint32_t crc, const uint8_t* data, size_t len) {
    for(size_t i = 0; i < len; i++) {
        crc = (crc >> 8) ^ crc32_table[(crc ^ data[i]) & 0xFFu];
    }
    return crc;
}

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

    z->cur_crc = crc32_update(z->cur_crc, data, len);
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
