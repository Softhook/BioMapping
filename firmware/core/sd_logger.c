// SD Logger — date-time-named CSV writer. Shared by every device: see
// sd_logger.h. The card itself is reached only through SdPlatform.

#include "sd_logger.h"
#include "biomap_format.h"
#include "core_check.h"
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define LOGGER_BASENAME "biomap_"
#define LOGGER_EXT       ".csv"
// Highest "_N" suffix tried when a file with the same start time already
// exists (two recordings started within the same second, or a clock that
// was reset and is reading the same times again). Only a guard against an
// endless loop: reaching it fails the recording, it never overwrites.
#define LOGGER_MAX_SUFFIX 9999

// One-shot pre-allocation size — see preallocate_log_file() below. Sized
// against track 016's own measured worst-case rate (GPS+GSR+RF, debug fields on
// — the widest schema, ~72 KiB/min): ~90 minutes (6.33 MiB) plus real margin,
// rounded to 8 MiB. Every mode gets the same pre-allocation regardless of its
// actual (lower) row width — harmless, since sd_logger_stop() always trims the
// unused tail back to the real data length.
#define SD_LOGGER_PREALLOC_BYTES (8u * 1024u * 1024u)
// ── Integrity bracket ─────────────────────────────────────────────────────
// Every recording is wrapped by two lines so the visualiser (or any
// external tool) can confirm the file is complete and unmodified:
//   • "# Integrity: crc32 v1" as the file's first line — announces that a
//     trailer is expected and which algorithm produced it;
//   • "# End rows:<n> bytes:<n> crc32:<hex> [end_time:<epoch>]
//     overflows:<n> flush_fails:<n>" written by sd_logger_stop() once the
//     final batch has flushed.
// The CRC32 (biomap_crc32_update) covers every byte from the marker line up
// to — but not including — the trailer. A missing trailer means the
// recording never stopped cleanly (flat battery, crash, card pulled); a
// trailer whose CRC / row count disagrees with the data means the file was
// truncated or altered after the device wrote it.
// This is corruption detection, not tamper protection — a plain CRC can
// always be recomputed by whoever edited the file.
#define SD_LOGGER_INTEGRITY_LINE "# Integrity: crc32 v1\n"

struct SdLogger {
    SdPlatform platform;
    // Whole-block writes (sd_logger_create()); 0 = write everything.
    uint32_t block_bytes;
    bool     file_open;
    bool     active;
    char     filename[64];

    // GPS+GSR+RF batch buffer: accumulate formatted rows each tick,
    // flush to SD in one write every FLUSH_INTERVAL seconds.
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

    // The last flush failed. The next one then writes the whole buffer,
    // whole blocks or not, so a success really means the card is back.
    bool last_flush_failed;

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
    // sd_logger_stop(). Every byte written goes through the CRC, so
    // crc_bytes is also the file's current length and write position.
    uint32_t crc;
    uint32_t crc_bytes;
    uint32_t row_count;
    bool     last_byte_newline; // was the last data byte a '\n'? (trailer needs its own line)
};

__attribute__((format(printf, 3, 4)))
static void sd_log(const SdLogger* l, SdLogLevel level, const char* fmt, ...) {
    if(!l->platform.log) return;
    char line[160];
    va_list args;
    va_start(args, fmt);
    vsnprintf(line, sizeof(line), fmt, args);
    va_end(args);
    l->platform.log(l->platform.ctx, level, line);
}

SdLogger* sd_logger_create(const SdPlatform* platform, uint32_t block_bytes) {
    CORE_CHECK(platform, "SdLogger: NULL platform in create()");
    CORE_CHECK(platform->open_new && platform->write && platform->sync && platform->seek
                   && platform->truncate && platform->close && platform->now_ms,
               "SdLogger: platform is missing a function");
    SdLogger* l = malloc(sizeof(SdLogger));
    CORE_CHECK(l, "SdLogger: NULL logger alloc");
    *l = (SdLogger){.platform = *platform, .block_bytes = block_bytes};
    return l;
}

void sd_logger_destroy(SdLogger* l) {
    CORE_CHECK(l, "SdLogger: NULL in destroy()");
    // 0 = no clock reading available on this teardown path; the trailer's
    // end_time token is simply omitted (see sd_logger_write_trailer).
    if(l->active) sd_logger_stop(l, 0);
    free(l);
}

