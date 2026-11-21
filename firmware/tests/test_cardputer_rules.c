// Host tests for the Cardputer-only rules, in plain C:
//   cardputer/src/clock_rule.c     when the clock is set from GPS time
//   cardputer/src/wake_watch.c     the wake-up wait's "first clean byte"
//   cardputer/src/tick_schedule.c  the 10 Hz ticks, catch-up and GPS slices
//   cardputer/src/clock_local.c    local time, and the UTC offset kept
//                                  across a recording

#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "cardputer/src/clock_rule.h"
#include "cardputer/src/wake_watch.h"
#include "cardputer/src/tick_schedule.h"
#include "cardputer/src/clock_local.h"
#include "core/biomap_pipeline.h"

// ── Clock ───────────────────────────────────────────────────────────────

// 21 November 2026, 14:00:00 UTC, in ms.
#define T0 ((int64_t)1795269600 * 1000)

// One look a second, the GPS and the clock both moving on by `step` ms.
typedef struct {
    ClockRule r;
    int64_t   gps, clock;
    int       sets;
} Sim;

static bool look(Sim* s, bool gps_ok) {
    bool set = clock_rule_look(&s->r, gps_ok, s->gps, s->clock);
    if(set) {
        s->clock = s->gps;
        s->sets++;
    }
    return set;
}

static void tick(Sim* s, int64_t gps_step, int64_t clock_step) {
    s->gps += gps_step;
    s->clock += clock_step;
}

static void test_first_set_needs_two_agreeing_looks(void) {
    Sim s = {.gps = T0, .clock = 0};
    assert(!look(&s, true));  // nothing to compare with yet
    tick(&s, 1000, 1000);
    assert(!look(&s, true));  // first look that wants it set
    tick(&s, 1000, 1000);
    assert(look(&s, true));   // the second agrees
    assert(s.r.clock_set && s.clock == T0 + 2000);
    // Then left alone while the two keep step.
    for(int i = 0; i < 20; i++) {
        tick(&s, 1000, 1000);
        assert(!look(&s, true));
    }
    assert(s.sets == 1);
    printf("  first set after two agreeing looks: ok\n");
}

static void test_no_fix_never_sets(void) {
    Sim s = {.gps = T0, .clock = 0};
    for(int i = 0; i < 10; i++) {
        assert(!look(&s, false));
        tick(&s, 1000, 1000);
    }
    assert(!s.r.clock_set);
    printf("  no fix, never set: ok\n");
}

static Sim set_sim(void) {
    Sim s = {.gps = T0, .clock = 0};
    look(&s, true);
    tick(&s, 1000, 1000);
    look(&s, true);
    tick(&s, 1000, 1000);
    look(&s, true);
    assert(s.r.clock_set);
    return s;
}

// The module goes quiet (cable loose): the GPS time stops while the fix
// flag stays on. The clock must keep running, not be pulled back.
static void test_stopped_gps_time_is_ignored(void) {
    Sim s = set_sim();
    int64_t before = s.clock;
    for(int i = 1; i <= 60; i++) {
        tick(&s, 0, 1000);
        assert(!look(&s, true));
    }
    assert(s.clock == before + 60000 && s.sets == 1);
    // The same with looks 300 ms apart. With 1 s looks the two-look rule
    // alone would also hold, by a hair (each look is 1 s further out);
    // this checks the "moved forward" rule on its own.
    before = s.clock;
    for(int i = 1; i <= 60; i++) {
        tick(&s, 0, 300);
        assert(!look(&s, true));
    }
    assert(s.clock == before + 18000 && s.sets == 1);
    printf("  GPS time stopped for a minute, clock not pulled back: ok\n");
}

// After a 4 s main-loop pause the first look reads an old sentence: later
// than the last look's, so it counts as moved on, but 3.5 s behind. The
// next look, with the backlog cleared, is right again, so the two don't
// agree and the clock is left alone.
static void test_old_sentence_after_a_pause(void) {
    Sim s = set_sim();
    int64_t real = s.gps;
    tick(&s, 0, 4000);
    real += 4000;
    s.gps = real - 3500;  // an old sentence from the backlog
    assert(!look(&s, true));
    tick(&s, 0, 1000);
    real += 1000;
    s.gps = real;  // caught up
    assert(!look(&s, true));
    assert(s.sets == 1);
    printf("  old sentence after a pause, no reset: ok\n");
}

