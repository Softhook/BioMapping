// test_gps_uart.c — Host-side test for gps_uart.c's NMEA parsing and RX
// framing, run against the REAL production gps_uart.c (not a copy of its
// logic) — unmodified from what ships in the Flipper build. gps_uart.c
// calls the real Flipper SDK directly (furi_hal_serial_*, furi_mutex_*,
// furi_stream_buffer_*, ...); this test compiles it against tests/shims/
// (a minimal Furi-core + furi_hal shim, plus a fake USART1 peripheral in
// furi_hal_mock.c that lets us inject bytes as if they'd arrived from
// the ISR).
//
// Coverage: every NMEA sentence type gps_uart_parse_line() dispatches on
// (RMC, GGA, GSA, GSV, GLL), the RX-buffer-full and NMEA-watchdog reinit
// paths, hot start, standby, and malformed input. NOT covered: the
// L76K-specific PCAS command path (modules/gps_uart.c's #if GPS_MODULE ==
// GPS_MODULE_L76K branch) — biomap_config.h compiles this firmware for
// M10Q only, so PCAS code isn't even part of this binary; testing it would
// mean building a second variant with GPS_MODULE flipped, not done here.
//
// Build: ./run_tests.sh (or see that script for the raw gcc invocation).

#include <assert.h>
#include <math.h>
#include <stdio.h>
#include <string.h>

#include "modules/gps_uart.h"
#include "furi_hal.h"

// minmea.c defines its own static timegm(), which clashes with the
// libc-declared one when compiled standalone on a host toolchain — same
// workaround test_firmware.c uses: rename it away before pulling the
// implementation in textually (so gps_uart.c can link against real
// minmea_parse_* without a separate, conflicting minmea.c translation unit).
#include "minmea.h"
#define timegm mock_timegm
#include "minmea.c"

// Declared in tests/shims/furi.h; lets watchdog/timeout logic be exercised
// without a real clock.
extern _Atomic uint32_t furi_test_tick;
_Atomic uint32_t furi_test_tick = 1;

// ── Fixtures ─────────────────────────────────────────────────────────────
// Every checksum below was verified against minmea_checksum() before use
// (see the GGA note) — hand-computed NMEA checksums are exactly how the
// test_firmware.c fixture ended up wrong in the first place.

// Coordinates verified against minmea by test_firmware.c's test_nmea_parsing
// (5133.34438 N -> 51.5557397, 00004.28757 W -> -0.0714595), but that test
// calls minmea_parse_gga() directly and never validates the checksum field.
// gps_uart_parse_line()'s dispatch goes through minmea_sentence_id(), which
// does check it — test_firmware.c's "*50" is actually invalid (XOR is 6C).
// Caught here because this test drives the real dispatch path, not just
// the parser.
static const char* GGA_LINE =
    "$GNGGA,203337.00,5133.34438,N,00004.28757,W,1,16,0.9,123.4,M,45.6,M,,*6C\r\n";

// Documented worked example from minmea.c itself.
static const char* RMC_LINE =
    "$GPRMC,081836,A,3751.65,S,14507.36,E,000.0,360.0,130998,011.3,E*62\r\n";

// Documented worked example from minmea.c ($GNGSA variant, SystemID=1/GPS
// appended). 4 satellites (10,13,15,20), fix_type=3 (3D), pdop=2.5,
// hdop=2.0, vdop=1.5 — all PRNs < 120, so no SBAS.
static const char* GSA_LINE =
    "$GNGSA,A,3,10,13,15,20,,,,,,,,,2.5,2.0,1.5,1*35\r\n";

// Same shape as GSA_LINE with sats[0]=120 (SBAS range is PRN >= 120) to
// exercise the sbas_active detection branch.
static const char* GSA_SBAS_LINE =
    "$GNGSA,A,3,120,13,15,20,,,,,,,,,2.5,2.0,1.5,1*07\r\n";

// Single-message GSV (total_msgs=1, msg_nr=1) so it satisfies both the
// msg_nr==1 total_sats-accumulation branch AND the msg_nr==total_msgs
// gsv_fresh branch in one sentence. 4 sats: (nr=3,el=3) (nr=4,el=15)
// (nr=6,el=1) (nr=13,el=6). Talker GP -> constellation offset 0.
static const char* GSV_LINE =
    "$GPGSV,1,1,4,03,03,111,00,04,15,270,00,06,01,010,00,13,06,292,00*42\r\n";

// Second, distinct constellation (GLONASS) with a different total_sats (3),
// for the multi-constellation-in-one-window accumulation test.
static const char* GSV_LINE_GLONASS =
    "$GLGSV,1,1,3,65,10,100,00,66,20,200,00,67,30,300,00*64\r\n";

// Documented worked example from minmea.c, status='A' (valid) — GLL only
// updates position when status is DATA_VALID.
static const char* GLL_VALID_LINE =
    "$GPGLL,3723.2475,N,12158.3416,W,161229.487,A,A*41\r\n";

