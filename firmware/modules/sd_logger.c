// SD Logger — auto-incrementing CSV writer.

#include "sd_logger.h"
#include "biomap_config.h"
#include "util.h"
#include <furi.h>
#include <storage/storage.h>
#include <string.h>
#include <stdio.h>
#include <stdarg.h>

#define LOGGER_DIR      "biomapping"
#define LOGGER_BASENAME "biomap_"
#define LOGGER_EXT       ".csv"
#define LOGGER_MAX_INDEX 999

// One-shot pre-allocation size (BIOMAP_SD_PREALLOC, biomap_config.h) — see
// preallocate_log_file() below and docs/archive/gps_rf_mutex_status.md's "option E"
// entries. Sized against track 016's own measured worst-case rate (GPS+GSR+
// RF, debug fields on — the widest schema, ~72 KiB/min): ~90 minutes
// (6.33 MiB) plus real margin, rounded to 8 MiB. Every mode gets the same
// pre-allocation regardless of its actual (lower) row width — harmless,
// since sd_logger_stop() always trims the unused tail back to the real
// data length.
#define SD_LOGGER_PREALLOC_BYTES (8u * 1024u * 1024u)

// Always real FURI_LOG_* calls — debug CSV *fields* are a runtime
// Options-menu toggle (BioMapApp::debug_fields_enabled), unrelated to
// whether these serial logs exist. SdLogger has no app-level context to
// gate on anyway, and Flipper's own runtime log level already controls
// what's visible on a given build/session.
#define SD_LOG_I(tag, fmt, ...) FURI_LOG_I(tag, fmt, ##__VA_ARGS__)
#define SD_LOG_W(tag, fmt, ...) FURI_LOG_W(tag, fmt, ##__VA_ARGS__)
#define SD_LOG_E(tag, fmt, ...) FURI_LOG_E(tag, fmt, ##__VA_ARGS__)

// ── Integrity bracket ─────────────────────────────────────────────────────
// Every recording is wrapped by two lines so the visualiser (or any
// external tool) can confirm the file is complete and unmodified:
//   • "# Integrity: crc32 v1" as the file's first line — announces that a
//     trailer is expected and which algorithm produced it;
//   • "# End rows:<n> bytes:<n> crc32:<hex> [end_time:<epoch>]
//     overflows:<n> flush_fails:<n>" written by sd_logger_stop() once the
//     final batch has flushed.
// The CRC32 (same reflected zlib polynomial as em_scan_cal.c) covers every
// byte from the marker line up to — but not including — the trailer. A
// missing trailer means the recording never stopped cleanly (flat battery,
// crash, card pulled); a trailer whose CRC / row count disagrees with the
// data means the file was truncated or altered after the Flipper wrote it.
// This is corruption detection, not tamper protection — a plain CRC can
// always be recomputed by whoever edited the file.
#define SD_LOGGER_INTEGRITY_LINE "# Integrity: crc32 v1\n"

