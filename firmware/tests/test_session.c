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
#include <math.h>
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
static void gsr_run(uint32_t ms);
static void f_delay(void* ctx, uint32_t ms) {
    (void)ctx;
    assert(!F.locked);
    if(F.delay_count < 8) F.delays[F.delay_count++] = ms;
    gsr_run(ms);  // the GSR worker keeps running during the wait
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

// ── A pretend GSR chip (ADS1115) behind the real shared GSR code ────────
// Single-threaded: the GSR worker, which runs on its own thread on a real
// device, is run here by hand — between ticks (gsr_run()) and during any
// wait (the bias check, the settle wait after the start sound). The chip
// answers like the real one: the reading depends on which input the last
// config write chose (bit 6:4 = 101 is the bias input, AIN1) and on its
// gain (bits 3:1), so the code's gain switching sees real numbers.
typedef struct {
    GsrSensor* gsr;      // set once created, so waits inside create don't run the worker
    bool   locked;
    bool   in_worker;
    uint8_t cfg_msb;     // the last config write's first byte
    float  skin_v;       // the skin input's voltage; 0 = fingers off
    float  bias_v;       // the bias input's voltage (about 0.5 V)
    bool   bias_fails;   // reads on the bias input fail (I2C trouble)
    int    dither;       // ±1 count, so no two reads are identical
} FakeGsr;

static FakeGsr G;

// About 5 µS (5,000 nS): a normal skin reading.
#define SKIN_V_5US 0.112f

static void g_lock(void* ctx) { (void)ctx; assert(!G.locked); G.locked = true; }
static void g_unlock(void* ctx) { (void)ctx; assert(G.locked); G.locked = false; }
static uint32_t g_now(void* ctx) { (void)ctx; return F.now; }

// One worker pass every 2 ms, as on the Flipper (about 500 a second).
static void gsr_run(uint32_t ms) {
    for(uint32_t t = 0; t < ms; t += 2) {
        if(G.gsr && !G.in_worker) {
            G.in_worker = true;
            gsr_sensor_worker_pass(G.gsr);
            G.in_worker = false;
        }
        F.now += 2;
    }
}

static void g_delay(void* ctx, uint32_t ms) {
    (void)ctx;
    gsr_run(ms < 2 ? 2 : ms);
}

static bool g_i2c_read(void* ctx, uint8_t addr, uint8_t reg, uint8_t* data, size_t len,
                       uint32_t timeout_ms) {
    (void)ctx; (void)addr; (void)reg; (void)timeout_ms;
    static const float fsr[8] = {6.144f, 4.096f, 2.048f, 1.024f, 0.512f, 0.256f, 0.256f, 0.256f};
    bool on_bias = ((G.cfg_msb >> 4) & 7u) == 5u;
    if(on_bias && G.bias_fails) return false;
    float v = on_bias ? G.bias_v : G.skin_v;
    float code = v / fsr[(G.cfg_msb >> 1) & 7u] * 32768.0f;
    if(code > 32767.0f) code = 32767.0f;
    G.dither = !G.dither;
    int16_t c = (int16_t)(code + (G.dither ? 0.5f : -0.5f));
    if(v <= 0.0f) c = 0;
    if(len >= 1) data[0] = (uint8_t)((uint16_t)c >> 8);
    if(len >= 2) data[1] = (uint8_t)((uint16_t)c & 0xFF);
    return true;
}

static bool g_i2c_write(void* ctx, uint8_t addr, uint8_t reg, const uint8_t* data, size_t len,
                        uint32_t timeout_ms) {
    (void)ctx; (void)addr; (void)timeout_ms;
    if(reg == 0x01 && len >= 1) G.cfg_msb = data[0];
    return true;
}

// ── A pretend GPS module behind the real shared GPS code ────────────────
// Answers every set-up packet with an ACK and the chip ID poll with a
// fixed ID, so create() runs its normal path. NMEA sentences are fed with
// gps_send().
typedef struct {
    GpsUart* gps;
    bool     locked;
    uint8_t  rx[4096];
    size_t   rx_head, rx_len;
} FakeGps;

static FakeGps P;

// The chip ID AA BB CC DD EE FF, which reads as this phrase.
#define CHIP_PHRASE "baker mute aloha fable poet"

static void p_push(const uint8_t* b, size_t n) {
    assert(P.rx_len + n <= sizeof(P.rx));
    for(size_t i = 0; i < n; i++) P.rx[(P.rx_head + P.rx_len + i) % sizeof(P.rx)] = b[i];
    P.rx_len += n;
}

static void p_tx(void* ctx, const uint8_t* d, size_t len) {
    (void)ctx;
    static const uint8_t uniqid_poll[] = {0xB5, 0x62, 0x27, 0x03, 0x00, 0x00, 0x2A, 0xA5};
    static const uint8_t uniqid_reply[] = {
        0xB5, 0x62, 0x27, 0x03, 0x0A, 0x00, 0x02, 0x00, 0x00, 0x00,
        0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF, 0x31, 0x1A,
    };
    if(len == sizeof(uniqid_poll) && memcmp(d, uniqid_poll, len) == 0) {
        p_push(uniqid_reply, sizeof(uniqid_reply));
    } else if(len >= 4 && d[0] == 0xB5 && d[1] == 0x62 && d[2] == 0x06) {
        // UBX-ACK-ACK for this configuration packet.
        uint8_t ack[10] = {0xB5, 0x62, 0x05, 0x01, 0x02, 0x00, d[2], d[3], 0, 0};
        uint8_t a = 0, b = 0;
        for(int i = 2; i < 8; i++) { a = (uint8_t)(a + ack[i]); b = (uint8_t)(b + a); }
        ack[8] = a;
        ack[9] = b;
        p_push(ack, sizeof(ack));
    }
}

static void p_set_baud(void* ctx, uint32_t baud) { (void)ctx; (void)baud; }
static void p_rx_start(void* ctx, GpsRxMode mode) { (void)ctx; (void)mode; }
static void p_rx_stop(void* ctx) { (void)ctx; }
static size_t p_rx_read(void* ctx, uint8_t* buf, size_t len) {
    (void)ctx;
    size_t n = 0;
    while(n < len && P.rx_len > 0) {
        buf[n++] = P.rx[P.rx_head];
        P.rx_head = (P.rx_head + 1) % sizeof(P.rx);
        P.rx_len--;
    }
    return n;
}
static void p_rx_clear(void* ctx) { (void)ctx; P.rx_len = 0; }
static bool p_wake_seen(void* ctx, uint32_t* first_ms) { (void)ctx; *first_ms = F.now; return true; }
static uint32_t p_drops(void* ctx) { (void)ctx; return 0; }
static void p_again(void* ctx) { (void)ctx; }
static void p_delay(void* ctx, uint32_t ms) { (void)ctx; F.now += ms; }
static void p_lock(void* ctx) { (void)ctx; assert(!P.locked); P.locked = true; }
static void p_unlock(void* ctx) { (void)ctx; assert(P.locked); P.locked = false; }

// One NMEA sentence (without '$' and checksum), then parse it.
static void gps_send(const char* body) {
    uint8_t sum = 0;
    for(const char* c = body; *c; c++) sum ^= (uint8_t)*c;
    char line[160];
    int n = snprintf(line, sizeof(line), "$%s*%02X\r\n", body, sum);
    p_push((const uint8_t*)line, (size_t)n);
    gps_uart_handle_rx(P.gps);
}

static void gps_fix(void) {
    gps_send("GNRMC,090807.00,A,5130.0000,N,00007.5000,W,0.5,90.0,201126,,,A");
    gps_send("GNGGA,090807.00,5130.0000,N,00007.5000,W,1,08,0.9,45.0,M,47.0,M,,");
}

static void gps_no_fix(void) {
    gps_send("GNRMC,090808.00,V,,,,,,,201126,,,N");
    gps_send("GNGGA,090808.00,,,,,0,00,99.9,,,,,,");
}

static SessionCore S;

static void free_modules(void) {
    if(G.gsr) gsr_sensor_destroy(G.gsr);
    if(P.gps) gps_uart_destroy(P.gps);
    G.gsr = NULL;
    P.gps = NULL;
}

static void start(BioMapMode mode, SessionSettings cfg) {
    free_modules();
    memset(&F, 0, sizeof(F));
    F.now = 5000;
    SessionPlatform p = platform();
    session_core_init(&S, mode, &p, &cfg);
}

// start(), then the real GSR and GPS code on the pretend chips, set up
// the way the Flipper's loop does it (the session gets them after init).
// The GSR sensor measures bias_v once as it starts.
static void start_with_modules(BioMapMode mode, SessionSettings cfg, float bias_v) {
    start(mode, cfg);
    memset(&G, 0, sizeof(G));
    memset(&P, 0, sizeof(P));
    G.skin_v = SKIN_V_5US;
    G.bias_v = bias_v;
    GsrPlatform gp = {
        .lock = g_lock, .unlock = g_unlock, .now_ms = g_now, .delay_ms = g_delay,
        .i2c_read = g_i2c_read, .i2c_write = g_i2c_write,
    };
    if(session_mode_needs_gsr(mode)) {
        G.gsr = gsr_sensor_create(&gp);
        assert(gsr_sensor_available(G.gsr));
    }
    GpsPlatform pp = {
        .set_baud = p_set_baud, .tx = p_tx, .rx_start = p_rx_start, .rx_stop = p_rx_stop,
        .rx_read = p_rx_read, .rx_clear = p_rx_clear, .rx_wake_seen = p_wake_seen,
        .rx_drop_count = p_drops, .rx_again = p_again, .now_ms = g_now, .delay_ms = p_delay,
        .lock = p_lock, .unlock = p_unlock,
    };
    if(session_mode_needs_gps(mode)) {
        P.gps = gps_uart_create(&pp, true, GpsNavModelPedestrian, true);
        assert(gps_uart_is_ready(P.gps));
    }
    S.gsr = G.gsr;
    S.gps = P.gps;
    gsr_run(500);  // let the GSR settle on its starting gain
}

// Each tick: 100 ms of GSR worker passes (when there is a sensor), then
// the session's tick.
static void tick(int n) {
    for(int i = 0; i < n; i++) {
        if(G.gsr) gsr_run(100);
        else F.now += 100;
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
    // A radio mode that records needs the radio reading: its header lists
    // the radio columns. GPS Only is one of them.
    p = platform();
    p.rf_snapshot = NULL;
    EXPECT_FATAL(session_core_init(&S, BioMapModeGpsOnly, &p, &cfg));
    EXPECT_FATAL(session_core_init(&S, BioMapModeGpsGsrRf, &p, &cfg));
    // Diagnostics and the modes without radio don't.
    session_core_init(&S, BioMapModeDiagnostics, &p, &cfg);
    session_core_init(&S, BioMapModeGpsGsr, &p, &cfg);
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

// ── With the real GSR and GPS code on pretend chips ────────────────────

// The header's "# GSR Bias" line: a fresh check at each recording start.
// An out-of-range reading is written down but not used; a check that
// times out writes "none"; either way the last good value is used.
static void test_bias_header_line(void) {
    printf("Running test_bias_header_line...\n");
    start_with_modules(BioMapModeGpsGsr, settings(), 0.4980f);
    // Measured at start-up (498.0 mV); now it reads 503.1 mV.
    G.bias_v = 0.5031f;
    session_core_key(&S, SessionKeyOk);
    assert(S.recording.active);
    assert(strstr(F.header, "# GSR Bias: measured_mv:503.1,used_mv:503.1\n") != NULL);
    // The GPS module's ID, as its phrase.
    assert(strstr(F.header, "# GPSChipID:" CHIP_PHRASE "\n") != NULL);
    session_core_key(&S, SessionKeyOk);

    // Out of range (0.40 V): written down, but 503.1 mV stays in use.
    G.bias_v = 0.40f;
    session_core_key(&S, SessionKeyOk);
    assert(strstr(F.header, "# GSR Bias: measured_mv:400.0,used_mv:503.1\n") != NULL);
    session_core_key(&S, SessionKeyOk);

    // The bias input stops answering: the check times out, and the
    // recording still starts.
    G.bias_v = 0.5031f;
    G.bias_fails = true;
    uint32_t before = F.now;
    session_core_key(&S, SessionKeyOk);
    assert(S.recording.active);
    assert(F.now - before >= GSR_BIAS_CHECK_TIMEOUT_MS);
    assert(strstr(F.header, "# GSR Bias: measured_mv:none,used_mv:503.1\n") != NULL);
    session_core_key(&S, SessionKeyOk);
    G.bias_fails = false;

    // GSR only has the line too; GPS + RF (no GSR) doesn't.
    start_with_modules(BioMapModeGsrOnly, settings(), 0.5f);
    session_core_key(&S, SessionKeyOk);
    assert(strstr(F.header, "# GSR Bias: measured_mv:500.0,used_mv:500.0\n") != NULL);
    assert(strstr(F.header, "GPSChipID") == NULL);
    start_with_modules(BioMapModeGpsOnly, settings(), 0.5f);
    session_core_key(&S, SessionKeyOk);
    assert(strstr(F.header, "GSR Bias") == NULL);
    assert(strstr(F.header, "# GPSChipID:" CHIP_PHRASE "\n") != NULL);
}

// The once-a-second light: green with fingers on, red with them off,
// and the blue blip whenever GPS has no fix.
static void test_heartbeat_fingers_and_fix(void) {
    printf("Running test_heartbeat_fingers_and_fix...\n");
    start_with_modules(BioMapModeGpsGsr, settings(), 0.5f);
    gps_fix();
    session_core_key(&S, SessionKeyOk);
    F.cue_count = 0;
    tick(10 * 3);
    assert(count_cue(BioMapCueHeartbeat) == 3);
    assert(count_cue(BioMapCueHeartbeatFingersOff) == 0);
    assert(count_cue(BioMapCueNoGpsFix) == 0);

    // GPS loses its fix: the blip after each heartbeat.
    gps_no_fix();
    F.cue_count = 0;
    tick(10 * 2);
    assert(count_cue(BioMapCueHeartbeat) == 2);
    assert(count_cue(BioMapCueNoGpsFix) == 2);
    assert(F.cues[0] == BioMapCueHeartbeat && F.cues[1] == BioMapCueNoGpsFix);

    // Fingers off: red after the 2 s it takes to be sure.
    gps_fix();
    G.skin_v = 0.0f;
    F.cue_count = 0;
    tick(10 * 4);
    assert(!gsr_sensor_is_connected(G.gsr));
    assert(count_cue(BioMapCueHeartbeatFingersOff) >= 1);
    assert(F.cues[F.cue_count - 1] == BioMapCueHeartbeatFingersOff);

    // Back on: green again.
    G.skin_v = SKIN_V_5US;
    F.cue_count = 0;
    tick(10 * 2);
    assert(gsr_sensor_is_connected(G.gsr));
    assert(F.cues[F.cue_count - 1] == BioMapCueHeartbeat);
    // No sound at any point in the recording.
    for(int i = 0; i < F.cue_count; i++) assert(!biomap_cue_has_sound(F.cues[i]));
}

// The GSR display and graph follow the reading; rows carry it and, on the
// GPS row boundary, the fix.
static void test_gsr_display_and_rows(void) {
    printf("Running test_gsr_display_and_rows...\n");
    start_with_modules(BioMapModeGpsGsr, settings(), 0.5f);
    gps_fix();
    tick(20);
    float ns = S.pipeline.display.filtered_ns;
    printf("  reading %.0f nS (expect about 5000)\n", (double)ns);
    assert(ns > 4500.0f && ns < 5500.0f);
    assert(S.pipeline.display.primed);
    assert(fabsf(S.pipeline.display.smoothed - ns) < 250.0f);
    int head = S.pipeline.graph.head;

    session_core_key(&S, SessionKeyOk);
    tick(10);
    assert(S.pipeline.graph.head != head);  // the graph moved on
    // Every row has the reading; GPS_CSV_HZ is 10, so every row has the fix.
    assert(count_lines(F.rows, F.rows_len) == 10);
    assert(strstr(F.rows, "51.5000000") != NULL);
    assert(strstr(F.rows, "-0.1250000") != NULL);
    // gsr_raw is the 10th column: about 5,000 nS in every row.
    for(const char* row = F.rows; row < F.rows + F.rows_len; row = strchr(row, '\n') + 1) {
        const char* col = row;
        for(int c = 0; c < 9; c++) col = strchr(col, ',') + 1;
        float gsr = strtof(col, NULL);
        assert(gsr > 4500.0f && gsr < 5500.0f);
    }

    // Fingers off: the display holds its last good value (an out-of-range
    // reading is not shown), while the row records what was read.
    float shown = S.pipeline.display.smoothed;
    G.skin_v = 0.0f;
    tick(5);
    assert(S.pipeline.display.smoothed == shown);
    assert(S.pipeline.display.filtered_ns < GSR_VALID_MIN_NS);

    // Back on at a much higher reading (about 15 µS). The graph shows the
    // rate of change, so a jump would draw one tall spike; instead the
    // line restarts from the new value: the newest graph point is flat.
    G.skin_v = 0.30f;
    tick(1);
    assert(S.pipeline.display.raw_sample_ns > 12000.0f);
    int newest = (S.pipeline.graph.head + GRAPH_N - 1) % GRAPH_N;
    assert(S.pipeline.graph.buf[newest] == 0.0f);
}

// Live Stream's bias check on the first phone connect, with a real sensor:
// done once, logged, not repeated on a reconnect; given up after
// LIVE_BIAS_MAX_TRIES ticks if the sensor won't answer.
static void test_live_stream_bias_with_sensor(void) {
    printf("Running test_live_stream_bias_with_sensor...\n");
    start_with_modules(BioMapModeLiveStream, settings(), 0.4980f);
    tick(3);
    assert(!S.live_bias_checked);  // no phone yet
    G.bias_v = 0.5031f;
    F.connected = true;
    tick(1);
    assert(S.live_bias_checked);
    assert(strcmp(F.last_log, "Live Stream bias: measured 503.1 mV, using 503.1 mV") == 0);
    int logs = F.log_count;
    F.connected = false;
    tick(3);
    F.connected = true;
    tick(3);
    assert(F.log_count == logs);  // a reconnect doesn't check again
    // The packets carry the reading.
    float gsr_raw;
    memcpy(&gsr_raw, F.last_packet + 22, sizeof(gsr_raw));
    assert(gsr_raw > 4500.0f && gsr_raw < 5500.0f);

    // The bias input won't answer: three tries, then it gives up.
    start_with_modules(BioMapModeLiveStream, settings(), 0.5f);
    G.bias_fails = true;
    F.connected = true;
    tick(LIVE_BIAS_MAX_TRIES - 1);
    assert(!S.live_bias_checked);
    tick(1);
    assert(S.live_bias_checked);
    assert(strstr(F.last_log, "measured nan mV, using 500.0 mV") != NULL);
    int tries_logs = F.log_count;
    tick(5);
    assert(F.log_count == tries_logs);
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
    test_bias_header_line();
    test_heartbeat_fingers_and_fix();
    test_gsr_display_and_rows();
    test_live_stream_bias_with_sensor();
    free_modules();
    printf("All session tests passed!\n");
    return 0;
}
