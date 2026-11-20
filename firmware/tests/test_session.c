// test_session.c — the shared session (core/biomap_session.c) against a
// fake device: no Flipper headers. Checks what the session does with keys
// and ticks (rows, the header, cues, the SD failure rules, the Live Stream
// packets) and which device calls happen with the lock held.
//
// Each fake device function asserts whether the lock is held, so moving a
// slow call (file write, sound, Bluetooth send) under the lock fails here.

#include "core/biomap_session.h"
#include "core/biomap_format.h"
#include "core/core_check.h"

#include <assert.h>
#include <setjmp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// ── core_fatal: jump back to the test that expected it ─────────────────
static jmp_buf g_fatal_jmp;
static bool g_expect_fatal;
static const char* g_fatal_msg;

void core_fatal(const char* msg) {
    if(!g_expect_fatal) {
        fprintf(stderr, "unexpected core_fatal: %s\n", msg);
        abort();
    }
    g_fatal_msg = msg;
    longjmp(g_fatal_jmp, 1);
}

#define EXPECT_FATAL(stmt)                     \
    do {                                       \
        g_expect_fatal = true;                 \
        g_fatal_msg = NULL;                    \
        if(setjmp(g_fatal_jmp) == 0) {         \
            stmt;                              \
            assert(!"expected core_fatal");    \
        }                                      \
        g_expect_fatal = false;                \
        assert(g_fatal_msg != NULL);           \
    } while(0)

// ── The fake device ─────────────────────────────────────────────────────
typedef struct {
    bool     locked;
    uint32_t now;
    uint32_t delays[8];
    int      delay_count;

    BioMapCue cues[512];
    int       cue_count;

    bool  file_open;
    int   file_starts;
    int   file_stops;
    bool  fail_start;
    char  header[1024];
    char  stamp[32];
    char  rows[64 * 1024];   // appended but not yet flushed
    size_t rows_len;
    size_t rows_cap;         // 0 = unlimited
    char  written[256 * 1024];
    size_t written_len;
    int   flush_calls;
    int   fail_flushes;      // the next N flushes fail
    int   append_calls;

    bool connected;
    int  sends;
    uint8_t last_packet[BT_STREAM_PACKET_SIZE];

    int rf_calls;
    int second_diags;
    char last_log[256];
    int  log_count;
} Fake;

static Fake F;

static void f_lock(void* ctx) { (void)ctx; assert(!F.locked); F.locked = true; }
static void f_unlock(void* ctx) { (void)ctx; assert(F.locked); F.locked = false; }
static uint32_t f_now(void* ctx) { (void)ctx; return F.now; }
static void f_delay(void* ctx, uint32_t ms) {
    (void)ctx;
    assert(!F.locked);
    if(F.delay_count < 8) F.delays[F.delay_count++] = ms;
}
static void f_cue(void* ctx, BioMapCue cue) {
    (void)ctx;
    if(biomap_cue_has_sound(cue)) assert(!F.locked);
    assert(F.cue_count < 512);
    F.cues[F.cue_count++] = cue;
}
static void f_log(void* ctx, SessionLogLevel level, const char* line) {
    (void)ctx; (void)level;
    assert(!F.locked);
    snprintf(F.last_log, sizeof(F.last_log), "%s", line);
    F.log_count++;
}
static void f_datetime(void* ctx, SessionDateTime* out) {
    (void)ctx;
    *out = (SessionDateTime){.year = 2026, .month = 11, .day = 20, .hour = 9, .minute = 8, .second = 7};
}
static uint32_t f_epoch(void* ctx) { (void)ctx; return 1795000000u; }
static bool f_file_start(void* ctx, const char* header, const char* stamp) {
    (void)ctx;
    assert(!F.locked);
    F.file_starts++;
    if(F.fail_start) return false;
    snprintf(F.header, sizeof(F.header), "%s", header);
    snprintf(F.stamp, sizeof(F.stamp), "%s", stamp);
    F.file_open = true;
    F.rows_len = 0;
    F.written_len = 0;
    return true;
}
static void f_file_stop(void* ctx, uint32_t end_epoch) {
    (void)ctx;
    assert(!F.locked);
    assert(end_epoch == 1795000000u);
    F.file_stops++;
    F.file_open = false;
}
static bool f_file_append(void* ctx, const char* row, size_t len) {
    (void)ctx;
    assert(F.locked);  // the row is built and appended in one go, under the lock
    assert(F.file_open);
    assert(len > 0 && row[len - 1] == '\n');
    F.append_calls++;
    size_t cap = F.rows_cap ? F.rows_cap : sizeof(F.rows);
    if(F.rows_len + len > cap) return false;
    memcpy(F.rows + F.rows_len, row, len);
    F.rows_len += len;
    return true;
}
static int f_file_flush(void* ctx) {
    (void)ctx;
    assert(!F.locked);
    F.flush_calls++;
    if(F.fail_flushes > 0) {
        F.fail_flushes--;
        return -1;
    }
    memcpy(F.written + F.written_len, F.rows, F.rows_len);
    F.written_len += F.rows_len;
    int n = (int)F.rows_len;
    F.rows_len = 0;
    return n;
}
static void f_rf(void* ctx, float out[RF_BAND_COUNT]) {
    (void)ctx;
    assert(F.locked);
    F.rf_calls++;
    for(int i = 0; i < RF_BAND_COUNT; i++) out[i] = -90.0f + (float)i;
}
static void f_fill_diag(void* ctx, RowDiag* d) {
    (void)ctx;
    assert(F.locked);
    d->flush_peak_ms = 42;
}
static void f_second_diag(void* ctx, const SessionCore* s) {
    (void)ctx; (void)s;
    assert(!F.locked);
    F.second_diags++;
}
static bool f_connected(void* ctx) { (void)ctx; return F.connected; }
static void f_send(void* ctx, const uint8_t* p, size_t len) {
    (void)ctx;
    assert(!F.locked);
    assert(len == BT_STREAM_PACKET_SIZE);
    memcpy(F.last_packet, p, len);
    F.sends++;
}

