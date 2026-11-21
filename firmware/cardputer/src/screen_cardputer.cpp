#include "screen_cardputer.h"

#include <math.h>
#include <stdio.h>
#include <string.h>

#include "biomap_screen.h"
#include "bt_cardputer.h"
#include "sd_cardputer.h"
#include "session_cardputer.h"

static const int DISP_W = 240;
static const int DISP_H = 135;

// Stretch a 128 × 64 layout coordinate to 240 × 135.
static inline int sx(int x) { return (x * DISP_W + SCREEN_W / 2) / SCREEN_W; }
static inline int sy(int y) { return (y * DISP_H + SCREEN_H / 2) / SCREEN_H; }

// One layout unit in device pixels (at least 1).
static inline int sw(int x, int w) {
    int w_px = sx(x + w) - sx(x);
    return w_px > 0 ? w_px : 1;
}
static inline int sh(int y, int h) {
    int h_px = sy(y + h) - sy(y);
    return h_px > 0 ? h_px : 1;
}

struct DrawCtx {
    M5Canvas*   canvas;
    ScreenFont  font = ScreenFontSecondary;
    bool        inverted = false;
    bool        recording = false;
    bool        retrying = false;
    bool        write_stopped = false;
    uint32_t    last_graph_tick_ms = 0;
};

static uint16_t fg_color(const DrawCtx* c) {
    return c->inverted ? TFT_BLACK : TFT_WHITE;
}

static void cp_clear(void* ctx) {
    auto* c = static_cast<DrawCtx*>(ctx);
    c->canvas->fillSprite(TFT_BLACK);
    c->inverted = false;
    c->font = ScreenFontSecondary;
    c->canvas->setFont(&fonts::Font2);
    c->canvas->setTextDatum(textdatum_t::top_left);
}

static void cp_set_font(void* ctx, ScreenFont font) {
    auto* c = static_cast<DrawCtx*>(ctx);
    c->font = font;
    c->canvas->setFont(&fonts::Font2);
}

static void cp_draw_str(void* ctx, int x, int y, const char* text) {
    auto* c = static_cast<DrawCtx*>(ctx);
    // In layout units, `y` is the text baseline (about 8 units below the
    // top of the glyph). Font2 is 16 px tall; sy(y) - 14 aligns the baseline.
    int py = sy(y) - 14;
    if(py < 0) py = 0;
    if(py > DISP_H - 16) py = DISP_H - 16;
    int px = sx(x);
    uint16_t col = (c->inverted && c->write_stopped) ? TFT_WHITE : fg_color(c);
    c->canvas->setTextColor(col);
    c->canvas->drawString(text, px, py);
    if(c->font == ScreenFontPrimary) {
        c->canvas->drawString(text, px + 1, py);
    }
}

static int cp_str_width(void* ctx, const char* text) {
    auto* c = static_cast<DrawCtx*>(ctx);
    int w_px = c->canvas->textWidth(text);
    if(c->font == ScreenFontPrimary && w_px > 0) w_px += 1;
    // Convert device pixel width back into 128-wide layout units, rounded up
    // so right-aligned text never clips past the right edge (biomap_screen.h).
    return (w_px * SCREEN_W + DISP_W - 1) / DISP_W;
}

static void cp_draw_dot(void* ctx, int x, int y) {
    auto* c = static_cast<DrawCtx*>(ctx);
    c->canvas->fillRect(sx(x), sy(y), sw(x, 1), sh(y, 1), TFT_CYAN);
}

static void cp_draw_line(void* ctx, int x1, int y1, int x2, int y2) {
    auto* c = static_cast<DrawCtx*>(ctx);
    int px1 = sx(x1), py1 = sy(y1), px2 = sx(x2), py2 = sy(y2);
    c->canvas->drawLine(px1, py1, px2, py2, TFT_LIGHTGREY);
}

static void cp_draw_box(void* ctx, int x, int y, int w, int h) {
    auto* c = static_cast<DrawCtx*>(ctx);
    uint16_t col = fg_color(c);
    // Recording indicator (top right) and SD-error banner (full width at top).
    if(x == 118 && y == 1 && w == 8 && h == 8) {
        col = c->retrying ? TFT_ORANGE : TFT_RED;
    } else if(x == 0 && y == 0 && w == SCREEN_W && c->write_stopped) {
        col = TFT_RED;
    }
    c->canvas->fillRect(sx(x), sy(y), sw(x, w), sh(y, h), col);
}

static void cp_draw_frame(void* ctx, int x, int y, int w, int h) {
    auto* c = static_cast<DrawCtx*>(ctx);
    c->canvas->drawRect(sx(x), sy(y), sw(x, w), sh(y, h), TFT_DARKGREY);
}

static void cp_invert(void* ctx) {
    auto* c = static_cast<DrawCtx*>(ctx);
    c->inverted = !c->inverted;
}

// ── Native 240 × 135 smooth spline GSR waveform ──────────────────────────
//
// Evaluates a Catmull-Rom cubic spline across the smoothed GSR rate buffer at
// full 240 px horizontal resolution, with sub-tick fractional time scrolling
// (30 FPS) so the curve glides continuously from right to left instead of
// jumping in 2 Hz steps.

