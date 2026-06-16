#pragma once

// GSR Sensor — ADS1115 I2C differential reader (AIN0–AIN1, TIA circuit).
// Always probed at alloc(); gsr_sensor_available() reports success.
// Readings return 0 and tick() is a no-op if the probe fails.

#include <furi.h>
#include <furi_hal.h>
#include <stdbool.h>
#include <stdint.h>

// ADS1115 I2C address (ADDR pin → GND → 0x48)
#define ADS1115_I2C_ADDR    (0x48 << 1)
#define ADS1115_CONV_REG    0x00

typedef struct GsrSensor GsrSensor;

// Lifecycle
GsrSensor* gsr_sensor_alloc(void);
void       gsr_sensor_free(GsrSensor* gsr);

// Returns false when ADS1115 probe failed at init
bool gsr_sensor_available(const GsrSensor* gsr);

// Call at 10 Hz. Reads ADS1115 (if available) and stores the raw value.
void gsr_sensor_tick(GsrSensor* gsr);

// Raw 16-bit differential ADC reading (0 when unavailable)
int16_t gsr_sensor_get_raw(const GsrSensor* gsr);
