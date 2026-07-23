// GSR Sensor — ADS1115 I2C differential reader with PGA autoranging.
// Signal processing (EMA, derivative) is deferred to the main app.

#include "gsr_sensor.h"
#include <furi.h>
#include <furi_hal.h>
#include <stdlib.h>
#include <math.h>

// ─────────────────────────────────────────────────────────────────────────────
// TIA conversion: normalized ADC counts → nanosiemens
//
// Transimpedance amplifier circuit equation.  Clamped at 319000 counts
// (≈rail saturation).  Constants: 5×10⁶ numerator, 1.504×10⁷ − 47×counts
// denominator.  Used by both tick() and get_raw_sample_ns() — defined
// here as file-local static inline so the two call sites share one copy.
// ─────────────────────────────────────────────────────────────────────────────
static inline float tia_counts_to_ns(float counts) {
    if(counts <= 0.0f) return 0.0f;
    if(counts > 319000.0f) counts = 319000.0f;
    return (counts * 5000000.0f) / (15040000.0f - counts * 47.0f);
}

// ─────────────────────────────────────────────────────────────────────────────
// ADS1115 register addresses
// ─────────────────────────────────────────────────────────────────────────────
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
// DELAY AFTER PGA CHANGE
//   The ADS1115 is a delta-sigma ADC in continuous mode at 860 SPS.  After
//   writing a new config, the current conversion in the register was started
//   under the OLD setting (~1.16 ms old).  The worker skips that stale read
//   and waits 2 ms (> 1.16 ms) so the next iteration reads the first
//   fully-settled conversion under the new PGA — preventing single-sample
//   glitches where the signal suddenly halved or doubled.
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
// OUTPUT NORMALISATION
//   gsr_sensor_get_raw() returns counts normalised to the pga_index=5 (±0.256 V)
//   reference where 1 unit = 7.8125 µV.  This preserves 100 % of the hardware's
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
// ─────────────────────────────────────────────────────────────────────────────

#define ADS_PGA_DEFAULT       2
#define ADS_PGA_MIN           0
#define ADS_PGA_MAX           5
#define ADS_SATURATE_THRESH   30000  // 91.5 % of FS → range down immediately
#define ADS_LOW_THRESH         4096  // 12.5 % of FS → range up candidate
#define ADS_LOW_COUNT_TICKS       5  // consecutive low ticks before range up

// Target duration of gsr_sensor_tick()'s averaging window. Time-based
// (see docs/gsr_filtering_analysis.md, Recommendation 1b) rather than a
// fixed sample count — a fixed N=100 was only actually ~100 ms when the
// worker's true rate was ~1000 Hz, which measurement showed it wasn't
// (~500 Hz measured on real hardware, giving a ~200 ms window instead).
#define BOXCAR_WINDOW_MS  100

// Target frequency for the on-device mains-hum content estimator (see
// gsr_sensor_get_mains_50hz_mag()). Fixed at 50 Hz — the diagnostics
// screen has room for one, and the boxcar's exact-null property already
// covers both 50 and 60 Hz identically by construction (Recommendation
// 1b), so this is purely about giving a visible, measured answer to "is
// there real mains-hum content in the raw signal", not about validating
// one mains frequency over the other.
#define MAINS_HUM_TARGET_HZ  50.0f
#define GSR_PI  3.14159265358979323846f

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

// ─────────────────────────────────────────────────────────────────────────────
// Struct & Constants
// ─────────────────────────────────────────────────────────────────────────────

// Compile-time guard: the ring buffer uses & (SENSOR_BUFFER_SIZE - 1) which
// only works for powers of two.
_Static_assert((SENSOR_BUFFER_SIZE & (SENSOR_BUFFER_SIZE - 1)) == 0,
               "SENSOR_BUFFER_SIZE must be a power of two");

struct GsrSensor {
    float   raw;        // skin conductance in nanosiemens (nS)
    bool    available;
    bool    connected;  // false after 20+ ticks of zero readings (cuffs disconnected)
    bool    i2c_working; // false when consecutive I2C reads fail
    uint8_t pga_index;  // active PGA setting (0 … ADS_PGA_MAX)
    uint8_t low_count;  // consecutive ticks below ADS_LOW_THRESH
    uint8_t zero_count; // consecutive ticks with raw == 0.0f
    int8_t  pga_locked; // -1 = autoranging; 0–5 = fixed PGA (diagnostic lock)
    bool    cal_active; // true when custom calibration is active
    float   cal_gain;   // linear calibration gain factor (default 1.0)
    float   cal_offset; // linear calibration offset in counts (default 0.0)
    int32_t tick_last_norm; // raw normalized count at tick's last-summed index
                             // (snapshotted during tick, used by get_raw_sample_ns)
    int32_t tick_mean_norm; // ~100 ms window mean normalized count (pre-TIA)
    int32_t tick_window_samples; // how many buffer entries landed in that window
    int32_t  tick_window_ptp;      // max-min of the window's raw counts (peak-to-peak)
    uint32_t tick_window_min_gap;  // smallest inter-sample tick gap seen in the window
    float    tick_mains_hum_mag;   // per-sample-timestamp correlation amplitude at
                                    // MAINS_HUM_TARGET_HZ — see gsr_sensor_get_mains_hum_mag()
    uint32_t pga_change_count;         // tick()-only — total PGA changes applied, lifetime
    uint32_t hz_window_start_pga_changes; // pga_change_count snapshot — tick() only
    uint32_t pga_change_rate_cached;      // tick() only — PGA changes in the last ~1 s window

    FuriThread* thread;
    FuriMutex*  mutex;
    volatile bool running;
    volatile bool pga_changed;

