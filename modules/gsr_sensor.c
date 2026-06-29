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
//   The ADS1115 is a delta-sigma ADC in continuous mode at 128 SPS.  After
//   writing a new config, the current conversion completes at the OLD setting
//   (~7.8 ms), then every subsequent conversion uses the new setting.
//   We poll at 10 Hz (100 ms between ticks), so ≥12 fully-settled new-PGA
//   conversions have completed before the next read — no explicit delay or
//   "skip first reading" logic is required.
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
// Struct
// ─────────────────────────────────────────────────────────────────────────────
struct GsrSensor {
    int32_t raw;        // skin conductance in nanosiemens (nS)
    bool    available;
    uint8_t pga_index;  // active PGA setting (0 … ADS_PGA_MAX)
    uint8_t low_count;  // consecutive ticks below ADS_LOW_THRESH
};

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
        uint8_t cfg[2] = { pga_msb(ADS_PGA_DEFAULT), 0x83 };
        bool cfg_ok = furi_hal_i2c_write_mem(
            &furi_hal_i2c_handle_external,
            ADS1115_I2C_ADDR, ADS1115_CONFIG_REG,
            cfg, 2, 50);
        if(!cfg_ok) FURI_LOG_W("GsrSensor", "Config write failed — using defaults");
    }
    furi_hal_i2c_release(&furi_hal_i2c_handle_external);

    gsr->available = probed;
    FURI_LOG_I("GsrSensor", "Probe %s", probed ? "OK" : "not found");
    return gsr;
}

void gsr_sensor_free(GsrSensor* gsr) { furi_assert(gsr); free(gsr); }

// ─────────────────────────────────────────────────────────────────────────────
// Accessors
// ─────────────────────────────────────────────────────────────────────────────
bool    gsr_sensor_available(const GsrSensor* gsr)     { return gsr->available; }
int32_t gsr_sensor_get_raw(const GsrSensor* gsr)       { return gsr->raw; }
uint8_t gsr_sensor_get_pga_index(const GsrSensor* gsr) { return gsr->pga_index; }

// ─────────────────────────────────────────────────────────────────────────────
// Tick — read, autorange, normalise
// ─────────────────────────────────────────────────────────────────────────────
void gsr_sensor_tick(GsrSensor* gsr) {
    furi_assert(gsr);
    if(!gsr->available) return;

    furi_hal_i2c_acquire(&furi_hal_i2c_handle_external);

    // ── Step 1: read the most recent conversion result ────────────────────
    uint8_t data[2];
    bool ok = furi_hal_i2c_read_mem(
        &furi_hal_i2c_handle_external,
        ADS1115_I2C_ADDR, ADS1115_CONV_REG,
        data, 2, 50);

    uint8_t old_pga = gsr->pga_index;
    int16_t hw = 0;

    if(ok) {
        hw = (int16_t)((data[0] << 8) | data[1]);

        // Use int32 to safely handle hw == INT16_MIN (-32768) without overflow.
        int32_t abs_hw = (hw < 0) ? -(int32_t)hw : (int32_t)hw;

        // ── Step 2: autoranging decision ─────────────────────────────────
        uint8_t new_pga = gsr->pga_index;

        if(abs_hw >= ADS_SATURATE_THRESH && new_pga > ADS_PGA_MIN) {
            // At or near full scale — widen FSR immediately (lower gain).
            new_pga--;
            gsr->low_count = 0;
        } else if(abs_hw < ADS_LOW_THRESH && new_pga < ADS_PGA_MAX) {
            // Signal weak — require several consecutive low ticks before
            // narrowing FSR (higher gain) to avoid range-hunting.
            if(++gsr->low_count >= ADS_LOW_COUNT_TICKS) {
                new_pga++;
                gsr->low_count = 0;
            }
        } else {
            // Signal in good range — reset the ranging-up counter.
            gsr->low_count = 0;
        }

        // ── Step 3: write new PGA config if needed (same I2C transaction) ─
        if(new_pga != gsr->pga_index) {
            uint8_t cfg[2] = { pga_msb(new_pga), 0x83 };
            bool cfg_ok = furi_hal_i2c_write_mem(
                &furi_hal_i2c_handle_external,
                ADS1115_I2C_ADDR, ADS1115_CONFIG_REG,
                cfg, 2, 50);
            if(cfg_ok) {
                FURI_LOG_I("GsrSensor", "PGA %u→%u (±%s)",
                    (unsigned)old_pga, (unsigned)new_pga, PGA_LABEL[new_pga]);
                gsr->pga_index = new_pga;
            } else {
                // Write failed — leave pga_index unchanged; will retry next tick.
                FURI_LOG_W("GsrSensor", "PGA update write failed");
            }
        }
    }

    furi_hal_i2c_release(&furi_hal_i2c_handle_external);

    // ── Step 4: normalise raw hardware count to physical skin conductance (nS)
    //
    // Using safety resistors of 2 * 4.7 kOhm = 9.4 kOhm, reference of 0.5V, and
    // feedback resistor of 47 kOhm, the skin conductance in nanosiemens is:
    //   G_skin (nS) = (5,000,000 * norm) / (15,040,000 - 47 * norm)
    // where norm = hw * NORM_FACTOR[old_pga] is the PGA 5 LSB equivalent count.
    // We use int64_t for intermediate math to prevent 32-bit overflow.
    if(ok) {
        int32_t norm = (int32_t)hw * NORM_FACTOR[old_pga];
        if(norm <= 0) {
            gsr->raw = 0;
        } else {
            if(norm > 319000) norm = 319000; // safety cap to prevent division by zero/negative
            int64_t num = (int64_t)norm * 5000000LL;
            int64_t den = 15040000LL - (int64_t)norm * 47LL;
            gsr->raw = (int32_t)(num / den);
        }
    }
    // If read failed, keep gsr->raw at its last valid value.
}
