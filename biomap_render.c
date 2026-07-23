// Bio Mapping — Canvas rendering callbacks for all ViewPorts.
#include "biomap.h"

// ── Label arrays for menu and options screens ──────────────────────────────

static const char* const menu_labels[MENU_COUNT] = {
    "GPS + GSR", "GPS Only", "GSR Only", "Options", "Diagnostics",
};

static const char* const options_labels[OPTIONS_COUNT] = {
    "Reset GPS",
    "Auto-zoom GSR",
    "Backlight",
    "GSR Calibration",
    "Sound",
};

// ── GPS display helpers ────────────────────────────────────────────────────

static const char* gps_fix_label(int fix_type) {
    if(fix_type == 3) return "3D";
    if(fix_type == 2) return "2D";
    return "--";
}

static bool gps_has_fix(const GpsStatus* g) {
    return g->fix_valid || g->fix_quality > 0;
}

static void format_pdop_str(char* out, size_t outlen, float pdop) {
    if(pdop < 99.0f) {
        snprintf(out, outlen, "%.1f", (double)pdop);
    } else {
        strcpy(out, "--");
    }
}


// ==========================================================================
// Graph rendering (GSR waveform)
// ==========================================================================

static void draw_graph(Canvas* c, BioMapApp* a, int gx, int gy, int gw, int gh) {
    int n  = gw - 2;
    int cy = gy + gh / 2;

    // Fold zoom and scale into one constant so the inner loop only needs
    // one multiply per sample instead of two.
    const float combined_scale = a->session.pipeline.zoom.level * ((float)(gh / 2 - 2) / 100.0f);

    canvas_draw_frame(c, gx, gy, gw, gh);

    // 10-second notches above the graph — integer arithmetic only.
    // px_per_notch: how many pixels represent 10 seconds at current speed.
    // scroll_divider ticks per pixel, TICK_HZ ticks per second.
    // 10 s × TICK_HZ ticks/s ÷ scroll_divider ticks/px = px per notch.
    int px_per_notch = (10 * TICK_HZ) / a->session.pipeline.graph.scroll_divider; // integer, always ≥1
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
    int idx = a->session.pipeline.graph.head;
    float v0 = a->session.pipeline.graph.buf[idx] * combined_scale;
    int y_prev = cy - (int)v0;

    for(int i = 0; i < n - 1; i++) {
        // Advance index with branchless wrap (compare cheaper than divide)
        if(++idx >= GRAPH_N) idx = 0;

        float v1 = a->session.pipeline.graph.buf[idx] * combined_scale;
        int y1 = cy - (int)v1;

        canvas_draw_line(c, gx + 1 + i, y_prev, gx + 1 + i + 1, y1);
        y_prev = y1;
    }
}

// ==========================================================================
// Recording view — live display during data logging
// ==========================================================================

