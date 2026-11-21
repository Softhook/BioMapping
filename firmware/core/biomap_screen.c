// Copyright (c) 2026 Christian Nold
// Licensed under the Bio Mapping Community Licence 1.0.
// See LICENCE.md in the project root for terms.

// The recording screen, shared by every device — see biomap_screen.h.

#include "biomap_screen.h"

#include <math.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>

// ==========================================================================
// Helpers
// ==========================================================================

static const char* gps_fix_label(int fix_type) {
    if(fix_type == 3) return "3D";
    if(fix_type == 2) return "2D";
    return "--";
}

// Prefer u-blox's own hAcc; fall back to HDOP*2.5 (rough metres estimate)
// when hAcc isn't available/valid, else 99.9 to mean "no usable accuracy".
static float gps_hacc_display(const GpsStatus* g) {
    return (g->hacc < 50.0f) ? g->hacc : ((g->hdop < 50.0f) ? g->hdop * 2.5f : 99.9f);
}

// Format + draw at (x, y) in one call, returning y + 10 for the next line.
// buf is capped at 48 bytes: the small font's glyphs are 3–6 px wide,
// about 25–30 per line on the 128 px screen, so 48 is a safe ceiling.
__attribute__((format(printf, 4, 5)))
static int draw_fmt(const ScreenDraw* d, int x, int y, const char* fmt, ...) {
    char buf[48];
    va_list args;
    va_start(args, fmt);
    vsnprintf(buf, sizeof(buf), fmt, args);
    va_end(args);
    d->draw_str(d->ctx, x, y, buf);
    return y + 10;
}

void screen_cache_init(ScreenCache* cache) {
    *cache = (ScreenCache){
        .ns_label_last = -1.0f,  // forces the first frame to format it (nS ≥ 0 always)
    };
}

// ==========================================================================
// Graph (GSR waveform)
// ==========================================================================
//
// A dot for each sample column (cheaper than a line, even for one-pixel
// steps), with one vertical line to fill the gap when |dy| > 1 between
// neighbouring samples. One line call replaces |dy| dot calls, which
// matters at high zoom where the steps are large.
//
// y is clipped to the graph frame's inside (gy+1 .. gy+gh-2) so zoomed-out
// values can't bleed into the top bar or over the zoom label. x is always
// inside the frame (gx+1+i, with i bounded by gw).

static inline int clamp_y(int v, int lo, int hi) {
    if(v < lo) return lo;
    if(v > hi) return hi;
    return v;
}

static void draw_graph(const ScreenDraw* d, const SessionCore* s, int gx, int gy, int gw, int gh) {
    int n  = gw - 2;
    int cy = gy + gh / 2;

    // The frame's inside: every graph pixel stays within these bounds.
    const int y0 = gy + 1;
    const int y1 = gy + gh - 2;

    // Zoom and scale folded into one constant: one multiply per sample.
    const float combined_scale = s->pipeline.zoom.level * ((float)(gh / 2 - 2) / 100.0f);

    // 10-second notches above the graph — integer arithmetic only.
    int px_per_notch = (10 * TICK_HZ) / s->pipeline.graph.scroll_divider;
    if(px_per_notch > 2) {
        int right_edge = gx + gw - 2;
        int notch_top = gy > 3 ? gy - 3 : 0;
        for(int x = right_edge - px_per_notch; x > gx; x -= px_per_notch) {
            d->draw_line(d->ctx, x, notch_top, x, gy);
        }
    }

    // Walk the ring buffer linearly, starting n samples back from the
    // newest, so a narrower graph (GPS+GSR+RF mode) shows the most recent
    // n samples, not the oldest n.
    int idx = (s->pipeline.graph.head + GRAPH_N - n) % GRAPH_N;
    float v0 = s->pipeline.graph.buf[idx] * combined_scale;
    int y_prev = cy - (int)v0;

    // First column: the first sample, clipped to the inside.
    d->draw_dot(d->ctx, gx + 1, clamp_y(y_prev, y0, y1));

    for(int i = 1; i < n; i++) {
        if(++idx >= GRAPH_N) idx = 0;

        float v1 = s->pipeline.graph.buf[idx] * combined_scale;
        int y_cur = cy - (int)v1;

        d->draw_dot(d->ctx, gx + 1 + i, clamp_y(y_cur, y0, y1));

        // Fill the gap between this dot and the last with one vertical
        // line in this column. Only when |dy| > 1: rare for normal GSR.
        if(y_prev < y_cur - 1) {
            d->draw_line(d->ctx, gx + 1 + i, clamp_y(y_prev + 1, y0, y1),
                         gx + 1 + i, clamp_y(y_cur - 1, y0, y1));
        } else if(y_prev > y_cur + 1) {
            d->draw_line(d->ctx, gx + 1 + i, clamp_y(y_cur + 1, y0, y1),
                         gx + 1 + i, clamp_y(y_prev - 1, y0, y1));
        }

        y_prev = y_cur;
    }
}

