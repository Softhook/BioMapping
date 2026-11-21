// Host tests for two Cardputer-only rules, in plain C:
//   cardputer/src/clock_rule.c  when the clock is set from GPS time
//   cardputer/src/wake_watch.c  the wake-up wait's "first clean byte"

#include <assert.h>
#include <stdio.h>
#include <string.h>

#include "cardputer/src/clock_rule.h"
#include "cardputer/src/wake_watch.h"

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

int main(void) {
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
    printf("All Cardputer rule tests passed.\n");
    return 0;
}
