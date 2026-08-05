// test_sd_logger_prealloc.c — experiment, NOT production code.
//
// docs/gps_rf_mutex_status.md's option E ("pre-allocate the log file") asks
// whether the seek-past-EOF-and-write-dummy-byte trick (the only pre-alloc
// primitive the Flipper app SDK actually exposes -- storage.h has no
// f_expand binding, confirmed by grepping the real SDK headers) can cut the
// once-per-FLUSH_INTERVAL SD-flush stall documented for tracks 116-118, and
// specifically whether it should run once at recording start or as a
// rolling "extend a chunk ahead" check on every flush cycle.
//
// This file does NOT call any modules/sd_logger.c function and is NOT
// wired into the real recording path (biomap_session.c) or SdLogger's
// public API (sd_logger.h). It operates directly on the Storage/File mock
// to prototype and measure the rolling-chunk approach in isolation, using
// track 016's own measured write rate, before deciding whether it's worth
// integrating for real. See the "2026-08-05: track 016" doc entry for
// where the ~13000 bytes/10s-cycle figure below comes from.
//
// tests/shims/storage/storage.h's storage_file_seek()/_tell()/_truncate()/
// _size() (added alongside this file) mirror the real SDK's documented
// behaviour, most importantly: a seek past the current file size in write
// mode expands the file's size IMMEDIATELY, inside that call, with
// undefined (not zero-filled) content in the gap -- see storage_mock.c's
// storage_file_seek() doc comment. That's the exact mechanic being tested
// here.

#include <stdio.h>
#include <string.h>
#include <assert.h>

#include "storage/storage.h"

_Atomic uint32_t furi_test_tick = 1;

#define PREALLOC_CHUNK_BYTES (1024u * 1024u) // 1 MiB ~= 13 min headroom at track 016's rate
#define PREALLOC_LOW_WATER   (32u * 1024u)   // extend once headroom drops below this

// Ensures at least PREALLOC_LOW_WATER bytes of already-allocated space sit
// ahead of the file's real write position (storage_file_tell()). Always
// leaves the file positioned exactly where it was on entry -- the real data
// boundary -- so a normal storage_file_write() called right after this
// lands contiguously with the real data already written, never inside the
// pre-allocated (undefined-content) tail. Returns true if an extension
// happened.
static bool prealloc_ensure_ahead(File* file) {
    uint64_t real_pos = storage_file_tell(file);
    uint64_t size = storage_file_size(file);
    if(size - real_pos >= PREALLOC_LOW_WATER) return false;

    uint64_t new_size = real_pos + PREALLOC_CHUNK_BYTES;
    bool seek_ok = storage_file_seek(file, (uint32_t)(new_size - 1), true);
    assert(seek_ok);
    uint8_t dummy = 0;
    storage_file_write(file, &dummy, 1); // forces the size-extend cost, right here
    bool rewind_ok = storage_file_seek(file, (uint32_t)real_pos, true);
    assert(rewind_ok);
    return true;
}

// Trims any never-written pre-allocated tail back to the real data length.
// Must run before storage_file_close() at "stop" whenever
// prealloc_ensure_ahead() was ever used, or the file keeps a trailing block
// of undefined bytes past the real CSV rows. Safe to call unconditionally:
// prealloc_ensure_ahead() always rewinds to the real boundary, so the file
// position on entry here is always already correct.
static bool prealloc_truncate_to_real_length(File* file) {
    return storage_file_truncate(file);
}

static void test_prealloc_extends_only_when_headroom_low(void) {
    printf("Running test_prealloc_extends_only_when_headroom_low...\n");
    Storage* storage = storage_mock_alloc();
    File* file = storage_file_alloc(storage);
    assert(storage_file_open(file, "/ext/biomapping/prealloc_test.csv", FSAM_WRITE, FSOM_CREATE_ALWAYS));

    // Empty file, zero headroom -> must extend.
    assert(prealloc_ensure_ahead(file));
    assert(storage_file_size(file) == PREALLOC_CHUNK_BYTES);
    assert(storage_file_tell(file) == 0); // rewound to the real (still-zero) data boundary

    // Full chunk of headroom now -> must be a no-op.
    assert(!prealloc_ensure_ahead(file));
    assert(storage_file_size(file) == PREALLOC_CHUNK_BYTES);

    storage_file_close(file);
    storage_file_free(file);
    storage_mock_free(storage);
    printf("  -> Pass\n");
}

static void test_prealloc_preserves_write_position_and_data(void) {
    printf("Running test_prealloc_preserves_write_position_and_data...\n");
    Storage* storage = storage_mock_alloc();
    File* file = storage_file_alloc(storage);
    assert(storage_file_open(file, "/ext/biomapping/prealloc_test.csv", FSAM_WRITE, FSOM_CREATE_ALWAYS));

    assert(storage_file_write(file, "AAAA", 4) == 4);
    assert(prealloc_ensure_ahead(file));             // grows the file far ahead of the real data
    assert(storage_file_tell(file) == 4);             // must rewind exactly to the real boundary
    assert(storage_file_write(file, "BBBB", 4) == 4); // must land right after "AAAA", not in the grown tail

    assert(prealloc_truncate_to_real_length(file));
    storage_file_close(file);

    size_t len;
    const uint8_t* contents = storage_mock_get_file_contents(
        storage, "/ext/biomapping/prealloc_test.csv", &len);
    assert(len == 8);
    assert(memcmp(contents, "AAAABBBB", 8) == 0); // no gap, no corruption from the extension in between

    storage_file_free(file);
    storage_mock_free(storage);
    printf("  -> Pass\n");
}