// Midnight: a look pairs 00:00:00.1 with yesterday's date, a day early.
// The time went back, so it is ignored, and the next look is fine.
static void test_midnight_date_mix_up(void) {
    Sim s = set_sim();
    tick(&s, 1000, 1000);
    int64_t real = s.gps;
    s.gps = real - 86400000;
    assert(!look(&s, true));
    tick(&s, 0, 1000);
    s.gps = real + 1000;
    assert(!look(&s, true));
    tick(&s, 1000, 1000);
    assert(!look(&s, true));
    assert(s.sets == 1);
    printf("  midnight date mix-up ignored: ok\n");
}

// A real drift of 3 s is put right after two looks.
static void test_real_drift_is_reset(void) {
    Sim s = set_sim();
    s.clock -= 3000;
    tick(&s, 1000, 1000);
    assert(!look(&s, true));
    tick(&s, 1000, 1000);
    assert(look(&s, true));
    assert(s.clock == s.gps && s.sets == 2);
    // A drift under 2 s is left alone.
    s.clock -= 1500;
    for(int i = 0; i < 5; i++) {
        tick(&s, 1000, 1000);
        assert(!look(&s, true));
    }
    printf("  drift of 3 s reset, 1.5 s left: ok\n");
}

// A backlog (gps_ok false) makes it start again: two fresh looks needed.
static void test_backlog_starts_again(void) {
    Sim s = set_sim();
    s.clock -= 5000;
    tick(&s, 1000, 1000);
    assert(!look(&s, true));   // wants it
    tick(&s, 1000, 1000);
    assert(!look(&s, false));  // behind: forget
    tick(&s, 1000, 1000);
    assert(!look(&s, true));   // nothing to compare with
    tick(&s, 1000, 1000);
    assert(!look(&s, true));   // wants it
    tick(&s, 1000, 1000);
    assert(look(&s, true));    // agrees
    printf("  backlog starts the count again: ok\n");
}

// ── Wake watch ──────────────────────────────────────────────────────────

#define GUARD 150

static void test_guard_time(void) {
    // 120 bytes at 9600: 125 ms, plus the 25 ms margin.
    assert(wake_watch_guard_ms(9600, 120) == 150);
    // At 115200: 10.4 ms, rounded up to 11.
    assert(wake_watch_guard_ms(115200, 120) == 36);
    // During the wake watch the chip hands bytes over every 4: 4.2 ms at
    // 9600, rounded up to 5.
    assert(wake_watch_guard_ms(9600, 4) == 30);
    printf("  guard time: ok\n");
}

static void test_clean_byte(void) {
    WakeWatch w;
    wake_watch_reset(&w);
    wake_watch_look(&w, 10, false, false, GUARD);
    wake_watch_look(&w, 11, false, true, GUARD);   // bytes, no report
    assert(!w.seen);
    wake_watch_look(&w, 12, false, false, GUARD);  // still no report
    assert(w.seen && w.seen_ms == 11);
    printf("  clean byte seen at the look it came: ok\n");
}

// The case the guard exists for: the report comes first, the garbled byte
// becomes readable a few ms later, with no second report.
static void test_report_before_byte(void) {
    WakeWatch w;
    wake_watch_reset(&w);
    wake_watch_look(&w, 100, true, false, GUARD);  // report, nothing to read yet
    wake_watch_look(&w, 101, false, false, GUARD);
    wake_watch_look(&w, 103, false, true, GUARD);  // the garbled byte
    for(uint32_t t = 104; t < 250; t++) {
        wake_watch_look(&w, t, false, false, GUARD);
        assert(!w.seen);
    }
    // After the guard, clean bytes count.
    wake_watch_look(&w, 260, false, true, GUARD);
    wake_watch_look(&w, 261, false, false, GUARD);
    assert(w.seen && w.seen_ms == 260);
    printf("  report before the garbled byte: byte not counted: ok\n");
}

