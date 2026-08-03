// test_sd_logger.c — host tests for modules/sd_logger.c against the
// in-memory virtual filesystem in tests/shims/storage/storage.h +
// storage_mock.c. Drives the real, unmodified sd_logger_* functions —
// auto-incrementing file index, header write, and the GSR batch
// append/printf/flush path — the same code that runs on device.
//
// 2026-08-03: sd_logger.c now runs its actual SD write/sync on a real
// background FuriThread (a genuine pthread under this harness, same as
// GsrSensor's worker — modules/gsr_sensor.c/tests/test_gsr_sensor.c), so
// several of these tests need a deterministic way to know the writer
// thread has actually finished a given write before checking the mock
// filesystem's contents. sd_logger_stop() is that point: it blocks until
// the writer has processed everything queued and closed the file, so
// tests call it before asserting file contents rather than checking
// right after sd_logger_batch_flush() (which now only hands a buffer off
// and returns immediately).

#include <stdio.h>
#include <string.h>
#include <assert.h>
#include <unistd.h>

#include "sd_logger.h"

// Mirrors the internal gsr_batch[] size in sd_logger.c — used only to
// size this test's fill buffer, not linked against the struct itself
// (SdLogger is opaque to callers).
#define SD_LOGGER_BATCH_CAP 12288

// Storage for tests/shims/furi.h's furi_get_tick() shim — sd_logger.c's
// writer thread calls furi_get_tick() again as of 2026-08-03
// (flush_dur_ms timing, sd_logger_get_flush_dur_ms()), same pattern
// test_gps_uart.c/test_gsr_sensor.c already use. Left untouched (at 1) by
// every test — the mock storage's write/sync calls are effectively
// instantaneous, so every measured duration is 0 regardless; no test here
// needs to inject a delay against the fake clock (storage_mock's own
// delay hook is a real usleep(), not a fake-tick advance — see
// storage_mock_set_next_write_delay_ms()).
_Atomic uint32_t furi_test_tick = 1;

static void test_sd_logger_start_creates_file_with_header(void) {
    printf("Running test_sd_logger_start_creates_file_with_header...\n");
    Storage* storage = storage_mock_alloc();
    SdLogger* l = sd_logger_alloc(storage);

    bool ok = sd_logger_start(l, "timestamp,lat,lon\n");
    assert(ok);
    assert(strcmp(sd_logger_get_filename(l), "biomap_001.csv") == 0);

    size_t len;
    const uint8_t* contents = storage_mock_get_file_contents(
        storage, "/ext/biomapping/biomap_001.csv", &len);
    assert(contents != NULL);
    assert(len == strlen("timestamp,lat,lon\n"));
    assert(memcmp(contents, "timestamp,lat,lon\n", len) == 0);

    sd_logger_free(l);
    storage_mock_free(storage);
    printf("  -> Pass\n");
}

static void test_sd_logger_start_finds_next_free_index(void) {
    printf("Running test_sd_logger_start_finds_next_free_index...\n");
    Storage* storage = storage_mock_alloc();
    storage_mock_touch_file(storage, "/ext/biomapping/biomap_001.csv");
    storage_mock_touch_file(storage, "/ext/biomapping/biomap_002.csv");
    storage_mock_touch_file(storage, "/ext/biomapping/biomap_005.csv");

    SdLogger* l = sd_logger_alloc(storage);
    bool ok = sd_logger_start(l, "H\n");
    assert(ok);
    // Picks max existing index + 1 (006), ignoring the 003/004 gap.
    assert(strcmp(sd_logger_get_filename(l), "biomap_006.csv") == 0);

    sd_logger_free(l);
    storage_mock_free(storage);
    printf("  -> Pass\n");
}

