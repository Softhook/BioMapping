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
// biomap_config.h — 2026-08-05, docs/archive/gps_rf_mutex_status.md's "option E"
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

// Mirrors sd_logger.c's SD_LOGGER_INTEGRITY_LINE — every file now opens with
// this marker line and closes with a "# End …" trailer (sd_logger_stop).
// Tests that assert on exact row content use data_region() below to look at
// just the bytes between the two.
#define INTEGRITY_LINE "# Integrity: crc32 v1\n"

// Reference CRC32 (reflected, poly 0xEDB88320) — an independent copy of the
// algorithm in sd_logger.c / em_scan_cal.c, so the trailer tests verify the
// logger's checksum against a separate implementation rather than itself.
static uint32_t crc32_ref(const uint8_t* data, size_t len) {
    uint32_t crc = 0xFFFFFFFFu;
    for(size_t i = 0; i < len; i++) {
        crc ^= data[i];
        for(int bit = 0; bit < 8; bit++) {
            crc = (crc >> 1) ^ (0xEDB88320u & (uint32_t)(-(int32_t)(crc & 1u)));
        }
    }
    return ~crc;
}

// The data region of a stopped file: everything after the "# Integrity:"
// marker line, up to (not including) the "\n# End " that starts the
// trailer. This is exactly the byte span the trailer's crc32/bytes cover.
static const uint8_t* data_region(const uint8_t* contents, size_t len, size_t* out_len) {
    assert(contents != NULL);
    assert(len > strlen(INTEGRITY_LINE));
    assert(memcmp(contents, INTEGRITY_LINE, strlen(INTEGRITY_LINE)) == 0);
    const uint8_t* start = contents + strlen(INTEGRITY_LINE);

    const char* marker = "\n# End ";
    const uint8_t* p = NULL;
    for(size_t i = strlen(INTEGRITY_LINE); i + strlen(marker) <= len; i++) {
        if(memcmp(contents + i, marker, strlen(marker)) == 0) { p = contents + i; break; }
    }
    assert(p != NULL); // a stopped file always has a trailer
    *out_len = (size_t)(p + 1 - start); // include the '\n' that ends the last row
    return start;
}

// Length of the full CRC-covered region of a stopped file: from byte 0
// (the "# Integrity:" marker) up to and including the '\n' that ends the
// last row — exactly what the trailer's crc32/bytes describe.
static size_t crc_region_len(const uint8_t* contents, size_t len) {
    const char* marker = "\n# End ";
    for(size_t i = 0; i + strlen(marker) <= len; i++) {
        if(memcmp(contents + i, marker, strlen(marker)) == 0) return i + 1;
    }
    assert(0 && "stopped file has no trailer");
    return 0;
}

// Locate the "# End …" trailer line and return it NUL-terminated in `out`
// (without the trailing '\n'). Asserts the file has one.
static void get_trailer(const uint8_t* contents, size_t len, char* out, size_t out_cap) {
    const char* marker = "\n# End ";
    const uint8_t* p = NULL;
    for(size_t i = 0; i + strlen(marker) <= len; i++) {
        if(memcmp(contents + i, marker, strlen(marker)) == 0) { p = contents + i + 1; break; }
    }
    assert(p != NULL);
    size_t tlen = (size_t)(contents + len - p);
    if(tlen > 0 && p[tlen - 1] == '\n') tlen--;
    assert(tlen < out_cap);
    memcpy(out, p, tlen);
    out[tlen] = '\0';
}

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
    assert(memcmp(contents, INTEGRITY_LINE "timestamp,lat,lon\n",
                  strlen(INTEGRITY_LINE "timestamp,lat,lon\n")) == 0);
    // Pre-allocation (default on, BIOMAP_SD_PREALLOC) grows the file past
    // the header immediately, in sd_logger_start() -- this is the direct
    // proof it ran, not inferred from timing.
    assert(len == strlen(INTEGRITY_LINE "timestamp,lat,lon\n") + SD_LOGGER_PREALLOC_BYTES);

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

    sd_logger_stop(l, 0);
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
    sd_logger_stop(l, 0);
    size_t len;
    const uint8_t* contents = storage_mock_get_file_contents(
        storage, "/ext/biomapping/biomap_001.csv", &len);
    size_t dlen;
    const uint8_t* d = data_region(contents, len, &dlen);
    assert(dlen == strlen("H\nrow1\nrow2\n"));
    assert(memcmp(d, "H\nrow1\nrow2\n", dlen) == 0);

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
    sd_logger_stop(l, 0);
    size_t len;
    const uint8_t* contents = storage_mock_get_file_contents(
        storage, "/ext/biomapping/biomap_001.csv", &len);
    size_t dlen;
    const uint8_t* d = data_region(contents, len, &dlen);
    assert(dlen == strlen("H\nrow1\nrow2\n"));
    assert(memcmp(d, "H\nrow1\nrow2\n", dlen) == 0);

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
    sd_logger_stop(l, 0);
    size_t len;
    const uint8_t* contents = storage_mock_get_file_contents(
        storage, "/ext/biomapping/biomap_001.csv", &len);
    size_t dlen;
    const uint8_t* d = data_region(contents, len, &dlen);
    assert(dlen == strlen("H\n1.50,42\n"));
    assert(memcmp(d, "H\n1.50,42\n", dlen) == 0);

    sd_logger_free(l);
    storage_mock_free(storage);
    printf("  -> Pass\n");
}

