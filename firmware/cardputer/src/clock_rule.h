#pragma once

// When the Cardputer sets its clock from GPS time (clock_cardputer.cpp).
// Plain C with no Arduino code, so the host tests can run it
// (tests/test_cardputer_rules.c).
//
// The GPS time read from the shared code is the time of the last sentence
// parsed, which can be old:
//   - the module has gone quiet (cable loose, or before a reconfigure):
//     the time stops moving, but the fix flag stays on;
//   - after a pause of the main loop, the waiting sentences are parsed a
//     few at a time, so the first look sees a time from seconds ago;
//   - one sentence type carries the date and another doesn't, so a look
//     between the two at midnight can pair today's time with yesterday's
//     date.
// So a GPS time is only used when it has moved forward since the last look,
// and the clock is only set when two looks in a row agree on how far out it
// is.

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// Set again when the clock is this far from GPS time.
#define CLOCK_RULE_RESYNC_MS 2000
// Two looks agree when their "how far out" differ by less than this.
#define CLOCK_RULE_AGREE_MS 1000

typedef struct {
    bool    clock_set;         // set from GPS since power-on
    bool    have_last;         // last_gps_ms holds the last look's GPS time
    int64_t last_gps_ms;
    bool    have_wanted;       // the last look wanted the clock set
    int64_t wanted_offset_ms;  // GPS time minus the clock, at that look
} ClockRule;

// One look, about once a second. Start from a zeroed ClockRule.
// `gps_ok`: a real satellite fix with a sensible date and time, and no GPS
// bytes waiting to be parsed. `gps_ms`: the GPS time; `clock_ms`: the clock
// now (both ms since 1970, UTC). Returns true when the clock should be set
// to `gps_ms` now.
bool clock_rule_look(ClockRule* r, bool gps_ok, int64_t gps_ms, int64_t clock_ms);

#ifdef __cplusplus
}
#endif
