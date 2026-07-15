#pragma once

// GSR Sensor — ADS1115 I2C differential reader with PGA autoranging.
//
// Auto-ranging keeps the ADC reading in [12.5 %, 91.5 %] of full scale by
// stepping the PGA gain in real time.  The tick() normalises the reading
// through the TIA circuit equation and stores the result in nanosiemens.
// gsr_sensor_get_raw() returns skin conductance in nS regardless of PGA.
// Returns 0 when the sensor is unavailable.
//
// Always probed at alloc(); gsr_sensor_available() reports success.
// Readings return 0 and tick() is a no-op if the probe fails.

#include <furi.h>
#include <furi_hal.h>
#include <stdbool.h>
#include <stdint.h>

// ADS1115 I2C address (ADDR pin → GND → 0x48)
#define ADS1115_I2C_ADDR    (0x48 << 1)
#define ADS1115_CONV_REG    0x00

// Ring buffer size for background sampling (MUST be a power of two —
// the worker uses & (SENSOR_BUFFER_SIZE - 1) for fast wraparound).
#define SENSOR_BUFFER_SIZE  128

// Physiological skin conductance validity range (nanosiemens).
// Used by gsr_sensor.c (disconnect debounce) and biomap_session.c
// (per-tick validity gate).  Define here so both users stay in sync.
//
//   Below GSR_VALID_MIN_NS → open circuit  (finger cuffs not attached)
//   Above GSR_VALID_MAX_NS → rail saturation (hardware fault or short)
//
// Typical resting range: 1–20 µS = 1 000–20 000 nS.
// Literature: Boucsein 2012 reports SCL 1–50 µS as normal range.
#define GSR_VALID_MIN_NS    0.1f      // nS — below this: open circuit
#define GSR_VALID_MAX_NS    75000.0f  // nS — above this: rail saturation

typedef struct GsrSensor GsrSensor;

// Lifecycle
GsrSensor* gsr_sensor_alloc(void);
void       gsr_sensor_free(GsrSensor* gsr);

// Returns false when ADS1115 probe failed at init
bool gsr_sensor_available(const GsrSensor* gsr);

// Returns false when the sensor has been returning invalid readings
// (e.g. finger cuffs disconnected) for multiple consecutive ticks.
// Uses GSR_VALID_MIN_NS / GSR_VALID_MAX_NS thresholds for 20+ consecutive
// ticks (2+ s).  Automatically recovers when an in-range reading comes back.
bool gsr_sensor_is_connected(const GsrSensor* gsr);

// Call at 10 Hz.  Reads the ring buffer, applies 100-sample decimation,
// autoranging, and TIA circuit equation.  Blocks for ~1 ms (100 integer
// adds + float ops); safe at 10 Hz on Cortex-M4 @ 64 MHz.
void gsr_sensor_tick(GsrSensor* gsr);

// Skin conductance in nanosiemens (nS), computed from the TIA circuit
// equation each tick.  Returns 0.0f when sensor unavailable.
float gsr_sensor_get_raw(const GsrSensor* gsr);

// Single raw ADC sample converted directly to nanosiemens via the TIA
// equation — no decimation, no averaging, no autoranging, no calibration.
// Reads the most recent ring-buffer entry (updated at ~860 Hz by the
// background worker).  This is the "pure hardware" value: one ADS1115
// conversion → normalised count → TIA → nS.
// Returns 0.0f when sensor unavailable or buffer is empty.
float gsr_sensor_get_raw_sample_ns(const GsrSensor* gsr);

// Raw normalised ADC count (pre-TIA) snapshotted from the same buffer
// position as get_raw_sample_ns.  For hardware diagnostics.
int32_t gsr_sensor_get_raw_sample_count(const GsrSensor* gsr);

// 100-sample mean normalised count (pre-TIA).  Compare with
// get_raw_sample_count to see single-sample vs averaged difference.
int32_t gsr_sensor_get_mean_count(const GsrSensor* gsr);

// Current PGA index (0–5).  For diagnostics.
uint8_t gsr_sensor_get_pga_index(const GsrSensor* gsr);

// Update calibration parameters (thread-safe).  When active is true,
// the raw counts are scaled by gain and offset-shifted before conductance conversion.
void gsr_sensor_set_calibration(GsrSensor* gsr, bool active, float gain, float offset);

// Lock PGA at a fixed index (0–5) to disable autoranging.  Pass -1 to unlock
// and resume normal autoranging.  When locked, tick() still runs the 100-sample
// mean but skips the PGA-switching decision.  Useful for hardware diagnostics.
void gsr_sensor_lock_pga(GsrSensor* gsr, int8_t index);
