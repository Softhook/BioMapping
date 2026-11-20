// Host tests for the shared SD logger's whole-block mode (core/sd_logger.c,
// block_bytes 512, as the Cardputer uses it). The Flipper's mode (every row
// at each flush) is covered by test_sd_logger.c through the Flipper wrapper.
//
// A pretend card in memory records where each write starts and ends, so the
// tests can check that a periodic flush always ends on a whole block of the
// file, and that the finished file is exactly what the Flipper's mode
// writes for the same rows.

#include <assert.h>
#include <stdio.h>
#include <string.h>

#include "core/sd_logger.h"

#define BLOCK 512
#define CARD_CAP (9u * 1024u * 1024u)

typedef struct {
    uint8_t  data[CARD_CAP];
    uint32_t size, pos;
    bool     open;
    bool     fail_writes;
    size_t   short_write;  // > 0: the next write takes only this many bytes
    // Every row write's start and end (pre-allocation's 1-byte write and
    // the trailer are left out by write_log_on).
    bool     write_log_on;
    uint32_t write_ends[4096];
    uint32_t write_starts[4096];
    int      writes;
    uint32_t now;
} Card;

static Card card_a, card_b;

static SdOpenResult card_open(void* ctx, const char* name) {
    (void)name;
    Card* c = ctx;
    c->open = true;
    c->size = c->pos = 0;
    return SdOpenOk;
}
static size_t card_write(void* ctx, const void* d, size_t n) {
    Card* c = ctx;
    assert(c->open);
    if(c->fail_writes) return 0;
    if(c->short_write) {
        if(n > c->short_write) n = c->short_write;
        c->short_write = 0;
    }
    assert(c->pos + n <= CARD_CAP);
    memcpy(c->data + c->pos, d, n);
    if(c->write_log_on && n > 1) {
        c->write_starts[c->writes] = c->pos;
        c->write_ends[c->writes] = c->pos + (uint32_t)n;
        c->writes++;
    }
    c->pos += (uint32_t)n;
    if(c->pos > c->size) c->size = c->pos;
    return n;
}
static bool card_sync(void* ctx) { return !((Card*)ctx)->fail_writes; }
static bool card_seek(void* ctx, uint32_t pos) {
    Card* c = ctx;
    if(pos > CARD_CAP) return false;
    c->pos = pos;
    if(pos > c->size) c->size = pos;
    return true;
}
static bool card_truncate(void* ctx) { Card* c = ctx; c->size = c->pos; return true; }
static void card_close(void* ctx) { ((Card*)ctx)->open = false; }
static uint32_t card_now(void* ctx) { return ((Card*)ctx)->now; }

static SdLogger* make(Card* c, uint32_t block) {
    memset(c, 0, sizeof(*c));
    SdPlatform p = {
        .ctx = c, .open_new = card_open, .write = card_write, .sync = card_sync,
        .seek = card_seek, .truncate = card_truncate, .close = card_close, .now_ms = card_now,
    };
    return sd_logger_create(&p, block);
}

static const char* HEADER = "# Start time: 0\ntime,gsr\n";

static int make_row(char* out, int i) {
    return snprintf(out, 64, "%d.%d,%d.%02d\n", i / 10, i % 10, 1000 + (i * 37) % 900, i % 100);
}

// Ten seconds of rows, then one flush, like a recording.
static void ten_seconds(SdLogger* a, SdLogger* b, int* row) {
    for(int k = 0; k < 100; k++, (*row)++) {
        char r[64];
        int n = make_row(r, *row);
        assert(sd_logger_batch_append(a, r, (size_t)n));
        if(b) assert(sd_logger_batch_append(b, r, (size_t)n));
    }
}

