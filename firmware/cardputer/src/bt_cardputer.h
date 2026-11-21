#pragma once

// BLE Live Stream transport on the Cardputer ADV.
//
// Advertises the same BLE service and notify characteristic UUIDs that the
// visualiser's Live tab connects to (visualiser/src/live/live_bluetooth.mjs),
// with MTU raised so the 49-byte Live Stream packets (BT_STREAM_PACKET_SIZE)
// are sent whole rather than cut to the 20-byte BLE default.
//
// The radio stays completely off until a Live Stream session opens. On
// disconnect while a session is still open, advertising restarts so the
// visualiser's auto-reconnect can pick the link back up; on session exit,
// any connected client is disconnected and advertising is stopped.

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "biomap_screen.h"  // ScreenLink

// Starts advertising for a Live Stream session (initialising the BLE stack
// on first call). Returns false if the BLE server or service failed to start.
bool bt_cardputer_start(void);

// Stops advertising and disconnects any client. Safe to call even if
// bt_cardputer_start() was not called or failed.
void bt_cardputer_stop(void);

// True while a client (phone / browser) is connected over BLE.
bool bt_cardputer_is_connected(void);

// Current link state for the Live Stream screen ("Unavailable", "Bluetooth
// off", "Advertising", "Connected").
ScreenLink bt_cardputer_get_link(void);

// Sends one pre-packed Live Stream packet (BT_STREAM_PACKET_SIZE bytes).
// When not connected, counts the interval as a drop and returns false.
bool bt_cardputer_send(const uint8_t* data, size_t len);

// Cumulative count of send intervals where nothing was sent (not connected).
uint32_t bt_cardputer_get_drop_count(void);

// Worst single BLE notify duration (ms) in the current session.
uint32_t bt_cardputer_get_tx_peak_ms(void);
