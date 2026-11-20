#pragma once

// GSR Sensor — ADS1115 I2C differential reader with PGA autoranging.
// Shared by every device; plain C with no device code.
//
// The device runs one background thread that calls gsr_sensor_worker_pass()
// in a loop, which samples the ADC at up to 860 SPS into a ring buffer.
// Everything that touches hardware (I2C, the clock, waits, the lock) goes
// through the GsrPlatform functions the device hands to gsr_sensor_create().
// The Flipper's thread and functions are in flipper/gsr_sensor_flipper.c.
//
// Auto-ranging keeps the ADC reading in [12.5 %, 91.5 %] of full scale by
// stepping the PGA gain in real time. The tick() normalises the reading
// through the TIA circuit equation and stores the result in nanosiemens.
// gsr_sensor_get_raw() returns skin conductance in nS regardless of PGA.
// Returns 0 when the sensor is unavailable.
//
// Always probed at create(); gsr_sensor_available() reports success.
// Readings return 0 and tick() is a no-op if the probe fails.
//
// Thread safety / lock ordering: one lock, supplied by the device
// (GsrPlatform.lock/unlock) and used only by GsrSensor, guards the ADC ring
// buffer, PGA/calibration state, and diagnostics counters. It is never
// held across an I2C call or across the device's other job on the GSR
// thread (the Flipper's worker hook) — it only ever guards in-memory
// fields, copied in/out. The hook's own state has its own lock (see
// em_scan_sampler.h), so a slow radio call can never block ADC readers.
//
// Safe to call any accessor below from a caller that is ALREADY holding
// the app's own main lock (on the Flipper, BioMapApp's app->mutex: the
// render callback and the session's tick handler both do exactly this).
// That's safe specifically because this module never takes the app's
// lock — it doesn't know the app exists — so the lock order is always
// app-lock-then-GsrSensor's-lock, never the reverse. Do not add any call
// from inside this module (or the device's GSR thread, or any other job
// sharing it) back into the app's lock; that would create the opposite
// ordering and open up a deadlock between the two.

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

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

// 0.5 V bias measurement. The bias (op-amp B output, REF_0V5) is already on
// the ADS1115's AIN1, as the reference for the skin reading; it can also be
// read on its own, AIN1 against ground. No extra wiring. The skin reading is
// directly proportional to the bias, and the bias follows the 3.3 V supply
// through the 56k/10k divider, so the TIA equation uses the measured value
// instead of assuming exactly 0.5 V. Both readings come from the same ADC,
// so its internal reference cancels too. What is left is the resistors and,
// on the MCP6002 prototype, the op-amp's input offset — the calibration
// wizard's job.
//
// When it is measured: once in create(), and on request — at the start of
// each recording (biomap_session.c), before the first row, so one value
// holds for the whole file and is written to its header; when a phone
// first connects in Live Stream (logged, as the BLE packet has no room for
// it; not again on a reconnect, which continues the same track);
// and before each resistor in the calibration wizard (biomap_gui.c), which
// refuses to go on without a good reading. Never in the
// middle of a recording: a mid-recording update would put a step in the
// data, and a repeating check would leave a regular gap in the 100 ms
// averaging.
//
// A reading outside GSR_BIAS_MIN_V..GSR_BIAS_MAX_V is not used: the last
// good value (or the nominal 0.5 V if there is none) stays in use. It is
// still reported (gsr_sensor_get_bias_measured_volts()), as a health check.
// The window is wide enough for a 3.3 V supply anywhere from 2.97 V to
// 3.63 V.
#define GSR_BIAS_NOMINAL_V        0.5f
#define GSR_BIAS_MIN_V            0.45f
#define GSR_BIAS_MAX_V            0.55f

// True for a bias reading the TIA equation may use. NAN fails both
// comparisons, so a failed check is never in range.
static inline bool gsr_bias_in_range(float v) {
    return v >= GSR_BIAS_MIN_V && v <= GSR_BIAS_MAX_V;
}

// How long gsr_sensor_run_bias_check() waits. A check takes about 40–50 ms
// at the worker's real ~500 Hz (~65 ms with a radio sweep in the middle);
// this much longer means I2C trouble.
#define GSR_BIAS_CHECK_TIMEOUT_MS 200

// TIA conversion: normalised ADC counts (pga_index 5 scale, 7.8125 µV per
// unit, see gsr_sensor.c) → nanosiemens, from the transimpedance amplifier
// circuit equation, for a bias of bias_scale × 0.5 V:
//
//   V_diff = V_bias × 47 kΩ / (R_skin + 9.4 kΩ)
//   G_skin = V_diff / (V_bias × 47 kΩ − 9.4 kΩ × V_diff)
//
// which at 0.5 V and in these units is counts × 5e6 / (15 040 000 − 47 × counts).
// Clamped just below the rail-saturation count (a dead short reads
// V_diff = 5 × V_bias = 320 000 × bias_scale units). Inline here rather than
// private to gsr_sensor.c so the host tests check this exact formula
// instead of a copy of it.
static inline float gsr_tia_counts_to_ns_at_bias(float counts, float bias_scale) {
    if(counts <= 0.0f) return 0.0f;
    float max_counts = 319000.0f * bias_scale;
    if(counts > max_counts) counts = max_counts;
    return (counts * 5000000.0f) / (15040000.0f * bias_scale - counts * 47.0f);
}

