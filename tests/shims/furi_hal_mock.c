// furi_hal_mock.c — test-only backend for the furi_hal.h shim.
// Simulates a single USART1 peripheral (gps_uart.c) and a single I2C bus
// with one ADS1115-shaped device (gsr_sensor.c). See furi_hal.h for the
// test-facing APIs.

#include "furi_hal.h"
#include "furi.h"
#include <stdatomic.h>
#include <unistd.h>
#include "em_scan_rf.h"

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
// Simulates a slow/stuck I2C transaction — same real-usleep stand-in as
// furi_hal_subghz_mock_set_rssi_delay_ms(), for a stuck ADS1115 transfer
// instead of a stuck CC1101 one. Applied to BOTH read_mem and write_mem
// (one knob for either call site, mirroring gsr_sensor.c's i2c_peak_ms
// column covering both) — unconditionally, before any
// success/failure resolution, same ordering as the RSSI mock. 0 (default)
// disables the artificial delay.
static _Atomic uint32_t g_i2c_delay_ms = 0;
// True for the exact real-time span read_mem/write_mem is inside its
// (possibly artificially delayed) call — mirrors
// furi_hal_subghz_mock_rssi_call_in_progress(), same purpose.
static _Atomic bool     g_i2c_call_in_progress = false;

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
    atomic_store(&g_i2c_call_in_progress, true);
    uint32_t delay_ms = atomic_load(&g_i2c_delay_ms);
    if(delay_ms > 0) {
        usleep(delay_ms * 1000);
    }
    int call_num = atomic_fetch_add(&g_read_count, 1) + 1; // 1-based
    if(atomic_load(&g_read_fail)) {
        atomic_store(&g_i2c_call_in_progress, false);
        return false;
    }
    int n = atomic_load(&g_fail_every_nth);
    if(n > 0 && (call_num % n) == 0) {
        atomic_store(&g_i2c_call_in_progress, false);
        return false;
    }

    int16_t v = atomic_load(&g_raw16);
    if(len >= 1) data[0] = (uint8_t)((uint16_t)v >> 8);
    if(len >= 2) data[1] = (uint8_t)((uint16_t)v & 0xFF);
    atomic_store(&g_i2c_call_in_progress, false);
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
    atomic_store(&g_i2c_call_in_progress, true);
    uint32_t delay_ms = atomic_load(&g_i2c_delay_ms);
    if(delay_ms > 0) {
        usleep(delay_ms * 1000);
    }
    atomic_fetch_add(&g_write_count, 1);
    if(len >= 1) atomic_store(&g_last_config_msb, data[0]);
    atomic_store(&g_i2c_call_in_progress, false);
    return true;
}

void furi_hal_i2c_mock_set_delay_ms(uint32_t ms) {
    atomic_store(&g_i2c_delay_ms, ms);
}

bool furi_hal_i2c_mock_call_in_progress(void) {
    return atomic_load(&g_i2c_call_in_progress);
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
    atomic_store(&g_i2c_delay_ms, 0);
    atomic_store(&g_i2c_call_in_progress, false);
}

// ── SubGHz RF band-control stubs for host test harness ──────────────────
// Weak so a test that ever links the real em_scan/em_scan_rf.c in addition
// to this mock gets the real (strong) symbol instead of silently keeping
// this one.
//
// gsr_sensor.c's worker loop runs unthrottled here (furi_delay_ms() is a
// no-op — see the file banner). In practice it can rack up 10,000+
// iterations (tens of band rotations) in the time it takes the test
// thread's polling loop to wake up even ONCE — an earlier version of this
// mock kept a small fixed-size ring buffer of "which band was call #N",
// meant to be read back at small fixed indices regardless of how far the
// worker had raced ahead; that overshoot turned out to wrap even a
// 64-entry buffer within a single poll, silently corrupting index 0.
// Every RF mock below is instead built from state that either (a) is a
// plain monotonic count, safe to threshold with "at least N" — count-based
// but never read back element-by-element — or (b) is resolved by the
// worker itself from its OWN current band/visit bookkeeping (the
// per-(band,visit) RSSI table below), so what value comes back never
// depends on the test thread's timing at all. "Wait for band to differ
// from X" (an even earlier version) is similarly unreliable — by the time
// the test thread notices *some* change, the band may already be several
// more steps past X than expected.
#define RF_MOCK_MAX_BANDS  8
#define RF_MOCK_MAX_VISITS 8

static _Atomic int   g_rf_init_count     = 0;
static _Atomic int   g_rf_deinit_count   = 0;
static _Atomic int   g_rf_set_band_count = 0;
static _Atomic int   g_rf_last_band      = -1;
static _Atomic int   g_rf_current_band   = -1;
static _Atomic int   g_rf_band_visit_count[RF_MOCK_MAX_BANDS]; // 1-based: 1 = currently on its 1st dwell

