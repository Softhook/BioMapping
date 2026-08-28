// benchmark_graph.c — host-side benchmark: canvas_draw_line vs canvas_draw_dot
// for graph rendering.  Simulates a u8g2 page buffer (128×64, 1024 bytes) and
// runs both approaches N times against identical GSR-like data, measuring
// wall-clock time and counting pixel writes.
//
// Build:  gcc -O2 -o build/benchmark_graph tests/benchmarks/benchmark_graph.c -lm
// Run:    ./build/benchmark_graph

#include <stdio.h>
#include <stdint.h>
#include <stdbool.h>
#include <stdlib.h>
#include <time.h>
#include <math.h>
#include <string.h>

// ── Mock framebuffer (u8g2 page buffer: 8 pages × 128 bytes) ──────────
static uint8_t fb[1024];

// Counters
static long dot_calls   = 0;
static long line_calls  = 0;
static long pixels_set  = 0;
static long pixels_set_line = 0;  // separate counter for line-based approach

// ── Mock canvas_draw_dot — clips to canvas, counts calls ───────────────
static void mock_draw_dot(void* c, uint8_t x, uint8_t y) {
    (void)c;
    if(x < 128 && y < 64) {
        fb[x + ((unsigned)y >> 3) * 128] |= (uint8_t)(1U << (y & 7));
        pixels_set++;
    }
    dot_calls++;
}

// ── Mock canvas_draw_line — Bresenham, clips per-pixel, counts calls ───
static void mock_draw_line(void* c, uint8_t x0, uint8_t y0, uint8_t x1, uint8_t y1) {
    (void)c;
    line_calls++;

    int dx  = abs((int)x1 - (int)x0);
    int dy  = -abs((int)y1 - (int)y0);
    int sx  = x0 < x1 ? 1 : -1;
    int sy  = y0 < y1 ? 1 : -1;
    int err = dx + dy;
    int x = (int)x0, y = (int)y0;

    for(;;) {
        if((unsigned)x < 128 && (unsigned)y < 64) {
            fb[x + ((unsigned)y >> 3) * 128] |= (uint8_t)(1U << (y & 7));
            pixels_set_line++;
        }
        if(x == (int)x1 && y == (int)y1) break;
        int e2 = 2 * err;
        if(e2 >= dy) { err += dy; x += sx; }
        if(e2 <= dx) { err += dx; y += sy; }
    }
}

// ── Helper: clamp int to uint8_t canvas range ─────────────────────────
static inline uint8_t clamp_u8(int v, int max) {
    if(v < 0) return 0;
    if(v > max) return (uint8_t)max;
    return (uint8_t)v;
}

// ── GSR-like test data: a 126-sample ring buffer ──────────────────────
#define GRAPH_N 126

// ── OLD approach: canvas_draw_line per segment ────────────────────────
static void draw_graph_line(void* c, const float* buf, int head,
                             int gx, int gy, int gw, int gh,
                             float combined_scale) {
    int n  = gw - 2;
    int cy = gy + gh / 2;

    int idx = head;
    float v0 = buf[idx] * combined_scale;
    int y_prev = cy - (int)v0;

    for(int i = 0; i < n - 1; i++) {
        if(++idx >= GRAPH_N) idx = 0;
        float v1 = buf[idx] * combined_scale;
        int y1 = cy - (int)v1;
        mock_draw_line(c,
            clamp_u8(gx + 1 + i, 127),     clamp_u8(y_prev, 63),
            clamp_u8(gx + 1 + i + 1, 127), clamp_u8(y1, 63));
        y_prev = y1;
    }
}

