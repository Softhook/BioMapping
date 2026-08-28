// test_bt_stream.c — Host-side test for bt_stream.c's BLE profile
// lifecycle and send logic, run against the REAL production bt_stream.c
// (not a copy of its logic) — unmodified from what ships in the Flipper
// build. bt_stream.c calls the real Flipper SDK surface directly
// (bt_profile_start, bt_profile_restore_default, bt_set_status_changed_callback,
// ble_profile_serial_tx); this test compiles it against tests/shims/ (a
// minimal Furi-core shim plus tests/shims/bt_ble_mock.c, which fakes the
// BLE stack well enough to inject connect/disconnect transitions and
// send failures without any real radio).
//
// Coverage: bt_profile_start() == NULL (§1.7's "Bluetooth unavailable"
// path), connection-status transitions via the status-changed callback
// (§1.3), the connected/disconnected and send-failure branches of
// bt_stream_tx_batch() (§1.2), and that bt_stream_stop() always calls
// bt_profile_restore_default() — even after a failed start — per §3's
// "every exit path" requirement.
//
// NOT covered here (see docs/archive/bluetooth_serial_investigation.md §4): real
// ble_profile_serial_tx() latency / tick-thread contention. This mock's
// fake clock (furi_test_tick) never advances on its own, so
// bt_stream_get_tx_peak_ms() can only be checked for a sane baseline, not
// a real measured worst-case — that's real hardware's job (§10 Phase 3),
// not something a host test can see.
//
// Build: ./run_tests.sh (or see that script for the raw gcc invocation).

#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <math.h>

#include "modules/bt_stream.h"
#include "bt/bt_service/bt.h"
#include "profiles/serial_profile.h"

// Declared in tests/shims/furi.h.
extern _Atomic uint32_t furi_test_tick;
_Atomic uint32_t furi_test_tick = 1;

static void reset_all(void) {
    bt_mock_reset();
}

static void test_alloc_free(void) {
    printf("Running test_alloc_free...\n");
    reset_all();
    BtStream* bs = bt_stream_alloc();
    assert(bs != NULL);
    assert(!bt_stream_is_connected(bs));
    assert(bt_stream_get_status(bs) == BtStatusUnavailable);
    assert(bt_stream_get_drop_count(bs) == 0);
    assert(bt_stream_get_tx_peak_ms(bs) == 0);
    bt_stream_free(bs);
    printf("  -> Pass\n");
}

static void test_start_success_claims_profile(void) {
    printf("Running test_start_success_claims_profile...\n");
    reset_all();
    BtStream* bs = bt_stream_alloc();

    bool ok = bt_stream_start(bs);
    assert(ok);
    assert(bt_mock_profile_start_count() == 1);
    // Starting the profile alone doesn't mean a phone is connected yet —
    // status only changes once the mock fires the callback (§1.3).
    assert(!bt_stream_is_connected(bs));

    bt_stream_stop(bs);
    bt_stream_free(bs);
    printf("  -> Pass\n");
}

// §1.7 — bt_profile_start() returning NULL must not be treated as success,
// and must not crash anything downstream (NULL profile must never reach
// ble_profile_serial_tx()).
static void test_start_failure_profile_null(void) {
    printf("Running test_start_failure_profile_null...\n");
    reset_all();
    bt_mock_set_profile_start_fail(true);
    BtStream* bs = bt_stream_alloc();

    bool ok = bt_stream_start(bs);
    assert(!ok);
    assert(!bt_stream_is_connected(bs));

    // A send attempt after a failed start must be a clean drop, not a
    // NULL-pointer call into ble_profile_serial_tx().
    uint8_t payload[8] = {0};
    bool sent = bt_stream_tx_batch(bs, payload, sizeof(payload));
    assert(!sent);
    assert(bt_stream_get_drop_count(bs) == 1);
    assert(bt_mock_tx_call_count() == 0);

    bt_stream_stop(bs);
    bt_stream_free(bs);
    printf("  -> Pass\n");
}