static void test_sd_logger_batch_printf_truncation_rolls_back(void) {
    printf("Running test_sd_logger_batch_printf_truncation_rolls_back...\n");
    Storage* storage = storage_mock_alloc();
    SdLogger* l = sd_logger_alloc(storage);
    assert(sd_logger_start(l, "H\n"));

    // Fill the batch buffer to within 6 bytes of full. Newline-terminate
    // the filler so the file's last data byte is a '\n' and sd_logger_stop()
    // doesn't need to insert a normalising separator before the trailer
    // (that path has its own test).
    char filler[SD_LOGGER_BATCH_CAP - 6];
    memset(filler, 'x', sizeof(filler));
    filler[sizeof(filler) - 1] = '\n';
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
    sd_logger_stop(l, 0);
    size_t len;
    const uint8_t* contents = storage_mock_get_file_contents(
        storage, "/ext/biomapping/biomap_001.csv", &len);
    size_t dlen;
    const uint8_t* d = data_region(contents, len, &dlen);
    assert(dlen == strlen("H\n") + sizeof(filler));
    assert(memcmp(d + strlen("H\n"), filler, sizeof(filler)) == 0);

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

// 2026-08-03: tracks 116/117 (docs/archive/gps_rf_mutex_status.md) showed real
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

// BIOMAP_SD_PREALLOC (biomap_config.h): the seek+write+truncate log-file
// pre-allocation. These tests prove sd_logger_start()/sd_logger_stop()
// use it correctly, end to end, through the real production code path —
// see docs/archive/gps_rf_mutex_status.md's "option E" entries.
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
    assert(len == strlen(INTEGRITY_LINE "H\n") + SD_LOGGER_PREALLOC_BYTES);

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

    sd_logger_stop(l, 0);

    // The file must shrink back down to exactly the real data written --
    // proof the pre-allocated (undefined-content) tail was trimmed, not
    // shipped as a garbage-padded CSV. This is the exact drawback flagged
    // in docs/archive/gps_rf_mutex_status.md's option E research: forgetting this
    // step silently pads every recording out to SD_LOGGER_PREALLOC_BYTES.
    size_t len;
    const uint8_t* contents = storage_mock_get_file_contents(
        storage, "/ext/biomapping/biomap_001.csv", &len);
    size_t dlen;
    const uint8_t* d = data_region(contents, len, &dlen);
    assert(dlen == strlen("H\nrow1\n"));
    assert(memcmp(d, "H\nrow1\n", dlen) == 0);

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
    sd_logger_stop(l, 0);

    size_t len;
    const uint8_t* contents = storage_mock_get_file_contents(
        storage, "/ext/biomapping/biomap_001.csv", &len);
    size_t dlen;
    const uint8_t* d = data_region(contents, len, &dlen);
    assert(dlen == strlen("H\nrow\nrow\nrow\nrow\nrow\n"));
    assert(memcmp(d, "H\nrow\nrow\nrow\nrow\nrow\n", dlen) == 0);

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
    sd_logger_stop(l, 0);
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
    sd_logger_stop(l, 0);

    size_t len;
    const uint8_t* contents = storage_mock_get_file_contents(
        storage, "/ext/biomapping/biomap_001.csv", &len);
    size_t dlen;
    const uint8_t* d = data_region(contents, len, &dlen);
    assert(dlen == strlen("H\nrow1\n"));
    assert(memcmp(d, "H\nrow1\n", dlen) == 0);

    sd_logger_free(l);
    storage_mock_free(storage);
    printf("  -> Pass\n");
}

