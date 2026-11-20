// GSR sensor on the Flipper: the GSR thread, and the I2C, clock, wait and
// lock functions the shared code in core/gsr_sensor.c works through.

#include "gsr_sensor_flipper.h"
#include <furi.h>
#include <furi_hal.h>
#include <stdlib.h>
#include <stdatomic.h>

#define TAG "GsrSensor"

typedef struct {
    GsrSensor*  gsr;
    FuriThread* thread;
    FuriMutex*  mutex; // the shared code's lock (GsrPlatform.lock/unlock)
    // Optional per-pass hook (see GsrWorkerHook). Set once at alloc, before
    // the worker starts; never changed after.
    GsrWorkerHook hook;
    void*         hook_ctx;
    // Worker reads this every loop iteration (while(f->running)),
    // gsr_sensor_free() writes it once to stop the thread. _Atomic rather
    // than volatile so ThreadSanitizer sees a synchronised access; it
    // compiles to the same instruction on both host and ARM, and the worker
    // seeing it one pass late is harmless.
    _Atomic bool running;
} GsrFlipper;

static void gsr_flipper_lock(void* ctx) {
    GsrFlipper* f = ctx;
    furi_mutex_acquire(f->mutex, FuriWaitForever);
}

static void gsr_flipper_unlock(void* ctx) {
    GsrFlipper* f = ctx;
    furi_mutex_release(f->mutex);
}

// furi_get_tick() counts milliseconds: the Flipper's kernel tick is 1 kHz
// (checked in gsr_sensor_alloc()).
static uint32_t gsr_flipper_now_ms(void* ctx) {
    (void)ctx;
    return furi_get_tick();
}

static void gsr_flipper_delay_ms(void* ctx, uint32_t ms) {
    (void)ctx;
    furi_delay_ms(ms);
}

// The Flipper's I2C calls take the 7-bit address shifted left by one.
static bool gsr_flipper_i2c_read(void* ctx, uint8_t addr, uint8_t reg, uint8_t* data,
                                 size_t len, uint32_t timeout_ms) {
    (void)ctx;
    furi_hal_i2c_acquire(&furi_hal_i2c_handle_external);
    bool ok = furi_hal_i2c_read_mem(
        &furi_hal_i2c_handle_external, (uint8_t)(addr << 1), reg, data, len, timeout_ms);
    furi_hal_i2c_release(&furi_hal_i2c_handle_external);
    return ok;
}

static bool gsr_flipper_i2c_write(void* ctx, uint8_t addr, uint8_t reg, const uint8_t* data,
                                  size_t len, uint32_t timeout_ms) {
    (void)ctx;
    furi_hal_i2c_acquire(&furi_hal_i2c_handle_external);
    bool ok = furi_hal_i2c_write_mem(
        &furi_hal_i2c_handle_external, (uint8_t)(addr << 1), reg, data, len, timeout_ms);
    furi_hal_i2c_release(&furi_hal_i2c_handle_external);
    return ok;
}

static void gsr_flipper_log(void* ctx, bool warning, const char* line) {
    (void)ctx;
    if(warning) {
        FURI_LOG_W(TAG, "%s", line);
    } else {
        FURI_LOG_I(TAG, "%s", line);
    }
}

// The GSR thread: one shared worker pass, the hook's turn after a normal
// read pass, then a 1 ms pause.
static int32_t gsr_flipper_worker(void* context) {
    GsrFlipper* f = context;
    while(f->running) {
        // On the Flipper the hook is em_scan_sampler_poll(), the radio scan.
        if(gsr_sensor_worker_pass(f->gsr) && f->hook) f->hook(f->hook_ctx);
        furi_delay_ms(1);
    }
    return 0;
}

GsrSensor* gsr_sensor_alloc(GsrWorkerHook hook, void* hook_ctx) {
    // furi_check, not furi_assert: this app's build defines FURI_NDEBUG, so
    // furi_assert() compiles to a no-op and would never check anything on a
    // real device.
    furi_check(furi_kernel_get_tick_frequency() == 1000, "GsrSensor: tick is not 1 ms");
    GsrFlipper* f = malloc(sizeof(GsrFlipper));
    furi_check(f, "GsrSensor: alloc failed");
    f->mutex = furi_mutex_alloc(FuriMutexTypeNormal);
    furi_check(f->mutex, "GsrSensor: mutex alloc failed");
    f->hook = hook;
    f->hook_ctx = hook_ctx;

    GsrPlatform platform = {
        .ctx = f,
        .lock = gsr_flipper_lock,
        .unlock = gsr_flipper_unlock,
        .now_ms = gsr_flipper_now_ms,
        .delay_ms = gsr_flipper_delay_ms,
        .i2c_read = gsr_flipper_i2c_read,
        .i2c_write = gsr_flipper_i2c_write,
        .log = gsr_flipper_log,
    };
    f->gsr = gsr_sensor_create(&platform);

    f->running = true;
    f->thread = furi_thread_alloc();
    furi_thread_set_name(f->thread, "GsrSensorWorker");
    furi_thread_set_stack_size(f->thread, 2048);
    furi_thread_set_context(f->thread, f);
    furi_thread_set_callback(f->thread, gsr_flipper_worker);
    furi_thread_start(f->thread);

    return f->gsr;
}

void gsr_sensor_free(GsrSensor* gsr) {
    GsrFlipper* f = gsr_sensor_platform_ctx(gsr); // stops on NULL
    f->running = false;
    furi_thread_join(f->thread);
    furi_thread_free(f->thread);

    gsr_sensor_destroy(gsr); // powers the ADS1115 down

    furi_mutex_free(f->mutex);
    free(f);
}

uint32_t gsr_sensor_get_stack_space(const GsrSensor* gsr) {
    GsrFlipper* f = gsr_sensor_platform_ctx(gsr);
    // furi_thread_get_stack_space() takes a FuriThreadId (the RTOS handle
    // from furi_thread_get_id()), not the FuriThread* wrapper itself.
    FuriThreadId id = furi_thread_get_id(f->thread);
    if(!id) return 0;
    return furi_thread_get_stack_space(id);
}