// The other order: the byte is read, the report comes at the next look.
static void test_report_after_byte(void) {
    WakeWatch w;
    wake_watch_reset(&w);
    wake_watch_look(&w, 100, false, true, GUARD);
    wake_watch_look(&w, 101, true, false, GUARD);
    assert(!w.seen && !w.candidate);
    printf("  report after the byte: byte not counted: ok\n");
}

// Every byte garbled (the module at another baud): never seen.
static void test_all_garbled(void) {
    WakeWatch w;
    wake_watch_reset(&w);
    for(uint32_t t = 0; t < 1500; t++) {
        bool report = t % 20 == 0;
        bool bytes = t % 20 == 3;
        wake_watch_look(&w, t, report, bytes, GUARD);
        assert(!w.seen);
    }
    printf("  every byte garbled: never seen: ok\n");
}

// A report left over from before rx_start() (not cleared there): the first
// look guards, so a garbled byte still on the chip isn't counted.
static void test_report_left_from_before_start(void) {
    WakeWatch w;
    wake_watch_reset(&w);
    wake_watch_look(&w, 0, true, false, GUARD);
    wake_watch_look(&w, 2, false, true, GUARD);
    wake_watch_look(&w, 3, false, false, GUARD);
    assert(!w.seen);
    printf("  report from before the start: guarded: ok\n");
}

// The clock wraps at 2^32 ms during the guard.
static void test_guard_across_wrap(void) {
    WakeWatch w;
    wake_watch_reset(&w);
    uint32_t t = 0xFFFFFFF0u;
    wake_watch_look(&w, t, true, false, GUARD);
    wake_watch_look(&w, t + 100, false, true, GUARD);
    wake_watch_look(&w, t + 101, false, false, GUARD);
    assert(!w.seen);
    wake_watch_look(&w, t + 200, false, true, GUARD);
    wake_watch_look(&w, t + 201, false, false, GUARD);
    assert(w.seen && w.seen_ms == t + 200);
    printf("  guard across the clock wrap: ok\n");
}

// NMEA text passes; bytes from output at another baud mostly don't.
static void test_bytes_are_text(void) {
    const char* nmea = "$GNTXT,01,01,02,u-blox AG*4C\r\n";
    assert(wake_watch_bytes_are_text((const uint8_t*)nmea, strlen(nmea)));
    assert(wake_watch_bytes_are_text(NULL, 0));
    const uint8_t high[] = {'$', 'G', 0xE6};
    assert(!wake_watch_bytes_are_text(high, sizeof(high)));
    const uint8_t zero[] = {0x00};
    assert(!wake_watch_bytes_are_text(zero, sizeof(zero)));
    const uint8_t tab[] = {'\t'};
    assert(!wake_watch_bytes_are_text(tab, sizeof(tab)));
    printf("  NMEA text check: ok\n");
}

// ── Tick schedule ───────────────────────────────────────────────────────

#define PERIOD TICK_SCHEDULE_PERIOD_MS

// Runs what is due at `now`, as session_cardputer_poll() does. Returns how
// many ticks ran.
static uint32_t poll_at(TickSchedule* t, uint32_t now) {
    uint32_t due = tick_schedule_due(t, now);
    for(uint32_t k = 1; k <= due; k++) tick_schedule_ran(t);
    tick_schedule_after_run(t, due, now);
    return due;
}

static void test_ticks_on_time(void) {
    TickSchedule t;
    tick_schedule_restart(&t, 1000);
    assert(tick_schedule_due(&t, 1099) == 0);
    assert(tick_schedule_due(&t, 1100) == 1);
    assert(tick_schedule_due(&t, 1199) == 1);
    // A loop pass every 1 ms for 10 s: 100 ticks, never two at once.
    tick_schedule_restart(&t, 0);
    uint32_t ticks = 0;
    for(uint32_t now = 0; now < 10000; now++) {
        uint32_t ran = poll_at(&t, now);
        assert(ran <= 1);
        ticks += ran;
    }
    assert(ticks == 99);  // the 100th is due at 10000
    printf("  on time: one tick per 100 ms: ok\n");
}