// The "# End" trailer must report a row count and a CRC32 that an
// independent implementation agrees with over the exact data_region()
// span, plus the end_time passed to sd_logger_stop() and zeroed
// continuity counters for a clean run.
static void test_sd_logger_trailer_matches_data(void) {
    printf("Running test_sd_logger_trailer_matches_data...\n");
    Storage* storage = storage_mock_alloc();
    SdLogger* l = sd_logger_alloc(storage);
    assert(sd_logger_start(l, "timestamp,gsr_raw\n"));

    assert(sd_logger_batch_printf(l, "%lu,%d\n", 0UL, 100) > 0);
    assert(sd_logger_batch_printf(l, "%lu,%d\n", 1UL, 101) > 0);
    assert(sd_logger_batch_flush(l) > 0);
    assert(sd_logger_batch_printf(l, "%lu,%d\n", 2UL, 102) > 0);

    sd_logger_stop(l, 1000000000UL);

    size_t len;
    const uint8_t* contents = storage_mock_get_file_contents(
        storage, "/ext/biomapping/biomap_001.csv", &len);
    size_t rlen = crc_region_len(contents, len);

    char trailer[192];
    get_trailer(contents, len, trailer, sizeof(trailer));

    unsigned long rows = 0, bytes = 0, crc = 0, endt = 0, ovf = 99, ff = 99;
    int matched = sscanf(trailer,
        "# End rows:%lu bytes:%lu crc32:%lx end_time:%lu overflows:%lu flush_fails:%lu",
        &rows, &bytes, &crc, &endt, &ovf, &ff);
    assert(matched == 6);
    assert(rows == 3);
    assert(bytes == rlen);
    assert(crc == crc32_ref(contents, rlen));
    assert(endt == 1000000000UL);
    assert(ovf == 0);
    assert(ff == 0);

    sd_logger_free(l);
    storage_mock_free(storage);
    printf("  -> Pass\n");
}

// end_epoch == 0 (RTC unset / teardown path) must drop the end_time token
// entirely rather than emit a misleading "end_time:0".
static void test_sd_logger_trailer_omits_end_time_when_epoch_zero(void) {
    printf("Running test_sd_logger_trailer_omits_end_time_when_epoch_zero...\n");
    Storage* storage = storage_mock_alloc();
    SdLogger* l = sd_logger_alloc(storage);
    assert(sd_logger_start(l, "H\n"));
    assert(sd_logger_batch_append(l, "row1\n", 5));
    assert(sd_logger_batch_flush(l) == 5);

    sd_logger_stop(l, 0);

    size_t len;
    const uint8_t* contents = storage_mock_get_file_contents(
        storage, "/ext/biomapping/biomap_001.csv", &len);
    char trailer[192];
    get_trailer(contents, len, trailer, sizeof(trailer));

    assert(strstr(trailer, "end_time:") == NULL);
    unsigned long rows = 0, bytes = 0, crc = 0, ovf = 99, ff = 99;
    int matched = sscanf(trailer,
        "# End rows:%lu bytes:%lu crc32:%lx overflows:%lu flush_fails:%lu",
        &rows, &bytes, &crc, &ovf, &ff);
    assert(matched == 5);
    assert(rows == 1);

    sd_logger_free(l);
    storage_mock_free(storage);
    printf("  -> Pass\n");
}

// A flush that failed mid-recording (even if a later flush recovered) must
// be visible in the trailer's flush_fails counter — the whole point of
// putting the continuity counters there is that a re-import can flag a
// file that hit SD pressure.
static void test_sd_logger_trailer_reports_flush_fails(void) {
    printf("Running test_sd_logger_trailer_reports_flush_fails...\n");
    Storage* storage = storage_mock_alloc();
    SdLogger* l = sd_logger_alloc(storage);
    assert(sd_logger_start(l, "H\n"));

    assert(sd_logger_batch_append(l, "row1\n", 5));
    storage_mock_fail_writes(storage, true);
    assert(sd_logger_batch_flush(l) == -1);
    storage_mock_fail_writes(storage, false);
    assert(sd_logger_batch_flush(l) == 5);

    sd_logger_stop(l, 0);

    size_t len;
    const uint8_t* contents = storage_mock_get_file_contents(
        storage, "/ext/biomapping/biomap_001.csv", &len);
    char trailer[192];
    get_trailer(contents, len, trailer, sizeof(trailer));

    assert(strstr(trailer, "flush_fails:1") != NULL);
    // The one row still made it (on the recovering flush), so the CRC must
    // still describe the file correctly.
    size_t rlen = crc_region_len(contents, len);
    size_t dlen;
    const uint8_t* d = data_region(contents, len, &dlen);
    unsigned long crc = 0;
    assert(sscanf(strstr(trailer, "crc32:"), "crc32:%lx", &crc) == 1);
    assert(crc == crc32_ref(contents, rlen));
    assert(dlen == strlen("H\nrow1\n"));
    assert(memcmp(d, "H\nrow1\n", dlen) == 0);

    sd_logger_free(l);
    storage_mock_free(storage);
    printf("  -> Pass\n");
}

