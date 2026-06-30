// Bio Mapping — Canvas rendering callbacks for all ViewPorts.
#include "biomap.h"

// ── Label arrays for menu and options screens ──────────────────────────────

static const char* const menu_labels[MENU_COUNT] = {
    "GPS + GSR", "GPS Only", "GSR Only", "Convert CSV to GPX", "Options",
};

static const char* const options_labels[OPTIONS_COUNT] = {
    "Reset GPS",
    "Auto-zoom GSR",
    "Backlight",
};

// ==========================================================================
// Graph rendering (GSR waveform)
// ==========================================================================

static void draw_graph(Canvas* c, BioMapApp* a, int gx, int gy, int gw, int gh) {
    int n  = gw - 2;
    int cy = gy + gh / 2;

    // Fold zoom and scale into one constant so the inner loop only needs
    // one multiply per sample instead of two.
    const float combined_scale = a->zoom.level * ((float)(gh / 2 - 2) / 100.0f);

    canvas_draw_frame(c, gx, gy, gw, gh);

    // 10-second notches above the graph — integer arithmetic only.
    // px_per_notch: how many pixels represent 10 seconds at current speed.
    // scroll_divider ticks per pixel, TICK_HZ ticks per second.
    // 10 s × TICK_HZ ticks/s ÷ scroll_divider ticks/px = px per notch.
    int px_per_notch = (10 * TICK_HZ) / a->graph.scroll_divider; // integer, always ≥1
    if(px_per_notch > 2) {
        int right_edge = gx + gw - 2;
        int notch_top = gy > 3 ? gy - 3 : 0;   // guard against negative canvas y
        for(int x = right_edge - px_per_notch; x > gx; x -= px_per_notch) {
            canvas_draw_line(c, x, notch_top, x, gy);
        }
    }

    // Walk the ring buffer linearly — no modulo divisions per pixel.
    // GRAPH_N (126) is not a power-of-two, so % GRAPH_N compiles to a
    // software divide on Cortex-M4. Replace with a compare-and-wrap.
    // Also cache y_prev: y1 of segment i becomes y0 of segment i+1.
    int idx = a->graph.head;
    float v0 = a->graph.buf[idx] * combined_scale;
    int y_prev = cy - (int)v0;

    for(int i = 0; i < n - 1; i++) {
        // Advance index with branchless wrap (compare cheaper than divide)
        if(++idx >= GRAPH_N) idx = 0;

        float v1 = a->graph.buf[idx] * combined_scale;
        int y1 = cy - (int)v1;

        canvas_draw_line(c, gx + 1 + i, y_prev, gx + 1 + i + 1, y1);
        y_prev = y1;
    }
}

// ==========================================================================
// Recording view — live display during data logging
// ==========================================================================

void biomap_render_callback(Canvas* c, void* ctx) {
    BioMapApp* a = (BioMapApp*)ctx;
    furi_mutex_acquire(a->mutex, FuriWaitForever);
    canvas_clear(c);

    bool has_graph = has_gsr(a->mode);

    // Full-width graph (behind text, when GSR active)
    if(has_graph) {
        draw_graph(c, a, 0, 16, 128, 48);

        // Zoom label — cached; only reformat when zoom_level changes visibly.
        // Avoids snprintf + canvas_string_width on every render frame.
        static char  zoom_buf[16] = "1.0x";
        static float zoom_last    = -1.0f; // sentinel: force first format
        static int   zoom_px_w    = 0;
        if(a->zoom.level < zoom_last - 0.05f || a->zoom.level > zoom_last + 0.05f) {
            snprintf(zoom_buf, sizeof(zoom_buf), "%.1fx", (double)a->zoom.level);
            canvas_set_font(c, FontSecondary);
            zoom_px_w = canvas_string_width(c, zoom_buf);
            zoom_last = a->zoom.level;
        }
        canvas_set_font(c, FontSecondary);
        canvas_draw_str(c, 128 - zoom_px_w - 2, 62, zoom_buf);
    }

    // Title + recording indicator
    canvas_set_font(c, FontPrimary);
    canvas_draw_str(c, 0, 10, "Bio Mapping");
    canvas_set_font(c, FontSecondary);

    if(a->recording.active) {
        canvas_draw_box(c, 118, 1, 8, 8);
    }

    if(has_graph) {
        // GPS+GSR or GSR-only: minimal overlay — just GSR number on GSR-only
        if(a->mode == BioMapModeGsrOnly && a->gsr && gsr_sensor_available(a->gsr)) {
            char buf[32];
            snprintf(buf, sizeof(buf), "%ld nS", (long)a->display.last_displayed);
            int x = 128 - canvas_string_width(c, buf) - (a->recording.active ? 12 : 2);
            canvas_draw_str(c, x, 10, buf);
        }
    } else if(a->gps) {
        // GPS-only: full detail view
        GpsStatus g = gps_uart_get_status(a->gps);
        int y = 20;

        if(a->recording.active) {
            const char* fn = a->recording.filename;
            canvas_draw_str(c, 0, y, (strlen(fn) > 7) ? fn + 7 : fn);
            y += 10;
        }

        if(gps_uart_is_ready(a->gps) && g.date.year) {
            char buf[48];
            int yr = gps_year_expand(g.date.year);
            snprintf(buf, sizeof(buf), "%02d:%02d:%02d UTC %04d-%02d-%02d",
                g.time.hours, g.time.minutes, g.time.seconds,
                yr, g.date.month, g.date.day);
            canvas_draw_str(c, 0, y, buf);
            y += 10;

            if(g.fix_valid || g.fix_quality > 0) {
                snprintf(buf, sizeof(buf), "%.5f", (double)g.latitude);
                canvas_draw_str(c, 0, y, buf);
                y += 10;
                snprintf(buf, sizeof(buf), "%.5f", (double)g.longitude);
                canvas_draw_str(c, 0, y, buf);
                y += 10;
            } else {
                canvas_draw_str(c, 0, y, "Waiting for fix...");
                y += 10;
            }

            snprintf(buf, sizeof(buf), "Sats:%d  Q:%d", g.satellites_tracked, g.fix_quality);
            canvas_draw_str(c, 0, y, buf);
        } else {
            canvas_draw_str(c, 0, y, "GPS: no signal");
        }
    } else {
        int y = 20;
        canvas_draw_str(c, 0, y, "GPS unavailable");
    }

    furi_mutex_release(a->mutex);
}

