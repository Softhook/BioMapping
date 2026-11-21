#include "tick_schedule.h"

void tick_schedule_restart(TickSchedule* t, uint32_t now_ms) {
    t->next_ms = now_ms + TICK_SCHEDULE_PERIOD_MS;
}

uint32_t tick_schedule_due(const TickSchedule* t, uint32_t now_ms) {
    // Signed difference, so the millis() wrap at 2^32 ms (49.7 days) is
    // no different from any other moment.
    int32_t late = (int32_t)(now_ms - t->next_ms);
    if(late < 0) return 0;
    uint32_t due = (uint32_t)late / TICK_SCHEDULE_PERIOD_MS + 1;
    return due > TICK_SCHEDULE_MAX_DUE ? TICK_SCHEDULE_MAX_DUE : due;
}

void tick_schedule_ran(TickSchedule* t) {
    t->next_ms += TICK_SCHEDULE_PERIOD_MS;
}

void tick_schedule_after_run(TickSchedule* t, uint32_t due, uint32_t now_ms) {
    if(due >= TICK_SCHEDULE_MAX_DUE && (int32_t)(now_ms - t->next_ms) >= 0) {
        tick_schedule_restart(t, now_ms);
    }
}

int tick_schedule_gps_bytes_left(int waiting, uint32_t due, uint32_t k) {
    if(waiting <= 0 || due == 0 || k >= due) return 0;
    return (int)((int64_t)waiting * (due - k) / due);
}
