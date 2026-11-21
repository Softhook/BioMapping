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

static struct {
    bool               inited = false;
    volatile bool      active = false;     // true between bt_cardputer_start() and _stop()
    volatile bool      connected = false;  // updated from the BLE stack's callback thread
    BLEServer*         server = nullptr;
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

bool bt_cardputer_start(void) {
    g_bt.drop_count = 0;
    g_bt.tx_peak_ms = 0;

    if(!g_bt.inited) {
        BLEDevice::init(BLE_DEVICE_NAME);
        // 49-byte packet + 3-byte ATT header = 52 bytes minimum so notifications
        // are never truncated to the 20-byte default (docs/cardputer_port.md §3).
        BLEDevice::setMTU(BT_STREAM_PACKET_SIZE + 3);
        g_bt.server = BLEDevice::createServer();
        if(!g_bt.server) {
            Serial.println("[BLE] warning: createServer() failed");
            return false;
        }
        g_bt.server->setCallbacks(&g_ble_callbacks);
        BLEService* svc = g_bt.server->createService(BLE_SERVICE_UUID);
        if(!svc) {
            Serial.println("[BLE] warning: createService() failed");
            return false;
        }
        g_bt.ch = svc->createCharacteristic(
            BLE_RX_CHAR_UUID,
            BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
        if(!g_bt.ch) {
            Serial.println("[BLE] warning: createCharacteristic() failed");
            return false;
        }
        svc->start();

        BLEAdvertising* adv = BLEDevice::getAdvertising();
        adv->addServiceUUID(BLE_SERVICE_UUID);
        adv->setScanResponse(true);
        g_bt.inited = true;
    }

    g_bt.active = true;
    if(!g_bt.connected) {
        BLEDevice::startAdvertising();
    }
    return true;
}

void bt_cardputer_stop(void) {
    g_bt.active = false;
    if(!g_bt.inited) return;
    BLEDevice::stopAdvertising();
    if(g_bt.connected && g_bt.server) {
        g_bt.server->disconnect(g_bt.server->getConnId());
    }
    g_bt.connected = false;
}

bool bt_cardputer_is_connected(void) {
    return g_bt.active && g_bt.connected;
}

ScreenLink bt_cardputer_get_link(void) {
    if(!g_bt.inited) return ScreenLinkUnavailable;
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
