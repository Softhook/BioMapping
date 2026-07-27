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
    furi_assert(w);
    *w = (EmScanRfWorker){
        .mutex = furi_mutex_alloc(FuriMutexTypeNormal),
        .park_ms = park_ms,
    };
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
    furi_assert(w);
    furi_assert(!w->thread);

    furi_mutex_acquire(w->mutex, FuriWaitForever);
    w->running = true;
    furi_mutex_release(w->mutex);

    // 2048B is a guess, not a measured figure — the deepest call chain
    // (park_band -> furi_hal_subghz -> CC1101 SPI driver) hasn't been
    // profiled on real hardware. Check furi_thread_get_stack_space() on
    // this thread during hardware testing before trusting this number.
    w->thread = furi_thread_alloc_ex("EmScanRfWorker", 2048, em_scan_rf_worker_thread_fn, w);
    // TEMPORARY DIAGNOSTIC CHANGE (2026-07-27): set to Normal instead of
    // Low to test whether Low priority is why real per-band park time
    // measures ~630-670ms against a configured 300ms (see track 75
    // analysis — 300/315/434/446 all showed ~4.4-4.7s per 7-band cycle,
    // not the ~2.1s that 7x300ms predicts). There's no GSR thread in this
    // standalone build to protect from right now, so testing at Normal is
    // safe today — but if/when this integrates with BioMapping's GSR
    // worker (see em_scan_worker_integration_plan.md), this MUST go back
    // to Low (or lower than GSR's priority, whatever that ends up being)
    // so the scheduler guarantees GSR is never starved. Don't forget to
    // revisit this once the priority question is answered.
    furi_thread_set_priority(w->thread, FuriThreadPriorityNormal);
    furi_thread_start(w->thread);
}

void em_scan_rf_worker_stop(EmScanRfWorker* w) {
    furi_assert(w);
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
    furi_assert(w);
    furi_mutex_acquire(w->mutex, FuriWaitForever);
    memcpy(out_rssi_dbm, w->rssi_dbm, sizeof(w->rssi_dbm));
    memcpy(out_peak_hold_dbm, w->peak_hold_dbm, sizeof(w->peak_hold_dbm));
    furi_mutex_release(w->mutex);
}