// Same fixture with status='V' (void) — must NOT update position.
static const char* GLL_INVALID_LINE =
    "$GPGLL,3723.2475,N,12158.3416,W,161229.487,V,A*56\r\n";

static void test_alloc_lifecycle(void) {
    printf("Running test_alloc_lifecycle...\n");
    FuriMessageQueue queue = {0};
    assert(furi_hal_mock_acquire_count() == 0);

    GpsUart* g = gps_uart_alloc(&queue, NULL, GpsNavModelPedestrian);
    assert(g != NULL);
    assert(gps_uart_is_ready(g));
    assert(furi_hal_mock_acquire_count() == 1);

    gps_uart_free(g);
    assert(furi_hal_mock_acquire_count() == 0);
    printf("  -> Pass\n");
}

// gps_uart_configure() sends 7 UBX-CFG packets (rate, GLL off, VTG off,
// GSV throttle, PUBX00 enable, NAV5, AssistNow VALSET) and waits for each
// one's UBX-ACK-ACK/NAK. This mock never feeds any bytes back during that
// window (furi_hal_serial_tx() is a no-op — see furi_hal_mock.c), so every
// packet times out waiting for a reply that never arrives (logged via
// FURI_LOG_W, compiled out under this host harness — see furi.h). This
// proves the failure path is bounded and doesn't hang or crash the host
// test's fake clock (tests/shims/furi.h's furi_get_tick() never advances
// on its own) — the exact risk a wall-clock-deadline design would have
// hit — and that a fully-unanswered configure() still leaves the module
// usable rather than failing alloc() outright. The ACK-received path
// itself isn't reachable from this mock, since nothing here can reply
// mid-configure().
static void test_cfg_ack_timeout_is_bounded(void) {
    printf("Running test_cfg_ack_timeout_is_bounded...\n");
    FuriMessageQueue queue = {0};
    GpsUart* g = gps_uart_alloc(&queue, NULL, GpsNavModelPedestrian);
    assert(g != NULL);
    assert(gps_uart_is_ready(g)); // config failures are logged, not fatal

    gps_uart_free(g);
    printf("  -> Pass\n");
}

static void test_gga_updates_status(void) {
    printf("Running test_gga_updates_status...\n");
    FuriMessageQueue queue = {0};
    GpsUart* g = gps_uart_alloc(&queue, NULL, GpsNavModelPedestrian);
    assert(g != NULL);

    furi_hal_mock_feed_string(GGA_LINE);
    gps_uart_process_rx(g);

    GpsStatus s = gps_uart_get_status(g);
    printf("  lat=%.7f lon=%.7f hdop=%.2f sats=%d fix_quality=%d\n",
           s.latitude, s.longitude, (double)s.hdop, s.satellites_tracked, s.fix_quality);
    assert(fabs(s.latitude - 51.5557397) < 1e-6);
    assert(fabs(s.longitude - (-0.0714595)) < 1e-6);
    assert(fabs((double)s.hdop - 0.9) < 1e-3);
    assert(s.satellites_tracked == 16);
    assert(s.fix_quality == 1);
    assert(queue.put_count >= 1); // UART event was posted to the app queue

    gps_uart_free(g);
    printf("  -> Pass\n");
}

static void test_rmc_updates_status(void) {
    printf("Running test_rmc_updates_status...\n");
    FuriMessageQueue queue = {0};
    GpsUart* g = gps_uart_alloc(&queue, NULL, GpsNavModelPedestrian);
    assert(g != NULL);

    furi_hal_mock_feed_string(RMC_LINE);
    gps_uart_process_rx(g);

    GpsStatus s = gps_uart_get_status(g);
    printf("  lat=%.7f lon=%.7f speed=%.1f course=%.1f fix_valid=%d\n",
           s.latitude, s.longitude, (double)s.speed, (double)s.course, s.fix_valid);
    assert(s.fix_valid == true);
    assert(fabs(s.latitude - (-37.860833)) < 1e-4);   // 3751.65 S
    assert(fabs(s.longitude - 145.122667) < 1e-4);    // 14507.36 E
    assert(fabs((double)s.course - 360.0) < 1e-3);

    gps_uart_free(g);
    printf("  -> Pass\n");
}

static void test_gsa_updates_status(void) {
    printf("Running test_gsa_updates_status...\n");
    FuriMessageQueue queue = {0};
    GpsUart* g = gps_uart_alloc(&queue, NULL, GpsNavModelPedestrian);
    assert(g != NULL);

    furi_hal_mock_feed_string(GSA_LINE);
    gps_uart_process_rx(g);

    GpsStatus s = gps_uart_get_status(g);
    printf("  fix_type=%d hdop=%.2f vdop=%.2f pdop=%.2f sbas=%d prn_count=%d\n",
           s.fix_type, (double)s.hdop, (double)s.vdop, (double)s.pdop,
           s.sbas_active, s.active_prn_count);
    assert(s.fix_type == 3);
    assert(fabs((double)s.hdop - 2.0) < 1e-3);
    assert(fabs((double)s.vdop - 1.5) < 1e-3);
    assert(fabs((double)s.pdop - 2.5) < 1e-3);
    assert(s.sbas_active == false);
    assert(s.active_prn_count == 4);
    assert(s.active_prns[0] == 10 && s.active_prns[1] == 13);
    assert(s.satellites_tracked == 4); // active_prn_count, no GGA/GSV yet

    gps_uart_free(g);
    printf("  -> Pass\n");
}