// §3 — bt_stream_stop() must call bt_profile_restore_default() on EVERY
// exit path, including one where bt_stream_start() itself failed.
static void test_stop_always_restores_default_profile(void) {
    printf("Running test_stop_always_restores_default_profile...\n");
    reset_all();
    bt_mock_set_profile_start_fail(true);
    BtStream* bs = bt_stream_alloc();
    bt_stream_start(bs);
    assert(bt_mock_profile_restore_count() == 0);

    bt_stream_stop(bs);
    assert(bt_mock_profile_restore_count() == 1);

    // Idempotent: calling stop() again (e.g. a defensive session_deinit()
    // call after an already-clean exit) must not call restore_default()
    // a second time — bs->bt is already NULL.
    bt_stream_stop(bs);
    assert(bt_mock_profile_restore_count() == 1);

    bt_stream_free(bs);
    printf("  -> Pass\n");
}

// §1.3 — the connection-status callback drives an _Atomic cache, not a
// direct query. Verified here by firing the callback exactly the way the
// mock says the BLE stack's own thread would.
static void test_status_transitions_via_callback(void) {
    printf("Running test_status_transitions_via_callback...\n");
    reset_all();
    BtStream* bs = bt_stream_alloc();
    bt_stream_start(bs);

    bt_mock_fire_status_changed(BtStatusAdvertising);
    assert(bt_stream_get_status(bs) == BtStatusAdvertising);
    assert(!bt_stream_is_connected(bs));

    bt_mock_fire_status_changed(BtStatusConnected);
    assert(bt_stream_get_status(bs) == BtStatusConnected);
    assert(bt_stream_is_connected(bs));

    bt_mock_fire_status_changed(BtStatusOff);
    assert(!bt_stream_is_connected(bs));

    bt_stream_stop(bs);
    bt_stream_free(bs);
    printf("  -> Pass\n");
}

// §1.2/§3 — not connected: tx_batch() must drop without ever calling
// ble_profile_serial_tx() at all (no NULL/garbage profile pointer used).
static void test_tx_batch_drops_when_not_connected(void) {
    printf("Running test_tx_batch_drops_when_not_connected...\n");
    reset_all();
    BtStream* bs = bt_stream_alloc();
    bt_stream_start(bs);
    // Deliberately never fire Connected — status stays Unavailable.

    uint8_t payload[45] = {0x42, 0x4d};
    bool sent = bt_stream_tx_batch(bs, payload, sizeof(payload));

    assert(!sent);
    assert(bt_stream_get_drop_count(bs) == 1);
    assert(bt_mock_tx_call_count() == 0);

    bt_stream_stop(bs);
    bt_stream_free(bs);
    printf("  -> Pass\n");
}

// §1.2 — connected, but ble_profile_serial_tx() itself fails (the BLE
// stack's flow control rejecting an overlapping send). Must count as a
// drop, exactly like the not-connected case, and must not be retried
// synchronously (bt_mock_tx_call_count() stays 1 for one tx_batch() call).
static void test_tx_batch_drops_on_send_failure(void) {
    printf("Running test_tx_batch_drops_on_send_failure...\n");
    reset_all();
    BtStream* bs = bt_stream_alloc();
    bt_stream_start(bs);
    bt_mock_fire_status_changed(BtStatusConnected);
    bt_mock_set_tx_fail(true);

    uint8_t payload[45] = {0x42, 0x4d};
    bool sent = bt_stream_tx_batch(bs, payload, sizeof(payload));

    assert(!sent);
    assert(bt_stream_get_drop_count(bs) == 1);
    assert(bt_mock_tx_call_count() == 1);
    assert(bt_mock_tx_success_count() == 0);

    bt_stream_stop(bs);
    bt_stream_free(bs);
    printf("  -> Pass\n");
}

// Connected, send succeeds: no drop, exact byte count reaches
// ble_profile_serial_tx(), and the profile pointer passed through is the
// one bt_profile_start() actually returned (proven indirectly: the mock
// only counts a call as a success when it receives a non-NULL profile —
// see bt_ble_mock.c's ble_profile_serial_tx()).
static void test_tx_batch_success(void) {
    printf("Running test_tx_batch_success...\n");
    reset_all();
    BtStream* bs = bt_stream_alloc();
    bt_stream_start(bs);
    bt_mock_fire_status_changed(BtStatusConnected);

    uint8_t payload[45];
    memset(payload, 0xAB, sizeof(payload));
    payload[0] = 0x42;
    payload[1] = 0x4d;

    bool sent = bt_stream_tx_batch(bs, payload, sizeof(payload));

    assert(sent);
    assert(bt_stream_get_drop_count(bs) == 0);
    assert(bt_mock_tx_call_count() == 1);
    assert(bt_mock_tx_success_count() == 1);
    assert(bt_mock_tx_last_size() == sizeof(payload));

    bt_stream_stop(bs);
    bt_stream_free(bs);
    printf("  -> Pass\n");
}