static void test_sd_logger_start_missing_directory_falls_back_to_index_1(void) {
    printf("Running test_sd_logger_start_missing_directory_falls_back_to_index_1...\n");
    Storage* storage = storage_mock_alloc();
    // Simulates the very first recording: the "biomapping" directory
    // doesn't exist yet, so storage_dir_open() itself fails (distinct
    // from the "directory exists but is empty" case).
    storage_mock_fail_next_dir_open(storage, true);

    SdLogger* l = sd_logger_alloc(storage);
    bool ok = sd_logger_start(l, "H\n");
    assert(ok);
    assert(strcmp(sd_logger_get_filename(l), "biomap_001.csv") == 0);

    sd_logger_free(l);
    storage_mock_free(storage);
    printf("  -> Pass\n");
}

static void test_sd_logger_start_wraps_at_max_index(void) {
    printf("Running test_sd_logger_start_wraps_at_max_index...\n");
    Storage* storage = storage_mock_alloc();
    storage_mock_touch_file(storage, "/ext/biomapping/biomap_999.csv");

    SdLogger* l = sd_logger_alloc(storage);
    bool ok = sd_logger_start(l, "H\n");
    assert(ok);
    // next_idx (1000) exceeds LOGGER_MAX_INDEX (999) -> wraps to 001.
    assert(strcmp(sd_logger_get_filename(l), "biomap_001.csv") == 0);

    sd_logger_free(l);
    storage_mock_free(storage);
    printf("  -> Pass\n");
}

static void test_sd_logger_start_fails_when_open_fails(void) {
    printf("Running test_sd_logger_start_fails_when_open_fails...\n");
    Storage* storage = storage_mock_alloc();
    storage_mock_fail_next_open(storage, true);   // simulates unmounted/full SD card

    SdLogger* l = sd_logger_alloc(storage);
    bool ok = sd_logger_start(l, "H\n");
    assert(!ok);
    assert(strcmp(sd_logger_get_filename(l), "") == 0);
    assert(!storage_mock_file_exists(storage, "/ext/biomapping/biomap_001.csv"));

    sd_logger_free(l);
    storage_mock_free(storage);
    printf("  -> Pass\n");
}

static void test_sd_logger_start_fails_when_header_write_fails(void) {
    printf("Running test_sd_logger_start_fails_when_header_write_fails...\n");
    Storage* storage = storage_mock_alloc();
    storage_mock_fail_writes(storage, true);

    SdLogger* l = sd_logger_alloc(storage);
    bool ok = sd_logger_start(l, "H\n");
    assert(!ok);
    // open_log_file() must clean up (close+free the file, clear filename)
    // on a failed header write rather than leaving a half-open logger.
    assert(strcmp(sd_logger_get_filename(l), "") == 0);

    sd_logger_free(l);
    storage_mock_free(storage);
    printf("  -> Pass\n");
}

static void test_sd_logger_stop_closes_file(void) {
    printf("Running test_sd_logger_stop_closes_file...\n");
    Storage* storage = storage_mock_alloc();
    SdLogger* l = sd_logger_alloc(storage);
    assert(sd_logger_start(l, "H\n"));

    sd_logger_stop(l);
    // A second start after stop must succeed and pick the next free index
    // (001 is already on "disk"), proving the logger returned to a clean
    // inactive state rather than staying wedged.
    bool ok = sd_logger_start(l, "H\n");
    assert(ok);
    assert(strcmp(sd_logger_get_filename(l), "biomap_002.csv") == 0);

    sd_logger_free(l);
    storage_mock_free(storage);
    printf("  -> Pass\n");
}

