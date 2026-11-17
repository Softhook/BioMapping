#pragma once

// GSR Sensor — ADS1115 I2C differential reader with PGA autoranging.
//
// Owns one background FuriThread ("GsrSensorWorker") that samples the ADC
// at up to 860 SPS into a ring buffer. The thread can also host one other
// job through an optional worker hook (GsrWorkerHook below). On the
// Flipper that job is the radio scan (em_scan_sampler.h), which shares
// this thread rather than spawning a second one. Without a hook the loop
// is GSR only.
//
// Auto-ranging keeps the ADC reading in [12.5 %, 91.5 %] of full scale by
// stepping the PGA gain in real time. The tick() normalises the reading
// through the TIA circuit equation and stores the result in nanosiemens.
// gsr_sensor_get_raw() returns skin conductance in nS regardless of PGA.
// Returns 0 when the sensor is unavailable.
//
// Always probed at alloc(); gsr_sensor_available() reports success.
// Readings return 0 and tick() is a no-op if the probe fails.
//
// Thread safety / lock ordering: one internal mutex, private to GsrSensor
// in gsr_sensor.c, guards the ADC ring buffer, PGA/calibration state, and
// diagnostics counters. It is never held across a furi_hal_i2c_* call or
// across the worker hook — it only ever guards in-memory fields, copied
// in/out. The hook's own state has its own lock (see em_scan_sampler.h),
// so a slow radio call can never block ADC readers.
//
// Safe to call any accessor below from a caller that is ALREADY holding
// BioMapApp's app->mutex (biomap_render_callback and the tick handler in
// biomap_session.c both do exactly this). That's safe specifically because
// this module never acquires app->mutex itself — it doesn't even hold a
// reference to BioMapApp — so the lock order is always app->mutex-then-
// GsrSensor's-internal-mutex, never the reverse. Do not add any call from
// inside this module (or gsr_sensor_worker's background thread) back into
// app->mutex; that would create the opposite ordering and open up a
// deadlock between the two. The same rule applies to the worker hook.
// (Contrast with gps_uart.h's rule, which is the
// opposite kind of caution for a different reason — bounding how long
// app->mutex stays held during NMEA parsing, not lock ordering.)

#include <stdbool.h>
#include <stdint.h>

// ADS1115 I2C address (ADDR pin → GND → 0x48)
#define ADS1115_I2C_ADDR    (0x48 << 1)
#define ADS1115_CONV_REG    0x00

// Ring buffer size for background sampling (MUST be a power of two —
// the worker uses & (SENSOR_BUFFER_SIZE - 1) for fast wraparound).
#define SENSOR_BUFFER_SIZE  128

// Physiological skin conductance validity range (nanosiemens).
// Used by gsr_sensor.c (disconnect debounce) and biomap_session.c
// (per-tick validity gate).  Define here so both users stay in sync.
//
//   Below GSR_VALID_MIN_NS → open circuit  (finger cuffs not attached)
//   Above GSR_VALID_MAX_NS → rail saturation (hardware fault or short)
//
// Typical resting range: 1–20 µS = 1 000–20 000 nS.
// Literature: Boucsein 2012 reports SCL 1–50 µS as normal range.
// GSR_VALID_MIN_NS sits well above the observed open-circuit noise floor
// (~17 nS of ADC leakage with cuffs removed, gsr_tia_counts_to_ns() only clamps
// to exactly 0 at counts <= 0) and well below that 1 000 nS literature
// floor, so it can't false-trigger on genuinely dry skin.
#define GSR_VALID_MIN_NS    100.0f    // nS — below this: open circuit
#define GSR_VALID_MAX_NS    75000.0f  // nS — above this: rail saturation

// TIA conversion: normalised ADC counts (pga_index 5 scale, see
// gsr_sensor.c) → nanosiemens, from the transimpedance amplifier circuit
// equation. Clamped at 319000 counts (≈ rail saturation). Inline here
// rather than private to gsr_sensor.c so the host tests check this exact
// formula instead of a copy of it.
static inline float gsr_tia_counts_to_ns(float counts) {
    if(counts <= 0.0f) return 0.0f;
    if(counts > 319000.0f) counts = 319000.0f;
    return (counts * 5000000.0f) / (15040000.0f - counts * 47.0f);
}

