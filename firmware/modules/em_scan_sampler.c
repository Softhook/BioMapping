// em_scan_sampler.c — paced CC1101 RSSI sampling on the GSR worker thread.
// See em_scan_sampler.h for how it plugs into gsr_sensor.c.

#include "em_scan_sampler.h"
#include <furi.h>
#include <stdlib.h>
#include <string.h>
#include <stdatomic.h>

// Paces sampling to ~10 Hz instead of every GSR loop pass (~1-2 ms) — the
// radio doesn't need anywhere near that resolution, and every
// furi_hal_subghz_* call is exposure to the unbounded SPI busy-wait bug in
// furi_hal_spi_bus_end_txrx() (no timeout). Cutting call frequency ~50-100x
// is the only mitigation available from app code for that bug — reducing
// exposure, not fixing it.
#define EM_SCAN_SAMPLE_INTERVAL_MS 100

// How long set_enabled(false) waits for an in-flight sweep to finish
// before deferring the power-down. A normal fast sweep is
// 3 × (retune + EM_SCAN_WARMUP_MS), ~15 ms, and furi_delay_ms() routinely
// overshoots — the timeout sits well above that so an ordinary sweep never
// trips it.
#define EM_SCAN_DISABLE_SPI_WAIT_TIMEOUT_MS 100
#define EM_SCAN_DISABLE_SPI_WAIT_POLL_MS     1

struct EmScanSampler {
    // Written by the main thread (set_enabled), read by the worker on every
    // poll. No mutex for the plain read: the worst case of the worker seeing
    // it one pass late is sampling starting or stopping one pass late, not
    // corrupted state. Guarding it would make every GSR loop pass take
    // `mutex` just to check a flag. _Atomic rather than volatile so
    // ThreadSanitizer sees a synchronised access; it compiles to the same
    // instruction on both host and ARM.
    _Atomic bool enabled;

    // True for exactly the span of the worker's sweep (the only SPI
    // traffic), so it doubles as "is the worker inside a radio hardware
    // call right now". set_enabled(false) polls this before calling
    // em_scan_rf_deinit(), so the deinit never races an in-flight sweep on
    // the same CC1101. _Atomic for the same reason as `enabled`.
    _Atomic bool spi_busy;

    // Main thread only. Set when a disable timed out with the worker still
    // inside a sweep, so em_scan_rf_deinit() was skipped rather than raced;
    // em_scan_sampler_free() does it once the worker thread has been joined.
    bool deinit_pending;

    uint32_t last_sample_tick; // worker (under `mutex`) and set_enabled(true) — paces to ~10 Hz
    uint32_t sample_ticks;     // EM_SCAN_SAMPLE_INTERVAL_MS in ticks, fixed at alloc

    // Published to other threads, guarded by `mutex`.
    float    rssi_dbm[EM_SCAN_NUM_FREQS];
    uint32_t rssi_peak_ms;   // whole fast-sweep call (retune + settle + RSSI reads)
    uint32_t retune_peak_ms; // worst single per-band retune step within a sweep

    FuriMutex* mutex;
};

static void reset_snapshot(EmScanSampler* s) {
    furi_mutex_acquire(s->mutex, FuriWaitForever);
    for(int i = 0; i < EM_SCAN_NUM_FREQS; i++) {
        s->rssi_dbm[i] = -100.0f;
    }
    furi_mutex_release(s->mutex);
}

EmScanSampler* em_scan_sampler_alloc(void) {
    EmScanSampler* s = malloc(sizeof(EmScanSampler));
    furi_check(s, "EmScanSampler: alloc failed");
    s->enabled = false;
    s->spi_busy = false;
    s->deinit_pending = false;
    s->last_sample_tick = 0;
    s->sample_ticks = (EM_SCAN_SAMPLE_INTERVAL_MS * furi_kernel_get_tick_frequency()) / 1000;
    for(int i = 0; i < EM_SCAN_NUM_FREQS; i++) {
        s->rssi_dbm[i] = -100.0f;
    }
    s->rssi_peak_ms = 0;
    s->retune_peak_ms = 0;
    s->mutex = furi_mutex_alloc(FuriMutexTypeNormal);
    furi_check(s->mutex, "EmScanSampler: mutex alloc failed");
    return s;
}

void em_scan_sampler_free(EmScanSampler* s) {
    furi_check(s, "EmScanSampler: NULL in free()");
    // The worker thread is gone by now (see em_scan_sampler.h), so the
    // disable path finds spi_busy false and powers down straight away.
    if(s->enabled) em_scan_sampler_set_enabled(s, false);
    if(s->deinit_pending) em_scan_rf_deinit();
    furi_mutex_free(s->mutex);
    free(s);
}

// Runs on the GSR worker thread, once per loop pass.
//
// No lock is held across the sweep itself — only around the decide-and-
// mark step and the publish afterwards, each a handful of field writes.
//
// The decide-and-mark step (checking `enabled` and the pacing gate, up to
// and including setting spi_busy) runs under `mutex`, not as two separate
// atomic operations, so that set_enabled(false)'s own acquire/release of
// `mutex` lands either fully before or fully after it. Otherwise there is
// a gap: the worker could read enabled == true, be preempted before
// setting spi_busy, and the disable path could see spi_busy == false and
// power the radio down in exactly that window. Each flag being atomic on
// its own doesn't close this — the gap is between the two operations.
void em_scan_sampler_poll(void* ctx) {
    EmScanSampler* s = ctx;
    if(!s->enabled) return;

    uint32_t now_tick = furi_get_tick();

    furi_mutex_acquire(s->mutex, FuriWaitForever);
    bool should_sample = s->enabled && (now_tick - s->last_sample_tick >= s->sample_ticks);
    if(should_sample) {
        s->last_sample_tick = now_tick;
        s->spi_busy = true;
    }
    furi_mutex_release(s->mutex);

    if(!should_sample) return;

    float    snapshot[EM_SCAN_NUM_FREQS];
    uint32_t retune_dur = 0;
    uint32_t sweep_start = furi_get_tick();
    em_scan_rf_fast_sweep_snapshot(snapshot, &retune_dur);
    uint32_t sweep_dur = furi_get_tick() - sweep_start;

    furi_mutex_acquire(s->mutex, FuriWaitForever);
    for(int b = 0; b < EM_SCAN_NUM_FREQS; b++) {
        s->rssi_dbm[b] = snapshot[b];
    }
    if(sweep_dur > s->rssi_peak_ms) s->rssi_peak_ms = sweep_dur;
    if(retune_dur > s->retune_peak_ms) s->retune_peak_ms = retune_dur;
    furi_mutex_release(s->mutex);

    s->spi_busy = false; // SPI region ends here
}

