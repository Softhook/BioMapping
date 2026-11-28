#pragma once

// GSR sensor on the Flipper: the GSR thread and the Flipper's I2C, clock,
// wait and lock. All the GSR logic and read-outs are shared, in
// core/gsr_sensor.h; this adds only what needs the Flipper.
//
// Owns one background FuriThread ("GsrSensorWorker") that runs the shared
// worker pass in a loop. The thread can also host one other job through
// an optional worker hook (GsrWorkerHook below). On the Flipper that job
// is the radio scan (em_scan_sampler.h), which shares this thread rather
// than spawning a second one. Without a hook the loop is GSR only.

#include "core/gsr_sensor.h"

// Called on the worker thread once per normal loop pass, right after the
// ADC read (not on PGA-change passes). Lets another job share this thread.
// Rules for the hook:
//   - keep it short: time spent here is time the ADC isn't being read
//     (em_scan_sampler_poll() returns at once except every ~100 ms);
//   - never take app->mutex, or anything that waits on this sensor;
//   - `ctx` must stay valid until gsr_sensor_free() returns.
typedef void (*GsrWorkerHook)(void* ctx);

// Lifecycle. `hook` may be NULL (GSR only). It is fixed for the sensor's
// lifetime. The worker thread starts inside alloc(), so the hook can be
// called before alloc() returns: `ctx` must be fully set up beforehand.
GsrSensor* gsr_sensor_alloc(GsrWorkerHook hook, void* hook_ctx);
void       gsr_sensor_free(GsrSensor* gsr);

// Remaining free stack space (bytes) on the worker's own thread, via
// furi_thread_get_stack_space(). Returns 0 if gsr is NULL.
uint32_t gsr_sensor_get_stack_space(const GsrSensor* gsr);