// Zero-phase 3-tap binomial smoothing ([0.25, 0.5, 0.25]) over the linearised
// sample array `s` of length `N` to remove single-sample ADC aliasing spikes
// (see research/gsr_filtering_analysis.md, Finding 2) while preserving every
// real phasic GSR wave.
static float filtered_sample(const float* s, int n, int idx) {
    if(idx <= 0) return 0.75f * s[0] + 0.25f * s[1];
    if(idx >= n - 1) return 0.25f * s[n - 2] + 0.75f * s[n - 1];
    return 0.25f * s[idx - 1] + 0.50f * s[idx] + 0.25f * s[idx + 1];
}

// Catmull-Rom cubic spline between p1 and p2 for t in [0, 1].
static float catmull_rom(float p0, float p1, float p2, float p3, float t) {
    float t2 = t * t;
    float t3 = t2 * t;
    return 0.5f * ((2.0f * p1) +
                   (-p0 + p2) * t +
                   (2.0f * p0 - 5.0f * p1 + 4.0f * p2 - p3) * t2 +
                   (-p0 + 3.0f * p1 - 3.0f * p2 + p3) * t3);
}

static inline int clamp_int(int v, int lo, int hi) {
    return v < lo ? lo : (v > hi ? hi : v);
}

static void cp_draw_graph(void* ctx, const SessionCore* s, int layout_gx, int layout_gy,
                          int layout_gw, int layout_gh, bool visible) {
    auto* c = static_cast<DrawCtx*>(ctx);
    M5Canvas& canvas = *c->canvas;
    const int gx = sx(layout_gx);
    const int gy = sy(layout_gy);
    const int gw = sw(layout_gx, layout_gw);
    const int gh = sh(layout_gy, layout_gh);
    const int y0 = gy + 2;
    const int y1 = gy + gh - 3;
    const int cy = (y0 + y1) / 2;

    // Subtle background grid: centre zero-rate baseline + quarter lines.
    static const uint16_t COL_FRAME     = 0x2965;  // slate border
    static const uint16_t COL_GRID      = 0x10A2;  // subtle dark grid
    static const uint16_t COL_ZERO_LINE = 0x2124;  // centre baseline
    static const uint16_t COL_GLOW      = 0x0451;  // mid-cyan anti-alias halo
    static const uint16_t COL_CURVE     = 0x3FFF;  // bright cyan main trace

    int qh = (y1 - y0) / 4;
    canvas.drawFastHLine(gx + 1, cy - qh, gw - 2, COL_GRID);
    canvas.drawFastHLine(gx + 1, cy + qh, gw - 2, COL_GRID);
    for(int x = gx + 4; x < gx + gw - 2; x += 4) {
        canvas.drawPixel(x, cy, COL_ZERO_LINE);
        canvas.drawPixel(x + 1, cy, COL_ZERO_LINE);
    }

    // 10-second time marks along the top of the graph frame. Each mark is
    // tied to a sample, so it scrolls left with the curve (including the
    // sub-step glide) and drops off the left edge.
    const int n = layout_gw - 2;
    const GraphRing* ring = graph_shown(&s->pipeline.graph);
    const uint32_t div = (uint32_t)graph_divider(&s->pipeline.graph);
    const uint32_t ticks = s->pipeline.graph.ticks;

    // How far the curve has moved toward its next sample, 0 .. 1: the
    // whole ticks since the ring last stepped, plus how far into the
    // current tick we are.
    float tick_frac = (float)(millis() - c->last_graph_tick_ms) / (1000.0f / TICK_HZ);
    if(tick_frac > 1.0f) tick_frac = 1.0f;
    float phase = ((float)(ticks % div) + tick_frac) / (float)div;
    if(phase > 1.0f) phase = 1.0f;

    const uint32_t ticks_per_notch = 10 * TICK_HZ;
    float samples_per_notch = (float)ticks_per_notch / (float)div;
    if(samples_per_notch > 2.0f) {
        float px_per_sample = (float)(gw - 3) / (float)(n - 2);
        float px_per_notch = samples_per_notch * px_per_sample;
        // How many samples ago the newest mark was. The ring's newest
        // sample was taken at tick (ticks - ticks % div); marks sit on
        // every 10 s of graph ticks.
        uint32_t newest_tick = ticks - ticks % div;
        float age_samples = (float)(newest_tick % ticks_per_notch) / (float)div;
        // Sample index i sits at x = right + (i - (n - 2) - phase) * px_per_sample,
        // the same mapping the curve uses below; the newest sample is n - 1.
        float right = (float)(gx + gw - 2);
        float xf = right + (1.0f - age_samples - phase) * px_per_sample;
        int notch_top = gy >= 5 ? gy - 5 : 0;
        for(; xf > (float)(gx + 2); xf -= px_per_notch) {
            if(xf > right) continue;  // not scrolled into view yet
            int x = (int)(xf + 0.5f);
            canvas.drawFastVLine(x, notch_top, gy - notch_top, TFT_DARKGREY);
        }
    }

    if(visible) {
        // Linearise the newest `n` samples from the circular buffer:
        // raw_s[0] is oldest (left), raw_s[n-1] is newest (right).
        float raw_s[GRAPH_N];
        int start = (ring->head + GRAPH_N - n) % GRAPH_N;
        for(int i = 0; i < n; i++) {
            raw_s[i] = ring->buf[(start + i) % GRAPH_N];
        }
        float filt[GRAPH_N];
        for(int i = 0; i < n; i++) {
            filt[i] = filtered_sample(raw_s, n, i);
        }

        // Scale to vertical pixels (48 layout units → gh device pixels).
        const float scale = s->pipeline.zoom.level * ((float)((y1 - y0) / 2 - 2) / 100.0f);
        const int plot_w = gw - 2;  // pixels gx+1 .. gx+gw-2

        int prev_y = cy;
        for(int px = 0; px < plot_w; px++) {
            // Map pixel column `px` into sample index [0 .. n-2], shifted
            // forward by `phase` so the curve glides left as time advances
            // toward the next sample arrival.
            float u = ((float)px / (float)(plot_w - 1)) * (float)(n - 2) + phase;
            int idx = (int)u;
            float t = u - (float)idx;
            if(idx < 0) { idx = 0; t = 0.0f; }
            if(idx > n - 2) { idx = n - 2; t = 1.0f; }

            float p0 = filt[idx > 0 ? idx - 1 : 0];
            float p1 = filt[idx];
            float p2 = filt[idx + 1];
            float p3 = filt[idx + 2 < n ? idx + 2 : n - 1];

            float val = catmull_rom(p0, p1, p2, p3, t) * scale;
            int y_cur = clamp_int((int)lroundf((float)cy - val), y0, y1);
            int x_cur = gx + 1 + px;

            // Connect from the previous column with a 2 px thick anti-aliased
            // cyan ribbon so steep slopes are solid and smooth.
            if(px == 0) prev_y = y_cur;
            int y_lo = prev_y < y_cur ? prev_y : y_cur;
            int y_hi = prev_y > y_cur ? prev_y : y_cur;

            // Outer glow pixels 1 px above and below the stroke.
            if(y_lo > y0) canvas.drawPixel(x_cur, y_lo - 1, COL_GLOW);
            if(y_hi < y1) canvas.drawPixel(x_cur, y_hi + 1, COL_GLOW);

            // Solid core stroke across [y_lo .. y_hi].
            canvas.drawFastVLine(x_cur, y_lo, y_hi - y_lo + 1, COL_CURVE);

            prev_y = y_cur;
        }
    }

    // Outer frame drawn over the fill edges.
    canvas.drawRect(gx, gy, gw, gh, COL_FRAME);

    // Zoom label in the bottom-left corner of the graph.
    if(visible) {
        char zbuf[16];
        snprintf(zbuf, sizeof(zbuf), "%.1fx", (double)s->pipeline.zoom.level);
        canvas.setFont(&fonts::Font2);
        canvas.setTextColor(TFT_LIGHTGREY);
        canvas.drawString(zbuf, gx + 5, gy + gh - 18);
    }
}

