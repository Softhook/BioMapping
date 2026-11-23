// test_session.c — the shared session (core/biomap_session.c) and its
// screen (core/biomap_screen.c) against a
// fake device: no Flipper headers. Checks what the session does with keys
// and ticks (rows, the header, cues, the SD failure rules, the Live Stream
// packets) and which device calls happen with the lock held.
//
// Each fake device function asserts whether the lock is held, so moving a
// slow call (file write, sound, Bluetooth send) under the lock fails here.

#include "core/biomap_session.h"
#include "core/cal_wizard.h"
#include "core/biomap_screen.h"
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
    int   flush_all_calls;  // flushes asked to write everything (the stop's)
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
static int f_file_flush(void* ctx, bool all) {
    (void)ctx;
    assert(!F.locked);
    F.flush_calls++;
    if(all) F.flush_all_calls++;
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
        .firmware = BIOMAP_FIRMWARE_TEXT("Tester", "9.8.7"),
        .hardware_address = "DC:54:75:0C:2A:03",
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
    float  skin_wobble_v; // the skin input steps ± this every 0.5 s (a noisy reading)
    float  hum_v;         // mains hum on the skin input: amplitude, V (0 = none)
    double hum_hz;        // and its frequency
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
    if(!on_bias && G.skin_wobble_v != 0.0f) {
        v += ((F.now / 500u) % 2u) ? G.skin_wobble_v : -G.skin_wobble_v;
    }
    if(!on_bias && G.hum_v != 0.0f) {
        v += G.hum_v * (float)sin(2.0 * 3.14159265358979 * G.hum_hz * (double)F.now / 1000.0);
    }
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
        // The host tests' build sets no BIOMAP_GIT_REV.
        "# Firmware:Tester 9.8.7 (unknown)\n"
        "# HardwareAddress:DC:54:75:0C:2A:03\n"
        "# Band Floors (dBm): 815:-101.5,868:-99.2,915:-97.0\n"
        "# GSR Calibration: gain:1.0123,zero_counts:-321.4,r2:0.9991,noise_ns:0.40,1.10,2.39,cal_time:1790000000\n"
        BIOMAP_CSV_COLS_GPS_GSR_RF_PROD;
    if(strcmp(F.header, want) != 0) {
        fprintf(stderr, "header:\n%s\nwant:\n%s\n", F.header, want);
        assert(0);
    }
    // The CSV's radio columns spell out the shared band names.
    assert(strstr(BIOMAP_CSV_COLS_GPS_GSR_RF_PROD,
                  "rssi_" RF_BAND_0_MHZ ",rssi_" RF_BAND_1_MHZ ",rssi_" RF_BAND_2_MHZ "\n") != NULL);
    assert(strstr(BIOMAP_CSV_COLS_GPS_GSR_RF_DEBUG,
                  "rssi_" RF_BAND_0_MHZ ",rssi_" RF_BAND_1_MHZ ",rssi_" RF_BAND_2_MHZ ",") != NULL);
    // Start sound, then the settle wait, both before the recording starts.
    assert(F.cue_count == 1 && F.cues[0] == BioMapCueRecordingStarted);
    assert(F.delay_count == 1 && F.delays[0] == GSR_TONE_SETTLE_MS);

    // Sound off: no settle wait. No radio cal or GSR cal, no firmware text
    // or hardware address (the Flipper has none): no such lines.
    SessionSettings cfg = settings();
    cfg.sound_enabled = false;
    cfg.rf_calibrated = false;
    cfg.cal_active = false;
    cfg.firmware = NULL;
    cfg.hardware_address = NULL;
    cfg.debug_fields_enabled = true;
    start(BioMapModeGpsGsr, cfg);
    session_core_key(&S, SessionKeyOk);
    assert(F.delay_count == 0);
    assert(strstr(F.header, "Band Floors") == NULL);
    assert(strstr(F.header, "GSR Calibration") == NULL);
    assert(strstr(F.header, "Firmware") == NULL);
    assert(strstr(F.header, "HardwareAddress") == NULL);
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
    assert(F.flush_all_calls == 0);  // the periodic flush may keep part of a block back
    assert(count_lines(F.written, F.written_len) == 10 * FLUSH_INTERVAL);
    assert(strncmp(F.written, "0.00,", 5) == 0);
    // A heartbeat a second. No GSR sensor here, so never "fingers off".
    assert(count_cue(BioMapCueHeartbeat) == FLUSH_INTERVAL);
    assert(F.cue_count == FLUSH_INTERVAL);
    // Debug fields off: no once-a-second device log.
    assert(F.second_diags == 0);
}

