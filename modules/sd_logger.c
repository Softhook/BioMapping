// SD Logger — auto-incrementing CSV writer.
//
// ── Background writer thread (2026-08-03) ──────────────────────────────
// docs/gps_rf_mutex_status.md's SD-flush investigation found real,
// measured storage_file_write()/storage_file_sync() stalls (up to ~950ms,
// tracks 116/117/118) landing on the app's main thread — the same thread
// that has to keep draining GPS UART, processing Tick events, and pacing
// the GUI redraw. This file now moves that write+sync off onto its own
// FuriThread, so a slow SD card blocks only this thread, not the caller.
//
// Design, deliberately minimal:
//   - Double-buffered: gsr_batch[0]/[1], each the same size as the single
//     buffer this replaces. The caller (sd_logger_batch_append/_printf)
//     always writes into `cur_buf`; sd_logger_batch_flush() hands that
//     buffer to the writer thread and switches `cur_buf` to the other one
//     — but only once the OTHER buffer is confirmed free (buf_free[]),
//     so the caller is never more than one buffer-swap ahead of the
//     writer. If the writer is still busy with the other buffer when a
//     flush is due, the flush is skipped this call (data stays in the
//     current buffer, retried next time) rather than blocking — the same
//     "some data-loss risk under duress" the existing buffer-overflow
//     path already accepts, not a new category of risk.
//   - Two FuriMessageQueues carry ownership of a buffer across the
//     thread boundary — no mutex, and no manual atomics either: `cur_buf`,
//     `gsr_batch_len[]`, and `buf_free[]` are all touched ONLY by the
//     calling (main) thread; `gsr_batch[]`'s contents are touched by the
//     calling thread while filling, then exclusively by the writer
//     thread once handed off via the queue, never both at once. The
//     queue's own internal locking is the only synchronization involved,
//     same primitive the app's own event loop already uses.
//   - The writer thread is created once (sd_logger_alloc()) and destroyed
//     once (sd_logger_free()), like GsrSensor's worker thread
//     (modules/gsr_sensor.c) — NOT recreated per recording. Between
//     recordings (and between flushes) it just blocks on
//     furi_message_queue_get(..., FuriWaitForever), costing nothing.
//   - sd_logger_stop() still synchronously waits for the writer to flush
//     whatever's left and close the file (a furi_thread_join()-free wait
//     on the ack queue instead) — every caller in biomap_session.c
//     assumes the file is fully closed by the time stop() returns, and
//     that's still true here; only the PERIODIC in-recording flushes
//     became asynchronous, not the final one.
//   - Deliberate, explicit trade: a write/sync failure is no longer
//     reported back to the caller. sd_logger_batch_flush() always
//     returns >= 0 now. Before this change, a broken/full/pulled SD card
//     got detected synchronously and stopped the recording with a
//     red-LED alert (biomap_session.c's handle_write_failure(), removed
//     alongside this). That safety behavior is gone in this minimal
//     version — the writer thread just logs and moves on. Restoring it
//     would need the writer to report status back through the ack queue
//     too; not done here.

#include "sd_logger.h"
#include "util.h"
#include <furi.h>
#include <storage/storage.h>
#include <string.h>
#include <stdio.h>
#include <stdarg.h>
#include <stdatomic.h>

#define LOGGER_DIR      "biomapping"
#define LOGGER_BASENAME "biomap_"
#define LOGGER_EXT       ".csv"
#define LOGGER_MAX_INDEX 999

// Message from the caller to the writer thread. buf_index == -1 is the
// shutdown sentinel (sd_logger_free() only) — the writer closes whatever
// file is open, if any, and returns, ending the thread for good.
typedef struct {
    int  buf_index;
    int  len;
    bool close_file;
} SdWriteMsg;

// Message back from the writer thread once it's actually done with a
// buffer (closed == false) or has finished closing the file for a
// sd_logger_stop() (closed == true, buf_index meaningless).
typedef struct {
    int  buf_index;
    bool closed;
} SdWriteAck;

struct SdLogger {
    Storage* storage;
    File*    file;
    bool     recording_active;
    char     filename[64];
    int      last_index;

    // Double-buffered batch — see this file's banner comment above.
    // 100 rows × ~110-115 bytes (GPS+GSR+RF row, 22 columns) ≈ 11-11500
    // bytes per buffer, comfortably under 12288 each — same per-buffer
    // capacity the single-buffer version had, just two of them now.
    char gsr_batch[2][12288];
    int  gsr_batch_len[2];
    int  cur_buf;         // 0 or 1 — which buffer the caller is filling
    bool buf_free[2];     // true once the writer thread is done with it