static _Atomic int      g_rf_fast_sweep_count = 0;
static _Atomic uint32_t g_rf_fast_sweep_delay_ms = 0;
static _Atomic bool     g_rf_fast_sweep_call_in_progress = false;
// Simulates a slow/stuck per-band retune sub-step specifically (distinct
// from g_rf_fast_sweep_delay_ms, which delays the whole call) — lets a test
// exercise em_scan_rf_fast_sweep_snapshot()'s out_retune_peak_ms param in
// isolation. Applied once, before the first band, same real-usleep
// technique as the other *_delay_ms mocks.
static _Atomic uint32_t g_rf_retune_delay_ms = 0;
static _Atomic bool     g_rf_retune_call_in_progress = false;

// Set true by em_scan_rf_set_band() on every rotation (including the
// initial arm-to-band-0) and consumed by the very next
// furi_hal_subghz_get_rssi() call — i.e. "the first sample of whichever
// dwell is currently in progress", regardless of which band or which visit
// number that dwell is. See furi_hal_subghz_mock_set_first_read_of_each_dwell().
static _Atomic bool  g_subghz_first_read_pending        = false;
static _Atomic bool  g_subghz_first_read_spike_enabled  = false;
static _Atomic float g_subghz_first_read_spike_value    = 0.0f;
// Simulates a slow/stuck band-retune (the real function is four chained
// CC1101 SPI transactions — idle/flush_rx/set_frequency_and_path/rx, see
// em_scan_rf.c) — same real-usleep stand-in as
// furi_hal_subghz_mock_set_rssi_delay_ms(), applied unconditionally before
// the rest of this mock's bookkeeping. 0 (default) disables it.
static _Atomic uint32_t g_rf_set_band_delay_ms = 0;
// True for the exact real-time span em_scan_rf_set_band() is inside its
// (possibly artificially delayed) call — mirrors
// furi_hal_subghz_mock_rssi_call_in_progress(), same purpose.
static _Atomic bool     g_rf_set_band_call_in_progress = false;

__attribute__((weak)) void em_scan_rf_init(void) {
    atomic_fetch_add(&g_rf_init_count, 1);
}
__attribute__((weak)) void em_scan_rf_deinit(void) {
    atomic_fetch_add(&g_rf_deinit_count, 1);
}
__attribute__((weak)) void em_scan_rf_set_band(int band_index) {
    atomic_store(&g_rf_set_band_call_in_progress, true);
    uint32_t delay_ms = atomic_load(&g_rf_set_band_delay_ms);
    if(delay_ms > 0) {
        usleep(delay_ms * 1000);
    }
    atomic_fetch_add(&g_rf_set_band_count, 1);
    atomic_store(&g_rf_last_band, band_index);
    atomic_store(&g_rf_current_band, band_index);
    if(band_index >= 0 && band_index < RF_MOCK_MAX_BANDS) {
        atomic_fetch_add(&g_rf_band_visit_count[band_index], 1);
    }
    atomic_store(&g_subghz_first_read_pending, true);
    atomic_store(&g_rf_set_band_call_in_progress, false);
}

void em_scan_rf_mock_set_set_band_delay_ms(uint32_t ms) {
    atomic_store(&g_rf_set_band_delay_ms, ms);
}

bool em_scan_rf_mock_set_band_call_in_progress(void) {
    return atomic_load(&g_rf_set_band_call_in_progress);
}

int em_scan_rf_mock_init_count(void) {
    return atomic_load(&g_rf_init_count);
}
int em_scan_rf_mock_deinit_count(void) {
    return atomic_load(&g_rf_deinit_count);
}
int em_scan_rf_mock_set_band_count(void) {
    return atomic_load(&g_rf_set_band_count);
}
int em_scan_rf_mock_last_band(void) {
    return atomic_load(&g_rf_last_band);
}
// How many times `band` has become active (1 = currently/most-recently on
// its first dwell, 2 = its second, ...). Monotonic — safe to threshold
// with "at least N" regardless of how far the worker has since continued,
// unlike a fixed-size history buffer indexed by absolute call number.
int em_scan_rf_mock_visit_count(int band) {
    if(band < 0 || band >= RF_MOCK_MAX_BANDS) return 0;
    return atomic_load(&g_rf_band_visit_count[band]);
}
void em_scan_rf_mock_reset(void) {
    atomic_store(&g_rf_init_count, 0);
    atomic_store(&g_rf_deinit_count, 0);
    atomic_store(&g_rf_set_band_count, 0);
    atomic_store(&g_rf_last_band, -1);
    atomic_store(&g_rf_current_band, -1);
    for(int i = 0; i < RF_MOCK_MAX_BANDS; i++) atomic_store(&g_rf_band_visit_count[i], 0);
    atomic_store(&g_subghz_first_read_pending, false);
    atomic_store(&g_rf_set_band_delay_ms, 0);
    atomic_store(&g_rf_set_band_call_in_progress, false);
    atomic_store(&g_rf_fast_sweep_count, 0);
    atomic_store(&g_rf_fast_sweep_delay_ms, 0);
    atomic_store(&g_rf_fast_sweep_call_in_progress, false);
    atomic_store(&g_rf_retune_delay_ms, 0);
    atomic_store(&g_rf_retune_call_in_progress, false);
}