// A partial write (card dies mid-transfer) must leave the buffer holding
// ONLY the bytes that didn't reach the card — never re-write the prefix on
// the retry. Regression target: without the partial-write handling in
// sd_logger_batch_flush(), the retry re-writes the whole batch and the file
// ends up with a duplicated prefix + a trailer whose crc32/bytes no longer
// match, which a re-import reads as tampered-with rather than "hit SD
// pressure".
static void test_sd_logger_partial_write_keeps_only_unwritten_tail(void) {
    printf("Running test_sd_logger_partial_write_keeps_only_unwritten_tail...\n");
    Storage* storage = storage_mock_alloc();
    SdLogger* l = sd_logger_alloc(storage);
    assert(sd_logger_start(l, "H\n"));

    assert(sd_logger_batch_append(l, "row1\n", 5));
    assert(sd_logger_batch_append(l, "row2\n", 5));

    // Next write stops 6 bytes in — "row1\nr" reaches the card, "ow2\n" does not.
    storage_mock_set_next_write_short(storage, 6);
    assert(sd_logger_batch_flush(l) == -1);

    // More data arrives while riding out the failure — it must append onto
    // the 4-byte remainder, not onto a still-full 10-byte buffer.
    assert(sd_logger_batch_append(l, "row3\n", 5));

    // Recovery: writes exactly the un-written tail + the new row ("ow2\nrow3\n").
    assert(sd_logger_batch_flush(l) == 9);

    sd_logger_stop(l, 0);

    size_t len;
    const uint8_t* contents = storage_mock_get_file_contents(
        storage, "/ext/biomapping/biomap_001.csv", &len);

    // Every row appears exactly once — no duplicated "row1\n".
    size_t dlen;
    const uint8_t* d = data_region(contents, len, &dlen);
    assert(dlen == strlen("H\nrow1\nrow2\nrow3\n"));
    assert(memcmp(d, "H\nrow1\nrow2\nrow3\n", dlen) == 0);

    // Trailer still describes the file exactly: byte count, CRC and row
    // count all reconcile against an independent pass over the region.
    char trailer[192];
    get_trailer(contents, len, trailer, sizeof(trailer));
    size_t rlen = crc_region_len(contents, len);
    unsigned long rows = 0, bytes = 0, crc = 0, ovf = 99, ff = 99;
    assert(sscanf(trailer, "# End rows:%lu bytes:%lu crc32:%lx overflows:%lu flush_fails:%lu",
                  &rows, &bytes, &crc, &ovf, &ff) == 5);
    assert(rows == 3);
    assert(bytes == rlen);
    assert(crc == crc32_ref(contents, rlen));
    assert(ff == 1);   // the partial write counts as one flush failure

    sd_logger_free(l);
    storage_mock_free(storage);
    printf("  -> Pass\n");
}