static void test_gsa_sbas_detection(void) {
    printf("Running test_gsa_sbas_detection...\n");
    FuriMessageQueue queue = {0};
    GpsUart* g = gps_uart_alloc(&queue, NULL, GpsNavModelPedestrian);
    assert(g != NULL);

    furi_hal_mock_feed_string(GSA_SBAS_LINE);
    gps_uart_process_rx(g);

    GpsStatus s = gps_uart_get_status(g);
    printf("  sbas_active=%d (sats[0]=120, SBAS range is >= 120)\n", s.sbas_active);
    assert(s.sbas_active == true);

    gps_uart_free(g);
    printf("  -> Pass\n");
}

static void test_gsv_elevation_and_fresh(void) {
    printf("Running test_gsv_elevation_and_fresh...\n");
    FuriMessageQueue queue = {0};
    GpsUart* g = gps_uart_alloc(&queue, NULL, GpsNavModelPedestrian);
    assert(g != NULL);

    furi_hal_mock_feed_string(GSV_LINE);
    gps_uart_process_rx(g);

    GpsStatus s = gps_uart_get_status(g);
    printf("  gsv_fresh=%d gsv_total_sats=%d elevation[3]=%d elevation[13]=%d\n",
           s.gsv_fresh, s.gsv_total_sats, s.sat_elevation[3], s.sat_elevation[13]);
    assert(s.gsv_fresh == true);         // msg_nr(1) == total_msgs(1)
    assert(s.gsv_total_sats == 4);       // accumulated on msg_nr==1
    assert(s.sat_elevation[3] == 3);     // PRN 3, GP talker -> offset 0
    assert(s.sat_elevation[4] == 15);
    assert(s.sat_elevation[6] == 1);
    assert(s.sat_elevation[13] == 6);

    gps_uart_free(g);
    printf("  -> Pass\n");
}

// Regression test for the track-111 sats-doubling bug: a talker whose GSV
// cycle restarts (msg_nr==1 again) inside the ~800ms accumulation window
// used to have its total_sats summed a second time (23 -> 46 on real
// hardware). Feeding the same GP cycle twice back-to-back, with the tick
// unmoved, must now leave gsv_total_sats at 4, not 8.
static void test_gsv_duplicate_within_window_not_doubled(void) {
    printf("Running test_gsv_duplicate_within_window_not_doubled...\n");
    FuriMessageQueue queue = {0};
    GpsUart* g = gps_uart_alloc(&queue, NULL, GpsNavModelPedestrian);
    assert(g != NULL);

    furi_hal_mock_feed_string(GSV_LINE);
    gps_uart_process_rx(g);
    furi_hal_mock_feed_string(GSV_LINE);
    gps_uart_process_rx(g);

    GpsStatus s = gps_uart_get_status(g);
    printf("  gsv_total_sats=%d (expect 4, not 8)\n", s.gsv_total_sats);
    assert(s.gsv_total_sats == 4);

    gps_uart_free(g);
    printf("  -> Pass\n");
}

// The dedup fix must not break the feature it's guarding: two DIFFERENT
// constellations' first-of-cycle GSV sentences arriving in the same window
// should still both contribute, giving the true combined satellite count.
static void test_gsv_multi_constellation_within_window_sums(void) {
    printf("Running test_gsv_multi_constellation_within_window_sums...\n");
    FuriMessageQueue queue = {0};
    GpsUart* g = gps_uart_alloc(&queue, NULL, GpsNavModelPedestrian);
    assert(g != NULL);

    furi_hal_mock_feed_string(GSV_LINE);          // GP, total_sats=4
    gps_uart_process_rx(g);
    furi_hal_mock_feed_string(GSV_LINE_GLONASS);  // GL, total_sats=3
    gps_uart_process_rx(g);

    GpsStatus s = gps_uart_get_status(g);
    printf("  gsv_total_sats=%d (expect 7 = 4 GP + 3 GL)\n", s.gsv_total_sats);
    assert(s.gsv_total_sats == 7);

    gps_uart_free(g);
    printf("  -> Pass\n");
}

