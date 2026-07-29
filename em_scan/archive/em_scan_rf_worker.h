#pragma once

// em_scan_rf_worker.h — dedicated background thread for long-park RF
// sampling.
//
// Why a separate thread rather than the main tick loop: em_scan_rf_park_band()
// can be told to sit tuned to one band for hundreds of ms, far longer than
// the ~22ms the main 100ms-tick loop can afford without freezing the
// UI/GPS. Running it here instead means the main thread never blocks on
// it, and a much longer per-band dwell means a better chance of catching a
// short pulse that a brief dwell would simply miss the timing of.
//
// This thread does exactly that and nothing else: round-robin through
// EM_SCAN_NUM_FREQS bands, park on each, keep a decaying peak-hold per
// band, and hand the results back through em_scan_rf_worker_get_snapshot()
// in the same shape em_scan.c's rssi_dbm/peak_hold_dbm arrays already
// use — the UI renderer and CSV logger need no changes beyond reading from
// here instead of a per-tick em_scan_rf_dwell_band() call.
//
// Why a dedicated 3rd thread rather than interleaving into an existing
// worker (per em_scan_worker_integration_plan.md's original proposal to
// interleave into GsrSensorWorker): em_scan is deliberately being kept
// standalone from the rest of BioMapping for now (see project memory), so
// this thread lives entirely inside the em_scan app with no GSR
// involvement yet. When/if this gets folded into BioMapping proper, GSR's
// thread must be given strictly higher FuriThreadPriority than this one so
// the scheduler — not hope — guarantees GSR is never starved; that's not
// this thread's concern today since there's no GSR thread in this app to
// protect, but the priority is set defensively low regardless so the
// pattern already matches what integration will require.
//
// Thread safety: all shared state is behind an internal mutex. Callers on
// the main thread should only touch an EmScanRfWorker through the
// functions below — never reach into its internals directly.

#include "em_scan_rf.h"

#include <stdbool.h>
#include <stdint.h>

typedef struct EmScanRfWorker EmScanRfWorker;

// park_ms is how long the radio parks on each band before hopping to the
// next (see em_scan_rf.h's em_scan_rf_park_band) — this is the actual
// "dwell time" knob.
EmScanRfWorker* em_scan_rf_worker_alloc(uint32_t park_ms);

// Stops the thread (if running) and frees everything, including joining
// the underlying FuriThread. Safe to call even if never started.
void em_scan_rf_worker_free(EmScanRfWorker* w);

// Starts the background thread. Must not be called while already running.
// Only call this while the radio is otherwise idle — the worker and
// em_scan_rf_dwell_band() (used by the main tick loop for calibration/menu
// modes) both drive the same physical CC1101 and must never run at the
// same time. em_scan.c is responsible for that mutual exclusion via mode
// gating.
void em_scan_rf_worker_start(EmScanRfWorker* w);

// Stops the thread and joins it (blocks briefly — at most one park_ms
// cycle — until the worker finishes its current park and exits cleanly).
// Safe to call even if not running.
void em_scan_rf_worker_stop(EmScanRfWorker* w);

// Copies the current per-band RSSI array out for the UI/CSV logger to consume.
void em_scan_rf_worker_get_snapshot(
    EmScanRfWorker* w,
    float*          out_rssi_dbm);


// Remaining free stack space (bytes) on the worker's own thread, via
// furi_thread_get_stack_space() — see the 2048B->3072B bump above, which
// was a safety-margin guess, never confirmed against a real measurement.
// Returns 0 if the thread isn't running (w->thread == NULL).
uint32_t em_scan_rf_worker_get_stack_space(EmScanRfWorker* w);

