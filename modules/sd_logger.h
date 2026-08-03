#pragma once

// SD Logger — auto-incrementing CSV writer.
// Files: /ext/biomapping/biomap_001.csv … biomap_999.csv (wraps at 999).
// Column layout varies by mode (GSR-only / GPS+GSR / GPS+GSR+RF) — see the
// BIOMAP_CSV_COLS_* headers in biomap_config.h for the authoritative,
// currently-in-force column lists, and docs/csv_schema.md for the
// field-by-field specification.
//
// 2026-08-03 (docs/gps_rf_mutex_status.md's SD-flush investigation): the
// actual SD write/sync now happens on a dedicated background thread, not
// the caller's — sd_logger_batch_flush() hands a filled buffer off and
// returns immediately, so a slow storage_file_write()/storage_file_sync()
// (the SD card occasionally taking far longer than its usual ~20-60ms —
// see that doc's tracks 116/117/118 entries) no longer blocks whichever
// thread calls batch_flush() (the app's main Tick handler in practice).
// Deliberate trade made for this: a write/sync failure is no longer
// reported back to the caller (sd_logger_batch_flush() always returns
// >= 0 now) — the worker logs and moves on rather than the caller
// learning about it synchronously and alerting the user. See
// modules/sd_logger.c's file banner for the full design and why.

#include <storage/storage.h>
#include <stdbool.h>
#include <stdint.h>

typedef struct SdLogger SdLogger;

SdLogger* sd_logger_alloc(Storage* storage);
void      sd_logger_free(SdLogger* logger);

bool        sd_logger_start(SdLogger* logger, const char* header);
void        sd_logger_stop(SdLogger* logger);

// GSR batch write API — accumulate formatted rows in memory and flush
// to SD every FLUSH_INTERVAL seconds. The internal buffer (4096 bytes)
// holds up to 50 rows at the 10 Hz rate.
//   sd_logger_batch_append  — append a pre-formatted row (returns false on overflow)
//   sd_logger_batch_printf  — format a row directly into the batch buffer (no
//                             intermediate stack buffer).  Returns bytes written
//                             or 0 on overflow (logged internally).
//   sd_logger_batch_flush   — hand the current batch off to the background
//                             writer thread and return immediately (does NOT
//                             wait for storage_file_write()/sync() to finish).
//                             Returns >0 (bytes handed off), 0 if the buffer
//                             was empty OR the writer thread hadn't finished
//                             the other buffer yet (flush skipped this call,
//                             data stays put and is retried next time — see
//                             sd_logger.c). Never returns < 0 any more: a
//                             write/sync failure is logged by the writer
//                             thread, not reported back here.
int         sd_logger_batch_flush(SdLogger* logger);
bool        sd_logger_batch_append(SdLogger* logger, const char* data, size_t len);
int         sd_logger_batch_printf(SdLogger* logger, const char* fmt, ...);

const char* sd_logger_get_filename(const SdLogger* logger);

// Worst single storage_file_write()+storage_file_sync() real duration
// (furi_get_tick() delta) the writer thread has ever seen, in ms.
// Lifetime max, never reset. Added 2026-08-03 alongside the writer thread
// itself: moving the write/sync off the caller's thread fixed the freeze,
// but it also meant nothing could tell whether the SD card was still
// occasionally stalling — just now invisibly, off the critical path — or
// had genuinely stopped. This answers that directly. Intended for the
// same once-a-second FURI_LOG heartbeat gsr_sensor_get_stack_space() below
// already feeds (biomap_session.c's handle_second_boundary()), not a CSV
// column — see docs/gps_rf_mutex_status.md.
uint32_t sd_logger_get_flush_dur_ms(const SdLogger* logger);

// Remaining free stack space (bytes) on the writer thread's own thread,
// via furi_thread_get_stack_space() — same diagnostic
// gsr_sensor_get_stack_space() (modules/gsr_sensor.h) already provides for
// GsrSensor's worker, added here for the same reason: the writer thread's
// stack size (2048 bytes, sd_logger.c) was picked to match GsrSensor's
// worker by precedent, not by measuring storage_file_write()/sync()'s
// actual stack depth, and the host test harness can't catch a real
// overflow (its FuriThread shim doesn't enforce stack_size at all — a
// real pthread's stack is orders of magnitude bigger). This is the
// on-device signal that would.
uint32_t sd_logger_get_stack_space(const SdLogger* logger);