// Deterministic intermittent-failure rate (mirrors furi_hal_i2c_mock's
// fail_every_nth pattern) — every 3rd send fails, the rest succeed;
// drop_count and success_count must both land exactly where that implies.
static void test_tx_batch_intermittent_failures(void) {
    printf("Running test_tx_batch_intermittent_failures...\n");
    reset_all();
    BtStream* bs = bt_stream_alloc();
    bt_stream_start(bs);
    bt_mock_fire_status_changed(BtStatusConnected);
    bt_mock_set_tx_fail_every_nth(3);

    uint8_t payload[45] = {0x42, 0x4d};
    int sent_count = 0;
    for(int i = 0; i < 9; i++) {
        if(bt_stream_tx_batch(bs, payload, sizeof(payload))) sent_count++;
    }

    assert(sent_count == 6);                      // 9 calls, every 3rd fails -> 3 failures
    assert(bt_stream_get_drop_count(bs) == 3);
    assert(bt_mock_tx_call_count() == 9);
    assert(bt_mock_tx_success_count() == 6);

    bt_stream_stop(bs);
    bt_stream_free(bs);
    printf("  -> Pass\n");
}

// bt_stream_stop() must reset connection status back to Unavailable so a
// stale "Connected" reading can't linger and mislead a caller checking
// status after the session has already torn down.
static void test_stop_resets_status(void) {
    printf("Running test_stop_resets_status...\n");
    reset_all();
    BtStream* bs = bt_stream_alloc();
    bt_stream_start(bs);
    bt_mock_fire_status_changed(BtStatusConnected);
    assert(bt_stream_is_connected(bs));

    bt_stream_stop(bs);
    assert(!bt_stream_is_connected(bs));
    assert(bt_stream_get_status(bs) == BtStatusUnavailable);

    bt_stream_free(bs);
    printf("  -> Pass\n");
}

// Real-hardware crash investigation (2026-08-14, docs/bluetooth_serial_
// investigation.md): bt_profile_restore_default() restarts the BLE
// co-processor's second core — an asynchronous hardware event that could
// plausibly still invoke the status-changed callback after
// bt_stream_stop()/bt_stream_free() had already run, writing into freed
// heap memory. bt_stream_stop() now explicitly unregisters the callback
// first; this proves a status change fired AFTER stop() is a safe no-op
// rather than reaching bt_stream_status_cb() at all.
static void test_stop_unregisters_status_callback(void) {
    printf("Running test_stop_unregisters_status_callback...\n");
    reset_all();
    BtStream* bs = bt_stream_alloc();
    bt_stream_start(bs);
    bt_mock_fire_status_changed(BtStatusAdvertising);
    assert(bt_stream_get_status(bs) == BtStatusAdvertising);

    bt_stream_stop(bs);
    assert(bt_stream_get_status(bs) == BtStatusUnavailable);

    // A status change arriving AFTER stop() (simulating the async
    // co-processor restart settling late) must not reach bs — status
    // stays Unavailable rather than flipping back to Connected.
    bt_mock_fire_status_changed(BtStatusConnected);
    assert(bt_stream_get_status(bs) == BtStatusUnavailable);

    bt_stream_free(bs);
    printf("  -> Pass\n");
}

// bt_stream_alloc()/bt_stream_free() are backed by a static singleton
// (bt_stream.c) — proves a second session can reuse it cleanly after the
// first is freed, and that state doesn't leak across sessions (a fresh
// alloc() must start at BtStatusUnavailable/0 drops, not carry over the
// previous session's Connected status or drop count).
static void test_alloc_after_free_reuses_singleton_cleanly(void) {
    printf("Running test_alloc_after_free_reuses_singleton_cleanly...\n");
    reset_all();
    BtStream* bs1 = bt_stream_alloc();
    bt_stream_start(bs1);
    bt_mock_fire_status_changed(BtStatusConnected);
    assert(bt_stream_is_connected(bs1));
    uint8_t payload[45] = {0x42, 0x4d};
    bt_stream_tx_batch(bs1, payload, sizeof(payload));
    bt_stream_stop(bs1);
    bt_stream_free(bs1);

    BtStream* bs2 = bt_stream_alloc();
    assert(bs2 == bs1); // same backing storage, by design
    assert(!bt_stream_is_connected(bs2));
    assert(bt_stream_get_status(bs2) == BtStatusUnavailable);
    assert(bt_stream_get_drop_count(bs2) == 0);
    assert(bt_stream_get_tx_peak_ms(bs2) == 0);

    bt_stream_free(bs2);
    printf("  -> Pass\n");
}

