// furi_hal_subghz_mock.c — test-only backend for the furi_hal_subghz.h shim.
//
// Single-threaded by design: em_scan_rf.c's public functions are plain
// synchronous calls (no background thread of their own, unlike
// gsr_sensor.c's worker), so tests/test_em_scan_rf.c calls them directly
// from main() — no pthread, no atomics needed here.
//
// furi_hal_subghz_get_rssi() advances the shared fake tick
// (tests/shims/furi.h's furi_test_tick) by 1 on every call. This is what
// lets em_scan_rf_dwell_band()'s peak-hold loop — which polls
// furi_get_tick() against a start mark with no other clock source, since
// furi_delay_ms() is a no-op in this harness — terminate deterministically
// after exactly EM_SCAN_DWELL_MS calls instead of spinning forever. Safe
// only because this mock is never linked alongside furi_hal_mock.c (whose
// own furi_hal_subghz_get_rssi() does NOT advance the tick, since
// test_gsr_sensor.c's timing-sensitive assertions depend on the tick moving
// only when the test explicitly calls furi_test_advance_tick()) — the two
// mocks are mutually exclusive per test binary, not layered.

#include "furi_hal.h"
#include "furi_hal_subghz.h"
#include "furi.h"
#include <string.h>

const uint8_t subghz_device_cc1101_preset_ook_650khz_async_regs[] = {0};

static int      g_reset_count = 0;
static int      g_idle_count  = 0;
static int      g_sleep_count = 0;
static int      g_flush_rx_count = 0;
static int      g_rx_count = 0;
static int      g_load_preset_count = 0;
static const uint8_t* g_last_preset = NULL;

#define SET_FREQ_MAX_CALLS 64
static uint32_t g_set_freq_calls[SET_FREQ_MAX_CALLS];
static int      g_set_freq_call_count = 0;
static int32_t  g_freq_offset_hz = 0;

void furi_hal_subghz_reset(void) {
    g_reset_count++;
}

void furi_hal_subghz_idle(void) {
    g_idle_count++;
}

void furi_hal_subghz_sleep(void) {
    g_sleep_count++;
}

void furi_hal_subghz_flush_rx(void) {
    g_flush_rx_count++;
}

void furi_hal_subghz_rx(void) {
    g_rx_count++;
}

void furi_hal_subghz_load_custom_preset(const uint8_t* preset_data) {
    g_load_preset_count++;
    g_last_preset = preset_data;
}

uint32_t furi_hal_subghz_set_frequency_and_path(uint32_t value) {
    if(g_set_freq_call_count < SET_FREQ_MAX_CALLS) {
        g_set_freq_calls[g_set_freq_call_count] = value;
    }
    g_set_freq_call_count++;
    return (uint32_t)((int64_t)value + g_freq_offset_hz);
}

int furi_hal_subghz_mock_reset_count(void) { return g_reset_count; }
int furi_hal_subghz_mock_idle_count(void) { return g_idle_count; }
int furi_hal_subghz_mock_sleep_count(void) { return g_sleep_count; }
int furi_hal_subghz_mock_flush_rx_count(void) { return g_flush_rx_count; }
int furi_hal_subghz_mock_rx_count(void) { return g_rx_count; }
int furi_hal_subghz_mock_load_custom_preset_count(void) { return g_load_preset_count; }
const uint8_t* furi_hal_subghz_mock_last_preset(void) { return g_last_preset; }

int furi_hal_subghz_mock_set_freq_call_count(void) { return g_set_freq_call_count; }

uint32_t furi_hal_subghz_mock_set_freq_call(int index) {
    if(index < 0 || index >= g_set_freq_call_count || index >= SET_FREQ_MAX_CALLS) return 0;
    return g_set_freq_calls[index];
}

void furi_hal_subghz_mock_set_freq_offset_hz(int32_t offset_hz) {
    g_freq_offset_hz = offset_hz;
}

// ── RSSI: flat default + an optional per-call sequence, auto-advancing tick ──

static float    g_rssi_default = -91.5f;
#define RSSI_SEQUENCE_MAX 64
static float    g_rssi_sequence[RSSI_SEQUENCE_MAX];
static int      g_rssi_sequence_len = 0;
static int      g_rssi_sequence_pos = 0;
static int      g_rssi_call_count = 0;

float furi_hal_subghz_get_rssi(void) {
    float result;
    if(g_rssi_sequence_pos < g_rssi_sequence_len) {
        result = g_rssi_sequence[g_rssi_sequence_pos++];
    } else {
        result = g_rssi_default;
    }
    g_rssi_call_count++;
    furi_test_advance_tick(1);
    return result;
}

void furi_hal_subghz_mock_set_rssi(float value) {
    g_rssi_default = value;
}

// Queues values to return one per get_rssi() call, in order; once
// exhausted, falls back to the flat default. Replaces any previously
// queued sequence.
void furi_hal_subghz_mock_queue_rssi_sequence(const float* values, int count) {
    if(count > RSSI_SEQUENCE_MAX) count = RSSI_SEQUENCE_MAX;
    memcpy(g_rssi_sequence, values, count * sizeof(float));
    g_rssi_sequence_len = count;
    g_rssi_sequence_pos = 0;
}

int furi_hal_subghz_mock_get_rssi_call_count(void) {
    return g_rssi_call_count;
}

void furi_hal_subghz_mock_reset(void) {
    g_reset_count = 0;
    g_idle_count = 0;
    g_sleep_count = 0;
    g_flush_rx_count = 0;
    g_rx_count = 0;
    g_load_preset_count = 0;
    g_last_preset = NULL;
    g_set_freq_call_count = 0;
    g_freq_offset_hz = 0;
    g_rssi_default = -91.5f;
    g_rssi_sequence_len = 0;
    g_rssi_sequence_pos = 0;
    g_rssi_call_count = 0;
}
