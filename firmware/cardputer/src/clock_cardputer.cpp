#include "clock_cardputer.h"

#include <Arduino.h>
#include <stdlib.h>
#include <sys/time.h>
#include <time.h>

#include "biomap_pipeline.h"

// UK time: GMT, and BST (GMT+1) from 01:00 GMT on the last Sunday of March
// to 01:00 GMT (02:00 BST) on the last Sunday of October.
static const char* const UK_TZ = "GMT0BST,M3.5.0/1,M10.5.0/2";

// Set again whenever the clock is this far from GPS time. The ESP32's own
// clock drifts by seconds a day, so this rarely happens within a walk.
static const int32_t RESYNC_S = 2;

static bool     g_set = false;
static bool     g_looked = false;
static uint32_t g_last_look_ms = 0;

void clock_cardputer_begin(void) {
    setenv("TZ", UK_TZ, 1);
    tzset();
}

void clock_cardputer_poll(const GpsUart* gps) {
    if(!gps || !gps_uart_is_ready(gps)) return;
    uint32_t now_ms = millis();
    if(g_looked && now_ms - g_last_look_ms < 1000) return;
    g_looked = true;
    g_last_look_ms = now_ms;

    GpsStatus s = gps_uart_get_status(gps);
    // Only an RMC with a real satellite fix (status A, not estimated) is
    // trusted: before that, the module's time can be its own guess.
    if(!s.fix_valid) return;
    const struct minmea_date& d = s.date;
    const struct minmea_time& t = s.time;
    if(d.month < 1 || d.month > 12 || d.day < 1 || d.day > 31 || t.hours < 0 || t.hours > 23 ||
       t.minutes < 0 || t.minutes > 59 || t.seconds < 0 || t.seconds > 60) {
        return;
    }
    // RMC gives a two-digit year; 2000 + it holds until 2099.
    uint32_t gps_utc = pipeline_unix_epoch((uint16_t)(2000 + d.year), (uint8_t)d.month,
                                           (uint8_t)d.day, (uint8_t)t.hours, (uint8_t)t.minutes,
                                           (uint8_t)t.seconds);
    if(gps_utc == 0) return;

    time_t sys = time(nullptr);
    int32_t diff = (int32_t)((int64_t)sys - (int64_t)gps_utc);
    if(g_set && diff > -RESYNC_S && diff < RESYNC_S) return;

    struct timeval tv;
    tv.tv_sec = (time_t)gps_utc;
    tv.tv_usec = (t.microseconds >= 0 && t.microseconds < 1000000) ? t.microseconds : 0;
    settimeofday(&tv, nullptr);
    if(g_set) {
        Serial.printf("[Clock] reset from GPS (was %ld s out)\n", (long)diff);
    } else {
        Serial.printf("[Clock] set from GPS: 20%02d-%02d-%02d %02d:%02d:%02d UTC\n", d.year,
                      d.month, d.day, t.hours, t.minutes, t.seconds);
    }
    g_set = true;
}

bool clock_cardputer_is_set(void) {
    return g_set;
}

void clock_cardputer_now(SessionDateTime* out) {
    time_t now = time(nullptr);
    struct tm tm;
    localtime_r(&now, &tm);
    *out = SessionDateTime{};
    out->year = (uint16_t)(tm.tm_year + 1900);
    out->month = (uint8_t)(tm.tm_mon + 1);
    out->day = (uint8_t)tm.tm_mday;
    out->hour = (uint8_t)tm.tm_hour;
    out->minute = (uint8_t)tm.tm_min;
    out->second = (uint8_t)tm.tm_sec;
}