static SessionPlatform platform(void) {
    return (SessionPlatform){
        .lock = f_lock, .unlock = f_unlock, .now_ms = f_now, .delay_ms = f_delay,
        .cue = f_cue, .log = f_log, .datetime_now = f_datetime, .epoch_now = f_epoch,
        .file_start = f_file_start, .file_stop = f_file_stop,
        .file_append = f_file_append, .file_flush = f_file_flush,
        .rf_snapshot = f_rf, .fill_diag = f_fill_diag, .second_diag = f_second_diag,
        .live_connected = f_connected, .live_send = f_send,
    };
}

static SessionSettings settings(void) {
    SessionSettings c = {
        .sound_enabled = true, .zoom_enabled = true, .device_name = "Tester",
        .rf_calibrated = true, .rf_floors_dbm = {-101.5f, -99.25f, -97.0f},
        .cal_active = true, .cal_gain = 1.0123f, .cal_zero_counts = -321.4f,
        .cal_r_squared = 0.9991f, .cal_noise_std_dev = {0.4f, 1.1f, 2.39f},
        .cal_timestamp = 1790000000u,
    };
    return c;
}

static SessionCore S;

static void start(BioMapMode mode, SessionSettings cfg) {
    memset(&F, 0, sizeof(F));
    F.now = 5000;
    SessionPlatform p = platform();
    session_core_init(&S, mode, &p, &cfg);
}

static void tick(int n) {
    for(int i = 0; i < n; i++) {
        F.now += 100;
        session_core_tick(&S);
        assert(!F.locked);
    }
}

static int count_cue(BioMapCue cue) {
    int n = 0;
    for(int i = 0; i < F.cue_count; i++) n += (F.cues[i] == cue);
    return n;
}

static int count_lines(const char* buf, size_t len) {
    int n = 0;
    for(size_t i = 0; i < len; i++) n += (buf[i] == '\n');
    return n;
}

// ── Tests ──────────────────────────────────────────────────────────────

static void test_init_checks_platform(void) {
    printf("Running test_init_checks_platform...\n");
    SessionSettings cfg = settings();
    SessionPlatform p = platform();
    p.file_flush = NULL;
    EXPECT_FATAL(session_core_init(&S, BioMapModeGsrOnly, &p, &cfg));
    // Live Stream records nothing, so it needs no file functions...
    p.file_start = NULL;
    p.file_stop = NULL;
    p.file_append = NULL;
    session_core_init(&S, BioMapModeLiveStream, &p, &cfg);
    // ...but does need the live ones.
    p.live_send = NULL;
    EXPECT_FATAL(session_core_init(&S, BioMapModeLiveStream, &p, &cfg));
    p = platform();
    p.cue = NULL;
    EXPECT_FATAL(session_core_init(&S, BioMapModeDiagnostics, &p, &cfg));
}