// 2026-08-03: the writer thread (modules/sd_logger.c) is created once in
// sd_logger_alloc() and destroyed once in sd_logger_free() — NOT
// recreated per recording, mirroring GsrSensor's worker thread
// (modules/gsr_sensor.c). Proves a second start/stop cycle on the SAME
// SdLogger, with no extra alloc/free in between, still writes each
// recording's data to the right file.
static void test_sd_logger_writer_thread_persists_across_recordings(void) {
    printf("Running test_sd_logger_writer_thread_persists_across_recordings...\n");
    Storage* storage = storage_mock_alloc();
    SdLogger* l = sd_logger_alloc(storage);

    assert(sd_logger_start(l, "H1\n"));
    assert(sd_logger_batch_append(l, "a\n", 2));
    assert(sd_logger_batch_flush(l) == 2);
    sd_logger_stop(l);

    assert(sd_logger_start(l, "H2\n"));
    assert(sd_logger_batch_append(l, "b\n", 2));
    assert(sd_logger_batch_flush(l) == 2);
    sd_logger_stop(l);

    size_t len;
    const uint8_t* c1 = storage_mock_get_file_contents(
        storage, "/ext/biomapping/biomap_001.csv", &len);
    assert(memcmp(c1, "H1\na\n", len) == 0);
    const uint8_t* c2 = storage_mock_get_file_contents(
        storage, "/ext/biomapping/biomap_002.csv", &len);
    assert(memcmp(c2, "H2\nb\n", len) == 0);

    sd_logger_free(l);
    storage_mock_free(storage);
    printf("  -> Pass\n");
}

// 2026-08-03: sd_logger_batch_flush() hands a buffer off to the writer
// thread and returns immediately — it no longer reports write/sync
// failure back to the caller (a deliberate simplification, see
// sd_logger.h's doc comment). This proves a failed write doesn't wedge
// the pipeline: the buffer involved still gets reclaimed (even though its
// data never reached the "disk"), and a subsequent recording works
// completely normally afterward.
static void test_sd_logger_failed_write_does_not_wedge_pipeline(void) {
    printf("Running test_sd_logger_failed_write_does_not_wedge_pipeline...\n");
    Storage* storage = storage_mock_alloc();
    SdLogger* l = sd_logger_alloc(storage);
    assert(sd_logger_start(l, "H\n"));

    assert(sd_logger_batch_append(l, "row1\n", 5));
    storage_mock_fail_writes(storage, true);
    int flushed = sd_logger_batch_flush(l);
    assert(flushed == 5); // bytes handed off -- not a durability guarantee any more

    // sd_logger_stop() blocks until the writer thread has processed
    // everything queued so far (including the failing write above) and
    // closed the file — nothing left in the batch buffer at this point,
    // so the close message itself has nothing to write and isn't
    // affected by fail_writes.
    sd_logger_stop(l);

    // "row1" never reached the mock's file — proves the write really
    // failed, not that fail_writes silently no-opped.
    size_t len;
    const uint8_t* contents = storage_mock_get_file_contents(
        storage, "/ext/biomapping/biomap_001.csv", &len);
    assert(memcmp(contents, "H\n", len) == 0);

    // Recovery: a new recording afterward must work completely normally —
    // proof the failed write didn't leave the writer thread wedged or the
    // SdLogger in a broken state.
    storage_mock_fail_writes(storage, false);
    assert(sd_logger_start(l, "H2\n"));
    assert(sd_logger_batch_append(l, "row2\n", 5));
    assert(sd_logger_batch_flush(l) == 5);
    sd_logger_stop(l);

    const uint8_t* contents2 = storage_mock_get_file_contents(
        storage, "/ext/biomapping/biomap_002.csv", &len);
    assert(memcmp(contents2, "H2\nrow2\n", len) == 0);

    sd_logger_free(l);
    storage_mock_free(storage);
    printf("  -> Pass\n");
}