// The write-failure ride-out shape: several flushes, two of them partial,
// interleaved with new rows, then a clean recovery. The finished file must
// contain each row once and carry a trailer that verifies — the whole point
// of the ride-out is that a transient card blip costs some latency, not a
// file that looks corrupted.
static void test_sd_logger_partial_write_ride_out_trailer_verifies(void) {
    printf("Running test_sd_logger_partial_write_ride_out_trailer_verifies...\n");
    Storage* storage = storage_mock_alloc();
    SdLogger* l = sd_logger_alloc(storage);
    assert(sd_logger_start(l, "timestamp,gsr_raw\n"));

    char expected[256];
    size_t exp_len = (size_t)snprintf(expected, sizeof(expected), "timestamp,gsr_raw\n");

    // 9 rows total, flushed in bursts; writes 3 and 6 land mid-transfer.
    for(int i = 0; i < 9; i++) {
        int n = sd_logger_batch_printf(l, "%d,%d\n", i, 100 + i);
        assert(n > 0);
        exp_len += (size_t)snprintf(expected + exp_len, sizeof(expected) - exp_len, "%d,%d\n", i, 100 + i);

        if(i == 2) {
            assert(sd_logger_batch_flush(l) > 0);           // clean
        } else if(i == 5) {
            storage_mock_set_next_write_short(storage, 5);   // dies mid-batch
            assert(sd_logger_batch_flush(l) == -1);
        } else if(i == 7) {
            storage_mock_set_next_write_short(storage, 3);   // dies again, different offset
            assert(sd_logger_batch_flush(l) == -1);
        }
    }
    assert(sd_logger_batch_flush(l) > 0);                    // final recovery

    sd_logger_stop(l, 1000000000UL);

    size_t len;
    const uint8_t* contents = storage_mock_get_file_contents(
        storage, "/ext/biomapping/biomap_001.csv", &len);

    size_t dlen;
    const uint8_t* d = data_region(contents, len, &dlen);
    assert(dlen == exp_len);
    assert(memcmp(d, expected, dlen) == 0);                  // no duplicated rows

    char trailer[192];
    get_trailer(contents, len, trailer, sizeof(trailer));
    size_t rlen = crc_region_len(contents, len);
    unsigned long rows = 0, bytes = 0, crc = 0, endt = 0, ovf = 99, ff = 99;
    assert(sscanf(trailer,
        "# End rows:%lu bytes:%lu crc32:%lx end_time:%lu overflows:%lu flush_fails:%lu",
        &rows, &bytes, &crc, &endt, &ovf, &ff) == 6);
    assert(rows == 9);
    assert(bytes == rlen);
    assert(crc == crc32_ref(contents, rlen));               // verifies clean
    assert(ovf == 0);
    assert(ff == 2);

    sd_logger_free(l);
    storage_mock_free(storage);
    printf("  -> Pass\n");
}

// A partial write that stops exactly on a row boundary ('\n' as its last
// committed byte) must not desync the row count or inject a separator: the
// committed prefix is whole rows, the tail is whole rows, and the trailer's
// rows:/crc32: still reconcile.
static void test_sd_logger_partial_write_on_row_boundary(void) {
    printf("Running test_sd_logger_partial_write_on_row_boundary...\n");
    Storage* storage = storage_mock_alloc();
    SdLogger* l = sd_logger_alloc(storage);
    assert(sd_logger_start(l, "H\n"));

    assert(sd_logger_batch_append(l, "aa\n", 3));
    assert(sd_logger_batch_append(l, "bb\n", 3));
    assert(sd_logger_batch_append(l, "cc\n", 3));

    // 6 bytes = "aa\nbb\n" exactly — the cut lands on a newline.
    storage_mock_set_next_write_short(storage, 6);
    assert(sd_logger_batch_flush(l) == -1);

    assert(sd_logger_batch_append(l, "dd\n", 3));
    assert(sd_logger_batch_flush(l) == 6);   // "cc\ndd\n"

    sd_logger_stop(l, 0);

    size_t len;
    const uint8_t* contents = storage_mock_get_file_contents(
        storage, "/ext/biomapping/biomap_001.csv", &len);

    size_t dlen;
    const uint8_t* d = data_region(contents, len, &dlen);
    assert(dlen == strlen("H\naa\nbb\ncc\ndd\n"));
    assert(memcmp(d, "H\naa\nbb\ncc\ndd\n", dlen) == 0);

    char trailer[192];
    get_trailer(contents, len, trailer, sizeof(trailer));
    size_t rlen = crc_region_len(contents, len);
    unsigned long rows = 0, bytes = 0, crc = 0, ovf = 99, ff = 99;
    assert(sscanf(trailer, "# End rows:%lu bytes:%lu crc32:%lx overflows:%lu flush_fails:%lu",
                  &rows, &bytes, &crc, &ovf, &ff) == 5);
    assert(rows == 4);
    assert(bytes == rlen);
    assert(crc == crc32_ref(contents, rlen));
    assert(ff == 1);

    sd_logger_free(l);
    storage_mock_free(storage);
    printf("  -> Pass\n");
}

// ── Fault-injection stress harness ───────────────────────────────────────
// A deterministic xorshift PRNG so any failing run reprints the exact seed
// that produced it.
static uint32_t g_rng;
static uint32_t rng_next(void) {
    uint32_t x = g_rng;
    x ^= x << 13; x ^= x >> 17; x ^= x << 5;
    return (g_rng = x);
}

