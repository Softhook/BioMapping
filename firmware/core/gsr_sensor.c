// GSR Sensor — ADS1115 I2C differential reader with PGA autoranging.
// Signal processing (EMA, derivative) is deferred to the main app.
//
// Shared by every device. It never touches hardware, threads or the clock
// itself: everything goes through the GsrPlatform functions the device
// passed to gsr_sensor_create() (see gsr_sensor.h).

#include "gsr_sensor.h"
#include "core_check.h"
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <math.h>

// ─────────────────────────────────────────────────────────────────────────────
// ADS1115 address and registers
// ─────────────────────────────────────────────────────────────────────────────
#define ADS1115_I2C_ADDR     0x48   // 7-bit address (ADDR pin → GND)
#define ADS1115_CONV_REG     0x00
#define ADS1115_CONFIG_REG   0x01

// ─────────────────────────────────────────────────────────────────────────────
// PGA autoranging
//
// pga_index  FSR        µV/LSB    Config MSB
// ─────────  ─────────  ────────  ──────────
//    0       ±6.144 V   187.500   0x80
//    1       ±4.096 V   125.000   0x82
//    2       ±2.048 V    62.500   0x84  ← default / normalisation reference
//    3       ±1.024 V    31.250   0x86
//    4       ±0.512 V    15.625   0x88
//    5       ±0.256 V     7.813   0x8A
//
// REACHABLE RANGE (3.3 V supply, this front-end)
//   V_diff into the ADC = 0.5 V × 47 kΩ / (R_skin + 9.4 kΩ) — bias × R_f /
//   R_safety (see gsr_tia_counts_to_ns() and the README schematic).  A dead short
//   (R_skin → 0) gives 0.5 × 47000 / 9400 = 2.5 V, a hard ceiling the 9.4 kΩ
//   electrode-safety resistors impose independent of supply.  Consequences:
//     - pga 0 (±6.144 V) is unreachable: a 1→0 range-down needs ~30 000 counts
//       on ±4.096 V ≈ 3.75 V, which the input physically cannot produce.
//     - pga 1 (±4.096 V) tops out near 61 % of range; pga 2 only clips below
//       R_skin ≈ 2 kΩ (non-physiological).  pga 2 is thus the startup default
//       and clip guard; the autoranger then climbs toward pga 5.
//   Effective ladder in normal use is pga 2 → 5.  ADS_PGA_MIN stays 0 — the
//   state is simply never entered, and keeping it leaves headroom for a
//   front-end revision with different safety resistors or supply.
//
// DELAY AFTER PGA CHANGE
//   In continuous mode the config write does not take effect at once: the
//   in-flight conversion finishes under the OLD gain, THEN one full
//   conversion runs under the NEW gain (datasheet 7.4.2.2), so the first
//   valid new-gain result is up to 2 × t_CONV away.  Reading before that
//   returns an old-gain count scaled by the new NORM_FACTOR — one sample at
//   exactly 2× or 0.5× the true value.  The worker's read path discards
//   conversions until PGA_SETTLE_MS of real elapsed time (on the clock,
//   not a count of delays) has passed since the write.  See
//   PGA_SETTLE_MS and the worker's settle-gate comment.
//
// SATURATION DETECTION
//   The ADC clips at exactly ±32 767 (0x7FFF / 0x8000).  We use
//   ADS_SATURATE_THRESH = 30 000 (~91.5 % of FS) to catch the approaching
//   rail one tick before hard saturation; the FSR is widened immediately.
//
// RANGING-UP HYSTERESIS
//   Gain is only increased after ADS_LOW_COUNT_TICKS = 5 consecutive ticks
//   with |raw| < ADS_LOW_THRESH = 4 096 (12.5 % FS).  After ranging up, the
//   same physical signal reads ~2× as many counts (~25 % FS), safely above
//   the threshold — preventing oscillation around the boundary.
//
//   The counts are of 100 ms windows, not of calls: after a main-loop stall
//   the missed ticks run back to back, all averaging the same latest window
//   (COUNTED_WINDOW_GAP_MS below). That one window is counted once, so a
//   single 100 ms dip can't range up, nor one bad window add to the
//   disconnect count more than once.
//
// OUTPUT NORMALISATION
//   The worker stores counts normalised to the pga_index=5 (±0.256 V)
//   reference where 1 unit = 7.8125 µV; tick() converts these to nS for
//   gsr_sensor_get_raw().  This preserves 100 % of the hardware's
//   resolution at all gain settings:
//
//     normalised = hw × NORM_FACTOR[pga]
//
//   PGA ratios relative to ±0.256 V are exact integers (no float or division):
//     pga 0 (±6.144V, LSB=187.5 µV):    ×24
//     pga 1 (±4.096V, LSB=125.0 µV):    ×16
//     pga 2 (±2.048V, LSB=62.50 µV):    ×8  (familiar ±2.048V range scale × 8)
//     pga 3 (±1.024V, LSB=31.25 µV):    ×4
//     pga 4 (±0.512V, LSB=15.625 µV):   ×2
//     pga 5 (±0.256V, LSB=7.8125 µV):   ×1
//
//   These exact ratios hold only if the source driving AIN0/AIN1 is
//   low-impedance against the ADS1115's differential input impedance, which
//   falls with gain (~4.9 MΩ at ±2.048 V → 710 kΩ at ±0.256 V, datasheet
//   §5.5).  It is: both pins are op-amp outputs (MCP6002, closed-loop output
//   impedance in the mΩ–Ω range across the sub-Hz GSR band, nothing in series
//   to the ADC), so the per-range loading error is sub-ppm.  The precision-
//   resistor sweep in docs/reference_test_results.csv crosses several pga
//   steps and stays within the ±0.1 / ±0.5 % spec, confirming this end to end.
// ─────────────────────────────────────────────────────────────────────────────

// 0.5 V BIAS MEASUREMENT (see GSR_BIAS_* in gsr_sensor.h)
//   AIN1 carries the bias (it is the skin reading's reference). alloc()
//   reads it directly before the worker starts. After that the worker only
//   reads it when asked (gsr_sensor_request_bias_check(), at the start of
//   each recording): it switches the input multiplexer to AIN1-vs-GND on
//   ±1.024 V (0.5 V reads ~16 000 counts), waits out the same PGA_SETTLE_MS
//   window a gain change needs, averages BIAS_AVG_READS reads, then queues a
//   normal config write (pga_changed) to put the skin input back, which
//   arms the usual settle gate. Conversions taken while the bias is on the
//   multiplexer are never written to the ring buffer.
//   The ADS1115's own noise at ±1.024 V is tens of µV, under 0.01 % of
//   0.5 V, so one conversion would do for that. 16 reads span about
//   30 ms on the Flipper (a read every 2 ms) and about 16 ms on the
//   Cardputer (every 1 ms; see the pacing notes further down). The whole
//   check, switch-over and settle included, takes about 40–50 ms on the
//   Flipper, where a radio sweep landing in the middle adds ~15 ms, and
//   about 25 ms on the Cardputer. That is also the gap it leaves in the
//   skin samples. The average adds
//   little on the PCBs: C9 already smooths the bias over ~85 ms, so a
//   supply dip that gets through C9 lasts longer than the 30 ms and the
//   average can't remove it either. It only helps on a board without C9,
//   against a shorter dip.

#define BIAS_AVG_READS 16

#define ADS_PGA_DEFAULT       2
#define ADS_PGA_MIN           0
#define ADS_PGA_MAX           5
#define ADS_SATURATE_THRESH   30000  // 91.5 % of FS → range down immediately
#define ADS_LOW_THRESH         4096  // 12.5 % of FS → range up candidate
#define ADS_LOW_COUNT_TICKS       5  // consecutive low ticks before range up

// Post-PGA-change settle window (see "DELAY AFTER PGA CHANGE" above).  The
// first valid new-gain conversion is up to 2 × t_CONV away; t_CONV = 1/860
// SPS = 1.163 ms, and the datasheet permits the data rate to run 10 % slow,
// so the worst case is 2 × 1.292 ≈ 2.58 ms.  4 ms clears that with margin
// even at the coarsest alignment: with a 1 kHz tick the gate opens 3–4 ms
// after it is armed, depending on sub-tick phase.
#define PGA_SETTLE_MS  4