// 2026-08-03: double-buffering means sd_logger_batch_flush() must skip
// (not block on) a flush if the writer thread hasn't finished with the
// OTHER buffer yet — see sd_logger.c's file banner. Uses a real usleep()
// delay (storage_mock_set_next_write_delay_ms(), tests/shims/storage_mock.c)
// so the writer thread is genuinely still busy in real wall-clock time
// when the test's main thread tries to flush again immediately after.
static void test_sd_logger_flush_skipped_while_writer_busy_then_recovers(void) {
    printf("Running test_sd_logger_flush_skipped_while_writer_busy_then_recovers...\n");
    Storage* storage = storage_mock_alloc();
    SdLogger* l = sd_logger_alloc(storage);
    assert(sd_logger_start(l, "H\n"));

    assert(sd_logger_batch_append(l, "row1\n", 5));
    storage_mock_set_next_write_delay_ms(storage, 100); // stand-in for a stuck SD write
    int flushed1 = sd_logger_batch_flush(l);
    assert(flushed1 == 5); // handed off; writer thread is now busy for ~100ms real time

    // Immediately flush again, well before the writer could possibly be
    // done — the other buffer isn't free yet, so this must be skipped
    // (0), not block the caller.
    assert(sd_logger_batch_append(l, "row2\n", 5));
    int flushed2 = sd_logger_batch_flush(l);
    assert(flushed2 == 0); // skipped -- row2 stays in the buffer, untouched

    // Give the writer thread's delayed write real time to finish.
    usleep(150 * 1000);

    // Same data, retried: now succeeds, since the writer caught up and
    // freed the other buffer.
    int flushed3 = sd_logger_batch_flush(l);
    assert(flushed3 == 5);

    sd_logger_stop(l);
    size_t len;
    const uint8_t* contents = storage_mock_get_file_contents(
        storage, "/ext/biomapping/biomap_001.csv", &len);
    assert(memcmp(contents, "H\nrow1\nrow2\n", len) == 0);

    sd_logger_free(l);
    storage_mock_free(storage);
    printf("  -> Pass\n");
}

// Polls sd_logger_get_flush_dur_ms() until it reaches `target`, instead of
// trusting "storage_mock_write_in_progress() went false" as proof the
// result is ready to read. Those are NOT the same moment: the mock flips
// write_in_progress false as its very last step before returning, but the
// writer thread's surrounding code still has to compute the duration and
// publish it into flush_dur_ms afterward — a real, if normally
// nanoseconds-wide, gap. Mirrors test_gsr_sensor.c's
// wait_for_peak_ms_at_least (same reasoning, same fix).
static void wait_for_flush_dur_ms_at_least(SdLogger* l, uint32_t target) {
    int waited_us = 0;
    while(sd_logger_get_flush_dur_ms(l) < target) {
        usleep(200);
        waited_us += 200;
        if(waited_us > 5000000) {
            fprintf(stderr, "TIMEOUT: flush_dur_ms never reached %u\n", (unsigned)target);
            assert(false);
        }
    }
}

// 2026-08-03: flush_dur_ms is the on-device signal for "is the SD card
// still occasionally stalling, just now invisibly off the main thread" —
// see sd_logger_get_flush_dur_ms()'s doc comment (sd_logger.h). Proves the
// writer thread actually times its own write+sync and publishes the
// result, using the same call-in-progress + fake-tick-advance pattern
// test_gsr_sensor.c's peak_ms tests already use (storage_mock_write_in_progress()
// mirrors furi_hal_i2c_mock_call_in_progress()).
static void test_sd_logger_flush_dur_ms_detects_slow_write(void) {
    printf("Running test_sd_logger_flush_dur_ms_detects_slow_write...\n");
    Storage* storage = storage_mock_alloc();
    SdLogger* l = sd_logger_alloc(storage);
    assert(sd_logger_start(l, "H\n"));
    assert(sd_logger_get_flush_dur_ms(l) == 0);

    assert(sd_logger_batch_append(l, "row1\n", 5));
    storage_mock_set_next_write_delay_ms(storage, 150); // stand-in for a stuck SD write
    int flushed = sd_logger_batch_flush(l);
    assert(flushed == 5);

    int waited_us = 0;
    while(!storage_mock_write_in_progress(storage)) {
        usleep(200);
        waited_us += 200;
        if(waited_us > 5000000) { fprintf(stderr, "TIMEOUT waiting for write to start\n"); assert(false); }
    }
    furi_test_advance_tick(150); // simulate 150ms of device time elapsing during the stall

    waited_us = 0;
    while(storage_mock_write_in_progress(storage)) {
        usleep(200);
        waited_us += 200;
        if(waited_us > 5000000) { fprintf(stderr, "TIMEOUT waiting for write to finish\n"); assert(false); }
    }
    wait_for_flush_dur_ms_at_least(l, 150);
    assert(sd_logger_get_flush_dur_ms(l) == 150);

    // A second, fast flush must NOT lower the recorded value — lifetime
    // max, never reset, same convention as gsr_sensor.h's peak_ms columns.
    assert(sd_logger_batch_append(l, "row2\n", 5));
    assert(sd_logger_batch_flush(l) == 5);
    sd_logger_stop(l);
    assert(sd_logger_get_flush_dur_ms(l) == 150);

    sd_logger_free(l);
    storage_mock_free(storage);
    printf("  -> Pass\n");
}