// The same at exactly the nominal 0.5 V bias.
static inline float gsr_tia_counts_to_ns(float counts) {
    return gsr_tia_counts_to_ns_at_bias(counts, 1.0f);
}

typedef struct GsrSensor GsrSensor;

// ── What each device supplies ───────────────────────────────────────────
// Every function gets `ctx` back as its first argument. All are required
// except `log`.
typedef struct {
    void* ctx;
    // The lock described under "Thread safety" above. Not recursive.
    void (*lock)(void* ctx);
    void (*unlock)(void* ctx);
    // A clock in milliseconds that counts up and wraps at 2^32. The settle
    // gates, the averaging window, the worker rate and the ms read-outs
    // (I2C peak, duplicate gap) are all timed on it, so it must count in
    // real milliseconds.
    uint32_t (*now_ms)(void* ctx);
    // Wait at least `ms`. Used only by create() (the start-up bias check
    // and warm-up read) and gsr_sensor_run_bias_check(), never by the
    // worker pass.
    void (*delay_ms)(void* ctx, uint32_t ms);
    // Read or write `len` bytes of register `reg` on the chip at 7-bit
    // address `addr`, taking and releasing the shared bus around the call.
    // True on success.
    bool (*i2c_read)(void* ctx, uint8_t addr, uint8_t reg, uint8_t* data, size_t len,
                     uint32_t timeout_ms);
    bool (*i2c_write)(void* ctx, uint8_t addr, uint8_t reg, const uint8_t* data, size_t len,
                      uint32_t timeout_ms);
    // Optional (may be NULL): one log line. `warning` false is information.
    // Never called with the lock held, and never from the worker pass, so
    // a slow log (a serial link) can't hold up sampling.
    void (*log)(void* ctx, bool warning, const char* line);
} GsrPlatform;

// Probes the ADS1115, measures the bias once and sets the starting gain,
// then returns. `platform` is copied. Starts no thread: the device starts
// its GSR thread afterwards. Stops (core_fatal) if `platform` lacks a
// required function or memory runs out.
GsrSensor* gsr_sensor_create(const GsrPlatform* platform);

// Puts the ADS1115 into power-down and frees the sensor. The device must
// have stopped its GSR thread first.
void gsr_sensor_destroy(GsrSensor* gsr);

// The `ctx` given in the platform, for the device's own wrappers.
void* gsr_sensor_platform_ctx(const GsrSensor* gsr);

// One pass of the worker: a config write (gain change, bias switch-over) or
// one conversion read. The device's GSR thread calls it in a loop with a
// 1 ms pause after every pass:
//
//     while(running) {
//         if(gsr_sensor_worker_pass(gsr)) { /* other job's turn, if any */ }
//         pause 1 ms;
//     }
//
// Returns true after a normal read pass — the moment another job may share
// the thread (on the Flipper, the radio scan). Returns false after a config
// write, which skips that turn.
bool gsr_sensor_worker_pass(GsrSensor* gsr);

// Returns false when ADS1115 probe failed at create()
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
// equation — no decimation, no averaging, no autoranging, no calibration
// gain. When a calibration is active its open-circuit zero is removed
// first, so this matches what the wizard measured, before the gain.
// Reads the most recent ring-buffer entry (updated at whatever rate the
// background worker is actually achieving — see gsr_sensor_get_worker_hz,
// bounded above by the ADS1115's 860 SPS conversion rate).  This is the
// "pure hardware" value: one ADS1115 conversion → normalised count → TIA → nS.
// Returns 0.0f when sensor unavailable or buffer is empty.
float gsr_sensor_get_raw_sample_ns(const GsrSensor* gsr);

// Raw normalised ADC count (pre-TIA) snapshotted from the same buffer
// position as get_raw_sample_ns.  For hardware diagnostics.
int32_t gsr_sensor_get_raw_sample_count(const GsrSensor* gsr);

// ~100 ms window mean normalised count (pre-TIA, before the calibration
// zero is removed), rounded to the nearest count.  Compare with
// get_raw_sample_count to see single-sample vs averaged difference. The
// calibration wizard's open-circuit step averages this.
int32_t gsr_sensor_get_mean_count(const GsrSensor* gsr);

// How many ring-buffer entries were actually averaged into the most
// recent get_mean_count() result — the real, currently-in-effect sample
// count behind the boxcar mean, as opposed to get_worker_hz()'s rolling
// ~1 s trend.  Always >= 1.  For diagnostics.
int32_t gsr_sensor_get_window_samples(const GsrSensor* gsr);