// Incremental CRC32 (reflected, poly 0xEDB88320) — the streaming form of
// em_scan_cal.c's em_scan_cal_compute_crc(). Seed `crc` with 0xFFFFFFFFu on
// the first call; the finished checksum is ~crc after the last chunk.
//
// Table-driven (one byte per step instead of eight bit iterations): each
// GSR flush folds ~11–17 kB into the CRC on the main thread's flush tick,
// right next to the SD write/sync, so the byte loop is kept cheap. The
// 1 kB table is const — it lives in flash, costs no RAM, and needs no
// init. Values are the standard reflected-0xEDB88320 table; the seed/
// final-XOR convention is unchanged, so results stay bit-identical to the
// old bitwise form and to em_scan_cal.c.
static const uint32_t crc32_table[256] = {
    0x00000000, 0x77073096, 0xee0e612c, 0x990951ba,
    0x076dc419, 0x706af48f, 0xe963a535, 0x9e6495a3,
    0x0edb8832, 0x79dcb8a4, 0xe0d5e91e, 0x97d2d988,
    0x09b64c2b, 0x7eb17cbd, 0xe7b82d07, 0x90bf1d91,
    0x1db71064, 0x6ab020f2, 0xf3b97148, 0x84be41de,
    0x1adad47d, 0x6ddde4eb, 0xf4d4b551, 0x83d385c7,
    0x136c9856, 0x646ba8c0, 0xfd62f97a, 0x8a65c9ec,
    0x14015c4f, 0x63066cd9, 0xfa0f3d63, 0x8d080df5,
    0x3b6e20c8, 0x4c69105e, 0xd56041e4, 0xa2677172,
    0x3c03e4d1, 0x4b04d447, 0xd20d85fd, 0xa50ab56b,
    0x35b5a8fa, 0x42b2986c, 0xdbbbc9d6, 0xacbcf940,
    0x32d86ce3, 0x45df5c75, 0xdcd60dcf, 0xabd13d59,
    0x26d930ac, 0x51de003a, 0xc8d75180, 0xbfd06116,
    0x21b4f4b5, 0x56b3c423, 0xcfba9599, 0xb8bda50f,
    0x2802b89e, 0x5f058808, 0xc60cd9b2, 0xb10be924,
    0x2f6f7c87, 0x58684c11, 0xc1611dab, 0xb6662d3d,
    0x76dc4190, 0x01db7106, 0x98d220bc, 0xefd5102a,
    0x71b18589, 0x06b6b51f, 0x9fbfe4a5, 0xe8b8d433,
    0x7807c9a2, 0x0f00f934, 0x9609a88e, 0xe10e9818,
    0x7f6a0dbb, 0x086d3d2d, 0x91646c97, 0xe6635c01,
    0x6b6b51f4, 0x1c6c6162, 0x856530d8, 0xf262004e,
    0x6c0695ed, 0x1b01a57b, 0x8208f4c1, 0xf50fc457,
    0x65b0d9c6, 0x12b7e950, 0x8bbeb8ea, 0xfcb9887c,
    0x62dd1ddf, 0x15da2d49, 0x8cd37cf3, 0xfbd44c65,
    0x4db26158, 0x3ab551ce, 0xa3bc0074, 0xd4bb30e2,
    0x4adfa541, 0x3dd895d7, 0xa4d1c46d, 0xd3d6f4fb,
    0x4369e96a, 0x346ed9fc, 0xad678846, 0xda60b8d0,
    0x44042d73, 0x33031de5, 0xaa0a4c5f, 0xdd0d7cc9,
    0x5005713c, 0x270241aa, 0xbe0b1010, 0xc90c2086,
    0x5768b525, 0x206f85b3, 0xb966d409, 0xce61e49f,
    0x5edef90e, 0x29d9c998, 0xb0d09822, 0xc7d7a8b4,
    0x59b33d17, 0x2eb40d81, 0xb7bd5c3b, 0xc0ba6cad,
    0xedb88320, 0x9abfb3b6, 0x03b6e20c, 0x74b1d29a,
    0xead54739, 0x9dd277af, 0x04db2615, 0x73dc1683,
    0xe3630b12, 0x94643b84, 0x0d6d6a3e, 0x7a6a5aa8,
    0xe40ecf0b, 0x9309ff9d, 0x0a00ae27, 0x7d079eb1,
    0xf00f9344, 0x8708a3d2, 0x1e01f268, 0x6906c2fe,
    0xf762575d, 0x806567cb, 0x196c3671, 0x6e6b06e7,
    0xfed41b76, 0x89d32be0, 0x10da7a5a, 0x67dd4acc,
    0xf9b9df6f, 0x8ebeeff9, 0x17b7be43, 0x60b08ed5,
    0xd6d6a3e8, 0xa1d1937e, 0x38d8c2c4, 0x4fdff252,
    0xd1bb67f1, 0xa6bc5767, 0x3fb506dd, 0x48b2364b,
    0xd80d2bda, 0xaf0a1b4c, 0x36034af6, 0x41047a60,
    0xdf60efc3, 0xa867df55, 0x316e8eef, 0x4669be79,
    0xcb61b38c, 0xbc66831a, 0x256fd2a0, 0x5268e236,
    0xcc0c7795, 0xbb0b4703, 0x220216b9, 0x5505262f,
    0xc5ba3bbe, 0xb2bd0b28, 0x2bb45a92, 0x5cb36a04,
    0xc2d7ffa7, 0xb5d0cf31, 0x2cd99e8b, 0x5bdeae1d,
    0x9b64c2b0, 0xec63f226, 0x756aa39c, 0x026d930a,
    0x9c0906a9, 0xeb0e363f, 0x72076785, 0x05005713,
    0x95bf4a82, 0xe2b87a14, 0x7bb12bae, 0x0cb61b38,
    0x92d28e9b, 0xe5d5be0d, 0x7cdcefb7, 0x0bdbdf21,
    0x86d3d2d4, 0xf1d4e242, 0x68ddb3f8, 0x1fda836e,
    0x81be16cd, 0xf6b9265b, 0x6fb077e1, 0x18b74777,
    0x88085ae6, 0xff0f6a70, 0x66063bca, 0x11010b5c,
    0x8f659eff, 0xf862ae69, 0x616bffd3, 0x166ccf45,
    0xa00ae278, 0xd70dd2ee, 0x4e048354, 0x3903b3c2,
    0xa7672661, 0xd06016f7, 0x4969474d, 0x3e6e77db,
    0xaed16a4a, 0xd9d65adc, 0x40df0b66, 0x37d83bf0,
    0xa9bcae53, 0xdebb9ec5, 0x47b2cf7f, 0x30b5ffe9,
    0xbdbdf21c, 0xcabac28a, 0x53b39330, 0x24b4a3a6,
    0xbad03605, 0xcdd70693, 0x54de5729, 0x23d967bf,
    0xb3667a2e, 0xc4614ab8, 0x5d681b02, 0x2a6f2b94,
    0xb40bbe37, 0xc30c8ea1, 0x5a05df1b, 0x2d02ef8d,
};

