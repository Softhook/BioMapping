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
//
// The time is used before the GPS has a position fix. The M10Q leaves the
// time and date out of its sentences until it believes them (we leave
// CFG-NMEA-OUT_INVTIME and OUT_INVDATE off, their default), and it often
// knows the time long before a fix: from its backup clock, or from the
// first satellite it hears. A backup clock that has drifted is put right
// by the 2 s reset once satellites correct the module's time.

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// Set again when the clock is this far from GPS time.
#define CLOCK_RULE_RESYNC_MS 2000
// Two looks agree when their "how far out" differ by less than this.
#define CLOCK_RULE_AGREE_MS 1000

struct minmea_date;
struct minmea_time;

typedef struct {
    bool    clock_set;         // set from GPS since power-on
    bool    have_last;         // last_gps_ms holds the last look's GPS time
    int64_t last_gps_ms;
    bool    have_wanted;       // the last look wanted the clock set
    int64_t wanted_offset_ms;  // GPS time minus the clock, at that look
} ClockRule;

// The GPS time in ms since 1970 UTC, from the last RMC's date and time.
// False when either is missing (the module doesn't know it yet) or isn't a
// sensible date or time. A fix isn't needed: see above.
bool clock_rule_gps_time_ms(const struct minmea_date* d, const struct minmea_time* t,
                            int64_t* out);

// One look, about once a second. Start from a zeroed ClockRule.
// `gps_ok`: clock_rule_gps_time_ms() gave a time, and no GPS bytes are
// waiting to be parsed. `gps_ms`: the GPS time; `clock_ms`: the clock
// now (both ms since 1970, UTC). Returns true when the clock should be set
// to `gps_ms` now.
bool clock_rule_look(ClockRule* r, bool gps_ok, int64_t gps_ms, int64_t clock_ms);

#ifdef __cplusplus
}
#endif