// ==========================================================================
// Conversion status screens
// ==========================================================================

void conv_progress_render(Canvas* c, void* ctx) {
    ConvResult* r = (ConvResult*)ctx;
    static const char spinner[] = {'|', '/', '-', '\\'};

    canvas_clear(c);
    canvas_set_font(c, FontPrimary);
    canvas_draw_str(c, 0, 10, "Converting...");
    canvas_set_font(c, FontSecondary);
    canvas_draw_str(c, 0, 26, r->conv_name);

    char buf[32];
    snprintf(buf, sizeof(buf), "%c Please wait", spinner[r->spinner_frame & 3]);
    canvas_draw_str(c, 0, 40, buf);

    r->spinner_frame++;
}

void conv_status_render(Canvas* c, void* ctx) {
    ConvResult* r = (ConvResult*)ctx;
    canvas_clear(c);
    canvas_set_font(c, FontPrimary);
    canvas_draw_str(c, 0, 10, r->conv_ok ? "Conversion OK" : "Conversion FAILED");
    canvas_set_font(c, FontSecondary);
    char buf[64];
    snprintf(buf, sizeof(buf), "CSV : %s", r->conv_name);
    canvas_draw_str(c, 0, 24, buf);

    // Derive GPX name: copy conv_name and replace the last 3 chars (.csv → .gpx)
    char gpx[32];
    strncpy(gpx, r->conv_name, sizeof(gpx) - 1);
    gpx[sizeof(gpx) - 1] = '\0';
    size_t len = strlen(gpx);
    if(len >= 4 && strcmp(gpx + len - 4, ".csv") == 0) {
        gpx[len - 3] = 'g'; gpx[len - 2] = 'p'; gpx[len - 1] = 'x';
    }
    snprintf(buf, sizeof(buf), "GPX : %s", gpx);
    canvas_draw_str(c, 0, 34, buf);
    snprintf(buf, sizeof(buf), "Points : %d", r->conv_points);
    canvas_draw_str(c, 0, 46, buf);
    canvas_draw_str(c, 0, 58,
        (!r->conv_ok && r->conv_points == 0) ? "No GPS fix rows found" : "Press Back");
}

// ==========================================================================
// Menu & options rendering
// ==========================================================================

static void draw_selection_list(Canvas* c, int sel, int count,
                         const char* const* labels, int start_y) {
    for(int i = 0; i < count; i++) {
        int y = start_y + i * 10;
        if(i == sel) {
            canvas_draw_box(c, 0, y - 8, 128, 9);
            canvas_invert_color(c);
            canvas_draw_str(c, 0, y, ">");
            canvas_draw_str(c, 8, y, labels[i]);
            canvas_invert_color(c);
        } else {
            canvas_draw_str(c, 8, y, labels[i]);
        }
    }
}

void menu_render(Canvas* c, void* ctx) {
    MenuContext* m_ctx = (MenuContext*)ctx;
    BioMapApp* a = m_ctx->app;
    furi_mutex_acquire(a->mutex, FuriWaitForever);
    canvas_clear(c);
    canvas_set_font(c, FontPrimary);
    canvas_draw_str(c, 0, 10, "Bio Mapping");
    canvas_set_font(c, FontSecondary);
    draw_selection_list(c, (int)m_ctx->selection, MENU_COUNT, menu_labels, 22);
    furi_mutex_release(a->mutex);
}

void options_render(Canvas* c, void* ctx) {
    OptionsContext* o_ctx = (OptionsContext*)ctx;
    BioMapApp* a = o_ctx->app;
    furi_mutex_acquire(a->mutex, FuriWaitForever);
    canvas_clear(c);
    canvas_set_font(c, FontPrimary);
    canvas_draw_str(c, 0, 10, "Options");
    canvas_set_font(c, FontSecondary);
    int sel = (int)o_ctx->selection;
    draw_selection_list(c, sel, OPTIONS_COUNT, options_labels, 22);

    // Overlay toggle state on items 1 (auto-zoom) and 2 (backlight)
    for(int i = 1; i < OPTIONS_COUNT; i++) {
        int y = 22 + i * 10;
        bool on = (i == 1) ? a->zoom.enabled : a->backlight_on;
        const char* state = on ? "ON" : "OFF";
        int sx = 128 - canvas_string_width(c, state) - 2;
        if(i == sel) canvas_invert_color(c);
        canvas_draw_str(c, sx, y, state);
        if(i == sel) canvas_invert_color(c);
    }
    canvas_set_font(c, FontSecondary);
    canvas_draw_str(c, 0, 60, "Press Back to return");
    furi_mutex_release(a->mutex);
}