typedef struct GsrSensor GsrSensor;

// Called on the worker thread once per normal loop pass, right after the
// ADC read (not on PGA-change passes). Lets another job share this thread.
// Rules for the hook:
//   - keep it short: time spent here is time the ADC isn't being read
//     (em_scan_sampler_poll() returns at once except every ~100 ms);
//   - never take app->mutex, or anything that waits on this sensor;
//   - `ctx` must stay valid until gsr_sensor_free() returns.
typedef void (*GsrWorkerHook)(void* ctx);

// Lifecycle. `hook` may be NULL (GSR only). It is fixed for the sensor's
// lifetime. The worker thread starts inside alloc(), so the hook can be
// called before alloc() returns: `ctx` must be fully set up beforehand.
GsrSensor* gsr_sensor_alloc(GsrWorkerHook hook, void* hook_ctx);
void       gsr_sensor_free(GsrSensor* gsr);

// Returns false when ADS1115 probe failed at init
bool gsr_sensor_available(const GsrSensor* gsr);

// Returns false when the sensor has been returning invalid readings
// (e.g. finger cuffs disconnected) for multiple consecutive ticks.
// Uses GSR_VALID_MIN_NS / GSR_VALID_MAX_NS thresholds for 20+ consecutive
// ticks (2+ s).  Automatically recovers when an in-range reading comes back.
bool gsr_sensor_is_connected(const GsrSensor* gsr);

// Call at 10 Hz.  Reads the ring buffer, applies ~100 ms time-windowed
// boxcar decimation (sample count varies with the worker's true rate —
// see research/gsr_filtering_analysis.md), autoranging, and TIA circuit
// equation.  Well under 1 ms even at the ADS1115's 860 SPS ceiling
// (~86 integer adds + float ops); safe at 10 Hz on Cortex-M4 @ 64 MHz.
void gsr_sensor_tick(GsrSensor* gsr);

// Skin conductance in nanosiemens (nS), computed from the TIA circuit
// equation each tick.  Returns 0.0f when sensor unavailable.
float gsr_sensor_get_raw(const GsrSensor* gsr);

// Single raw ADC sample converted directly to nanosiemens via the TIA
// equation — no decimation, no averaging, no autoranging, no calibration.
// Reads the most recent ring-buffer entry (updated at whatever rate the
// background worker is actually achieving — see gsr_sensor_get_worker_hz,
// bounded above by the ADS1115's 860 SPS conversion rate).  This is the
// "pure hardware" value: one ADS1115 conversion → normalised count → TIA → nS.
// Returns 0.0f when sensor unavailable or buffer is empty.
float gsr_sensor_get_raw_sample_ns(const GsrSensor* gsr);

// Raw normalised ADC count (pre-TIA) snapshotted from the same buffer
// position as get_raw_sample_ns.  For hardware diagnostics.
int32_t gsr_sensor_get_raw_sample_count(const GsrSensor* gsr);

// ~100 ms window mean normalised count (pre-TIA).  Compare with
// get_raw_sample_count to see single-sample vs averaged difference.
int32_t gsr_sensor_get_mean_count(const GsrSensor* gsr);

// How many ring-buffer entries were actually averaged into the most
// recent get_mean_count() result — the real, currently-in-effect sample
// count behind the boxcar mean, as opposed to get_worker_hz()'s rolling
// ~1 s trend.  Always >= 1.  For diagnostics.
int32_t gsr_sensor_get_window_samples(const GsrSensor* gsr);

// Current PGA index (0–5).  For diagnostics.
uint8_t gsr_sensor_get_pga_index(const GsrSensor* gsr);

// Measured worker-thread throughput in Hz — the real rate the background
// I2C-polling loop fills gsr_sensor_tick()'s ~100 ms averaging window
// with samples. Returns 0.0f if unavailable or if called immediately
// after alloc() (before any real time has elapsed).  For diagnostics.
float gsr_sensor_get_worker_hz(const GsrSensor* gsr);

