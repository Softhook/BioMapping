#include "clock_cardputer.h"

#include <Arduino.h>
#include <stdlib.h>
#include <sys/time.h>
#include <time.h>

#include "biomap_pipeline.h"
#include "clock_local.h"
#include "clock_rule.h"
#include "gps_cardputer.h"

// The ESP32's own clock drifts by seconds a day, so once set it is rarely
// reset within a walk. When it is set is decided in clock_rule.c.
static ClockRule g_rule = {};
static bool      g_looked = false;
static uint32_t  g_last_look_ms = 0;

void clock_cardputer_begin(void) {
    setenv("TZ", CLOCK_UK_TZ, 1);
    tzset();
}

// The GPS time in ms since 1970 UTC, or false when there is no real
// satellite fix (status A, not estimated: before that, the module's time
// can be its own guess) or the date or time isn't sensible.
static bool gps_time_ms(const GpsStatus& s, int64_t* out) {
    if(!s.fix_valid) return false;
    const struct minmea_date& d = s.date;
    const struct minmea_time& t = s.time;
    if(d.month < 1 || d.month > 12 || d.day < 1 || d.day > 31 || t.hours < 0 || t.hours > 23 ||
       t.minutes < 0 || t.minutes > 59 || t.seconds < 0 || t.seconds > 60) {
        return false;
    }
    // RMC gives a two-digit year; 2000 + it holds until 2099.
    uint32_t utc = pipeline_unix_epoch((uint16_t)(2000 + d.year), (uint8_t)d.month,
                                       (uint8_t)d.day, (uint8_t)t.hours, (uint8_t)t.minutes,
                                       (uint8_t)t.seconds);
    if(utc == 0) return false;
    int32_t us = (t.microseconds >= 0 && t.microseconds < 1000000) ? t.microseconds : 0;
    *out = (int64_t)utc * 1000 + us / 1000;
    return true;
}

void clock_cardputer_poll(const GpsUart* gps) {
    if(!gps || !gps_uart_is_ready(gps)) return;
    uint32_t now_ms = millis();
    if(g_looked && now_ms - g_last_look_ms < 1000) return;
    g_looked = true;
    g_last_look_ms = now_ms;

    GpsStatus s = gps_uart_get_status(gps);
    int64_t gps_ms = 0;
    bool gps_ok = gps_time_ms(s, &gps_ms) && !gps_cardputer_behind(gps);
    struct timeval now;
    gettimeofday(&now, nullptr);
    int64_t clock_ms = (int64_t)now.tv_sec * 1000 + now.tv_usec / 1000;

    bool was_set = g_rule.clock_set;
    if(!clock_rule_look(&g_rule, gps_ok, gps_ms, clock_ms)) return;

    struct timeval tv;
    tv.tv_sec = (time_t)(gps_ms / 1000);
    tv.tv_usec = (suseconds_t)(gps_ms % 1000) * 1000;
    settimeofday(&tv, nullptr);
    if(was_set) {
        Serial.printf("[Clock] reset from GPS (was %ld ms out)\n", (long)(clock_ms - gps_ms));
    } else {
        Serial.printf("[Clock] set from GPS: 20%02d-%02d-%02d %02d:%02d:%02d UTC\n", s.date.year,
                      s.date.month, s.date.day, s.time.hours, s.time.minutes, s.time.seconds);
    }
}

bool clock_cardputer_is_set(void) {
    return g_rule.clock_set;
}

void clock_cardputer_now(SessionDateTime* out, int32_t* utc_offset_s) {
    clock_local_from_utc((int64_t)time(nullptr), out, utc_offset_s);
}

uint32_t clock_cardputer_epoch(int32_t utc_offset_s) {
    return clock_local_epoch((int64_t)time(nullptr), utc_offset_s);
}

uint32_t clock_cardputer_epoch_now(void) {
    SessionDateTime dt;
    int32_t off = 0;
    clock_cardputer_now(&dt, &off);
    return clock_cardputer_epoch(off);
}
