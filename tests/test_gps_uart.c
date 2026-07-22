// test_gps_uart.c — Host-side test for gps_uart.c's NMEA parsing and RX
// framing, run against the REAL production gps_uart.c (not a copy of its
// logic) — unmodified from what ships in the Flipper build. gps_uart.c
// calls the real Flipper SDK directly (furi_hal_serial_*, furi_mutex_*,
// furi_stream_buffer_*, ...); this test compiles it against tests/shims/
// (a minimal Furi-core + furi_hal shim, plus a fake USART1 peripheral in
// furi_hal_mock.c that lets us inject bytes as if they'd arrived from
// the ISR).
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
extern uint32_t furi_test_tick;
uint32_t furi_test_tick = 1;

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

static void test_alloc_lifecycle(void) {
    printf("Running test_alloc_lifecycle...\n");
    FuriMessageQueue queue = {0};
    assert(furi_hal_mock_acquire_count() == 0);

    GpsUart* g = gps_uart_alloc(&queue, NULL);
    assert(g != NULL);
    assert(gps_uart_is_ready(g));
    assert(furi_hal_mock_acquire_count() == 1);

    gps_uart_free(g);
    assert(furi_hal_mock_acquire_count() == 0);
    printf("  -> Pass\n");
}

static void test_gga_updates_status(void) {
    printf("Running test_gga_updates_status...\n");
    FuriMessageQueue queue = {0};
    GpsUart* g = gps_uart_alloc(&queue, NULL);
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
    GpsUart* g = gps_uart_alloc(&queue, NULL);
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

// Bytes trickling in split across two ISR/process_rx cycles (the normal
// case on real hardware — process_rx drains whatever has arrived so far)
// must not be parsed until the terminating '\n' actually shows up.
static void test_split_line_buffering(void) {
    printf("Running test_split_line_buffering...\n");
    FuriMessageQueue queue = {0};
    GpsUart* g = gps_uart_alloc(&queue, NULL);
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

int main(void) {
    test_alloc_lifecycle();
    test_gga_updates_status();
    test_rmc_updates_status();
    test_split_line_buffering();

    printf("\nAll gps_uart host tests passed successfully!\n");
    return 0;
}
