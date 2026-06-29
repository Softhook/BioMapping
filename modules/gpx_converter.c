// =============================================================================
//  GPX Converter — biomap_*.csv  →  biomap_*.gpx
// =============================================================================
//
//  OVERVIEW
//  ────────
//  Reads a Bio Mapping CSV log and writes a GPX track file where each
//  trackpoint's <ele> (elevation) encodes the GSR rate‑of‑change:
//
//      0   = calm / steady GSR  (no emotional event)
//      255 = maximum GSR change  (strongest emotional event)
//
//  Both rapid rises AND rapid drops in GSR produce high elevation —
//  only the magnitude of change matters, not the direction.
//
//
//  HOW RATE‑OF‑CHANGE IS COMPUTED
//  ──────────────────────────────
//
//  1. Raw GSR values are fed into a Simple Moving Average (SMA) with a
//     configurable window of GPX_RATE_WINDOW samples.
//
//  2. The SMA smooths out sensor noise.  A larger window ignores short
//     twitches and only reacts to big, sustained changes.
//
//  3. Rate = SMA_current − SMA_previous
//     This is the slope of the smoothed GSR signal — how fast the
//     moving average changed from one step to the next.
//
//  4. |Rate| is normalised to [0, 255] against the global maximum |rate|
//     found across the entire recording.
//
//  Example (window = 8, 1 sample/sec):
//    sec  1‑7   → window filling, no rates emitted
//    sec  8     → first full‑window SMA, stored as baseline
//    sec  9     → (samples 2‑9) − (samples 1‑8)  = first real rate
//    sec 10     → (samples 3‑10) − (samples 2‑9) = second rate
//    …and so on.
//
//  Outlier protection:  |rate| is capped at GPX_MAX_ABS_RATE (500.0
//  by default) so a single sensor glitch cannot hijack the scale.
//
//
//  TWO‑PASS DESIGN (memory‑safe)
//  ─────────────────────────────
//
//  Pass 1 — Scan every CSV row, run SMA, track max |rate| across the
//           entire walk.  Uses full csv_split so row filtering is
//           identical to pass 2.  O(1) memory.
//
//  Pass 2 — Re‑read the CSV, re‑run the identical SMA sequence (the
//           output is deterministic), normalise each |rate| → [0,255],
//           and write GPX trackpoints for every row with a GPS fix.
//
//  No heap allocation per row.  Two SmaState structs (one per pass)
//  each use GPX_RATE_WINDOW × 2 bytes — 16 bytes at the default of 8.
//
//
//  RELIABILITY
//  ───────────
//  • Buffered I/O — reads 256‑byte chunks, writes 512‑byte chunks.
//  • Watchdog petting — furi_delay_ms(1) every 64 lines.
//  • CSV format:  timestamp,lat,lon,alt,sats,fix,gsr_raw
//
//
//  TUNING
//  ──────
//  Change GPX_RATE_WINDOW in gpx_converter.h to experiment:
//    3  → reacts to every tiny twitch
//    8  → moderate smoothing (default)
//    20 → only big, sustained emotional events
// =============================================================================

#include "gpx_converter.h"
#include <furi.h>
#include <gui/view_port.h>
#include <storage/storage.h>
#include <string.h>
#include <stdio.h>

#include <math.h>

#define TAG             "GpxConverter"

/* ── buffered line-reader ───────────────────────────────────────────── */

#define LR_BUF_SZ        256          // read-ahead buffer (bytes)

typedef struct {
    File*   file;
    uint8_t buf[LR_BUF_SZ];
    int     pos;                       // next byte to return
    int     len;                       // valid bytes in buf (0 = EOF)
} LineReader;

static void lr_init(LineReader* lr, File* f) {
    lr->file = f;
    lr->pos  = 0;
    lr->len  = 0;
}

// Return next byte or -1 on EOF.
static int lr_getc(LineReader* lr) {
    if(lr->pos >= lr->len) {
        lr->len = (int)storage_file_read(lr->file, lr->buf, LR_BUF_SZ);
        lr->pos = 0;
        if(lr->len <= 0) return -1;
    }
    return (int)lr->buf[lr->pos++];
}