// ==========================================================================
// Recording screen pieces
// ==========================================================================

// The zoom label (bottom-left corner), formatted and measured again only
// when the zoom changes.
static void render_zoom_label(const ScreenDraw* d, const SessionCore* s, ScreenCache* cache, int x) {
    // |delta|, so the cache also updates when the zoom goes down.
    if(fabsf(s->pipeline.zoom.level - cache->zoom_label_last) > 0.05f) {
        snprintf(cache->zoom_label, sizeof(cache->zoom_label), "%.1fx",
                 (double)s->pipeline.zoom.level);
        d->set_font(d->ctx, ScreenFontSecondary);
        cache->zoom_label_width = d->str_width(d->ctx, cache->zoom_label);
        cache->zoom_label_last = s->pipeline.zoom.level;
    }
    d->set_font(d->ctx, ScreenFontSecondary);
    d->draw_str(d->ctx, x, 62, cache->zoom_label);
}

// ── Radio panel ───────────────────────────────────────────────────────
// The bars' floor without a radio calibration: ambient noise. Real-world
// idle (tracks/biomap_111.csv) sits at -92.5 to -90.5 dBm.
#define RF_VIZ_FLOOR_DBM  (-90.0f)

// Full scale of each bar, in dB above its band's floor. 18 dB spans
// real-world idle noise up to the strongest peaks seen in tracks.
#define RF_VIZ_SPAN_DB    18.0f

// Width of the left radio panel. In GPS+GSR+RF mode the GSR graph takes
// the remaining right 2/3 of the screen; the panel is x 0..RF_PANEL_W-1,
// y 16..63.
#define RF_PANEL_W        43

// The recording's file name, top left in the top bar (GPS+RF mode, while
// recording), where the GSR modes have their GPS badge or time span. The
// full name ("biomap_2026-11-19_14-32-05.csv") is too wide, so only the
// start time part ("14-32-05", plus any "_2" suffix) is shown: that is
// what tells recordings from one day apart.
static void render_file_name(const ScreenDraw* d, const SessionCore* s,
                             const ScreenExtras* extras) {
    if(!s->recording.active || !extras->file_name) return;
    const char* fn = extras->file_name;
    const char* t = (strlen(fn) > 18) ? fn + 18 : fn;
    const char* ext = strstr(t, ".csv");
    int tlen = ext ? (int)(ext - t) : (int)strlen(t);
    draw_fmt(d, 1, 10, "%.*s", tlen, t);
}