// Once the ~800ms window genuinely elapses, the same talker's next cycle
// is a new epoch and must be counted again (the dedup guard is per-window,
// not permanent).
static void test_gsv_recounts_after_window_reset(void) {
    printf("Running test_gsv_recounts_after_window_reset...\n");
    FuriMessageQueue queue = {0};
    GpsUart* g = gps_uart_alloc(&queue, NULL, GpsNavModelPedestrian);
    assert(g != NULL);

    furi_hal_mock_feed_string(GSV_LINE);
    gps_uart_process_rx(g);
    furi_test_advance_tick(801); // > 800ms @ 1000 Hz shim frequency
    furi_hal_mock_feed_string(GSV_LINE);
    gps_uart_process_rx(g);

    GpsStatus s = gps_uart_get_status(g);
    printf("  gsv_total_sats=%d (expect 4 — fresh window, not carried over)\n",
           s.gsv_total_sats);
    assert(s.gsv_total_sats == 4);

    gps_uart_free(g);
    printf("  -> Pass\n");
}

static void test_gll_updates_when_valid(void) {
    printf("Running test_gll_updates_when_valid...\n");
    FuriMessageQueue queue = {0};
    GpsUart* g = gps_uart_alloc(&queue, NULL, GpsNavModelPedestrian);
    assert(g != NULL);

    furi_hal_mock_feed_string(GLL_VALID_LINE);
    gps_uart_process_rx(g);

    GpsStatus s = gps_uart_get_status(g);
    double expect_lat = 37.0 + 23.2475 / 60.0;
    double expect_lon = -(121.0 + 58.3416 / 60.0);
    printf("  lat=%.6f lon=%.6f (expect %.6f, %.6f)\n", s.latitude, s.longitude, expect_lat, expect_lon);
    assert(fabs(s.latitude - expect_lat) < 1e-5);
    assert(fabs(s.longitude - expect_lon) < 1e-5);

    gps_uart_free(g);
    printf("  -> Pass\n");
}

static void test_gll_ignored_when_invalid(void) {
    printf("Running test_gll_ignored_when_invalid...\n");
    FuriMessageQueue queue = {0};
    GpsUart* g = gps_uart_alloc(&queue, NULL, GpsNavModelPedestrian);
    assert(g != NULL);

    // Establish a known-good position first via GGA, then feed a
    // void-status GLL and confirm it does NOT clobber it.
    furi_hal_mock_feed_string(GGA_LINE);
    gps_uart_process_rx(g);
    GpsStatus before = gps_uart_get_status(g);

    furi_hal_mock_feed_string(GLL_INVALID_LINE);
    gps_uart_process_rx(g);
    GpsStatus after = gps_uart_get_status(g);

    printf("  lat before=%.7f after=%.7f (GLL status=V must not overwrite)\n",
           before.latitude, after.latitude);
    assert(fabs(after.latitude - before.latitude) < 1e-9);
    assert(fabs(after.longitude - before.longitude) < 1e-9);

    gps_uart_free(g);
    printf("  -> Pass\n");
}

// Bytes trickling in split across two ISR/process_rx cycles (the normal
// case on real hardware — process_rx drains whatever has arrived so far)
// must not be parsed until the terminating '\n' actually shows up.
static void test_split_line_buffering(void) {
    printf("Running test_split_line_buffering...\n");
    FuriMessageQueue queue = {0};
    GpsUart* g = gps_uart_alloc(&queue, NULL, GpsNavModelPedestrian);
    assert(g != NULL);

    size_t split = strlen(GGA_LINE) / 2;
    for(size_t i = 0; i < split; i++) furi_hal_mock_feed_byte((uint8_t)GGA_LINE[i]);
    gps_uart_process_rx(g);

    GpsStatus mid = gps_uart_get_status(g);
    assert(mid.fix_quality == 0); // nothing complete yet — line held in rx_buf

    for(size_t i = split; GGA_LINE[i]; i++) furi_hal_mock_feed_byte((uint8_t)GGA_LINE[i]);
    gps_uart_process_rx(g);

    GpsStatus done = gps_uart_get_status(g);
    assert(fabs(done.latitude - 51.5557397) < 1e-6);
    assert(done.fix_quality == 1);

    gps_uart_free(g);
    printf("  -> Pass\n");
}

// A run of bytes with no '\n' long enough to fill rx_buf (RX_LINE_BUF-1 =
// 1023 bytes) must trigger the "RX buffer full" reinit path in
// gps_uart_process_rx() — observed indirectly via TX activity, since
// reinit re-runs the full module configure() sequence.
static void test_rx_buffer_overflow_reconfigures(void) {
    printf("Running test_rx_buffer_overflow_reconfigures...\n");
    FuriMessageQueue queue = {0};
    GpsUart* g = gps_uart_alloc(&queue, NULL, GpsNavModelPedestrian);
    assert(g != NULL);
    furi_hal_mock_reset_tx_count();

    for(int i = 0; i < 1023; i++) furi_hal_mock_feed_byte('A');
    for(int i = 0; i < 8 && furi_hal_mock_tx_count() == 0; i++) {
        gps_uart_process_rx(g);
    }

    int tx_after_overflow = furi_hal_mock_tx_count();
    printf("  tx_count after 1023 bytes with no newline (chunked drains) = %d\n",
           tx_after_overflow);
    assert(tx_after_overflow > 0); // configure() re-ran
    assert(gps_uart_get_reinit_count(g) == 1); // real, measured — not just TX activity

    // Confirm the reinit left it in a working state, not just "did something".
    furi_hal_mock_feed_string(GGA_LINE);
    gps_uart_process_rx(g);
    GpsStatus s = gps_uart_get_status(g);
    assert(fabs(s.latitude - 51.5557397) < 1e-6);

    gps_uart_free(g);
    printf("  -> Pass\n");
}

