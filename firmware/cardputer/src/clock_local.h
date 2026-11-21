#pragma once

// UTC to local time on the Cardputer (clock_cardputer.cpp). Plain C with no
// Arduino code, so the host tests can run it (tests/test_cardputer_rules.c).
// Uses the C library's time zone (TZ, set with setenv() and tzset()).
//
// The session asks for the date and time once, at the start of a
// recording, and for the epoch at its end. The epoch is in local time, as
// on the Flipper. The UTC offset at the start is kept for the end, so a
// recording across a clock change (01:00 GMT on the last Sunday of March
// or October) doesn't get an end time an hour off: in October it would
// otherwise end before it started. The Flipper's clock doesn't change by
// itself, so this matches it.

#include <stdint.h>

#include "biomap_session.h"  // SessionDateTime (core/)

#ifdef __cplusplus
extern "C" {
#endif

// UK time: GMT, and BST (GMT+1) from 01:00 GMT on the last Sunday of March
// to 01:00 GMT (02:00 BST) on the last Sunday of October.
#define CLOCK_UK_TZ "GMT0BST,M3.5.0/1,M10.5.0/2"

// The local date and time at `utc_s` (seconds since 1970, UTC). If
// `utc_offset_s` isn't NULL it gets how far local time is ahead of UTC then
// (0 or 3600 in the UK).
void clock_local_from_utc(int64_t utc_s, SessionDateTime* out, int32_t* utc_offset_s);

// `utc_s` as an epoch in local time with the given UTC offset (the scale
// the header's start time uses), or 0 before 2020 (the clock not set, the
// same rule as pipeline_unix_epoch()).
uint32_t clock_local_epoch(int64_t utc_s, int32_t utc_offset_s);

#ifdef __cplusplus
}
#endif