// Render GPS detail lines for GPS-only mode (no GSR graph).
// Mutex must already be held by caller.
static void render_gps_detail(Canvas* c, BioMapApp* a) {
    GpsStatus g = gps_uart_get_status(a->session.gps);
    int y = 20;

    if(a->session.recording.active) {
        const char* fn = sd_logger_get_filename(a->session.logger);
        canvas_draw_str(c, 0, y, (strlen(fn) > 7) ? fn + 7 : fn);
        y += 10;
    }

    if(gps_uart_is_ready(a->session.gps) && g.date.year) {
        char buf[48];
        int yr = gps_year_expand(g.date.year);
        snprintf(buf, sizeof(buf), "%02d:%02d:%02d UTC %04d-%02d-%02d",
            g.time.hours, g.time.minutes, g.time.seconds,
            yr, g.date.month, g.date.day);
        canvas_draw_str(c, 0, y, buf);
        y += 10;

        bool has_fix = gps_has_fix(&g);
        bool gps_ready = has_fix && g.hdop < GPS_HDOP_GATE;

        if(gps_ready) {
            snprintf(buf, sizeof(buf), "%.5f", (double)g.latitude);
            canvas_draw_str(c, 0, y, buf);
            y += 10;
            snprintf(buf, sizeof(buf), "%.5f", (double)g.longitude);
            canvas_draw_str(c, 0, y, buf);
            y += 10;
        } else if(has_fix) {
            // Fix acquired but DOP still too high — tell user to wait
            if(g.hdop < 50.0f) {
                snprintf(buf, sizeof(buf), "Acquiring (HDOP:%.1f)", (double)g.hdop);
            } else {
                snprintf(buf, sizeof(buf), "Acquiring...");
            }
            canvas_draw_str(c, 0, y, buf);
            y += 10;
        } else {
            canvas_draw_str(c, 0, y, "Waiting for fix...");
            y += 10;
        }

        // Quality line: HDOP + PDOP + fix type (+ SBAS indicator).
        // Both DOP values come from GSA — chip-computed from ALL constellations.
        // HDOP < 1  = excellent    PDOP < 2   = excellent
        // HDOP 1-2 = very good     PDOP 2-4   = very good
        // HDOP 2-5 = good          PDOP 4-8   = good
        const char* fix_str = gps_fix_label(g.fix_type);
        if(g.hdop < 50.0f) {
            char pbuf[8];
            format_pdop_str(pbuf, sizeof(pbuf), g.pdop);
            snprintf(buf, sizeof(buf), "H:%.1f  P:%s  %s%s",
                     (double)g.hdop, pbuf, fix_str,
                     g.sbas_active ? " SBAS" : "");
        } else {
            snprintf(buf, sizeof(buf), "H:--  P:--  %s%s",
                     fix_str,
                     g.sbas_active ? " SBAS" : "");
        }
        canvas_draw_str(c, 0, y, buf);
    } else {
        canvas_draw_str(c, 0, y, "GPS: no signal");
    }
}

// Render the zoom label (bottom-right corner), caching format/width to
// avoid snprintf + canvas_string_width on every frame.  Mutex held by caller.
static void render_zoom_label(Canvas* c, BioMapApp* a) {
    if(a->session.pipeline.zoom.level < a->session.zoom_label_last - 0.05f ||
       a->session.pipeline.zoom.level > a->session.zoom_label_last + 0.05f) {
        snprintf(a->session.zoom_label, sizeof(a->session.zoom_label), "%.1fx",
                 (double)a->session.pipeline.zoom.level);
        canvas_set_font(c, FontSecondary);
        a->session.zoom_label_width = canvas_string_width(c, a->session.zoom_label);
        a->session.zoom_label_last = a->session.pipeline.zoom.level;
    }
    canvas_set_font(c, FontSecondary);
    canvas_draw_str(c, 2, 62, a->session.zoom_label);
}

static void draw_sensor_alert(Canvas* c, const char* text) {
    canvas_set_font(c, FontPrimary);
    int text_w = canvas_string_width(c, text);
    int box_w = text_w + 12;
    int box_h = 14;
    int box_x = (128 - box_w) / 2;
    int box_y = 16 + (48 - box_h) / 2; // Centered in 16..64 graph area

    // Draw solid black background
    canvas_draw_box(c, box_x, box_y, box_w, box_h);

    // Draw white border inside the black box
    canvas_invert_color(c);
    canvas_draw_frame(c, box_x + 1, box_y + 1, box_w - 2, box_h - 2);

    // Draw white text
    canvas_draw_str(c, box_x + 6, box_y + box_h - 4, text);
    canvas_invert_color(c);

    canvas_set_font(c, FontSecondary);
}