// Enable/disable ordering matters — this function and the worker thread
// both touch the same CC1101 over SPI, and SPI transactions can't overlap
// between threads.
//
// Enable: all hardware init and state reset happen BEFORE `enabled` flips
// true, so the worker never sees "on" until setup is actually done.
//
// Disable: `enabled` flips false FIRST (the worker stops starting sweeps on
// its next pass), THEN this polls spi_busy — true for exactly the span of a
// sweep — before calling the hardware deinit. So deinit only runs once the
// worker has demonstrably left the SPI region, rather than after a fixed
// delay chosen to probably be long enough. If the worker is unusually slow,
// the bounded timeout skips the deinit and leaves it to
// em_scan_sampler_free(), which runs after the worker has been joined. A
// skipped deinit only leaves the CC1101 idle (every sweep ends with
// furi_hal_subghz_idle()), not in RX. A worker wedged for good (e.g. the
// unbounded SPI busy-wait in furi_hal_spi_bus_end_txrx()) still hangs
// gsr_sensor_free()'s join — no timeout here can fix that.
//
// Known gap: after a disable that timed out (deinit_pending), an immediate
// re-enable calls em_scan_rf_init() without waiting for spi_busy, so it
// could overlap the sweep still in flight. The app never does this today —
// it only disables at session end, from em_scan_sampler_free(), after the
// worker has been joined. Waiting on spi_busy here too would close it.
void em_scan_sampler_set_enabled(EmScanSampler* s, bool enabled) {
    furi_check(s, "EmScanSampler: NULL in set_enabled()");
    if(s->enabled == enabled) return;

    if(enabled) {
        em_scan_rf_init();
        s->deinit_pending = false; // init reconfigures the radio from scratch
        s->last_sample_tick = 0;   // force an immediate first sample
        reset_snapshot(s);
        s->enabled = true; // last — see doc comment above
        return;
    }

    s->enabled = false; // first — see doc comment above

    // Rendezvous on `mutex` before polling spi_busy: forces this thread's
    // view of spi_busy to reflect whichever decide-and-mark step (see
    // em_scan_sampler_poll()) most recently ran. Cheap — that critical
    // section is never held across a hardware call.
    furi_mutex_acquire(s->mutex, FuriWaitForever);
    furi_mutex_release(s->mutex);

    // Measured against real elapsed ticks, not a count of furi_delay_ms()
    // calls: furi_delay_ms(N) is not guaranteed to take exactly N ms (see
    // em_scan_rf.c's EM_SCAN_DWELL_MS loop), so counting calls drifts from
    // the real bound. The delay here only yields the CPU between checks.
    uint32_t start_tick = furi_get_tick();
    uint32_t timeout_ticks =
        (EM_SCAN_DISABLE_SPI_WAIT_TIMEOUT_MS * furi_kernel_get_tick_frequency()) / 1000;
    while(s->spi_busy && (furi_get_tick() - start_tick) < timeout_ticks) {
        furi_delay_ms(EM_SCAN_DISABLE_SPI_WAIT_POLL_MS);
    }
    if(s->spi_busy) {
        FURI_LOG_E("EmScanSampler", "worker still in SPI after %d ms — deferring radio deinit",
                   EM_SCAN_DISABLE_SPI_WAIT_TIMEOUT_MS);
        s->deinit_pending = true;
    } else {
        em_scan_rf_deinit();
    }

    // Don't leave the last live reading visible once the radio is off.
    reset_snapshot(s);
}

void em_scan_sampler_get_snapshot(const EmScanSampler* s, float out_rssi_dbm[EM_SCAN_NUM_FREQS]) {
    furi_check(s, "EmScanSampler: NULL in get_snapshot()");
    furi_check(out_rssi_dbm, "EmScanSampler: NULL out_rssi_dbm");
    furi_mutex_acquire(s->mutex, FuriWaitForever);
    memcpy(out_rssi_dbm, s->rssi_dbm, sizeof(s->rssi_dbm));
    furi_mutex_release(s->mutex);
}

uint32_t em_scan_sampler_get_rssi_peak_ms(const EmScanSampler* s) {
    furi_check(s, "EmScanSampler: NULL in get_rssi_peak_ms()");
    furi_mutex_acquire(s->mutex, FuriWaitForever);
    uint32_t val = s->rssi_peak_ms;
    furi_mutex_release(s->mutex);
    return val;
}

uint32_t em_scan_sampler_get_retune_peak_ms(const EmScanSampler* s) {
    furi_check(s, "EmScanSampler: NULL in get_retune_peak_ms()");
    furi_mutex_acquire(s->mutex, FuriWaitForever);
    uint32_t val = s->retune_peak_ms;
    furi_mutex_release(s->mutex);
    return val;
}