// Read one line (strips \r, stops at \n or EOF).  Returns true when
// a complete line was read (may be empty).
static bool lr_read_line(LineReader* lr, char* out, size_t sz) {
    size_t pos = 0;
    while(pos < sz - 1) {
        int ch = lr_getc(lr);
        if(ch < 0) { out[pos] = '\0'; return pos > 0; }
        if(ch == '\n') { out[pos] = '\0'; return true; }
        if(ch == '\r') continue;
        out[pos++] = (char)ch;
    }
    out[pos] = '\0';
    return true;
}

/* ── buffered writer ────────────────────────────────────────────────── */

#define WB_BUF_SZ        512          // write-back buffer (bytes)

typedef struct {
    File*   file;
    char    buf[WB_BUF_SZ];
    int     pos;
} WriteBuf;

static bool wb_flush(WriteBuf* wb);  // forward

static void wb_init(WriteBuf* wb, File* f) {
    wb->file = f;
    wb->pos  = 0;
}

// Append a string; flushes automatically when the buffer is full.
static bool wb_str(WriteBuf* wb, const char* s) {
    size_t len = strlen(s);
    if(len > WB_BUF_SZ) {
        // Oversized string — flush first, then write directly.
        if(!wb_flush(wb)) return false;
        return storage_file_write(wb->file, s, len) == len;
    }
    if(wb->pos + (int)len > WB_BUF_SZ) {
        if(!wb_flush(wb)) return false;
    }
    memcpy(wb->buf + wb->pos, s, len);
    wb->pos += (int)len;
    return true;
}

static bool wb_flush(WriteBuf* wb) {
    if(wb->pos == 0) return true;
    bool ok = storage_file_write(wb->file, wb->buf, (size_t)wb->pos) == (size_t)wb->pos;
    wb->pos = 0;
    return ok;
}

/* ── tiny parsers (no libc atof / atoi — Flipper API disables them) ── */

static float str_to_float(const char* s) {
    float r = 0, sign = 1, frac = 0, div = 1;
    if(*s == '-') { sign = -1; s++; }
    while(*s >= '0' && *s <= '9') { r = r * 10 + (*s++ - '0'); }
    if(*s == '.') { s++; while(*s >= '0' && *s <= '9') { frac = frac * 10 + (*s++ - '0'); div *= 10; } }
    return sign * (r + frac / div);
}

static int str_to_int(const char* s) {
    int r = 0, sign = 1;
    if(*s == '-') { sign = -1; s++; }
    while(*s >= '0' && *s <= '9') { r = r * 10 + (*s++ - '0'); }
    return sign * r;
}

/* ── CSV tokeniser (in‑place, zero‑terminates each field) ──────────── */

// Split a line on commas.  Returns token count.  tok[0] points to start
// of line; up to 7 tokens supported (ts,lat,lon,alt,sats,fix,raw).
static int csv_split(char* line, char** tok, int max_tok) {
    int n = 0;
    tok[n++] = line;
    for(char* p = line; *p && n < max_tok; p++) {
        if(*p == ',') { *p = '\0'; tok[n++] = p + 1; }
    }
    return n;
}


/* ── GPX converter object ───────────────────────────────────────────── */

struct GpxConverter {
    Storage* storage;
    char     filenames[GPX_MAX_CSV_FILES][32];
    int      file_count;
};

GpxConverter* gpx_converter_alloc(Storage* storage) {
    GpxConverter* c = malloc(sizeof(GpxConverter));
    memset(c, 0, sizeof(*c));
    c->storage = storage;
    return c;
}

void gpx_converter_free(GpxConverter* c) { furi_assert(c); free(c); }

// Parse the file index from biomap_xxx.csv (returns -1 if invalid/non-numeric)
static int parse_file_index(const char* name) {
    size_t len = strlen(name);
    if(len < 12) return -1;
    if(strncmp(name, "biomap_", 7) != 0) return -1;
    if(strcmp(name + len - 4, ".csv") != 0) return -1;

    int idx = 0;
    const char* p = name + 7;
    while(p < name + len - 4) {
        if(*p < '0' || *p > '9') return -1;
        if(idx > 99999) return -1; // overflow protection
        idx = idx * 10 + (*p - '0');
        p++;
    }
    return idx;
}

// Insertion sort by index — no stdlib dependency, O(n²) is fine for ≤32 files
static void sort_filenames_by_index(char names[][32], int* indices, int count) {
    for(int i = 1; i < count; i++) {
        char tmp_name[32];
        memcpy(tmp_name, names[i], 32);
        int tmp_idx = indices[i];
        int j = i - 1;
        while(j >= 0 && indices[j] > tmp_idx) {
            memcpy(names[j + 1], names[j], 32);
            indices[j + 1] = indices[j];
            j--;
        }
        memcpy(names[j + 1], tmp_name, 32);
        indices[j + 1] = tmp_idx;
    }
}