// Full post-mortem on a stopped file: the data region must be byte-identical
// to `expected` (no duplicated, dropped, or reordered rows), and the "# End"
// trailer's bytes / crc32 / rows / overflows / flush_fails must all
// reconcile against an independent pass over the file. `want_fails` is the
// number of flush failures the run injected — sd_logger must have counted
// exactly that many.
static void assert_file_verifies(Storage* storage, const char* expected, size_t expected_len,
                                 unsigned long want_rows, unsigned long want_fails) {
    size_t len;
    const uint8_t* contents = storage_mock_get_file_contents(
        storage, "/ext/biomapping/biomap_001.csv", &len);
    assert(contents != NULL);

    size_t dlen;
    const uint8_t* d = data_region(contents, len, &dlen);
    assert(dlen == expected_len);
    assert(memcmp(d, expected, dlen) == 0);

    char trailer[192];
    get_trailer(contents, len, trailer, sizeof(trailer));
    size_t rlen = crc_region_len(contents, len);

    unsigned long rows = 0, bytes = 0, crc = 0, endt = 0, ovf = 999, ff = 999;
    int matched = sscanf(trailer,
        "# End rows:%lu bytes:%lu crc32:%lx end_time:%lu overflows:%lu flush_fails:%lu",
        &rows, &bytes, &crc, &endt, &ovf, &ff);
    if(matched != 6) {
        matched = sscanf(trailer,
            "# End rows:%lu bytes:%lu crc32:%lx overflows:%lu flush_fails:%lu",
            &rows, &bytes, &crc, &ovf, &ff);
        assert(matched == 5);
    }
    assert(rows == want_rows);
    assert(bytes == rlen);
    assert(crc == crc32_ref(contents, rlen));
    assert(ovf == 0);
    assert(ff == want_fails);
}

// One randomised run: emit TOTAL_ROWS known rows in bursts, and before each
// flush inject either nothing, a total write failure, or a partial write
// that dies at a random offset inside the pending buffer. Whatever the
// card does, the finished file must reconstruct exactly and its trailer
// must verify (assert_file_verifies). `pending` mirrors sd_logger's
// internal gsr_batch_len so the test can pick a partial-cut offset.
static void stress_run(uint32_t seed) {
    g_rng = seed ? seed : 1u;
    Storage* storage = storage_mock_alloc();
    SdLogger* l = sd_logger_alloc(storage);
    assert(sd_logger_start(l, "timestamp,gsr_raw\n"));

    static char expected[16384];
    size_t exp_len = (size_t)snprintf(expected, sizeof(expected), "timestamp,gsr_raw\n");

    const int TOTAL_ROWS = 240;
    int emitted = 0;
    unsigned long injected_fails = 0;
    size_t pending = 0;   // bytes appended but not yet durably on the card

    while(emitted < TOTAL_ROWS) {
        int burst = 1 + (int)(rng_next() % 12);
        for(int b = 0; b < burst && emitted < TOTAL_ROWS; b++) {
            char row[48];
            int n = (rng_next() % 3 == 0)
                ? snprintf(row, sizeof(row), "%d,%d.%03d\n", emitted, 1000 + emitted, (int)(rng_next() % 1000))
                : snprintf(row, sizeof(row), "%d,%d\n", emitted, 1000 + emitted);
            assert(n > 0 && (size_t)n < sizeof(row));
            assert(sd_logger_batch_append(l, row, (size_t)n));
            assert(exp_len + (size_t)n < sizeof(expected));
            memcpy(expected + exp_len, row, (size_t)n);
            exp_len += (size_t)n;
            pending += (size_t)n;
            emitted++;
        }

        if(pending == 0) { assert(sd_logger_batch_flush(l) == 0); continue; }

        switch(rng_next() % 4) {
        case 0:   // clean flush
        case 1:
            assert(sd_logger_batch_flush(l) > 0);
            pending = 0;
            break;
        case 2:   // total write failure — nothing reaches the card
            storage_mock_fail_writes(storage, true);
            assert(sd_logger_batch_flush(l) == -1);
            storage_mock_fail_writes(storage, false);
            injected_fails++;
            break;
        case 3:   // partial write — card dies mid-transfer at a random offset
            if(pending >= 2) {
                size_t cap = 1 + (rng_next() % (pending - 1));   // 1 .. pending-1
                storage_mock_set_next_write_short(storage, cap);
                assert(sd_logger_batch_flush(l) == -1);
                injected_fails++;
                pending -= cap;
            } else {
                assert(sd_logger_batch_flush(l) > 0);
                pending = 0;
            }
            break;
        }
    }

    // sd_logger_stop() drains whatever is still buffered (writes are enabled
    // again) and writes the trailer.
    sd_logger_stop(l, 1000000000UL);
    assert_file_verifies(storage, expected, exp_len, (unsigned long)TOTAL_ROWS, injected_fails);

    sd_logger_free(l);
    storage_mock_free(storage);
}