// ── GPS chip ID capture (ubx_poll_chip_id(), M10Q only) ─────────────────
// gps_uart_get_chip_id()'s cache AND the "have we tried" gate
// (g_chip_id_poll_attempted) are both file-scope statics with no reset
// hook — deliberately: production behaviour is that the poll is attempted
// at MOST ONCE per process lifetime, success or failure, never retried on
// a later reinit (see ubx_poll_chip_id()'s doc comment for why — it used
// to retry on every RX-buffer-full/NMEA-watchdog reinit, which could
// block the main thread for seconds on a module that never answers
// cleanly). That one-shot-ever behaviour is exactly what this test needs
// to prove — which also means it's not just this function's own two
// phases that must stay ordered: ANY gps_uart_alloc() call anywhere in
// this binary, in ANY test, spends the one lifetime attempt. This test
// MUST run first in main(), before every other test that (like almost
// all of them) calls gps_uart_alloc() without arming a chip-id response —
// see the comment at its call site in main().
//
// The exact bytes here are ubx_poll_uniqid[] (the poll gps_uart.c actually
// sends) and hand-verified UBX-SEC-UNIQID response frames — class 0x27 id
// 0x03, 10-byte payload (version=0x02, reserved[3], then a 6-byte
// uniqueId), Fletcher-8 checksum computed the same way ubx_calc_checksum()
// does. furi_hal_mock_arm_response_for_tx() matches on the poll's exact
// bytes rather than "whichever TX comes next", since gps_uart_alloc() has
// already sent several unrelated packets (wake byte, baud switch, CFG-
// VALSET x4) by the time the poll itself goes out.
static const uint8_t k_uniqid_poll[] = {0xB5, 0x62, 0x27, 0x03, 0x00, 0x00, 0x2A, 0xA5};

static void test_chipid_capture(void) {
    printf("Running test_chipid_capture...\n");

    // Phase 1: the overall poll attempt FAILS — this is the scenario the
    // fix actually matters for. A corrupted response is queued for
    // attempt 1 (must be rejected); attempt 2 gets nothing armed and
    // times out on its own (bounded by iteration count, not wall clock —
    // see test_cfg_ack_timeout_is_bounded for the same property exercised
    // directly). Deliberately NOT testing "corrupted then a valid retry
    // succeeds" here: that scenario's overall outcome is success, and a
    // reverted, pre-fix version of ubx_poll_chip_id() (guarded only by
    // "stop once found") behaves IDENTICALLY to the fixed version whenever
    // the very first alloc's attempt happens to succeed — checked this by
    // literally reverting the fix in a scratch copy and confirming a
    // success-first test still passed. Only a FAILED first attempt can
    // tell the two behaviours apart, which is exactly what phase 2 below
    // does. (Checksum-rejection itself is unchanged code, already covered
    // by this phase, and the corrupted-then-valid-succeeds parse path is
    // unchanged from before this fix and was verified separately, both by
    // an earlier version of this test and on real hardware.)
    GpsUart* g;
    {
        static const uint8_t corrupted_response[] = {
            0xB5, 0x62, 0x27, 0x03, 0x0A, 0x00,             // header, len=10
            0x02, 0x00, 0x00, 0x00,                          // version, reserved
            0x11, 0x22, 0x33, 0x44, 0x55, 0x66,              // uniqueId
            0x9B, 0x8E,                                      // checksum: should be 9B 8D
        };
        FuriMessageQueue queue = {0};
        furi_hal_mock_arm_response_for_tx(
            k_uniqid_poll, sizeof(k_uniqid_poll),
            corrupted_response, sizeof(corrupted_response));
        g = gps_uart_alloc(&queue, NULL, GpsNavModelPedestrian);
        assert(g != NULL);

        printf("  phase 1: chip_id after corrupted response + timed-out retry = \"%s\" (expect empty)\n",
               gps_uart_get_chip_id(g));
        assert(gps_uart_get_chip_id(g)[0] == '\0');

        gps_uart_free(g);
    }

    // Phase 2: THE fix under test. A later gps_uart_alloc() (e.g. a mode
    // switch, or exactly what an RX-buffer-full/NMEA-watchdog reinit
    // does) must NOT retry the poll just because phase 1's attempt
    // failed. A valid response is queued for the same trigger; if the old
    // "stop once found" guard were still in place, this alloc WOULD poll
    // again (chip_id is still empty from phase 1) and it WOULD succeed,
    // setting chip_id to this phrase. It must not: chip_id staying empty
    // here is only possible if the poll never fired at all this time.
    {
        static const uint8_t valid_response[] = {
            0xB5, 0x62, 0x27, 0x03, 0x0A, 0x00,             // header, len=10
            0x02, 0x00, 0x00, 0x00,                          // version, reserved
            0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF,              // uniqueId
            0x31, 0x1A,                                      // valid checksum
        };
        FuriMessageQueue queue = {0};
        furi_hal_mock_arm_response_for_tx(
            k_uniqid_poll, sizeof(k_uniqid_poll),
            valid_response, sizeof(valid_response));
        g = gps_uart_alloc(&queue, NULL, GpsNavModelPedestrian);
        assert(g != NULL);

        printf("  phase 2: chip_id after a later alloc = \"%s\" (expect still empty, NOT \"baker mute aloha fable poet\")\n",
               gps_uart_get_chip_id(g));
        assert(gps_uart_get_chip_id(g)[0] == '\0');

        gps_uart_free(g);
    }

    printf("  -> Pass\n");
}