// Compact GPS details for GPS+RF mode, in the right 2/3 (x RF_PANEL_W..127)
// beside the radio panel: UTC time (no date), lat, lon and fix quality.
// Four lines, which is all the 48 px frame holds.
static void render_gps_compact(const ScreenDraw* d, const SessionCore* s) {
    GpsStatus g = gps_uart_get_status(s->gps);
    const int x = RF_PANEL_W + 2;  // 2 px clear of the frame's left edge
    int y = 25;                    // baseline, 2 px below the frame's top

    if(gps_uart_is_ready(s->gps) && g.date.year) {
        y = draw_fmt(d, x, y, "%02d:%02d:%02d UTC",
                     g.time.hours, g.time.minutes, g.time.seconds);

        if(gps_status_has_fix(&g)) {
            y = draw_fmt(d, x, y, "%.5f", g.latitude);
            y = draw_fmt(d, x, y, "%.5f", g.longitude);
        } else {
            y = draw_fmt(d, x, y, "Waiting for fix...");
        }

        const char* fix_str = gps_fix_label(g.fix_type);
        float hacc_disp = gps_hacc_display(&g);
        if(hacc_disp < 50.0f) {
            draw_fmt(d, x, y, "%.1fm  %s%s",
                     (double)hacc_disp, fix_str, g.sbas_active ? " SBAS" : "");
        } else {
            draw_fmt(d, x, y, "%s%s", fix_str, g.sbas_active ? " SBAS" : "");
        }
    } else {
        d->draw_str(d->ctx, x, y, "GPS: no signal");
    }
}

// The left radio panel: one labelled bar per band (815/868/915 MHz) in
// three 15 px rows, filling x 0..RF_PANEL_W-1, y 16..63.
//
// Bars grow left to right, like a level meter, which uses the narrow
// panel's width far better than upright bars. Each label sits under its
// bar, not beside it, so the bar gets the full width (x 1 to 41).
//
// Each bar shows "dB above that band's floor". The floor is the band's own
// calibrated noise floor (Faraday-bag calibration), or RF_VIZ_FLOOR_DBM
// without one. Per-band floors matter: 868/915 typically calibrate to
// about -91.5 dBm while 815 sits at about -90.5.
static void draw_rf_panel_left(const ScreenDraw* d, const SessionCore* s,
                               const float rssi_dbm[RF_BAND_COUNT]) {
    const int row_h = 15;
    const int row_gap = 1;
    const int panel_x = 1;  // 1 px from the edge; the labels stay clear of the graph frame at x 43
    const int bar_h = 6;    // leaves a 1 px gap above the label in a 15 px row
    const int bar_max_w = 41 - panel_x;  // 40 px

    // The bands are sub-GHz channels, so MHz is the right unit. The shared
    // band names (core/biomap_config.h), in the CSV's radio column order.
    static const char* const band_label[RF_BAND_COUNT] = {
        RF_BAND_0_MHZ " MHz", RF_BAND_1_MHZ " MHz", RF_BAND_2_MHZ " MHz",
    };

    d->set_font(d->ctx, ScreenFontSecondary);
    for(int i = 0; i < RF_BAND_COUNT; i++) {
        int row_top = 16 + i * (row_h + row_gap);  // 16 / 32 / 48

        // Calibrated floors are checked to lie in [-110, -90] dBm when
        // saved, so they are never above the default.
        float floor_dbm = RF_VIZ_FLOOR_DBM;
        if(s->settings.rf_calibrated) floor_dbm = s->settings.rf_floors_dbm[i];

        float frac = clampf((rssi_dbm[i] - floor_dbm) / RF_VIZ_SPAN_DB, 0.0f, 1.0f);
        int w = (int)(frac * (float)bar_max_w + 0.5f);
        if(w > 0) d->draw_box(d->ctx, panel_x, row_top, w, bar_h);

        d->draw_str(d->ctx, panel_x, row_top + row_h - 1, band_label[i]);
    }
}