// 600 randomised fault-injection runs. Any corruption — a duplicated prefix,
// a dropped row, a trailer that stops matching the file — trips an assert
// and prints the seed to replay.
static void test_sd_logger_partial_write_fuzz(void) {
    printf("Running test_sd_logger_partial_write_fuzz...\n");
    for(uint32_t seed = 1; seed <= 600; seed++) {
        stress_run(seed);
        if(seed % 100 == 0) printf("  seed %u ok\n", seed);
    }
    printf("  -> Pass\n");
}

// Exhaustive: a fixed 3-row batch, with the first flush cut short at EVERY
// possible byte offset 0..len. Every mid-transfer death point must still
// reconstruct exactly and verify after recovery.
static void test_sd_logger_partial_write_every_offset(void) {
    printf("Running test_sd_logger_partial_write_every_offset...\n");
    const char* rows = "10,1001\n11,1002.5\n12,1003\n";
    const size_t rlen = strlen(rows);

    for(size_t cut = 0; cut <= rlen; cut++) {
        Storage* storage = storage_mock_alloc();
        SdLogger* l = sd_logger_alloc(storage);
        assert(sd_logger_start(l, "H\n"));

        assert(sd_logger_batch_append(l, rows, rlen));

        unsigned long fails = 0;
        if(cut == 0) {
            storage_mock_fail_writes(storage, true);
            assert(sd_logger_batch_flush(l) == -1);
            storage_mock_fail_writes(storage, false);
            fails = 1;
        } else if(cut < rlen) {
            storage_mock_set_next_write_short(storage, cut);
            assert(sd_logger_batch_flush(l) == -1);
            fails = 1;
        } else {
            assert(sd_logger_batch_flush(l) > 0);   // cut == rlen: full write
        }

        // A follow-up row lands on whatever tail is left, then a clean flush.
        assert(sd_logger_batch_append(l, "13,1004\n", 8));
        assert(sd_logger_batch_flush(l) > 0);

        sd_logger_stop(l, 0);

        char expected[64];
        size_t exp_len = (size_t)snprintf(expected, sizeof(expected), "H\n%s13,1004\n", rows);
        assert_file_verifies(storage, expected, exp_len, 4, fails);

        sd_logger_free(l);
        storage_mock_free(storage);
    }
    printf("  -> Pass\n");
}

// The unrecoverable path: writes fail for good partway through. The file
// must degrade to a clean PREFIX of the data with no "# End" trailer (a
// re-import reads that as "incomplete", never "corrupt") — never a
// duplicated or garbled tail.
static void test_sd_logger_permanent_write_failure_leaves_clean_prefix(void) {
    printf("Running test_sd_logger_permanent_write_failure_leaves_clean_prefix...\n");
    Storage* storage = storage_mock_alloc();
    SdLogger* l = sd_logger_alloc(storage);
    assert(sd_logger_start(l, "H\n"));

    // 10 rows land cleanly.
    for(int i = 0; i < 10; i++) {
        char row[16];
        int n = snprintf(row, sizeof(row), "r%02d\n", i);
        assert(sd_logger_batch_append(l, row, (size_t)n));
    }
    assert(sd_logger_batch_flush(l) > 0);

    // A partial write commits 2 more full rows ("r10\nr11\n" = 8 bytes) then
    // the card is gone for good.
    for(int i = 10; i < 15; i++) {
        char row[16];
        int n = snprintf(row, sizeof(row), "r%02d\n", i);
        assert(sd_logger_batch_append(l, row, (size_t)n));
    }
    storage_mock_set_next_write_short(storage, 8);
    assert(sd_logger_batch_flush(l) == -1);
    storage_mock_fail_writes(storage, true);
    assert(sd_logger_batch_flush(l) == -1);

    sd_logger_stop(l, 0);   // its final flush + trailer write also fail

    size_t len;
    const uint8_t* contents = storage_mock_get_file_contents(
        storage, "/ext/biomapping/biomap_001.csv", &len);

    // Whatever is on the card is exactly the integrity line + a prefix of
    // the rows, and there is no trailer.
    const char* want = INTEGRITY_LINE "H\nr00\nr01\nr02\nr03\nr04\nr05\nr06\nr07\nr08\nr09\nr10\nr11\n";
    assert(len == strlen(want));
    assert(memcmp(contents, want, len) == 0);
    int has_trailer = 0;
    for(size_t i = 0; i + 5 <= len; i++)
        if(memcmp(contents + i, "# End", 5) == 0) { has_trailer = 1; break; }
    assert(!has_trailer);

    sd_logger_free(l);
    storage_mock_free(storage);
    printf("  -> Pass\n");
}