// Current PGA index (0–5).  For diagnostics.
uint8_t gsr_sensor_get_pga_index(const GsrSensor* gsr);

// Most recent accepted measurement of the 0.5 V bias (AIN1 against ground),
// in volts — the value the TIA equation is using. 0.0f if no reading has
// been inside GSR_BIAS_MIN_V..GSR_BIAS_MAX_V yet, in which case the nominal
// 0.5 V is used.
float gsr_sensor_get_bias_volts(const GsrSensor* gsr);

// What the most recent bias check actually read, in volts, accepted or not
// — so an out-of-range bias is visible rather than silently replaced. NAN
// if that check failed (I2C error).
float gsr_sensor_get_bias_measured_volts(const GsrSensor* gsr);

// Bias check on request (see "When it is measured" above). The worker
// switches to the bias, averages 16 reads of it, and switches back — about
// 40–50 ms.
//   request() asks for one and returns a ticket;
//   done(ticket) is true once a check has finished after that request;
//   cancel() withdraws a request that is still pending or in progress: a
//   check that finishes after it changes nothing. Call it if done() doesn't
//   come true in time, so a late check can't change the bias mid-recording.
uint32_t gsr_sensor_request_bias_check(GsrSensor* gsr);
bool     gsr_sensor_bias_check_done(const GsrSensor* gsr, uint32_t ticket);
void     gsr_sensor_cancel_bias_check(GsrSensor* gsr);

// All three in one, for callers that can wait: asks for a check, waits up
// to timeout_ms, and cancels it if it hasn't finished by then (so a late
// one can't change the bias afterwards). Returns true if a check finished;
// gsr_sensor_get_bias_measured_volts() is then what it read (NAN on an I2C
// error). Returns false on a timeout; nothing has changed then. Blocks the
// calling thread, so don't hold a lock the GUI needs.
bool     gsr_sensor_run_bias_check(GsrSensor* gsr, uint32_t timeout_ms);

// Measured worker-thread throughput in Hz — the real rate the background
// I2C-polling loop fills gsr_sensor_tick()'s ~100 ms averaging window
// with samples. Returns 0.0f if unavailable or if called immediately
// after create() (before any real time has elapsed).  For diagnostics.
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
// gsr_sensor_get_worker_hz(), whose inter-read gap was under 2 ms
// (< 1.16 ms conversion cycle) and resulted in a stale re-read of the
// ADS1115 register before a new conversion completed.  For diagnostics.
float gsr_sensor_get_stale_rate(const GsrSensor* gsr);

// Live count of consecutive failed I2C reads happening right now — not a
// rolling average like get_success_rate(), so it shows a fresh failure
// streak building in real time, before either the 1 s success-rate
// average visibly drops or the 50-failure disconnect threshold actually
// fires.  For diagnostics.
uint32_t gsr_sensor_get_consecutive_failures(const GsrSensor* gsr);

// Smallest inter-read gap in ms seen SPECIFICALLY at a sample that turned
// out to be a duplicate (get_duplicate_rate()), over the same rolling
// ~1 s window as get_worker_hz().  Directly correlates timing with the
// reads that were actually stale.  Each timestamp is a floor() of the
// real time taken, so a reading of N ms is consistent with a true
// minimum anywhere from ~(N-1) ms to ~(N+1) ms.  Returns UINT32_MAX if
// no duplicates occurred in the most recent window (a real value of 0 is
// itself meaningful and must stay distinguishable from "no data"), or if
// unavailable.  For diagnostics.
uint32_t gsr_sensor_get_duplicate_gap_min_ms(const GsrSensor* gsr);

// Number of PGA (autorange) changes applied in the most recent rolling
// ~1 s window — same cadence as get_worker_hz().  A nonzero value signals
// the input sitting near an autorange threshold and flapping between
// ranges.  For diagnostics.
uint32_t gsr_sensor_get_pga_change_count(const GsrSensor* gsr);

// Update calibration parameters (thread-safe).  When active is true,
// zero_counts (the open-circuit reading, normalised counts) is subtracted
// from the window mean before the TIA conversion, and the result is
// multiplied by gain:  nS = gain * TIA(counts - zero_counts).
void gsr_sensor_set_calibration(GsrSensor* gsr, bool active, float gain, float zero_counts);

// Worst single I2C call duration ever observed on the worker thread, in ms
// — a lifetime max (never reset), timed immediately around each I2C call
// on the platform clock, including any wait for the bus. Covers both the config-write and conversion-read
// calls (mutually exclusive per loop iteration). Answers "did an I2C call
// cause a given main-loop stall" directly — see biomap_types.h's RowDiag
// doc comment and docs/archive/gps_rf_mutex_status.md. The radio's
// matching figures are in em_scan_sampler.h. Returns 0 if unavailable.
// For diagnostics.
uint32_t gsr_sensor_get_i2c_peak_ms(const GsrSensor* gsr);

#ifdef __cplusplus
}
#endif
