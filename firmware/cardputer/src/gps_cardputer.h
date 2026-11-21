#pragma once

// GPS on the Cardputer: the serial port to the M10Q (EXT header, G13 out to
// the module, G15 in from it), held for the whole time the Cardputer runs,
// and the serial, clock, wait and lock functions the shared code in
// core/gps_uart.c works through.
//
// Everything here runs on the main loop.

#include "gps_uart.h"

// Opens the port and puts the module to sleep, whatever state it is in
// (core: gps_uart_sleep_from_unknown_state()). Call once, from setup().
// Takes up to about 2 s. The port then stays open until power-off: a
// released port would let the module's receive wire float, and a sleeping
// M10Q wakes on any signal there.
void gps_cardputer_port_open(void);

// Starts a GPS session: wakes the module and sets it up (core:
// gps_uart_create()). Takes a few hundred ms. Always returns a GpsUart;
// gps_uart_is_ready() is false only if the port isn't open.
GpsUart* gps_cardputer_start(GpsNavModel nav_model, bool super_s);

// Ends the session: the module goes back to sleep, then the GpsUart is
// freed.
void gps_cardputer_stop(GpsUart* gps);

// Call every pass of the main loop, with or without a session (`gps` may
// be NULL). With a session it parses the bytes that have arrived; the
// session lock must NOT be held (a reconfigure inside waits for seconds).
// Without one it counts stray bytes, to check the module stayed asleep.
void gps_cardputer_poll(GpsUart* gps);
