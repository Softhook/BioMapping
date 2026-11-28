#pragma once

// GPS on the Cardputer: the serial port to the M10Q (EXT header, G13 out to
// the module, G15 in from it), held for the whole time the Cardputer runs,
// and the serial, clock, wait and lock functions the shared code in
// core/gps_uart.c works through.
//
// gps_cardputer_port_open() runs once during setup() (on the boot task while
// the splash animation plays); everything else runs on the main loop.

#include "gps_uart.h"

// Opens the port, brings the module to 115200 awake (core:
// gps_uart_wake_to_fast()), and polls UBX-NAV-TIMEUTC once for the module's
// battery-backed clock (if `boot_utc` is non-NULL). Call once, from setup().
// Leaves the module awake at 115200 so it begins acquiring satellites
// immediately; non-GPS modes call gps_cardputer_sleep(). Returns true and
// fills *boot_utc (including its millis() read_at_ms) when the module had a
// valid UTC time. The port stays open until power-off: a released port would
// let the module's receive wire float, and a sleeping M10Q wakes on any
// signal there.
bool gps_cardputer_port_open(GpsUtcTime* boot_utc = nullptr);

// Puts the module into software standby (100 ms; no-op if already asleep or
// port closed) and starts counting stray bytes until the next start(). Call
// when entering non-GPS modes (GSR Only, Diagnostics, Calibration, Wi-Fi
// Files, GSR Audio) or after a cold reset.
void gps_cardputer_sleep(void);

// True while the module has been put into software standby.
bool gps_cardputer_is_asleep(void);

// Starts a GPS session: reuses the awake module at 115200 (or wakes it from
// standby if asleep) and applies configuration (core: gps_uart_create()).
// Always returns a GpsUart; gps_uart_is_ready() is false only if the port
// isn't open.
GpsUart* gps_cardputer_start(GpsNavModel nav_model, bool super_s);

// Ends the session: stops receiving and frees the GpsUart, leaving the
// module awake at 115200 so the next GPS session starts without re-acquiring.
void gps_cardputer_stop(GpsUart* gps);

// Options > Cold Reset GPS: wakes the module (if asleep), sends a cold-start
// reset to wipe what its backup RAM remembers, waits 300 ms, and puts it to
// sleep so the wipe sticks. Returns true if the serial port was open and the
// reset sequence was sent.
bool gps_cardputer_cold_reset(GpsNavModel nav_model, bool super_s);

// Call every pass of the main loop, with or without a session (`gps` may
// be NULL). With a session it parses the bytes that have arrived; the
// session lock must NOT be held (a reconfigure inside waits for seconds).
// Without one it either counts stray bytes while asleep (idle watch) or
// drains NMEA while the module stays awake on the menu.
void gps_cardputer_poll(GpsUart* gps);

// True when the main loop is behind with the GPS bytes (a backlog waits to
// be parsed), so the GPS time just read is old. False with no session.
bool gps_cardputer_behind(const GpsUart* gps);

// Times the driver's buffer was full this session: a near miss, nothing
// lost yet (lost bytes count in gps_uart_get_rx_drop_count()).
uint32_t gps_cardputer_buffer_full_count(const GpsUart* gps);

// GPS bytes received but not yet parsed (0 before the port is open).
int gps_cardputer_waiting_bytes(void);

// Parses waiting GPS bytes until no more than `bytes_left` wait (or a pass
// limit is reached). For catching up after a pause, a slice at a time
// (session_cardputer_poll()). Same rules as gps_cardputer_poll().
void gps_cardputer_parse_down_to(GpsUart* gps, int bytes_left);
