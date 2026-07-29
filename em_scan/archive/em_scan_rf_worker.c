// em_scan_rf_worker.c — background RF park/scan thread. See em_scan_rf_worker.h.

#include "em_scan_rf_worker.h"

#include <furi.h>
#include <stdlib.h>
#include <string.h>

// Peak-hold decay, expressed as a real-time rate rather than a fixed
// per-cycle step: the old tick-bound dwell decayed 0.1dB every 100ms tick
// (EM_SCAN_PEAK_DECAY_DB_PER_TICK in em_scan.c) = 1.0 dB/second. This
// worker only touches a given band once per full EM_SCAN_NUM_FREQS-band
// rotation, not once per 100ms, so matching that same real-time decay
// speed means decaying further per visit the longer park_ms (and thus the
// rotation period) is — computed in the loop below, not a flat constant,
// specifically so the peak-hold dots feel exactly as responsive as they
// did before this thread existed rather than getting stickier as a side
// effect of a longer park time.
#define EM_SCAN_WORKER_TARGET_DECAY_DB_PER_SEC 1.0f

// Initial value before the first real park completes for a band — matches
// em_scan.c's own EM_SCAN_RSSI_FLOOR default used for the same purpose on
// app init, kept as a separate local literal rather than shared since this
// worker stays decoupled from em_scan.c's internals (see em_scan_rf_worker.h).
#define EM_SCAN_RF_WORKER_DEFAULT_DBM -100.0f

struct EmScanRfWorker {
    FuriMutex*  mutex;
    FuriThread* thread;
    volatile bool running;

    uint32_t park_ms;

    float rssi_dbm[EM_SCAN_NUM_FREQS];
    float peak_hold_dbm[EM_SCAN_NUM_FREQS];
};

static int32_t em_scan_rf_worker_thread_fn(void* context) {
    EmScanRfWorker* w = context;
    int band = 0;

    while(true) {
        furi_mutex_acquire(w->mutex, FuriWaitForever);
        bool     should_run = w->running;
        uint32_t park_ms = w->park_ms;
        furi_mutex_release(w->mutex);
        if(!should_run) break;

        float    peak, mean;
        uint32_t n;
        em_scan_rf_park_band(band, park_ms, &peak, &mean, &n);
        UNUSED(mean);
        UNUSED(n);

        float decay_per_visit =
            EM_SCAN_WORKER_TARGET_DECAY_DB_PER_SEC * ((float)EM_SCAN_NUM_FREQS * (float)park_ms / 1000.0f);

        furi_mutex_acquire(w->mutex, FuriWaitForever);
        w->rssi_dbm[band] = peak;
        if(peak > w->peak_hold_dbm[band]) {
            w->peak_hold_dbm[band] = peak;
        } else {
            w->peak_hold_dbm[band] -= decay_per_visit;
            if(w->peak_hold_dbm[band] < peak) w->peak_hold_dbm[band] = peak;
        }
        furi_mutex_release(w->mutex);

        band = (band + 1) % EM_SCAN_NUM_FREQS;
    }

    return 0;
}

EmScanRfWorker* em_scan_rf_worker_alloc(uint32_t park_ms) {
    EmScanRfWorker* w = malloc(sizeof(EmScanRfWorker));
    // furi_check, not furi_assert: this app's own build defines
    // FURI_NDEBUG (confirmed via .vscode/compile_commands.json), so
    // furi_assert() compiles to a no-op here — it would never actually
    // check anything on a real device. furi_check() is unconditional
    // regardless of build type. Promoted throughout this file
    // (2026-07-29) as part of the ongoing crash investigation — see
    // em_scan_rf_crash_investigation.md. These conditions should never
    // fail under correct operation, so this costs nothing on the success
    // path; if one ever does fail, a descriptive message here beats
    // silently continuing with a NULL/corrupted pointer.
    furi_check(w, "EmScanRfWorker: alloc failed");
    *w = (EmScanRfWorker){
        .mutex = furi_mutex_alloc(FuriMutexTypeNormal),
        .park_ms = park_ms,
    };
    // Never checked before this pass — matches the same alloc-failure
    // check gsr_sensor.c already had for its own mutex.
    furi_check(w->mutex, "EmScanRfWorker: mutex alloc failed");
    for(int i = 0; i < EM_SCAN_NUM_FREQS; i++) {
        w->rssi_dbm[i] = EM_SCAN_RF_WORKER_DEFAULT_DBM;
        w->peak_hold_dbm[i] = EM_SCAN_RF_WORKER_DEFAULT_DBM;
    }
    return w;
}

void em_scan_rf_worker_free(EmScanRfWorker* w) {
    if(!w) return;
    em_scan_rf_worker_stop(w);
    furi_mutex_free(w->mutex);
    free(w);
}