// No valid NMEA sentence for > 5 s (furi_kernel_get_tick_frequency() * 5
// ticks) must trigger the watchdog reinit path.
static void test_nmea_watchdog_reconfigures(void) {
    printf("Running test_nmea_watchdog_reconfigures...\n");
    FuriMessageQueue queue = {0};
    GpsUart* g = gps_uart_alloc(&queue, NULL, GpsNavModelPedestrian);
    assert(g != NULL);
    furi_hal_mock_reset_tx_count();

    furi_test_advance_tick(5001); // > 5000 ticks @ 1000 Hz shim frequency
    gps_uart_process_rx(g);       // no bytes queued — just runs the watchdog check

    int tx_after_watchdog = furi_hal_mock_tx_count();
    printf("  tx_count after 5.001s idle = %d\n", tx_after_watchdog);
    assert(tx_after_watchdog > 0); // configure() re-ran
    assert(gps_uart_get_reinit_count(g) == 1); // real, measured — not just TX activity

    gps_uart_free(g);
    printf("  -> Pass\n");
}

static void test_hot_start_sends_command(void) {
    printf("Running test_hot_start_sends_command...\n");
    FuriMessageQueue queue = {0};
    GpsUart* g = gps_uart_alloc(&queue, NULL, GpsNavModelPedestrian);
    assert(g != NULL);
    furi_hal_mock_reset_tx_count();

    gps_uart_send_hot_start(g);
    printf("  tx_count after hot start = %d\n", furi_hal_mock_tx_count());
    assert(furi_hal_mock_tx_count() > 0);

    gps_uart_free(g);
    printf("  -> Pass\n");
}

// Standalone standby — doesn't need a GpsUart at all, but does its own
// acquire/release of the same simulated USART1.
static void test_standby_acquires_and_releases(void) {
    printf("Running test_standby_acquires_and_releases...\n");
    assert(furi_hal_mock_acquire_count() == 0);
    gps_uart_standby();
    assert(furi_hal_mock_acquire_count() == 0); // acquired then released internally
    printf("  -> Pass\n");
}

// Unrecognised/garbage input must not crash and must not corrupt status —
// gps_uart_parse_line()'s dispatch switch defaults to a no-op.
static void test_malformed_line_ignored(void) {
    printf("Running test_malformed_line_ignored...\n");
    FuriMessageQueue queue = {0};
    GpsUart* g = gps_uart_alloc(&queue, NULL, GpsNavModelPedestrian);
    assert(g != NULL);

    furi_hal_mock_feed_string("this is not NMEA at all\r\n");
    furi_hal_mock_feed_string("$GPXYZ,1,2,3*00\r\n"); // well-formed but unknown sentence id
    gps_uart_process_rx(g);

    GpsStatus s = gps_uart_get_status(g);
    printf("  fix_quality=%d hdop=%.1f (both should be untouched defaults)\n",
           s.fix_quality, (double)s.hdop);
    assert(s.fix_quality == 0);
    assert(fabs((double)s.hdop - 99.9) < 1e-3);
    assert(isnan(s.latitude));

    gps_uart_free(g);
    printf("  -> Pass\n");
}

static void test_nav_model_allocation(void) {
    printf("Running test_nav_model_allocation...\n");
    FuriMessageQueue queue = {0};

    GpsNavModel models[] = {
        GpsNavModelPedestrian,
        GpsNavModelWrist,
        GpsNavModelVehicle,
        GpsNavModelStationary,
        GpsNavModelSea,
        GpsNavModelBike,
        GpsNavModelFlight
    };

    for(size_t i = 0; i < sizeof(models)/sizeof(models[0]); i++) {
        GpsUart* g = gps_uart_alloc(&queue, NULL, models[i]);
        assert(g != NULL);
        gps_uart_free(g);
    }

    printf("  -> Pass\n");
}

