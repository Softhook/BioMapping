// GSR Sensor Module for BioMapping 3.0
// ADS1115 I2C differential reader stub.
//
// *** CURRENTLY DISABLED (GSR_ENABLED = 0) ***
// When GSR_ENABLED == 0 all readings return 0 / false without touching I2C.
// No bus conflicts with the GPS module in this mode.

#include "gsr_sensor.h"
#include <stdlib.h>
#include <math.h>

struct GsrSensor {
    int16_t raw;
    float   smoothed_value;
    float   elevation_base;
    bool    smoothed_primed;
    bool    available;
};

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
GsrSensor* gsr_sensor_alloc(void) {
    GsrSensor* gsr = malloc(sizeof(GsrSensor));
    furi_assert(gsr);

    gsr->raw             = 0;
    gsr->smoothed_value  = 0.0f;
    gsr->elevation_base  = 0.0f;
    gsr->smoothed_primed = false;

#if GSR_ENABLED
    // Probe for ADS1115 on I2C external bus
    furi_hal_i2c_acquire(&furi_hal_i2c_handle_external);
    uint8_t probe = 0;
    bool found = furi_hal_i2c_read_mem(
        &furi_hal_i2c_handle_external,
        ADS1115_I2C_ADDR,
        ADS1115_CONV_REG,
        &probe,
        1,
        20); // 20 ms timeout
    furi_hal_i2c_release(&furi_hal_i2c_handle_external);
    gsr->available = found;
    FURI_LOG_I("GsrSensor", "ADS1115 probe %s", found ? "OK" : "not found");
#else
    gsr->available = false;
    FURI_LOG_I("GsrSensor", "GSR disabled at compile time (GSR_ENABLED=0)");
#endif

    return gsr;
}

void gsr_sensor_free(GsrSensor* gsr) {
    furi_assert(gsr);
    free(gsr);
}

// ---------------------------------------------------------------------------
// State accessors
// ---------------------------------------------------------------------------
bool gsr_sensor_available(const GsrSensor* gsr) {
    return gsr->available;
}

int16_t gsr_sensor_get_raw(const GsrSensor* gsr) {
    return gsr->raw;
}

float gsr_sensor_get_elevation_base(const GsrSensor* gsr) {
    return gsr->elevation_base;
}

void gsr_sensor_reset_primer(GsrSensor* gsr) {
    gsr->smoothed_primed = false;
}

// ---------------------------------------------------------------------------
// 10 Hz tick — read sensor, update EMA, compute derivative
// ---------------------------------------------------------------------------
void gsr_sensor_tick(GsrSensor* gsr) {
    furi_assert(gsr);

    if(!gsr->available) {
        gsr->elevation_base = 0.0f;
        return;
    }

#if GSR_ENABLED
    if(gsr->available) {
        uint8_t data[2];
        furi_hal_i2c_acquire(&furi_hal_i2c_handle_external);
        bool ok = furi_hal_i2c_read_mem(
            &furi_hal_i2c_handle_external,
            ADS1115_I2C_ADDR,
            ADS1115_CONV_REG,
            data,
            2,
            50); // 50 ms timeout
        furi_hal_i2c_release(&furi_hal_i2c_handle_external);

        if(ok) {
            gsr->raw = (int16_t)((data[0] << 8) | data[1]);
        } else {
            // I2C glitch — treat as no change (zero elevation rate) to avoid extreme spike
            gsr->elevation_base = 0.0f;
            return;
        }
    } else {
        gsr->raw = 0;
    }
#else
    gsr->raw = 0;
#endif

    // Seed EMA from first real reading to avoid cold-start spike
    if(!gsr->smoothed_primed) {
        gsr->smoothed_value  = (float)gsr->raw;
        gsr->smoothed_primed = true;
    }

    // EMA smoothing + derivative → elevation
    float current_smoothed =
        (GSR_EMA_ALPHA * (float)gsr->raw) +
        ((1.0f - GSR_EMA_ALPHA) * gsr->smoothed_value);
    float rate_of_change   = current_smoothed - gsr->smoothed_value;
    gsr->smoothed_value    = current_smoothed;

    // Negate: stress = resistance drop → negative rate → positive elevation
    gsr->elevation_base = -(rate_of_change) * GSR_ELEVATION_SCALE;
}