    int32_t  buffer[SENSOR_BUFFER_SIZE];
    uint32_t sample_tick[SENSOR_BUFFER_SIZE]; // tick timestamp of buffer[i], for
                                               // time-based (not count-based) averaging
                                               // in gsr_sensor_tick() — see Recommendation
                                               // 1b in docs/gsr_filtering_analysis.md
    volatile uint32_t write_idx;

    // Worker throughput diagnostics (see docs/gsr_filtering_analysis.md,
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
    // docs/gsr_filtering_analysis.md.
    //
    // Measured on real hardware (2026-07-23): ~7-11% with a live skin
    // conductance signal connected, ~12-16% with the sensor disconnected
    // (open circuit). NOT near 0% as the "worker rate is below 860 SPS,
    // so every read should be fresh" reasoning originally predicted here
    // — that reasoning was wrong (or at least incomplete): this counter
    // can't distinguish a genuinely stale re-read from two fresh
    // conversions of a signal that simply hasn't changed between them,
    // which is why the disconnected (near-DC, no real noise source)
    // reading is higher than the connected one. The remaining ~7-11%
    // under a real signal is still unexplained — per-iteration timing
    // jitter in furi_delay_ms(1)'s tick-aliasing (see the pacing comment
    // in gsr_sensor_worker()) occasionally producing a loop period under
    // the ADC's ~1.16 ms conversion time is the leading candidate, not
    // yet isolated. Reset to 0 (via have_last_hw = false in the worker)
    // on every PGA change, since a gain change makes the previous
    // reading's raw code incomparable to the new one — that's a scale
    // change, not evidence of a stale read.
    uint32_t duplicate_count;
    // duplicate_gap_running_min — mutex-protected. Worker tracks the
    // smallest inter-read tick gap seen specifically AT a duplicate
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
    float    worker_hz_cached;      // tick() only — successful-sample rate
    float    success_rate_cached;   // tick() only — iter_count/attempt_count over the same window, 0-100
    float    duplicate_rate_cached; // tick() only — duplicate_count/iter_count over the same window, 0-100

    // Live (not rolling-window) count of consecutive failed I2C reads —
    // mutex-protected, mirrors the worker's local consecutive_failures.
    // Published so the accessor can show "how close to the 50-failure
    // disconnect threshold right now", which a ~1 s rolling success_rate
    // average can't: success_rate can still read e.g. 80% while a fresh
    // failure streak is actively building toward disconnect. Only
    // written on failure, and once on recovery (not every successful
    // iteration) — see gsr_sensor_worker() — to avoid taking the mutex
    // on every single normal-operation read just to publish a 0.
    uint32_t consecutive_failures;
};