static void test_sd_logger_batch_append_and_flush_writes_to_disk(void) {
    printf("Running test_sd_logger_batch_append_and_flush_writes_to_disk...\n");
    Storage* storage = storage_mock_alloc();
    SdLogger* l = sd_logger_alloc(storage);
    assert(sd_logger_start(l, "H\n"));

    assert(sd_logger_batch_append(l, "row1\n", 5));
    assert(sd_logger_batch_append(l, "row2\n", 5));

    int flushed = sd_logger_batch_flush(l);
    assert(flushed == 10);

    // Buffer is empty now -> flushing again is a no-op, not a zero-byte write.
    assert(sd_logger_batch_flush(l) == 0);

    // sd_logger_stop() blocks until the writer thread has actually
    // performed the write+sync and closed the file — the deterministic
    // wait point these tests use now that batch_flush() hands off to a
    // background thread instead of writing synchronously (see this
    // file's banner comment).
    sd_logger_stop(l);

    size_t len;
    const uint8_t* contents = storage_mock_get_file_contents(
        storage, "/ext/biomapping/biomap_001.csv", &len);
    assert(len == strlen("H\nrow1\nrow2\n"));
    assert(memcmp(contents, "H\nrow1\nrow2\n", len) == 0);

    sd_logger_free(l);
    storage_mock_free(storage);
    printf("  -> Pass\n");
}

static void test_sd_logger_batch_printf_writes_formatted_row(void) {
    printf("Running test_sd_logger_batch_printf_writes_formatted_row...\n");
    Storage* storage = storage_mock_alloc();
    SdLogger* l = sd_logger_alloc(storage);
    assert(sd_logger_start(l, "H\n"));

    int n = sd_logger_batch_printf(l, "%.2f,%d\n", 1.5, 42);
    assert(n == (int)strlen("1.50,42\n"));

    assert(sd_logger_batch_flush(l) == n);
    sd_logger_stop(l);

    size_t len;
    const uint8_t* contents = storage_mock_get_file_contents(
        storage, "/ext/biomapping/biomap_001.csv", &len);
    assert(memcmp(contents, "H\n1.50,42\n", len) == 0);

    sd_logger_free(l);
    storage_mock_free(storage);
    printf("  -> Pass\n");
}