void biomap_render_callback(Canvas* c, void* ctx) {
    BioMapApp* a = (BioMapApp*)ctx;
    furi_mutex_acquire(a->mutex, FuriWaitForever);
    canvas_clear(c);

    bool has_graph = has_gsr(a->session.mode)
                  && a->session.mode != BioMapModeDiagnostics;
    bool is_diag   = (a->session.mode == BioMapModeDiagnostics);

    // Graph + zoom label (GSR modes except diagnostics)
    if(has_graph) {
        draw_graph(c, a, 0, 16, 128, 48);
        render_zoom_label(c, a);
    }

    // Recording indicator only — no title to maximise data visibility
    canvas_set_font(c, FontSecondary);
    if(a->session.recording.active) {
        canvas_draw_box(c, 118, 1, 8, 8);
    }

    // GPS quality badge — GPS+GSR mode only, top-left
    if(a->session.mode == BioMapModeGpsGsr && a->session.gps) {
        GpsStatus g = gps_uart_get_status(a->session.gps);
        bool has_fix = gps_has_fix(&g);
        char badge[16];
        if(!has_fix) {
            snprintf(badge, sizeof(badge), "No fix");
        } else if(isnan(g.hdop) || g.hdop >= GPS_HDOP_GATE) {
            if(isnan(g.hdop)) {
                snprintf(badge, sizeof(badge), "Acquiring");
            } else if(g.hdop < 50.0f) {
                snprintf(badge, sizeof(badge), "H:%.1f !", (double)g.hdop);
            } else {
                snprintf(badge, sizeof(badge), "Acquiring");
            }
        } else {
            char pbuf[8];
            format_pdop_str(pbuf, sizeof(pbuf), g.pdop);
            snprintf(badge, sizeof(badge), "H:%.1f P:%s",
                     (double)g.hdop, pbuf);
        }
        canvas_set_font(c, FontSecondary);
        canvas_draw_str(c, 1, 10, badge);
    }

    // ── Diagnostics: GSR only, 7 labeled lines ─────────────────────────
    // 8 px line spacing (not 10) — 7 lines at 10 px would put the last
    // line's baseline at y=68, off the bottom of the 128x64 canvas.
    if(is_diag) {
        canvas_set_font(c, FontSecondary);

        if(a->session.gsr && gsr_sensor_available(a->session.gsr)) {
            uint8_t pga = gsr_sensor_get_pga_index(a->session.gsr);
            int32_t mean_cnt = gsr_sensor_get_mean_count(a->session.gsr);
            char buf[32];
            int y = 8;

            snprintf(buf, sizeof(buf), "PGA:%u  Cal:%s",
                     (unsigned)pga, a->cal_active ? "yes" : "no");
            canvas_draw_str(c, 0, y, buf);  y += 8;

            snprintf(buf, sizeof(buf), "Raw:  %.0f nS",
                     (double)a->session.pipeline.display.raw_sample_ns);
            canvas_draw_str(c, 0, y, buf);  y += 8;

            snprintf(buf, sizeof(buf), "Filt: %.0f nS",
                     (double)a->session.pipeline.display.filtered_ns);
            canvas_draw_str(c, 0, y, buf);  y += 8;

            snprintf(buf, sizeof(buf), "Sngl: %ld",
                     (long)a->session.pipeline.display.raw_sample_count);
            canvas_draw_str(c, 0, y, buf);  y += 8;

            snprintf(buf, sizeof(buf), "Mean: %ld", (long)mean_cnt);
            canvas_draw_str(c, 0, y, buf);  y += 8;

            snprintf(buf, sizeof(buf), "Hz:%.0f OK:%.0f%%",
                     (double)gsr_sensor_get_worker_hz(a->session.gsr),
                     (double)gsr_sensor_get_success_rate(a->session.gsr));
            canvas_draw_str(c, 0, y, buf);  y += 8;

            snprintf(buf, sizeof(buf), "Dup:%.0f%%",
                     (double)gsr_sensor_get_duplicate_rate(a->session.gsr));
            canvas_draw_str(c, 0, y, buf);
        } else {
            canvas_draw_str(c, 0, 8, "GSR: --");
        }
    }

    // Mode-specific overlay (GSR modes with graph)
    if(has_graph) {
        if(a->session.gsr) {
            if(gsr_sensor_available(a->session.gsr)) {
                if(gsr_sensor_is_connected(a->session.gsr)) {
                    if(a->session.mode == BioMapModeGsrOnly) {
                        char buf[32];
                        // Time span label — top-left
                        int t_span = (GRAPH_N * a->session.pipeline.graph.scroll_divider) / TICK_HZ;
                        if(t_span >= 60) {
                            snprintf(buf, sizeof(buf), "%dm%ds", t_span / 60, t_span % 60);
                        } else {
                            snprintf(buf, sizeof(buf), "%ds", t_span);
                        }
                        canvas_draw_str(c, 1, 10, buf);
                        // nS value — top-right
                        snprintf(buf, sizeof(buf), "%.0f nS", (double)a->session.pipeline.display.filtered_ns);
                        int x = 128 - canvas_string_width(c, buf) - (a->session.recording.active ? 12 : 2);
                        canvas_draw_str(c, x, 10, buf);
                    } else if(a->session.mode == BioMapModeGpsGsr) {
                        // nS value — top-right (GPS badge already at top-left)
                        char buf[16];
                        snprintf(buf, sizeof(buf), "%.0f nS", (double)a->session.pipeline.display.filtered_ns);
                        int x = 128 - canvas_string_width(c, buf) - (a->session.recording.active ? 12 : 2);
                        canvas_draw_str(c, x, 10, buf);
                    }
                } else {
                    draw_sensor_alert(c, "NO SIGNAL");
                }
            } else {
                draw_sensor_alert(c, "NO SENSOR");
            }
        }
    } else if(!is_diag && a->session.gps) {
        render_gps_detail(c, a);
    } else if(!is_diag) {
        canvas_draw_str(c, 0, 20, "GPS unavailable");
    }

    furi_mutex_release(a->mutex);
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

    // Overlay toggle state on items 1 (auto-zoom), 2 (backlight), 3
    // (calibration), and 4 (sound). Item 4 now reaches y=62, the bottom
    // edge of the 64px display — with 5 rows there's no longer room for a
    // "Press Back to return" footer below the list (as there was with the
    // original 4 items), so it's been dropped; every other screen in this
    // app relies on Back working without an on-screen reminder.
    for(int i = 1; i < OPTIONS_COUNT; i++) {
        int y = 22 + i * 10;
        const char* state;
        if(i == 1) {
            state = a->zoom_enabled ? "ON" : "OFF";
        } else if(i == 2) {
            state = a->backlight_on ? "ON" : "OFF";
        } else if(i == 3) {
            state = a->cal_active ? "YES" : "NO";
        } else {
            state = a->sound_enabled ? "ON" : "OFF";
        }
        int sx = 128 - canvas_string_width(c, state) - 2;
        if(i == sel) canvas_invert_color(c);
        canvas_draw_str(c, sx, y, state);
        if(i == sel) canvas_invert_color(c);
    }
    canvas_set_font(c, FontSecondary);
    furi_mutex_release(a->mutex);
}