// Background worker thread for 860 SPS ADC reading.  Writes normalized
// samples to the ring buffer; the main thread's gsr_sensor_tick() handles
// decimation, autoranging, and TIA computation at exact 10 Hz boundaries.
static int32_t gsr_sensor_worker(void* context) {
    GsrSensor* gsr = context;
    uint8_t current_adc_pga = ADS_PGA_DEFAULT;
    uint32_t consecutive_failures = 0;
    int16_t  last_hw = 0;
    bool     have_last_hw = false; // no prior read to compare the first one against
    uint32_t last_read_tick = 0;   // paired with have_last_hw — valid whenever it's true

    while(gsr->running) {
        furi_mutex_acquire(gsr->mutex, FuriWaitForever);
        uint8_t active_pga = gsr->pga_index;
        bool pga_changed = gsr->pga_changed;
        furi_mutex_release(gsr->mutex);

        // ── PGA change path: acquire I2C, write config, release, always ──
        // continue back to the top — never fall through to the read path
        // or the I2C handle will be released twice.
        if(pga_changed) {
            furi_hal_i2c_acquire(&furi_hal_i2c_handle_external);
            uint8_t cfg[2] = { pga_msb(active_pga), 0xE3 };
            bool cfg_ok = furi_hal_i2c_write_mem(
                &furi_hal_i2c_handle_external,
                ADS1115_I2C_ADDR, ADS1115_CONFIG_REG,
                cfg, 2, 50);
            furi_hal_i2c_release(&furi_hal_i2c_handle_external);

            if(cfg_ok) {
                furi_mutex_acquire(gsr->mutex, FuriWaitForever);
                gsr->pga_changed = false;
                furi_mutex_release(gsr->mutex);

                // Wait for the first fully-settled conversion under the new
                // PGA.  At 860 SPS conversion takes 1.16 ms; 2 ms guarantees
                // the next read returns a new-PGA result.
                furi_delay_ms(2);
                current_adc_pga = active_pga;
                have_last_hw = false; // new gain scale — not comparable to the pre-change code
            } else {
                // Config write failed — retry next iteration.
                furi_delay_ms(1);
            }
            continue;
        }

        // ── Normal read path: acquire I2C, read conversion, release. ────
        furi_hal_i2c_acquire(&furi_hal_i2c_handle_external);
        uint8_t data[2];
        bool ok = furi_hal_i2c_read_mem(
            &furi_hal_i2c_handle_external,
            ADS1115_I2C_ADDR, ADS1115_CONV_REG,
            data, 2, 50);
        furi_hal_i2c_release(&furi_hal_i2c_handle_external);

        // Counts every attempt, success or failure — distinguishes "the
        // loop genuinely only runs this fast" from "the loop runs fast
        // but half the reads silently fail" (iter_count alone can't tell
        // these apart; see docs/gsr_filtering_analysis.md).
        furi_mutex_acquire(gsr->mutex, FuriWaitForever);
        gsr->attempt_count++;
        furi_mutex_release(gsr->mutex);

        if(ok) {
            if(consecutive_failures != 0) {
                consecutive_failures = 0;
                furi_mutex_acquire(gsr->mutex, FuriWaitForever);
                gsr->consecutive_failures = 0;
                furi_mutex_release(gsr->mutex);
            }
            if(!gsr->i2c_working) {
                furi_mutex_acquire(gsr->mutex, FuriWaitForever);
                gsr->i2c_working = true;
                furi_mutex_release(gsr->mutex);
            }
            int16_t hw = (int16_t)((data[0] << 8) | data[1]);

            // Normalize using current_adc_pga (the gain that was active
            // when the conversion currently in the register was started).
            int32_t norm = (int32_t)hw * NORM_FACTOR[current_adc_pga];

            // Same raw code as the immediately preceding (same-PGA) read
            // means the ADS1115 hadn't completed a new conversion between
            // the two I2C transactions — a stale re-read, not a fresh
            // sample. See duplicate_count's doc comment above.
            uint32_t this_tick = furi_get_tick();
            bool is_duplicate = have_last_hw && (hw == last_hw);
            // Only meaningful (and only ever read) when is_duplicate is
            // true, which requires have_last_hw — so last_read_tick is
            // always valid by the time it's actually used below.
            uint32_t gap_ticks = this_tick - last_read_tick;
            last_hw = hw;
            last_read_tick = this_tick;
            have_last_hw = true;

            furi_mutex_acquire(gsr->mutex, FuriWaitForever);
            gsr->buffer[gsr->write_idx] = norm;
            gsr->sample_tick[gsr->write_idx] = this_tick;
            gsr->write_idx = (gsr->write_idx + 1) & (SENSOR_BUFFER_SIZE - 1);
            gsr->iter_count++;
            if(is_duplicate) {
                gsr->duplicate_count++;
                if(gap_ticks < gsr->duplicate_gap_running_min) {
                    gsr->duplicate_gap_running_min = gap_ticks;
                }
            }
            furi_mutex_release(gsr->mutex);
        } else {
            consecutive_failures++;
            furi_mutex_acquire(gsr->mutex, FuriWaitForever);
            gsr->consecutive_failures = consecutive_failures;
            // After ~50 ms of continuous I2C failures, treat the sensor
            // as disconnected so the UI doesn't show a stale frozen value.
            if(consecutive_failures >= 50) {
                gsr->connected = false;
                gsr->i2c_working = false;
                gsr->raw = 0.0f;
            }
            furi_mutex_release(gsr->mutex);
        }

        // Track the PGA under which the next conversion will be started.
        // Only update when there is no pending (uncommitted) PGA change —
        // otherwise a failed I2C write would cause the next read to be
        // normalized with the wrong NORM_FACTOR.
        if(!pga_changed) {
            current_adc_pga = active_pga;
        }

        // Yield to the RTOS scheduler (~1000 Hz loop, nominally). Per its
        // own doc comment, furi_delay_ms(1) "aliases to scheduler timer
        // intervals" — real wait time is "X+ milliseconds", not X — and
        // measurement on real hardware (docs/gsr_filtering_analysis.md)
        // showed this loop actually only achieves ~500 Hz. furi_delay_us
        // would get the precise ~1 ms pacing, but it's documented as
        // "Blocking and non aliased" (Cortex DWT counter) — a genuine
        // busy-wait, not a scheduler yield, and was tried and reverted:
        // it monopolizes the (single application) CPU core for the full
        // wait instead of letting other threads run, which is exactly the
        // failure mode behind flipperdevices/flipperzero-firmware#3380
        // (a busy app thread starving the low-priority timer thread badly
        // enough to hang input processing). The ADS1115 converts
        // continuously at 860 SPS regardless of how often this loop reads
        // it — at the measured ~500 Hz (slower than 860 Hz), nearly every
        // read lands on a fresh conversion rather than re-reading a stale
        // one; the loop instead simply never reads roughly 42% of the
        // conversions the ADC produces. Skipped, not duplicated — either
        // way harmless to the mean: it just needs *some* representative
        // samples from the window, not every conversion. gsr_sensor_tick()'s
        // time-based averaging window (BOXCAR_WINDOW_MS, see above) means
        // correctness no longer depends on hitting any particular rate —
        // so there's no reason to trade scheduler cooperation for it.
        furi_delay_ms(1);
    }
    return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle
// ─────────────────────────────────────────────────────────────────────────────
GsrSensor* gsr_sensor_alloc(void) {
    GsrSensor* gsr = malloc(sizeof(GsrSensor));
    furi_assert(gsr);
    gsr->raw       = 0.0f;
    gsr->pga_index = ADS_PGA_DEFAULT;
    gsr->low_count = 0;
    gsr->connected = true;
    gsr->i2c_working = true;
    gsr->zero_count = 0;
    gsr->pga_locked = -1;  // autoranging enabled by default
    gsr->cal_active = false;
    gsr->cal_gain = 1.0f;
    gsr->cal_offset = 0.0f;

    furi_hal_i2c_acquire(&furi_hal_i2c_handle_external);
    uint8_t probe = 0;
    bool probed = furi_hal_i2c_read_mem(
        &furi_hal_i2c_handle_external,
        ADS1115_I2C_ADDR, ADS1115_CONV_REG,
        &probe, 1, 20);

    if(probed) {
        uint8_t cfg[2] = { pga_msb(ADS_PGA_DEFAULT), 0xE3 }; // Config: default PGA, continuous 860 SPS
        bool cfg_ok = furi_hal_i2c_write_mem(
            &furi_hal_i2c_handle_external,
            ADS1115_I2C_ADDR, ADS1115_CONFIG_REG,
            cfg, 2, 50);
        if(!cfg_ok) FURI_LOG_W("GsrSensor", "Config write failed — using defaults");
    }
    furi_hal_i2c_release(&furi_hal_i2c_handle_external);

    gsr->available = probed;
    FURI_LOG_I("GsrSensor", "Probe %s", probed ? "OK" : "not found");

    if(probed) {
        // Warm up buffer with initial value
        furi_delay_ms(5);
        furi_hal_i2c_acquire(&furi_hal_i2c_handle_external);
        uint8_t data[2];
        bool ok = furi_hal_i2c_read_mem(
            &furi_hal_i2c_handle_external,
            ADS1115_I2C_ADDR, ADS1115_CONV_REG,
            data, 2, 50);
        furi_hal_i2c_release(&furi_hal_i2c_handle_external);

        int16_t initial_hw = ok ? (int16_t)((data[0] << 8) | data[1]) : 0;
        int32_t initial_norm = (int32_t)initial_hw * NORM_FACTOR[ADS_PGA_DEFAULT];
        uint32_t alloc_tick = furi_get_tick();
        for(int i = 0; i < SENSOR_BUFFER_SIZE; i++) {
            gsr->buffer[i] = initial_norm;
            // Stamped with "now", not 0 — an uninitialized/zero timestamp
            // would make every warm-up slot look infinitely old to
            // gsr_sensor_tick()'s time-windowed average on the very first
            // call, which would then have zero samples to average.
            gsr->sample_tick[i] = alloc_tick;
        }
        gsr->write_idx = 0;

        gsr->mutex = furi_mutex_alloc(FuriMutexTypeNormal);
        furi_assert(gsr->mutex);

        gsr->iter_count = 0;
        gsr->attempt_count = 0;
        gsr->duplicate_count = 0;
        gsr->duplicate_gap_running_min = UINT32_MAX;
        gsr->duplicate_gap_min_cached = UINT32_MAX;
        gsr->consecutive_failures = 0;
        gsr->hz_window_start_tick = furi_get_tick(); // set before the worker starts — no lock needed
        gsr->hz_window_start_count = 0;
        gsr->hz_window_start_attempts = 0;
        gsr->hz_window_start_duplicates = 0;
        gsr->worker_hz_cached = 0.0f;
        gsr->success_rate_cached = 100.0f; // optimistic default until the first window rolls
        gsr->duplicate_rate_cached = 0.0f; // optimistic default until the first window rolls
        gsr->pga_change_count = 0;
        gsr->hz_window_start_pga_changes = 0;
        gsr->pga_change_rate_cached = 0;
        gsr->tick_window_ptp = 0;
        gsr->tick_window_min_gap = 0;
        gsr->tick_mains_hum_mag = 0.0f;

        gsr->running = true;
        gsr->pga_changed = false;
        gsr->thread = furi_thread_alloc();
        furi_thread_set_name(gsr->thread, "GsrSensorWorker");
        furi_thread_set_stack_size(gsr->thread, 1024);
        furi_thread_set_context(gsr->thread, gsr);
        furi_thread_set_callback(gsr->thread, gsr_sensor_worker);
        furi_thread_start(gsr->thread);
    }

    return gsr;
}

void gsr_sensor_free(GsrSensor* gsr) {
    furi_assert(gsr);
    if(gsr->available) {
        gsr->running = false;
        furi_thread_join(gsr->thread);
        furi_thread_free(gsr->thread);
        furi_mutex_free(gsr->mutex);
    }
    free(gsr);
}

// ─────────────────────────────────────────────────────────────────────────────
// Accessors
// ─────────────────────────────────────────────────────────────────────────────
bool gsr_sensor_available(const GsrSensor* gsr) {
    return gsr->available;
}

bool gsr_sensor_is_connected(const GsrSensor* gsr) {
    furi_assert(gsr);
    if(!gsr->available) return false;
    furi_mutex_acquire(gsr->mutex, FuriWaitForever);
    bool connected = gsr->connected;
    furi_mutex_release(gsr->mutex);
    return connected;
}

float gsr_sensor_get_raw(const GsrSensor* gsr) {
    furi_assert(gsr);
    if(!gsr->available) return 0.0f;
    furi_mutex_acquire(gsr->mutex, FuriWaitForever);
    float val = gsr->raw;
    furi_mutex_release(gsr->mutex);
    return val;
}

// ── Single-sample raw → nS (no decimation, no autoranging, no calibration) ──
// Uses the normalized count snapshotted by tick() from the same buffer
// position as the ~100 ms window's most recent entry.  This guarantees
// the raw sample and the filtered mean use the exact same underlying data.
float gsr_sensor_get_raw_sample_ns(const GsrSensor* gsr) {
    furi_assert(gsr);
    if(!gsr->available) return 0.0f;

    furi_mutex_acquire(gsr->mutex, FuriWaitForever);
    int32_t norm = gsr->tick_last_norm;
    furi_mutex_release(gsr->mutex);

    if(norm <= 0) return 0.0f;
    return tia_counts_to_ns((float)norm);
}

int32_t gsr_sensor_get_raw_sample_count(const GsrSensor* gsr) {
    furi_assert(gsr);
    if(!gsr->available) return 0;
    furi_mutex_acquire(gsr->mutex, FuriWaitForever);
    int32_t val = gsr->tick_last_norm;
    furi_mutex_release(gsr->mutex);
    return val;
}

int32_t gsr_sensor_get_mean_count(const GsrSensor* gsr) {
    furi_assert(gsr);
    if(!gsr->available) return 0;
    // tick_mean_norm is written by tick() on the same thread — no mutex needed
    return gsr->tick_mean_norm;
}

// How many ring-buffer entries landed inside the most recent tick()'s
// ~100 ms time window and were actually averaged into gsr_sensor_get_
// mean_count()'s result — the real-time counterpart to the rolling ~1 s
// gsr_sensor_get_worker_hz(): that one shows a trend, this shows exactly
// how many independent samples back the Mean value on screen right now.
// Always ≥ 1 (see the i==0-unconditional note in gsr_sensor_tick()).
int32_t gsr_sensor_get_window_samples(const GsrSensor* gsr) {
    furi_assert(gsr);
    if(!gsr->available) return 0;
    // tick_window_samples is written by tick() on the same thread — no mutex needed
    return gsr->tick_window_samples;
}

uint8_t gsr_sensor_get_pga_index(const GsrSensor* gsr) {
    furi_assert(gsr);
    if(!gsr->available) return ADS_PGA_DEFAULT;
    furi_mutex_acquire(gsr->mutex, FuriWaitForever);
    uint8_t val = gsr->pga_index;
    furi_mutex_release(gsr->mutex);
    return val;
}

// Measured worker throughput in Hz, over a rolling ~1 s window — the true
// rate at which gsr_sensor_tick()'s ~100 ms boxcar average is actually
// filling with samples. Updated by gsr_sensor_tick() (main thread only);
// reads 0.0f until the first ~1 s window has elapsed. See
// docs/gsr_filtering_analysis.md, Recommendation 1.
float gsr_sensor_get_worker_hz(const GsrSensor* gsr) {
    furi_assert(gsr);
    if(!gsr->available) return 0.0f;
    return gsr->worker_hz_cached;
}

// Percentage of I2C read attempts that succeeded, over the same rolling
// ~1 s window as gsr_sensor_get_worker_hz(). Distinguishes "the worker
// loop genuinely only runs this fast" (success_rate near 100%) from "the
// loop runs faster but many reads silently fail" (success_rate well below
// 100% — a real transport/wiring problem, not a rate limit). Reads 100.0f
// until the first window has elapsed (optimistic default, not a claim).
float gsr_sensor_get_success_rate(const GsrSensor* gsr) {
    furi_assert(gsr);
    if(!gsr->available) return 100.0f;
    return gsr->success_rate_cached;
}

// Percentage of successful reads, over the same rolling ~1 s window as
// gsr_sensor_get_worker_hz(), whose raw ADC code exactly matched the
// immediately preceding successful read. NOTE: this can mean either a
// stale re-read of a conversion the ADS1115 hadn't yet updated, OR two
// genuinely fresh conversions of a signal that just hasn't moved between
// them — the counter can't tell those apart, and real hardware
// measurement (2026-07-23) shows the difference matters: ~12-16% with
// the sensor disconnected (near-DC, no real signal to vary) vs. ~7-11%
// with a live skin conductance signal connected. Both are well above the
// "should be near 0% below 860 SPS" figure this comment originally
// predicted — see docs/gsr_filtering_analysis.md and duplicate_count's
// doc comment for what's still unexplained. Resets across PGA changes (a
// gain change isn't a stale read). Reads 0.0f until the first window has
// elapsed (optimistic default, not a claim).
float gsr_sensor_get_duplicate_rate(const GsrSensor* gsr) {
    furi_assert(gsr);
    if(!gsr->available) return 0.0f;
    return gsr->duplicate_rate_cached;
}

// Live count of consecutive failed I2C reads happening right now — not a
// rolling average like gsr_sensor_get_success_rate(), so it can show a
// fresh failure streak building in real time, before either the 1 s
// success-rate average visibly drops or the 50-failure disconnect
// threshold (gsr_sensor_worker()) actually fires. For diagnostics.
uint32_t gsr_sensor_get_consecutive_failures(const GsrSensor* gsr) {
    furi_assert(gsr);
    if(!gsr->available) return 0;
    furi_mutex_acquire(gsr->mutex, FuriWaitForever);
    uint32_t val = gsr->consecutive_failures;
    furi_mutex_release(gsr->mutex);
    return val;
}

// Peak-to-peak (max - min) of the raw normalized counts in the most
// recent tick()'s averaging window — a cheap, frequency-agnostic sense
// of instantaneous signal/noise range, independent of the mains-hum
// estimate below. For diagnostics.
int32_t gsr_sensor_get_window_ptp(const GsrSensor* gsr) {
    furi_assert(gsr);
    if(!gsr->available) return 0;
    // tick_window_ptp is written by tick() on the same thread — no mutex needed
    return gsr->tick_window_ptp;
}

// Smallest gap (in RTOS ticks, ~1 ms each) between two consecutive
// samples' timestamps anywhere in the most recent tick()'s window —
// general loop-pacing regularity, not tied to any specific sample.
// CAUTION on interpreting the value: each timestamp is a floor() of the
// real time it was taken, so a recorded gap of N ticks corresponds to a
// true elapsed time anywhere from just over (N-1) ms to just under
// (N+1) ms — e.g. a reading of 2 is consistent with a true minimum
// anywhere from ~1.0 ms to ~3.0 ms, which straddles the ADS1115's
// ~1.16 ms conversion time and so doesn't cleanly confirm or rule out
// the "loop occasionally runs fast enough to re-read a stale conversion"
// theory on its own. Real hardware (2026-07-23) measured this at 2 ticks
// in the same window Dup showed 18% — see
// gsr_sensor_get_duplicate_gap_min_ticks() for the more direct version
// of this question, which correlates the gap specifically with samples
// that turned out to be duplicates rather than comparing two independent
// aggregate numbers. For diagnostics.
uint32_t gsr_sensor_get_window_min_gap_ticks(const GsrSensor* gsr) {
    furi_assert(gsr);
    if(!gsr->available) return 0;
    // tick_window_min_gap is written by tick() on the same thread — no mutex needed
    return gsr->tick_window_min_gap;
}

// Smallest inter-read tick gap seen SPECIFICALLY at a sample that turned
// out to be a duplicate (see gsr_sensor_get_duplicate_rate()), over the
// same rolling ~1 s window as gsr_sensor_get_worker_hz(). Unlike
// gsr_sensor_get_window_min_gap_ticks() (the general per-window minimum,
// which may not even be adjacent to a duplicate), this directly
// correlates timing with the specific reads that were actually stale —
// the real test of the "occasional sub-ADC-conversion-time loop period"
// theory, rather than eyeballing whether two independent aggregate
// numbers seem consistent. Same tick-flooring caveat applies (see that
// function's doc comment). Returns UINT32_MAX if no duplicates occurred
// in the most recent window (not 0 — a real value of 0 is itself
// meaningful and must stay distinguishable from "no data"), or if
// unavailable.  For diagnostics.
uint32_t gsr_sensor_get_duplicate_gap_min_ticks(const GsrSensor* gsr) {
    furi_assert(gsr);
    if(!gsr->available) return UINT32_MAX;
    // duplicate_gap_min_cached is written by tick() on the same thread — no mutex needed
    return gsr->duplicate_gap_min_cached;
}

// Recovered amplitude, at MAINS_HUM_TARGET_HZ (50 Hz), of the raw
// (pre-averaging) samples in the most recent tick()'s window —
// normalized-count units, comparable to gsr_sensor_get_mean_count() and
// gsr_sensor_get_window_ptp(). Answers "how much real 50 Hz content is
// actually present in the raw signal", which is what the boxcar's
// mains-notch defends against; the notch's rejection itself isn't
// independently measurable here (it's a guaranteed property of the
// window's duration, not something to check post-averaging — 50 Hz
// aliases to exactly 0 Hz once decimated to the 10 Hz tick rate, so
// there's nothing meaningful to measure on the output side).
//
// Deliberately NOT a Goertzel filter — an earlier version was, using
// each sample's real timestamp only to pick a fixed coefficient assuming
// uniform spacing at the ~1 s rolling worker_hz. Real hardware
// (2026-07-23) measured that version reporting 103 counts of "50 Hz
// content" against a window whose total peak-to-peak was only 40 counts
// — physically impossible, since no single frequency component can
// exceed roughly half the signal's total peak-to-peak. Goertzel's
// recurrence has two poles exactly on the unit circle (marginally
// stable) and assumes uniform sample spacing; real sample timing is
// measurably uneven (get_window_min_gap_ticks()), and that combination
// inflates the reported energy. This version instead correlates directly
// against each sample's actual recorded timestamp — no resonant poles,
// no uniform-spacing assumption, correct for however unevenly the real
// samples are spaced. Meaningful from the very first tick (no longer
// needs worker_hz_cached to exist first). Reads 0.0f only if unavailable.
// For diagnostics.
float gsr_sensor_get_mains_hum_mag(const GsrSensor* gsr) {
    furi_assert(gsr);
    if(!gsr->available) return 0.0f;
    // tick_mains_hum_mag is written by tick() on the same thread — no mutex needed
    return gsr->tick_mains_hum_mag;
}

// Number of PGA (autorange) changes applied in the most recent rolling
// ~1 s window — same cadence as gsr_sensor_get_worker_hz(). Only counts
// changes tick()'s own autoranging logic applies (Step 5 in
// gsr_sensor_tick()), not manual gsr_sensor_lock_pga() calls, so this is
// specifically a signal for "the input is sitting near an autorange
// threshold and flapping between ranges" rather than counting deliberate
// diagnostic overrides. For diagnostics.
uint32_t gsr_sensor_get_pga_change_count(const GsrSensor* gsr) {
    furi_assert(gsr);
    if(!gsr->available) return 0;
    // pga_change_rate_cached is written by tick() on the same thread — no mutex needed
    return gsr->pga_change_rate_cached;
}

// ─────────────────────────────────────────────────────────────────────────────
// Oversampling & Filtering
//
// Each ~10 Hz tick walks the ring buffer backward from the most recent
// entry, accumulating samples whose timestamp falls within the last
// BOXCAR_WINDOW_MS (100 ms) of real elapsed time, and averages exactly
// those. Time-based, not a fixed sample count — see
// docs/gsr_filtering_analysis.md, Recommendation 1b. A fixed N=100 was
// only actually a 100 ms window when the worker's true rate happened to
// be ~1000 Hz; measurement on real hardware found it was actually
// ~500 Hz, silently doubling the window to ~200 ms and (worse) making
// consecutive ticks' windows overlap by half instead of being
// independent samples. This version gets the right window duration
// regardless of whatever the worker's true rate turns out to be, on any
// device, without needing to measure or hand-tune against it.
//
// The background worker's nominal pacing is furi_delay_ms(1), measured on
// real hardware at ~500 Hz true rate (see the pacing comment in
// gsr_sensor_worker() for why it's not exactly 1 kHz, and why that's left
// as-is) — below the ADS1115's 860 SPS conversion rate, so buffer entries
// are each (almost always) a distinct conversion rather than a duplicate
// of the previous one; the loop just never reads roughly 42% of the
// conversions the ADC produces in between. That's fine here: every
// sample that does land in the window is real, independent data, so the
// √samples noise-reduction estimate below isn't inflated by re-counted
// duplicates the way it would be if the worker ran faster than 860 Hz.
//
// A correctly-sized 100 ms window nominally nulls 50/60 Hz mains hum
// (5 × 20 ms, 6 × 16.67 ms) regardless of how many samples happen to fill
// it — that property depends on window duration, not sample count.
// ─────────────────────────────────────────────────────────────────────────────

void gsr_sensor_tick(GsrSensor* gsr) {
    furi_assert(gsr);
    if(!gsr->available) return;

    // ── Roll the worker-Hz measurement window (~1 s) ────────────────────
    // Deliberately independent of the i2c_ok early-return below — if the
    // sensor is disconnected, the rate should visibly drop toward zero on
    // the Diagnostics screen rather than freezing at its last good value.
    uint32_t now = furi_get_tick();
    uint32_t one_second_ticks = furi_kernel_get_tick_frequency();
    if(now - gsr->hz_window_start_tick >= one_second_ticks) {
        furi_mutex_acquire(gsr->mutex, FuriWaitForever);
        uint32_t count = gsr->iter_count;
        uint32_t attempts = gsr->attempt_count;
        uint32_t duplicates = gsr->duplicate_count;
        // Read-and-reset must happen in the same critical section — a
        // separate read then a separate reset would race against the
        // worker updating it in between, potentially discarding a
        // just-recorded minimum that belonged to THIS window.
        uint32_t dup_gap_min = gsr->duplicate_gap_running_min;
        gsr->duplicate_gap_running_min = UINT32_MAX;
        furi_mutex_release(gsr->mutex);

        uint32_t window_ticks = now - gsr->hz_window_start_tick;
        uint32_t delta = count - gsr->hz_window_start_count;
        uint32_t delta_attempts = attempts - gsr->hz_window_start_attempts;
        uint32_t delta_duplicates = duplicates - gsr->hz_window_start_duplicates;
        gsr->worker_hz_cached = (float)delta * (float)one_second_ticks / (float)window_ticks;
        gsr->success_rate_cached =
            (delta_attempts > 0) ? (100.0f * (float)delta / (float)delta_attempts) : 100.0f;
        gsr->duplicate_rate_cached =
            (delta > 0) ? (100.0f * (float)delta_duplicates / (float)delta) : 0.0f;
        gsr->duplicate_gap_min_cached = dup_gap_min; // UINT32_MAX = no duplicates this window
        // pga_change_count is tick()-only (written in Step 5 below), no mutex needed
        gsr->pga_change_rate_cached = gsr->pga_change_count - gsr->hz_window_start_pga_changes;

        gsr->hz_window_start_tick = now;
        gsr->hz_window_start_count = count;
        gsr->hz_window_start_attempts = attempts;
        gsr->hz_window_start_duplicates = duplicates;
        gsr->hz_window_start_pga_changes = gsr->pga_change_count;
    }

    furi_mutex_acquire(gsr->mutex, FuriWaitForever);
    bool i2c_ok = gsr->i2c_working;
    furi_mutex_release(gsr->mutex);

    if(!i2c_ok) return;

    // ── Step 1: sum every buffer entry timestamped within the last
    // BOXCAR_WINDOW_MS of real time, walking backward from the most
    // recent write. No intermediate array — the simple mean doesn't need
    // sorting, so one pass is enough. Also snapshot the single
    // most-recent count for get_raw_sample_ns().
    //
    // The i==0 iteration is unconditional (always included, regardless of
    // its age) so `samples` can never be 0 — guarantees no divide-by-zero
    // below even in the degenerate case where somehow nothing in the
    // buffer falls inside the window (shouldn't happen once alloc()'s
    // warm-up fill has aged out, since the worker writes far faster than
    // once per BOXCAR_WINDOW_MS, but the loop shouldn't crash if it does).
    // Capped at SENSOR_BUFFER_SIZE iterations so a pathological timestamp
    // can't spin forever — at the ADS1115's 860 SPS ceiling, a 100 ms
    // window holds at most ~86 samples, well under the buffer's 128.
    // Same pass also tracks (a) peak-to-peak of the window's raw counts —
    // a cheap, frequency-agnostic noise/signal-range indicator — (b) the
    // smallest gap between consecutive samples' timestamps, which is
    // direct evidence for or against the "furi_delay_ms(1) occasionally
    // produces a sub-ADC-conversion-time loop period" theory for the
    // measured (2026-07-23) 7-11% duplicate rate: a gap that reaches 0
    // ticks means two samples landed in the same millisecond, something
    // a cleanly-paced ~2 ms loop shouldn't produce — and (c) a direct,
    // per-sample-timestamp correlation against MAINS_HUM_TARGET_HZ (see
    // gsr_sensor_get_mains_hum_mag()). This is NOT a Goertzel filter — an
    // earlier version was, using each sample's ACTUAL timestamp only to
    // pick a fixed coefficient assuming uniform spacing at the ~1 s
    // rolling worker_hz. On real hardware (2026-07-23) that produced a
    // measured 50 Hz "magnitude" of 103 counts against a window whose
    // total peak-to-peak was only 40 counts — physically impossible (no
    // single frequency component can exceed roughly half the signal's
    // total peak-to-peak). Root cause: Goertzel's recurrence has two
    // poles exactly on the unit circle — a marginally-stable resonant
    // filter — and assumes uniform sample spacing; real sample timing is
    // measurably uneven (see get_window_min_gap_ticks()), and feeding
    // that into a uniform-spacing-assuming resonant recurrence produces
    // inflated, unreliable energy at the target bin. Using each sample's
    // real timestamp (already available in sample_tick[]) directly in
    // the correlation instead of an assumed fixed rate has no such
    // resonance to misbehave, and is naturally correct for however
    // unevenly the real samples are actually spaced.
    furi_mutex_acquire(gsr->mutex, FuriWaitForever);
    uint32_t r_idx = gsr->write_idx;
    uint32_t now_tick = furi_get_tick();
    uint32_t window_ticks = (BOXCAR_WINDOW_MS * furi_kernel_get_tick_frequency()) / 1000;
    int64_t sum = 0;
    int samples = 0;
    int32_t win_min = 0, win_max = 0;
    uint32_t min_gap_ticks = UINT32_MAX;
    uint32_t prev_sample_tick = 0;
    float tick_freq = (float)furi_kernel_get_tick_frequency();
    float sum_cos = 0.0f, sum_sin = 0.0f;
    for(int i = 0; i < SENSOR_BUFFER_SIZE; i++) {
        r_idx = (r_idx - 1) & (SENSOR_BUFFER_SIZE - 1);
        if(i > 0 && (now_tick - gsr->sample_tick[r_idx] > window_ticks)) break;
        int32_t v = gsr->buffer[r_idx];
        sum += v;
        if(i == 0) {
            gsr->tick_last_norm = v;  // snapshot for raw-sample compare
            win_min = v;
            win_max = v;
        } else {
            if(v < win_min) win_min = v;
            if(v > win_max) win_max = v;
            uint32_t gap = prev_sample_tick - gsr->sample_tick[r_idx];
            if(gap < min_gap_ticks) min_gap_ticks = gap;
        }
        prev_sample_tick = gsr->sample_tick[r_idx];

        // Correlate against this sample's REAL elapsed time (not an
        // assumed uniform rate) — sign convention doesn't matter, only
        // magnitude is used below.
        float t_sec = (float)(now_tick - gsr->sample_tick[r_idx]) / tick_freq;
        float angle = 2.0f * GSR_PI * MAINS_HUM_TARGET_HZ * t_sec;
        sum_cos += (float)v * cosf(angle);
        sum_sin += (float)v * sinf(angle);

        samples++;
    }
    uint8_t old_pga = gsr->pga_index;
    int8_t  locked   = gsr->pga_locked;
    bool active = gsr->cal_active;
    float gain = gsr->cal_gain;
    float offset = gsr->cal_offset;
    furi_mutex_release(gsr->mutex);

    gsr->tick_window_ptp = win_max - win_min;
    gsr->tick_window_min_gap = (samples > 1) ? min_gap_ticks : 0;
    // Standard real-sinusoid amplitude recovery from a cosine/sine
    // correlation: for a true component of amplitude A, each sum
    // approaches ~A*samples/2, so 2/samples recovers A.
    gsr->tick_mains_hum_mag = 2.0f * sqrtf(sum_cos * sum_cos + sum_sin * sum_sin) / (float)samples;

    // ── Step 2: simple mean over however many samples landed in the
    // window (typically ~50 at the ~500 Hz measured real-world rate;
    // was silently ~100 at the ~1000 Hz design assumption). Noise
    // reduction scales with √samples, so this is a real, if modest,
    // trade against the original documented ~8.7× — see
    // docs/gsr_filtering_analysis.md for the actual numbers.
    float avg_norm = (float)sum / (float)samples;
    gsr->tick_mean_norm = (int32_t)avg_norm;  // snapshot for diagnostics
    gsr->tick_window_samples = samples;       // snapshot for diagnostics

    // ── Step 3: autoranging decision on the RAW (uncalibrated) value.
    // Calibration is applied in the nS domain after TIA conversion —
    // applying it here would skew the PGA switching thresholds.
    // When pga_locked >= 0, autoranging is suppressed — PGA stays fixed.
    uint8_t new_pga = old_pga;
    if(locked < 0) {
        int32_t hw_equiv = (int32_t)(avg_norm / (float)NORM_FACTOR[old_pga]);
        int32_t abs_hw_equiv = (hw_equiv < 0) ? -hw_equiv : hw_equiv;

        if(abs_hw_equiv >= ADS_SATURATE_THRESH && new_pga > ADS_PGA_MIN) {
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
    } else if((uint8_t)locked != old_pga) {
        new_pga = (uint8_t)locked;
    }

    bool pga_update = false;
    if(new_pga != old_pga) {
        pga_update = true;
    }

    // ── Step 4: TIA conversion — raw normalized counts → nanosiemens.
    // Calibration (if active) is applied AFTER the TIA, in the nS domain
    // where gain and offset were computed.
    float raw_ns;
    raw_ns = tia_counts_to_ns(avg_norm);
    if(active) {
        raw_ns = gain * raw_ns + offset;
    }

    // ── Step 5: publish pga_index, pga_changed, and calibrated raw under
    // a single mutex acquisition to minimise contention with the worker.
    furi_mutex_acquire(gsr->mutex, FuriWaitForever);
    if(pga_update) {
        FURI_LOG_I("GsrSensor", "PGA %u→%u (±%s)",
            (unsigned)old_pga, (unsigned)new_pga, PGA_LABEL[new_pga]);
        gsr->pga_index = new_pga;
        gsr->pga_changed = true;
        gsr->pga_change_count++; // tick()-only field, safe to touch under this mutex acquisition
    }
    gsr->raw = raw_ns;

    // ── Finger-cuff disconnect detection (20-tick debounce).
    if(gsr->raw < GSR_VALID_MIN_NS || gsr->raw > GSR_VALID_MAX_NS) {
        if(++gsr->zero_count >= 20) {
            gsr->connected = false;
        }
    } else {
        gsr->zero_count = 0;
        gsr->connected = true;
    }
    furi_mutex_release(gsr->mutex);
}

void gsr_sensor_set_calibration(GsrSensor* gsr, bool active, float gain, float offset) {
    furi_assert(gsr);
    if(!gsr->available) return;
    furi_mutex_acquire(gsr->mutex, FuriWaitForever);
    gsr->cal_active = active;
    gsr->cal_gain = gain;
    gsr->cal_offset = offset;
    furi_mutex_release(gsr->mutex);
}

void gsr_sensor_lock_pga(GsrSensor* gsr, int8_t index) {
    furi_assert(gsr);
    if(!gsr->available) return;
    furi_mutex_acquire(gsr->mutex, FuriWaitForever);
    if(index < 0) {
        gsr->pga_locked = -1;
        FURI_LOG_I("GsrSensor", "PGA lock released — autoranging resumed");
    } else {
        if(index > ADS_PGA_MAX) index = ADS_PGA_MAX;
        gsr->pga_locked = (int8_t)index;
        gsr->pga_index = (uint8_t)index;
        gsr->pga_changed = true;  // force worker to apply new PGA
        FURI_LOG_I("GsrSensor", "PGA locked at %d (±%s)", (int)index, PGA_LABEL[index]);
    }
    furi_mutex_release(gsr->mutex);
}