// Target duration of gsr_sensor_tick()'s averaging window. Time-based (see
// research/gsr_filtering_analysis.md, Recommendation 1b) rather than a fixed
// sample count: the worker's real rate differs by device (about 500 reads a
// second on the Flipper, 1000 on the Cardputer) and varies a little run to
// run. A time window keeps its duration (and therefore its 50/60 Hz null)
// regardless of that rate; see the Oversampling & Filtering notes above
// gsr_sensor_tick().
#define BOXCAR_WINDOW_MS  100

// A tick less than this long after the last counted one reads mostly the
// same window, so it doesn't add to the range-up or disconnect counts (see
// RANGING-UP HYSTERESIS). Half a window: normal ticks, 100 ms apart with
// some jitter, always count.
#define COUNTED_WINDOW_GAP_MS (BOXCAR_WINDOW_MS / 2)

// Normalisation multiplier factors to pga_index=5 (±0.256 V) reference.
static const int32_t NORM_FACTOR[6] = { 24, 16, 8, 4, 2, 1 };

// Human-readable FSR label for each pga_index (log messages only).
static const char* const PGA_LABEL[6] = {
    "6.144V", "4.096V", "2.048V", "1.024V", "0.512V", "0.256V",
};

// Config register MSB for each pga_index.
// Bit layout: OS=1 | MUX=000 (AIN0–AIN1 differential) | PGA[2:0] | MODE=0 (continuous)
// = 0x80 | (pga_index << 1).  LSB stays 0xE3: DR=860 SPS, comparator disabled.
static inline uint8_t pga_msb(uint8_t idx) {
    return (uint8_t)(0x80u | ((uint32_t)idx << 1u));
}

// Bias check: MUX=101 (AIN1 against GND), PGA ±1.024 V (index 3, 31.25 µV
// per count), continuous. Same LSB (0xE3) as the skin config.
#define BIAS_CFG_MSB       (0x80u | (5u << 4u) | (3u << 1u))
#define BIAS_VOLTS_PER_LSB 31.25e-6f

// ─────────────────────────────────────────────────────────────────────────────
// Struct & Constants
// ─────────────────────────────────────────────────────────────────────────────

// Compile-time guard: the ring buffer uses & (SENSOR_BUFFER_SIZE - 1) which
// only works for powers of two.
_Static_assert((SENSOR_BUFFER_SIZE & (SENSOR_BUFFER_SIZE - 1)) == 0,
               "SENSOR_BUFFER_SIZE must be a power of two");

struct GsrSensor {
    float   raw;        // skin conductance in nanosiemens (nS)
    bool    connected;  // false after 20+ ticks outside GSR_VALID_MIN_NS..GSR_VALID_MAX_NS (cuffs disconnected)
    bool    i2c_working; // false when consecutive I2C reads fail
    uint8_t pga_index;  // active PGA setting (0 … ADS_PGA_MAX)
    uint8_t low_count;  // consecutive ticks below ADS_LOW_THRESH
    uint8_t zero_count; // consecutive ticks outside the valid nS range
    bool    counted_once;     // tick() only: a window has been counted (counted_ms is set)
    uint32_t counted_ms;      // tick() only: when the last window was counted
    bool    cal_active; // true when custom calibration is active
    float   cal_gain;   // linear calibration gain factor (default 1.0)
    float   cal_zero_counts; // open-circuit zero, normalised counts, removed before the TIA (default 0)
    float   bias_volts; // last accepted bias reading (AIN1 alone), V; 0 = none yet
    float   bias_scale; // bias_volts / GSR_BIAS_NOMINAL_V, or 1.0 if none — used by the TIA equation
    float   bias_measured_volts; // what the last check read, accepted or not; NAN = check failed
    bool    bias_check_requested; // set by request(), cleared by the worker on finishing or by cancel()
    uint32_t bias_check_seq;      // +1 each time the worker finishes a requested check
    int32_t tick_last_norm; // raw normalised count at tick's last-summed index
                             // (snapshotted during tick, used by get_raw_sample_ns)
    int32_t tick_mean_norm; // ~100 ms window mean normalised count (pre-TIA)
    int32_t tick_window_samples; // how many buffer entries landed in that window
    float   tick_spread_ns; // standard deviation of the readings in that window, in nS
    uint32_t pga_change_count;         // tick()-only — total PGA changes applied, lifetime
    uint32_t hz_window_start_pga_changes; // pga_change_count snapshot — tick() only
    uint32_t pga_change_rate_cached;      // tick() only — PGA changes in the last ~1 s window

    // The device's functions (copied at create, never changed). Its lock
    // guards the ADC ring buffer, PGA/calibration state and diagnostics
    // counters — gsr_lock()/gsr_unlock() below.
    GsrPlatform platform;
    volatile bool pga_changed; // guarded by the lock: written in tick(), read at the top of each worker pass

    // Worker-pass state: touched only by gsr_sensor_worker_pass(), on the
    // device's GSR thread, so it needs no lock. Survives from one pass to
    // the next.
    struct {
        uint8_t  current_adc_pga; // gain the conversion now in the ADC was started under
        uint32_t consecutive_failures;
        int16_t  last_hw;
        bool     have_last_hw;    // no prior read to compare the next one against
        uint32_t last_read_tick;  // paired with have_last_hw — valid whenever it's true
        // Reads are discarded until the clock reaches this — the
        // post-PGA-change settle gate. Starts at "now" (open) so there is
        // no wrap corner at startup; re-armed on each successful config write.
        uint32_t pga_settle_until_tick;
        // Bias check state (see "0.5 V BIAS MEASUREMENT" above). While
        // bias_active the multiplexer is on AIN1 alone, so conversions are
        // the bias, not skin.
        bool     bias_active;
        uint32_t bias_settle_until_tick;
        int32_t  bias_sum;        // sum of settled bias reads so far (counts)
        int32_t  bias_reads;
    } w;

    int32_t  buffer[SENSOR_BUFFER_SIZE];
    uint32_t sample_tick[SENSOR_BUFFER_SIZE]; // tick timestamp of buffer[i], for
                                               // time-based (not count-based) averaging
                                               // in gsr_sensor_tick() — see Recommendation
                                               // 1b in research/gsr_filtering_analysis.md
    volatile uint32_t write_idx;