static void test_prealloc_without_truncate_leaves_garbage_tail(void) {
    printf("Running test_prealloc_without_truncate_leaves_garbage_tail...\n");
    Storage* storage = storage_mock_alloc();
    File* file = storage_file_alloc(storage);
    assert(storage_file_open(file, "/ext/biomapping/prealloc_test.csv", FSAM_WRITE, FSOM_CREATE_ALWAYS));

    assert(storage_file_write(file, "AAAA", 4) == 4);
    assert(prealloc_ensure_ahead(file));
    storage_file_close(file); // stopped WITHOUT prealloc_truncate_to_real_length() -- the drawback flagged in the doc

    size_t len;
    storage_mock_get_file_contents(storage, "/ext/biomapping/prealloc_test.csv", &len);
    // Grows to real_pos + CHUNK (4 + 1 MiB), not just the 4 real bytes --
    // silent corruption (a garbage-padded CSV) if the truncate step is forgotten.
    assert(len == 4 + PREALLOC_CHUNK_BYTES);

    storage_file_free(file);
    storage_mock_free(storage);
    printf("  -> Pass\n");
}

static void test_prealloc_cuts_extension_frequency_vs_naive_growth(void) {
    printf("Running test_prealloc_cuts_extension_frequency_vs_naive_growth...\n");
    Storage* storage = storage_mock_alloc();
    File* file = storage_file_alloc(storage);
    assert(storage_file_open(file, "/ext/biomapping/prealloc_test.csv", FSAM_WRITE, FSOM_CREATE_ALWAYS));

    // Track 016's own measured rate (docs/gps_rf_mutex_status.md, 2026-08-05
    // entry): ~13000 bytes written per 10s FLUSH_INTERVAL cycle. Simulate
    // 800 cycles -- ~2.2 hours, well past track 016's 59-minute length --
    // to see whether the rolling chunk keeps up over a long walk.
    const int CYCLES = 800;
    const size_t CYCLE_BYTES = 13000;
    char cycle_data[13000];
    memset(cycle_data, 'x', sizeof(cycle_data));

    int extend_count = 0;
    for(int i = 0; i < CYCLES; i++) {
        if(prealloc_ensure_ahead(file)) extend_count++;
        assert(storage_file_write(file, cycle_data, CYCLE_BYTES) == CYCLE_BYTES);
    }

    // Today's unmodified behaviour pays an allocation-relevant flush stall
    // on essentially every one of these 800 cycles -- exactly what track
    // 016's flush_peak_ms/tick_dt_ms progression showed. The rolling chunk
    // should cut that to roughly one extension per (CHUNK/CYCLE_BYTES) ~= 80
    // cycles, ~10 total. Asserting a generous 50x-fewer bound (not the
    // theoretical ~80x) so this isn't brittle to the exact constants.
    printf("  %d cycles -> %d extension events (today: %d stalls)\n",
           CYCLES, extend_count, CYCLES);
    assert(extend_count > 0);
    assert(extend_count < CYCLES / 50);

    assert(prealloc_truncate_to_real_length(file));
    storage_file_close(file);

    size_t len;
    storage_mock_get_file_contents(storage, "/ext/biomapping/prealloc_test.csv", &len);
    assert(len == CYCLES * CYCLE_BYTES); // truncate leaves exactly the real data, nothing more

    storage_file_free(file);
    storage_mock_free(storage);
    printf("  -> Pass\n");
}

static void test_prealloc_extension_delay_hook_fires_only_on_real_extension(void) {
    printf("Running test_prealloc_extension_delay_hook_fires_only_on_real_extension...\n");
    Storage* storage = storage_mock_alloc();
    File* file = storage_file_alloc(storage);
    assert(storage_file_open(file, "/ext/biomapping/prealloc_test.csv", FSAM_WRITE, FSOM_CREATE_ALWAYS));

    // Stand-in for real f_lseek()'s cluster-allocation cost landing on the
    // extending seek itself, same idea as storage_mock_set_next_write_delay_
    // ticks() already used for sd_logger.c's flush_peak_ms tests.
    uint32_t before = furi_test_tick;
    storage_mock_set_next_seek_extend_delay_ticks(storage, 40);
    assert(prealloc_ensure_ahead(file));
    assert(furi_test_tick - before == 40);

    // A call that's a no-op (headroom already sufficient) must NOT consume
    // the queued delay or advance the clock -- the hook only models real
    // allocation cost, not every prealloc check.
    before = furi_test_tick;
    storage_mock_set_next_seek_extend_delay_ticks(storage, 40);
    assert(!prealloc_ensure_ahead(file));
    assert(furi_test_tick - before == 0);

    storage_file_close(file);
    storage_file_free(file);
    storage_mock_free(storage);
    printf("  -> Pass\n");
}

int main(void) {
    printf("========================================\n");
    printf("SD LOGGER PRE-ALLOCATION EXPERIMENT (docs/gps_rf_mutex_status.md option E)\n");
    printf("Prototype only -- not wired into modules/sd_logger.c\n");
    printf("========================================\n");
    test_prealloc_extends_only_when_headroom_low();
    test_prealloc_preserves_write_position_and_data();
    test_prealloc_without_truncate_leaves_garbage_tail();
    test_prealloc_cuts_extension_frequency_vs_naive_growth();
    test_prealloc_extension_delay_hook_fires_only_on_real_extension();

    printf("\nAll 5 sd_logger pre-allocation experiment tests passed successfully!\n");
    return 0;
}