// The nS value, top-right corner, in GSR Only (time span top-left) and the
// GPS+GSR modes (GPS badge top-left). Returns the left edge of the widest
// possible value ("-99999 nS"), not this frame's, so the elapsed time
// centred between the two doesn't jitter.
static int draw_ns_top_right(const ScreenDraw* d, const SessionCore* s, ScreenCache* cache) {
    if(cache->ns_worst_width == 0) cache->ns_worst_width = d->str_width(d->ctx, "-99999 nS");

    // Formatted and measured again only when the value changes. Comparing
    // floats exactly is right here: the same value always gives the same
    // "%.0f" text and width.
    float ns = s->pipeline.display.filtered_ns;
    if(ns != cache->ns_label_last) {
        snprintf(cache->ns_label, sizeof(cache->ns_label), "%.0f nS", (double)ns);
        cache->ns_label_width = d->str_width(d->ctx, cache->ns_label);
        cache->ns_label_last = ns;
    }
    int right_margin = s->recording.active ? 12 : 2;
    int x = SCREEN_W - cache->ns_label_width - right_margin;
    d->draw_str(d->ctx, x, 10, cache->ns_label);
    return SCREEN_W - cache->ns_worst_width - right_margin;
}

// Two short lines centred in the graph area (only its right 2/3 in
// GPS+GSR+RF mode), e.g. when the finger cuffs come off.
static void draw_inline_graph_status(const ScreenDraw* d, const char* line1, const char* line2,
                                     int centre_x) {
    d->set_font(d->ctx, ScreenFontSecondary);
    int w1 = d->str_width(d->ctx, line1);
    int w2 = d->str_width(d->ctx, line2);
    d->draw_str(d->ctx, centre_x - w1 / 2, 36, line1);
    d->draw_str(d->ctx, centre_x - w2 / 2, 45, line2);
}

// ── GPS badge, top-left (GPS+GSR modes) ───────────────────────────────
// Returns the right edge of the widest badge ("No fix"), not this frame's,
// so the elapsed time doesn't jitter as the accuracy figure changes.
static int render_gps_badge(const ScreenDraw* d, const SessionCore* s, ScreenCache* cache) {
    // No GPS module (not set up yet, or it failed): "No fix", rather than
    // asking a missing module for its status.
    GpsStatus g = {0};
    if(s->gps) g = gps_uart_get_status(s->gps);
    char badge[16];
    float hacc_disp = gps_hacc_display(&g);
    if(!s->gps || !gps_status_has_fix(&g)) {
        strcpy(badge, "No fix");
    } else if(hacc_disp < 50.0f) {
        snprintf(badge, sizeof(badge), "%.1fm", (double)hacc_disp);
    } else {
        strcpy(badge, "3D Fix");
    }
    d->draw_str(d->ctx, 1, 10, badge);
    if(cache->no_fix_width == 0) cache->no_fix_width = d->str_width(d->ctx, "No fix");
    return 1 + cache->no_fix_width;
}

// ── Time-span label, top-left (GSR Only) ──────────────────────────────
// Returns the right edge of the widest label, as above.
static int render_time_span(const ScreenDraw* d, const SessionCore* s, ScreenCache* cache) {
    char buf[32];
    int t_span = (GRAPH_N * s->pipeline.graph.scroll_divider) / TICK_HZ;
    if(t_span >= 60) {
        snprintf(buf, sizeof(buf), "%dm%ds", t_span / 60, t_span % 60);
    } else {
        snprintf(buf, sizeof(buf), "%ds", t_span);
    }
    d->draw_str(d->ctx, 1, 10, buf);
    if(cache->span_worst_width == 0) cache->span_worst_width = d->str_width(d->ctx, "59m59s");
    return 1 + cache->span_worst_width;
}