    // Worker throughput diagnostics (see research/gsr_filtering_analysis.md,
    // Recommendation 1) — iter_count counts successful buffer writes only
    // (not PGA-change passes, which don't write), so iter_count / elapsed
    // time is the true sample rate the CSV boxcar average in
    // gsr_sensor_tick() actually runs at.
    //
    // worker_hz_cached is a ROLLING ~1 s measurement, recomputed by
    // gsr_sensor_tick() (main thread only) whenever a window elapses —
    // deliberately NOT a lifetime average since alloc().  A lifetime
    // average converges slowly and stays permanently diluted by the
    // one-time probe/warm-up delay in gsr_sensor_alloc(), so a reading
    // taken shortly after entering the Diagnostics screen would
    // understate the true steady-state rate.  Same no-mutex-needed
    // pattern as tick_mean_norm below: written only by tick() on the main
    // thread, read by the accessor on the same thread.
    uint32_t iter_count;            // mutex-protected — worker increments (success only), tick() reads
    uint32_t attempt_count;         // mutex-protected — worker increments (every read, success or fail)
    // duplicate_count — mutex-protected, worker increments whenever a
    // successful read's raw ADC code exactly matches the immediately
    // preceding successful read's code (same PGA setting). This is the
    // direct, measured version of the skip-vs-duplicate question in
    // research/gsr_filtering_analysis.md.
    //
    // The counter can't distinguish a genuinely stale re-read from two
    // fresh conversions of a signal that hasn't changed between them, and
    // which one it mostly sees depends on the device's pace (see
    // Oversampling & Filtering below). The Flipper reads every 2 ms, slower
    // than the ADC's ~1.16 ms conversions, so its duplicates (measured
    // ~7-11 % with skin connected, ~12-16 % open circuit, where the input
    // is near DC) are nearly all fresh conversions that happened to match.
    // The Cardputer reads every 1 ms, faster than the conversions, so about
    // 14 % of its reads see the previous conversion again: expected, and
    // harmless to the mean. Reset to 0 (via have_last_hw = false in the
    // worker) on every PGA change — a gain change makes the previous
    // reading's raw code incomparable, which is a scale change, not a
    // stale read.
    uint32_t duplicate_count;
    uint32_t stale_count;               // mutex-protected — worker increments on duplicates with gap_ms < 2 (stale hardware re-read)
    // duplicate_gap_running_min — mutex-protected. Worker tracks the
    // smallest inter-read gap (ms) seen specifically AT a duplicate
    // event (not the general per-window minimum gsr_sensor_tick()
    // computes over the whole window in Step 1) since the last ~1 s
    // window reset. UINT32_MAX means no duplicates have occurred yet in
    // the current window. This is the direct correlation that
    // duplicate_count alone doesn't give: whether the reads that
    // actually turned out to be duplicates were specifically the
    // tightly-spaced ones — real evidence for or against the "occasional
    // sub-ADC-conversion-time loop period" theory, rather than comparing
    // two independent aggregate numbers (general window Gap vs. Dup%)
    // and eyeballing whether they seem consistent.
    uint32_t duplicate_gap_running_min;
    uint32_t duplicate_gap_min_cached; // tick() only — last window's value, same UINT32_MAX sentinel
    uint32_t hz_window_start_tick;  // tick() only
    uint32_t hz_window_start_count;    // iter_count snapshot — tick() only
    uint32_t hz_window_start_attempts; // attempt_count snapshot — tick() only
    uint32_t hz_window_start_duplicates; // duplicate_count snapshot — tick() only
    uint32_t hz_window_start_stale;    // stale_count snapshot — tick() only
    float    worker_hz_cached;      // tick() only — successful-sample rate
    float    success_rate_cached;   // tick() only — iter_count/attempt_count over the same window, 0-100
    float    duplicate_rate_cached; // tick() only — duplicate_count/iter_count over the same window, 0-100
    float    stale_rate_cached;     // tick() only — stale_count/iter_count over the same window, 0-100

    // Live (not rolling-window) count of consecutive failed I2C reads —
    // mutex-protected, mirrors the worker's local consecutive_failures.
    // Published so the accessor can show "how close to the 50-failure
    // disconnect threshold right now", which a ~1 s rolling success_rate
    // average can't: success_rate can still read e.g. 80% while a fresh
    // failure streak is actively building toward disconnect. Only
    // written on failure, and once on recovery (not every successful
    // iteration) — see gsr_sensor_worker_pass() — to avoid taking the lock
    // on every single normal-operation read just to publish a 0.
    uint32_t consecutive_failures;

    // Worst-case I2C call duration ever observed, in ms — a real
    // clock delta measured immediately around each I2C call in
    // the worker, never reset (same "only grows" spirit as gps_uart's
    // gps_rx_drops/nmea_fail — see RowDiag's doc comment, biomap_types.h).
    // It answers "did an I2C call cause a given main-loop stall" directly.
    // Covers both I2C call sites in the worker (PGA-change config write and
    // routine conversion read) — mutually exclusive within a loop
    // iteration, so one figure covers both. Includes any wait for the bus,
    // which the device's I2C functions take and release around each call.
    // Guarded by the lock, but only updated in the brief window after the
    // call, never across it.
    uint32_t i2c_peak_ms;
};

// ─────────────────────────────────────────────────────────────────────────────
// The device's functions
// ─────────────────────────────────────────────────────────────────────────────
static inline void gsr_lock(const GsrSensor* gsr) {
    gsr->platform.lock(gsr->platform.ctx);
}

static inline void gsr_unlock(const GsrSensor* gsr) {
    gsr->platform.unlock(gsr->platform.ctx);
}

// The device's millisecond clock.
static inline uint32_t gsr_now(const GsrSensor* gsr) {
    return gsr->platform.now_ms(gsr->platform.ctx);
}

static inline void gsr_delay_ms(const GsrSensor* gsr, uint32_t ms) {
    gsr->platform.delay_ms(gsr->platform.ctx, ms);
}

// Read the conversion register: one signed ADC code. *code is only
// written on success.
static bool ads_read_code(const GsrSensor* gsr, int16_t* code) {
    uint8_t data[2];
    bool ok = gsr->platform.i2c_read(gsr->platform.ctx, ADS1115_I2C_ADDR, ADS1115_CONV_REG,
                                     data, 2, 50);
    if(ok) *code = (int16_t)((data[0] << 8) | data[1]);
    return ok;
}

// Write the config register: `msb` (input, gain, mode) with the fixed
// 0xE3 LSB (860 SPS, comparator off).
static bool ads_write_config(const GsrSensor* gsr, uint8_t msb) {
    uint8_t cfg[2] = { msb, 0xE3 };
    return gsr->platform.i2c_write(gsr->platform.ctx, ADS1115_I2C_ADDR, ADS1115_CONFIG_REG,
                                   cfg, 2, 50);
}

// One log line, if the device takes them. printf-style; lines longer than
// the buffer are cut short.
static void gsr_log(const GsrSensor* gsr, bool warning, const char* fmt, ...) {
    if(!gsr->platform.log) return;
    char line[80];
    va_list args;
    va_start(args, fmt);
    vsnprintf(line, sizeof(line), fmt, args);
    va_end(args);
    gsr->platform.log(gsr->platform.ctx, warning, line);
}

// Worker only: a config write, timed for i2c_peak_ms. Timed regardless of
// the result — a stall is worth recording whether or not the write it
// stalled on happened to succeed.
static bool ads_write_config_timed(GsrSensor* gsr, uint8_t msb) {
    uint32_t start = gsr_now(gsr);
    bool ok = ads_write_config(gsr, msb);
    uint32_t dur = gsr_now(gsr) - start;
    gsr_lock(gsr);
    if(dur > gsr->i2c_peak_ms) gsr->i2c_peak_ms = dur;
    gsr_unlock(gsr);
    return ok;
}

// Record a finished bias check's reading, and use it if it is in range
// (otherwise the last good value stays in use). The caller holds the lock
// whenever the worker may be running.
static void gsr_store_bias(GsrSensor* gsr, float v) {
    gsr->bias_measured_volts = v;
    if(gsr_bias_in_range(v)) {
        gsr->bias_volts = v;
        gsr->bias_scale = v / GSR_BIAS_NOMINAL_V;
    }
}

// 50 failed I2C calls in a row: about 50 ms on the Cardputer (a pass every
// 1 ms), about 100 ms on the Flipper (every 2 ms).
#define I2C_FAIL_LOST_THRESHOLD 50

// One failed I2C transaction — a conversion read or a config write, so a
// config write that keeps failing can't retry forever while the sensor
// still claims to be working with a frozen value. After
// I2C_FAIL_LOST_THRESHOLD in a row, treat the sensor as disconnected so
// the UI doesn't show a stale reading; the next successful read then runs
// the recovery path in gsr_sensor_worker_pass(). Worker only.
static void gsr_note_i2c_failure(GsrSensor* gsr) {
    gsr->w.consecutive_failures++;
    gsr_lock(gsr);
    gsr->consecutive_failures = gsr->w.consecutive_failures;
    if(gsr->w.consecutive_failures >= I2C_FAIL_LOST_THRESHOLD) {
        gsr->connected = false;
        gsr->i2c_working = false;
        gsr->raw = 0.0f;
    }
    gsr_unlock(gsr);
}

// One successful I2C transaction: clear any failure streak. Worker only.
static void gsr_note_i2c_success(GsrSensor* gsr) {
    if(gsr->w.consecutive_failures == 0) return;
    gsr->w.consecutive_failures = 0;
    gsr_lock(gsr);
    gsr->consecutive_failures = 0;
    gsr_unlock(gsr);
}