static uint32_t crc32_feed(uint32_t crc, const void* data, size_t len) {
    const uint8_t* p = (const uint8_t*)data;
    for(size_t i = 0; i < len; i++) {
        crc = (crc >> 8) ^ crc32_table[(crc ^ p[i]) & 0xffu];
    }
    return crc;
}

struct SdLogger {
    Storage* storage;
    File*    file;
    bool     active;
    char     filename[64];
    int      last_index;

    // GPS+GSR+RF batch buffer: accumulate formatted rows each tick,
    // flush to SD in one storage_file_write every FLUSH_INTERVAL seconds.
    //
    // Sized against a worst-case row, not the ~110-125 byte typical case.
    // With debug fields on, several of the debug columns are lifetime
    // peak-hold/cumulative counters formatted as bare %u — they gain digits
    // as a recording runs longer, permanently costing the shared buffer
    // bytes on every subsequent row, so a long recording can grow past a
    // tight typical-case estimate and start dropping one row per flush.
    // ~169 bytes/row worst case (generous per-field digit bounds) × 100 rows
    // ≈ 16900 bytes; 24576 clears that with margin for future columns.
    char gsr_batch[24576];
    int  gsr_batch_len;

    // Worst single batch_flush() (write+sync) real duration ever seen —
    // see sd_logger_get_flush_peak_ms()'s doc comment (sd_logger.h).
    uint32_t flush_peak_ms;

    // One-shot pre-allocation duration, set once in open_log_file() —
    // see sd_logger_get_prealloc_ms()'s doc comment (sd_logger.h).
    uint32_t prealloc_ms;

    // Continuity-pressure metrics: current/peak batch occupancy and
    // cumulative failures that indicate logging risk under load.
    uint32_t batch_fill_peak_bytes;
    uint32_t overflow_count;
    uint32_t flush_fail_count;

    // Integrity-trailer state (SD_LOGGER_INTEGRITY_LINE): running CRC32
    // (pre-final-inversion, seeded 0xFFFFFFFF in open_log_file), the byte
    // count that CRC covers (marker + header + every flushed row batch),
    // and the data-row count — all emitted in the "# End" trailer by
    // sd_logger_stop().
    uint32_t crc;
    uint32_t crc_bytes;
    uint32_t row_count;
    bool     last_byte_newline; // was the last data byte a '\n'? (trailer needs its own line)
};

SdLogger* sd_logger_alloc(Storage* storage) {
    furi_check(storage, "SdLogger: NULL storage in alloc()");
    SdLogger* l = malloc(sizeof(SdLogger));
    furi_check(l, "SdLogger: NULL logger alloc");
    *l = (SdLogger){.storage = storage};
    return l;
}