static void test_pubx_hacc_parsing(void) {
    printf("Running test_pubx_hacc_parsing...\n");
    FuriMessageQueue queue = {0};
    GpsUart* g = gps_uart_alloc(&queue, NULL, GpsNavModelPedestrian);
    assert(g != NULL);

    static const char* pubx_line =
        "$PUBX,00,081350.00,4717.113210,N,00833.915187,E,546.589,G3,2.4,2.0,0.007,77.52,0.007,,0.92,1.16,1.08,12,0,0*5D\r\n";
    furi_hal_mock_feed_string(pubx_line);
    gps_uart_process_rx(g);

    GpsStatus s = gps_uart_get_status(g);
    printf("  parsed hacc = %.1f m (expect 2.4 m)\n", (double)s.hacc);
    assert(fabs((double)s.hacc - 2.4) < 1e-3);

    gps_uart_free(g);
    printf("  -> Pass\n");
}

// ── Contention diagnostics (2026-07-31) — see docs/gps_rf_mutex_status.md ──

// A checksum/format failure must count; a well-formed sentence (even one
// PUBX doesn't act on data from) must not — nmea_fail_count is specifically
// a corruption proxy, not a count of "unhandled sentence types".
static void test_nmea_fail_counter(void) {
    printf("Running test_nmea_fail_counter...\n");
    FuriMessageQueue queue = {0};
    GpsUart* g = gps_uart_alloc(&queue, NULL, GpsNavModelPedestrian);
    assert(g != NULL);
    assert(gps_uart_get_nmea_fail_count(g) == 0);

    furi_hal_mock_feed_string("this is not NMEA at all\r\n");
    gps_uart_process_rx(g);
    printf("  fail count after garbage line = %u (expect 1)\n",
           (unsigned)gps_uart_get_nmea_fail_count(g));
    assert(gps_uart_get_nmea_fail_count(g) == 1);

    furi_hal_mock_feed_string(GGA_LINE); // well-formed, valid checksum
    gps_uart_process_rx(g);
    assert(gps_uart_get_nmea_fail_count(g) == 1); // unchanged

    gps_uart_free(g);
    printf("  -> Pass\n");
}

// Filling rx_stream (GPS_RX_BUF_SIZE bytes) without ever draining it via
// gps_uart_process_rx() must not silently lose data — every byte beyond
// capacity has to be counted. furi_hal_mock_feed_byte() calls the real ISR
// callback synchronously (see furi_hal_mock.c), so this exercises the exact
// gps_uart_irq_cb() code path a real overrun would hit.
static void test_rx_stream_drop_counter(void) {
    printf("Running test_rx_stream_drop_counter...\n");
    FuriMessageQueue queue = {0};
    GpsUart* g = gps_uart_alloc(&queue, NULL, GpsNavModelPedestrian);
    assert(g != NULL);
    assert(gps_uart_get_rx_drop_count(g) == 0);

    for(int i = 0; i < GPS_RX_BUF_SIZE; i++) furi_hal_mock_feed_byte('A');
    assert(gps_uart_get_rx_drop_count(g) == 0);

    furi_hal_mock_feed_byte('A'); // one byte past capacity
    printf("  drop count after 1 byte past capacity = %u (expect 1)\n",
           (unsigned)gps_uart_get_rx_drop_count(g));
    assert(gps_uart_get_rx_drop_count(g) == 1);

    furi_hal_mock_feed_byte('A');
    assert(gps_uart_get_rx_drop_count(g) == 2);

    gps_uart_free(g);
    printf("  -> Pass\n");
}

// Backlog should be drained across multiple process_rx() calls, not all in
// one monopolizing pass. Feed many malformed lines at once and verify the
// first call parses only a subset, with later calls finishing the rest.
static void test_rx_drain_is_chunked_not_monolithic(void) {
    printf("Running test_rx_drain_is_chunked_not_monolithic...\n");
    FuriMessageQueue queue = {0};
    GpsUart* g = gps_uart_alloc(&queue, NULL, GpsNavModelPedestrian);
    assert(g != NULL);

    enum { Lines = 30 };
    for(int i = 0; i < Lines; i++) {
        furi_hal_mock_feed_string("garbage line\r\n");
    }

    gps_uart_process_rx(g);
    uint32_t after_first = gps_uart_get_nmea_fail_count(g);
    printf("  nmea_fail after first drain = %u (expect partial, not all %d)\n",
           (unsigned)after_first, Lines);
    assert(after_first > 0);
    assert(after_first < Lines);

    for(int i = 0; i < 40 && gps_uart_get_nmea_fail_count(g) < Lines; i++) {
        gps_uart_process_rx(g);
    }
    uint32_t final = gps_uart_get_nmea_fail_count(g);
    printf("  nmea_fail after follow-up drains = %u (expect %d)\n",
           (unsigned)final, Lines);
    assert(final == Lines);

    gps_uart_free(g);
    printf("  -> Pass\n");
}