// The write-failure ride-out runs on the same single event-loop thread that
// also drains the GPS UART and emits GSR/RF rows (biomap_session.c's Tick
// handler). So the only cost it imposes on the rest of the firmware is the
// tick-thread time each sd_logger_batch_flush() holds — and flush_peak_ms,
// which lands in the once-a-second telemetry row on hardware, must capture
// the worst of it, including on the *failed* retries (not just the eventual
// recovery write). This pins that down: three failed flushes each stalling
// 300 ticks, then a cheap recovery — the peak stays 300, and the whole
// backlog goes out in ONE write, not one-per-row.
static void test_sd_logger_ride_out_stall_is_measured(void) {
    printf("Running test_sd_logger_ride_out_stall_is_measured...\n");
    Storage* storage = storage_mock_alloc();
    SdLogger* l = sd_logger_alloc(storage);
    assert(sd_logger_start(l, "timestamp,gsr_raw\n"));
    assert(sd_logger_get_flush_peak_ms(l) == 0);

    char expected[8192];
    size_t exp_len = (size_t)snprintf(expected, sizeof(expected), "timestamp,gsr_raw\n");

    int total = 0;
    for(int cycle = 0; cycle < 3; cycle++) {
        for(int i = 0; i < 100; i++) {
            assert(sd_logger_batch_printf(l, "%d,%d\n", total, 1000 + total) > 0);
            exp_len += (size_t)snprintf(expected + exp_len, sizeof(expected) - exp_len,
                                        "%d,%d\n", total, 1000 + total);
            total++;
        }
        // A marginal card that times out on the write, then reports failure.
        storage_mock_set_next_write_delay_ticks(storage, 300);
        storage_mock_fail_writes(storage, true);
        assert(sd_logger_batch_flush(l) == -1);
        storage_mock_fail_writes(storage, false);
    }

    // Worst tick-thread stall so far is a *failed* retry — 300 ticks — even
    // though nothing has reached the card yet. This is the number the
    // telemetry row would show on hardware.
    assert(sd_logger_get_flush_peak_ms(l) == 300);

    // Recovery: the whole 300-row backlog flushed in a single write. Make it
    // cheap so the assertion below proves the peak still reflects the
    // ride-out, not this call.
    storage_mock_set_next_write_delay_ticks(storage, 50);
    int flushed = sd_logger_batch_flush(l);
    assert(flushed >= 300 * (int)strlen("0,1000\n"));   // one write, not 300
    assert(flushed <= SD_LOGGER_BATCH_CAP);
    assert(sd_logger_get_flush_peak_ms(l) == 300);

    sd_logger_stop(l, 0);

    // The stall cost latency, not integrity — the file still verifies, with
    // flush_fails:3 as the only mark.
    assert_file_verifies(storage, expected, exp_len, (unsigned long)total, 3);

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
    test_sd_logger_trailer_matches_data();
    test_sd_logger_trailer_omits_end_time_when_epoch_zero();
    test_sd_logger_trailer_reports_flush_fails();
    test_sd_logger_partial_write_keeps_only_unwritten_tail();
    test_sd_logger_partial_write_ride_out_trailer_verifies();
    test_sd_logger_partial_write_on_row_boundary();
    test_sd_logger_partial_write_fuzz();
    test_sd_logger_partial_write_every_offset();
    test_sd_logger_permanent_write_failure_leaves_clean_prefix();
    test_sd_logger_ride_out_stall_is_measured();
    test_sd_logger_free_while_active_stops_cleanly();

    printf("\nAll 31 sd_logger host tests passed successfully!\n");
    return 0;
}
