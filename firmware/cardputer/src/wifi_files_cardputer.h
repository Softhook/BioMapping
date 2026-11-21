#pragma once

// Wi-Fi Files screen on the Cardputer ADV.
//
// Starts an open Wi-Fi hotspot ("BioMapping-XXXX", no password; a join QR code
// is shown on screen) and a small HTTP file server serving /sd/biomapping/*.csv so walks can be downloaded onto a phone, tablet,
// or laptop without removing the SD card or plugging in a USB cable.
//
// Radio rule: Wi-Fi is switched on only while this screen is open and is torn
// down completely (WiFi.softAPdisconnect(true) + WiFi.mode(WIFI_OFF)) on exit,
// so the radio never runs during a GSR or GPS session.

#include <M5Cardputer.h>
#include <stdbool.h>

#include "biomap_session.h"

// Starts the hotspot and web server. Returns false (with Wi-Fi switched
// back off) if the SD card is unavailable or the hotspot fails to start.
bool wifi_files_start(M5Canvas& canvas);

// Stops the web server, disconnects all clients, switches Wi-Fi completely off,
// frees transfer buffers, and restores the user's backlight setting. Safe to
// call even if wifi_files_start() was not called or failed.
void wifi_files_stop(void);

// True while the Wi-Fi Files hotspot and web server are running.
bool wifi_files_active(void);

// Number of devices currently connected to the hotspot (0 when inactive).
int wifi_files_client_count(void);

// True if the screen should close right away: Esc was pressed during a
// streaming download, or no device has been connected for 10 minutes.
bool wifi_files_wants_exit(void);

// Call once every pass of loop() while Wi-Fi Files is open. Handles HTTP
// requests and watches for devices joining/leaving the hotspot. Returns true
// when the screen should be redrawn.
bool wifi_files_poll(M5Canvas& canvas);

// Handles Left/Right/OK keys while Wi-Fi Files is open (switches between the
// "Join Wi-Fi" and "Open Page" QR codes). Returns true when the screen should
// be redrawn. Back (Esc) is handled by menu_cardputer.cpp.
bool wifi_files_key(SessionKey key);

// Draws the Wi-Fi Files screen (header, QR code, connection info, transfer
// status, footer) into `canvas`.
void wifi_files_draw(M5Canvas& canvas);