__attribute__((weak)) void em_scan_rf_fast_sweep_snapshot(
    float     out_rssi_dbm[EM_SCAN_NUM_FREQS],
    uint32_t* out_retune_peak_ms) {
    atomic_store(&g_rf_fast_sweep_call_in_progress, true);
    uint32_t delay_ms = atomic_load(&g_rf_fast_sweep_delay_ms);
    if(delay_ms > 0) {
        usleep(delay_ms * 1000);
    }

    // Retune sub-step timing, measured the same way the real implementation
    // does (furi_get_tick() before/after) — see furi.h's furi_test_tick doc
    // comment for why this correctly picks up a test's furi_test_advance_tick()
    // call made while g_rf_retune_call_in_progress is true, even though the
    // usleep() below runs on the real OS clock, not the fake one.
    uint32_t retune_start = furi_get_tick();
    uint32_t retune_delay_ms = atomic_load(&g_rf_retune_delay_ms);
    if(retune_delay_ms > 0) {
        atomic_store(&g_rf_retune_call_in_progress, true);
        usleep(retune_delay_ms * 1000);
        atomic_store(&g_rf_retune_call_in_progress, false);
    }
    if(out_retune_peak_ms) *out_retune_peak_ms = furi_get_tick() - retune_start;

    atomic_fetch_add(&g_rf_fast_sweep_count, 1);
    for(int i = 0; i < EM_SCAN_NUM_FREQS; i++) {
        atomic_store(&g_rf_current_band, i);
        if(i < RF_MOCK_MAX_BANDS) {
            atomic_fetch_add(&g_rf_band_visit_count[i], 1);
        }
        atomic_store(&g_subghz_first_read_pending, true);
        out_rssi_dbm[i] = furi_hal_subghz_get_rssi();
    }
    atomic_store(&g_rf_fast_sweep_call_in_progress, false);
}

int em_scan_rf_mock_fast_sweep_count(void) {
    return atomic_load(&g_rf_fast_sweep_count);
}

void em_scan_rf_mock_set_fast_sweep_delay_ms(uint32_t ms) {
    atomic_store(&g_rf_fast_sweep_delay_ms, ms);
}

bool em_scan_rf_mock_fast_sweep_call_in_progress(void) {
    return atomic_load(&g_rf_fast_sweep_call_in_progress);
}

void em_scan_rf_mock_set_retune_delay_ms(uint32_t ms) {
    atomic_store(&g_rf_retune_delay_ms, ms);
}

bool em_scan_rf_mock_retune_call_in_progress(void) {
    return atomic_load(&g_rf_retune_call_in_progress);
}

// ── SubGHz — gsr_sensor.c's interleaved RSSI read ───────────────────────
// Resolution order per call: (1) the first-read-of-a-dwell spike, if
// enabled — auto-rearmed by em_scan_rf_set_band() on every rotation
// (including the initial arm-to-band-0), so it applies to whichever dwell
// is *currently* in progress no matter how many rotations have already
// happened by the time a test gets around to checking anything — a plain
// "return this once" flag would only cover ONE specific dwell, and the
// worker can race through several dwells between two of the test thread's
// polls (see the file-banner comment on the RF band-control stubs above),
// so a test has no way to guarantee it wins that race; (2) a value pinned
// to the (current band, current visit-to-that-band) pair — for simulating
// a band whose ambient level differs between one dwell and the next; (3)
// the flat default. All configured before gsr_sensor_set_rf_enabled(true)
// is even called; (1) and (2) are then resolved using state
// em_scan_rf_set_band() (called from the SAME worker thread, immediately
// before this function starts being called for the new band/dwell) has
// already recorded, never by the test thread reacting to something
// mid-flight.
static _Atomic float    g_subghz_rssi_default = -91.5f;
static _Atomic int      g_subghz_rssi_count   = 0;
static _Atomic float    g_rssi_band_visit[RF_MOCK_MAX_BANDS][RF_MOCK_MAX_VISITS];
static _Atomic bool     g_rssi_band_visit_set[RF_MOCK_MAX_BANDS][RF_MOCK_MAX_VISITS];
static _Atomic uint32_t g_subghz_rssi_delay_ms       = 0;
static _Atomic bool     g_subghz_rssi_call_in_progress = false;