// ── Elapsed recording time (centred, GSR modes) ───────────────────────
// left_edge and right_edge are the fixed edges the pieces either side
// return, not their widths this frame, so the time stays still.
static void render_elapsed(const ScreenDraw* d, const SessionCore* s, int left_edge, int right_edge) {
    if(!s->recording.active) return;
    char buf[16];
    int elapsed_s = (int)(s->recording.total_ticks / TICK_HZ);
    if(elapsed_s < 60) {
        snprintf(buf, sizeof(buf), "%ds", elapsed_s);
    } else if(elapsed_s < 3600) {
        snprintf(buf, sizeof(buf), "%dm", elapsed_s / 60);
    } else {
        snprintf(buf, sizeof(buf), "%dh%02dm", elapsed_s / 3600, (elapsed_s % 3600) / 60);
    }
    int w = d->str_width(d->ctx, buf);
    int gap_left  = left_edge + 3;
    int gap_right = right_edge - 3;
    int x = (gap_left + gap_right - w) / 2;
    if(x < gap_left) x = gap_left;
    if(x + w > gap_right) x = gap_right - w;
    d->draw_str(d->ctx, x, 10, buf);
}

// ==========================================================================
// One screen per mode
// ==========================================================================
// Each assumes the screen has just been cleared, in the small font.

// ── GSR modes (GPS+GSR+RF / GPS+GSR / GSR Only) ───────────────────────
static void render_gsr_session(const ScreenDraw* d, const SessionCore* s, ScreenCache* cache,
                               bool gsr_visible, const float* rf_dbm) {
    BioMapMode mode = s->mode;
    bool gps_gsr_top_bar = (mode == BioMapModeGpsGsr || mode == BioMapModeGpsGsrRf);

    // Graph frame — always drawn, even with the cuffs off
    int gx = (mode == BioMapModeGpsGsrRf) ? RF_PANEL_W : 0;
    int gw = SCREEN_W - gx;
    if(d->draw_graph) {
        d->draw_graph(d->ctx, s, gx, 16, gw, 48, gsr_visible);
    } else {
        d->draw_frame(d->ctx, gx, 16, gw, 48);

        // Graph and zoom label, only while there is a signal to show
        if(gsr_visible) {
            draw_graph(d, s, gx, 16, gw, 48);
            render_zoom_label(d, s, cache, gx + 2);
        }
    }

    // Radio panel (GPS+GSR+RF), whatever the cuffs are doing
    if(rf_dbm) draw_rf_panel_left(d, s, rf_dbm);

    // ── Top bar: label on the left, nS value on the right ─────────────
    int top_left  = 0;
    int top_right = SCREEN_W;

    if(s->gsr && gsr_sensor_available(s->gsr)) {
        if(gsr_visible) {
            if(mode == BioMapModeGsrOnly) {
                top_left  = render_time_span(d, s, cache);
                top_right = draw_ns_top_right(d, s, cache);
            } else if(gps_gsr_top_bar) {
                top_left  = render_gps_badge(d, s, cache);
                top_right = draw_ns_top_right(d, s, cache);
            }
        } else {
            // Cuffs off: say so in the middle of the graph area
            int cx = (mode == BioMapModeGpsGsrRf)
                ? RF_PANEL_W + (SCREEN_W - RF_PANEL_W) / 2 : SCREEN_W / 2;
            draw_inline_graph_status(d, "Finger cuffs", "disconnected", cx);
        }
    }
    // No sensor: no message. The frame is drawn, and an empty graph area
    // speaks for itself.

    // Elapsed recording time, centred between the top bar's two labels
    render_elapsed(d, s, top_left, top_right);
}