void* sd_logger_platform_ctx(const SdLogger* l) {
    CORE_CHECK(l, "SdLogger: NULL in platform_ctx()");
    return l->platform.ctx;
}

// "biomap_<stamp>.csv" for n == 1, otherwise "biomap_<stamp>_<n>.csv".
static void make_filename(SdLogger* l, const char* stamp, int n) {
    if(n == 1) {
        snprintf(l->filename, sizeof(l->filename), LOGGER_BASENAME "%s" LOGGER_EXT, stamp);
    } else {
        snprintf(l->filename, sizeof(l->filename), LOGGER_BASENAME "%s_%d" LOGGER_EXT, stamp, n);
    }
}

static void close_file(SdLogger* l) {
    l->platform.close(l->platform.ctx);
    l->file_open = false;
}

// Grows the just-opened file to SD_LOGGER_PREALLOC_BYTES once, up front, by
// seeking past the current end and writing one byte there. On the Flipper this
// is the only pre-allocation the app SDK offers (no f_expand binding exists;
// File is an opaque struct with no accessor to a raw FatFs handle either --
// confirmed by grepping the full SDK headers). Real FatFs's f_lseek() performs
// the size-extend (and pays its cluster-allocation cost) immediately, inside
// that call, with undefined -- NOT zero-filled -- content in the gap. Always
// leaves the file positioned back at the real data boundary (right after the
// header) so the first batch flush lands contiguously, never inside the
// pre-allocated tail. sd_logger_stop() trims the unused tail back to the real
// data length.
static void preallocate_log_file(SdLogger* l) {
    uint32_t real_pos = l->crc_bytes; // right after header write+sync
    uint32_t target = real_pos + SD_LOGGER_PREALLOC_BYTES;

    uint32_t start_ms = l->platform.now_ms(l->platform.ctx);
    if(l->platform.seek(l->platform.ctx, target - 1)) {
        uint8_t dummy = 0;
        l->platform.write(l->platform.ctx, &dummy, 1);
    } else {
        // Real FatFs still expands as far as it can on disk-full rather than
        // failing outright (elm-chan.org/fsw/ff/doc/lseek.html) -- this
        // branch is a defensive fallback for a seek that fails outright, not
        // the expected path. Either way, skip the dummy write and fall
        // through to the rewind below: a partial or missing pre-allocation
        // degrades to a plain append, it doesn't corrupt anything.
        sd_log(l, SdLogWarning, "Pre-allocation seek failed (SD full/near-full?) — continuing without it");
    }
    // Always rewind to the real data boundary, whatever happened above, so
    // the next batch flush resumes exactly where the header left off.
    l->platform.seek(l->platform.ctx, real_pos);
    // Save the reserved space now, before the recording starts. Without it
    // the card's file table changes for the whole 8 MB wait in the cache
    // until the first flush's sync, 10 s into the recording, which then
    // takes hundreds of ms (433 ms seen on the Cardputer; the bench, which
    // synced here, saw 57 ms at worst).
    if(!l->platform.sync(l->platform.ctx)) {
        sd_log(l, SdLogWarning, "Pre-allocation sync failed — the first flush will save it");
    }
    l->prealloc_ms = l->platform.now_ms(l->platform.ctx) - start_ms;
}