void sd_logger_free(SdLogger* l) {
    furi_check(l, "SdLogger: NULL in free()");
    // 0 = no RTC reading available on this teardown path; the trailer's
    // end_time token is simply omitted (see sd_logger_write_trailer).
    if(l->active) sd_logger_stop(l, 0);
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
        // biomap_parse_file_index() already validates the "biomap_" prefix,
        // ".csv" suffix, and numeric body in one place — no need to
        // re-check the prefix/suffix here too (util.h is the single
        // source of truth for the filename format).
        int idx = biomap_parse_file_index(name);
        if(idx > max_idx && idx <= LOGGER_MAX_INDEX) {
            max_idx = idx;
        }
    }
    storage_dir_close(dir);
    storage_file_free(dir);

    int next_idx = max_idx + 1;
    if(next_idx > LOGGER_MAX_INDEX) {
        SD_LOG_W("SdLogger", "All %d slots used — wrapping to 001", LOGGER_MAX_INDEX);
        next_idx = 1;
    }
    l->last_index = next_idx;
    return next_idx;
}

#if BIOMAP_SD_PREALLOC
// Grows the just-opened file to SD_LOGGER_PREALLOC_BYTES once, up front, via
// storage_file_seek() past the current end -- the only pre-allocation
// primitive the app SDK exposes (no f_expand binding exists; File is an
// opaque struct with no accessor to a raw FatFs handle either -- confirmed
// by grepping the full SDK headers, see docs/archive/gps_rf_mutex_status.md). Real
// FatFs's f_lseek() performs the size-extend (and pays its cluster-
// allocation cost) immediately, inside that call, with undefined -- NOT
// zero-filled -- content in the gap. Always leaves the file positioned back
// at the real data boundary (right after the header) so the first batch
// flush lands contiguously, never inside the pre-allocated tail.
// sd_logger_stop() trims the unused tail back to the real data length.
static void preallocate_log_file(SdLogger* l) {
    uint64_t real_pos = storage_file_tell(l->file); // right after header write+sync
    uint64_t target = real_pos + SD_LOGGER_PREALLOC_BYTES;

    uint32_t start_tick = furi_get_tick();
    if(storage_file_seek(l->file, (uint32_t)(target - 1), true)) {
        uint8_t dummy = 0;
        storage_file_write(l->file, &dummy, 1);
    } else {
        // Real FatFs still expands as far as it can on disk-full rather than
        // failing outright (elm-chan.org/fsw/ff/doc/lseek.html) -- this
        // branch is a defensive fallback for a seek that fails outright, not
        // the expected path. Either way, skip the dummy write and fall
        // through to the rewind below: a partial or missing pre-allocation
        // degrades to a plain append, it doesn't corrupt anything.
        SD_LOG_W("SdLogger", "Pre-allocation seek failed (SD full/near-full?) — continuing without it");
    }
    // Always rewind to the real data boundary, whatever happened above, so
    // the next batch flush resumes exactly where the header left off.
    storage_file_seek(l->file, (uint32_t)real_pos, true);
    l->prealloc_ms = furi_get_tick() - start_tick;
}
#endif