// The tick count, tick gap and flush count all run before a recording
// starts too. A recording starts them again: row 0 shows no gap (not the
// start-up wait), and the first card write comes a full FLUSH_INTERVAL
// seconds in, however long the session ran first.
static void test_start_resets_tick_gap_and_flush(void) {
    printf("Running test_start_resets_tick_gap_and_flush...\n");
    SessionSettings cfg = settings();
    cfg.debug_fields_enabled = true;
    cfg.sound_enabled = false;
    start(BioMapModeGsrOnly, cfg);
    tick(25);  // 2.5 s before recording
    F.now += 700;  // the start-up wait (bias check, file, sound)
    session_core_key(&S, SessionKeyOk);
    tick(1);
    tick(10 * FLUSH_INTERVAL - 2);
    assert(F.flush_calls == 0);
    tick(1);
    assert(F.flush_calls == 1);

    // Row 0 itself: started again with no tick before it.
    start(BioMapModeGsrOnly, cfg);
    tick(3);
    F.now += 700;
    session_core_key(&S, SessionKeyOk);
    F.now += 100;
    session_core_tick(&S);
    assert(S.recording.tick_dt_ms == 0);
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
    assert(graph_divider(&S.pipeline.graph) == 2);
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
    assert(F.flush_all_calls == 1);  // ... and it asks for everything
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
    assert(F.flush_calls == 1 && F.flush_all_calls == 0);
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

// Every header line at once, each as long as it can get, with the radio
// mode's debug columns (the longest list): still fits the header buffer
// in biomap_session.c, so no device's recording start can fail on length.
static void test_longest_header_fits(void) {
    printf("Running test_longest_header_fits...\n");
    SessionSettings cfg = settings();
    cfg.debug_fields_enabled = true;
    cfg.device_name = "Abcdefgh";  // Flipper names are at most 8 characters
    cfg.firmware = "Cardputer 10.10.10 (396a8f1+changes)";
    cfg.hardware_address = "DC:54:75:0C:2A:03";
    for(int i = 0; i < RF_BAND_COUNT; i++) cfg.rf_floors_dbm[i] = -120.25f;
    cfg.cal_gain = 12.3456f;
    cfg.cal_zero_counts = -32768.0f;
    cfg.cal_r_squared = 0.9999f;
    for(int i = 0; i < CAL_POINTS; i++) cfg.cal_noise_std_dev[i] = 999.99f;
    cfg.cal_timestamp = 4294967295u;
    start_with_modules(BioMapModeGpsGsrRf, cfg, 0.5f);
    G.bias_v = 0.5031f;
    session_core_key(&S, SessionKeyOk);
    assert(S.recording.active);
    assert(strstr(F.header, "# HardwareAddress:DC:54:75:0C:2A:03\n") != NULL);
    assert(strstr(F.header, "# GPSChipID:" CHIP_PHRASE "\n") != NULL);
    assert(strstr(F.header, "# GSR Bias: ") != NULL);
    assert(strstr(F.header, BIOMAP_CSV_COLS_GPS_GSR_RF_DEBUG) != NULL);
    printf("  longest header: %zu bytes\n", strlen(F.header));
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
    int head = graph_shown(&S.pipeline.graph)->head;

    session_core_key(&S, SessionKeyOk);
    tick(10);
    assert(graph_shown(&S.pipeline.graph)->head != head);  // the graph moved on
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
    const GraphRing* ring = graph_shown(&S.pipeline.graph);
    int newest = (ring->head + GRAPH_N - 1) % GRAPH_N;
    assert(ring->buf[newest] == 0.0f);
}

// The GSR worker by hand at one device's pace (a reading every step_ms),
// with gsr_sensor_tick() every 100 + step_ms ms so the ticks walk through
// the mains cycle. Each tick runs just after the reading in its millisecond
// (as on the Cardputer, whose main loop wakes on the same kernel tick as
// the GSR task, just after it) or just before it. Records the window's
// entry counts and how far the mean strays from `base`.
typedef struct {
    int     min_n, max_n;
    int32_t worst;  // largest |mean - base|, normalised counts
    int32_t last;   // the last tick's mean
} WindowRun;

static WindowRun window_run(uint32_t step_ms, bool tick_before_read, int ticks, int32_t base) {
    WindowRun r = {.min_n = 1 << 30, .max_n = 0, .worst = 0, .last = 0};
    uint32_t period = 100 + step_ms;
    for(uint32_t t = 1; ticks > 0; t++) {
        F.now++;
        bool tick_now = (t % period) == 0;
        for(int pass = 0; pass < 2; pass++) {
            bool read_turn = (pass == 0) != tick_before_read;
            if(read_turn) {
                if(t % step_ms == 0) gsr_sensor_worker_pass(G.gsr);
            } else if(tick_now) {
                gsr_sensor_tick(G.gsr);
                int n = gsr_sensor_get_window_samples(G.gsr);
                int32_t m = gsr_sensor_get_mean_count(G.gsr);
                int32_t dev = m > base ? m - base : base - m;
                if(n < r.min_n) r.min_n = n;
                if(n > r.max_n) r.max_n = n;
                if(dev > r.worst) r.worst = dev;
                r.last = m;
                ticks--;
            }
        }
    }
    return r;
}

// The averaging window holds exactly 100 ms of readings — 100 at the
// Cardputer's pace (one every 1 ms), 50 at the Flipper's (every 2 ms) —
// whichever millisecond the tick lands in, so 50 Hz mains hum cancels in
// the mean. Counting a full 100 ms back from "now" would take one reading
// too many whenever the newest was read in the tick's own millisecond: a
// 101 or 102 ms window, letting about 1–2 % of the hum through.
static void test_window_is_exactly_100_ms(void) {
    printf("Running test_window_is_exactly_100_ms...\n");
    start_with_modules(BioMapModeGsrOnly, settings(), 0.5f);
    window_run(2, false, 15, 0);  // the gain climbs to ±0.512 V and settles
    for(uint32_t step = 1; step <= 2; step++) {
        for(int before = 0; before < 2; before++) {
            G.hum_v = 0.0f;
            int32_t base = window_run(step, before, 3, 0).last;
            // ±20 mV of 50 Hz hum: ±2560 counts in a single reading.
            G.hum_v = 0.02f;
            G.hum_hz = 50.0;
            WindowRun r = window_run(step, before, 20, base);
            int want = step == 1 ? 100 : 50;
            printf("  a reading every %u ms, tick %s it: %d-%d readings, hum left %d counts\n",
                   (unsigned)step, before ? "before" : "after", r.min_n, r.max_n, (int)r.worst);
            assert(r.min_n == want && r.max_n == want);
            assert(r.worst <= 3);
        }
    }
    G.hum_v = 0.0f;
}

// The graph shows no mains hum. Mains is never exactly 50 Hz; at 50.2 Hz a
// single reading taken every 100 ms swings through the hum once every 5 s,
// a slow wave the graph would draw as a real change. The graph follows the
// 100 ms mean, where the hum all but cancels.
static void test_graph_ignores_mains_hum(void) {
    printf("Running test_graph_ignores_mains_hum...\n");
    start_with_modules(BioMapModeGsrOnly, settings(), 0.5f);
    tick(30);  // the gain settles and the display primes
    G.hum_v = 0.02f;  // ±20 mV: about ±900 nS in a single reading
    G.hum_hz = 50.2;
    tick(20);  // the display filters settle
    float worst = 0.0f;
    for(int i = 0; i < 60; i++) {  // 6 s, more than one 5 s wave
        tick(1);
        const GraphRing* ring = graph_shown(&S.pipeline.graph);
        float v = fabsf(ring->buf[(ring->head + GRAPH_N - 1) % GRAPH_N]);
        if(v > worst) worst = v;
    }
    printf("  biggest graph step %.2f\n", (double)worst);
    assert(worst < 1.0f);
}

// The window spread (a debug column) shows the hum that the mean cancels:
// ±20 mV of 50 Hz is ±2560 counts in a single reading, so the readings in
// a window spread by its RMS, 2560 / √2 ≈ 1810 counts, while the mean
// stays put. With no hum only the pretend ADC's ±½-count dither is left.
static void test_window_spread_shows_hum(void) {
    printf("Running test_window_spread_shows_hum...\n");
    start_with_modules(BioMapModeGsrOnly, settings(), 0.5f);
    window_run(1, false, 15, 0);  // the gain climbs to ±0.512 V and settles
    SessionSettings cfg = settings();
    G.hum_v = 0.0f;
    window_run(1, false, 3, 0);
    float counts = (float)gsr_sensor_get_mean_count(G.gsr) - cfg.cal_zero_counts;
    float ns_per_count = (gsr_tia_counts_to_ns_at_bias(counts + 0.5f, 1.0f) -
                          gsr_tia_counts_to_ns_at_bias(counts - 0.5f, 1.0f)) * cfg.cal_gain;
    float quiet = gsr_sensor_get_window_spread_ns(G.gsr) / ns_per_count;
    G.hum_v = 0.02f;
    G.hum_hz = 50.0;
    window_run(1, false, 3, 0);
    float hum = gsr_sensor_get_window_spread_ns(G.gsr) / ns_per_count;
    printf("  spread %.2f counts with no hum, %.1f with hum\n", (double)quiet, (double)hum);
    assert(quiet < 2.0f);
    assert(hum > 1810.0f * 0.98f && hum < 1810.0f * 1.02f);
    G.hum_v = 0.0f;
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

// ── The recording screen (core/biomap_screen.c) ────────────────────────
// A pretend screen that keeps every text and box drawn, with a made-up
// font (4 px a character, 6 in the title font). Every call is checked:
// on the 128 × 64 screen, and colour swaps in pairs.

typedef struct { int x, y; char text[48]; } DrawnText;
typedef struct { int x, y, w, h; } DrawnBox;

typedef struct {
    DrawnText texts[64];
    int       text_count;
    DrawnBox  boxes[16];
    int       box_count;
    int       dots, lines, frames;
    int       font;      // ScreenFont
    bool      inverted;
} FakeScreen;

static FakeScreen D;

static void on_screen(int x, int y) {
    assert(x >= 0 && x < SCREEN_W);
    assert(y >= 0 && y < SCREEN_H);
}
static void d_clear(void* ctx) { (void)ctx; assert(!D.inverted); }
static void d_font(void* ctx, ScreenFont f) { (void)ctx; D.font = f; }
static void d_str(void* ctx, int x, int y, const char* t) {
    (void)ctx;
    on_screen(x, y);
    assert(D.text_count < 64);
    DrawnText* dt = &D.texts[D.text_count++];
    dt->x = x;
    dt->y = y;
    snprintf(dt->text, sizeof(dt->text), "%s", t);
}
static int d_width(void* ctx, const char* t) {
    (void)ctx;
    return (int)strlen(t) * (D.font == ScreenFontPrimary ? 6 : 4);
}
static void d_dot(void* ctx, int x, int y) { (void)ctx; on_screen(x, y); D.dots++; }
static void d_line(void* ctx, int x1, int y1, int x2, int y2) {
    (void)ctx;
    on_screen(x1, y1);
    on_screen(x2, y2);
    D.lines++;
}
static void d_box(void* ctx, int x, int y, int w, int h) {
    (void)ctx;
    on_screen(x, y);
    on_screen(x + w - 1, y + h - 1);
    assert(D.box_count < 16);
    D.boxes[D.box_count++] = (DrawnBox){x, y, w, h};
}
static void d_frame(void* ctx, int x, int y, int w, int h) {
    (void)ctx;
    on_screen(x, y);
    on_screen(x + w - 1, y + h - 1);
    D.frames++;
}
static void d_invert(void* ctx) { (void)ctx; D.inverted = !D.inverted; }

static ScreenCache SC;
static ScreenExtras X;

static void draw(void) {
    memset(&D, 0, sizeof(D));
    D.font = -1;
    ScreenDraw d = {
        .clear = d_clear, .set_font = d_font, .draw_str = d_str, .str_width = d_width,
        .draw_dot = d_dot, .draw_line = d_line, .draw_box = d_box, .draw_frame = d_frame,
        .invert = d_invert,
    };
    screen_draw_session(&d, &S, &X, &SC);
    assert(!D.inverted);  // every swap undone
}

static const DrawnText* text_starting(const char* prefix) {
    for(int i = 0; i < D.text_count; i++) {
        if(strncmp(D.texts[i].text, prefix, strlen(prefix)) == 0) return &D.texts[i];
    }
    return NULL;
}

static bool has_box(int x, int y, int w, int h) {
    for(int i = 0; i < D.box_count; i++) {
        const DrawnBox* b = &D.boxes[i];
        if(b->x == x && b->y == y && b->w == w && b->h == h) return true;
    }
    return false;
}

static void screen_start(BioMapMode mode, SessionSettings cfg) {
    start_with_modules(mode, cfg, 0.5f);
    screen_cache_init(&SC);
    X = (ScreenExtras){0};
}

// GPS + GSR: the top bar (GPS badge, elapsed time, nS value), the graph,
// and the recording mark.
static void test_screen_gps_gsr(void) {
    printf("Running test_screen_gps_gsr...\n");
    screen_start(BioMapModeGpsGsr, settings());
    draw();
    const DrawnText* badge = text_starting("No fix");
    assert(badge && badge->x == 1 && badge->y == 10);
    gps_fix();
    tick(20);
    draw();
    // HDOP 0.9 and no u-blox accuracy figure: about 2.2 m (HDOP × 2.5).
    badge = text_starting("2.");
    assert(badge && badge->x == 1 && strstr(badge->text, "m") != NULL);
    // The nS value at the top right, 2 px from the edge; no recording mark.
    const DrawnText* ns = text_starting("49");
    assert(ns && ns->y == 10 && strstr(ns->text, " nS") != NULL);
    assert(ns->x + (int)strlen(ns->text) * 4 == SCREEN_W - 2);
    assert(!has_box(118, 1, 8, 8));
    assert(D.dots == SCREEN_W - 2);  // one per graph column
    // The zoom label, bottom left ("1.0x"; auto-zoom moves it).
    bool zoom_label = false;
    for(int i = 0; i < D.text_count; i++) {
        const DrawnText* z = &D.texts[i];
        if(z->x == 2 && z->y == 62 && z->text[strlen(z->text) - 1] == 'x') zoom_label = true;
    }
    assert(zoom_label);

    // Recording: the mark, the nS value moved left for it, and the time.
    session_core_key(&S, SessionKeyOk);
    tick(25);
    draw();
    assert(has_box(118, 1, 8, 8));
    ns = text_starting("49");
    assert(ns->x + (int)strlen(ns->text) * 4 == SCREEN_W - 12);
    const DrawnText* t = text_starting("2s");
    assert(t && t->y == 10 && t->x > badge->x);
    S.recording.total_ticks = 10 * 3725;
    draw();
    assert(text_starting("1h02m") != NULL);
    S.recording.total_ticks = 10 * 125;
    draw();
    assert(text_starting("2m") != NULL);

    // An SD write being retried: the mark blinks (on, off, on...).
    S.recording.flush_fail_streak = 1;
    S.recording.total_ticks = 10;
    draw();
    assert(has_box(118, 1, 8, 8));
    S.recording.total_ticks = 15;
    draw();
    assert(!has_box(118, 1, 8, 8));

    // Recording stopped by the SD card: the banner over the top.
    S.recording.active = false;
    S.recording.write_stopped = true;
    draw();
    assert(has_box(0, 0, SCREEN_W, 11));
    assert(text_starting("REC STOPPED - SD ERROR") != NULL);
    S.recording.write_stopped = false;

    // Fingers off: the message centred on the graph, no graph, no nS.
    G.skin_v = 0.0f;
    tick(40);
    draw();
    const DrawnText* l1 = text_starting("Finger cuffs");
    const DrawnText* l2 = text_starting("disconnected");
    assert(l1 && l2 && l1->y == 36 && l2->y == 45);
    assert(l1->x == SCREEN_W / 2 - (int)strlen("Finger cuffs") * 4 / 2);
    assert(D.dots == 0);
    assert(text_starting("49") == NULL);

    // No GPS module (not set up yet, or failed): "No fix", and the app
    // carries on.
    G.skin_v = SKIN_V_5US;
    tick(5);
    GpsUart* gps = S.gps;
    S.gps = NULL;
    draw();
    assert(text_starting("No fix") != NULL);
    S.gps = gps;
}

// GPS + GSR + RF: the radio panel on the left, one bar per band above its
// label, measured from that band's calibrated floor.
static void test_screen_radio_panel(void) {
    printf("Running test_screen_radio_panel...\n");
    screen_start(BioMapModeGpsGsrRf, settings());  // floors -101.5, -99.25, -97.0
    float rf[RF_BAND_COUNT] = {-90.0f, -120.0f, -50.0f};
    X.rf_dbm = rf;
    draw();
    assert(text_starting("815 MHz")->y == 30);
    assert(text_starting("868 MHz")->y == 46);
    assert(text_starting("915 MHz")->y == 62);
    // 815: 11.5 dB above its floor, of an 18 dB scale, on a 40 px bar: 26 px.
    assert(has_box(1, 16, 26, 6));
    // 868: below its floor, so no bar. 915: off the scale, so full length.
    for(int i = 0; i < D.box_count; i++) assert(D.boxes[i].y != 32);
    assert(has_box(1, 48, 40, 6));
    // The graph is narrowed to the right of the panel.
    assert(D.dots == SCREEN_W - 43 - 2);

    // Without a radio calibration the floor is -90 dBm for every band.
    SessionSettings cfg = settings();
    cfg.rf_calibrated = false;
    screen_start(BioMapModeGpsGsrRf, cfg);
    X.rf_dbm = rf;
    draw();
    assert(!has_box(1, 16, 26, 6));  // -90 dBm is now exactly the floor: no bar
    // No reading to show: no panel at all.
    X.rf_dbm = NULL;
    draw();
    assert(text_starting("815 MHz") == NULL);
}

// GPS + RF: the recording's start time from its file name, then the GPS.
static void test_screen_gps_rf(void) {
    printf("Running test_screen_gps_rf...\n");
    screen_start(BioMapModeGpsOnly, settings());
    float rf[RF_BAND_COUNT] = {-95.0f, -95.0f, -95.0f};
    X.rf_dbm = rf;
    X.file_name = "biomap_2026-11-20_09-08-07_2.csv";
    gps_fix();
    draw();
    assert(text_starting("09:08:07 UTC")->y == 25);
    assert(text_starting("09-08-07") == NULL);  // not recording: no name
    session_core_key(&S, SessionKeyOk);
    tick(2);
    // Recording: the start time from the file name goes top left, in the
    // top bar, so the four GPS lines stay where they were and the last one
    // (accuracy and fix type) stays on the screen.
    draw();
    const DrawnText* name = text_starting("09-08-07_2");
    assert(name && name->x == 1 && name->y == 10);
    assert(strcmp(name->text, "09-08-07_2") == 0);
    assert(text_starting("09:08:07 UTC")->y == 25);
    assert(text_starting("51.50000")->y == 35);
    assert(text_starting("-0.12500")->y == 45);
    assert(text_starting("2.")->y == 55);  // "2.2m  --"

    // No GPS module at all.
    S.gps = NULL;
    draw();
    assert(text_starting("GPS unavailable") != NULL);
}

// Live Stream: the Bluetooth state, dropped packets, GSR and GPS.
static void test_screen_live_stream(void) {
    printf("Running test_screen_live_stream...\n");
    screen_start(BioMapModeLiveStream, settings());
    X.link = ScreenLinkAdvertising;
    draw();
    assert(text_starting("Live Stream")->y == 10);
    assert(text_starting("BLE: Advertising") != NULL);
    assert(text_starting("GPS: No fix") != NULL);
    X.link = ScreenLinkConnected;
    X.link_dropped = 3;
    gps_fix();
    tick(5);
    draw();
    assert(text_starting("BLE: Connected") != NULL);
    assert(text_starting("Dropped: 3") != NULL);
    assert(text_starting("GSR: 49") != NULL);
    assert(text_starting("GPS: --  Sats:") != NULL);  // a fix, but no 2D/3D report yet
    G.skin_v = 0.0f;
    tick(40);
    draw();
    assert(text_starting("GSR: cuffs disconnected") != NULL);
}

// Custom draw_graph callback (used by the Cardputer's 240 × 135 smooth spline
// renderer): replaces the default 128 × 64 frame, dots, lines and zoom label
// without coordinate sniffing, while keeping the top bar and cuffs-off status.
static struct {
    int  calls;
    int  gx, gy, gw, gh;
    bool visible;
} DG;

static void d_custom_graph(void* ctx, const SessionCore* s, int gx, int gy, int gw, int gh,
                           bool visible) {
    (void)ctx;
    assert(s == &S);
    DG.calls++;
    DG.gx = gx;
    DG.gy = gy;
    DG.gw = gw;
    DG.gh = gh;
    DG.visible = visible;
}

static void test_screen_custom_graph_callback(void) {
    printf("Running test_screen_custom_graph_callback...\n");
    screen_start(BioMapModeGpsGsr, settings());
    gps_fix();
    tick(20);
    memset(&D, 0, sizeof(D));
    memset(&DG, 0, sizeof(DG));
    D.font = -1;
    ScreenDraw d = {
        .clear = d_clear, .set_font = d_font, .draw_str = d_str, .str_width = d_width,
        .draw_dot = d_dot, .draw_line = d_line, .draw_box = d_box, .draw_frame = d_frame,
        .invert = d_invert, .draw_graph = d_custom_graph,
    };
    screen_draw_session(&d, &S, &X, &SC);
    assert(DG.calls == 1 && DG.gx == 0 && DG.gy == 16 && DG.gw == 128 && DG.gh == 48);
    assert(DG.visible);
    // Core did not draw the 128 × 64 dots, lines or frame itself.
    assert(D.dots == 0 && D.lines == 0 && D.frames == 0);
    // Top bar (badge and nS reading) is still drawn by core.
    assert(text_starting("2.") != NULL);
    assert(text_starting("49") != NULL);
}

// Shared 4-step calibration wizard state machine (CalWizardCore in
// core/biomap_session.c): Zero step + 470k, 100k, 47k resistor steps, bias
// check, cancel, and save.
static void run_wiz_dwell_to_end(CalWizardCore* w, BioMapCue* done_cue) {
    int guard = 0;
    while(cal_wizard_measuring(w)) {
        gsr_run(100);
        if(cal_wizard_tick(w, done_cue)) break;
        assert(++guard < 500);
    }
    assert(!cal_wizard_measuring(w));
}

static void test_cal_wizard_state_machine(void) {
    printf("Running test_cal_wizard_state_machine...\n");
    start_with_modules(BioMapModeGsrOnly, settings(), 0.5f);

    // 1. No sensor available: OK on Zero prompt plays BioMapCueClick, enters
    // MeasuringZero, and cal_wizard_check_sensor() transitions to
    // MeasureFailed with BioMapCueError; OK on failure resets to PromptZero.
    CalWizardCore w;
    cal_wizard_init(&w, NULL);
    assert(w.step == WizardStepPromptZero && !w.sensor_ok);
    BioMapCue cue = BioMapCueCount;
    assert(cal_wizard_key(&w, true, &cue) == CalKeyOutcomeStepChanged);
    assert(w.step == WizardStepMeasuringZero && cue == BioMapCueClick);
    assert(cal_wizard_check_sensor(&w, &cue));
    assert(w.step == WizardStepMeasureFailed && cue == BioMapCueError);
    char why[96];
    assert(cal_wizard_fail_reason(&w, why, sizeof(why)) && strcmp(why, "No GSR sensor") == 0);
    assert(cal_wizard_key(&w, true, &cue) == CalKeyOutcomeStepChanged);
    assert(w.step == WizardStepPromptZero && cue == BioMapCueClick);
    // Not a fail step: nothing to log.
    assert(!cal_wizard_fail_reason(&w, why, sizeof(why)));

    // 2. Full 4-step happy path with the pretend ADS1115.
    cal_wizard_init(&w, G.gsr);
    assert(w.sensor_ok);

    // Step 1/4: Open-circuit zero (0 V on skin input).
    G.skin_v = 0.0f;
    assert(cal_wizard_key(&w, true, &cue) == CalKeyOutcomeStepChanged);
    assert(w.step == WizardStepMeasuringZero && cue == BioMapCueClick);
    run_wiz_dwell_to_end(&w, &cue);
    assert(w.step == WizardStepPrompt470k && cue == BioMapCueConfirm);
    assert(fabsf(w.zero_counts) < 10.0f);

    // Steps 2..4/4: 470k, 100k, 47k resistors.
    // V_diff = 0.5 V * 47 / (R_kohm + 9.4)
    const float r_kohm[CAL_POINTS] = {470.0f, 100.0f, 47.0f};
    const int want_next[CAL_POINTS] = {
        WizardStepPrompt100k, WizardStepPrompt47k, WizardStepSuccess,
    };
    for(int i = 0; i < CAL_POINTS; i++) {
        G.skin_v = 0.5f * 47.0f / (r_kohm[i] + 9.4f);
        assert(cal_wizard_key(&w, true, &cue) == CalKeyOutcomeStepChanged);
        assert(w.step == i * 2 + 1 && cue == BioMapCueClick);
        run_wiz_dwell_to_end(&w, &cue);
        assert(w.step == want_next[i]);
        assert(cue == BioMapCueConfirm);
        assert(w.fit_cue == (i + 1 < CAL_POINTS ? BioMapCueCount : BioMapCueSuccess));
    }
    assert(fabsf(w.gain - 1.0f) < 0.02f && w.r_squared > 0.999f);

    assert(!cal_wizard_fail_reason(&w, why, sizeof(why)));  // passed

    // OK on WizardStepSuccess requests save & exit.
    assert(cal_wizard_key(&w, true, &cue) == CalKeyOutcomeSaveAndExit);
    assert(cue == BioMapCueConfirm);

    // 3. Back mid-dwell cancels immediately with BioMapCueBack.
    cal_wizard_init(&w, G.gsr);
    G.skin_v = 0.0f;
    cal_wizard_key(&w, true, &cue);
    assert(cal_wizard_measuring(&w));
    assert(cal_wizard_key(&w, false, &cue) == CalKeyOutcomeCancelAndExit);
    assert(!cal_wizard_measuring(&w) && cue == BioMapCueBack);
}

// Skin voltage that reads `ns` nanosiemens through the pretend board:
// V_diff = 0.5 V * 47 / (R_kohm + 9.4), with R_kohm = 1e6 / ns.
static float skin_v_for_ns(float ns) {
    return 0.5f * 47.0f / (1e6f / ns + 9.4f);
}

// Open-circuit zero step, passing: leaves the wizard at the 470k prompt.
static void wiz_pass_zero(CalWizardCore* w) {
    BioMapCue cue = BioMapCueCount;
    G.skin_v = 0.0f;
    assert(cal_wizard_key(w, true, &cue) == CalKeyOutcomeStepChanged);
    run_wiz_dwell_to_end(w, &cue);
    assert(w->step == WizardStepPrompt470k && cue == BioMapCueConfirm);
}

// One resistor step at a reading of `ns`, from its prompt.
static void wiz_measure(CalWizardCore* w, float ns, BioMapCue* cue) {
    G.skin_v = skin_v_for_ns(ns);
    assert(cal_wizard_key(w, true, cue) == CalKeyOutcomeStepChanged);
    run_wiz_dwell_to_end(w, cue);
}

// The wizard's log line for its current fail step must start with
// `want_start` and contain `want_part`.
static void assert_fail_reason(const CalWizardCore* w, const char* want_start,
                               const char* want_part) {
    char why[96];
    assert(cal_wizard_fail_reason(w, why, sizeof(why)));
    printf("    log: %s\n", why);
    assert(strncmp(why, want_start, strlen(want_start)) == 0);
    assert(strstr(why, want_part) != NULL);
}

// The wizard's fail screens, the log line for each, and that OK on each
// starts again from the zero step.
static void test_cal_wizard_fail_paths(void) {
    printf("Running test_cal_wizard_fail_paths...\n");
    start_with_modules(BioMapModeGsrOnly, settings(), 0.5f);
    CalWizardCore w;
    BioMapCue cue = BioMapCueCount;

    // Zero fail: something still connected during the open-circuit step.
    cal_wizard_init(&w, G.gsr);
    G.skin_v = SKIN_V_5US;
    assert(cal_wizard_key(&w, true, &cue) == CalKeyOutcomeStepChanged);
    run_wiz_dwell_to_end(&w, &cue);
    printf("  zero fail: step=%d zero=%.0f cue=%d\n", w.step, (double)w.zero_counts, (int)cue);
    assert(w.step == WizardStepZeroFailed && cue == BioMapCueError);
    assert(fabsf(w.zero_counts) > CAL_ZERO_MAX_COUNTS);  // the fail screen shows what was read
    assert_fail_reason(&w, "Zero failed:", "limit");
    assert(cal_wizard_key(&w, true, &cue) == CalKeyOutcomeStepChanged);
    assert(w.step == WizardStepPromptZero && cue == BioMapCueClick);

    // Measurement fail: nothing connected at the 470k step (below its gate).
    cal_wizard_init(&w, G.gsr);
    wiz_pass_zero(&w);
    G.skin_v = 0.0f;
    assert(cal_wizard_key(&w, true, &cue) == CalKeyOutcomeStepChanged);
    run_wiz_dwell_to_end(&w, &cue);
    assert(w.step == WizardStepMeasureFailed && w.fail_idx == 0 && cue == BioMapCueError);
    assert(w.dwell.below > 0 && w.dwell.in_gate == 0);
    assert_fail_reason(&w, "470k failed:", "in=0 below=");
    assert(cal_wizard_key(&w, true, &cue) == CalKeyOutcomeStepChanged);
    assert(w.step == WizardStepPromptZero);

    // Bias fail: the bias reads 0.40 V (out of range) at the 100k step.
    cal_wizard_init(&w, G.gsr);
    wiz_pass_zero(&w);
    wiz_measure(&w, CAL_TARGET_470K, &cue);
    assert(w.step == WizardStepPrompt100k);
    G.bias_v = 0.40f;
    wiz_measure(&w, CAL_TARGET_100K, &cue);
    G.bias_v = 0.5f;
    printf("  bias fail: step=%d bias=%.3f V\n", w.step, (double)w.bias_measured_v);
    assert(w.step == WizardStepBiasFailed && w.fail_idx == 1 && cue == BioMapCueError);
    assert(fabsf(w.bias_measured_v - 0.40f) < 0.01f);  // the fail screen shows what was read
    assert(!cal_wizard_measuring(&w));
    assert_fail_reason(&w, "Bias check failed:", "0.4");
    assert(cal_wizard_key(&w, true, &cue) == CalKeyOutcomeStepChanged);
    assert(w.step == WizardStepPromptZero);

    // Noise fail: the 470k reading steps up and down while in its gate.
    cal_wizard_init(&w, G.gsr);
    wiz_pass_zero(&w);
    G.skin_wobble_v = skin_v_for_ns(CAL_TARGET_470K) * 0.15f;
    wiz_measure(&w, CAL_TARGET_470K, &cue);
    G.skin_wobble_v = 0.0f;
    printf("  noise fail: step=%d sigma=%.1f nS\n", w.step, (double)w.noise_std_dev[0]);
    assert(w.step == WizardStepNoiseFailed && w.fail_idx == 0 && cue == BioMapCueError);
    assert(w.noise_std_dev[0] >= CAL_NOISE_ACCEPTABLE_NS);  // kept for the fail screen
    assert_fail_reason(&w, "470k too noisy:", "nS");
    assert(cal_wizard_key(&w, true, &cue) == CalKeyOutcomeStepChanged);
    assert(w.step == WizardStepPromptZero);

    // Fit fail: each reading inside its own gate, but not in proportion to
    // the resistors (100k reads high, 47k reads low), so R² is far below 0.95.
    cal_wizard_init(&w, G.gsr);
    wiz_pass_zero(&w);
    const float bad_ns[CAL_POINTS] = {2900.0f, 24000.0f, 6000.0f};
    for(int i = 0; i < CAL_POINTS; i++) {
        wiz_measure(&w, bad_ns[i], &cue);
        assert(cue == BioMapCueConfirm);  // each reading passed its own checks
    }
    printf("  fit fail: step=%d gain=%.3f r2=%.3f\n", w.step, (double)w.gain, (double)w.r_squared);
    assert(w.step == WizardStepFitFailed && w.fit_cue == BioMapCueError);
    assert(w.r_squared < 0.95f);
    assert_fail_reason(&w, "Fit failed:", "R2=");
    assert(cal_wizard_key(&w, true, &cue) == CalKeyOutcomeStepChanged);
    assert(w.step == WizardStepPromptZero);
    // A fresh run clears the last run's fit cue.
    G.skin_v = 0.0f;
    cal_wizard_key(&w, true, &cue);
    assert(w.fit_cue == BioMapCueCount);
}

int main(void) {
    test_init_checks_platform();
    test_start_header_and_settle();
    test_start_failures();
    test_rows_flush_and_heartbeat();
    test_start_resets_tick_gap_and_flush();
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
    test_longest_header_fits();
    test_heartbeat_fingers_and_fix();
    test_gsr_display_and_rows();
    test_window_is_exactly_100_ms();
    test_graph_ignores_mains_hum();
    test_window_spread_shows_hum();
    test_live_stream_bias_with_sensor();
    test_screen_gps_gsr();
    test_screen_radio_panel();
    test_screen_gps_rf();
    test_screen_live_stream();
    test_screen_custom_graph_callback();
    test_cal_wizard_state_machine();
    test_cal_wizard_fail_paths();
    free_modules();
    printf("All session tests passed!\n");
    return 0;
}
