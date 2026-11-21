#pragma once

// The Cardputer's clock. It has no clock chip, so the time is lost at every
// power-off; it is set from GPS time instead (docs/cardputer_port.md, "The
// clock"). Times are UK time, like a Flipper set to UK time: GMT in winter,
// BST (one hour ahead) from the last Sunday of March to the last Sunday of
// October.
//
// Everything here runs on the main loop.

#include "biomap_session.h"
#include "gps_uart.h"

// Sets the time zone. Call once, from setup().
void clock_cardputer_begin(void);

// Sets the clock from the GPS when it has a fix: once two looks in a row
// agree, using only a GPS time that has moved on since the last look, and
// not while GPS bytes wait to be parsed (clock_rule.h). Call every pass of
// the main loop while a GPS session is open; it looks once a second.
void clock_cardputer_poll(const GpsUart* gps);

// True once the clock has been set from GPS since power-on.
bool clock_cardputer_is_set(void);

// The local time now (UK time). Before GPS time it is 1 January 1970,
// which the session treats as "clock not set". `utc_offset_s`, if given,
// gets how far local time is ahead of UTC at that moment (0 or 3600).
void clock_cardputer_now(SessionDateTime* out, int32_t* utc_offset_s = nullptr);

// The clock as an epoch in local time with a given UTC offset (the scale
// the header's start time uses), or 0 before GPS time.
uint32_t clock_cardputer_epoch(int32_t utc_offset_s);

// The clock as an epoch in local time using the current UTC offset now,
// or 0 before GPS time.
uint32_t clock_cardputer_epoch_now(void);
