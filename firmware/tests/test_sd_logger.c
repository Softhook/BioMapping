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
#define SD_LOGGER_BATCH_CAP 24576

// Mirrors sd_logger.c's SD_LOGGER_PREALLOC_BYTES (BIOMAP_SD_PREALLOC,
// biomap_config.h — 2026-08-05, docs/gps_rf_mutex_status.md's "option E"
// entries). With pre-allocation on (the default), sd_logger_start() grows
// the mock file to real_data_len + this many bytes immediately, so any test
// that inspects file content/length BEFORE calling sd_logger_stop() (which
// trims the unused tail back down) must account for it: compare only the
// real-data PREFIX, not the file's full reported length.
#define SD_LOGGER_PREALLOC_BYTES (8u * 1024u * 1024u)

// Storage for tests/shims/furi.h's furi_get_tick() shim — sd_logger.c calls
// furi_get_tick() itself (flush_peak_ms write/sync latency instrumentation,
// 2026-08-03), same pattern already used in test_gps_uart.c/
// test_gsr_sensor.c. Left untouched (at 1) by every test except
// test_sd_logger_flush_peak_ms_detects_slow_flush, which advances it via
// storage_mock_set_next_write_delay_ticks() to simulate a slow SD write —
// every other test's measured latency is 0, since the mock storage's
// read/write calls are otherwise effectively instantaneous.
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
    // The header is still exactly the real-data prefix -- pre-allocation
    // only grows the file AFTER it, never touches already-written bytes.
    assert(memcmp(contents, "timestamp,lat,lon\n", strlen("timestamp,lat,lon\n")) == 0);
    // Pre-allocation (default on, BIOMAP_SD_PREALLOC) grows the file past
    // the header immediately, in sd_logger_start() -- this is the direct
    // proof it ran, not inferred from timing.
    assert(len == strlen("timestamp,lat,lon\n") + SD_LOGGER_PREALLOC_BYTES);

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

    // Stop first: with pre-allocation on (default, BIOMAP_SD_PREALLOC) the
    // file is grown past the real data at sd_logger_start() and only
    // trimmed back down at sd_logger_stop() -- checking exact content/
    // length before that would see the pre-allocated (undefined-content)
    // tail too, same as reading a real recording while it's still running.
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

    // Stop first so pre-allocation's tail (default on, BIOMAP_SD_PREALLOC)
    // is trimmed before checking exact content/length -- see the matching
    // comment in test_sd_logger_batch_flush_failure_preserves_buffer_for_retry.
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

    // Stop first so pre-allocation's tail (default on, BIOMAP_SD_PREALLOC)
    // is trimmed before checking exact content/length.
    sd_logger_stop(l);
    size_t len;
    const uint8_t* contents = storage_mock_get_file_contents(
        storage, "/ext/biomapping/biomap_001.csv", &len);
    assert(len == strlen("H\n1.50,42\n"));
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

    // Stop first so pre-allocation's tail (default on, BIOMAP_SD_PREALLOC)
    // is trimmed before checking exact content/length.
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

// 2026-08-03: tracks 116/117 (docs/gps_rf_mutex_status.md) showed real
// tick_dt_ms stalls landing exactly on the once-per-FLUSH_INTERVAL flush
// tick while gsr_sensor.c's i2c/rf_rssi/rf_retune peak columns stayed near
// zero — pointing at sd_logger_batch_flush() itself. This proves the new
// flush_peak_ms counter actually catches a slow flush, mirroring the
// three existing gsr_sensor.c peak_ms tests (tests/test_gsr_sensor.c).
static void test_sd_logger_flush_peak_ms_detects_slow_flush(void) {
    printf("Running test_sd_logger_flush_peak_ms_detects_slow_flush...\n");
    Storage* storage = storage_mock_alloc();
    SdLogger* l = sd_logger_alloc(storage);
    assert(sd_logger_start(l, "H\n"));
    assert(sd_logger_get_flush_peak_ms(l) == 0);

    assert(sd_logger_batch_append(l, "row1\n", 5));
    storage_mock_set_next_write_delay_ticks(storage, 150); // stand-in for a stuck SD write
    int flushed = sd_logger_batch_flush(l);
    assert(flushed == 5);
    assert(sd_logger_get_flush_peak_ms(l) == 150);

    // A second, fast flush must NOT lower the recorded peak — lifetime max,
    // never reset, same convention as gsr_sensor.h's peak_ms columns.
    assert(sd_logger_batch_append(l, "row2\n", 5));
    int flushed2 = sd_logger_batch_flush(l);
    assert(flushed2 == 5);
    assert(sd_logger_get_flush_peak_ms(l) == 150);

    sd_logger_free(l);
    storage_mock_free(storage);
    printf("  -> Pass\n");
}