// Tighter host-side mock-up: drive the real gps_uart_process_rx() in a
// synthetic 10 Hz scheduler. Incoming UART load scales with the measured
// tick_dt (long tick => more bytes accrued before the app returns), and
// every 5th tick adds a heavy redraw cost. This couples redraw stalls to
// bigger UART drains on the next iterations, reproducing the same
// stall-and-catch-up shape seen on-device.
static void test_scheduler_mock_with_real_uart_drain_feedback(void) {
    printf("Running test_scheduler_mock_with_real_uart_drain_feedback...\n");

    FuriMessageQueue queue = {0};
    GpsUart* g = gps_uart_alloc(&queue, NULL, GpsNavModelPedestrian);
    assert(g != NULL);

    enum { SimTicks = 15 };
    uint32_t tick_dt_ms[SimTicks] = {0};
    uint32_t drained_lines[SimTicks] = {0};

    uint32_t now_ms = 0;
    uint32_t next_tick_due_ms = 100;
    uint32_t last_tick_start_ms = 0;

    for(int i = 0; i < SimTicks; i++) {
        if(now_ms < next_tick_due_ms) now_ms = next_tick_due_ms;

        uint32_t tick_start = now_ms;
        uint32_t dt = last_tick_start_ms ? (tick_start - last_tick_start_ms) : 0;
        tick_dt_ms[i] = dt;
        last_tick_start_ms = tick_start;

        // Input load model: two malformed lines per 100 ms of elapsed time.
        // A long dt therefore creates proportionally larger backlog.
        uint32_t lines_to_feed = (dt == 0) ? 2 : ((dt * 2 + 99) / 100);
        for(uint32_t n = 0; n < lines_to_feed; n++) {
            furi_hal_mock_feed_string("not nmea\r\n");
        }

        uint32_t before = gps_uart_get_nmea_fail_count(g);
        gps_uart_process_rx(g);
        uint32_t after = gps_uart_get_nmea_fail_count(g);
        drained_lines[i] = after - before;

        // Synthetic app-thread work budget: base per tick + cost per drained
        // line + heavy redraw every 5th tick (2 Hz at 10 Hz tick rate).
        uint32_t work_ms = 12 + drained_lines[i] * 18;
        if(((uint32_t)(i + 1) % 5) == 0) work_ms += 220;

        now_ms += work_ms;
        next_tick_due_ms += 100;
    }

    printf("  dt:");
    for(int i = 0; i < SimTicks; i++) printf(" %u", (unsigned)tick_dt_ms[i]);
    printf("\n  drained:");
    for(int i = 0; i < SimTicks; i++) printf(" %u", (unsigned)drained_lines[i]);
    printf("\n");

    // 2 Hz redraw produces a clear overrun burst at/after the 5th tick.
    assert(tick_dt_ms[5] >= 200);
    // Drain work should rise after the overrun because more input accrued.
    assert(drained_lines[5] > drained_lines[4]);
    // Post-overrun window should show at least two elevated dt values,
    // indicating a smeared disturbance rather than a single spike.
    int elevated = 0;
    for(int i = 5; i <= 8; i++) {
        if(tick_dt_ms[i] >= 120) elevated++;
    }
    assert(elevated >= 2);

    gps_uart_free(g);
    printf("  -> Pass\n");
}

int main(void) {
    // Must run before any other test: ubx_poll_chip_id() now attempts its
    // UBX-SEC-UNIQID poll at most ONCE per process, on the first
    // gps_uart_configure() call from ANY test's gps_uart_alloc() — not
    // just this one. Every other test below also calls gps_uart_alloc()
    // without arming a chip-id response, so if this ran anywhere else,
    // the one lifetime attempt would already be spent by the time it got
    // here and every assertion in it would silently fail against an
    // empty chip_id instead of testing what it claims to.
    test_chipid_capture();
    test_alloc_lifecycle();
    test_cfg_ack_timeout_is_bounded();
    test_gga_updates_status();
    test_rmc_updates_status();
    test_gsa_updates_status();
    test_gsa_sbas_detection();
    test_gsv_elevation_and_fresh();
    test_gsv_duplicate_within_window_not_doubled();
    test_gsv_multi_constellation_within_window_sums();
    test_gsv_recounts_after_window_reset();
    test_gll_updates_when_valid();
    test_gll_ignored_when_invalid();
    test_split_line_buffering();
    test_rx_buffer_overflow_reconfigures();
    test_nmea_watchdog_reconfigures();
    test_hot_start_sends_command();
    test_standby_acquires_and_releases();
    test_malformed_line_ignored();
    test_nav_model_allocation();
    test_pubx_hacc_parsing();
    test_nmea_fail_counter();
    test_rx_stream_drop_counter();
    test_rx_drain_is_chunked_not_monolithic();
    test_scheduler_mock_with_real_uart_drain_feedback();

    printf("\nAll gps_uart host tests passed successfully!\n");
    return 0;
}