    FuriThread*       writer;
    FuriMessageQueue* to_writer;   // SdWriteMsg
    FuriMessageQueue* from_writer; // SdWriteAck

    // Worst single storage_file_write()+storage_file_sync() real duration
    // ever seen, timed on the writer thread itself — see
    // sd_logger_get_flush_dur_ms()'s doc comment (sd_logger.h). _Atomic
    // because the writer thread writes it and the main thread reads it;
    // safe as plain load/store (no read-modify-write race) because the
    // writer thread is the ONLY writer — same reasoning already applied
    // to GsrSensor's `running`/`rf_enabled`/`rf_spi_busy` (modules/gsr_sensor.c).
    _Atomic uint32_t flush_dur_ms;
};

// Runs entirely on its own thread. Touches l->file and l->gsr_batch[N]
// only for a buffer index it just received ownership of via the queue —
// never concurrently with the caller thread (see this file's banner).
static int32_t sd_logger_writer(void* context) {
    SdLogger* l = context;
    while(true) {
        SdWriteMsg msg;
        if(furi_message_queue_get(l->to_writer, &msg, FuriWaitForever) != FuriStatusOk) {
            continue;
        }
        if(msg.buf_index < 0) break; // shutdown sentinel — sd_logger_free()

        if(msg.len > 0) {
            uint32_t write_start = furi_get_tick();
            uint16_t written = storage_file_write(l->file, l->gsr_batch[msg.buf_index],
                                                  (size_t)msg.len);
            if(written != (uint16_t)msg.len) {
                FURI_LOG_E("SdLogger", "Writer: batch write error %d/%d",
                           written, msg.len);
            } else if(!storage_file_sync(l->file)) {
                FURI_LOG_W("SdLogger", "Writer: batch sync failed");
            }
            uint32_t dur = furi_get_tick() - write_start;
            if(dur > l->flush_dur_ms) l->flush_dur_ms = dur;
        }

        if(msg.close_file) {
            storage_file_close(l->file);
            storage_file_free(l->file);
            SdWriteAck ack = {.buf_index = 0, .closed = true};
            furi_message_queue_put(l->from_writer, &ack, FuriWaitForever);
        } else {
            SdWriteAck ack = {.buf_index = msg.buf_index, .closed = false};
            furi_message_queue_put(l->from_writer, &ack, FuriWaitForever);
        }
    }
    return 0;
}

SdLogger* sd_logger_alloc(Storage* storage) {
    furi_check(storage, "SdLogger: NULL storage in alloc()");
    SdLogger* l = malloc(sizeof(SdLogger));
    furi_check(l, "SdLogger: NULL logger alloc");
    *l = (SdLogger){.storage = storage};
    l->buf_free[0] = true;
    l->buf_free[1] = true;

    // Depth 2 on both: the double-buffering invariant (sd_logger_batch_flush()
    // never hands off a new buffer until the other is confirmed free) means
    // at most one message is ever really in flight at a time — this is
    // headroom, not a requirement, and cheap (each message is a few bytes).
    l->to_writer = furi_message_queue_alloc(2, sizeof(SdWriteMsg));
    l->from_writer = furi_message_queue_alloc(2, sizeof(SdWriteAck));
    furi_check(l->to_writer && l->from_writer, "SdLogger: queue alloc failed");

    l->writer = furi_thread_alloc();
    furi_thread_set_name(l->writer, "SdLoggerWriter");
    furi_thread_set_stack_size(l->writer, 2048); // matches GsrSensor's worker (modules/gsr_sensor.c)
    furi_thread_set_context(l->writer, l);
    furi_thread_set_callback(l->writer, sd_logger_writer);
    furi_thread_start(l->writer);

    return l;
}

void sd_logger_free(SdLogger* l) {
    furi_check(l, "SdLogger: NULL in free()");
    if(l->recording_active) sd_logger_stop(l);

    SdWriteMsg shutdown = {.buf_index = -1, .len = 0, .close_file = false};
    furi_message_queue_put(l->to_writer, &shutdown, FuriWaitForever);
    furi_thread_join(l->writer);
    furi_thread_free(l->writer);
    furi_message_queue_free(l->to_writer);
    furi_message_queue_free(l->from_writer);

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
        FURI_LOG_W("SdLogger", "All %d slots used — wrapping to 001", LOGGER_MAX_INDEX);
        next_idx = 1;
    }
    l->last_index = next_idx;
    return next_idx;
}

