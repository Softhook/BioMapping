#pragma once

// bt/bt_service/bt.h — host-test shim. Real path:
// applications/services/bt/bt_service/bt.h (SDK API version 87.1, checked
// against ~/.ufbt/current/sdk_headers/f7_sdk/applications/services/bt/
// bt_service/bt.h). Fakes just the surface modules/bt_stream.c calls
// directly: claiming/releasing the BLE profile and the connection-status
// callback (see docs/bluetooth_serial_investigation.md §1.3/§1.7). Real
// signatures, not simplified — bt_profile_start() genuinely returns NULL on
// failure and bt_profile_restore_default() genuinely returns bool, so the
// shim must let tests exercise both failure paths.
//
// See bt_ble_mock.c for the implementations and the test-injection API
// declared below.

#include <stdbool.h>
#include <stdint.h>
#include <furi_ble/profile_interface.h>

#define RECORD_BT "bt"

typedef struct Bt Bt;

typedef enum {
    BtStatusUnavailable,
    BtStatusOff,
    BtStatusAdvertising,
    BtStatusConnected,
} BtStatus;

typedef void (*BtStatusChangedCallback)(BtStatus status, void* context);

FuriHalBleProfileBase* bt_profile_start(
    Bt* bt,
    const FuriHalBleProfileTemplate* profile_template,
    FuriHalBleProfileParams params);

bool bt_profile_restore_default(Bt* bt);

void bt_set_status_changed_callback(Bt* bt, BtStatusChangedCallback callback, void* context);

// ── Test-injection API ──────────────────────────────────────────────────
// Call bt_mock_reset() at the start of each test — never while a previous
// test's BtStream is still alive.
void bt_mock_reset(void);

// When true, the NEXT bt_profile_start() call (and every one after, until
// cleared) returns NULL — simulates §1.7's "Bluetooth unavailable" path
// (radio off at the system level, already claimed by another service, ...).
void bt_mock_set_profile_start_fail(bool fail);
int  bt_mock_profile_start_count(void);

// bt_profile_restore_default()'s return value (default true — matches real
// hardware's normal case).
void bt_mock_set_profile_restore_fail(bool fail);
int  bt_mock_profile_restore_count(void);

// Fires the status-changed callback registered via
// bt_set_status_changed_callback(), synchronously, as if the BLE stack's
// own thread had invoked it — bt_stream.c's tests drive the connected/
// advertising/disconnected transitions this way rather than polling.
// No-op if no callback has been registered yet.
void bt_mock_fire_status_changed(BtStatus status);
