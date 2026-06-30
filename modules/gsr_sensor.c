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
//   writing a new config, the current conversion completes at the OLD setting
//   (~1.16 ms), then every subsequent conversion uses the new setting.
//   Since we tick at 10 Hz (100 ms between ticks), ~86 conversions have
//   completed before the next tick — meaning PGA changes are settled immediately
//   relative to the 100 ms filter window.
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
// = 0x80 | (pga_index << 1).  LSB stays 0x83: DR=128 SPS, comparator disabled.
static inline uint8_t pga_msb(uint8_t idx) {
    return (uint8_t)(0x80u | ((uint32_t)idx << 1u));
}

// ─────────────────────────────────────────────────────────────────────────────
// Struct & Constants
// ─────────────────────────────────────────────────────────────────────────────
#define SENSOR_BUFFER_SIZE 128

struct GsrSensor {
    int32_t raw;        // skin conductance in nanosiemens (nS)
    bool    available;
    uint8_t pga_index;  // active PGA setting (0 … ADS_PGA_MAX)
    uint8_t low_count;  // consecutive ticks below ADS_LOW_THRESH

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
            uint8_t cfg[2] = { pga_msb(active_pga), 0xE3 }; // Config: active PGA, continuous 860 SPS
            bool cfg_ok = furi_hal_i2c_write_mem(
                &furi_hal_i2c_handle_external,
                ADS1115_I2C_ADDR, ADS1115_CONFIG_REG,
                cfg, 2, 50);
            if(cfg_ok) {
                furi_mutex_acquire(gsr->mutex, FuriWaitForever);
                gsr->pga_changed = false;
                furi_mutex_release(gsr->mutex);
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

        // The next read sample will be from a conversion started under the active PGA config
        current_adc_pga = active_pga;

        // Yield to the RTOS scheduler (~1000 Hz loop).  The ADS1115 converts
        // at 860 SPS so ~14 % of reads return the same conversion as the
        // previous iteration — duplicates are harmless: the trimmed-mean
        // filter in gsr_sensor_tick() discards extreme values anyway, and
        // duplicate mid-range samples do not bias the average.
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
    gsr->raw       = 0;
    gsr->pga_index = ADS_PGA_DEFAULT;
    gsr->low_count = 0;

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

int32_t gsr_sensor_get_raw(const GsrSensor* gsr) {
    furi_assert(gsr);
    if(!gsr->available) return 0;
    furi_mutex_acquire(gsr->mutex, FuriWaitForever);
    int32_t val = gsr->raw;
    furi_mutex_release(gsr->mutex);
    return val;
}

uint8_t gsr_sensor_get_pga_index(const GsrSensor* gsr) {
    furi_assert(gsr);
    if(!gsr->available) return ADS_PGA_DEFAULT;
    furi_mutex_acquire(gsr->mutex, FuriWaitForever);
    uint8_t val = gsr->pga_index;
    furi_mutex_release(gsr->mutex);
    return val;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sorting & Filtering
// ─────────────────────────────────────────────────────────────────────────────
static void sort_int32(int32_t* arr, int n) {
    for(int i = 1; i < n; i++) {
        int32_t key = arr[i];
        int j = i - 1;
        while(j >= 0 && arr[j] > key) {
            arr[j + 1] = arr[j];
            j = j - 1;
        }
        arr[j + 1] = key;
    }
}

void gsr_sensor_tick(GsrSensor* gsr) {
    furi_assert(gsr);
    if(!gsr->available) return;

    // ── Step 1: extract the most recent 86 samples (100 ms window) ────────
    int32_t window[86];
    furi_mutex_acquire(gsr->mutex, FuriWaitForever);
    uint32_t r_idx = gsr->write_idx;
    for(int i = 0; i < 86; i++) {
        r_idx = (r_idx - 1) & (SENSOR_BUFFER_SIZE - 1);
        window[i] = gsr->buffer[r_idx];
    }
    uint8_t old_pga = gsr->pga_index;
    furi_mutex_release(gsr->mutex);

    // ── Step 2: sort the 86 samples ───────────────────────────────────────
    sort_int32(window, 86);

    // ── Step 3: discard top 6 and bottom 6, average the remaining 74 ──────
    int64_t sum = 0;
    for(int i = 6; i <= 79; i++) {
        sum += window[i];
    }
    int32_t avg_norm = (int32_t)(sum / 74);

    // ── Step 4: autoranging decision on filtered equivalent raw value ─────
    int32_t hw_equiv = avg_norm / NORM_FACTOR[old_pga];
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

    if(new_pga != old_pga) {
        furi_mutex_acquire(gsr->mutex, FuriWaitForever);
        FURI_LOG_I("GsrSensor", "PGA %u→%u (±%s)",
            (unsigned)old_pga, (unsigned)new_pga, PGA_LABEL[new_pga]);
        gsr->pga_index = new_pga;
        gsr->pga_changed = true;
        furi_mutex_release(gsr->mutex);
    }

    // ── Step 5: normalise filtered reading to physical skin conductance (nS)
    furi_mutex_acquire(gsr->mutex, FuriWaitForever);
    if(avg_norm <= 0) {
        gsr->raw = 0;
    } else {
        if(avg_norm > 319000) avg_norm = 319000; // safety cap to prevent division by zero/negative
        int64_t num = (int64_t)avg_norm * 5000000LL;
        int64_t den = 15040000LL - (int64_t)avg_norm * 47LL;
        gsr->raw = (int32_t)(num / den);
    }
    furi_mutex_release(gsr->mutex);
}
