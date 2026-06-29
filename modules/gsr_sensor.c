// GSR Sensor — ADS1115 I2C differential reader. Raw value only.
// Signal processing (EMA, derivative) is deferred to the GPX converter.

#include "gsr_sensor.h"
#include <stdlib.h>

#define ADS1115_CONFIG_REG  0x01

struct GsrSensor {
    int16_t raw;
    bool    available;
};

GsrSensor* gsr_sensor_alloc(void) {
    GsrSensor* gsr = malloc(sizeof(GsrSensor));
    furi_assert(gsr);
    gsr->raw = 0;

    furi_hal_i2c_acquire(&furi_hal_i2c_handle_external);
    uint8_t probe = 0;
    bool probed = furi_hal_i2c_read_mem(
        &furi_hal_i2c_handle_external,
        ADS1115_I2C_ADDR, ADS1115_CONV_REG,
        &probe, 1, 20);

    if(probed) {
        // OS=1, MUX=000 (AIN0-AIN1), PGA=010 (±2.048V), MODE=continuous, DR=128 SPS
        uint8_t cfg[2] = {0x84, 0x83};
        bool cfg_ok = furi_hal_i2c_write_mem(
            &furi_hal_i2c_handle_external,
            ADS1115_I2C_ADDR, ADS1115_CONFIG_REG,
            cfg, 2, 50);
        // Sensor still usable in its default mode if config write fails
        if(!cfg_ok) FURI_LOG_W("GsrSensor", "Config write failed — using defaults");
    }
    furi_hal_i2c_release(&furi_hal_i2c_handle_external);
    gsr->available = probed;   // available = sensor present, independent of config result
    FURI_LOG_I("GsrSensor", "Probe %s", probed ? "OK" : "not found");
    return gsr;
}

void gsr_sensor_free(GsrSensor* gsr) { furi_assert(gsr); free(gsr); }

bool gsr_sensor_available(const GsrSensor* gsr) { return gsr->available; }
int16_t gsr_sensor_get_raw(const GsrSensor* gsr) { return gsr->raw; }

void gsr_sensor_tick(GsrSensor* gsr) {
    furi_assert(gsr);
    if(!gsr->available) return;

    uint8_t data[2];
    furi_hal_i2c_acquire(&furi_hal_i2c_handle_external);
    bool ok = furi_hal_i2c_read_mem(
        &furi_hal_i2c_handle_external,
        ADS1115_I2C_ADDR, ADS1115_CONV_REG,
        data, 2, 50);
    furi_hal_i2c_release(&furi_hal_i2c_handle_external);
    if(ok) gsr->raw = (int16_t)((data[0] << 8) | data[1]);
}