// ── NEW approach: canvas_draw_dot per column + vertical gap-fill ──────
static void draw_graph_dot(void* c, const float* buf, int head,
                            int gx, int gy, int gw, int gh,
                            float combined_scale) {
    int n  = gw - 2;
    int cy = gy + gh / 2;

    int idx = head;
    float v0 = buf[idx] * combined_scale;
    int y_prev = cy - (int)v0;

    mock_draw_dot(c, clamp_u8(gx + 1, 127), clamp_u8(y_prev, 63));

    for(int i = 1; i < n; i++) {
        if(++idx >= GRAPH_N) idx = 0;
        float v1 = buf[idx] * combined_scale;
        int y_cur = cy - (int)v1;

        mock_draw_dot(c, clamp_u8(gx + 1 + i, 127), clamp_u8(y_cur, 63));

        // Gap-fill: one dot per pixel (expensive at high zoom)
        int gap_lo = y_prev < y_cur ? y_prev + 1 : y_cur + 1;
        int gap_hi = y_prev > y_cur ? y_prev - 1 : y_cur - 1;
        for(int y = gap_lo; y <= gap_hi; y++)
            mock_draw_dot(c, clamp_u8(gx + 1 + i, 127), clamp_u8(y, 63));

        y_prev = y_cur;
    }
}

// ── HYBRID approach: dot per column + single vertical line for gaps ───
// Uses canvas_draw_dot for each sample (no Bresenham for dx=1) and a
// single canvas_draw_line for the vertical gap when |dy| > 1 — one
// function call for the entire gap instead of |dy| dot calls.
static void draw_graph_hybrid(void* c, const float* buf, int head,
                               int gx, int gy, int gw, int gh,
                               float combined_scale) {
    int n  = gw - 2;
    int cy = gy + gh / 2;

    int idx = head;
    float v0 = buf[idx] * combined_scale;
    int y_prev = cy - (int)v0;

    // First column
    mock_draw_dot(c, clamp_u8(gx + 1, 127), clamp_u8(y_prev, 63));

    for(int i = 1; i < n; i++) {
        if(++idx >= GRAPH_N) idx = 0;
        float v1 = buf[idx] * combined_scale;
        int y_cur = cy - (int)v1;

        mock_draw_dot(c, clamp_u8(gx + 1 + i, 127), clamp_u8(y_cur, 63));

        // Vertical gap-fill: one line call for the entire span
        if(y_prev < y_cur - 1) {
            mock_draw_line(c,
                clamp_u8(gx + 1 + i, 127), clamp_u8(y_prev + 1, 63),
                clamp_u8(gx + 1 + i, 127), clamp_u8(y_cur - 1, 63));
        } else if(y_prev > y_cur + 1) {
            mock_draw_line(c,
                clamp_u8(gx + 1 + i, 127), clamp_u8(y_cur + 1, 63),
                clamp_u8(gx + 1 + i, 127), clamp_u8(y_prev - 1, 63));
        }

        y_prev = y_cur;
    }
}

// ── Timing helper ─────────────────────────────────────────────────────
static double now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (double)ts.tv_sec * 1000.0 + (double)ts.tv_nsec / 1e6;
}

// ── Generate realistic GSR-like data ──────────────────────────────────
static void fill_buf(float* buf, int len, float zoom) {
    // Simulate a slow-varying GSR signal with some noise and occasional spikes
    float val = 15.0f;
    for(int i = 0; i < len; i++) {
        // Slow drift + sinusoidal component + noise + occasional spike
        float drift  = sinf((float)i * 0.03f) * 8.0f;
        float wave   = sinf((float)i * 0.15f) * 5.0f;
        float noise  = ((float)rand() / (float)RAND_MAX - 0.5f) * 2.0f;
        float spike  = (rand() % 200 == 0) ? ((float)rand() / (float)RAND_MAX) * 30.0f : 0.0f;
        val = 15.0f + drift + wave + noise + spike;
        buf[i] = val * zoom;  // zoomed samples
    }
}