float furi_hal_subghz_get_rssi(void) {
    atomic_store(&g_subghz_rssi_call_in_progress, true);
    uint32_t delay_ms = atomic_load(&g_subghz_rssi_delay_ms);
    if(delay_ms > 0) {
        usleep(delay_ms * 1000);
    }
    atomic_fetch_add(&g_subghz_rssi_count, 1);

    float result;
    if(atomic_exchange(&g_subghz_first_read_pending, false) &&
       atomic_load(&g_subghz_first_read_spike_enabled)) {
        result = atomic_load(&g_subghz_first_read_spike_value);
        atomic_store(&g_subghz_rssi_call_in_progress, false);
        return result;
    }

    int band = atomic_load(&g_rf_current_band);
    if(band >= 0 && band < RF_MOCK_MAX_BANDS) {
        int visit = atomic_load(&g_rf_band_visit_count[band]); // 1-based
        int vidx = visit - 1;
        if(vidx >= 0 && vidx < RF_MOCK_MAX_VISITS &&
           atomic_load(&g_rssi_band_visit_set[band][vidx])) {
            result = atomic_load(&g_rssi_band_visit[band][vidx]);
            atomic_store(&g_subghz_rssi_call_in_progress, false);
            return result;
        }
    }
    result = atomic_load(&g_subghz_rssi_default);
    atomic_store(&g_subghz_rssi_call_in_progress, false);
    return result;
}

// Simulates a slow/stuck SPI transaction — see the doc comment in
// furi_hal.h. 0 (default) disables the artificial delay.
void furi_hal_subghz_mock_set_rssi_delay_ms(uint32_t ms) {
    atomic_store(&g_subghz_rssi_delay_ms, ms);
}

bool furi_hal_subghz_mock_rssi_call_in_progress(void) {
    return atomic_load(&g_subghz_rssi_call_in_progress);
}

// Flat default returned for every band/visit that has no more specific
// override configured.
void furi_hal_subghz_mock_set_rssi(float value) {
    atomic_store(&g_subghz_rssi_default, value);
}

// Makes the FIRST furi_hal_subghz_get_rssi() call after every single
// em_scan_rf_set_band() rotation (any band, any visit number) return
// `value`; every other read within that same dwell falls back to the
// default/per-visit table. For simulating a single-sample transient burst
// that a naive instantaneous read would usually miss but peak-hold-over-a-
// dwell should still capture — race-free (see the resolution-order
// comment above) regardless of how many dwells have already completed by
// the time a test inspects the result.
void furi_hal_subghz_mock_set_first_read_of_each_dwell(float value) {
    atomic_store(&g_subghz_first_read_spike_value, value);
    atomic_store(&g_subghz_first_read_spike_enabled, true);
}

// Pins the value returned for every read while `band` is active during its
// `visit_1based`'th dwell (1 = first time this band is scanned, 2 = second,
// ...). Must be configured before enabling RF — see file-banner comment.
void furi_hal_subghz_mock_set_rssi_for_band_visit(int band, int visit_1based, float value) {
    int vidx = visit_1based - 1;
    if(band < 0 || band >= RF_MOCK_MAX_BANDS) return;
    if(vidx < 0 || vidx >= RF_MOCK_MAX_VISITS) return;
    atomic_store(&g_rssi_band_visit[band][vidx], value);
    atomic_store(&g_rssi_band_visit_set[band][vidx], true);
}

int furi_hal_subghz_mock_get_rssi_call_count(void) {
    return atomic_load(&g_subghz_rssi_count);
}

void furi_hal_subghz_mock_reset(void) {
    atomic_store(&g_subghz_rssi_default, -91.5f);
    atomic_store(&g_subghz_rssi_count, 0);
    atomic_store(&g_subghz_first_read_pending, false);
    atomic_store(&g_subghz_first_read_spike_enabled, false);
    atomic_store(&g_subghz_first_read_spike_value, 0.0f);
    atomic_store(&g_subghz_rssi_delay_ms, 0);
    atomic_store(&g_subghz_rssi_call_in_progress, false);
    for(int b = 0; b < RF_MOCK_MAX_BANDS; b++) {
        for(int v = 0; v < RF_MOCK_MAX_VISITS; v++) {
            atomic_store(&g_rssi_band_visit_set[b][v], false);
        }
    }
}