static void test_sd_logger_continuity_counters_track_pressure(void) {
    printf("Running test_sd_logger_continuity_counters_track_pressure...\n");
    Storage* storage = storage_mock_alloc();
    SdLogger* l = sd_logger_alloc(storage);
    assert(sd_logger_start(l, "H\n"));

    assert(sd_logger_get_batch_fill_bytes(l) == 0);
    assert(sd_logger_get_batch_fill_peak_bytes(l) == 0);
    assert(sd_logger_get_overflow_count(l) == 0);
    assert(sd_logger_get_flush_fail_count(l) == 0);

    assert(sd_logger_batch_append(l, "abc\n", 4));
    assert(sd_logger_get_batch_fill_bytes(l) == 4);
    assert(sd_logger_get_batch_fill_peak_bytes(l) == 4);

    // Force an append overflow near buffer capacity.
    char filler[SD_LOGGER_BATCH_CAP - 4 - 2];
    memset(filler, 'x', sizeof(filler));
    assert(sd_logger_batch_append(l, filler, sizeof(filler)));
    assert(sd_logger_get_batch_fill_bytes(l) == (uint32_t)(4 + sizeof(filler)));
    assert(sd_logger_get_batch_fill_peak_bytes(l) == (uint32_t)(4 + sizeof(filler)));
    assert(!sd_logger_batch_append(l, "123", 3));
    assert(sd_logger_get_overflow_count(l) == 1);

    // Force a flush failure and verify the counter increments.
    storage_mock_fail_writes(storage, true);
    assert(sd_logger_batch_flush(l) == -1);
    assert(sd_logger_get_flush_fail_count(l) == 1);

    sd_logger_free(l);
    storage_mock_free(storage);
    printf("  -> Pass\n");
}

// 2026-08-05: BIOMAP_SD_PREALLOC (biomap_config.h) — the real, wired-in
// version of the standalone experiment in tests/test_sd_logger_prealloc.c.
// That file prototyped the seek+write+truncate mechanics in isolation;
// these tests prove sd_logger_start()/sd_logger_stop() actually use them
// correctly, end to end, through the real production code path — see
// docs/gps_rf_mutex_status.md's "option E" entries.
static void test_sd_logger_start_preallocates_file(void) {
    printf("Running test_sd_logger_start_preallocates_file...\n");
    Storage* storage = storage_mock_alloc();
    SdLogger* l = sd_logger_alloc(storage);
    assert(sd_logger_start(l, "H\n"));

    // Pre-allocation happens immediately in sd_logger_start(), not lazily
    // on first flush -- the whole point is paying the allocation cost once,
    // up front, before any time-critical batch write.
    size_t len;
    storage_mock_get_file_contents(storage, "/ext/biomapping/biomap_001.csv", &len);
    assert(len == strlen("H\n") + SD_LOGGER_PREALLOC_BYTES);

    sd_logger_free(l);
    storage_mock_free(storage);
    printf("  -> Pass\n");
}

static void test_sd_logger_stop_trims_preallocated_tail(void) {
    printf("Running test_sd_logger_stop_trims_preallocated_tail...\n");
    Storage* storage = storage_mock_alloc();
    SdLogger* l = sd_logger_alloc(storage);
    assert(sd_logger_start(l, "H\n"));
    assert(sd_logger_batch_append(l, "row1\n", 5));
    assert(sd_logger_batch_flush(l) == 5);

    sd_logger_stop(l);

    // The file must shrink back down to exactly the real data written --
    // proof the pre-allocated (undefined-content) tail was trimmed, not
    // shipped as a garbage-padded CSV. This is the exact drawback flagged
    // in docs/gps_rf_mutex_status.md's option E research: forgetting this
    // step silently pads every recording out to SD_LOGGER_PREALLOC_BYTES.
    size_t len;
    const uint8_t* contents = storage_mock_get_file_contents(
        storage, "/ext/biomapping/biomap_001.csv", &len);
    assert(len == strlen("H\nrow1\n"));
    assert(memcmp(contents, "H\nrow1\n", len) == 0);

    sd_logger_free(l);
    storage_mock_free(storage);
    printf("  -> Pass\n");
}