// Open (or create) the next auto-indexed CSV file and write a header row.
// Returns true on success; on failure the logger is left inactive with no
// open file handle.
static bool open_log_file(SdLogger* l, const char* header) {
    int idx = find_next_index(l);
    snprintf(l->filename, sizeof(l->filename), LOGGER_BASENAME "%03d" LOGGER_EXT, idx);
    l->prealloc_ms = 0;

#if BIOMAP_SD_DRY_RUN
    UNUSED(header);
    l->active = true;
    l->file = NULL;
    SD_LOG_W("SdLogger", "SD dry-run active: bypassing file I/O for %s", l->filename);
    return true;
#else
    char full_path[96];
    snprintf(full_path, sizeof(full_path), EXT_PATH(LOGGER_DIR "/%s"), l->filename);

    l->file = storage_file_alloc(l->storage);
    if(!l->file || !storage_file_open(l->file, full_path, FSAM_WRITE, FSOM_CREATE_ALWAYS)) {
        SD_LOG_E("SdLogger", "Failed to open %s", full_path);
        if(l->file) { storage_file_free(l->file); l->file = NULL; }
        l->filename[0] = '\0';
        return false;
    }

    // Integrity marker first (SD_LOGGER_INTEGRITY_LINE) so it is the file's
    // very first line, then the caller's header. Both are folded into the
    // CRC that the "# End" trailer will carry.
    size_t ilen = strlen(SD_LOGGER_INTEGRITY_LINE);
    size_t hlen = strlen(header);
    uint16_t iwritten = storage_file_write(l->file, SD_LOGGER_INTEGRITY_LINE, ilen);
    uint16_t written = (iwritten == ilen) ? storage_file_write(l->file, header, hlen) : 0;
    if(iwritten != ilen || written != hlen) {
        SD_LOG_E("SdLogger", "Header write failed (%d/%d + %d/%d)",
                 iwritten, (int)ilen, written, (int)hlen);
        storage_file_close(l->file);
        storage_file_free(l->file);
        l->file = NULL;
        l->filename[0] = '\0';
        return false;
    }

    l->crc = crc32_feed(0xFFFFFFFFu, SD_LOGGER_INTEGRITY_LINE, ilen);
    l->crc = crc32_feed(l->crc, header, hlen);
    l->crc_bytes = (uint32_t)(ilen + hlen);
    l->row_count = 0;
    l->last_byte_newline = (hlen > 0) ? (header[hlen - 1] == '\n') : true;
    // Sync immediately, same reasoning as sd_logger_batch_flush(): a
    // "successful" storage_file_write() only means FatFs accepted the
    // bytes into its cache, not that they reached physical media.
    bool header_synced = storage_file_sync(l->file);
    if(!header_synced) {
        SD_LOG_W("SdLogger", "Header sync failed (written, not yet confirmed durable)");
    }

#if BIOMAP_SD_PREALLOC
    preallocate_log_file(l);
#endif

    l->active = true;
    SD_LOG_I("SdLogger", "Recording to %s", full_path);
    return true;
#endif
}

bool sd_logger_start(SdLogger* l, const char* header) {
    furi_check(l, "SdLogger: NULL in start()");
    furi_check(!l->active, "SdLogger: already active in start()");
    bool ok = open_log_file(l, header);
    if(ok) {
        l->gsr_batch_len = 0;
        l->flush_peak_ms = 0;
        l->batch_fill_peak_bytes = 0;
        l->overflow_count = 0;
        l->flush_fail_count = 0;
    }
    return ok;
}

// Append the "# End" integrity trailer (SD_LOGGER_INTEGRITY_LINE) — the
// last line of a cleanly-stopped recording. Called from sd_logger_stop()
// after the final batch flush and before any pre-allocation trim, so it
// sits immediately after the last data row. end_epoch is the RTC time at
// stop; 0 means unknown (RTC unset), and the end_time token is omitted
// rather than written as a misleading 0. A failed trailer write/sync is
// logged, not fatal: the recording's data is already safely on the card,
// it just won't carry a verifiable trailer.
static void sd_logger_write_trailer(SdLogger* l, uint32_t end_epoch) {
    // Guarantee the trailer starts its own line even if the last flushed
    // batch ended mid-row (only reachable if a caller feeds unterminated
    // data — normal rows always end in '\n'). The separator is real file
    // content, so fold it into the CRC / byte / row counters the trailer
    // is about to report.
    if(!l->last_byte_newline) {
        if(storage_file_write(l->file, "\n", 1) == 1) {
            l->crc = crc32_feed(l->crc, "\n", 1);
            l->crc_bytes += 1;
            l->row_count += 1;
            l->last_byte_newline = true;
        }
    }

    char trailer[192];
    int n;
    if(end_epoch != 0) {
        n = snprintf(trailer, sizeof(trailer),
                     "# End rows:%lu bytes:%lu crc32:%08lx end_time:%lu "
                     "overflows:%lu flush_fails:%lu\n",
                     (unsigned long)l->row_count, (unsigned long)l->crc_bytes,
                     (unsigned long)(~l->crc), (unsigned long)end_epoch,
                     (unsigned long)l->overflow_count,
                     (unsigned long)l->flush_fail_count);
    } else {
        n = snprintf(trailer, sizeof(trailer),
                     "# End rows:%lu bytes:%lu crc32:%08lx "
                     "overflows:%lu flush_fails:%lu\n",
                     (unsigned long)l->row_count, (unsigned long)l->crc_bytes,
                     (unsigned long)(~l->crc),
                     (unsigned long)l->overflow_count,
                     (unsigned long)l->flush_fail_count);
    }
    if(n <= 0 || (size_t)n >= sizeof(trailer)) {
        SD_LOG_W("SdLogger", "Trailer format failed — file left without integrity trailer");
        return;
    }
    uint16_t w = storage_file_write(l->file, trailer, (size_t)n);
    if(w != (uint16_t)n) {
        SD_LOG_W("SdLogger", "Trailer write failed (%d/%d)", w, n);
        return;
    }
    if(!storage_file_sync(l->file)) {
        SD_LOG_W("SdLogger", "Trailer sync failed (written, not yet confirmed durable)");
    }
}

