// furi_hal_mock.c — test-only backend for the furi_hal.h shim.
// Simulates a single USART1 peripheral (gps_uart.c) and a single I2C bus
// with one ADS1115-shaped device (gsr_sensor.c). See furi_hal.h for the
// test-facing APIs.

#include "furi_hal.h"
#include <stdatomic.h>

struct FuriHalSerialHandle {
    FuriHalSerialAsyncRxCallback cb;
    void*                        context;
    int                          running;
    uint8_t                      pending_byte;
};

// Single static instance — mirrors real hardware (one USART1).
static struct FuriHalSerialHandle g_handle;
static int g_acquired = 0;
static int g_tx_count = 0;

FuriHalSerialHandle* furi_hal_serial_control_acquire(FuriHalSerialId id) {
    (void)id;
    if(g_acquired) return NULL;
    g_acquired = 1;
    g_handle.cb      = NULL;
    g_handle.context = NULL;
    g_handle.running = 0;
    return &g_handle;
}

void furi_hal_serial_control_release(FuriHalSerialHandle* handle) {
    (void)handle;
    g_acquired = 0;
}

void furi_hal_serial_init(FuriHalSerialHandle* handle, uint32_t baud) {
    (void)handle;
    (void)baud;
}

void furi_hal_serial_deinit(FuriHalSerialHandle* handle) {
    (void)handle;
}

void furi_hal_serial_async_rx_start(
    FuriHalSerialHandle* handle,
    FuriHalSerialAsyncRxCallback callback,
    void* context,
    bool report_errors) {
    (void)report_errors;
    handle->cb      = callback;
    handle->context = context;
    handle->running = 1;
}

void furi_hal_serial_async_rx_stop(FuriHalSerialHandle* handle) {
    handle->running = 0;
}

uint8_t furi_hal_serial_async_rx(FuriHalSerialHandle* handle) {
    return handle->pending_byte;
}

void furi_hal_serial_tx(FuriHalSerialHandle* handle, const uint8_t* data, size_t len) {
    (void)handle;
    (void)data;
    (void)len;
    g_tx_count++;
}

void furi_hal_mock_feed_byte(uint8_t byte) {
    if(g_handle.running && g_handle.cb) {
        g_handle.pending_byte = byte;
        g_handle.cb(&g_handle, FuriHalSerialRxEventData, g_handle.context);
    }
}

void furi_hal_mock_feed_string(const char* s) {
    for(const char* p = s; *p; p++) {
        furi_hal_mock_feed_byte((uint8_t)*p);
    }
}

int furi_hal_mock_acquire_count(void) {
    return g_acquired;
}

int furi_hal_mock_tx_count(void) {
    return g_tx_count;
}

void furi_hal_mock_reset_tx_count(void) {
    g_tx_count = 0;
}

// ── I2C — simulated ADS1115 ─────────────────────────────────────────────
// Touched from both the gsr_sensor.c worker thread and the test's main
// thread, so every bit of state here is atomic — this is real concurrency,
// not single-threaded host-test convenience.

const FuriHalI2cBusHandle furi_hal_i2c_handle_external = {0};

static _Atomic int16_t  g_raw16       = 0;
static _Atomic int      g_read_count  = 0;
static _Atomic bool     g_read_fail   = false;
static _Atomic int      g_fail_every_nth = 0;
static _Atomic int      g_write_count = 0;
static _Atomic uint8_t  g_last_config_msb = 0;

void furi_hal_i2c_acquire(const FuriHalI2cBusHandle* handle) {
    (void)handle;
}

void furi_hal_i2c_release(const FuriHalI2cBusHandle* handle) {
    (void)handle;
}

bool furi_hal_i2c_read_mem(
    const FuriHalI2cBusHandle* handle,
    uint8_t addr, uint8_t mem_addr,
    uint8_t* data, size_t len, uint32_t timeout_ms) {
    (void)handle;
    (void)addr;
    (void)mem_addr;
    (void)timeout_ms;
    int call_num = atomic_fetch_add(&g_read_count, 1) + 1; // 1-based
    if(atomic_load(&g_read_fail)) return false;
    int n = atomic_load(&g_fail_every_nth);
    if(n > 0 && (call_num % n) == 0) return false;

    int16_t v = atomic_load(&g_raw16);
    if(len >= 1) data[0] = (uint8_t)((uint16_t)v >> 8);
    if(len >= 2) data[1] = (uint8_t)((uint16_t)v & 0xFF);
    return true;
}

bool furi_hal_i2c_write_mem(
    const FuriHalI2cBusHandle* handle,
    uint8_t addr, uint8_t mem_addr,
    const uint8_t* data, size_t len, uint32_t timeout_ms) {
    (void)handle;
    (void)addr;
    (void)mem_addr;
    (void)timeout_ms;
    atomic_fetch_add(&g_write_count, 1);
    if(len >= 1) atomic_store(&g_last_config_msb, data[0]);
    return true;
}

void furi_hal_i2c_mock_set_raw16(int16_t value) {
    atomic_store(&g_raw16, value);
}

int furi_hal_i2c_mock_read_count(void) {
    return atomic_load(&g_read_count);
}

void furi_hal_i2c_mock_set_read_fail(bool fail) {
    atomic_store(&g_read_fail, fail);
}

void furi_hal_i2c_mock_set_fail_every_nth(int n) {
    atomic_store(&g_fail_every_nth, n);
}

int furi_hal_i2c_mock_write_count(void) {
    return atomic_load(&g_write_count);
}

uint8_t furi_hal_i2c_mock_last_config_msb(void) {
    return atomic_load(&g_last_config_msb);
}

void furi_hal_i2c_mock_reset(void) {
    atomic_store(&g_raw16, 0);
    atomic_store(&g_read_count, 0);
    atomic_store(&g_read_fail, false);
    atomic_store(&g_fail_every_nth, 0);
    atomic_store(&g_write_count, 0);
    atomic_store(&g_last_config_msb, 0);
}

// ── Weak SubGHz RF stubs for host test harness ────────────────────────
__attribute__((weak)) void em_scan_rf_init(void) {}
__attribute__((weak)) void em_scan_rf_deinit(void) {}
__attribute__((weak)) void em_scan_rf_set_band(int band_index) { (void)band_index; }
