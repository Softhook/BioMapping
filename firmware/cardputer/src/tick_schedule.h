#pragma once

// The Cardputer's 10 Hz tick schedule (session_cardputer.cpp). Plain C with
// no Arduino code, so the host tests can run it
// (tests/test_cardputer_rules.c).
//
// Ticks keep to a fixed 100 ms grid. After a stall (a slow SD write) the
// missed ticks are run straight away, as the Flipper's queued timer events
// are: each tick is one row and 0.1 s on the file's time column, so a
// dropped tick would put every later row early. Up to TICK_SCHEDULE_MAX_DUE
// are caught up: the Flipper's event queue holds 64 events
// (EVENT_QUEUE_DEPTH), about 6 s of ticks. Only after a longer stall does
// the grid start again from now.
//
// The GPS bytes that came in during a stall are parsed a slice at a time
// between the caught-up ticks, so each row gets about the position of its
// own moment rather than all getting the same one.

#include <stdbool.h>
#include <stdint.h>

#include "biomap_types.h"  // TICK_HZ, EVENT_QUEUE_DEPTH (core/)

#ifdef __cplusplus
extern "C" {
#endif

#define TICK_SCHEDULE_PERIOD_MS (1000u / TICK_HZ)
#define TICK_SCHEDULE_MAX_DUE   EVENT_QUEUE_DEPTH

typedef struct {
    uint32_t next_ms;  // when the next tick is due (millis())
} TickSchedule;

// The next tick one period from now: at a session's start, and once a
// recording has started (its start-up wait isn't a stall).
void tick_schedule_restart(TickSchedule* t, uint32_t now_ms);

// How many ticks are due now, 0 to TICK_SCHEDULE_MAX_DUE.
uint32_t tick_schedule_due(const TickSchedule* t, uint32_t now_ms);

// One tick has run: the next is one period on, on the same grid.
void tick_schedule_ran(TickSchedule* t);

// After running `due` ticks: if that was the most allowed and the grid is
// still behind `now_ms`, start it again from now.
void tick_schedule_after_run(TickSchedule* t, uint32_t due, uint32_t now_ms);

// Before caught-up tick k of `due` (k from 1): how many of the `waiting`
// GPS bytes to leave unparsed. The waiting bytes run up to now, so before
// tick k all but (due - k) / due of them are parsed; before the last, all.
int tick_schedule_gps_bytes_left(int waiting, uint32_t due, uint32_t k);

#ifdef __cplusplus
}
#endif
