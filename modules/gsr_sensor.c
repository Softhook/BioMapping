// GSR Sensor Module for BioMapping 3.0
// ADS1115 I2C differential reader — raw value only.
//
// Probes the ADS1115 at alloc() time. If found, tick() reads the raw
// 16-bit differential ADC value. Signal processing (EMA, derivative,
// elevation mapping) is deferred to the GPX converter.

#include "gsr_sensor.h"
#include <stdlib.h>

struct GsrSensor {
    int16_t raw;
    bool    available;
};

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
GsrSensor* gsr_sensor_alloc(void) {
    GsrSensor* gsr = malloc(sizeof(GsrSensor));
    furi_assert(gsr);

    gsr->raw       = 0;

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
    if(found) {
        // Explicitly write the configuration to register 0x01:
        // OS=1, MUX=000 (differential AIN0-AIN1), PGA=010 (+-2.048V), MODE=0 (continuous mode), DR=100 (128 SPS)
        // High byte: 0x84, Low byte: 0x83.
        uint8_t config_val[2] = {0x84, 0x83};
        bool config_ok = furi_hal_i2c_write_mem(
            &furi_hal_i2c_handle_external,
            ADS1115_I2C_ADDR,
            0x01, // Config register
            config_val,
            2,
            50); // 50 ms timeout
        if(config_ok) {
            FURI_LOG_I("GsrSensor", "ADS1115 configuration write successful");
        } else {
            FURI_LOG_E("GsrSensor", "ADS1115 configuration write failed");
            found = false; // treat as unavailable if we can't write config
        }
    }
    furi_hal_i2c_release(&furi_hal_i2c_handle_external);
    gsr->available = found;
    FURI_LOG_I("GsrSensor", "ADS1115 probe %s", found ? "OK" : "not found");

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

// ---------------------------------------------------------------------------
// 10 Hz tick — read sensor, store raw value
// ---------------------------------------------------------------------------
void gsr_sensor_tick(GsrSensor* gsr) {
    furi_assert(gsr);

    if(!gsr->available) {
        return;
    }

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
    }
    // On I2C failure, keep the previous raw value to avoid spikes
}