static void test_flush_ends_on_whole_blocks_and_file_matches_flipper_mode(void) {
    printf("Running test_flush_ends_on_whole_blocks_and_file_matches_flipper_mode...\n");
    SdLogger* a = make(&card_a, BLOCK);  // Cardputer
    SdLogger* b = make(&card_b, 0);      // Flipper
    assert(sd_logger_start(a, HEADER, "x"));
    assert(sd_logger_start(b, HEADER, "x"));
    card_a.write_log_on = true;
    int row = 0;
    for(int s = 0; s < 30; s++) {
        ten_seconds(a, b, &row);
        int fa = sd_logger_batch_flush(a);
        assert(sd_logger_batch_flush(b) > 0);
        assert(fa > 0);
        // What's left is less than one block.
        assert(sd_logger_get_batch_fill_bytes(a) < BLOCK);
    }
    // Every periodic write ended on a whole block of the file.
    assert(card_a.writes == 30);
    for(int i = 0; i < card_a.writes; i++) assert(card_a.write_ends[i] % BLOCK == 0);
    // And followed straight on from the one before.
    for(int i = 1; i < card_a.writes; i++) assert(card_a.write_starts[i] == card_a.write_ends[i - 1]);

    sd_logger_stop(a, 1763600000u);
    sd_logger_stop(b, 1763600000u);
    // The finished files are byte for byte the same, trailer included.
    assert(card_a.size == card_b.size);
    assert(memcmp(card_a.data, card_b.data, card_a.size) == 0);
    sd_logger_destroy(a);
    sd_logger_destroy(b);
    printf("  -> Pass\n");
}

static void test_less_than_a_block_writes_nothing_until_stop(void) {
    printf("Running test_less_than_a_block_writes_nothing_until_stop...\n");
    SdLogger* a = make(&card_a, BLOCK);
    assert(sd_logger_start(a, HEADER, "x"));
    card_a.write_log_on = true;
    // The header leaves the file part-way into block 0; fill it to one byte
    // short of the boundary.
    uint32_t pos = (uint32_t)(strlen("# Integrity: crc32 v1\n") + strlen(HEADER));
    char buf[BLOCK];
    size_t n = BLOCK - pos - 1;
    memset(buf, 'a', n - 1);
    buf[n - 1] = '\n';
    assert(sd_logger_batch_append(a, buf, n));
    assert(sd_logger_batch_flush(a) == 0);
    assert(card_a.writes == 0);
    // One more byte reaches the boundary: now it writes, exactly to it.
    assert(sd_logger_batch_append(a, "\n", 1));
    assert(sd_logger_batch_flush(a) == (int)(n + 1));
    assert(card_a.writes == 1 && card_a.write_ends[0] == BLOCK);
    assert(sd_logger_get_batch_fill_bytes(a) == 0);
    // A short row after it waits for the stop, which writes it.
    assert(sd_logger_batch_append(a, "1,2\n", 4));
    assert(sd_logger_batch_flush(a) == 0);
    sd_logger_stop(a, 0);
    assert(card_a.writes == 3);  // + the remainder + the trailer
    assert(card_a.write_ends[1] == BLOCK + 4);
    assert(memcmp(card_a.data + BLOCK, "1,2\n# End rows:", 15) == 0);
    sd_logger_destroy(a);
    printf("  -> Pass\n");
}

// After a failed flush the next one writes the whole buffer, so a success
// means the card really took everything that was waiting; then whole
// blocks again.
static void test_after_a_failure_the_retry_writes_everything(void) {
    printf("Running test_after_a_failure_the_retry_writes_everything...\n");
    SdLogger* a = make(&card_a, BLOCK);
    SdLogger* b = make(&card_b, 0);
    assert(sd_logger_start(a, HEADER, "x"));
    assert(sd_logger_start(b, HEADER, "x"));
    int row = 0;
    ten_seconds(a, b, &row);
    assert(sd_logger_batch_flush(a) > 0);
    assert(sd_logger_batch_flush(b) > 0);

    ten_seconds(a, b, &row);
    card_a.fail_writes = true;
    assert(sd_logger_batch_flush(a) < 0);
    card_a.fail_writes = false;
    card_a.write_log_on = true;
    size_t waiting = sd_logger_get_batch_fill_bytes(a);
    assert(sd_logger_batch_flush(a) == (int)waiting);
    assert(sd_logger_get_batch_fill_bytes(a) == 0);
    assert(sd_logger_batch_flush(b) > 0);

    ten_seconds(a, b, &row);
    assert(sd_logger_batch_flush(a) > 0);
    assert(sd_logger_batch_flush(b) > 0);
    assert(card_a.write_ends[card_a.writes - 1] % BLOCK == 0);

    sd_logger_stop(a, 0);
    sd_logger_stop(b, 0);
    // Same rows; only the trailer's flush_fails count differs.
    const char* ta = strstr((const char*)card_a.data, "# End ");
    const char* tb = strstr((const char*)card_b.data, "# End ");
    assert(ta && tb && (ta - (const char*)card_a.data) == (tb - (const char*)card_b.data));
    assert(memcmp(card_a.data, card_b.data, (size_t)(ta - (const char*)card_a.data)) == 0);
    assert(strstr(ta, "flush_fails:1\n"));
    assert(sd_logger_get_flush_fail_count(a) == 1);
    sd_logger_destroy(a);
    sd_logger_destroy(b);
    printf("  -> Pass\n");
}

