#pragma once

// profiles/serial_profile.h — host-test shim. Real path:
// targets/f7/ble_glue/profiles/serial_profile.h (SDK API version 87.1,
// checked against ~/.ufbt/current/sdk_headers/f7_sdk/targets/f7/ble_glue/
// profiles/serial_profile.h). Fakes only ble_profile_serial (the profile
// descriptor passed to bt_profile_start()) and ble_profile_serial_tx() —
// the two symbols modules/bt_stream.c calls. Real signature: tx() returns
// bool (can fail — see docs/archive/bluetooth_serial_investigation.md §1.2), not
// fire-and-forget.
//
// See bt_ble_mock.c for the implementation and the test-injection API
// declared below.

#include <stdbool.h>
#include <stdint.h>
#include <furi_ble/profile_interface.h>

extern const FuriHalBleProfileTemplate* const ble_profile_serial;

bool ble_profile_serial_tx(FuriHalBleProfileBase* profile, uint8_t* data, uint16_t size);

// ── Test-injection API ──────────────────────────────────────────────────
// When true, the next ble_profile_serial_tx() call fails (returns false)
// and is NOT counted by bt_mock_tx_success_count() — simulates §1.2's "the
// BLE stack won't accept a new send until the previous one completes"
// failure mode. Auto-clears after one failure (matches "one outstanding
// send" — a real caller's next attempt, on the following interval, would
// normally succeed) unless bt_mock_set_tx_fail_every_nth() is also armed.
void bt_mock_set_tx_fail(bool fail);

// When n > 0, every Nth ble_profile_serial_tx() call fails and the rest
// succeed — a deterministic intermittent-failure rate, same shape as
// furi_hal.h's furi_hal_i2c_mock_set_fail_every_nth(). n=0 disables
// (default).
void bt_mock_set_tx_fail_every_nth(int n);

int      bt_mock_tx_call_count(void);
int      bt_mock_tx_success_count(void);
uint16_t bt_mock_tx_last_size(void);