// ── Main ──────────────────────────────────────────────────────────────
int main(void) {
    srand(42);  // deterministic

    // Test parameters: GPS+GSR+RF mode (narrow graph)
    const int gx = 43, gy = 16, gw = 85, gh = 48;
    const float zoom_levels[] = { 1.0f, 4.0f, 16.0f };
    const int ITERATIONS = 200000;
    const int WARMUP     = 5000;

    float buf_test[GRAPH_N];
    float combined_scale;
    double t0, t1;

    printf("=== Graph rendering benchmark: draw_line vs draw_dot vs hybrid ===\n");
    printf("Graph: %dx%d at (%d,%d), %d iterations, GRAPH_N=%d\n\n",
           gw, gh, gx, gy, ITERATIONS, GRAPH_N);

    for(int zi = 0; zi < 3; zi++) {
        float zoom = zoom_levels[zi];
        combined_scale = zoom * ((float)(gh / 2 - 2) / 100.0f);

        printf("── Zoom %.0fx  (combined_scale=%.3f) ──\n", zoom, (double)combined_scale);

        fill_buf(buf_test, GRAPH_N, 1.0f);

        // ── OLD approach (canvas_draw_line) ────────────────────────
        dot_calls = 0; line_calls = 0; pixels_set = 0; pixels_set_line = 0;
        memset(fb, 0, sizeof(fb));
        for(int i = 0; i < WARMUP; i++)
            draw_graph_line(NULL, buf_test, i % GRAPH_N, gx, gy, gw, gh, combined_scale);
        dot_calls = 0; line_calls = 0; pixels_set = 0; pixels_set_line = 0;
        memset(fb, 0, sizeof(fb));
        t0 = now_ms();
        for(int i = 0; i < ITERATIONS; i++)
            draw_graph_line(NULL, buf_test, i % GRAPH_N, gx, gy, gw, gh, combined_scale);
        t1 = now_ms();
        double line_ms = t1 - t0;
        long line_px = pixels_set_line;
        printf("  draw_line:  %8.2f ms  (%5.0f ns/frame)  %ld line_calls  %ld px\n",
               line_ms, line_ms / (double)ITERATIONS * 1e6, line_calls, line_px);

        // ── draw_dot (dot-only gap-fill) ────────────────────────────
        dot_calls = 0; line_calls = 0; pixels_set = 0; pixels_set_line = 0;
        memset(fb, 0, sizeof(fb));
        for(int i = 0; i < WARMUP; i++)
            draw_graph_dot(NULL, buf_test, i % GRAPH_N, gx, gy, gw, gh, combined_scale);
        dot_calls = 0; line_calls = 0; pixels_set = 0; pixels_set_line = 0;
        memset(fb, 0, sizeof(fb));
        t0 = now_ms();
        for(int i = 0; i < ITERATIONS; i++)
            draw_graph_dot(NULL, buf_test, i % GRAPH_N, gx, gy, gw, gh, combined_scale);
        t1 = now_ms();
        double dot_ms = t1 - t0;
        long dot_calls_n = dot_calls;
        printf("  draw_dot:   %8.2f ms  (%5.0f ns/frame)  %ld dot_calls  %ld px",
               dot_ms, dot_ms / (double)ITERATIONS * 1e6, dot_calls_n, pixels_set);
        printf("  %.2f× vs line\n", line_ms / dot_ms);

        // ── HYBRID approach (dot + vertical line for gaps) ──────────
        dot_calls = 0; line_calls = 0; pixels_set = 0; pixels_set_line = 0;
        memset(fb, 0, sizeof(fb));
        for(int i = 0; i < WARMUP; i++)
            draw_graph_hybrid(NULL, buf_test, i % GRAPH_N, gx, gy, gw, gh, combined_scale);
        dot_calls = 0; line_calls = 0; pixels_set = 0; pixels_set_line = 0;
        memset(fb, 0, sizeof(fb));
        t0 = now_ms();
        for(int i = 0; i < ITERATIONS; i++)
            draw_graph_hybrid(NULL, buf_test, i % GRAPH_N, gx, gy, gw, gh, combined_scale);
        t1 = now_ms();
        double hyb_ms = t1 - t0;
        printf("  hybrid:     %8.2f ms  (%5.0f ns/frame)  %ld dot + %ld line  %ld px",
               hyb_ms, hyb_ms / (double)ITERATIONS * 1e6, dot_calls, line_calls, pixels_set);
        printf("  %.2f× vs line,  %.2f× vs dot\n\n",
               line_ms / hyb_ms, dot_ms / hyb_ms);
    }

    printf("=== Summary ===\n");
    printf("Hybrid approach: draw_dot for each sample column + draw_line\n");
    printf("for vertical gaps when |dy| > 1.  Best of both — avoids\n");
    printf("Bresenham for the common case (|dy| ≤ 1) and avoids the\n");
    printf("per-pixel function-call explosion of dot-only gap-fill at high zoom.\n");

    return 0;
}
