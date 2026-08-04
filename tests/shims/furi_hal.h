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

// Makes read_mem/write_mem sleep (a REAL usleep, not the fake tick) for
// `ms` before returning — simulates a slow/stuck ADS1115 I2C transaction,
// same purpose and shape as furi_hal_subghz_mock_set_rssi_delay_ms() for
// the RF SPI path. Applies to BOTH calls (one knob, since gsr_sensor.c
// times them into the same i2c_peak_ms column). 0 (default) disables it.
void furi_hal_i2c_mock_set_delay_ms(uint32_t ms);

// True for the exact real-time span read_mem/write_mem is inside its
// (possibly artificially delayed) call — same purpose as
// furi_hal_subghz_mock_rssi_call_in_progress() below.
bool furi_hal_i2c_mock_call_in_progress(void);

// ── SubGHz — gsr_sensor.c interleaved RSSI reads ─────────────────────────
// Real function (not static inline) so tests can control its return value —
// mirrors the I2C mock pattern above. The worker loop that calls this spins
// unthrottled (furi_delay_ms() is a no-op in this harness) and can race
// through several band rotations between two of the test thread's polling
// wake-ups, so none of the setters below are meant to be changed reactively
// mid-test — configure everything before enabling RF, then let the mock
// resolve the right value off its own band/visit bookkeeping. See the
// longer comment above the implementation in furi_hal_mock.c.
float furi_hal_subghz_get_rssi(void);

// Flat value returned for every band/visit that has no more specific
// override below. Defaults to -91.5f (quiet-floor reading).
void furi_hal_subghz_mock_set_rssi(float value);

// Makes the FIRST call after every single band rotation (any band, any
// visit number — auto-rearmed each time, not a one-shot) return `value`;
// every other read within that same dwell falls back to the default/
// per-visit table. For simulating a brief transient burst that a naive
// instantaneous read would usually miss but peak-hold-over-a-dwell should
// still capture — deliberately NOT a plain "next call only" one-shot: the
// worker can race through several dwells before a test gets around to
// checking anything (see the header comment above), so a one-shot would
// only cover one specific dwell and a test would have no way to guarantee
// it's still looking at that same dwell by the time it checks.
void furi_hal_subghz_mock_set_first_read_of_each_dwell(float value);

// Pins the value returned for every read while `band` (0-based) is active
// during its `visit_1based`'th dwell (1 = the first time this band is
// scanned since RF was enabled, 2 = the second, ...) — for simulating a
// band whose ambient level genuinely changes between one visit and the
// next (e.g. peak-hold decay: strong on visit 1, quiet by visit 2).
void furi_hal_subghz_mock_set_rssi_for_band_visit(int band, int visit_1based, float value);

// Number of furi_hal_subghz_get_rssi() calls so far — one per worker-loop
// iteration while RF is enabled. Poll this (relative to a snapshot) instead
// of guessing a sleep duration, same as furi_hal_i2c_mock_read_count().
int furi_hal_subghz_mock_get_rssi_call_count(void);

// Makes furi_hal_subghz_get_rssi() sleep (a REAL usleep, not the fake tick)
// for `ms` before returning — simulates a slow/stuck SPI transaction, the
// real-world shape of the unbounded furi_hal_spi_bus_end_txrx() busy-wait
// (see em_scan_rf_crash_investigation.md). For proving properties like
// "get_rf_snapshot() doesn't block behind an in-flight RF SPI call" without
// needing the real firmware bug to actually happen. 0 (the default) means
// no artificial delay.
void furi_hal_subghz_mock_set_rssi_delay_ms(uint32_t ms);

// True for the exact real-time span furi_hal_subghz_get_rssi() is inside
// its (possibly artificially delayed) call — lets a test wait until the
// worker has demonstrably ENTERED the slow call, not just been scheduled,
// before poking at whatever concurrent behavior it wants to test.
bool furi_hal_subghz_mock_rssi_call_in_progress(void);

void furi_hal_subghz_mock_reset(void);

// ── em_scan_rf_* — band control, called from the same interleaved block ──
// Real (non-weak-no-op) implementations that record what gsr_sensor.c
// actually asked for, so tests can assert on init/deinit lifecycle and on
// band rotation.
int em_scan_rf_mock_init_count(void);
int em_scan_rf_mock_deinit_count(void);
int em_scan_rf_mock_set_band_count(void);

// Wherever the worker happens to be *right now*. Only useful for a
// same-thread-of-execution synchronous check (e.g. immediately after
// gsr_sensor_set_rf_enabled(true) returns, which synchronously arms band 0
// before the worker can touch anything) — do NOT poll this waiting for it
// to change to some specific value: the worker can race through several
// rotations between two test-thread polls (in practice, 10,000+ loop
// iterations can elapse in the time it takes this thread to wake up even
// once), so a poll may never observe the exact value you're waiting for.
int em_scan_rf_mock_last_band(void);

// How many times `band` (0-based) has become active — 1 the first time
// it's scanned since RF was enabled, 2 the second, etc. Monotonic, so
// "wait until em_scan_rf_mock_visit_count(band) >= N" is safe to poll
// regardless of how far the worker has raced ahead by the time it's
// checked — unlike em_scan_rf_mock_last_band().
int em_scan_rf_mock_visit_count(int band);

// Makes em_scan_rf_set_band() sleep (a REAL usleep, not the fake tick) for
// `ms` before returning — simulates a slow/stuck band retune (the real
// function is four chained CC1101 SPI transactions), same purpose and
// shape as furi_hal_subghz_mock_set_rssi_delay_ms(). 0 (default) disables
// it. Also reset by em_scan_rf_mock_reset().
void em_scan_rf_mock_set_set_band_delay_ms(uint32_t ms);

// True for the exact real-time span em_scan_rf_set_band() is inside its
// (possibly artificially delayed) call — same purpose as
// furi_hal_subghz_mock_rssi_call_in_progress().
bool em_scan_rf_mock_set_band_call_in_progress(void);

int em_scan_rf_mock_fast_sweep_count(void);
void em_scan_rf_mock_set_fast_sweep_delay_ms(uint32_t ms);
bool em_scan_rf_mock_fast_sweep_call_in_progress(void);

void em_scan_rf_mock_reset(void);