void sd_logger_stop(SdLogger* l, uint32_t end_epoch) {
    furi_check(l, "SdLogger: NULL in stop()");
    if(!l->active && !l->file) return;
    if(l->gsr_batch_len > 0) {
        sd_logger_batch_flush(l);
    }
    if(l->file) {
        // Trailer before the pre-allocation trim below: storage_file_truncate()
        // cuts to the current position, so the trailer write must advance it
        // past the last data row first.
        sd_logger_write_trailer(l, end_epoch);
#if BIOMAP_SD_PREALLOC
        // Trim any never-written pre-allocated tail (preallocate_log_file(),
        // open_log_file() above) back to the real data length -- the
        // pre-allocated region's content is undefined, not zero-filled
        // (real FatFs f_lseek() semantics), so leaving it in place would pad
        // every recording out to the full SD_LOGGER_PREALLOC_BYTES with
        // garbage bytes. storage_file_truncate() truncates to the CURRENT
        // position, which sd_logger_batch_flush()'s writes always leave
        // sitting at the real end of data -- safe even when pre-allocation
        // never actually grew the file (the seek-full fallback above):
        // truncating to the current position when nothing grew past it is a
        // no-op.
        if(!storage_file_truncate(l->file)) {
            SD_LOG_W("SdLogger", "Final truncate failed — file may retain pre-allocated padding");
        }
#endif
        storage_file_close(l->file);
        storage_file_free(l->file);
        l->file = NULL;
    }
    l->active = false;
    SD_LOG_I("SdLogger", "Stopped %s", l->filename);
}


// Flush the internal batch buffer to SD in one write.
// Returns: >0 bytes flushed, 0 if buffer was empty, -1 on error.
//
// On error the buffer is left untouched (NOT cleared) so a subsequent call
// retries the exact same bytes rather than silently discarding data the SD
// card never actually received — the caller decides whether to retry or
// give up. A partial write (0 < written < flushed) is treated the same as
// a total failure: the whole batch is retried next time, which may
// duplicate the already-written prefix on a genuine partial write. That's
// a deliberate simplification — FatFs writes at this size (<=4 KB) are
// effectively atomic in practice, so tracking a partial-write remainder
// with a memmove isn't worth the complexity for an edge case this rare.
int sd_logger_batch_flush(SdLogger* l) {
    furi_check(l, "SdLogger: NULL in batch_flush()");
    if(!l->active) return 0;
    if(l->gsr_batch_len == 0) return 0;

#if BIOMAP_SD_DRY_RUN
    int flushed = l->gsr_batch_len;
    l->gsr_batch_len = 0;
    return flushed;
#else
    if(!l->file) return 0;

    // Timed as one unit (write+sync) since they always run back to back
    // here and the caller (biomap_session.c's Tick handler) only cares
    // about the total real time this call held the main thread — see
    // sd_logger_get_flush_peak_ms()'s doc comment (sd_logger.h).
    uint32_t flush_start = furi_get_tick();

    uint16_t written = storage_file_write(l->file, l->gsr_batch,
                                          (size_t)l->gsr_batch_len);
    int flushed = l->gsr_batch_len;

    if(written != (uint16_t)flushed) {
        SD_LOG_E("SdLogger", "Batch flush error: %d/%d",
                 written, flushed);
        uint32_t flush_dur = furi_get_tick() - flush_start;
        if(flush_dur > l->flush_peak_ms) l->flush_peak_ms = flush_dur;
        l->flush_fail_count++;
        return -1;
    }

    // Fold exactly the bytes that reached the file into the integrity
    // CRC / byte / row counters, on the confirmed-write path only, so the
    // "# End" trailer always describes what is actually on the card. A
    // genuine partial write that later succeeds on retry re-counts the
    // whole batch and would CRC the duplicated prefix — but that path also
    // bumps flush_fail_count, which the trailer reports, so the file is
    // flagged regardless.
    l->crc = crc32_feed(l->crc, l->gsr_batch, (size_t)flushed);
    l->crc_bytes += (uint32_t)flushed;
    for(int i = 0; i < flushed; i++) {
        if(l->gsr_batch[i] == '\n') l->row_count++;
    }
    if(flushed > 0) l->last_byte_newline = (l->gsr_batch[flushed - 1] == '\n');

    l->gsr_batch_len = 0;

    bool batch_synced = storage_file_sync(l->file);
    if(!batch_synced) {
        SD_LOG_W("SdLogger", "Batch sync failed");
        l->flush_fail_count++;
    }

    uint32_t flush_dur = furi_get_tick() - flush_start;
    if(flush_dur > l->flush_peak_ms) l->flush_peak_ms = flush_dur;

    return flushed;
#endif
}