// One pass of the background worker (860 SPS ADC reading).  Writes
// normalised samples to the ring buffer; the main thread's
// gsr_sensor_tick() handles decimation, autoranging, and TIA computation
// at exact 10 Hz boundaries. The device's GSR thread calls this in a loop
// with a 1 ms pause after each pass (see gsr_sensor.h).
bool gsr_sensor_worker_pass(GsrSensor* gsr) {
    gsr_lock(gsr);
    uint8_t active_pga = gsr->pga_index;
    bool pga_changed = gsr->pga_changed;
    bool i2c_working = gsr->i2c_working;
    bool bias_requested = gsr->bias_check_requested;
    gsr_unlock(gsr);

    // ── PGA change path: write the config, then end the pass — never fall
    // through to the read path.
    if(pga_changed) {
        if(ads_write_config_timed(gsr, pga_msb(active_pga))) {
            gsr_note_i2c_success(gsr);
            gsr_lock(gsr);
            gsr->pga_changed = false;
            gsr_unlock(gsr);

            // Arm the settle gate: the read path discards conversions
            // until PGA_SETTLE_MS of real elapsed time has passed (see
            // that #define). Measured on the clock rather than slept
            // through with a delay, for the same reason em_scan_rf.c's
            // dwell loop and em_scan_sampler.c's disable timeout are: the
            // Flipper's furi_delay_ms(N) is only loosely >= N ms. The
            // worker keeps looping through the window, so I2C failure
            // detection and the worker hook stay live.
            gsr->w.pga_settle_until_tick = gsr_now(gsr) + PGA_SETTLE_MS;
            gsr->w.current_adc_pga = active_pga;
            gsr->w.have_last_hw = false; // new gain scale — not comparable to the pre-change code
            gsr->w.bias_active = false;  // skin input is back; an unfinished bias check is dropped
        } else {
            // Config write failed — retry next pass, counting it toward
            // "sensor lost" like a failed read.
            gsr_note_i2c_failure(gsr);
        }
        return false;
    }

    // ── Bias check start (requested): multiplexer to AIN1 alone. ────
    // Not while a gain change is still settling (that would waste it),
    // and not while I2C is down (recovery rewrites the config itself).
    // A request stays pending through either, so it runs afterwards.
    if(!gsr->w.bias_active && bias_requested && i2c_working &&
       (int32_t)(gsr_now(gsr) - gsr->w.pga_settle_until_tick) >= 0) {
        if(ads_write_config_timed(gsr, (uint8_t)BIAS_CFG_MSB)) {
            gsr_note_i2c_success(gsr);
            gsr->w.bias_active = true;
            gsr->w.bias_settle_until_tick = gsr_now(gsr) + PGA_SETTLE_MS;
            gsr->w.bias_sum = 0;
            gsr->w.bias_reads = 0;
            gsr->w.have_last_hw = false; // next skin read follows a different input
        } else {
            // The multiplexer may or may not have switched: put the skin
            // config back through the normal path, which retries. The
            // check is finished, as a failure (measured = NAN).
            gsr_note_i2c_failure(gsr);
            gsr_lock(gsr);
            gsr->pga_changed = true;
            if(gsr->bias_check_requested) {
                gsr->bias_measured_volts = NAN;
                gsr->bias_check_requested = false;
                gsr->bias_check_seq++;
            }
            gsr_unlock(gsr);
        }
        return false;
    }

    // ── Normal read path: read the conversion. ──────────────────────────
    int16_t hw = 0;
    uint32_t i2c_read_start = gsr_now(gsr);
    bool ok = ads_read_code(gsr, &hw);
    uint32_t i2c_read_dur = gsr_now(gsr) - i2c_read_start;

    // Post-PGA-change settle gate: after a config write the conversion
    // register can still hold a sample started under the old gain (see
    // PGA_SETTLE_MS). Successful reads are discarded until real elapsed
    // time clears that window — I2C is still exercised so a disconnect
    // mid-settle trips the failure path below, but the sample isn't used.
    bool in_pga_settle = (int32_t)(gsr_now(gsr) - gsr->w.pga_settle_until_tick) < 0;
    bool in_bias_settle = gsr->w.bias_active &&
        (int32_t)(gsr_now(gsr) - gsr->w.bias_settle_until_tick) < 0;

    // attempt_count normally counts every read, success or failure — it
    // distinguishes "the loop genuinely only runs this fast" from "the
    // loop runs fast but half the reads silently fail" (iter_count alone
    // can't; see research/gsr_filtering_analysis.md). The settle window is
    // excluded from attempt_count (and therefore worker_hz / success
    // rate): we're deliberately not sampling then, exactly as during the
    // old furi_delay_ms() gap. i2c_peak_ms still updates — an I2C stall
    // matters whenever it lands.
    gsr_lock(gsr);
    if(!in_pga_settle && !gsr->w.bias_active) gsr->attempt_count++;
    if(i2c_read_dur > gsr->i2c_peak_ms) gsr->i2c_peak_ms = i2c_read_dur;
    gsr_unlock(gsr);

    // A successful read means I2C is alive whether or not the sample is
    // used (the settle gate below may discard it) — clear any failure
    // streak on every success.
    bool recovering = false;
    if(ok) {
        gsr_note_i2c_success(gsr);
        if(!gsr->i2c_working) {
            // Coming back from "sensor lost" (or a failed probe at
            // create): the ADS1115 may have lost power meanwhile, and it
            // powers up in single-shot mode (config reset 8583h), where
            // the conversion register never updates. Nothing else
            // rewrites the config at the highest gain (autoranging
            // only writes on a gain change), so the sensor would read
            // 0 for the rest of the session. Queue a config write for
            // the current gain, and drop this read — it came from a
            // chip that may still be in that power-up state.
            gsr_lock(gsr);
            gsr->i2c_working = true;
            gsr->pga_changed = true;
            gsr_unlock(gsr);
            recovering = true;
        }
    }

    // Sample processing proper — skipped during the settle window even on
    // a good read (the conversion may pre-date the gain change), and for
    // the read that just ended a "sensor lost" spell (see above).
    // have_last_hw stays false through the window, so the first sample
    // after it is not duplicate-compared against a discarded one.
    if(ok && gsr->w.bias_active && !recovering) {
        // Bias check in progress: this conversion is the bias, never skin.
        // Once settled, add up BIAS_AVG_READS reads (a failed read is
        // just skipped), then record the mean, use it if in range, and
        // queue the skin config back; the PGA-change path then clears
        // bias_active and arms the settle gate for the skin input. A
        // check cancelled meanwhile (request cleared) restores the skin
        // input straight away and changes nothing else.
        // The reads are paced by the loop's own 1 ms pause, and the
        // hook keeps running through the check.
        if(!in_bias_settle) {
            gsr->w.bias_sum += hw;
            gsr->w.bias_reads++;
        }
        gsr_lock(gsr);
        bool cancelled = !gsr->bias_check_requested;
        if(cancelled) gsr->pga_changed = true;
        gsr_unlock(gsr);
        if(!cancelled && gsr->w.bias_reads >= BIAS_AVG_READS) {
            float v = ((float)gsr->w.bias_sum / (float)gsr->w.bias_reads) * BIAS_VOLTS_PER_LSB;
            gsr_lock(gsr);
            if(gsr->bias_check_requested) {
                gsr_store_bias(gsr, v);
                gsr->bias_check_requested = false;
                gsr->bias_check_seq++;
            }
            gsr->pga_changed = true;
            gsr_unlock(gsr);
        }
    } else if(ok && !in_pga_settle && !recovering) {
        // Normalise using current_adc_pga (the gain that was active
        // when the conversion currently in the register was started).
        int32_t norm = (int32_t)hw * NORM_FACTOR[gsr->w.current_adc_pga];

        // Same raw code as the immediately preceding (same-PGA) read
        // means the ADS1115 hadn't completed a new conversion between
        // the two I2C transactions — a stale re-read, not a fresh
        // sample. See duplicate_count's doc comment above.
        uint32_t this_tick = gsr_now(gsr);
        bool is_duplicate = gsr->w.have_last_hw && (hw == gsr->w.last_hw);
        // Only meaningful (and only ever read) when is_duplicate is
        // true, which requires have_last_hw — so last_read_tick is
        // always valid by the time it's actually used below.
        uint32_t gap_ms = this_tick - gsr->w.last_read_tick;
        gsr->w.last_hw = hw;
        gsr->w.last_read_tick = this_tick;
        gsr->w.have_last_hw = true;

        gsr_lock(gsr);
        gsr->buffer[gsr->write_idx] = norm;
        gsr->sample_tick[gsr->write_idx] = this_tick;
        gsr->write_idx = (gsr->write_idx + 1) & (SENSOR_BUFFER_SIZE - 1);
        gsr->iter_count++;
        if(is_duplicate) {
            gsr->duplicate_count++;
            if(gap_ms < 2) {
                gsr->stale_count++;
            }
            if(gap_ms < gsr->duplicate_gap_running_min) {
                gsr->duplicate_gap_running_min = gap_ms;
            }
        }
        gsr_unlock(gsr);
    } else if(!ok) {
        gsr_note_i2c_failure(gsr);
    }

    if(!pga_changed) {
        gsr->w.current_adc_pga = active_pga;
    }

    // A normal pass: the device may now give its other job a turn.
    return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle
// ─────────────────────────────────────────────────────────────────────────────
GsrSensor* gsr_sensor_create(const GsrPlatform* platform) {
    CORE_CHECK(platform && platform->lock && platform->unlock && platform->now_ms &&
                   platform->delay_ms && platform->i2c_read && platform->i2c_write,
               "GsrSensor: incomplete platform");
    GsrSensor* gsr = malloc(sizeof(GsrSensor));
    CORE_CHECK(gsr, "GsrSensor: alloc failed");
    gsr->platform = *platform;
    gsr->raw       = 0.0f;
    gsr->pga_index = ADS_PGA_DEFAULT;
    gsr->low_count = 0;
    gsr->connected = true;
    gsr->i2c_working = true;
    gsr->zero_count = 0;
    gsr->counted_once = false;
    gsr->counted_ms = 0;
    gsr->cal_active = false;
    gsr->cal_gain = 1.0f;
    gsr->cal_zero_counts = 0.0f;
    gsr->bias_volts = 0.0f;
    gsr->bias_scale = 1.0f;
    gsr->bias_measured_volts = NAN;
    gsr->bias_check_requested = false;
    gsr->bias_check_seq = 0;

    // Probe: a short 1-byte read, just to see if the chip answers.
    uint8_t probe = 0;
    bool probed = gsr->platform.i2c_read(gsr->platform.ctx, ADS1115_I2C_ADDR, ADS1115_CONV_REG,
                                         &probe, 1, 20);

    if(probed) {
        // First bias check, so the very first readings already use it:
        // AIN1 alone on ±1.024 V, wait two conversions plus margin, then
        // average BIAS_AVG_READS reads 1 ms apart (failed reads skipped;
        // NAN if none succeeded).
        if(ads_write_config(gsr, (uint8_t)BIAS_CFG_MSB)) {
            gsr_delay_ms(gsr, 5);
            int32_t sum = 0;
            int32_t good = 0;
            for(int i = 0; i < BIAS_AVG_READS; i++) {
                if(i > 0) gsr_delay_ms(gsr, 1);
                int16_t code;
                if(ads_read_code(gsr, &code)) {
                    sum += code;
                    good++;
                }
            }
            float v = good > 0 ? ((float)sum / (float)good) * BIAS_VOLTS_PER_LSB : NAN;
            gsr_store_bias(gsr, v); // no lock: the worker hasn't started
            gsr_log(gsr, false, "Bias read %.4f V, using %.4f V", (double)v,
                    (double)(gsr->bias_scale * GSR_BIAS_NOMINAL_V));
        }

        // Config: default PGA, continuous 860 SPS
        if(!ads_write_config(gsr, pga_msb(ADS_PGA_DEFAULT))) gsr_log(gsr, true, "Config write failed — using defaults");
    }

    gsr->i2c_working = probed;
    gsr_log(gsr, false, "I2C Probe %s", probed ? "OK" : "not found");

    int32_t initial_norm = 0;
    if(probed) {
        // Warm up buffer with initial value
        gsr_delay_ms(gsr, 5);
        int16_t initial_hw = 0;
        ads_read_code(gsr, &initial_hw);
        initial_norm = (int32_t)initial_hw * NORM_FACTOR[ADS_PGA_DEFAULT];
    }
    uint32_t alloc_tick = gsr_now(gsr);
    for(int i = 0; i < SENSOR_BUFFER_SIZE; i++) {
        gsr->buffer[i] = initial_norm;
        gsr->sample_tick[i] = alloc_tick;
    }
    gsr->write_idx = 0;

    gsr->iter_count = 0;
    gsr->attempt_count = 0;
    gsr->duplicate_count = 0;
    gsr->stale_count = 0;
    gsr->duplicate_gap_running_min = UINT32_MAX;
    gsr->duplicate_gap_min_cached = UINT32_MAX;
    gsr->consecutive_failures = 0;
    gsr->hz_window_start_tick = gsr_now(gsr); // set before the worker starts — no lock needed
    gsr->hz_window_start_count = 0;
    gsr->hz_window_start_attempts = 0;
    gsr->hz_window_start_duplicates = 0;
    gsr->hz_window_start_stale = 0;
    gsr->worker_hz_cached = 0.0f;
    gsr->success_rate_cached = 100.0f; // optimistic default until the first window rolls
    gsr->duplicate_rate_cached = 0.0f; // optimistic default until the first window rolls
    gsr->stale_rate_cached = 0.0f;     // optimistic default until the first window rolls
    gsr->pga_change_count = 0;
    gsr->hz_window_start_pga_changes = 0;
    gsr->pga_change_rate_cached = 0;
    gsr->i2c_peak_ms = 0;
    gsr->tick_last_norm = 0;
    gsr->tick_mean_norm = 0;
    gsr->tick_window_samples = 0;
    gsr->tick_spread_ns = 0.0f;

    gsr->pga_changed = false;

    gsr->w.current_adc_pga = ADS_PGA_DEFAULT;
    gsr->w.consecutive_failures = 0;
    gsr->w.last_hw = 0;
    gsr->w.have_last_hw = false;
    gsr->w.last_read_tick = 0;
    gsr->w.pga_settle_until_tick = gsr_now(gsr);
    gsr->w.bias_active = false;
    gsr->w.bias_settle_until_tick = 0;
    gsr->w.bias_sum = 0;
    gsr->w.bias_reads = 0;

    return gsr;
}

void gsr_sensor_destroy(GsrSensor* gsr) {
    CORE_CHECK(gsr, "GsrSensor: NULL in destroy()");

    // Put ADS1115 into low-power single-shot/power-down mode (MODE bit = 1)
    ads_write_config(gsr, (uint8_t)(pga_msb(gsr->pga_index) | 0x01));

    free(gsr);
}

void* gsr_sensor_platform_ctx(const GsrSensor* gsr) {
    CORE_CHECK(gsr, "GsrSensor: NULL in platform_ctx()");
    return gsr->platform.ctx;
}

// ─────────────────────────────────────────────────────────────────────────────
// Accessors
// ─────────────────────────────────────────────────────────────────────────────
bool gsr_sensor_available(const GsrSensor* gsr) {
    if(!gsr) return false;
    // Under the mutex like every other accessor: the worker writes
    // i2c_working on a failure streak or recovery.
    gsr_lock(gsr);
    bool working = gsr->i2c_working;
    gsr_unlock(gsr);
    return working;
}

bool gsr_sensor_is_connected(const GsrSensor* gsr) {
    CORE_CHECK(gsr, "GsrSensor: NULL in is_connected()");
    gsr_lock(gsr);
    bool connected = gsr->connected;
    gsr_unlock(gsr);
    return connected;
}

float gsr_sensor_get_raw(const GsrSensor* gsr) {
    // Called every tick (10Hz) during recording — the highest-frequency
    // call site among the promoted checks in this file.
    CORE_CHECK(gsr, "GsrSensor: NULL in get_raw()");
    gsr_lock(gsr);
    float val = gsr->raw;
    gsr_unlock(gsr);
    return val;
}

// ── Single-sample raw → nS (no decimation, no autoranging, no calibration gain) ──
// Uses the normalised count snapshotted by tick() from the same buffer
// position as the ~100 ms window's most recent entry.  This guarantees
// the raw sample and the filtered mean use the exact same underlying data.
float gsr_sensor_get_raw_sample_ns(const GsrSensor* gsr) {
    CORE_CHECK(gsr, "GsrSensor: NULL in get_raw_sample_ns()");

    gsr_lock(gsr);
    float counts = (float)gsr->tick_last_norm;
    if(gsr->cal_active) counts -= gsr->cal_zero_counts;
    float bias_scale = gsr->bias_scale;
    gsr_unlock(gsr);

    return gsr_tia_counts_to_ns_at_bias(counts, bias_scale);
}

int32_t gsr_sensor_get_raw_sample_count(const GsrSensor* gsr) {
    CORE_CHECK(gsr, "GsrSensor: NULL in get_raw_sample_count()");
    gsr_lock(gsr);
    int32_t val = gsr->tick_last_norm;
    gsr_unlock(gsr);
    return val;
}

int32_t gsr_sensor_get_mean_count(const GsrSensor* gsr) {
    CORE_CHECK(gsr, "GsrSensor: NULL in get_mean_count()");
    // tick_mean_norm is written by tick() on the main thread but read here
    // from whatever thread calls this accessor (the GUI render thread, in
    // production) — genuinely cross-thread, so it needs gsr->mutex like
    // every other field below.
    gsr_lock(gsr);
    int32_t val = gsr->tick_mean_norm;
    gsr_unlock(gsr);
    return val;
}

// How many ring-buffer entries landed inside the most recent tick()'s
// ~100 ms time window and were actually averaged into gsr_sensor_get_
// mean_count()'s result — the real-time counterpart to the rolling ~1 s
// gsr_sensor_get_worker_hz(): that one shows a trend, this shows exactly
// how many independent samples back the Mean value on screen right now.
// Always ≥ 1 (see the i==0-unconditional note in gsr_sensor_tick()).
int32_t gsr_sensor_get_window_samples(const GsrSensor* gsr) {
    CORE_CHECK(gsr, "GsrSensor: NULL in get_window_samples()");
    // Cross-thread (GUI render thread reads what tick() writes on the main
    // thread) — see gsr_sensor_get_mean_count()'s comment.
    gsr_lock(gsr);
    int32_t val = gsr->tick_window_samples;
    gsr_unlock(gsr);
    return val;
}

// Standard deviation of the readings inside the most recent tick()'s
// window, in nS (see the spread note in gsr_sensor_tick()). For the debug
// columns.
float gsr_sensor_get_window_spread_ns(const GsrSensor* gsr) {
    CORE_CHECK(gsr, "GsrSensor: NULL in get_window_spread_ns()");
    gsr_lock(gsr);
    float val = gsr->tick_spread_ns;
    gsr_unlock(gsr);
    return val;
}

uint8_t gsr_sensor_get_pga_index(const GsrSensor* gsr) {
    CORE_CHECK(gsr, "GsrSensor: NULL in get_pga_index()");
    gsr_lock(gsr);
    uint8_t val = gsr->pga_index;
    gsr_unlock(gsr);
    return val;
}

float gsr_sensor_get_bias_volts(const GsrSensor* gsr) {
    CORE_CHECK(gsr, "GsrSensor: NULL in get_bias_volts()");
    gsr_lock(gsr);
    float val = gsr->bias_volts;
    gsr_unlock(gsr);
    return val;
}

float gsr_sensor_get_bias_measured_volts(const GsrSensor* gsr) {
    CORE_CHECK(gsr, "GsrSensor: NULL in get_bias_measured_volts()");
    gsr_lock(gsr);
    float val = gsr->bias_measured_volts;
    gsr_unlock(gsr);
    return val;
}

uint32_t gsr_sensor_request_bias_check(GsrSensor* gsr) {
    CORE_CHECK(gsr, "GsrSensor: NULL in request_bias_check()");
    gsr_lock(gsr);
    gsr->bias_check_requested = true;
    uint32_t ticket = gsr->bias_check_seq;
    gsr_unlock(gsr);
    return ticket;
}

bool gsr_sensor_bias_check_done(const GsrSensor* gsr, uint32_t ticket) {
    CORE_CHECK(gsr, "GsrSensor: NULL in bias_check_done()");
    gsr_lock(gsr);
    bool done = gsr->bias_check_seq != ticket;
    gsr_unlock(gsr);
    return done;
}

void gsr_sensor_cancel_bias_check(GsrSensor* gsr) {
    CORE_CHECK(gsr, "GsrSensor: NULL in cancel_bias_check()");
    gsr_lock(gsr);
    gsr->bias_check_requested = false;
    gsr_unlock(gsr);
}

bool gsr_sensor_run_bias_check(GsrSensor* gsr, uint32_t timeout_ms) {
    CORE_CHECK(gsr, "GsrSensor: NULL in run_bias_check()");
    uint32_t ticket = gsr_sensor_request_bias_check(gsr);
    uint32_t wait_start = gsr_now(gsr);
    bool done;
    while(!(done = gsr_sensor_bias_check_done(gsr, ticket)) &&
          gsr_now(gsr) - wait_start < timeout_ms) {
        gsr_delay_ms(gsr, 1);
    }
    if(!done) {
        gsr_sensor_cancel_bias_check(gsr);
        // It may have finished between the last poll and the cancel; then
        // its reading is real (and already in use), so report it.
        done = gsr_sensor_bias_check_done(gsr, ticket);
        if(!done) gsr_log(gsr, true, "Bias check timed out");
    }
    return done;
}

// Measured worker throughput in Hz, over a rolling ~1 s window — the true
// rate at which gsr_sensor_tick()'s ~100 ms boxcar average is actually
// filling with samples. Updated by gsr_sensor_tick() (main thread only);
// reads 0.0f until the first ~1 s window has elapsed. See
// research/gsr_filtering_analysis.md, Recommendation 1.
float gsr_sensor_get_worker_hz(const GsrSensor* gsr) {
    CORE_CHECK(gsr, "GsrSensor: NULL in get_worker_hz()");
    // Cross-thread — see gsr_sensor_get_mean_count()'s comment.
    gsr_lock(gsr);
    float val = gsr->worker_hz_cached;
    gsr_unlock(gsr);
    return val;
}

// Percentage of I2C read attempts that succeeded, over the same rolling
// ~1 s window as gsr_sensor_get_worker_hz(). Distinguishes "the worker
// loop genuinely only runs this fast" (success_rate near 100%) from "the
// loop runs faster but many reads silently fail" (success_rate well below
// 100% — a real transport/wiring problem, not a rate limit). Reads 100.0f
// until the first window has elapsed (optimistic default, not a claim).
float gsr_sensor_get_success_rate(const GsrSensor* gsr) {
    CORE_CHECK(gsr, "GsrSensor: NULL in get_success_rate()");
    // Cross-thread — see gsr_sensor_get_mean_count()'s comment.
    gsr_lock(gsr);
    float val = gsr->success_rate_cached;
    gsr_unlock(gsr);
    return val;
}

// Percentage of successful reads, over the same rolling ~1 s window as
// gsr_sensor_get_worker_hz(), whose raw ADC code exactly matched the
// immediately preceding successful read. This can mean either a stale
// re-read of a conversion the ADS1115 hadn't yet updated, or two genuinely
// fresh conversions of a signal that hasn't moved between them — the counter
// can't tell them apart. Measured ~12-16% with the sensor disconnected
// (near-DC) vs. ~7-11% with a live signal connected; see
// research/gsr_filtering_analysis.md and duplicate_count's doc comment. Resets
// across PGA changes (a gain change isn't a stale read). Reads 0.0f until
// the first window has elapsed (optimistic default, not a claim).
float gsr_sensor_get_duplicate_rate(const GsrSensor* gsr) {
    CORE_CHECK(gsr, "GsrSensor: NULL in get_duplicate_rate()");
    // Cross-thread — see gsr_sensor_get_mean_count()'s comment.
    gsr_lock(gsr);
    float val = gsr->duplicate_rate_cached;
    gsr_unlock(gsr);
    return val;
}

// Percentage of successful reads over the rolling ~1 s window whose
// inter-read gap was under 2 ms (< 1.16 ms conversion period) and resulted
// in a stale re-read of the ADS1115 register.
float gsr_sensor_get_stale_rate(const GsrSensor* gsr) {
    CORE_CHECK(gsr, "GsrSensor: NULL in get_stale_rate()");
    // Cross-thread — see gsr_sensor_get_mean_count()'s comment.
    gsr_lock(gsr);
    float val = gsr->stale_rate_cached;
    gsr_unlock(gsr);
    return val;
}

// Live count of consecutive failed I2C reads happening right now — not a
// rolling average like gsr_sensor_get_success_rate(), so it can show a
// fresh failure streak building in real time, before either the 1 s
// success-rate average visibly drops or the 50-failure disconnect
// threshold (gsr_sensor_worker_pass()) actually fires. For diagnostics.
uint32_t gsr_sensor_get_consecutive_failures(const GsrSensor* gsr) {
    CORE_CHECK(gsr, "GsrSensor: NULL in get_consecutive_failures()");
    gsr_lock(gsr);
    uint32_t val = gsr->consecutive_failures;
    gsr_unlock(gsr);
    return val;
}

// Smallest inter-read gap in ms seen SPECIFICALLY at a sample that turned
// out to be a duplicate (see gsr_sensor_get_duplicate_rate()), over the
// same rolling ~1 s window as gsr_sensor_get_worker_hz(). Directly
// correlates timing with the specific reads that were actually stale —
// the real test of the "occasional sub-ADC-conversion-time loop period"
// theory. Each timestamp is a floor() of the real time it was taken, so a
// recorded gap of N ms corresponds to a true elapsed time anywhere
// from just over (N-1) ms to just under (N+1) ms. Returns UINT32_MAX if
// no duplicates occurred in the most recent window (not 0 — a real value
// of 0 is itself meaningful and must stay distinguishable from "no
// data"), or if unavailable.  For diagnostics.
uint32_t gsr_sensor_get_duplicate_gap_min_ms(const GsrSensor* gsr) {
    CORE_CHECK(gsr, "GsrSensor: NULL in get_duplicate_gap_min_ms()");
    // Cross-thread — see gsr_sensor_get_mean_count()'s comment.
    gsr_lock(gsr);
    uint32_t val = gsr->duplicate_gap_min_cached;
    gsr_unlock(gsr);
    return val;
}

// Number of PGA (autorange) changes applied in the most recent rolling
// ~1 s window — same cadence as gsr_sensor_get_worker_hz(). Signals "the
// input is sitting near an autorange threshold and flapping between
// ranges". For diagnostics.
uint32_t gsr_sensor_get_pga_change_count(const GsrSensor* gsr) {
    CORE_CHECK(gsr, "GsrSensor: NULL in get_pga_change_count()");
    // Cross-thread — see gsr_sensor_get_mean_count()'s comment.
    gsr_lock(gsr);
    uint32_t val = gsr->pga_change_rate_cached;
    gsr_unlock(gsr);
    return val;
}

// Worst single I2C call duration (config write OR conversion read, real
// clock delta) ever observed on the worker thread — lifetime
// max, never reset. See i2c_peak_ms's struct comment for why one column
// covers both call sites. For diagnostics.
uint32_t gsr_sensor_get_i2c_peak_ms(const GsrSensor* gsr) {
    CORE_CHECK(gsr, "GsrSensor: NULL in get_i2c_peak_ms()");
    gsr_lock(gsr);
    uint32_t val = gsr->i2c_peak_ms;
    gsr_unlock(gsr);
    return val;
}


// ─────────────────────────────────────────────────────────────────────────────
// Oversampling & Filtering
//
// Each ~10 Hz tick walks the ring buffer backward from the most recent
// entry, accumulating the entries timestamped less than BOXCAR_WINDOW_MS
// (100 ms) before it, and averages exactly those. Time-based, not a fixed
// sample count (research/gsr_filtering_analysis.md, Recommendation 1b): a
// fixed count is only 100 ms at one particular read rate, and the rate
// differs between devices, so a count would stretch or shrink the window
// and lose the mains null below.
//
// The worker's pace is the device's 1 ms pause between passes, and the two
// devices differ:
//   - Flipper: furi_delay_ms(1) really waits two kernel ticks (it adds one
//     to make sure of at least 1 ms), so it reads every 2 ms, about 500
//     times a second. That is slower than the ADS1115's 860 conversions a
//     second, so each entry is a different conversion and about 42 % of
//     conversions are never read.
//   - Cardputer: vTaskDelay(1) waits one tick, so it reads every 1 ms,
//     about 1000 times a second. That is faster than the conversions, so
//     about 14 % of entries are the same conversion read again.
// Both are fine for the mean. A repeat adds nothing new, it only counts
// that conversion twice, so the Cardputer's window of ~100 entries holds
// about 1.6 times as many independent conversions as the Flipper's ~50,
// and the ADC's own noise in its mean is a little lower.
//
// A window of exactly 100 ms nulls 50/60 Hz mains hum (5 × 20 ms,
// 6 × 16.67 ms) however many entries fill it. Entries are timestamped to
// the whole millisecond, so the window is counted back from the newest
// entry and stops short of 100 ms: entries 1 ms apart give exactly 100,
// 2 ms apart exactly 50. Counting a full 100 ms back from "now" instead
// takes in one entry too many whenever the newest was read in the tick's
// own millisecond: a 101 or 102 ms window that lets about 1–2 % of the hum
// through. What is left (a few tenths of a percent, depending on how far
// the chip's own clock is from exactly 860 conversions a second) comes
// from the conversions not lining up with the reads.
// ─────────────────────────────────────────────────────────────────────────────

void gsr_sensor_tick(GsrSensor* gsr) {
    // Called every tick (10Hz) from the main thread during recording — the
    // single highest-frequency call site in this file.
    CORE_CHECK(gsr, "GsrSensor: NULL in tick()");

    // ── Roll the worker-Hz measurement window (~1 s) ────────────────────
    // Deliberately independent of the i2c_ok early-return below — if the
    // sensor is disconnected, the rate should visibly drop toward zero on
    // the Diagnostics screen rather than freezing at its last good value.
    uint32_t now = gsr_now(gsr);
    if(now - gsr->hz_window_start_tick >= 1000) {
        gsr_lock(gsr);
        uint32_t count = gsr->iter_count;
        uint32_t attempts = gsr->attempt_count;
        uint32_t duplicates = gsr->duplicate_count;
        uint32_t stale = gsr->stale_count;
        // Read-and-reset must happen in the same critical section — a
        // separate read then a separate reset would race against the
        // worker updating it in between, potentially discarding a
        // just-recorded minimum that belonged to THIS window.
        uint32_t dup_gap_min = gsr->duplicate_gap_running_min;
        gsr->duplicate_gap_running_min = UINT32_MAX;
        gsr_unlock(gsr);

        uint32_t window_ticks = now - gsr->hz_window_start_tick;
        uint32_t delta = count - gsr->hz_window_start_count;
        uint32_t delta_attempts = attempts - gsr->hz_window_start_attempts;
        uint32_t delta_duplicates = duplicates - gsr->hz_window_start_duplicates;
        uint32_t delta_stale = stale - gsr->hz_window_start_stale;
        float worker_hz = (float)delta * 1000.0f / (float)window_ticks;
        float success_rate =
            (delta_attempts > 0) ? (100.0f * (float)delta / (float)delta_attempts) : 100.0f;
        float duplicate_rate =
            (delta > 0) ? (100.0f * (float)delta_duplicates / (float)delta) : 0.0f;
        float stale_rate =
            (delta > 0) ? (100.0f * (float)delta_stale / (float)delta) : 0.0f;

        // Published under gsr->mutex — these *_cached fields are read
        // cross-thread by the Diagnostics screen's accessors
        // (gsr_sensor_get_worker_hz() etc.) from the GUI render thread
        // (core/biomap_screen.c is their only caller). hz_window_start_* stay
        // outside the lock: tick()-only, never read by any accessor.
        gsr_lock(gsr);
        gsr->worker_hz_cached = worker_hz;
        gsr->success_rate_cached = success_rate;
        gsr->duplicate_rate_cached = duplicate_rate;
        gsr->stale_rate_cached = stale_rate;
        gsr->duplicate_gap_min_cached = dup_gap_min; // UINT32_MAX = no duplicates this window
        gsr->pga_change_rate_cached = gsr->pga_change_count - gsr->hz_window_start_pga_changes;
        gsr_unlock(gsr);

        gsr->hz_window_start_tick = now;
        gsr->hz_window_start_count = count;
        gsr->hz_window_start_attempts = attempts;
        gsr->hz_window_start_duplicates = duplicates;
        gsr->hz_window_start_stale = stale;
        gsr->hz_window_start_pga_changes = gsr->pga_change_count;
    }

    gsr_lock(gsr);
    bool i2c_ok = gsr->i2c_working;
    gsr_unlock(gsr);

    if(!i2c_ok) return;

    // ── Step 1: sum every buffer entry timestamped less than
    // BOXCAR_WINDOW_MS before the newest one, walking backward from the
    // most recent write. No intermediate array — the simple mean doesn't
    // need sorting, so one pass is enough. Also snapshot the single
    // most-recent count for get_raw_sample_ns().
    //
    // The newest entry (i == 0) is always included, so `samples` can never
    // be 0 and the divide below is safe. Capped at SENSOR_BUFFER_SIZE
    // iterations so a pathological timestamp can't spin forever: a window
    // holds about 100 entries on the Cardputer and 50 on the Flipper, under
    // the buffer's 128.
    gsr_lock(gsr);
    uint32_t r_idx = gsr->write_idx;
    uint32_t now_tick = gsr_now(gsr);
    // Measured back from the newest entry, and short of a full window: see
    // "A window of exactly 100 ms" in the notes above.
    uint32_t newest_tick = gsr->sample_tick[(r_idx - 1) & (SENSOR_BUFFER_SIZE - 1)];
    int64_t sum = 0;
    int64_t sum_sq = 0; // for the spread: |v| < 2^20 and < 128 entries, so no overflow
    int samples = 0;
    for(int i = 0; i < SENSOR_BUFFER_SIZE; i++) {
        r_idx = (r_idx - 1) & (SENSOR_BUFFER_SIZE - 1);
        if(i > 0 && (newest_tick - gsr->sample_tick[r_idx] >= BOXCAR_WINDOW_MS)) break;
        int32_t v = gsr->buffer[r_idx];
        sum += v;
        sum_sq += (int64_t)v * v;
        if(i == 0) {
            gsr->tick_last_norm = v;  // snapshot for raw-sample compare
        }
        samples++;
    }
    uint8_t old_pga = gsr->pga_index;
    bool active = gsr->cal_active;
    float gain = gsr->cal_gain;
    float zero_counts = gsr->cal_zero_counts;
    float bias_scale = gsr->bias_scale;
    gsr_unlock(gsr);

    // ── Step 2: simple mean over the window's entries (about 100 on the
    // Cardputer, 50 on the Flipper; see Oversampling & Filtering above).
    float avg_norm = (float)sum / (float)samples;

    // Published under gsr->mutex — these tick_* fields are read cross-thread
    // by the Diagnostics screen's accessors from the GUI render thread, same
    // as the hz-window block above.
    gsr_lock(gsr);
    gsr->tick_mean_norm = (int32_t)lroundf(avg_norm);  // diagnostics + the wizard's zero step (rounded: truncation would bias a negative zero by ~0.5 count)
    gsr->tick_window_samples = samples;       // snapshot for diagnostics
    gsr_unlock(gsr);

    // ── Step 3: autoranging decision on the RAW (uncalibrated) value.
    // Calibration is applied in the nS domain after TIA conversion —
    // applying it here would skew the PGA switching thresholds.
    // A repeat of the last counted window (a catch-up tick) changes no
    // counts and no gain: see RANGING-UP HYSTERESIS.
    bool counted = !gsr->counted_once || now_tick - gsr->counted_ms >= COUNTED_WINDOW_GAP_MS;
    if(counted) {
        gsr->counted_once = true;
        gsr->counted_ms = now_tick;
    }
    uint8_t new_pga = old_pga;
    int32_t hw_equiv = (int32_t)(avg_norm / (float)NORM_FACTOR[old_pga]);
    int32_t abs_hw_equiv = (hw_equiv < 0) ? -hw_equiv : hw_equiv;

    if(!counted) {
        // no change
    } else if(abs_hw_equiv >= ADS_SATURATE_THRESH && new_pga > ADS_PGA_MIN) {
        new_pga--;
        gsr->low_count = 0;
    } else if(abs_hw_equiv < ADS_LOW_THRESH && new_pga < ADS_PGA_MAX) {
        if(++gsr->low_count >= ADS_LOW_COUNT_TICKS) {
            new_pga++;
            gsr->low_count = 0;
        }
    } else {
        gsr->low_count = 0;
    }

    bool pga_update = (new_pga != old_pga);

    // ── Step 4: TIA conversion — raw normalised counts → nanosiemens.
    // Calibration (if active): the open-circuit zero is removed in counts,
    // BEFORE the TIA conversion — the board's zero error is a fixed voltage
    // at the ADC, and the TIA equation is not linear in counts, so removing
    // it afterwards in nS would be wrong. The gain is applied after.
    // The whole calibrated value is also what disconnect detection (Step 5
    // below) checks: with the zero removed, an open circuit reads ~0 nS
    // whatever the board's zero error.
    float counts = active ? avg_norm - zero_counts : avg_norm;
    float raw_ns = gsr_tia_counts_to_ns_at_bias(counts, bias_scale);
    if(active) raw_ns *= gain;

    // How far the window's readings spread around their mean (standard
    // deviation), turned into nS with the conversion's slope at this
    // reading. Mains hum that the mean cancels still shows here, and so
    // does a burst of odd readings inside one window. Repeat reads of one
    // conversion count once per read, as they do in the mean.
    float spread_ns = 0.0f;
    if(samples > 1) {
        int64_t n_var = (int64_t)samples * sum_sq - sum * sum; // n² × variance, exact
        float sd_counts = n_var > 0
            ? sqrtf((float)n_var / ((float)samples * (float)(samples - 1)))
            : 0.0f;
        float ns_per_count = gsr_tia_counts_to_ns_at_bias(counts + 0.5f, bias_scale) -
                             gsr_tia_counts_to_ns_at_bias(counts - 0.5f, bias_scale);
        spread_ns = sd_counts * ns_per_count * (active ? gain : 1.0f);
    }

    // ── Step 5: publish pga_index, pga_changed, and calibrated raw under
    // a single mutex acquisition to minimise contention with the worker.
    gsr_lock(gsr);
    if(pga_update) {
        gsr->pga_index = new_pga;
        gsr->pga_changed = true;
        gsr->pga_change_count++; // tick()-only field, safe to touch under this mutex acquisition
    }
    gsr->raw = raw_ns;
    gsr->tick_spread_ns = spread_ns;

    // ── Finger-cuff disconnect detection (20-tick debounce).
    if(!counted) {
        // no change
    } else if(raw_ns < GSR_VALID_MIN_NS || raw_ns > GSR_VALID_MAX_NS) {
        if(++gsr->zero_count >= 20) {
            gsr->connected = false;
        }
    } else {
        gsr->zero_count = 0;
        gsr->connected = true;
    }
    gsr_unlock(gsr);

    // Logged after the unlock: a slow log (a serial link) must not hold up
    // the worker, which needs the lock for every sample.
    if(pga_update) {
        gsr_log(gsr, false, "PGA %u→%u (±%s)",
            (unsigned)old_pga, (unsigned)new_pga, PGA_LABEL[new_pga]);
    }
}

void gsr_sensor_set_calibration(GsrSensor* gsr, bool active, float gain, float zero_counts) {
    CORE_CHECK(gsr, "GsrSensor: NULL in set_calibration()");
    gsr_lock(gsr);
    gsr->cal_active = active;
    gsr->cal_gain = gain;
    gsr->cal_zero_counts = zero_counts;
    gsr_unlock(gsr);
}
