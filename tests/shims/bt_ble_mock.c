// bt_ble_mock.c — host-test mock backing tests/shims/bt/bt_service/bt.h and
// tests/shims/profiles/serial_profile.h. See those headers for the
// test-injection API this implements.

#include "bt/bt_service/bt.h"
#include "profiles/serial_profile.h"

#include <stddef.h>

static const FuriHalBleProfileTemplate fake_serial_template = {0};
const FuriHalBleProfileTemplate* const ble_profile_serial = &fake_serial_template;

static FuriHalBleProfileBase fake_profile = {.config = &fake_serial_template};

static BtStatusChangedCallback status_cb = NULL;
static void* status_cb_ctx = NULL;

static bool profile_start_fail = false;
static int  profile_start_count = 0;

static bool profile_restore_fail = false;
static int  profile_restore_count = 0;

static bool tx_fail_once = false;
static int  tx_fail_every_nth = 0;
static int  tx_call_count = 0;
static int  tx_success_count = 0;
static uint16_t tx_last_size = 0;

void bt_mock_reset(void) {
    status_cb = NULL;
    status_cb_ctx = NULL;
    profile_start_fail = false;
    profile_start_count = 0;
    profile_restore_fail = false;
    profile_restore_count = 0;
    tx_fail_once = false;
    tx_fail_every_nth = 0;
    tx_call_count = 0;
    tx_success_count = 0;
    tx_last_size = 0;
}

void bt_mock_set_profile_start_fail(bool fail) { profile_start_fail = fail; }
int  bt_mock_profile_start_count(void) { return profile_start_count; }

void bt_mock_set_profile_restore_fail(bool fail) { profile_restore_fail = fail; }
int  bt_mock_profile_restore_count(void) { return profile_restore_count; }

void bt_mock_fire_status_changed(BtStatus status) {
    if(status_cb) status_cb(status, status_cb_ctx);
}

FuriHalBleProfileBase* bt_profile_start(
    Bt* bt,
    const FuriHalBleProfileTemplate* profile_template,
    FuriHalBleProfileParams params) {
    (void)bt;
    (void)profile_template;
    (void)params;
    profile_start_count++;
    return profile_start_fail ? NULL : &fake_profile;
}

bool bt_profile_restore_default(Bt* bt) {
    (void)bt;
    profile_restore_count++;
    return !profile_restore_fail;
}

void bt_set_status_changed_callback(Bt* bt, BtStatusChangedCallback callback, void* context) {
    (void)bt;
    status_cb = callback;
    status_cb_ctx = context;
}

void bt_mock_set_tx_fail(bool fail) { tx_fail_once = fail; }
void bt_mock_set_tx_fail_every_nth(int n) { tx_fail_every_nth = n; }
int      bt_mock_tx_call_count(void) { return tx_call_count; }
int      bt_mock_tx_success_count(void) { return tx_success_count; }
uint16_t bt_mock_tx_last_size(void) { return tx_last_size; }

bool ble_profile_serial_tx(FuriHalBleProfileBase* profile, uint8_t* data, uint16_t size) {
    (void)profile;
    (void)data;
    tx_call_count++;
    tx_last_size = size;

    bool fail = tx_fail_once;
    if(tx_fail_every_nth > 0 && tx_call_count % tx_fail_every_nth == 0) fail = true;
    if(tx_fail_once) tx_fail_once = false; // one-shot, per the header's doc comment

    if(fail) return false;
    tx_success_count++;
    return true;
}