static void test_sd_logger_batch_printf_truncation_rolls_back(void) {
    printf("Running test_sd_logger_batch_printf_truncation_rolls_back...\n");
    Storage* storage = storage_mock_alloc();
    SdLogger* l = sd_logger_alloc(storage);
    assert(sd_logger_start(l, "H\n"));

    // Fill the batch buffer to within 6 bytes of full.
    char filler[SD_LOGGER_BATCH_CAP - 6];
    memset(filler, 'x', sizeof(filler));
    assert(sd_logger_batch_append(l, filler, sizeof(filler)));

    // "123456\n" needs 7 bytes + NUL, but only 6 bytes remain -> vsnprintf
    // would truncate. sd_logger_batch_printf must reject the whole row
    // (return 0) and roll gsr_batch_len back rather than advance it into
    // the truncated bytes vsnprintf scribbled into the tail.
    int n = sd_logger_batch_printf(l, "%d\n", 123456);
    assert(n == 0);

    // Flushing now must write exactly the filler bytes — nothing from the
    // rejected row — proving the internal length pointer never advanced.
    int flushed = sd_logger_batch_flush(l);
    assert(flushed == (int)sizeof(filler));
    sd_logger_stop(l);

    size_t len;
    const uint8_t* contents = storage_mock_get_file_contents(
        storage, "/ext/biomapping/biomap_001.csv", &len);
    assert(len == strlen("H\n") + sizeof(filler));
    assert(memcmp(contents + strlen("H\n"), filler, sizeof(filler)) == 0);

    sd_logger_free(l);
    storage_mock_free(storage);
    printf("  -> Pass\n");
}

static void test_sd_logger_batch_append_overflow_rejected(void) {
    printf("Running test_sd_logger_batch_append_overflow_rejected...\n");
    Storage* storage = storage_mock_alloc();
    SdLogger* l = sd_logger_alloc(storage);
    assert(sd_logger_start(l, "H\n"));

    char filler[SD_LOGGER_BATCH_CAP - 6];
    memset(filler, 'x', sizeof(filler));
    assert(sd_logger_batch_append(l, filler, sizeof(filler)));

    // 7 bytes don't fit in the remaining 6 -> must be rejected outright,
    // not partially copied.
    assert(!sd_logger_batch_append(l, "1234567", 7));

    int flushed = sd_logger_batch_flush(l);
    assert(flushed == (int)sizeof(filler));   // only the filler, nothing partial

    sd_logger_free(l);
    storage_mock_free(storage);
    printf("  -> Pass\n");
}

static void test_sd_logger_free_while_active_stops_cleanly(void) {
    printf("Running test_sd_logger_free_while_active_stops_cleanly...\n");
    Storage* storage = storage_mock_alloc();
    SdLogger* l = sd_logger_alloc(storage);
    assert(sd_logger_start(l, "H\n"));
    assert(sd_logger_batch_append(l, "row\n", 4));

    // sd_logger_free() on a still-active logger must call sd_logger_stop()
    // internally rather than leaking the open file handle or the writer
    // thread.
    sd_logger_free(l);

    storage_mock_free(storage);
    printf("  -> Pass\n");
}

int main(void) {
    printf("========================================\n");
    printf("SD LOGGER (auto-index / header / batch write / writer thread)\n");
    printf("========================================\n");
    test_sd_logger_start_creates_file_with_header();
    test_sd_logger_start_finds_next_free_index();
    test_sd_logger_start_missing_directory_falls_back_to_index_1();
    test_sd_logger_start_wraps_at_max_index();
    test_sd_logger_start_fails_when_open_fails();
    test_sd_logger_start_fails_when_header_write_fails();
    test_sd_logger_stop_closes_file();
    test_sd_logger_writer_thread_persists_across_recordings();
    test_sd_logger_failed_write_does_not_wedge_pipeline();
    test_sd_logger_flush_skipped_while_writer_busy_then_recovers();
    test_sd_logger_flush_dur_ms_detects_slow_write();
    test_sd_logger_batch_append_and_flush_writes_to_disk();
    test_sd_logger_batch_printf_writes_formatted_row();
    test_sd_logger_batch_printf_truncation_rolls_back();
    test_sd_logger_batch_append_overflow_rejected();
    test_sd_logger_free_while_active_stops_cleanly();

    printf("\nAll 16 sd_logger host tests passed successfully!\n");
    return 0;
}