// Create a new CSV file named from `stamp` and write a header row.
// Returns true on success; on failure the logger is left inactive with no
// open file.
static bool open_log_file(SdLogger* l, const char* header, const char* stamp) {
    l->prealloc_ms = 0;

    // Created new only: the card itself refuses to open a name that already
    // exists, so an older recording can never be overwritten — not even if
    // the clock was reset and is giving out times already used. When the
    // open fails because the name is taken, move on to the next suffix
    // ("_2", "_3" …); any other failure (card missing, full, faulty) stops.
    SdOpenResult r = SdOpenFailed;
    for(int n = 1; n <= LOGGER_MAX_SUFFIX; n++) {
        make_filename(l, stamp, n);
        r = l->platform.open_new(l->platform.ctx, l->filename);
        if(r != SdOpenNameTaken) break;
    }
    if(r != SdOpenOk) {
        sd_log(l, SdLogError, "Failed to create a new file for %s", stamp);
        l->filename[0] = '\0';
        return false;
    }
    l->file_open = true;

    // Integrity marker first (SD_LOGGER_INTEGRITY_LINE) so it is the file's
    // very first line, then the caller's header. Both are folded into the
    // CRC that the "# End" trailer will carry.
    size_t ilen = strlen(SD_LOGGER_INTEGRITY_LINE);
    size_t hlen = strlen(header);
    size_t iwritten = l->platform.write(l->platform.ctx, SD_LOGGER_INTEGRITY_LINE, ilen);
    size_t written = (iwritten == ilen) ? l->platform.write(l->platform.ctx, header, hlen) : 0;
    if(iwritten != ilen || written != hlen) {
        sd_log(l, SdLogError, "Header write failed (%d/%d + %d/%d)",
               (int)iwritten, (int)ilen, (int)written, (int)hlen);
        close_file(l);
        l->filename[0] = '\0';
        return false;
    }

    l->crc = biomap_crc32_update(0xFFFFFFFFu, SD_LOGGER_INTEGRITY_LINE, ilen);
    l->crc = biomap_crc32_update(l->crc, header, hlen);
    l->crc_bytes = (uint32_t)(ilen + hlen);
    l->row_count = 0;
    l->last_byte_newline = (hlen > 0) ? (header[hlen - 1] == '\n') : true;
    // Sync immediately, same reasoning as sd_logger_batch_flush(): a
    // "successful" write only means FatFs accepted the bytes into its
    // cache, not that they reached physical media.
    if(!l->platform.sync(l->platform.ctx)) {
        sd_log(l, SdLogWarning, "Header sync failed (written, not yet confirmed durable)");
    }

    preallocate_log_file(l);

    l->active = true;
    sd_log(l, SdLogInfo, "Recording to %s", l->filename);
    return true;
}

bool sd_logger_start(SdLogger* l, const char* header, const char* stamp) {
    CORE_CHECK(l, "SdLogger: NULL in start()");
    CORE_CHECK(stamp, "SdLogger: NULL stamp in start()");
    CORE_CHECK(!l->active, "SdLogger: already active in start()");
    bool ok = open_log_file(l, header, stamp);
    if(ok) {
        l->gsr_batch_len = 0;
        l->last_flush_failed = false;
        l->flush_peak_ms = 0;
        l->batch_fill_peak_bytes = 0;
        l->overflow_count = 0;
        l->flush_fail_count = 0;
    }
    return ok;
}

// Fold `n` bytes just committed to the file into the integrity counters the
// "# End" trailer reports: the running CRC, the byte total, the row count
// (one per '\n'), and the trailing-newline flag. Call once per confirmed
// write of real file content — the partial-write path, the confirmed-flush
// path, and the trailer's line separator all share this exact bookkeeping.
static void fold_committed(SdLogger* l, const char* data, size_t n) {
    if(n == 0) return;
    l->crc = biomap_crc32_update(l->crc, data, n);
    l->crc_bytes += (uint32_t)n;
    for(size_t i = 0; i < n; i++) {
        if(data[i] == '\n') l->row_count++;
    }
    l->last_byte_newline = (data[n - 1] == '\n');
}

// Drop the first `n` bytes of the batch buffer (they are on the card now).
static void drop_front(SdLogger* l, size_t n) {
    memmove(l->gsr_batch, l->gsr_batch + n, (size_t)l->gsr_batch_len - n);
    l->gsr_batch_len -= (int)n;
}

// Raise the lifetime high-water mark after the batch buffer has grown.
static void note_batch_fill(SdLogger* l) {
    if((uint32_t)l->gsr_batch_len > l->batch_fill_peak_bytes) {
        l->batch_fill_peak_bytes = (uint32_t)l->gsr_batch_len;
    }
}

// Fold one completed flush (write+sync) into the worst-case duration peak.
static void note_flush_duration(SdLogger* l, uint32_t start_ms) {
    uint32_t dur = l->platform.now_ms(l->platform.ctx) - start_ms;
    if(dur > l->flush_peak_ms) l->flush_peak_ms = dur;
}

