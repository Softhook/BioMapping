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
    bool found = furi_hal_i2c_read_mem(
        &furi_hal_i2c_handle_external,
        ADS1115_I2C_ADDR, ADS1115_CONV_REG,
        &probe, 1, 20);

    if(found) {
        // OS=1, MUX=000 (AIN0-AIN1), PGA=010 (±2.048V), MODE=continuous, DR=128 SPS
        uint8_t cfg[2] = {0x84, 0x83};
        found = furi_hal_i2c_write_mem(
            &furi_hal_i2c_handle_external,
            ADS1115_I2C_ADDR, ADS1115_CONFIG_REG,
            cfg, 2, 50);
        if(!found) FURI_LOG_E("GsrSensor", "Config write failed");
    }
    furi_hal_i2c_release(&furi_hal_i2c_handle_external);
    gsr->available = found;
    FURI_LOG_I("GsrSensor", "Probe %s", found ? "OK" : "not found");
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
