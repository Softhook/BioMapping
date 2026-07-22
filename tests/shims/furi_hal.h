#pragma once

// furi_hal.h — host-test shim.
//
// Fakes the exact furi_hal_serial_* surface gps_uart.c calls directly
// (single simulated USART1 peripheral). Declarations only — see
// furi_hal_mock.c for the implementation and the test-injection API
// (furi_hal_mock_feed_byte/_string) that lets a test simulate bytes
// arriving from the ISR.

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef enum { FuriHalSerialIdUsart } FuriHalSerialId;
typedef enum { FuriHalSerialRxEventData } FuriHalSerialRxEvent;

typedef struct FuriHalSerialHandle FuriHalSerialHandle;

typedef void (*FuriHalSerialAsyncRxCallback)(
    FuriHalSerialHandle* handle, FuriHalSerialRxEvent event, void* context);

FuriHalSerialHandle* furi_hal_serial_control_acquire(FuriHalSerialId id);
void furi_hal_serial_control_release(FuriHalSerialHandle* handle);

void furi_hal_serial_init(FuriHalSerialHandle* handle, uint32_t baud);
void furi_hal_serial_deinit(FuriHalSerialHandle* handle);

void furi_hal_serial_async_rx_start(
    FuriHalSerialHandle* handle,
    FuriHalSerialAsyncRxCallback callback,
    void* context,
    bool report_errors);
void furi_hal_serial_async_rx_stop(FuriHalSerialHandle* handle);
uint8_t furi_hal_serial_async_rx(FuriHalSerialHandle* handle);

void furi_hal_serial_tx(FuriHalSerialHandle* handle, const uint8_t* data, size_t len);

// ── Test-injection API ──────────────────────────────────────────────────
// Feed a byte into the currently-registered RX callback, simulating a byte
// arriving from the ISR. No-op if gps_uart hasn't started RX yet.
void furi_hal_mock_feed_byte(uint8_t byte);
void furi_hal_mock_feed_string(const char* s);

// Test-observable: number of furi_hal_serial_control_acquire() calls
// currently unreleased (mirrors real hardware: only one USART1).
int furi_hal_mock_acquire_count(void);