// Append the "# End" integrity trailer (SD_LOGGER_INTEGRITY_LINE) — the
// last line of a cleanly-stopped recording. Called from sd_logger_stop()
// after the final batch flush and before any pre-allocation trim, so it
// sits immediately after the last data row. end_epoch is the clock time at
// stop; 0 means unknown (clock unset), and the end_time token is omitted
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
        if(l->platform.write(l->platform.ctx, "\n", 1) == 1) {
            fold_committed(l, "\n", 1);
        }
    }

    // end_time token only when the clock gave a real epoch; otherwise it
    // drops out entirely rather than being written as a misleading 0.
    char end_time_tok[32] = "";
    if(end_epoch != 0) {
        snprintf(end_time_tok, sizeof(end_time_tok), "end_time:%lu ", (unsigned long)end_epoch);
    }
    char trailer[192];
    int n = snprintf(trailer, sizeof(trailer),
                     "# End rows:%lu bytes:%lu crc32:%08lx %soverflows:%lu flush_fails:%lu\n",
                     (unsigned long)l->row_count, (unsigned long)l->crc_bytes,
                     (unsigned long)(~l->crc), end_time_tok,
                     (unsigned long)l->overflow_count,
                     (unsigned long)l->flush_fail_count);
    if(n <= 0 || (size_t)n >= sizeof(trailer)) {
        sd_log(l, SdLogWarning, "Trailer format failed — file left without integrity trailer");
        return;
    }
    size_t w = l->platform.write(l->platform.ctx, trailer, (size_t)n);
    if(w != (size_t)n) {
        sd_log(l, SdLogWarning, "Trailer write failed (%d/%d)", (int)w, n);
        return;
    }
    if(!l->platform.sync(l->platform.ctx)) {
        sd_log(l, SdLogWarning, "Trailer sync failed (written, not yet confirmed durable)");
    }
}

static int flush_batch(SdLogger* l, bool whole_blocks_only);

void sd_logger_stop(SdLogger* l, uint32_t end_epoch) {
    CORE_CHECK(l, "SdLogger: NULL in stop()");
    if(!l->active && !l->file_open) return;
    // Everything left, whole blocks or not. The session has normally done
    // this already with sd_logger_batch_flush_all(), which it can retry
    // and warn about; this one is for the other ways a recording ends.
    if(l->gsr_batch_len > 0) {
        flush_batch(l, false);
    }
    if(l->file_open) {
        // Trailer before the pre-allocation trim below: the truncate cuts
        // to the current position, so the trailer write must advance it
        // past the last data row first.
        sd_logger_write_trailer(l, end_epoch);
        // Trim any never-written pre-allocated tail (preallocate_log_file(),
        // open_log_file() above) back to the real data length -- the
        // pre-allocated region's content is undefined, not zero-filled
        // (real FatFs f_lseek() semantics), so leaving it in place would pad
        // every recording out to the full SD_LOGGER_PREALLOC_BYTES with
        // garbage bytes. The truncate cuts at the CURRENT position, which
        // the flush writes always leave sitting at the real end of data --
        // safe even when pre-allocation never actually grew the file (the
        // seek-full fallback above): truncating to the current position
        // when nothing grew past it is a no-op.
        if(!l->platform.truncate(l->platform.ctx)) {
            sd_log(l, SdLogWarning, "Final truncate failed — file may retain pre-allocated padding");
        }
        close_file(l);
    }
    l->active = false;
    sd_log(l, SdLogInfo, "Stopped %s", l->filename);
}

// How many bytes from the front of the buffer this flush writes: all of
// them, or with block_bytes set, up to the last whole block of the file.
static size_t flush_length(const SdLogger* l, bool whole_blocks_only) {
    size_t len = (size_t)l->gsr_batch_len;
    if(!whole_blocks_only || l->block_bytes == 0 || l->last_flush_failed) return len;
    uint32_t end = ((l->crc_bytes + (uint32_t)len) / l->block_bytes) * l->block_bytes;
    return end > l->crc_bytes ? (size_t)(end - l->crc_bytes) : 0;
}