void em_scan_rf_worker_start(EmScanRfWorker* w) {
    furi_check(w, "EmScanRfWorker: NULL in start()");
    furi_check(!w->thread, "EmScanRfWorker: start() called twice");

    furi_mutex_acquire(w->mutex, FuriWaitForever);
    w->running = true;
    furi_mutex_release(w->mutex);

    // 4096B — bumped again from 3072B (2026-07-29) after three more
    // "furi_check failed" crashes on one GPS+GSR+RF walk (tracks 97-99),
    // with 3072B itself only ever having been a guessed safety margin
    // (see the note this replaces — never confirmed against a real
    // measurement). Still a guess, but a cheap one: this thread does
    // nothing but call into the subghz HAL and touch a few stack floats,
    // so the extra 1KB costs nothing worth worrying about on a device
    // with plenty of RAM to spare, and this is the only new thread this
    // merge introduced. handle_second_boundary() in biomap_session.c now
    // logs furi_thread_get_stack_space() for this thread every second
    // during recording (via em_scan_rf_worker_get_stack_space()) — check
    // that on the next walk before bumping this again blindly a third
    // time.
    w->thread = furi_thread_alloc_ex("EmScanRfWorker", 4096, em_scan_rf_worker_thread_fn, w);
    // Tried Normal here on 2026-07-28 (matching GSR's own worker), to test
    // whether it would fix the RF staleness measured on real walks — see
    // "RF staleness: routes forward" in em_scan_biomap_merge_plan.md.
    // Reverted: a real walk (track 95) showed RF staleness got WORSE on
    // 2 of 3 bands (868: 21%->41% stalled >1.5s, 915: 22%->38%) despite a
    // shorter test than the Low-priority baseline (track 91), and
    // Diagnostics-mode GSR metrics showed a real cost (Dup% nearly
    // doubled, Hz sitting at/below the documented 400-500Hz baseline).
    // Failed on both fronts it was meant to help — not a trade worth
    // keeping. Low priority is deliberate: it guarantees RF can never
    // starve GSR sampling, at the cost of RF itself being starved instead
    // (the still-unresolved "RF staleness" problem — being addressed via
    // other routes, not by fighting the scheduler this way).
    furi_thread_set_priority(w->thread, FuriThreadPriorityLow);
    furi_thread_start(w->thread);
}

void em_scan_rf_worker_stop(EmScanRfWorker* w) {
    furi_check(w, "EmScanRfWorker: NULL in stop()");
    if(!w->thread) return;

    furi_mutex_acquire(w->mutex, FuriWaitForever);
    w->running = false;
    furi_mutex_release(w->mutex);

    furi_thread_join(w->thread);
    furi_thread_free(w->thread);
    w->thread = NULL;
}

void em_scan_rf_worker_get_snapshot(
    EmScanRfWorker* w,
    float*          out_rssi_dbm,
    float*          out_peak_hold_dbm) {
    // Called every tick (10Hz) from the main thread during a recording
    // session — the highest-frequency call site in this file, and
    // therefore the most likely to catch corrupted state promptly if it
    // ever occurs.
    furi_check(w, "EmScanRfWorker: NULL in get_snapshot()");
    furi_check(out_rssi_dbm, "EmScanRfWorker: NULL rssi out-param"); // rssi is always required
    furi_mutex_acquire(w->mutex, FuriWaitForever);
    memcpy(out_rssi_dbm, w->rssi_dbm, sizeof(w->rssi_dbm));
    // out_peak_hold_dbm is optional: pass NULL if only the raw RSSI is needed.
    if(out_peak_hold_dbm) {
        memcpy(out_peak_hold_dbm, w->peak_hold_dbm, sizeof(w->peak_hold_dbm));
    }
    furi_mutex_release(w->mutex);
}

uint32_t em_scan_rf_worker_get_stack_space(EmScanRfWorker* w) {
    furi_check(w, "EmScanRfWorker: NULL in get_stack_space()");
    if(!w->thread) return 0;
    // furi_thread_get_stack_space() takes a FuriThreadId (the underlying
    // RTOS handle), not a FuriThread* (Furi's own wrapper struct) — two
    // distinct pointer values. Passing w->thread directly here compiled
    // silently (FuriThreadId is void*, so any pointer converts to it with
    // no warning) but was reading the watermark of whatever w->thread
    // happens to point to as if it were a thread ID, not this thread's
    // actual stack space. furi_thread_get_id() is the real conversion.
    FuriThreadId id = furi_thread_get_id(w->thread);
    if(!id) return 0; // per furi_thread_get_id()'s doc: NULL if not running
    return furi_thread_get_stack_space(id);
}
