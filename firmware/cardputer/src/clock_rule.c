#include "clock_rule.h"

#include "biomap_pipeline.h"
#include "../../vendor/minmea/minmea.h"

bool clock_rule_gps_time_ms(const struct minmea_date* d, const struct minmea_time* t,
                            int64_t* out) {
    // minmea gives -1 for an empty field, so a missing date or time fails here.
    if(d->month < 1 || d->month > 12 || d->day < 1 || d->day > 31 || d->year < 0 ||
       d->year > 99 || t->hours < 0 || t->hours > 23 || t->minutes < 0 || t->minutes > 59 ||
       t->seconds < 0 || t->seconds > 60) {
        return false;
    }
    // RMC gives a two-digit year; 2000 + it holds until 2099.
    uint32_t utc = pipeline_unix_epoch((uint16_t)(2000 + d->year), (uint8_t)d->month,
                                       (uint8_t)d->day, (uint8_t)t->hours, (uint8_t)t->minutes,
                                       (uint8_t)t->seconds);
    if(utc == 0) return false;
    int32_t us = (t->microseconds >= 0 && t->microseconds < 1000000) ? t->microseconds : 0;
    *out = (int64_t)utc * 1000 + us / 1000;
    return true;
}

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