// A 450 ms SD write: the five missed ticks run at once, and the grid stays
// where it was, so the file's 0.1 s steps still match real time.
static void test_ticks_after_stall(void) {
    TickSchedule t;
    tick_schedule_restart(&t, 1000);  // next at 1100
    assert(poll_at(&t, 1550) == 5);   // 1100, 1200, 1300, 1400, 1500
    assert(t.next_ms == 1600);
    assert(poll_at(&t, 1599) == 0);
    assert(poll_at(&t, 1600) == 1);
    printf("  after a 450 ms stall: 5 caught up, same grid: ok\n");
}

// A recording's start-up wait (bias check, file, sound, settle) isn't a
// stall: the schedule starts again, so row 0 comes one tick later and no
// burst of rows reading the same GSR window.
static void test_ticks_after_recording_start(void) {
    TickSchedule t;
    tick_schedule_restart(&t, 1000);   // next at 1100
    tick_schedule_restart(&t, 1800);   // Enter took 700 ms
    assert(poll_at(&t, 1800) == 0);
    assert(poll_at(&t, 1899) == 0);
    assert(poll_at(&t, 1900) == 1);
    printf("  after a recording start: no burst: ok\n");
}

// Longer behind than the catch-up covers: 64 run, then the grid starts
// again from now rather than running the rest.
static void test_ticks_after_long_stall(void) {
    TickSchedule t;
    tick_schedule_restart(&t, 1000);
    assert(poll_at(&t, 11000) == TICK_SCHEDULE_MAX_DUE);
    assert(t.next_ms == 11000 + PERIOD);
    assert(poll_at(&t, 11050) == 0);
    // Exactly the most allowed, and caught up: the grid is kept.
    tick_schedule_restart(&t, 0);
    uint32_t now = PERIOD * TICK_SCHEDULE_MAX_DUE;  // tick 64 is due now
    assert(poll_at(&t, now) == TICK_SCHEDULE_MAX_DUE);
    assert(t.next_ms == now + PERIOD);
    printf("  after a 10 s stall: 64 caught up, then from now: ok\n");
}

// millis() wraps at 2^32 ms (49.7 days).
static void test_ticks_across_wrap(void) {
    TickSchedule t;
    tick_schedule_restart(&t, 0xFFFFFFC0u);  // next at 0x24 after the wrap
    assert(poll_at(&t, 0xFFFFFFF0u) == 0);
    assert(poll_at(&t, 0x24u) == 1);
    assert(poll_at(&t, 0x24u + 3 * PERIOD + 10) == 3);
    printf("  across the millis() wrap: ok\n");
}

static void test_gps_slices(void) {
    // 1000 bytes waiting, 4 ticks due: each tick gets a quarter.
    assert(tick_schedule_gps_bytes_left(1000, 4, 1) == 750);
    assert(tick_schedule_gps_bytes_left(1000, 4, 2) == 500);
    assert(tick_schedule_gps_bytes_left(1000, 4, 3) == 250);
    assert(tick_schedule_gps_bytes_left(1000, 4, 4) == 0);
    // Never more left than before, and all parsed by the last tick.
    for(uint32_t due = 2; due <= TICK_SCHEDULE_MAX_DUE; due++) {
        int last = 8192;
        for(uint32_t k = 1; k <= due; k++) {
            int left = tick_schedule_gps_bytes_left(8192, due, k);
            assert(left >= 0 && left <= last);
            last = left;
        }
        assert(last == 0);
    }
    assert(tick_schedule_gps_bytes_left(0, 4, 1) == 0);
    assert(tick_schedule_gps_bytes_left(-5, 4, 1) == 0);
    assert(tick_schedule_gps_bytes_left(1000, 0, 1) == 0);
    printf("  GPS slices between caught-up ticks: ok\n");
}

// ── Local time ──────────────────────────────────────────────────────────

static int64_t utc(uint16_t y, uint8_t mo, uint8_t d, uint8_t h, uint8_t mi) {
    return (int64_t)pipeline_unix_epoch(y, mo, d, h, mi, 0);
}

