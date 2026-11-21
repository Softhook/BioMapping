#include "clock_local.h"

#include <string.h>
#include <time.h>

#include "biomap_pipeline.h"

void clock_local_from_utc(int64_t utc_s, SessionDateTime* out, int32_t* utc_offset_s) {
    time_t now = (time_t)utc_s;
    struct tm tm;
    localtime_r(&now, &tm);
    memset(out, 0, sizeof(*out));
    out->year = (uint16_t)(tm.tm_year + 1900);
    out->month = (uint8_t)(tm.tm_mon + 1);
    out->day = (uint8_t)tm.tm_mday;
    out->hour = (uint8_t)tm.tm_hour;
    out->minute = (uint8_t)tm.tm_min;
    out->second = (uint8_t)tm.tm_sec;
    if(utc_offset_s) {
        // The local fields read as if they were UTC, minus the real UTC.
        uint32_t local = pipeline_unix_epoch(out->year, out->month, out->day, out->hour,
                                             out->minute, out->second);
        *utc_offset_s = local ? (int32_t)((int64_t)local - utc_s) : 0;
    }
}

uint32_t clock_local_epoch(int64_t utc_s, int32_t utc_offset_s) {
    time_t now = (time_t)utc_s;
    struct tm tm;
    gmtime_r(&now, &tm);
    if(tm.tm_year + 1900 < 2020) return 0;
    return (uint32_t)(utc_s + utc_offset_s);
}