static void test_pack_packet(void) {
    printf("Running test_pack_packet...\n");
    uint8_t out[BT_STREAM_PACKET_SIZE];
    memset(out, 0xEE, sizeof(out));

    // Test 1: Valid GPS position
    GpsPosition pos1 = {
        .valid = true,
        .lat = 37.774929,
        .lon = -122.419416,
        .hdop = 1.2f,
        .pdop = 1.5f,
        .speed_kts = 5.5f,
        .course_deg = 180.0f,
        .sats = 8,
        .fix_type = 3
    };
    uint32_t ts1 = 123456u;
    float gsr1 = 1500.5f;

    bt_stream_pack_packet(out, ts1, &pos1, gsr1);

    assert(out[0] == 0x42);
    assert(out[1] == 0x4d);

    uint32_t ts_out;
    memcpy(&ts_out, out + 2, 4);
    assert(ts_out == ts1);

    double lat_out, lon_out;
    memcpy(&lat_out, out + 6, 8);
    memcpy(&lon_out, out + 14, 8);
    assert(lat_out == pos1.lat);
    assert(lon_out == pos1.lon);

    float gsr_out, hdop_out, pdop_out, speed_out, course_out;
    memcpy(&gsr_out, out + 22, 4);
    memcpy(&hdop_out, out + 26, 4);
    memcpy(&pdop_out, out + 30, 4);
    memcpy(&speed_out, out + 34, 4);
    memcpy(&course_out, out + 38, 4);

    assert(gsr_out == gsr1);
    assert(hdop_out == pos1.hdop);
    assert(pdop_out == pos1.pdop);
    assert(speed_out == pos1.speed_kts);
    assert(course_out == pos1.course_deg);

    assert(out[42] == 8);
    assert(out[43] == 3);
    assert(out[44] == 1);

    // Test 2: Invalid GPS position (NaN velocity, invalid flag)
    memset(out, 0xEE, sizeof(out));
    GpsPosition pos2 = {
        .valid = false,
        .lat = 0.0,
        .lon = 0.0,
        .hdop = 99.9f,
        .pdop = 99.9f,
        .speed_kts = NAN,
        .course_deg = NAN,
        .sats = 0,
        .fix_type = 1
    };
    uint32_t ts2 = 7890u;
    float gsr2 = 0.0f;

    bt_stream_pack_packet(out, ts2, &pos2, gsr2);

    assert(out[0] == 0x42);
    assert(out[1] == 0x4d);

    memcpy(&ts_out, out + 2, 4);
    assert(ts_out == ts2);

    memcpy(&lat_out, out + 6, 8);
    memcpy(&lon_out, out + 14, 8);
    assert(lat_out == 0.0);
    assert(lon_out == 0.0);

    memcpy(&gsr_out, out + 22, 4);
    memcpy(&hdop_out, out + 26, 4);
    memcpy(&pdop_out, out + 30, 4);
    memcpy(&speed_out, out + 34, 4);
    memcpy(&course_out, out + 38, 4);

    assert(gsr_out == gsr2);
    assert(hdop_out == pos2.hdop);
    assert(pdop_out == pos2.pdop);
    assert(speed_out == 0.0f); // NaN converted to 0.0
    assert(course_out == 0.0f); // NaN converted to 0.0

    assert(out[42] == 0);
    assert(out[43] == 1);
    assert(out[44] == 0);

    printf("  -> Pass\n");
}

int main(void) {
    test_alloc_free();
    test_start_success_claims_profile();
    test_start_failure_profile_null();
    test_stop_always_restores_default_profile();
    test_status_transitions_via_callback();
    test_tx_batch_drops_when_not_connected();
    test_tx_batch_drops_on_send_failure();
    test_tx_batch_success();
    test_tx_batch_intermittent_failures();
    test_stop_resets_status();
    test_stop_unregisters_status_callback();
    test_alloc_after_free_reuses_singleton_cleanly();
    test_pack_packet();
    printf("\nAll bt_stream tests passed!\n");
    return 0;
}
