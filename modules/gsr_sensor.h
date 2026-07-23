#pragma once

// GSR Sensor — ADS1115 I2C differential reader with PGA autoranging.
//
// Auto-ranging keeps the ADC reading in [12.5 %, 91.5 %] of full scale by
// stepping the PGA gain in real time.  The tick() normalises the reading
// through the TIA circuit equation and stores the result in nanosiemens.
// gsr_sensor_get_raw() returns skin conductance in nS regardless of PGA.
// Returns 0 when the sensor is unavailable.
//
// Always probed at alloc(); gsr_sensor_available() reports success.
// Readings return 0 and tick() is a no-op if the probe fails.

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
#define GSR_VALID_MIN_NS    0.1f      // nS — below this: open circuit
#define GSR_VALID_MAX_NS    75000.0f  // nS — above this: rail saturation

typedef struct GsrSensor GsrSensor;

// Lifecycle
GsrSensor* gsr_sensor_alloc(void);
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
// see docs/gsr_filtering_analysis.md), autoranging, and TIA circuit
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
// immediately preceding read. This can mean either a stale re-read or
// two fresh conversions of a signal that just hasn't moved between them
// — it can't tell those apart. Measured on real hardware (2026-07-23):
// ~7-11% with a live signal connected, ~12-16% disconnected (open
// circuit, near-DC, no real signal to vary) — both well above the near-0%
// this comment used to predict for worker rates below the ADS1115's
// 860 SPS ceiling. See docs/gsr_filtering_analysis.md and
// gsr_sensor.c's duplicate_count doc comment for what's still
// unexplained.  For diagnostics.
float gsr_sensor_get_duplicate_rate(const GsrSensor* gsr);

// Live count of consecutive failed I2C reads happening right now — not a
// rolling average like get_success_rate(), so it shows a fresh failure
// streak building in real time, before either the 1 s success-rate
// average visibly drops or the 50-failure disconnect threshold actually
// fires.  For diagnostics.
uint32_t gsr_sensor_get_consecutive_failures(const GsrSensor* gsr);

// Peak-to-peak (max - min) of the raw normalised counts in the most
// recent tick()'s averaging window.  A cheap, frequency-agnostic sense
// of instantaneous signal/noise range.  For diagnostics.
int32_t gsr_sensor_get_window_ptp(const GsrSensor* gsr);

// Smallest gap (RTOS ticks, ~1 ms each) between two consecutive samples'
// timestamps in the most recent window.  A value of 0 means two samples
// landed in the same millisecond — evidence the worker loop is, at least
// sometimes, running faster than a cleanly-paced ~2 ms period would
// allow, plausibly explaining the duplicate-rate finding in
// get_duplicate_rate()'s doc comment.  1 ms resolution can't resolve
// finer than that.  For diagnostics.
uint32_t gsr_sensor_get_window_min_gap_ticks(const GsrSensor* gsr);

// Recovered amplitude (normalised-count units) at 50 Hz, from a direct
// correlation against each raw sample's actual recorded timestamp (not
// an assumed uniform rate) in the most recent window — a real, measured
// answer to "how much mains-hum energy is actually present", as opposed
// to the boxcar notch's rejection itself, which is a guaranteed property
// of window duration and isn't separately measurable post-averaging.
// NOTE: an earlier Goertzel-filter version of this (fixed coefficient
// from get_worker_hz(), assuming uniform sample spacing) measured a
// physically impossible result on real hardware (2026-07-23) — 103
// counts of "50 Hz content" against a window whose total peak-to-peak
// was only 40 — because real sample timing is measurably uneven
// (get_window_min_gap_ticks()) and Goertzel's resonant recurrence
// amplifies that into inflated energy. This version has no such failure
// mode. See docs/gsr_filtering_analysis.md.  Reads 0.0f only if
// unavailable — meaningful from the first tick.  For diagnostics.
float gsr_sensor_get_mains_hum_mag(const GsrSensor* gsr);

// Number of PGA (autorange) changes applied in the most recent rolling
// ~1 s window — same cadence as get_worker_hz().  Only counts automatic
// autoranging changes, not manual gsr_sensor_lock_pga() calls, so a
// nonzero value signals the input sitting near an autorange threshold
// and flapping between ranges.  For diagnostics.
uint32_t gsr_sensor_get_pga_change_count(const GsrSensor* gsr);

// Update calibration parameters (thread-safe).  When active is true,
// the raw counts are scaled by gain and offset-shifted before conductance conversion.
void gsr_sensor_set_calibration(GsrSensor* gsr, bool active, float gain, float offset);

// Lock PGA at a fixed index (0–5) to disable autoranging.  Pass -1 to unlock
// and resume normal autoranging.  When locked, tick() still runs the ~100 ms
// window mean but skips the PGA-switching decision.  Useful for hardware diagnostics.
void gsr_sensor_lock_pga(GsrSensor* gsr, int8_t index);
