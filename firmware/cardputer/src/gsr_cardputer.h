#pragma once

// GSR sensor on the Cardputer: the GSR thread, and the I2C, clock, wait and
// lock functions the shared code in core/gsr_sensor.c works through.

#include "gsr_sensor.h"

// Probes the ADS1115 (through core/gsr_sensor.c), then starts the GSR
// thread. Always returns a sensor; gsr_sensor_available() says whether the
// ADS1115 answered.
GsrSensor* gsr_cardputer_start(void);

// Stops the GSR thread, waits for it to finish, then frees the sensor.
void gsr_cardputer_stop(GsrSensor* gsr);

// The GSR thread's unused stack, in bytes (for the log).
uint32_t gsr_cardputer_stack_free(const GsrSensor* gsr);