// Append a pre-formatted row to the internal batch buffer.
// Returns false on overflow (data not appended, caller should log/drop).
bool sd_logger_batch_append(SdLogger* l, const char* data, size_t len) {
    furi_check(l, "SdLogger: NULL in batch_append()");
    if(len == 0) return true;
    if(l->gsr_batch_len + (int)len > (int)sizeof(l->gsr_batch)) {
        SD_LOG_W("SdLogger", "Batch overflow (%d + %d > %d)",
                 l->gsr_batch_len, (int)len, (int)sizeof(l->gsr_batch));
        l->overflow_count++;
        return false;
    }
    memcpy(l->gsr_batch + l->gsr_batch_len, data, len);
    l->gsr_batch_len += (int)len;
    if((uint32_t)l->gsr_batch_len > l->batch_fill_peak_bytes) {
        l->batch_fill_peak_bytes = (uint32_t)l->gsr_batch_len;
    }
    return true;
}

// Format a row directly into the batch buffer, avoiding an intermediate
// stack buffer and the memcpy that sd_logger_batch_append would require.
// Returns bytes written to the buffer, or 0 on overflow/error.
int sd_logger_batch_printf(SdLogger* l, const char* fmt, ...) {
    furi_check(l, "SdLogger: NULL in batch_printf()");
    if(!l->active) return 0;

    int remaining = (int)sizeof(l->gsr_batch) - l->gsr_batch_len;
    if(remaining <= 0) {
        SD_LOG_W("SdLogger", "Batch printf overflow (buffer full)");
        l->overflow_count++;
        return 0;
    }

    va_list args;
    va_start(args, fmt);
    int n = vsnprintf(l->gsr_batch + l->gsr_batch_len,
                      (size_t)remaining, fmt, args);
    va_end(args);

    if(n <= 0) return 0;
    if(n >= remaining) {
        // vsnprintf truncated the row: it wrote only `remaining - 1` bytes
        // of real content (plus a NUL) into the buffer. Do NOT advance
        // gsr_batch_len past the last complete row — doing so would leave
        // a truncated/corrupt partial row in the buffer that the next
        // sd_logger_batch_flush() would write straight to the SD card,
        // corrupting the CSV. Roll back and let the caller's overflow
        // path (emergency flush) start the row fresh in a cleared buffer.
        SD_LOG_W("SdLogger", "Batch printf truncated (%d >= %d) — row discarded",
                 n, remaining);
        l->overflow_count++;
        return 0;
    }
    l->gsr_batch_len += n;
    if((uint32_t)l->gsr_batch_len > l->batch_fill_peak_bytes) {
        l->batch_fill_peak_bytes = (uint32_t)l->gsr_batch_len;
    }
    return n;
}

const char* sd_logger_get_filename(const SdLogger* l) { return l->filename; }

uint32_t sd_logger_get_flush_peak_ms(const SdLogger* l) { return l->flush_peak_ms; }
uint32_t sd_logger_get_prealloc_ms(const SdLogger* l) { return l->prealloc_ms; }
uint32_t sd_logger_get_batch_fill_bytes(const SdLogger* l) { return (uint32_t)l->gsr_batch_len; }
uint32_t sd_logger_get_batch_fill_peak_bytes(const SdLogger* l) { return l->batch_fill_peak_bytes; }
uint32_t sd_logger_get_overflow_count(const SdLogger* l) { return l->overflow_count; }
uint32_t sd_logger_get_flush_fail_count(const SdLogger* l) { return l->flush_fail_count; }