static void test_start_header_and_settle(void) {
    printf("Running test_start_header_and_settle...\n");
    start(BioMapModeGpsGsrRf, settings());
    assert(session_core_key(&S, SessionKeyOk));
    assert(S.recording.active);
    assert(F.file_starts == 1);
    assert(strcmp(F.stamp, "2026-11-20_09-08-07") == 0);
    const char* want =
        "# RecordingStartTime:1795165687\n"
        "# DeviceName:Tester\n"
        "# Band Floors (dBm): 815:-101.5,868:-99.2,915:-97.0\n"
        "# GSR Calibration: gain:1.0123,zero_counts:-321.4,r2:0.9991,noise_ns:0.40,1.10,2.39,cal_time:1790000000\n"
        BIOMAP_CSV_COLS_GPS_GSR_RF_PROD;
    if(strcmp(F.header, want) != 0) {
        fprintf(stderr, "header:\n%s\nwant:\n%s\n", F.header, want);
        assert(0);
    }
    // Start sound, then the settle wait, both before the recording starts.
    assert(F.cue_count == 1 && F.cues[0] == BioMapCueRecordingStarted);
    assert(F.delay_count == 1 && F.delays[0] == GSR_TONE_SETTLE_MS);

    // Sound off: no settle wait. No radio cal or GSR cal: no such lines.
    SessionSettings cfg = settings();
    cfg.sound_enabled = false;
    cfg.rf_calibrated = false;
    cfg.cal_active = false;
    cfg.debug_fields_enabled = true;
    start(BioMapModeGpsGsr, cfg);
    session_core_key(&S, SessionKeyOk);
    assert(F.delay_count == 0);
    assert(strstr(F.header, "Band Floors") == NULL);
    assert(strstr(F.header, "GSR Calibration") == NULL);
    assert(strstr(F.header, BIOMAP_CSV_COLS_GPS_GSR_DEBUG) != NULL);
}

static void test_start_failures(void) {
    printf("Running test_start_failures...\n");
    start(BioMapModeGsrOnly, settings());
    F.fail_start = true;
    session_core_key(&S, SessionKeyOk);
    assert(!S.recording.active);
    assert(F.cue_count == 1 && F.cues[0] == BioMapCueError);
    assert(F.delay_count == 0);

    // A header too long for its buffer: Error, and no file opened.
    static char long_name[800];
    memset(long_name, 'x', sizeof(long_name) - 1);
    SessionSettings cfg = settings();
    cfg.device_name = long_name;
    start(BioMapModeGsrOnly, cfg);
    session_core_key(&S, SessionKeyOk);
    assert(F.file_starts == 0);
    assert(!S.recording.active);
    assert(F.cue_count == 1 && F.cues[0] == BioMapCueError);
    assert(strcmp(F.last_log, "Header too long") == 0);
}

static void test_rows_flush_and_heartbeat(void) {
    printf("Running test_rows_flush_and_heartbeat...\n");
    start(BioMapModeGsrOnly, settings());
    tick(5);  // before recording: no rows
    assert(F.append_calls == 0);
    session_core_key(&S, SessionKeyOk);
    F.cue_count = 0;
    tick(10 * FLUSH_INTERVAL);
    // One row a tick, written to the card once at FLUSH_INTERVAL seconds.
    assert(F.append_calls == 10 * FLUSH_INTERVAL);
    assert(F.flush_calls == 1);
    assert(count_lines(F.written, F.written_len) == 10 * FLUSH_INTERVAL);
    assert(strncmp(F.written, "0.00,", 5) == 0);
    // A heartbeat a second. No GSR sensor here, so never "fingers off".
    assert(count_cue(BioMapCueHeartbeat) == FLUSH_INTERVAL);
    assert(F.cue_count == FLUSH_INTERVAL);
    // Debug fields off: no once-a-second device log.
    assert(F.second_diags == 0);
}

static void test_rf_only_while_recording(void) {
    printf("Running test_rf_only_while_recording...\n");
    start(BioMapModeGpsGsrRf, settings());
    tick(3);
    assert(F.rf_calls == 0);
    session_core_key(&S, SessionKeyOk);
    tick(3);
    assert(F.rf_calls == 3);
    // With no GPS module the GPS columns are empty, then the radio columns.
    assert(strstr(F.rows, ",-90.0,-89.0,-88.0\n") != NULL);
}

static void test_clicks_muted_while_recording(void) {
    printf("Running test_clicks_muted_while_recording...\n");
    start(BioMapModeGpsGsr, settings());
    float z0 = S.pipeline.zoom.level;
    assert(session_core_key(&S, SessionKeyUp));
    assert(F.cue_count == 1 && F.cues[0] == BioMapCueClick);
    assert(S.pipeline.zoom.level > z0);

    session_core_key(&S, SessionKeyOk);
    F.cue_count = 0;
    float z1 = S.pipeline.zoom.level;
    assert(session_core_key(&S, SessionKeyDown));
    assert(session_core_key(&S, SessionKeyLeft));
    // The zoom still changes, but rule 3: no click during a recording.
    assert(S.pipeline.zoom.level < z1);
    assert(S.pipeline.graph.scroll_divider == 2);
    assert(F.cue_count == 0);

    // GPS + RF mode has no graph: the zoom keys do nothing.
    start(BioMapModeGpsOnly, settings());
    assert(!session_core_key(&S, SessionKeyUp));
    assert(F.cue_count == 0);
}

