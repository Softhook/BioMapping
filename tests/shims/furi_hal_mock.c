// furi_hal_mock.c — test-only backend for the furi_hal.h shim.
// Simulates a single USART1 peripheral so tests can drive gps_uart.c's
// real RX/parsing path by injecting bytes as if they'd arrived from the
// ISR. See furi_hal.h for the test-facing API.

#include "furi_hal.h"

struct FuriHalSerialHandle {
    FuriHalSerialAsyncRxCallback cb;
    void*                        context;
    int                          running;
    uint8_t                      pending_byte;
};

// Single static instance — mirrors real hardware (one USART1).
static struct FuriHalSerialHandle g_handle;
static int g_acquired = 0;

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
