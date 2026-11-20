#include "gsr_cardputer.h"

#include <M5Cardputer.h>
#include <atomic>

#include "core_check.h"

// The ADS1115 shares the Cardputer's internal I2C bus (G8/G9) with the
// keyboard chip and the audio chip. It must go through M5's In_I2C, the
// same driver M5's own code uses, which locks the bus around every
// transfer: opening the same pins with Arduino's Wire would make two
// drivers fight (docs/cardputer_port.md, "Gotchas").
static const uint32_t I2C_FREQ = 400000;

// Same priority as the Flipper's GSR thread relative to its main loop:
// above it, so a slow screen push or SD write never delays a read. It
// sleeps 1 ms after every pass, so the main loop still gets the processor.
static const UBaseType_t GSR_TASK_PRIORITY = 2;
static const uint32_t    GSR_TASK_STACK = 4096;  // bytes

struct GsrCardputer {
    GsrSensor*         gsr = nullptr;
    SemaphoreHandle_t  mutex = nullptr;  // the shared code's lock
    TaskHandle_t       task = nullptr;
    std::atomic<bool>  running{false};
    std::atomic<bool>  finished{false};
};

static void plat_lock(void* ctx) {
    xSemaphoreTake(static_cast<GsrCardputer*>(ctx)->mutex, portMAX_DELAY);
}

static void plat_unlock(void* ctx) {
    xSemaphoreGive(static_cast<GsrCardputer*>(ctx)->mutex);
}

static uint32_t plat_now_ms(void* ctx) {
    (void)ctx;
    return millis();
}

static void plat_delay_ms(void* ctx, uint32_t ms) {
    (void)ctx;
    delay(ms);
}

// M5's driver has no per-call timeout; it gives up on its own when the
// chip doesn't answer.
static bool plat_i2c_read(void* ctx, uint8_t addr, uint8_t reg, uint8_t* data, size_t len,
                          uint32_t timeout_ms) {
    (void)ctx;
    (void)timeout_ms;
    return M5.In_I2C.readRegister(addr, reg, data, len, I2C_FREQ);
}

static bool plat_i2c_write(void* ctx, uint8_t addr, uint8_t reg, const uint8_t* data, size_t len,
                           uint32_t timeout_ms) {
    (void)ctx;
    (void)timeout_ms;
    return M5.In_I2C.writeRegister(addr, reg, data, len, I2C_FREQ);
}

static void plat_log(void* ctx, bool warning, const char* line) {
    (void)ctx;
    Serial.printf("[GSR]%s %s\n", warning ? " warning:" : "", line);
}

// The GSR thread: one shared worker pass, then a 1 ms pause, as on the
// Flipper. There is no other job to share the thread with (the radio scan
// is Flipper-only).
static void gsr_task(void* arg) {
    auto* g = static_cast<GsrCardputer*>(arg);
    while(g->running) {
        gsr_sensor_worker_pass(g->gsr);
        vTaskDelay(1);
    }
    g->finished = true;
    vTaskDelete(nullptr);
}

GsrSensor* gsr_cardputer_start(void) {
    // vTaskDelay(1) is the 1 ms pause only with a 1 kHz tick.
    CORE_CHECK(configTICK_RATE_HZ == 1000, "GsrSensor: tick is not 1 ms");
    auto* g = new GsrCardputer();
    g->mutex = xSemaphoreCreateMutex();
    CORE_CHECK(g->mutex, "GsrSensor: mutex alloc failed");

    GsrPlatform platform = {};
    platform.ctx = g;
    platform.lock = plat_lock;
    platform.unlock = plat_unlock;
    platform.now_ms = plat_now_ms;
    platform.delay_ms = plat_delay_ms;
    platform.i2c_read = plat_i2c_read;
    platform.i2c_write = plat_i2c_write;
    platform.log = plat_log;
    g->gsr = gsr_sensor_create(&platform);

    g->running = true;
    // Pinned to the same core as the main loop (core 1), like the Flipper's
    // single core: core 0 is left for the radio stack (Bluetooth, step 11).
    BaseType_t ok = xTaskCreatePinnedToCore(gsr_task, "gsr", GSR_TASK_STACK, g,
                                            GSR_TASK_PRIORITY, &g->task, 1);
    CORE_CHECK(ok == pdPASS, "GsrSensor: task create failed");
    return g->gsr;
}

void gsr_cardputer_stop(GsrSensor* gsr) {
    auto* g = static_cast<GsrCardputer*>(gsr_sensor_platform_ctx(gsr));  // stops on NULL
    g->running = false;
    while(!g->finished) delay(1);
    gsr_sensor_destroy(gsr);  // powers the ADS1115 down
    vSemaphoreDelete(g->mutex);
    delete g;
}

uint32_t gsr_cardputer_stack_free(const GsrSensor* gsr) {
    auto* g = static_cast<GsrCardputer*>(gsr_sensor_platform_ctx(gsr));
    if(!g->task || g->finished) return 0;
    return uxTaskGetStackHighWaterMark(g->task);
}