static void test_sound_rule_checks(void) {
    printf("Running test_sound_rule_checks...\n");
    start(BioMapModeGsrOnly, settings());
    // Rule 2: a cue with a sound while the session holds the lock stops
    // the app; a light-only cue is fine.
    S.locked = true;
    session_core_cue(&S, BioMapCueHeartbeat);
    EXPECT_FATAL(session_core_cue(&S, BioMapCueClick));
    S.locked = false;
    // Rule 3: during a recording a cue with a sound is left out.
    S.recording.active = true;
    F.cue_count = 0;
    session_core_cue(&S, BioMapCueSuccess);
    session_core_cue(&S, BioMapCueSdRetrying);
    assert(F.cue_count == 1 && F.cues[0] == BioMapCueSdRetrying);
}

static void test_stop_keys(void) {
    printf("Running test_stop_keys...\n");
    // OK stops: file closed first, then the stop sound.
    start(BioMapModeGsrOnly, settings());
    session_core_key(&S, SessionKeyOk);
    tick(15);
    F.cue_count = 0;
    session_core_key(&S, SessionKeyOk);
    assert(!S.recording.active && S.running);
    assert(F.file_stops == 1 && F.flush_calls == 1);  // only the final write: under 10 s
    assert(F.cue_count == 1 && F.cues[0] == BioMapCueRecordingStopped);
    assert(count_lines(F.written, F.written_len) == 15);

    // Back with the final write failing twice: the warning instead.
    start(BioMapModeGsrOnly, settings());
    session_core_key(&S, SessionKeyOk);
    tick(15);
    F.cue_count = 0;
    F.fail_flushes = 2;
    assert(!session_core_key(&S, SessionKeyBack));
    assert(!S.running && !S.recording.active);
    assert(F.file_stops == 1);
    assert(F.cue_count == 1 && F.cues[0] == BioMapCueRecordingIncomplete);

    // One failed final write is retried and counts as clean.
    start(BioMapModeGsrOnly, settings());
    session_core_key(&S, SessionKeyOk);
    tick(3);
    F.cue_count = 0;
    F.fail_flushes = 1;
    session_core_key(&S, SessionKeyBack);
    assert(F.cues[0] == BioMapCueRecordingStopped);

    // Back when not recording: the back sound, nothing closed.
    start(BioMapModeGsrOnly, settings());
    session_core_key(&S, SessionKeyBack);
    assert(!S.running && F.file_stops == 0);
    assert(F.cue_count == 1 && F.cues[0] == BioMapCueBack);

    // session_core_end() closes a recording left active, quietly if clean.
    start(BioMapModeGsrOnly, settings());
    session_core_key(&S, SessionKeyOk);
    tick(2);
    F.cue_count = 0;
    session_core_end(&S);
    assert(!S.recording.active && F.file_stops == 1 && F.cue_count == 0);
    session_core_end(&S);
    assert(F.file_stops == 1);
}