// ── Diagnostics ───────────────────────────────────────────────────────
static void render_diagnostics(const ScreenDraw* d, const SessionCore* s) {
    if(s->gsr && gsr_sensor_available(s->gsr)) {
        uint8_t pga = gsr_sensor_get_pga_index(s->gsr);
        int32_t mean_cnt = gsr_sensor_get_mean_count(s->gsr);
        int32_t window_n = gsr_sensor_get_window_samples(s->gsr);
        int y = 8;

        // Single reading and filtered (~100 ms mean), in nS and kΩ
        // (kΩ = 1e6 / nS), so a calibration resistor can be checked
        // straight against a multimeter.
        float raw_ns  = s->pipeline.display.raw_sample_ns;
        float filt_ns = s->pipeline.display.filtered_ns;
        float raw_kohm  = (raw_ns  > 0.0f) ? 1000000.0f / raw_ns  : 0.0f;
        float filt_kohm = (filt_ns > 0.0f) ? 1000000.0f / filt_ns : 0.0f;
        y = draw_fmt(d, 0, y, "Raw: %.0fnS / %.1fk", (double)raw_ns,  (double)raw_kohm);
        y = draw_fmt(d, 0, y, "Filt:%.0fnS / %.1fk", (double)filt_ns, (double)filt_kohm);

        y = draw_fmt(d, 0, y, "PGA:%u Cal:%s Chg:%lu",
                     (unsigned)pga, s->settings.cal_active ? "yes" : "no",
                     (unsigned long)gsr_sensor_get_pga_change_count(s->gsr));
        y = draw_fmt(d, 0, y, "Sngl:%ld Mean:%ld(N=%ld)",
                     (long)s->pipeline.display.raw_sample_count,
                     (long)mean_cnt, (long)window_n);
        // Vb: the 0.5 V bias in use (AIN1 against ground), whole mV; "--"
        // when no reading has been plausible, so 500 is assumed. The CSV
        // header has it to 0.1 mV. Vb comes after F, which is 0 while the
        // sensor works, rather than after Chg, which only grows: the line
        // fits the 128 px screen while F stays under 100.
        float vb = gsr_sensor_get_bias_volts(s->gsr);
        char vb_str[8];
        if(vb > 0.0f) {
            snprintf(vb_str, sizeof(vb_str), "%.0f", (double)(vb * 1000.0f));
        } else {
            strcpy(vb_str, "--");
        }
        y = draw_fmt(d, 0, y, "Hz:%.0f OK:%.0f%% F:%lu Vb:%s",
                     (double)gsr_sensor_get_worker_hz(s->gsr),
                     (double)gsr_sensor_get_success_rate(s->gsr),
                     (unsigned long)gsr_sensor_get_consecutive_failures(s->gsr),
                     vb_str);

        uint32_t dup_gap = gsr_sensor_get_duplicate_gap_min_ms(s->gsr);
        char dg[12];
        if(dup_gap == UINT32_MAX) {
            strcpy(dg, "-");
        } else {
            snprintf(dg, sizeof(dg), "%lu", (unsigned long)dup_gap);
        }
        draw_fmt(d, 0, y, "Dup:%.0f%% Stl:%.0f%% DG:%s",
                 (double)gsr_sensor_get_duplicate_rate(s->gsr),
                 (double)gsr_sensor_get_stale_rate(s->gsr), dg);
    } else {
        d->draw_str(d->ctx, 0, 8, "GSR: --");
    }
}

// ── GPS + RF ──────────────────────────────────────────────────────────
static void render_gps_rf(const ScreenDraw* d, const SessionCore* s, const ScreenExtras* extras) {
    d->draw_frame(d->ctx, RF_PANEL_W, 16, SCREEN_W - RF_PANEL_W, 48);
    if(extras->rf_dbm) draw_rf_panel_left(d, s, extras->rf_dbm);
    render_file_name(d, s, extras);
    render_gps_compact(d, s);
}

// ── Live Stream ───────────────────────────────────────────────────────
static const char* link_label(ScreenLink link) {
    switch(link) {
    case ScreenLinkConnected:   return "Connected";
    case ScreenLinkAdvertising: return "Advertising";
    case ScreenLinkOff:         return "Bluetooth off";
    case ScreenLinkUnavailable:
    default:                    return "Unavailable";
    }
}