static void test_sd_logger_preallocation_does_not_corrupt_subsequent_writes(void) {
    printf("Running test_sd_logger_preallocation_does_not_corrupt_subsequent_writes...\n");
    Storage* storage = storage_mock_alloc();
    SdLogger* l = sd_logger_alloc(storage);
    assert(sd_logger_start(l, "H\n"));

    // Several flush cycles after the one-shot pre-allocation -- each must
    // land immediately after the previous one's real data, never inside or
    // past the pre-allocated (undefined-content) tail. This is the position-
    // rewind correctness property from the standalone experiment, now
    // proven against the real batch_append/batch_flush path.
    for(int i = 0; i < 5; i++) {
        assert(sd_logger_batch_append(l, "row\n", 4));
        assert(sd_logger_batch_flush(l) == 4);
    }
    sd_logger_stop(l);

    size_t len;
    const uint8_t* contents = storage_mock_get_file_contents(
        storage, "/ext/biomapping/biomap_001.csv", &len);
    assert(len == strlen("H\n") + 5 * 4);
    assert(memcmp(contents, "H\nrow\nrow\nrow\nrow\nrow\n", len) == 0);

    sd_logger_free(l);
    storage_mock_free(storage);
    printf("  -> Pass\n");
}

static void test_sd_logger_prealloc_ms_measures_seek_extend_cost(void) {
    printf("Running test_sd_logger_prealloc_ms_measures_seek_extend_cost...\n");
    Storage* storage = storage_mock_alloc();
    SdLogger* l = sd_logger_alloc(storage);
    assert(sd_logger_get_prealloc_ms(l) == 0); // nothing recorded before a session ever starts

    // Stand-in for real f_lseek()'s cluster-allocation cost on a real SD
    // card, same hook this project already uses for flush_peak_ms.
    storage_mock_set_next_seek_extend_delay_ticks(storage, 220);
    assert(sd_logger_start(l, "H\n"));
    assert(sd_logger_get_prealloc_ms(l) == 220);

    // A second session must re-measure, not keep the first session's value
    // around stale -- prealloc_ms is session-constant, not a lifetime max
    // like flush_peak_ms.
    sd_logger_stop(l);
    assert(sd_logger_start(l, "H\n"));
    assert(sd_logger_get_prealloc_ms(l) == 0); // no delay queued this time

    sd_logger_free(l);
    storage_mock_free(storage);
    printf("  -> Pass\n");
}

// Exercises preallocate_log_file()'s disk-full fallback branch
// (modules/sd_logger.c) -- a card too full to satisfy the full
// SD_LOGGER_PREALLOC_BYTES extension must not block recording from
// starting, or corrupt where subsequent writes land. Degrading to today's
// plain-append behavior is the correct fallback, not a hard failure.
static void test_sd_logger_preallocate_survives_disk_full(void) {
    printf("Running test_sd_logger_preallocate_survives_disk_full...\n");
    Storage* storage = storage_mock_alloc();
    // Room for the header but nowhere near SD_LOGGER_PREALLOC_BYTES ->
    // preallocate_log_file()'s storage_file_seek() call must return false
    // and hit the fallback branch.
    storage_mock_set_capacity_limit(storage, 4096);
    SdLogger* l = sd_logger_alloc(storage);

    assert(sd_logger_start(l, "H\n"));
    // The file must NOT have grown to the full pre-allocation size --
    // proof the fallback actually ran rather than silently ignoring the cap.
    size_t len_after_start;
    storage_mock_get_file_contents(storage, "/ext/biomapping/biomap_001.csv", &len_after_start);
    assert(len_after_start < SD_LOGGER_PREALLOC_BYTES);

    // Recording must still be fully functional: writes land contiguously
    // right after the header, same as if pre-allocation had never run.
    assert(sd_logger_batch_append(l, "row1\n", 5));
    assert(sd_logger_batch_flush(l) == 5);
    sd_logger_stop(l);

    size_t len;
    const uint8_t* contents = storage_mock_get_file_contents(
        storage, "/ext/biomapping/biomap_001.csv", &len);
    assert(len == strlen("H\nrow1\n"));
    assert(memcmp(contents, "H\nrow1\n", len) == 0);

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
    test_sd_logger_flush_peak_ms_detects_slow_flush();
    test_sd_logger_continuity_counters_track_pressure();
    test_sd_logger_start_preallocates_file();
    test_sd_logger_stop_trims_preallocated_tail();
    test_sd_logger_preallocation_does_not_corrupt_subsequent_writes();
    test_sd_logger_prealloc_ms_measures_seek_extend_cost();
    test_sd_logger_preallocate_survives_disk_full();
    test_sd_logger_free_while_active_stops_cleanly();

    printf("\nAll 21 sd_logger host tests passed successfully!\n");
    return 0;
}