int gpx_converter_scan(GpxConverter* c) {
    furi_assert(c);
    c->file_count = 0;

    int indices[GPX_MAX_CSV_FILES];
    memset(indices, 0, sizeof(indices));

    File* dir = storage_file_alloc(c->storage);
    if(!storage_dir_open(dir, "/ext/biomapping")) {
        FURI_LOG_E(TAG, "Cannot open /ext/biomapping");
        storage_file_free(dir);
        return 0;
    }

    FileInfo info;
    char     name[64];
    while(storage_dir_read(dir, &info, name, sizeof(name))) {
        if(info.flags & FSF_DIRECTORY) continue;
        size_t len = strlen(name);
        if(len < 12) continue;
        if(strncmp(name, "biomap_", 7) != 0) continue;
        if(strcmp(name + len - 4, ".csv") != 0) continue;

        int idx = parse_file_index(name);
        if(idx < 0) idx = 0; // fallback for malformed names

        if(c->file_count < GPX_MAX_CSV_FILES) {
            strncpy(c->filenames[c->file_count], name, 31);
            c->filenames[c->file_count][31] = '\0';
            indices[c->file_count] = idx;
            c->file_count++;
        } else {
            // Find the element with the minimum index to evict
            int min_pos = 0;
            int min_idx = indices[0];
            for(int i = 1; i < GPX_MAX_CSV_FILES; i++) {
                if(indices[i] < min_idx) {
                    min_idx = indices[i];
                    min_pos = i;
                }
            }
            // If the new file has a larger index, replace the minimum element
            if(idx > min_idx) {
                strncpy(c->filenames[min_pos], name, 31);
                c->filenames[min_pos][31] = '\0';
                indices[min_pos] = idx;
            }
        }
    }
    storage_dir_close(dir);
    storage_file_free(dir);

    if(c->file_count > 1) {
        sort_filenames_by_index(c->filenames, indices, c->file_count);
    }

    FURI_LOG_I(TAG, "%d CSV file(s) found", c->file_count);
    return c->file_count;
}

const char* gpx_converter_get_name(const GpxConverter* c, int index) {
    furi_assert(c);
    return (index >= 0 && index < c->file_count) ? c->filenames[index] : NULL;
}

/* ── SMA (Simple Moving Average) rate-of-change helper ──────────────── */

// Self-contained state so pass 1 and pass 2 produce identical results.
typedef struct {
    int32_t buf[GPX_RATE_WINDOW];   // circular buffer of raw GSR values
    int     head;                    // next write slot
    int     count;                   // values stored so far (0 … WINDOW)
    float   sum;                     // running sum (maintained incrementally)
    float   prev_sma;               // SMA from previous step
    bool    rate_ready;              // true once we have a full-window baseline
} SmaState;

static void sma_init(SmaState* s) {
    memset(s, 0, sizeof(*s));
}

// Feed one raw GSR value; returns the rate-of-change (SMA delta),
// or 0.0f while the window is still filling.
//
// Warm‑up example (window = 8):
//   rows 1‑7  → filling, no SMA, return 0.0
//   row  8    → first full‑window SMA, stored as baseline, return 0.0
//   row  9    → second full‑window SMA, rate = SMA₂ − SMA₁  ← first real rate
static float sma_feed(SmaState* s, int32_t raw) {
    // Maintain circular buffer and running sum (O(1) per step)
    if(s->count == GPX_RATE_WINDOW) {
        s->sum -= s->buf[s->head];          // evict oldest
    }
    s->buf[s->head] = raw;
    s->sum += raw;
    s->head = (s->head + 1) % GPX_RATE_WINDOW;
    if(s->count < GPX_RATE_WINDOW) s->count++;

    // No rates until the window is fully populated
    if(s->count < GPX_RATE_WINDOW) return 0.0f;

    float sma = s->sum / (float)GPX_RATE_WINDOW;

    if(!s->rate_ready) {
        // First full‑window SMA — store as baseline
        s->prev_sma   = sma;
        s->rate_ready = true;
        return 0.0f;
    }

    float rate  = sma - s->prev_sma;
    s->prev_sma = sma;
    return rate;
}