// Reads the GSR and GPS directly rather than the session's display
// figures: Live Stream's tick never updates those, so they stay at zero.
static void render_live_stream(const ScreenDraw* d, const SessionCore* s,
                               const ScreenExtras* extras) {
    d->set_font(d->ctx, ScreenFontPrimary);
    d->draw_str(d->ctx, 0, 10, "Live Stream");
    d->set_font(d->ctx, ScreenFontSecondary);

    draw_fmt(d, 0, 23, "BLE: %s", link_label(extras->link));
    draw_fmt(d, 0, 35, "Dropped: %lu", (unsigned long)extras->link_dropped);

    if(s->gsr && gsr_sensor_available(s->gsr)) {
        // Connected, not just available, like the GSR modes: cuffs off
        // says so rather than freezing on the last reading. What is sent
        // is whatever the sensor reads either way, as in the CSV.
        if(gsr_sensor_is_connected(s->gsr)) {
            draw_fmt(d, 0, 47, "GSR: %.0f nS", (double)gsr_sensor_get_raw(s->gsr));
        } else {
            d->draw_str(d->ctx, 0, 47, "GSR: cuffs disconnected");
        }
    } else {
        d->draw_str(d->ctx, 0, 47, "GSR: --");
    }

    if(s->gps) {
        GpsStatus g = gps_uart_get_status(s->gps);
        draw_fmt(d, 0, 59, "GPS: %s  Sats:%d",
                 gps_status_has_fix(&g) ? gps_fix_label(g.fix_type) : "No fix",
                 g.satellites_tracked);
    } else {
        d->draw_str(d->ctx, 0, 59, "GPS: --");
    }
}

// ==========================================================================
// One frame
// ==========================================================================

void screen_draw_session(const ScreenDraw* d, const SessionCore* s, const ScreenExtras* extras,
                         ScreenCache* cache) {
    d->clear(d->ctx);
    d->set_font(d->ctx, ScreenFontSecondary);

    bool is_diag   = (s->mode == BioMapModeDiagnostics);
    bool has_graph = has_gsr(s->mode) && !is_diag;

    // The radio reading, in the radio modes. Diagnostics runs the radio
    // (has_rf()) but its screen has no radio panel.
    const float* rf_dbm = (has_rf(s->mode) && !is_diag) ? extras->rf_dbm : NULL;

    if(s->mode == BioMapModeLiveStream) {
        render_live_stream(d, s, extras);
    } else if(is_diag) {
        render_diagnostics(d, s);
    } else if(has_graph) {
        bool gsr_visible = s->gsr && gsr_sensor_available(s->gsr) && gsr_sensor_is_connected(s->gsr);
        render_gsr_session(d, s, cache, gsr_visible, rf_dbm);
    } else if(s->gps) {
        ScreenExtras x = *extras;
        x.rf_dbm = rf_dbm;
        render_gps_rf(d, s, &x);
    } else {
        d->draw_str(d->ctx, 0, 20, "GPS unavailable");
    }

    // Recording mark, every mode: a steady box, blinking at about 1 Hz
    // while an SD write failure is being ridden out (flush_fail_streak > 0)
    // so a struggling recording looks different from a healthy one.
    if(s->recording.active) {
        bool blink_gap = s->recording.flush_fail_streak > 0 && ((s->recording.total_ticks / 5) % 2);
        if(!blink_gap) d->draw_box(d->ctx, 118, 1, 8, 8);
    }

    // The banner once an SD failure has ended the recording
    // (write_stopped stays set after recording.active clears). Drawn last,
    // over the top of the mode's own screen: the recording is over, so
    // covering the now-stale top strip is the right trade.
    if(s->recording.write_stopped) {
        d->set_font(d->ctx, ScreenFontSecondary);
        d->draw_box(d->ctx, 0, 0, SCREEN_W, 11);
        d->invert(d->ctx);
        d->draw_str(d->ctx, 2, 9, "REC STOPPED - SD ERROR");
        d->invert(d->ctx);
    }
}