// Percentage of I2C read attempts that succeeded (0-100), over the same
// window as gsr_sensor_get_worker_hz().  Near 100% means the Hz figure
// reflects the loop's true attempt rate; well below 100% means many
// reads are silently failing and the loop is attempting faster than the
// Hz figure alone would suggest — a transport/wiring problem, not a rate
// limit.  For diagnostics.
float gsr_sensor_get_success_rate(const GsrSensor* gsr);

// Percentage of successful reads (0-100), over the same window as
// gsr_sensor_get_worker_hz(), whose raw ADC code exactly matched the
// immediately preceding read. This can mean either a stale re-read or two
// fresh conversions of a signal that just hasn't moved between them — it
// can't tell those apart. Measured ~7-11% with a live signal connected,
// ~12-16% disconnected (open circuit, near-DC). See
// research/gsr_filtering_analysis.md and gsr_sensor.c's duplicate_count doc
// comment.  For diagnostics.
float gsr_sensor_get_duplicate_rate(const GsrSensor* gsr);

// Percentage of successful reads (0-100), over the same window as
// gsr_sensor_get_worker_hz(), whose inter-read gap was under 2 ticks
// (< 1.16 ms conversion cycle) and resulted in a stale re-read of the
// ADS1115 register before a new conversion completed.  For diagnostics.
float gsr_sensor_get_stale_rate(const GsrSensor* gsr);

// Remaining free stack space (bytes) on the worker's own thread, via
// furi_thread_get_stack_space(). Returns 0 when the sensor is unavailable
// (no thread was ever started).
uint32_t gsr_sensor_get_stack_space(const GsrSensor* gsr);

// Live count of consecutive failed I2C reads happening right now — not a
// rolling average like get_success_rate(), so it shows a fresh failure
// streak building in real time, before either the 1 s success-rate
// average visibly drops or the 50-failure disconnect threshold actually
// fires.  For diagnostics.
uint32_t gsr_sensor_get_consecutive_failures(const GsrSensor* gsr);

// Smallest inter-read tick gap seen SPECIFICALLY at a sample that turned
// out to be a duplicate (get_duplicate_rate()), over the same rolling
// ~1 s window as get_worker_hz().  Directly correlates timing with the
// reads that were actually stale.  Each timestamp is a floor() of the
// real time taken, so a reading of N ticks is consistent with a true
// minimum anywhere from ~(N-1) ms to ~(N+1) ms.  Returns UINT32_MAX if
// no duplicates occurred in the most recent window (a real value of 0 is
// itself meaningful and must stay distinguishable from "no data"), or if
// unavailable.  For diagnostics.
uint32_t gsr_sensor_get_duplicate_gap_min_ticks(const GsrSensor* gsr);

// Number of PGA (autorange) changes applied in the most recent rolling
// ~1 s window — same cadence as get_worker_hz().  A nonzero value signals
// the input sitting near an autorange threshold and flapping between
// ranges.  For diagnostics.
uint32_t gsr_sensor_get_pga_change_count(const GsrSensor* gsr);

// Update calibration parameters (thread-safe).  When active is true, the
// conductance is corrected after the TIA conversion, in the nS domain:
// nS = gain * nS + offset.
void gsr_sensor_set_calibration(GsrSensor* gsr, bool active, float gain, float offset);

// Worst single I2C call duration ever observed on the worker thread, in ms
// — a lifetime max (never reset), timed immediately around each I2C call
// with furi_get_tick(). Covers both the config-write and conversion-read
// calls (mutually exclusive per loop iteration). Answers "did an I2C call
// cause a given main-loop stall" directly — see biomap_types.h's RowDiag
// doc comment and docs/archive/gps_rf_mutex_status.md. The radio's
// matching figures are in em_scan_sampler.h. Returns 0 if unavailable.
// For diagnostics.
uint32_t gsr_sensor_get_i2c_peak_ms(const GsrSensor* gsr);