// Open (or create) the next auto-indexed CSV file and write a header row.
// Returns true on success; on failure the logger is left inactive with no
// open file handle. Runs entirely on the calling (main) thread — a
// one-time-per-recording cost, not the steady-state concern the writer
// thread above exists for (see this file's banner comment).
static bool open_log_file(SdLogger* l, const char* header) {
    int idx = find_next_index(l);
    snprintf(l->filename, sizeof(l->filename), LOGGER_BASENAME "%03d" LOGGER_EXT, idx);
    char full_path[96];
    snprintf(full_path, sizeof(full_path), EXT_PATH(LOGGER_DIR "/%s"), l->filename);

    l->file = storage_file_alloc(l->storage);
    if(!l->file || !storage_file_open(l->file, full_path, FSAM_WRITE, FSOM_CREATE_ALWAYS)) {
        FURI_LOG_E("SdLogger", "Failed to open %s", full_path);
        if(l->file) { storage_file_free(l->file); l->file = NULL; }
        l->filename[0] = '\0';
        return false;
    }

    size_t hlen = strlen(header);
    uint16_t written = storage_file_write(l->file, header, hlen);
    if(written != hlen) {
        FURI_LOG_E("SdLogger", "Header write failed (%d/%d)", written, (int)hlen);
        storage_file_close(l->file);
        storage_file_free(l->file);
        l->file = NULL;
        l->filename[0] = '\0';
        return false;
    }
    // Sync immediately, same reasoning as the writer thread's batch sync: a
    // "successful" storage_file_write() only means FatFs accepted the
    // bytes into its cache, not that they reached physical media.
    bool header_synced = storage_file_sync(l->file);
    if(!header_synced) {
        FURI_LOG_W("SdLogger", "Header sync failed (written, not yet confirmed durable)");
    }

    l->cur_buf = 0;
    l->gsr_batch_len[0] = 0;
    l->gsr_batch_len[1] = 0;
    l->buf_free[0] = true;
    l->buf_free[1] = true;

    l->recording_active = true;
    FURI_LOG_I("SdLogger", "Recording to %s", full_path);
    return true;
}

bool sd_logger_start(SdLogger* l, const char* header) {
    furi_check(l, "SdLogger: NULL in start()");
    furi_check(!l->recording_active, "SdLogger: already active in start()");
    return open_log_file(l, header);
}

void sd_logger_stop(SdLogger* l) {
    furi_check(l, "SdLogger: NULL in stop()");
    if(!l->file) return;

    // Hand off whatever's left in the buffer currently being filled, and
    // tell the writer to close the file right after — one combined
    // message so nothing can be appended in between the two. The writer
    // thread itself stays alive afterward, blocked on to_writer, ready
    // for a future sd_logger_start() within the same session (see this
    // file's banner) — only sd_logger_free() actually ends it.
    SdWriteMsg msg = {
        .buf_index  = l->cur_buf,
        .len        = l->gsr_batch_len[l->cur_buf],
        .close_file = true,
    };
    furi_message_queue_put(l->to_writer, &msg, FuriWaitForever);

    // Wait for the close confirmation. May need to drain one stale
    // "buffer done" ack from an earlier ordinary flush first — the queue
    // is FIFO and this close message was enqueued last, so the closed
    // ack is guaranteed to be the last one the writer ever sends for
    // this file.
    SdWriteAck ack;
    do {
        furi_message_queue_get(l->from_writer, &ack, FuriWaitForever);
    } while(!ack.closed);

    l->file = NULL;
    l->recording_active = false;
    FURI_LOG_I("SdLogger", "Stopped %s", l->filename);
}

