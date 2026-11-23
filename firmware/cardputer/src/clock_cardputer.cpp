#include "clock_cardputer.h"

#include <Arduino.h>
#include <sys/time.h>
#include <time.h>

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

void clock_cardputer_poll(const GpsUart* gps) {
    if(!gps || !gps_uart_is_ready(gps)) return;
    uint32_t now_ms = millis();
    if(g_looked && now_ms - g_last_look_ms < 1000) return;
    g_looked = true;
    g_last_look_ms = now_ms;

    GpsStatus s = gps_uart_get_status(gps);
    int64_t gps_ms = 0;
    bool gps_ok = clock_rule_gps_time_ms(&s.date, &s.time, &gps_ms) && !gps_cardputer_behind(gps);
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
