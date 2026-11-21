#include "clock_rule.h"

bool clock_rule_look(ClockRule* r, bool gps_ok, int64_t gps_ms, int64_t clock_ms) {
    if(!gps_ok) {
        r->have_last = false;
        r->have_wanted = false;
        return false;
    }
    // Moved forward since the last look: a time that stood still or went
    // back is an old sentence.
    bool fresh = r->have_last && gps_ms > r->last_gps_ms;
    r->have_last = true;
    r->last_gps_ms = gps_ms;
    if(!fresh) {
        r->have_wanted = false;
        return false;
    }

    int64_t offset = gps_ms - clock_ms;
    bool want = !r->clock_set || offset >= CLOCK_RULE_RESYNC_MS || offset <= -CLOCK_RULE_RESYNC_MS;
    if(!want) {
        r->have_wanted = false;
        return false;
    }
    int64_t change = offset - r->wanted_offset_ms;
    bool agree = r->have_wanted && change > -CLOCK_RULE_AGREE_MS && change < CLOCK_RULE_AGREE_MS;
    r->have_wanted = true;
    r->wanted_offset_ms = offset;
    if(!agree) return false;

    r->clock_set = true;
    r->have_wanted = false;
    return true;
}