void screen_cardputer_draw_session(M5Canvas& canvas) {
    session_cardputer_lock();
    const SessionCore& s = g_session.core;

    DrawCtx dctx;
    dctx.canvas = &canvas;
    dctx.recording = s.recording.active;
    dctx.retrying = s.recording.flush_fail_streak > 0;
    dctx.write_stopped = s.recording.write_stopped;
    dctx.last_graph_tick_ms = g_session.last_graph_tick_ms;

    ScreenExtras extras = {};
    extras.file_name = g_session.logger ? sd_logger_get_filename(g_session.logger) : nullptr;
    extras.rf_dbm = nullptr;
    extras.link = g_session.bt_active ? bt_cardputer_get_link() : ScreenLinkUnavailable;
    extras.link_dropped = g_session.bt_active ? bt_cardputer_get_drop_count() : 0;

    ScreenDraw draw = {};
    draw.ctx = &dctx;
    draw.clear = cp_clear;
    draw.set_font = cp_set_font;
    draw.draw_str = cp_draw_str;
    draw.str_width = cp_str_width;
    draw.draw_dot = cp_draw_dot;
    draw.draw_line = cp_draw_line;
    draw.draw_box = cp_draw_box;
    draw.draw_frame = cp_draw_frame;
    draw.invert = cp_invert;
    draw.draw_graph = cp_draw_graph;

    screen_draw_session(&draw, &s, &extras, &g_session.screen);
    session_cardputer_unlock();

    // Cardputer-specific overlay: if Enter was pressed in GPS+GSR mode before
    // the GPS clock was set, show a brief banner at the top.
    if(session_cardputer_no_time_notice()) {
        canvas.fillRect(0, 0, DISP_W, 20, TFT_YELLOW);
        canvas.setFont(&fonts::Font2);
        canvas.setTextColor(TFT_BLACK);
        canvas.drawString("Waiting for GPS time...", 6, 2);
    }
}