// Flush the front of the internal batch buffer to SD in one write.
// Returns: >0 bytes flushed, 0 if there was nothing to write, -1 on error.
//
// On a total failure (written == 0) the buffer is left untouched (NOT
// cleared) so a subsequent call retries the exact same bytes rather than
// silently discarding data the SD card never received — the caller decides
// whether to retry or give up.
//
// On a partial write (0 < written < wanted — a card that dies mid-transfer)
// the bytes the card DID take are folded into the integrity counters and
// only the unwritten tail is kept for the retry, so a later successful
// flush never re-writes the already-stored prefix. That keeps the "# End"
// trailer's crc32/bytes/rows an exact description of the file even across a
// flush failure a later flush recovers from — the write-failure ride-out in
// core/biomap_session.c relies on it, so such a file re-imports as "hit SD
// pressure" (flagged by flush_fails>0), not as corrupt.
static int flush_batch(SdLogger* l, bool whole_blocks_only) {
    if(!l->active) return 0;
    if(l->gsr_batch_len == 0) return 0;
    if(!l->file_open) return 0;
    size_t want = flush_length(l, whole_blocks_only);
    if(want == 0) return 0;

    // Timed as one unit (write+sync) since they always run back to back
    // here and the caller (core/biomap_session.c's tick) only cares
    // about the total real time this call held the main thread — see
    // sd_logger_get_flush_peak_ms()'s doc comment (sd_logger.h).
    uint32_t flush_start = l->platform.now_ms(l->platform.ctx);

    size_t written = l->platform.write(l->platform.ctx, l->gsr_batch, want);

    if(written != want) {
        sd_log(l, SdLogError, "Batch flush error: %d/%d", (int)written, (int)want);
        note_flush_duration(l, flush_start);
        l->flush_fail_count++;
        l->last_flush_failed = true;

        // Partial write: `written` bytes reached the card before it failed.
        // Commit exactly those to the CRC / byte / row counters and drop
        // them from the buffer, leaving only the unwritten tail for the
        // retry. (written == 0 is the common total-failure case: nothing
        // committed, the whole batch is retried unchanged.)
        if(written > 0) {
            fold_committed(l, l->gsr_batch, written);
            drop_front(l, written);
        }
        return -1;
    }

    // Fold exactly the bytes that reached the file into the integrity
    // CRC / byte / row counters, on the confirmed-write path only, so the
    // "# End" trailer always describes what is actually on the card. After
    // a partial write, the failure branch above already committed the
    // prefix and kept only the unwritten tail, so a successful retry lands
    // here with just that tail — nothing is counted twice.
    fold_committed(l, l->gsr_batch, want);
    drop_front(l, want);
    l->last_flush_failed = false;

    if(!l->platform.sync(l->platform.ctx)) {
        sd_log(l, SdLogWarning, "Batch sync failed");
        l->flush_fail_count++;
    }

    note_flush_duration(l, flush_start);
    return (int)want;
}

int sd_logger_batch_flush(SdLogger* l) {
    CORE_CHECK(l, "SdLogger: NULL in batch_flush()");
    return flush_batch(l, true);
}

int sd_logger_batch_flush_all(SdLogger* l) {
    CORE_CHECK(l, "SdLogger: NULL in batch_flush_all()");
    return flush_batch(l, false);
}

// Append a pre-formatted row to the internal batch buffer.
// Returns false on overflow (data not appended, caller should log/drop).
bool sd_logger_batch_append(SdLogger* l, const char* data, size_t len) {
    CORE_CHECK(l, "SdLogger: NULL in batch_append()");
    if(len == 0) return true;
    if(l->gsr_batch_len + (int)len > (int)sizeof(l->gsr_batch)) {
        sd_log(l, SdLogWarning, "Batch overflow (%d + %d > %d)",
               l->gsr_batch_len, (int)len, (int)sizeof(l->gsr_batch));
        l->overflow_count++;
        return false;
    }
    memcpy(l->gsr_batch + l->gsr_batch_len, data, len);
    l->gsr_batch_len += (int)len;
    note_batch_fill(l);
    return true;
}

const char* sd_logger_get_filename(const SdLogger* l) { return l->filename; }

uint32_t sd_logger_get_flush_peak_ms(const SdLogger* l) { return l->flush_peak_ms; }
uint32_t sd_logger_get_prealloc_ms(const SdLogger* l) { return l->prealloc_ms; }
uint32_t sd_logger_get_batch_fill_bytes(const SdLogger* l) { return (uint32_t)l->gsr_batch_len; }
uint32_t sd_logger_get_batch_fill_peak_bytes(const SdLogger* l) { return l->batch_fill_peak_bytes; }
uint32_t sd_logger_get_overflow_count(const SdLogger* l) { return l->overflow_count; }
uint32_t sd_logger_get_flush_fail_count(const SdLogger* l) { return l->flush_fail_count; }
