#pragma once

// em_scan_sampler.h — paced CC1101 RSSI sampling, run on the GSR worker
// thread's spare time.
//
// Owns no thread of its own. gsr_sensor_alloc() is handed
// em_scan_sampler_poll() as its worker hook, so the radio sweep runs on the
// GSR worker thread, once per loop pass, after the ADC read. On a device
// without the radio, nothing is handed over and the GSR loop has no radio
// code in it at all.
//
// Lifetime: the sampler must outlive the GsrSensor that calls it. Free the
// GsrSensor first (which joins its worker thread), then the sampler.
//
// Thread safety: one internal mutex guards only the published RSSI
// snapshot and the peak-duration figures, and is never held across a
// furi_hal_subghz_* call — only to copy a few numbers in or out. It is
// separate from the GSR sensor's own mutex, so a radio SPI stall can never
// block ADC sampling (a single shared mutex once caused a GPS-quality
// regression, traced to the radio's SPI retune running inside the lock the
// main thread needed every tick). Like gsr_sensor.h, this module never
// takes app->mutex, so the getters below are safe to call while holding it.

#include <stdbool.h>
#include <stdint.h>
#include "em_scan_rf.h"

typedef struct EmScanSampler EmScanSampler;

EmScanSampler* em_scan_sampler_alloc(void);

// Turns the radio off if it is still on (or finishes a deferred power-down
// — see em_scan_sampler_set_enabled()). Call only after the GsrSensor that
// polls this sampler has been freed.
void em_scan_sampler_free(EmScanSampler* s);

// Powers the CC1101 up (true) or down (false). Main thread only; not
// reentrant with itself. Safe with respect to the worker thread — see the
// doc comment on the definition in em_scan_sampler.c for the ordering.
void em_scan_sampler_set_enabled(EmScanSampler* s, bool enabled);

// The GSR worker hook (GsrWorkerHook, flipper/gsr_sensor_flipper.h). `ctx` is the
// EmScanSampler*. Does nothing while disabled or between samples (paced to
// ~10 Hz); otherwise runs one 3-band sweep and publishes the result.
void em_scan_sampler_poll(void* ctx);

// Copies the latest 3-band RSSI snapshot (dBm). Reads -100 for every band
// while disabled.
void em_scan_sampler_get_snapshot(const EmScanSampler* s, float out_rssi_dbm[EM_SCAN_NUM_FREQS]);

// Worst whole-sweep duration ever seen (retune + settle + RSSI reads), and
// worst single per-band retune step within a sweep, in ms. Lifetime
// maxima, never reset. The sweep figure is always >= the retune figure.
// For diagnostics.
uint32_t em_scan_sampler_get_rssi_peak_ms(const EmScanSampler* s);
uint32_t em_scan_sampler_get_retune_peak_ms(const EmScanSampler* s);