static void test_sd_ride_out_and_stop(void) {
    printf("Running test_sd_ride_out_and_stop...\n");
    // Five failed flushes are ridden out; the next success writes every row.
    start(BioMapModeGsrOnly, settings());
    session_core_key(&S, SessionKeyOk);
    F.cue_count = 0;
    F.fail_flushes = SD_FLUSH_FAIL_STREAK_LIMIT - 1;
    tick(10 * FLUSH_INTERVAL * SD_FLUSH_FAIL_STREAK_LIMIT);
    assert(S.recording.active && !S.recording.write_stopped);
    assert(count_cue(BioMapCueSdRetrying) == SD_FLUSH_FAIL_STREAK_LIMIT - 1);
    assert(S.recording.flush_fail_streak == 0);
    assert(count_lines(F.written, F.written_len) == 10 * FLUSH_INTERVAL * SD_FLUSH_FAIL_STREAK_LIMIT);
    assert(strstr(F.last_log, "recovered after 5") != NULL);

    // Six in a row stop the recording: the light at once (lock held),
    // then the file closed, then the alarm.
    start(BioMapModeGsrOnly, settings());
    session_core_key(&S, SessionKeyOk);
    F.cue_count = 0;
    F.fail_flushes = 1000;
    tick(10 * FLUSH_INTERVAL * SD_FLUSH_FAIL_STREAK_LIMIT);
    assert(!S.recording.active && S.recording.write_stopped);
    assert(F.file_stops == 1);
    assert(F.cues[F.cue_count - 2] == BioMapCueSdWriteStopped);
    assert(F.cues[F.cue_count - 1] == BioMapCueSdWriteStoppedAlarm);
    int flushes = F.flush_calls;
    tick(10 * FLUSH_INTERVAL);  // stopped: no more flushes or heartbeats
    assert(F.flush_calls == flushes);
    // A new recording clears the stopped state.
    F.fail_flushes = 0;
    session_core_key(&S, SessionKeyOk);
    assert(S.recording.active && !S.recording.write_stopped);

    // A full buffer flushes at once; full and failing stops at once.
    start(BioMapModeGsrOnly, settings());
    session_core_key(&S, SessionKeyOk);
    F.rows_cap = 40;  // four 9-byte rows ("0.00,0.0\n")
    tick(5);          // the fifth doesn't fit: flush at once
    assert(F.flush_calls == 1);
    assert(S.recording.active);
    F.fail_flushes = 1000;
    tick(6);
    assert(!S.recording.active && S.recording.write_stopped);
}

static void test_debug_fields(void) {
    printf("Running test_debug_fields...\n");
    SessionSettings cfg = settings();
    cfg.debug_fields_enabled = true;
    start(BioMapModeGpsGsr, cfg);
    tick(10);
    assert(F.second_diags == 1);  // once a second, even when not recording
    int logs = F.log_count;
    session_core_key(&S, SessionKeyOk);
    tick(10);
    assert(F.second_diags == 2);
    assert(F.log_count == logs + 1);  // the telemetry line
    assert(strncmp(F.last_log, "telemetry tick_dt=10", 20) == 0);
    // The device's figures reach the row (flush_peak_ms = 42).
    assert(strstr(F.rows, ",42,") != NULL);
}

static void test_live_stream(void) {
    printf("Running test_live_stream...\n");
    start(BioMapModeLiveStream, settings());
    tick(1);
    assert(F.sends == 1);  // the first tick sends at once
    tick(BT_STREAM_INTERVAL_TICKS * 4);
    assert(F.sends == 5);
    assert(F.last_packet[0] == 'B' && F.last_packet[1] == 'N');
    uint32_t ts;
    memcpy(&ts, F.last_packet + 2, sizeof(ts));
    assert(ts == (uint32_t)(4 * BT_STREAM_INTERVAL_TICKS * (1000 / TICK_HZ)));
    // OK has nothing to start: a click, no file.
    F.cue_count = 0;
    assert(!session_core_key(&S, SessionKeyOk));
    assert(F.cue_count == 1 && F.cues[0] == BioMapCueClick);
    assert(F.file_starts == 0 && F.append_calls == 0 && F.flush_calls == 0);
    // Without a GSR sensor, a connect gives up the bias check after the
    // tries run out.
    F.connected = true;
    tick(LIVE_BIAS_MAX_TRIES);
    assert(S.live_bias_checked);
}

static void test_diagnostics_records_nothing(void) {
    printf("Running test_diagnostics_records_nothing...\n");
    SessionPlatform p = platform();
    p.file_start = NULL;
    p.file_stop = NULL;
    p.file_append = NULL;
    p.file_flush = NULL;
    SessionSettings cfg = settings();
    memset(&F, 0, sizeof(F));
    session_core_init(&S, BioMapModeDiagnostics, &p, &cfg);
    session_core_key(&S, SessionKeyOk);
    tick(10 * FLUSH_INTERVAL);
    assert(!S.recording.active);
    assert(F.cue_count == 1 && F.cues[0] == BioMapCueClick);
}

static void test_redraw_cadence(void) {
    printf("Running test_redraw_cadence...\n");
    start(BioMapModeGsrOnly, settings());
    int redraws = 0;
    for(int i = 0; i < 20; i++) redraws += session_core_tick(&S);
    assert(redraws == 4);
}

int main(void) {
    test_init_checks_platform();
    test_start_header_and_settle();
    test_start_failures();
    test_rows_flush_and_heartbeat();
    test_rf_only_while_recording();
    test_clicks_muted_while_recording();
    test_sound_rule_checks();
    test_stop_keys();
    test_sd_ride_out_and_stop();
    test_debug_fields();
    test_live_stream();
    test_diagnostics_records_nothing();
    test_redraw_cadence();
    printf("All session tests passed!\n");
    return 0;
}