// Hand the current batch buffer off to the writer thread and return
// immediately — see this file's banner comment for the full design.
// Returns: >0 bytes handed off, 0 if the buffer was empty or the flush
// was skipped (writer still busy with the other buffer).
int sd_logger_batch_flush(SdLogger* l) {
    furi_check(l, "SdLogger: NULL in batch_flush()");
    if(!l->recording_active || !l->file) return 0;
    if(l->gsr_batch_len[l->cur_buf] == 0) return 0;

    // Drain any pending "buffer done" acks (non-blocking) so a buffer the
    // writer has since finished with becomes available for reuse.
    SdWriteAck ack;
    while(furi_message_queue_get(l->from_writer, &ack, 0) == FuriStatusOk) {
        if(!ack.closed) l->buf_free[ack.buf_index] = true;
    }

    int other = 1 - l->cur_buf;
    if(!l->buf_free[other]) {
        // Writer thread hasn't finished the other buffer yet — can't
        // swap. Data stays where it is; this flush attempt is simply
        // retried next time. Same "some data-loss risk under duress" the
        // existing overflow path (sd_logger_batch_append/_printf
        // rejecting a row when gsr_batch[] itself is full) already
        // accepts, not a new category of risk.
        FURI_LOG_W("SdLogger", "Flush skipped — writer thread still busy");
        return 0;
    }

    int flushed = l->gsr_batch_len[l->cur_buf];
    SdWriteMsg msg = {.buf_index = l->cur_buf, .len = flushed, .close_file = false};
    l->buf_free[l->cur_buf] = false;
    furi_message_queue_put(l->to_writer, &msg, FuriWaitForever);

    l->cur_buf = other;
    l->gsr_batch_len[l->cur_buf] = 0;
    return flushed;
}

// Append a pre-formatted row to the currently-active batch buffer.
// Returns false on overflow (data not appended, caller should log/drop).
bool sd_logger_batch_append(SdLogger* l, const char* data, size_t len) {
    furi_check(l, "SdLogger: NULL in batch_append()");
    if(len == 0) return true;
    int buf = l->cur_buf;
    if(l->gsr_batch_len[buf] + (int)len > (int)sizeof(l->gsr_batch[buf])) {
        FURI_LOG_W("SdLogger", "Batch overflow (%d + %d > %d)",
                   l->gsr_batch_len[buf], (int)len, (int)sizeof(l->gsr_batch[buf]));
        return false;
    }
    memcpy(l->gsr_batch[buf] + l->gsr_batch_len[buf], data, len);
    l->gsr_batch_len[buf] += (int)len;
    return true;
}

// Format a row directly into the currently-active batch buffer, avoiding
// an intermediate stack buffer and the memcpy sd_logger_batch_append
// would require.
// Returns bytes written to the buffer, or 0 on overflow/error.
int sd_logger_batch_printf(SdLogger* l, const char* fmt, ...) {
    furi_check(l, "SdLogger: NULL in batch_printf()");
    if(!l->recording_active) return 0;

    int buf = l->cur_buf;
    int remaining = (int)sizeof(l->gsr_batch[buf]) - l->gsr_batch_len[buf];
    if(remaining <= 0) {
        FURI_LOG_W("SdLogger", "Batch printf overflow (buffer full)");
        return 0;
    }

    va_list args;
    va_start(args, fmt);
    int n = vsnprintf(l->gsr_batch[buf] + l->gsr_batch_len[buf],
                      (size_t)remaining, fmt, args);
    va_end(args);

    if(n <= 0) return 0;
    if(n >= remaining) {
        // vsnprintf truncated the row: it wrote only `remaining - 1` bytes
        // of real content (plus a NUL) into the buffer. Do NOT advance
        // gsr_batch_len past the last complete row — doing so would leave
        // a truncated/corrupt partial row in the buffer that the next
        // sd_logger_batch_flush() would hand to the writer thread as-is,
        // corrupting the CSV. Roll back and let the caller's overflow
        // path (emergency flush) start the row fresh in a cleared buffer.
        FURI_LOG_W("SdLogger", "Batch printf truncated (%d >= %d) — row discarded",
                   n, remaining);
        return 0;
    }
    l->gsr_batch_len[buf] += n;
    return n;
}

const char* sd_logger_get_filename(const SdLogger* l) { return l->filename; }

uint32_t sd_logger_get_flush_dur_ms(const SdLogger* l) { return l->flush_dur_ms; }

uint32_t sd_logger_get_stack_space(const SdLogger* l) {
    furi_check(l, "SdLogger: NULL in get_stack_space()");
    // Same furi_thread_get_stack_space(FuriThreadId)-not-FuriThread*
    // fix already applied in gsr_sensor_get_stack_space() (modules/gsr_sensor.c)
    // — furi_thread_get_id() is the RTOS handle this call actually wants.
    FuriThreadId id = furi_thread_get_id(l->writer);
    if(!id) return 0;
    return furi_thread_get_stack_space(id);
}