void calibration_menu_render(Canvas* c, void* ctx) {
    int sel = *(int*)ctx;
    canvas_clear(c);
    canvas_set_font(c, FontPrimary);
    canvas_draw_str(c, 0, 10, "GSR Calibration");
    canvas_set_font(c, FontSecondary);
    
    const char* options[] = { "Start Wizard", "Reset to Default", "Show Current" };
    for(int i = 0; i < 3; i++) {
        int y = 25 + i * 12;
        if(i == sel) {
            canvas_draw_str(c, 0, y, "> ");
            canvas_draw_str(c, 10, y, options[i]);
        } else {
            canvas_draw_str(c, 10, y, options[i]);
        }
    }
    canvas_draw_str(c, 0, 60, "Press Back to return");
}

void calibration_wizard_render(Canvas* c, void* ctx) {
    WizardState* w = (WizardState*)ctx;
    canvas_clear(c);
    canvas_set_font(c, FontPrimary);
    canvas_draw_str(c, 0, 10, "GSR Calibration");
    canvas_set_font(c, FontSecondary);
    
    char buf[64];
    switch(w->step) {
    case 0: // Prompt 470k
        canvas_draw_str(c, 0, 25, "Step 1/3: Low (470k)");
        canvas_draw_str(c, 0, 37, "Connect 470k resistor");
        canvas_draw_str(c, 0, 49, "[Press OK to measure]");
        break;
    case 1: // Measuring 470k
        canvas_draw_str(c, 0, 25, "Measuring 470k...");
        canvas_draw_str(c, 0, 40, "Keep resistor connected");
        break;
    case 2: // Prompt 100k
        canvas_draw_str(c, 0, 25, "Step 2/3: Mid (100k)");
        canvas_draw_str(c, 0, 37, "Connect 100k resistor");
        canvas_draw_str(c, 0, 49, "[Press OK to measure]");
        break;
    case 3: // Measuring 100k
        canvas_draw_str(c, 0, 25, "Measuring 100k...");
        canvas_draw_str(c, 0, 40, "Keep resistor connected");
        break;
    case 4: // Prompt 47k
        canvas_draw_str(c, 0, 25, "Step 3/3: High (47k)");
        canvas_draw_str(c, 0, 37, "Connect 47k resistor");
        canvas_draw_str(c, 0, 49, "[Press OK to measure]");
        break;
    case 5: // Measuring 47k
        canvas_draw_str(c, 0, 25, "Measuring 47k...");
        canvas_draw_str(c, 0, 40, "Keep resistor connected");
        break;
    case 8: // Success
        canvas_draw_str(c, 0, 23, "Calibration Success!");
        snprintf(buf, sizeof(buf), "Gain: %.3fx  R\xb2: %.4f", (double)w->gain, (double)w->r_squared);
        canvas_draw_str(c, 0, 35, buf);
        snprintf(buf, sizeof(buf), "Offset: %.0f nS", (double)w->offset);
        canvas_draw_str(c, 0, 47, buf);
        canvas_draw_str(c, 0, 60, "[OK to Save, Back to Cancel]");
        break;
    case 9: // Measurement failed — not enough samples in gate
        canvas_draw_str(c, 0, 25, "Calibration Failed!");
        canvas_draw_str(c, 0, 38, "Check connections.");
        canvas_draw_str(c, 0, 50, "[Press OK to Retry]");
        break;
    case 10: // Fit failed — bounds or R²
        canvas_draw_str(c, 0, 25, "Calibration Failed!");
        canvas_draw_str(c, 0, 37, "Device out of range.");
        snprintf(buf, sizeof(buf), "Gain: %.3fx  R\xb2: %.4f", (double)w->gain, (double)w->r_squared);
        canvas_draw_str(c, 0, 49, buf);
        canvas_draw_str(c, 0, 61, "[Press OK to Retry]");
        break;
    default:
        break;
    }
}

void show_current_calibration_render(Canvas* c, void* ctx) {
    BioMapApp* app = (BioMapApp*)ctx;
    canvas_clear(c);
    canvas_set_font(c, FontPrimary);
    canvas_draw_str(c, 0, 10, "GSR Calibration");
    canvas_set_font(c, FontSecondary);

    char buf[64];
    furi_mutex_acquire(app->mutex, FuriWaitForever);
    bool active = app->cal_active;
    float gain = app->cal_gain;
    float offset = app->cal_offset;
    furi_mutex_release(app->mutex);

    if(active) {
        canvas_draw_str(c, 0, 23, "Active Custom Cal:");
    } else {
        canvas_draw_str(c, 0, 23, "Active Default Cal:");
    }

    snprintf(buf, sizeof(buf), "Gain: %.3fx", (double)gain);
    canvas_draw_str(c, 0, 35, buf);
    snprintf(buf, sizeof(buf), "Offset: %.0f nS", (double)offset);
    canvas_draw_str(c, 0, 47, buf);
    canvas_draw_str(c, 0, 60, "[Press OK or Back to return]");
}