// What a whole-block flush of `l` would write now (bytes up to the last
// whole block of the file).
static size_t flush_wants(SdLogger* l) {
    size_t pos = strlen("# Integrity: crc32 v1\n") + strlen(HEADER);
    size_t end = ((pos + sd_logger_get_batch_fill_bytes(l)) / BLOCK) * BLOCK;
    return end - pos;
}

// The final write before a stop (sd_logger_batch_flush_all()) writes the
// part-block too, and a failure is reported, so the session can retry it
// and warn instead of losing the last rows quietly.
static void test_flush_all_writes_the_part_block_and_reports_failure(void) {
    printf("Running test_flush_all_writes_the_part_block_and_reports_failure...\n");
    SdLogger* a = make(&card_a, BLOCK);
    assert(sd_logger_start(a, HEADER, "x"));
    assert(sd_logger_batch_append(a, "1,2\n", 4));
    assert(sd_logger_batch_flush(a) == 0);  // under a block: kept back
    card_a.fail_writes = true;
    assert(sd_logger_batch_flush_all(a) < 0);
    assert(sd_logger_get_batch_fill_bytes(a) == 4);  // kept for the retry
    card_a.fail_writes = false;
    assert(sd_logger_batch_flush_all(a) == 4);
    assert(sd_logger_get_batch_fill_bytes(a) == 0);
    sd_logger_stop(a, 0);
    size_t pos = strlen("# Integrity: crc32 v1\n") + strlen(HEADER);
    assert(memcmp(card_a.data + pos, "1,2\n# End rows:1 ", 17) == 0);
    sd_logger_destroy(a);
    printf("  -> Pass\n");
}

// A card that takes only part of a whole-block write: the part it took is
// kept, the rest retried, and the finished file still matches.
static void test_partial_write_in_block_mode(void) {
    printf("Running test_partial_write_in_block_mode...\n");
    // The first flush writes 977 bytes (to the end of block 1); every cut
    // is part-way through it.
    for(size_t cut = 1; cut < 977; cut += 37) {
        SdLogger* a = make(&card_a, BLOCK);
        SdLogger* b = make(&card_b, 0);
        assert(sd_logger_start(a, HEADER, "x"));
        assert(sd_logger_start(b, HEADER, "x"));
        int row = 0;
        ten_seconds(a, b, &row);
        assert(flush_wants(a) == 977 && (flush_wants(a) + 47) % BLOCK == 0);
        card_a.short_write = cut;
        assert(sd_logger_batch_flush(a) < 0);
        ten_seconds(a, b, &row);
        assert(sd_logger_batch_flush(a) > 0);
        ten_seconds(a, b, &row);
        assert(sd_logger_batch_flush(a) >= 0);
        assert(sd_logger_batch_flush(b) > 0);
        sd_logger_stop(a, 0);
        sd_logger_stop(b, 0);
        const char* ta = strstr((const char*)card_a.data, "# End ");
        const char* tb = strstr((const char*)card_b.data, "# End ");
        assert(ta && tb && (ta - (const char*)card_a.data) == (tb - (const char*)card_b.data));
        assert(memcmp(card_a.data, card_b.data, (size_t)(ta - (const char*)card_a.data)) == 0);
        // Same row and byte counts and CRC: the file describes itself.
        assert(strncmp(ta, tb, (size_t)(strstr(ta, "overflows:") - ta)) == 0);
        sd_logger_destroy(a);
        sd_logger_destroy(b);
    }
    printf("  -> Pass\n");
}

int main(void) {
    test_flush_ends_on_whole_blocks_and_file_matches_flipper_mode();
    test_less_than_a_block_writes_nothing_until_stop();
    test_after_a_failure_the_retry_writes_everything();
    test_partial_write_in_block_mode();
    test_flush_all_writes_the_part_block_and_reports_failure();
    printf("\nAll sd_blocks host tests passed!\n");
    return 0;
}
