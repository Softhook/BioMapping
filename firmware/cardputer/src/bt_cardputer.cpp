#include "bt_cardputer.h"

#include <Arduino.h>
#include <BLEDevice.h>
#include <BLEServer.h>

#include "biomap_format.h"  // BT_STREAM_PACKET_SIZE

// Same device name as the CSV header's "# DeviceName:Cardputer", and the
// same service / notify characteristic UUIDs the visualiser's Live tab
// looks for (visualiser/src/live/live_bluetooth.mjs).
static const char* const BLE_DEVICE_NAME  = "Cardputer";
static const char* const BLE_SERVICE_UUID = "8fe5b3d5-2e7f-4a98-2a48-7acc60fe0000";
static const char* const BLE_RX_CHAR_UUID = "19ed82ae-ed21-4c9d-4145-228e61fe0000";

// How long bt_cardputer_stop() waits for a connected client's disconnect
// to finish before switching Bluetooth off.
static const uint32_t DISCONNECT_WAIT_MS = 500;

static struct {
    bool               on = false;         // Bluetooth switched on (BLEDevice::init() done)
    volatile bool      active = false;     // true between bt_cardputer_start() and _stop()
    volatile bool      connected = false;  // updated from the BLE stack's callback thread
    BLEServer*         server = nullptr;
    BLEService*        svc = nullptr;
    BLECharacteristic* ch = nullptr;
    uint32_t           drop_count = 0;
    uint32_t           tx_peak_ms = 0;
} g_bt;

class CardputerBleCallbacks : public BLEServerCallbacks {
    void onConnect(BLEServer*) override {
        g_bt.connected = true;
    }
    void onDisconnect(BLEServer*) override {
        g_bt.connected = false;
        // If the Live Stream session is still open, advertise again so the
        // visualiser's auto-reconnect loop can re-establish the link.
        if(g_bt.active) {
            BLEDevice::startAdvertising();
        }
    }
};

static CardputerBleCallbacks g_ble_callbacks;

// Switches Bluetooth off completely: the radio, the controller and the
// NimBLE stack (BLEDevice::deinit(false), which also deletes the server
// and advertising objects, and lets BLEDevice::init() start afresh next
// time: NimBLE's service list is rebuilt from empty at init). The library
// deletes neither the service nor the characteristic, and the service
// can't be deleted from here (its destructor is private). Both are left
// alone rather than deleting the characteristic out from under a service
// definition the stack might still point to, which leaves a small leak per
// Live Stream session (about 1 KB; tools/hw_test.py's live_stream_cycles
// fails if it grows); the "[BLE] on/off" lines log free heap so it can be
// watched. Our callbacks object is static and is never deleted.
static void switch_off(void) {
    if(!g_bt.on) return;
    BLEDevice::deinit(false);
    g_bt.ch = nullptr;
    g_bt.svc = nullptr;
    g_bt.server = nullptr;  // deleted by deinit()
    g_bt.connected = false;
    g_bt.on = false;
}

// A set-up step failed: say which, and switch everything back off so the
// next Live Stream starts from scratch.
static bool start_failed(const char* what) {
    Serial.printf("[BLE] warning: %s failed\n", what);
    switch_off();
    return false;
}

bool bt_cardputer_start(void) {
    g_bt.drop_count = 0;
    g_bt.tx_peak_ms = 0;
    g_bt.connected = false;

    // Fresh every session: bt_cardputer_stop() switched it all off.
    switch_off();
    g_bt.on = true;  // set before init() so a failed init is still cleaned up
    if(!BLEDevice::init(BLE_DEVICE_NAME)) return start_failed("BLEDevice::init()");
    // 49-byte packet + 3-byte ATT header = 52 bytes minimum so notifications
    // are never truncated to the 20-byte default (docs/cardputer_port.md §3).
    BLEDevice::setMTU(BT_STREAM_PACKET_SIZE + 3);
    g_bt.server = BLEDevice::createServer();
    if(!g_bt.server) return start_failed("createServer()");
    g_bt.server->setCallbacks(&g_ble_callbacks);
    g_bt.svc = g_bt.server->createService(BLE_SERVICE_UUID);
    if(!g_bt.svc) return start_failed("createService()");
    g_bt.ch = g_bt.svc->createCharacteristic(
        BLE_RX_CHAR_UUID,
        BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
    if(!g_bt.ch) return start_failed("createCharacteristic()");
    // No 0x2902 descriptor is added by hand: this build uses NimBLE, which
    // adds one itself to every notify characteristic (it is what a browser
    // writes to subscribe), and only notifies subscribed clients.
    g_bt.svc->start();

    BLEAdvertising* adv = BLEDevice::getAdvertising();
    if(!adv) return start_failed("getAdvertising()");
    adv->addServiceUUID(BLE_SERVICE_UUID);
    adv->setScanResponse(true);

    g_bt.active = true;
    BLEDevice::startAdvertising();
    Serial.printf("[BLE] on: advertising (free heap %u)\n", (unsigned)ESP.getFreeHeap());
    return true;
}

void bt_cardputer_stop(void) {
    g_bt.active = false;  // first, so onDisconnect() doesn't advertise again
    if(!g_bt.on) return;
    BLEDevice::stopAdvertising();
    if(g_bt.connected && g_bt.server) {
        g_bt.server->disconnect(g_bt.server->getConnId());
        // Let the disconnect reach the phone or browser before the radio
        // goes off, so it sees a clean disconnect rather than a lost link.
        uint32_t t0 = millis();
        while(g_bt.connected && millis() - t0 < DISCONNECT_WAIT_MS) delay(10);
    }
    switch_off();
    Serial.printf("[BLE] off (free heap %u)\n", (unsigned)ESP.getFreeHeap());
}

bool bt_cardputer_is_connected(void) {
    return g_bt.active && g_bt.connected;
}

ScreenLink bt_cardputer_get_link(void) {
    if(!g_bt.on) return ScreenLinkUnavailable;
    if(!g_bt.active) return ScreenLinkOff;
    return g_bt.connected ? ScreenLinkConnected : ScreenLinkAdvertising;
}

bool bt_cardputer_send(const uint8_t* data, size_t len) {
    if(!bt_cardputer_is_connected() || !g_bt.ch || !data || len == 0) {
        g_bt.drop_count++;
        return false;
    }
    uint32_t t0 = millis();
    // BLECharacteristic::setValue() takes a non-const uint8_t* but only
    // copies the bytes into its internal attribute value buffer.
    g_bt.ch->setValue(const_cast<uint8_t*>(data), len);
    g_bt.ch->notify();
    uint32_t dt = millis() - t0;
    if(dt > g_bt.tx_peak_ms) g_bt.tx_peak_ms = dt;
    return true;
}

uint32_t bt_cardputer_get_drop_count(void) {
    return g_bt.drop_count;
}

uint32_t bt_cardputer_get_tx_peak_ms(void) {
    return g_bt.tx_peak_ms;
}
