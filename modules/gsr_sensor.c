// GSR Sensor — ADS1115 I2C differential reader with PGA autoranging.
// Signal processing (EMA, derivative) is deferred to the main app.

#include "gsr_sensor.h"
#include <stdlib.h>

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
    uint8_t pga_index;  // active PGA setting (0 … ADS_PGA_MAX)
    uint8_t low_count;  // consecutive ticks below ADS_LOW_THRESH
    uint8_t zero_count; // consecutive ticks with raw == 0.0f

    FuriThread* thread;
    FuriMutex*  mutex;
    volatile bool running;
    volatile bool pga_changed;

    int32_t buffer[SENSOR_BUFFER_SIZE];
    volatile uint32_t write_idx;
};

// Background worker thread for 860 SPS reading and normalization
static int32_t gsr_sensor_worker(void* context) {
    GsrSensor* gsr = context;
    uint8_t current_adc_pga = ADS_PGA_DEFAULT;

    while(gsr->running) {
        furi_mutex_acquire(gsr->mutex, FuriWaitForever);
        uint8_t active_pga = gsr->pga_index;
        bool pga_changed = gsr->pga_changed;
        furi_mutex_release(gsr->mutex);

        furi_hal_i2c_acquire(&furi_hal_i2c_handle_external);
        if(pga_changed) {
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

                // Wait for the first fully-settled conversion under the new PGA
                // setting.  At 860 SPS conversion takes 1.16 ms; 2 ms guarantees
                // the next read returns a new-PGA result.
                furi_delay_ms(2);
                current_adc_pga = active_pga;
                continue;
            }
        }

        uint8_t data[2];
        bool ok = furi_hal_i2c_read_mem(
            &furi_hal_i2c_handle_external,
            ADS1115_I2C_ADDR, ADS1115_CONV_REG,
            data, 2, 50);
        furi_hal_i2c_release(&furi_hal_i2c_handle_external);

        if(ok) {
            int16_t hw = (int16_t)((data[0] << 8) | data[1]);
            
            // Normalize using current_adc_pga (which corresponds to the gain active 
            // when the conversion currently in the conversion register was performed).
            int32_t norm = (int32_t)hw * NORM_FACTOR[current_adc_pga];

            furi_mutex_acquire(gsr->mutex, FuriWaitForever);
            gsr->buffer[gsr->write_idx] = norm;
            gsr->write_idx = (gsr->write_idx + 1) & (SENSOR_BUFFER_SIZE - 1);
            furi_mutex_release(gsr->mutex);
        }

        // Track the PGA under which the next conversion will be started.
        // Only update when there is no pending (uncommitted) PGA change —
        // otherwise a failed I2C write would cause the next read to be
        // normalized with the wrong NORM_FACTOR.
        if(!pga_changed) {
            current_adc_pga = active_pga;
        }

        // Yield to the RTOS scheduler (~1000 Hz loop).  The ADS1115 converts
        // at 860 SPS so ~14 % of reads return the same conversion as the
        // previous iteration — duplicates are harmless: they are valid
        // measurements and do not bias the simple mean.
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
    gsr->zero_count = 0;

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
        for(int i = 0; i < SENSOR_BUFFER_SIZE; i++) {
            gsr->buffer[i] = initial_norm;
        }
        gsr->write_idx = 0;

        gsr->mutex = furi_mutex_alloc(FuriMutexTypeNormal);
        furi_assert(gsr->mutex);

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

// ─────────────────────────────────────────────────────────────────────────────
// Oversampling & Filtering
//
// Each 100 ms (10 Hz) tick extracts the 100 most recent buffer entries
// and averages them — spanning the full 100 ms decimation interval.
// The background worker polls at ~1000 Hz (furi_delay_ms(1) synchronised
// to the RTOS tick) while the ADS1115 converts at 860 SPS, so ~14 % of
// buffer entries are duplicate reads of the same conversion.  Duplicates
// do not bias the simple mean but also don't add independent noise
// reduction — the effective unique-sample count remains ~86.
//
// Empirical testing (biomap_019.csv, 873 samples) confirmed zero I2C
// glitches — all large tick-to-tick jumps were sustained physiological
// SCR onsets, not single-sample spikes that trimming would catch.
//
// Simple mean noise reduction: ~8.7× effective (geometric model: ~86 unique
// conversions but ~14 % are re-reads, reducing true attenuation from the
// theoretical √86 ≈ 9.27× for fully independent samples).
// 100 ms window nominally nulls 50/60 Hz mains hum (5 × 20 ms, 6 × 16.67 ms),
// though non-uniform re-reads limit practical rejection to ~−22 dB combined
// with the hardware TIA low-pass filter (47 kΩ × 100 nF, −3 dB at 33.9 Hz).
// ─────────────────────────────────────────────────────────────────────────────

void gsr_sensor_tick(GsrSensor* gsr) {
    furi_assert(gsr);
    if(!gsr->available) return;

    // ── Step 1: sum the most recent 100 samples directly from the ring
    // buffer (100 ms window).  No intermediate array — the simple mean
    // doesn't need sorting, so one pass is enough. ─────────────────────
    furi_mutex_acquire(gsr->mutex, FuriWaitForever);
    uint32_t r_idx = gsr->write_idx;
    int64_t sum = 0;
    for(int i = 0; i < 100; i++) {
        r_idx = (r_idx - 1) & (SENSOR_BUFFER_SIZE - 1);
        sum += gsr->buffer[r_idx];
    }
    uint8_t old_pga = gsr->pga_index;
    furi_mutex_release(gsr->mutex);

    // ── Step 2: simple mean. Effective ~8.7× noise reduction (see comment above) ──
    float avg_norm = (float)sum / 100.0f;

    // ── Step 3: autoranging decision on filtered equivalent raw value ─────
    int32_t hw_equiv = (int32_t)(avg_norm / (float)NORM_FACTOR[old_pga]);
    int32_t abs_hw_equiv = (hw_equiv < 0) ? -hw_equiv : hw_equiv;
    uint8_t new_pga = old_pga;

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

    bool pga_update = false;
    if(new_pga != old_pga) {
        // Combined with Step 4 below (single mutex acquisition)
        pga_update = true;
    }

    // ── Step 4: normalise filtered reading to physical skin conductance (nS)
    // Write pga_index, pga_changed, and raw under a single mutex acquisition
    // to minimise contention with the background worker thread.
    furi_mutex_acquire(gsr->mutex, FuriWaitForever);
    if(pga_update) {
        FURI_LOG_I("GsrSensor", "PGA %u→%u (±%s)",
            (unsigned)old_pga, (unsigned)new_pga, PGA_LABEL[new_pga]);
        gsr->pga_index = new_pga;
        gsr->pga_changed = true;
    }
    if(avg_norm <= 0) {
        gsr->raw = 0.0f;
    } else {
        // Use float arithmetic for the TIA equation to preserve fractional
        // precision.  Integer truncation was producing visible quantization
        // steps (±1 nS) when the signal changed slowly.
        float clamped = (avg_norm > 319000) ? 319000.0f : (float)avg_norm;
        float num = clamped * 5000000.0f;
        float den = 15040000.0f - clamped * 47.0f;
        gsr->raw = num / den;
    }

    // ── Finger-cuff disconnect detection ──────────────────────────────
    // When the cuffs are disconnected the ADC reads either 0 (open
    // input floats low) or near-rail saturation (stray coupling drives
    // the input to the rail).  A rail reading at PGA 0 (±6.144V)
    // normalises to ~786 408 counts, which the TIA clamps to 319 000,
    // producing raw ≈ 33 936 170 nS — far beyond any physiological
    // range (normal GSR is 500-25 000 nS).  We detect both extremes:
    //
    //   raw < 0.1 nS     → zero / open input
    //   raw > 50 000 nS  → rail saturation (cuffs disconnected)
    //
    // After 20 consecutive invalid ticks (2 s) the sensor is marked
    // disconnected.  A single in-range reading resets the counter and
    // re-marks it as connected.  This keeps the display pipeline from
    // going haywire while the CSV continues to log the raw values
    // accurately.
    if(gsr->raw < 0.1f || gsr->raw > 50000.0f) {
        if(++gsr->zero_count >= 20) {
            gsr->connected = false;
        }
    } else {
        gsr->zero_count = 0;
        gsr->connected = true;
    }
    furi_mutex_release(gsr->mutex);
}
