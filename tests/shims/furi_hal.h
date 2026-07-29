#pragma once

// furi_hal.h — host-test shim.
//
// Fakes the exact furi_hal_serial_* (gps_uart.c) and furi_hal_i2c_*
// (gsr_sensor.c) surface these drivers call directly — a single simulated
// USART1 and a single simulated I2C bus. Declarations only — see
// furi_hal_mock.c for the implementations and the test-injection APIs
// (furi_hal_mock_feed_byte/_string for UART, furi_hal_i2c_mock_* for I2C).

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

// Test-observable: number of furi_hal_serial_tx() calls since the last
// reset. Used to detect that gps_uart_configure() (re-)ran — e.g. after
// the NMEA watchdog or an RX-buffer-full reinit — without needing to
// inspect the actual bytes sent.
int  furi_hal_mock_tx_count(void);
void furi_hal_mock_reset_tx_count(void);

// ── I2C — gsr_sensor.c's ADS1115 transport ──────────────────────────────
// Content doesn't matter — gsr_sensor.c only ever passes
// &furi_hal_i2c_handle_external through, never dereferences it.
typedef struct FuriHalI2cBusHandle { int unused; } FuriHalI2cBusHandle;
extern const FuriHalI2cBusHandle furi_hal_i2c_handle_external;

void furi_hal_i2c_acquire(const FuriHalI2cBusHandle* handle);
void furi_hal_i2c_release(const FuriHalI2cBusHandle* handle);
bool furi_hal_i2c_read_mem(
    const FuriHalI2cBusHandle* handle,
    uint8_t addr, uint8_t mem_addr,
    uint8_t* data, size_t len, uint32_t timeout_ms);
bool furi_hal_i2c_write_mem(
    const FuriHalI2cBusHandle* handle,
    uint8_t addr, uint8_t mem_addr,
    const uint8_t* data, size_t len, uint32_t timeout_ms);

// ── I2C test-injection API ──────────────────────────────────────────────
// The simulated ADS1115 has one 16-bit conversion register (big-endian,
// matching gsr_sensor.c's `(data[0] << 8) | data[1]`) and one config
// register. All counters are atomic — the worker thread and the test
// thread touch them concurrently by design.

// Value the next (and all subsequent, until changed) CONV_REG read
// returns.
void furi_hal_i2c_mock_set_raw16(int16_t value);

// Number of read_mem calls made so far. Poll this (relative to a
// snapshot) to know the worker has picked up a newly-injected value,
// rather than guessing a sleep duration.
int furi_hal_i2c_mock_read_count(void);

// When true, read_mem returns false unconditionally (simulated I2C
// failure / sensor disconnected).
void furi_hal_i2c_mock_set_read_fail(bool fail);

// When n > 0, every Nth read_mem call fails and the rest succeed — a
// deterministic, precisely-testable intermittent-failure rate (e.g. n=2
// gives exactly 50% success), as opposed to furi_hal_i2c_mock_set_read_fail's
// all-or-nothing. n=0 disables (default).
void furi_hal_i2c_mock_set_fail_every_nth(int n);

// Number of write_mem (CONFIG_REG) calls so far, and the MSB of the most
// recent one — pga_msb(index) encodes the PGA index being switched to.
int     furi_hal_i2c_mock_write_count(void);
uint8_t furi_hal_i2c_mock_last_config_msb(void);

// Reset all of the above to zero/defaults. Call at the start of each test
// — never while a previous test's GsrSensor/worker is still alive.
void furi_hal_i2c_mock_reset(void);

// ── SubGHz — gsr_sensor.c interleaved RSSI reads ─────────────────────────
static inline float furi_hal_subghz_get_rssi(void) { return -91.5f; }