static void test_local_time_and_offset(void) {
    SessionDateTime dt;
    int32_t off = -1;
    clock_local_from_utc(utc(2026, 7, 1, 12, 0), &dt, &off);
    assert(dt.year == 2026 && dt.month == 7 && dt.day == 1 && dt.hour == 13 && off == 3600);
    clock_local_from_utc(utc(2026, 1, 15, 12, 0), &dt, &off);
    assert(dt.hour == 12 && off == 0);
    // March 2026: the clocks go forward at 01:00 GMT on Sunday 29th.
    clock_local_from_utc(utc(2026, 3, 29, 0, 30), &dt, &off);
    assert(dt.hour == 0 && dt.minute == 30 && off == 0);
    clock_local_from_utc(utc(2026, 3, 29, 1, 30), &dt, &off);
    assert(dt.hour == 2 && dt.minute == 30 && off == 3600);
    // October 2026: back at 01:00 GMT on Sunday 25th; 01:30 comes twice.
    clock_local_from_utc(utc(2026, 10, 25, 0, 30), &dt, &off);
    assert(dt.hour == 1 && dt.minute == 30 && off == 3600);
    clock_local_from_utc(utc(2026, 10, 25, 1, 30), &dt, &off);
    assert(dt.hour == 1 && dt.minute == 30 && off == 0);
    // The header's start epoch (the session builds it from the date and
    // time) is the same as clock_local_epoch() with that moment's offset.
    int64_t at = utc(2026, 7, 1, 12, 0);
    clock_local_from_utc(at, &dt, &off);
    assert(pipeline_unix_epoch(dt.year, dt.month, dt.day, dt.hour, dt.minute, dt.second) ==
           clock_local_epoch(at, off));
    printf("  local time and UTC offset, both clock changes: ok\n");
}

// A recording across October's clock change: an hour long, from 00:30 to
// 01:30 GMT. With the start's offset kept, the end is an hour after the
// start. With the end's own offset it would be the same time as the start.
static void test_offset_kept_across_clock_change(void) {
    SessionDateTime dt;
    int32_t start_off = 0, end_off = 0;
    int64_t start = utc(2026, 10, 25, 0, 30), end = utc(2026, 10, 25, 1, 30);
    clock_local_from_utc(start, &dt, &start_off);
    clock_local_from_utc(end, &dt, &end_off);
    uint32_t start_epoch = clock_local_epoch(start, start_off);
    assert(clock_local_epoch(end, start_off) - start_epoch == 3600);
    assert(clock_local_epoch(end, end_off) == start_epoch);  // what keeping it avoids
    // March: the same hour reads as two hours of local time; kept, one.
    start = utc(2026, 3, 29, 0, 30);
    end = utc(2026, 3, 29, 1, 30);
    clock_local_from_utc(start, &dt, &start_off);
    assert(clock_local_epoch(end, start_off) - clock_local_epoch(start, start_off) == 3600);
    printf("  UTC offset kept across a clock change: ok\n");
}

static void test_clock_not_set(void) {
    SessionDateTime dt;
    int32_t off = -1;
    clock_local_from_utc(5, &dt, &off);  // just after power-on: 1970
    assert(dt.year == 1970);
    assert(clock_local_epoch(5, off) == 0);
    assert(clock_local_epoch(utc(2019, 12, 31, 23, 59), 0) == 0);
    assert(clock_local_epoch(utc(2020, 1, 1, 0, 0), 0) != 0);
    printf("  clock not set (before 2020): epoch 0: ok\n");
}

int main(void) {
    setenv("TZ", CLOCK_UK_TZ, 1);
    tzset();
    printf("Clock rule:\n");
    test_first_set_needs_two_agreeing_looks();
    test_no_fix_never_sets();
    test_stopped_gps_time_is_ignored();
    test_old_sentence_after_a_pause();
    test_midnight_date_mix_up();
    test_real_drift_is_reset();
    test_backlog_starts_again();
    printf("Wake watch:\n");
    test_guard_time();
    test_clean_byte();
    test_report_before_byte();
    test_report_after_byte();
    test_all_garbled();
    test_report_left_from_before_start();
    test_guard_across_wrap();
    test_bytes_are_text();
    printf("Tick schedule:\n");
    test_ticks_on_time();
    test_ticks_after_stall();
    test_ticks_after_recording_start();
    test_ticks_after_long_stall();
    test_ticks_across_wrap();
    test_gps_slices();
    printf("Local time:\n");
    test_local_time_and_offset();
    test_offset_kept_across_clock_change();
    test_clock_not_set();
    printf("All Cardputer rule tests passed.\n");
    return 0;
}