/* ── two‑pass conversion ────────────────────────────────────────────── */

int gpx_converter_run(GpxConverter* c, const char* csv_filename,
                       void* progress_vp) {
    furi_assert(c);
    furi_assert(csv_filename);

    /* ----- path setup ------------------------------------------------ */
    char csv_path[128];
    snprintf(csv_path, sizeof(csv_path), EXT_PATH("biomapping/%s"), csv_filename);

    char gpx_path[128];
    strncpy(gpx_path, csv_path, sizeof(gpx_path) - 1);
    gpx_path[sizeof(gpx_path) - 1] = '\0';
    size_t plen = strlen(gpx_path);
    if(plen < 4 || strcmp(gpx_path + plen - 4, ".csv") != 0) {
        FURI_LOG_E(TAG, "Not a .csv: %s", csv_filename);
        return 0;
    }
    gpx_path[plen - 3] = 'g'; gpx_path[plen - 2] = 'p'; gpx_path[plen - 1] = 'x';
    FURI_LOG_I(TAG, "%s -> %s (window=%d)", csv_path, gpx_path, GPX_RATE_WINDOW);

    /* ==================================================================
     * PASS 1 — find global max |rate|
     * ================================================================ */
    File* csv1 = storage_file_alloc(c->storage);
    if(!storage_file_open(csv1, csv_path, FSAM_READ, FSOM_OPEN_EXISTING)) {
        FURI_LOG_E(TAG, "Cannot open %s for pass 1", csv_path);
        storage_file_free(csv1);
        return 0;
    }

    LineReader lr1;
    lr_init(&lr1, csv1);

    char     line[256];
    float    max_abs_rate = 0.0f;
    SmaState sma1;
    sma_init(&sma1);
    int      rows_scanned  = 0;
    int      rows_skipped  = 0;
    bool     has_any_fix   = false;
    bool     has_any_gsr   = false;

    // Skip CSV header
    lr_read_line(&lr1, line, sizeof(line));

    while(lr_read_line(&lr1, line, sizeof(line))) {
        if(!line[0]) continue;

        // Use full csv_split so row filtering matches pass 2 exactly
        char* tok[7];
        int nt = csv_split(line, tok, 7);
        if(nt < 7) { rows_skipped++; continue; }

        int32_t raw = str_to_int(tok[6]);
        int     fix = str_to_int(tok[5]);
        float   lat = str_to_float(tok[1]);
        float   lon = str_to_float(tok[2]);

        if(raw != 0) has_any_gsr = true;
        if(fix > 0 && fabsf(lat) > 0.0001f && fabsf(lon) > 0.0001f) has_any_fix = true;

        float rate = sma_feed(&sma1, raw);

        // sma_feed returns 0.0 until window is full + baseline stored
        if(!sma1.rate_ready) continue;

        float abs_rate = fabsf(rate);
        // Clamp outliers (sensor glitch / static discharge)
        if(abs_rate > GPX_MAX_ABS_RATE) abs_rate = GPX_MAX_ABS_RATE;
        if(abs_rate > max_abs_rate) max_abs_rate = abs_rate;
        rows_scanned++;

        if((rows_scanned & 63) == 0) {
            if(progress_vp) view_port_update((ViewPort*)progress_vp);
            furi_delay_ms(1);  // pet watchdog
        }
    }

    storage_file_close(csv1);
    storage_file_free(csv1);

    // GSR‑only recording — no GPS fix rows → don't create a GPX
    if(!has_any_fix) {
        FURI_LOG_W(TAG, "No GPS fix rows — GSR‑only recording, skipping GPX");
        return 0;
    }

    // GPS‑only recording (all GSR = 0) → still produce GPX with flat ele=0
    if(!has_any_gsr) {
        FURI_LOG_I(TAG, "All GSR values zero — GPS‑only recording, ele=0 throughout");
    }

    if(max_abs_rate < 0.001f) {
        max_abs_rate = 1.0f;   // GPS‑only: avoid division by zero, all ele → 0
    }

    FURI_LOG_I(TAG, "Pass 1: %d rate rows (%d skipped, window=%d), max |rate| = %.1f",
               rows_scanned, rows_skipped, GPX_RATE_WINDOW, (double)max_abs_rate);

    /* ==================================================================
     * PASS 2 — re‑read, normalise, write GPX
     * ================================================================ */
    File* csv2 = storage_file_alloc(c->storage);
    if(!storage_file_open(csv2, csv_path, FSAM_READ, FSOM_OPEN_EXISTING)) {
        FURI_LOG_E(TAG, "Cannot open %s for pass 2", csv_path);
        storage_file_free(csv2);
        return 0;
    }

    File* gpx = storage_file_alloc(c->storage);
    if(!storage_file_open(gpx, gpx_path, FSAM_WRITE, FSOM_CREATE_ALWAYS)) {
        FURI_LOG_E(TAG, "Cannot create %s", gpx_path);
        storage_file_close(csv2);
        storage_file_free(csv2);
        storage_file_free(gpx);
        return 0;
    }

    WriteBuf wb;
    wb_init(&wb, gpx);

    LineReader lr2;
    lr_init(&lr2, csv2);

    int points      = 0;   // declared before goto that jumps to done:
    int rows_done   = 0;
    int rows_no_fix = 0;

    // Write GPX header through the buffer
    if(!wb_str(&wb,
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
        "<gpx version=\"1.1\" creator=\"Bio Mapping\">\n"
        "  <trk>\n"
        "    <name>Bio Mapping Walk</name>\n"
        "    <trkseg>\n")) {
        FURI_LOG_E(TAG, "GPX header write failed");
        wb_flush(&wb);
        goto done;
    }

    // Skip CSV header
    lr_read_line(&lr2, line, sizeof(line));

    SmaState sma2;
    sma_init(&sma2);

    while(lr_read_line(&lr2, line, sizeof(line))) {
        if(!line[0]) continue;

        // Full 7‑token split — identical filtering to pass 1
        char* tok[7];
        int nt = csv_split(line, tok, 7);
        if(nt < 7) continue;

        char  ts[32];
        strncpy(ts, tok[0], sizeof(ts) - 1);
        ts[sizeof(ts) - 1] = '\0';
        float lat = str_to_float(tok[1]);
        float lon = str_to_float(tok[2]);
        int   fix = str_to_int(tok[5]);
        int   raw = str_to_int(tok[6]);

        float rate = sma_feed(&sma2, raw);

        // Skip rows before the SMA window has produced real rates
        if(!sma2.rate_ready) { rows_done++; continue; }

        // Normalise absolute rate → [0, 255]  (calm=0, big change=255)
        float abs_rate = fabsf(rate);
        if(abs_rate > GPX_MAX_ABS_RATE) abs_rate = GPX_MAX_ABS_RATE;
        uint8_t ele = (uint8_t)((abs_rate / max_abs_rate) * 255.0f + 0.5f);

        if(fix > 0 && fabsf(lat) > 0.0001f && fabsf(lon) > 0.0001f) {
            char pt[256];
            int  n = snprintf(pt, sizeof(pt),
                "      <trkpt lat=\"%.6f\" lon=\"%.6f\">\n"
                "        <ele>%u</ele>\n"
                "        <time>%s</time>\n"
                "      </trkpt>\n",
                (double)lat, (double)lon, (unsigned)ele, ts);
            if(n > 0 && n < (int)sizeof(pt)) {
                if(!wb_str(&wb, pt)) {
                    FURI_LOG_E(TAG, "GPX trackpoint write failed, aborting");
                    points = 0;
                    goto done;
                }
                points++;
            }
        } else {
            rows_no_fix++;
        }

        rows_done++;
        if((rows_done & 63) == 0) {
            if(progress_vp) view_port_update((ViewPort*)progress_vp);
            furi_delay_ms(1);  // pet watchdog
        }
    }

    if(!wb_str(&wb,
        "    </trkseg>\n"
        "  </trk>\n"
        "</gpx>\n") || !wb_flush(&wb)) {
        FURI_LOG_E(TAG, "GPX footer write failed");
        points = 0;
    }

    if(points == 0) {
        FURI_LOG_W(TAG, "No GPS fix rows or write failed — GSR‑only recording? (%d rows skipped)",
                   rows_no_fix);
    } else {
        FURI_LOG_I(TAG, "%d trackpoints written (%d rows, %d no-fix)",
                   points, rows_done, rows_no_fix);
    }

done:
    storage_file_close(csv2);
    storage_file_free(csv2);
    storage_file_close(gpx);
    storage_file_free(gpx);
    return points;
}
