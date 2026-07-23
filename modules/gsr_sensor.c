// GSR Sensor — ADS1115 I2C differential reader with PGA autoranging.
// Signal processing (EMA, derivative) is deferred to the main app.

#include "gsr_sensor.h"
#include <furi.h>
#include <furi_hal.h>
#include <stdlib.h>

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
    // docs/gsr_filtering_analysis.md: at worker rates below the ADS1115's
    // 860 SPS conversion rate this should stay near 0 (each read lands on
    // a fresh conversion); a rate above 860 SPS would show it rising, the
    // signature of the boxcar average's effective independent-sample
    // count being diluted by re-read stale conversions. Reset to 0 (via
    // have_last_hw = false in the worker) on every PGA change, since a
    // gain change makes the previous reading's raw code incomparable to
    // the new one — that's a scale change, not evidence of a stale read.
    uint32_t duplicate_count;
    uint32_t hz_window_start_tick;  // tick() only
    uint32_t hz_window_start_count;    // iter_count snapshot — tick() only
    uint32_t hz_window_start_attempts; // attempt_count snapshot — tick() only
    uint32_t hz_window_start_duplicates; // duplicate_count snapshot — tick() only
    float    worker_hz_cached;      // tick() only — successful-sample rate
    float    success_rate_cached;   // tick() only — iter_count/attempt_count over the same window, 0-100
    float    duplicate_rate_cached; // tick() only — duplicate_count/iter_count over the same window, 0-100
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
            consecutive_failures = 0;
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
            bool is_duplicate = have_last_hw && (hw == last_hw);
            last_hw = hw;
            have_last_hw = true;

            furi_mutex_acquire(gsr->mutex, FuriWaitForever);
            gsr->buffer[gsr->write_idx] = norm;
            gsr->sample_tick[gsr->write_idx] = furi_get_tick();
            gsr->write_idx = (gsr->write_idx + 1) & (SENSOR_BUFFER_SIZE - 1);
            gsr->iter_count++;
            if(is_duplicate) gsr->duplicate_count++;
            furi_mutex_release(gsr->mutex);
        } else {
            consecutive_failures++;
            // After ~50 ms of continuous I2C failures, treat the sensor
            // as disconnected so the UI doesn't show a stale frozen value.
            if(consecutive_failures >= 50) {
                furi_mutex_acquire(gsr->mutex, FuriWaitForever);
                gsr->connected = false;
                gsr->i2c_working = false;
                gsr->raw = 0.0f;
                furi_mutex_release(gsr->mutex);
            }
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
        gsr->hz_window_start_tick = furi_get_tick(); // set before the worker starts — no lock needed
        gsr->hz_window_start_count = 0;
        gsr->hz_window_start_attempts = 0;
        gsr->hz_window_start_duplicates = 0;
        gsr->worker_hz_cached = 0.0f;
        gsr->success_rate_cached = 100.0f; // optimistic default until the first window rolls
        gsr->duplicate_rate_cached = 0.0f; // optimistic default until the first window rolls

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
// immediately preceding successful read — i.e. a stale re-read of a
// conversion the ADS1115 hadn't yet updated, rather than a fresh sample.
// This is the direct, measured answer to the skip-vs-duplicate question
// in docs/gsr_filtering_analysis.md: at worker rates below the ADS1115's
// 860 SPS conversion rate this should sit near 0% (nearly every read is
// fresh); well above 0% at rates near or above 860 SPS is the signature
// of gsr_sensor_tick()'s boxcar average being diluted by re-counted
// stale conversions rather than genuinely independent samples. Resets
// across PGA changes (a gain change isn't a stale read). Reads 0.0f
// until the first window has elapsed (optimistic default, not a claim).
float gsr_sensor_get_duplicate_rate(const GsrSensor* gsr) {
    furi_assert(gsr);
    if(!gsr->available) return 0.0f;
    return gsr->duplicate_rate_cached;
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

        gsr->hz_window_start_tick = now;
        gsr->hz_window_start_count = count;
        gsr->hz_window_start_attempts = attempts;
        gsr->hz_window_start_duplicates = duplicates;
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
    furi_mutex_acquire(gsr->mutex, FuriWaitForever);
    uint32_t r_idx = gsr->write_idx;
    uint32_t now_tick = furi_get_tick();
    uint32_t window_ticks = (BOXCAR_WINDOW_MS * furi_kernel_get_tick_frequency()) / 1000;
    int64_t sum = 0;
    int samples = 0;
    for(int i = 0; i < SENSOR_BUFFER_SIZE; i++) {
        r_idx = (r_idx - 1) & (SENSOR_BUFFER_SIZE - 1);
        if(i > 0 && (now_tick - gsr->sample_tick[r_idx] > window_ticks)) break;
        int32_t v = gsr->buffer[r_idx];
        sum += v;
        if(i == 0) gsr->tick_last_norm = v;  // snapshot for raw-sample compare
        samples++;
    }
    uint8_t old_pga = gsr->pga_index;
    int8_t  locked   = gsr->pga_locked;
    bool active = gsr->cal_active;
    float gain = gsr->cal_gain;
    float offset = gsr->cal_offset;
    furi_mutex_release(gsr->mutex);

    // ── Step 2: simple mean over however many samples landed in the
    // window (typically ~50 at the ~500 Hz measured real-world rate;
    // was silently ~100 at the ~1000 Hz design assumption). Noise
    // reduction scales with √samples, so this is a real, if modest,
    // trade against the original documented ~8.7× — see
    // docs/gsr_filtering_analysis.md for the actual numbers.
    float avg_norm = (float)sum / (float)samples;
    gsr->tick_mean_norm = (int32_t)avg_norm;  // snapshot for diagnostics

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
