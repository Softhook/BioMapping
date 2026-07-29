// test_sd_logger.c — host tests for modules/sd_logger.c against the
// in-memory virtual filesystem in tests/shims/storage/storage.h +
// storage_mock.c. Drives the real, unmodified sd_logger_* functions —
// auto-incrementing file index, header write, and the GSR batch
// append/printf/flush path — the same code that runs on device.

#include <stdio.h>
#include <string.h>
#include <assert.h>

#include "sd_logger.h"

// Mirrors the internal gsr_batch[] size in sd_logger.c — used only to
// size this test's fill buffer, not linked against the struct itself
// (SdLogger is opaque to callers).
#define SD_LOGGER_BATCH_CAP 6144

// Storage for tests/shims/furi.h's furi_get_tick() shim — sd_logger.c now
// calls furi_get_tick() itself (write/sync latency instrumentation,
// 2026-07-29), same pattern already used in test_gps_uart.c/
// test_gsr_sensor.c. Fixed at 1 (never advanced): these tests don't
// exercise timing, just correctness, and the mock storage's read/write
// calls are effectively instantaneous, so every measured latency is 0
// regardless.
uint32_t furi_test_tick = 1;

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

static void test_sd_logger_batch_flush_failure_preserves_buffer_for_retry(void) {
    printf("Running test_sd_logger_batch_flush_failure_preserves_buffer_for_retry...\n");
    Storage* storage = storage_mock_alloc();
    SdLogger* l = sd_logger_alloc(storage);
    assert(sd_logger_start(l, "H\n"));

    assert(sd_logger_batch_append(l, "row1\n", 5));

    // Simulate a failed SD write (e.g. card briefly busy/full). The batch
    // must NOT be discarded -- a real regression here would silently drop
    // "row1\n" forever instead of leaving it for the next flush attempt.
    storage_mock_fail_writes(storage, true);
    assert(sd_logger_batch_flush(l) == -1);

    // A second append while still in the failed state must accumulate on
    // top of the preserved (not cleared) row1 bytes, not overwrite them.
    assert(sd_logger_batch_append(l, "row2\n", 5));

    // Recovery: the next successful flush must write BOTH rows -- proof
    // that row1 survived the earlier failed attempt instead of having been
    // silently zeroed out of the buffer.
    storage_mock_fail_writes(storage, false);
    int flushed = sd_logger_batch_flush(l);
    assert(flushed == 10);

    size_t len;
    const uint8_t* contents = storage_mock_get_file_contents(
        storage, "/ext/biomapping/biomap_001.csv", &len);
    assert(memcmp(contents, "H\nrow1\nrow2\n", len) == 0);

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

    size_t len;
    const uint8_t* contents = storage_mock_get_file_contents(
        storage, "/ext/biomapping/biomap_001.csv", &len);
    assert(len == strlen("H\nrow1\nrow2\n"));
    assert(memcmp(contents, "H\nrow1\nrow2\n", len) == 0);

    // Buffer is empty now -> flushing again is a no-op, not a zero-byte write.
    assert(sd_logger_batch_flush(l) == 0);

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

    // Fill the 4096-byte batch buffer to within 6 bytes of full.
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
    // internally rather than leaking the open file handle.
    sd_logger_free(l);

    storage_mock_free(storage);
    printf("  -> Pass\n");
}

int main(void) {
    printf("========================================\n");
    printf("SD LOGGER (auto-index / header / batch write)\n");
    printf("========================================\n");
    test_sd_logger_start_creates_file_with_header();
    test_sd_logger_start_finds_next_free_index();
    test_sd_logger_start_missing_directory_falls_back_to_index_1();
    test_sd_logger_start_wraps_at_max_index();
    test_sd_logger_start_fails_when_open_fails();
    test_sd_logger_start_fails_when_header_write_fails();
    test_sd_logger_stop_closes_file();
    test_sd_logger_batch_flush_failure_preserves_buffer_for_retry();
    test_sd_logger_batch_append_and_flush_writes_to_disk();
    test_sd_logger_batch_printf_writes_formatted_row();
    test_sd_logger_batch_printf_truncation_rolls_back();
    test_sd_logger_batch_append_overflow_rejected();
    test_sd_logger_free_while_active_stops_cleanly();

    printf("\nAll 13 sd_logger host tests passed successfully!\n");
    return 0;
}
