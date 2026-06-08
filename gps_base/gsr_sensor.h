#pragma once

// GSR Sensor Module for BioMapping
// ADS1115 I2C differential reader (A0 – A1) via Wheatstone Bridge.
//
// *** CURRENTLY DISABLED ***
// The ADS1115 shares I2C pins (PC0/PC1) with the L76K GPS standby/reset
// lines. Until the hardware trace-cut mod is performed to deconflict them,
// the sensor is initialised as unavailable and all readings return 0.
//
// When hardware is ready, set GSR_ENABLED to 1 and rebuild.

#include <furi.h>
#include <furi_hal.h>
#include <stdbool.h>
#include <stdint.h>

#define GSR_ENABLED         0   // Set to 1 when ADS1115 hardware is wired
#define GSR_EMA_ALPHA       0.2f
#define GSR_ELEVATION_SCALE 0.5f

// ADS1115 I2C address (ADDR pin → GND → 0x48)
#define ADS1115_I2C_ADDR    (0x48 << 1)
#define ADS1115_CONV_REG    0x00

typedef struct GsrSensor GsrSensor;

// Lifecycle
GsrSensor* gsr_sensor_alloc(void);
void       gsr_sensor_free(GsrSensor* gsr);

// Returns false when GSR_ENABLED == 0 or ADS1115 probe failed at init
bool gsr_sensor_available(const GsrSensor* gsr);

// Call at 10 Hz. Reads ADS1115 (if available), updates EMA + derivative.
void gsr_sensor_tick(GsrSensor* gsr);

// Raw 16-bit differential ADC reading (0 when unavailable)
int16_t gsr_sensor_get_raw(const GsrSensor* gsr);

// Zoom-free elevation_base = -(rate_of_change) × GSR_ELEVATION_SCALE
// Zoom is applied at render/log time, not stored here.
float gsr_sensor_get_elevation_base(const GsrSensor* gsr);

// Resets the EMA primer so the next tick re-seeds from a fresh reading.
// Call this when starting a new recording session.
void gsr_sensor_reset_primer(GsrSensor* gsr);
