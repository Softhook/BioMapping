// Bio Mapping — Canvas rendering callbacks for all ViewPorts.
#include "biomap.h"

// ── Label arrays for menu and options screens ──────────────────────────────

static const char* const menu_labels[MENU_COUNT] = {
    "GPS + GSR + RF", "GPS + GSR", "GPS + RF", "GSR Only", "Options",
};

static const char* const options_labels[OPTIONS_COUNT] = {
    "GPS Profile",
    "Reset GPS",
    "Auto-zoom GSR",
    "GSR Calibration",
    "RF Calibration",
    "Backlight",
    "Sound",
    "Diagnostics",
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

// Prefer u-blox's own hAcc; fall back to HDOP*2.5 (rough meters estimate)
// when hAcc isn't available/valid, else 99.9 to mean "no usable accuracy".
static float gps_hacc_display(const GpsStatus* g) {
    return (g->hacc < 50.0f) ? g->hacc : ((g->hdop < 50.0f) ? g->hdop * 2.5f : 99.9f);
}

// ── Rendering helpers ──────────────────────────────────────────────────────

// Format + draw at (x, y) in one call, returning y + 10 for the next line.
// Replaces the repetitive snprintf + canvas_draw_str + y += 10 triplet
// that appears ~30 times across diagnostics, GPS, and calibration renders.
static int draw_fmt(Canvas* c, int x, int y, const char* fmt, ...) {
    char buf[48];
    va_list args;
    va_start(args, fmt);
    vsnprintf(buf, sizeof(buf), fmt, args);
    va_end(args);
    canvas_draw_str(c, x, y, buf);
    return y + 10;
}


// ==========================================================================
// Graph rendering (GSR waveform)
// ==========================================================================
//
// Hybrid approach: canvas_draw_dot() for each sample column (avoids the
// Bresenham overhead that canvas_draw_line pays even for dx=1 segments),
// with canvas_draw_line() for vertical gap-fill when |dy| > 1 between
// consecutive samples.  A single vertical line call replaces |dy| individual
// dot calls — critical at high zoom where large y-steps would otherwise
// incur heavy function-call overhead from the gap-fill loop.
//
// Clamp helpers clip y to the graph frame interior (gy+1 .. gy+gh-2) so
// zoomed-out values cannot bleed into the top bar or overlap the zoom label.
// x is always within the frame (computed from gx+1+i, i bounded by gw).
// Branches are well-predicted: values stay in range during normal operation.

static inline uint8_t clamp_to_u8(int v, int lo, int hi) {
    if(v < lo) return (uint8_t)lo;
    if(v > hi) return (uint8_t)hi;
    return (uint8_t)v;
}

static void draw_graph(Canvas* c, BioMapApp* a, int gx, int gy, int gw, int gh) {
    int n  = gw - 2;
    int cy = gy + gh / 2;

    // Graph frame interior — all graph pixels must stay within these bounds
    // to avoid bleeding into the top bar (y < gy+1) or overlapping the
    // zoom label / frame border.
    const int y0 = gy + 1;
    const int y1 = gy + gh - 2;

    // Fold zoom and scale into one constant so the inner loop only needs
    // one multiply per sample instead of two.
    const float combined_scale = a->session.pipeline.zoom.level * ((float)(gh / 2 - 2) / 100.0f);

    // 10-second notches above the graph — integer arithmetic only.
    int px_per_notch = (10 * TICK_HZ) / a->session.pipeline.graph.scroll_divider;
    if(px_per_notch > 2) {
        int right_edge = gx + gw - 2;
        int notch_top = gy > 3 ? gy - 3 : 0;
        for(int x = right_edge - px_per_notch; x > gx; x -= px_per_notch) {
            canvas_draw_line(c, x, notch_top, x, gy);
        }
    }

    // Walk the ring buffer linearly — no modulo divisions per pixel.
    int idx = a->session.pipeline.graph.head;
    float v0 = a->session.pipeline.graph.buf[idx] * combined_scale;
    int y_prev = cy - (int)v0;

    // First column: plot the initial sample, clamped to graph interior.
    canvas_draw_dot(c, (uint8_t)(gx + 1), clamp_to_u8(y_prev, y0, y1));

    for(int i = 1; i < n; i++) {
        if(++idx >= GRAPH_N) idx = 0;

        float v1 = a->session.pipeline.graph.buf[idx] * combined_scale;
        int y_cur = cy - (int)v1;

        // Dot at current sample column — cheap (u8g2_DrawPixel, no Bresenham).
        canvas_draw_dot(c, (uint8_t)(gx + 1 + i), clamp_to_u8(y_cur, y0, y1));

        // Vertical gap-fill: one canvas_draw_line for the entire gap
        // between consecutive dots, drawn at the current column (dx=0).
        // Only fires when |dy| > 1 — rare for normal GSR data.
        if(y_prev < y_cur - 1) {
            canvas_draw_line(c,
                (uint8_t)(gx + 1 + i), clamp_to_u8(y_prev + 1, y0, y1),
                (uint8_t)(gx + 1 + i), clamp_to_u8(y_cur - 1, y0, y1));
        } else if(y_prev > y_cur + 1) {
            canvas_draw_line(c,
                (uint8_t)(gx + 1 + i), clamp_to_u8(y_cur + 1, y0, y1),
                (uint8_t)(gx + 1 + i), clamp_to_u8(y_prev - 1, y0, y1));
        }

        y_prev = y_cur;
    }
}

// ==========================================================================
// Recording view — live display during data logging
// ==========================================================================

// Render the zoom label (bottom-left corner), caching format/width to
// avoid snprintf + canvas_string_width on every frame.  Mutex held by caller.
static void render_zoom_label(Canvas* c, BioMapApp* a, int x) {
    if(a->session.pipeline.zoom.level != a->session.zoom_label_last &&
       a->session.pipeline.zoom.level > a->session.zoom_label_last + 0.05f) {
        snprintf(a->session.zoom_label, sizeof(a->session.zoom_label), "%.1fx",
                 (double)a->session.pipeline.zoom.level);
        canvas_set_font(c, FontSecondary);
        a->session.zoom_label_width = canvas_string_width(c, a->session.zoom_label);
        a->session.zoom_label_last = a->session.pipeline.zoom.level;
    }
    canvas_set_font(c, FontSecondary);
    canvas_draw_str(c, x, 62, a->session.zoom_label);
}

// ── RF visualization constants ────────────────────────────────────────
// All RF modes (GPS+GSR+RF and GPS+RF) now use draw_rf_panel_left — the
// larger labeled left-side panel with per-band calibrated floors.
#define RF_VIZ_FLOOR_DBM  (-90.0f) // ambient-noise reference — matches em_scan_cal_max_floor_dbm; real-world idle (tracks/biomap_111.csv) sits -92.5..-90.5 dBm
#define RF_VIZ_CEIL_DBM   (-72.0f) // "strong signal" reference — real-world elevated peaks (tracks/biomap_111.csv) top out around -72.5 dBm

// Full-scale window (dB) above a band's floor for the left RF panel in
// GPS+GSR+RF mode. Each bar maps this span of "dB above that band's
// floor" onto its full length; the floor itself is the per-band
// Faraday-calibrated noise floor (see draw_rf_panel_left). Kept at 18 dB
// to match the old RF_VIZ_FLOOR..RF_VIZ_CEIL window width.
#define RF_VIZ_SPAN_DB       18.0f

// Width in px of the left RF band panel in BioMapModeGpsGsrRf — the GSR
// graph narrows to the remaining right 2/3 (128 - RF_PANEL_W) of the
// screen, and this panel occupies x 0..RF_PANEL_W-1 / y 16..63.
#define RF_PANEL_W          43

// Render compact GPS info for GPS+RF mode — positioned in the right 2/3
// (x=RF_PANEL_W..127) so the left 1/3 hosts the labeled RF band panel
// (drawn separately via draw_rf_panel_left).  Shows only UTC time (no
// date), lat, lon, and fix quality — fits comfortably in the 85px-wide
// right pane at FontSecondary.
static void render_gps_compact(Canvas* c, BioMapApp* a) {
    GpsStatus g = gps_uart_get_status(a->session.gps);
    const int x = RF_PANEL_W + 2;  // 2px clearance from frame left border
    int y = 25;                    // baseline — 2px clearance from frame top

    // Recording filename at top of the right pane
    if(a->session.recording.active) {
        const char* fn = sd_logger_get_filename(a->session.logger);
        canvas_draw_str(c, x, y, (strlen(fn) > 7) ? fn + 7 : fn);
        y += 10;
    }

    if(gps_uart_is_ready(a->session.gps) && g.date.year) {
        // UTC time only — no date line
        y = draw_fmt(c, x, y, "%02d:%02d:%02d UTC",
            g.time.hours, g.time.minutes, g.time.seconds);

        bool has_fix = gps_has_fix(&g);
        bool gps_ready = has_fix && g.hdop < GPS_HDOP_GATE;

        if(gps_ready) {
            y = draw_fmt(c, x, y, "%.5f", (double)g.latitude);
            y = draw_fmt(c, x, y, "%.5f", (double)g.longitude);
        } else if(has_fix) {
            if(g.hdop < 50.0f) {
                y = draw_fmt(c, x, y, "Acquiring (HDOP:%.1f)", (double)g.hdop);
            } else {
                y = draw_fmt(c, x, y, "Acquiring...");
            }
        } else {
            y = draw_fmt(c, x, y, "Waiting for fix...");
        }

        // Fix quality line
        const char* fix_str = gps_fix_label(g.fix_type);
        float hacc_disp = gps_hacc_display(&g);
        if(hacc_disp < 50.0f) {
            draw_fmt(c, x, y, "%.1fm  %s%s",
                     (double)hacc_disp, fix_str, g.sbas_active ? " SBAS" : "");
        } else {
            draw_fmt(c, x, y, "%s%s",
                     fix_str, g.sbas_active ? " SBAS" : "");
        }
    } else {
        canvas_draw_str(c, x, y, "GPS: no signal");
    }
}

// ── Left RF band panel (GPS+GSR+RF layout) ─────────────────────────────
// Replaces the tiny bottom-right bars in BioMapModeGpsGsrRf: the GSR
// graph narrows to the right 2/3 (see RF_PANEL_W) and this function fills
// the left 1/3 (x 0..RF_PANEL_W-1, y 16..63) with one labeled bar per
// band — 815/868/915 MHz — stacked in three 15px rows.
//
// Bars grow LEFT to RIGHT (level-meter style), which uses the narrow
// panel's horizontal space far better than bottom-up vertical bars would.
// Each label sits UNDERNEATH its bar (not in line with it), which frees
// the full panel width for the bar: a bar runs from x=3 to x=41 (~38px)
// instead of being squeezed to ~21px by an in-line label.
//
// Scale: each bar maps "dB above that band's FLOOR" onto its length, where
// the floor is the per-band Faraday-calibrated noise floor
// (app->rf_cal_data.noise_floor_dbm[i], loaded at startup) — falling back
// to RF_VIZ_FLOOR_DBM when no calibration exists. This is what makes the
// bars correct per band: 868/915 typically calibrate to ~-91.5 dBm while
// 815 sits ~-90.5, so an absolute floor would misread one of them.
// RF_VIZ_SPAN_DB is the full-scale window above the floor. (Called with
// app->mutex already held by biomap_render_callback, so reading
// rf_calibrated/rf_cal_data is safe.)
static void draw_rf_panel_left(Canvas* c, BioMapApp* a, const float rssi_dbm[EM_SCAN_NUM_FREQS]) {
    const int row_h = 15;
    const int row_gap = 1;
    const int panel_x = 1; // left-aligned with a 1px edge margin; label right edge stays clear of the graph frame at x=43
    const int bar_h = 6; // thin enough to leave a 1px gap above the label in a 15px row
    const int bar_max_w = 41 - panel_x; // 40px — bar spans nearly the full panel width

    canvas_set_font(c, FontSecondary);
    for(int i = 0; i < EM_SCAN_NUM_FREQS; i++) {
        int row_top = 16 + i * (row_h + row_gap); // 16 / 32 / 48

        // Per-band floor: Faraday-calibrated noise floor if present, else
        // the default ambient reference. Calibrated floors are validated
        // to lie in [-110, -90] dBm (em_scan_cal.c), so they're always
        // <= the default — a calibrated band may sit below the old floor.
        float floor_dbm = RF_VIZ_FLOOR_DBM;
        if(a->rf_calibrated) floor_dbm = a->rf_cal_data.noise_floor_dbm[i];

        float frac = (rssi_dbm[i] - floor_dbm) / RF_VIZ_SPAN_DB;
        frac = fmaxf(0.0f, fminf(1.0f, frac));
        int w = (int)(frac * bar_max_w + 0.5f);
        if(w > 0) canvas_draw_box(c, panel_x, row_top, w, bar_h);

        // Label under the bar at the bottom of the row — full designation
        // ("815 MHz"), not just the bare band number. The bands are sub-GHz
        // CC1101 channels (0.815/0.868/0.915 GHz), so MHz is the correct
        // unit; GHz would be three orders of magnitude off.
        char label[16];
        snprintf(label, sizeof(label), "%s MHz", em_scan_freq_label[i]);
        canvas_draw_str(c, panel_x, row_top + row_h - 1, label);
    }
}

// nS value, top-right corner — shared by the GSR-Only layout (top-left
// occupied by the time-span label) and the GPS+GSR/GPS+GSR+RF top bar
// (top-left occupied by the GPS badge); previously two copies of the same
// four lines. Returns the fixed worst-case left edge of this element
// ("-99999 nS", not this frame's actual width — see the elapsed-time
// comment in biomap_render_callback for why a fixed placeholder is used).
static int draw_ns_top_right(Canvas* c, BioMapApp* a) {
    // Cache worst-case placeholder width — constant string, measure once.
    static int worst_case_w = 0;
    if(worst_case_w == 0) worst_case_w = canvas_string_width(c, "-99999 nS");

    // Only reformat + remeasure when the nS value actually changes.
    // The float comparison is exact for whole-number nS values rendered
    // with "%.0f" — two frames with the same integer nS produce the
    // identical string and width, so we skip both snprintf and
    // canvas_string_width (an expensive glyph-measurement call).
    float ns = a->session.pipeline.display.filtered_ns;
    if(ns != a->session.ns_label_last) {
        snprintf(a->session.ns_label, sizeof(a->session.ns_label), "%.0f nS", (double)ns);
        a->session.ns_label_width = canvas_string_width(c, a->session.ns_label);
        a->session.ns_label_last = ns;
    }
    int right_margin = a->session.recording.active ? 12 : 2;
    int x = 128 - a->session.ns_label_width - right_margin;
    canvas_draw_str(c, x, 10, a->session.ns_label);
    return 128 - worst_case_w - right_margin;
}

// "Finger cuffs disconnected", centered over two lines inside the graph
// area (which is only the right 2/3 in GPS+GSR+RF mode) when the cuffs
// drop out. Two short lines read better than one long one squeezed into
// the narrowed graph region.
static void draw_inline_graph_status(
    Canvas* c, const char* line1, const char* line2, int center_x) {
    canvas_set_font(c, FontSecondary);
    int w1 = canvas_string_width(c, line1);
    int w2 = canvas_string_width(c, line2);
    canvas_draw_str(c, center_x - w1 / 2, 36, line1);
    canvas_draw_str(c, center_x - w2 / 2, 45, line2);
}

// ==========================================================================
// Sub-renderers — one per mode, called from biomap_render_callback
// ==========================================================================
// Each sub-renderer assumes app->mutex is already held by the caller and
// the canvas has just been cleared.  FontSecondary is the default; switch
// to FontPrimary only where needed (alerts).

// ── GPS badge, top-left (GPS+GSR / GPS+GSR+RF modes) ──────────────────
// Returns the fixed worst-case right edge for elapsed-time centering.
static int render_gps_badge(Canvas* c, BioMapApp* a) {
    GpsStatus g = gps_uart_get_status(a->session.gps);
    bool has_fix = gps_has_fix(&g);
    char badge[16];
    float hacc_disp = gps_hacc_display(&g);
    if(!has_fix) {
        snprintf(badge, sizeof(badge), "No fix");
    } else if(hacc_disp < 50.0f) {
        snprintf(badge, sizeof(badge), "%.1fm", (double)hacc_disp);
    } else {
        snprintf(badge, sizeof(badge), "3D Fix");
    }
    canvas_draw_str(c, 1, 10, badge);
    return 1 + canvas_string_width(c, "No fix");
}

// ── Time-span label, top-left (GSR-only mode) ─────────────────────────
// Returns the fixed worst-case right edge for elapsed-time centering.
static int render_time_span(Canvas* c, BioMapApp* a) {
    char buf[32];
    int t_span = (GRAPH_N * a->session.pipeline.graph.scroll_divider) / TICK_HZ;
    if(t_span >= 60) {
        snprintf(buf, sizeof(buf), "%dm%ds", t_span / 60, t_span % 60);
    } else {
        snprintf(buf, sizeof(buf), "%ds", t_span);
    }
    canvas_draw_str(c, 1, 10, buf);
    return 1 + canvas_string_width(c, "59m59s");
}

// ── Elapsed recording time (centered, all GSR modes) ──────────────────
static void render_elapsed(Canvas* c, BioMapApp* a, int left_edge, int right_edge) {
    if(!a->session.recording.active) return;
    char buf[16];
    int elapsed_min = (int)(a->session.recording.total_ticks / TICK_HZ) / 60;
    if(elapsed_min >= 60) {
        snprintf(buf, sizeof(buf), "%dh%02dm", elapsed_min / 60, elapsed_min % 60);
    } else {
        snprintf(buf, sizeof(buf), "%dm", elapsed_min);
    }
    int w = canvas_string_width(c, buf);
    int gap_left  = left_edge + 3;
    int gap_right = right_edge - 3;
    int x = (gap_left + gap_right - w) / 2;
    if(x < gap_left) x = gap_left;
    if(x + w > gap_right) x = gap_right - w;
    canvas_draw_str(c, x, 10, buf);
}

// ── GSR session (GPS+GSR+RF / GPS+GSR / GSR-only) ─────────────────────
static void render_gsr_session(Canvas* c, BioMapApp* a,
                                bool gsr_visible, bool rf_viz,
                                const float* rf_rssi) {
    BioMapMode mode = a->session.mode;
    bool gps_gsr_top_bar = (mode == BioMapModeGpsGsr || mode == BioMapModeGpsGsrRf);

    // Graph frame — always drawn (even when cuffs disconnected)
    int gx = (mode == BioMapModeGpsGsrRf) ? RF_PANEL_W : 0;
    canvas_draw_frame(c, gx, 16, 128 - gx, 48);

    // Graph data + zoom label (only when signal is visible)
    if(gsr_visible) {
        if(mode == BioMapModeGpsGsrRf) {
            draw_graph(c, a, RF_PANEL_W, 16, 128 - RF_PANEL_W, 48);
            render_zoom_label(c, a, RF_PANEL_W + 2);
        } else {
            draw_graph(c, a, 0, 16, 128, 48);
            render_zoom_label(c, a, 2);
        }
    }

    // RF band panel (GPS+GSR+RF — independent of GSR connect state)
    if(rf_viz) draw_rf_panel_left(c, a, rf_rssi);

    // ── Top bar: left label + right nS value ──────────────────────────
    int top_left  = 0;
    int top_right = 128;

    if(a->session.gsr && gsr_sensor_available(a->session.gsr)) {
        if(gsr_visible) {
            if(mode == BioMapModeGsrOnly) {
                top_left  = render_time_span(c, a);
                top_right = draw_ns_top_right(c, a);
            } else if(gps_gsr_top_bar) {
                top_left  = render_gps_badge(c, a);
                top_right = draw_ns_top_right(c, a);
            }
        } else {
            // Cuffs disconnected — center message in the graph area
            int cx = (mode == BioMapModeGpsGsrRf)
                ? RF_PANEL_W + (128 - RF_PANEL_W) / 2 : 64;
            draw_inline_graph_status(c, "Finger cuffs", "disconnected", cx);
        }
    }
    // No sensor → no pop-up.  Frame is already drawn above; an empty
    // graph area is self-explanatory.

    // Elapsed recording time — centered between left/right top-bar labels
    render_elapsed(c, a, top_left, top_right);
}

// ── Diagnostics screen ────────────────────────────────────────────────
static void render_diagnostics(Canvas* c, BioMapApp* a) {
    if(a->session.gsr && gsr_sensor_available(a->session.gsr)) {
        uint8_t pga = gsr_sensor_get_pga_index(a->session.gsr);
        int32_t mean_cnt = gsr_sensor_get_mean_count(a->session.gsr);
        int32_t window_n = gsr_sensor_get_window_samples(a->session.gsr);
        int y = 8;

        y = draw_fmt(c, 0, y, "PGA:%u Cal:%s Chg:%lu",
                     (unsigned)pga, a->cal_active ? "yes" : "no",
                     (unsigned long)gsr_sensor_get_pga_change_count(a->session.gsr));
        y = draw_fmt(c, 0, y, "Sngl: %ld",
                     (long)a->session.pipeline.display.raw_sample_count);
        y = draw_fmt(c, 0, y, "Mean: %ld (N=%ld)",
                     (long)mean_cnt, (long)window_n);
        y = draw_fmt(c, 0, y, "Hz:%.0f OK:%.0f%% F:%lu",
                     (double)gsr_sensor_get_worker_hz(a->session.gsr),
                     (double)gsr_sensor_get_success_rate(a->session.gsr),
                     (unsigned long)gsr_sensor_get_consecutive_failures(a->session.gsr));

        uint32_t dup_gap = gsr_sensor_get_duplicate_gap_min_ticks(a->session.gsr);
        if(dup_gap == UINT32_MAX) {
            y = draw_fmt(c, 0, y, "Dup:%.0f%% Stl:%.0f%% DG:-",
                         (double)gsr_sensor_get_duplicate_rate(a->session.gsr),
                         (double)gsr_sensor_get_stale_rate(a->session.gsr));
        } else {
            y = draw_fmt(c, 0, y, "Dup:%.0f%% Stl:%.0f%% DG:%lu",
                         (double)gsr_sensor_get_duplicate_rate(a->session.gsr),
                         (double)gsr_sensor_get_stale_rate(a->session.gsr),
                         (unsigned long)dup_gap);
        }
        draw_fmt(c, 0, y, "P2P:%ld 50Hz:%.0f Gap:%lu",
                 (long)gsr_sensor_get_window_ptp(a->session.gsr),
                 (double)gsr_sensor_get_mains_hum_mag(a->session.gsr),
                 (unsigned long)gsr_sensor_get_window_min_gap_ticks(a->session.gsr));
    } else {
        canvas_draw_str(c, 0, 8, "GSR: --");
    }
}

// ── GPS + RF mode ─────────────────────────────────────────────────────
static void render_gps_rf(Canvas* c, BioMapApp* a,
                           bool rf_viz, const float* rf_rssi) {
    canvas_draw_frame(c, RF_PANEL_W, 16, 128 - RF_PANEL_W, 48);
    if(rf_viz) draw_rf_panel_left(c, a, rf_rssi);
    render_gps_compact(c, a);
}

// ==========================================================================
// Main render callback — dispatcher (one mode → one sub-renderer)
// ==========================================================================

void biomap_render_callback(Canvas* c, void* ctx) {
    BioMapApp* a = (BioMapApp*)ctx;
    if(furi_mutex_acquire(a->mutex, 10) != FuriStatusOk) return;
    canvas_clear(c);
    canvas_set_font(c, FontSecondary);

    bool is_diag   = (a->session.mode == BioMapModeDiagnostics);
    bool has_graph = has_gsr(a->session.mode) && !is_diag;

    // RF snapshot — needed by both GSR session and GPS+RF modes
    float rf_rssi[EM_SCAN_NUM_FREQS];
    bool rf_viz = (a->session.mode == BioMapModeGpsGsrRf || a->session.mode == BioMapModeGpsOnly)
               && a->session.gsr;
    if(rf_viz) gsr_sensor_get_rf_snapshot(a->session.gsr, rf_rssi);

    if(is_diag) {
        render_diagnostics(c, a);
    } else if(has_graph) {
        bool gsr_visible = a->session.gsr
                        && gsr_sensor_available(a->session.gsr)
                        && gsr_sensor_is_connected(a->session.gsr);
        render_gsr_session(c, a, gsr_visible, rf_viz, rf_rssi);
    } else if(a->session.gps) {
        render_gps_rf(c, a, rf_viz, rf_rssi);
    } else {
        canvas_draw_str(c, 0, 20, "GPS unavailable");
    }

    // Recording indicator — shared across all modes
    if(a->session.recording.active) {
        canvas_draw_box(c, 118, 1, 8, 8);
    }

    furi_mutex_release(a->mutex);
}

// ==========================================================================
// Menu & options rendering
// ==========================================================================

// Index of the first visible row when a list of `count` items, `max_visible`
// of which fit on screen at once, is scrolled to keep `sel` in view.
// Shared by draw_selection_list below and options_render's separate overlay
// pass over the same rows (previously two copies of this calculation, which
// must agree or the toggle-state text would land on the wrong row).
static int scroll_window_top(int sel, int count, int max_visible) {
    int top = 0;
    if(count > max_visible) {
        if(sel >= top + max_visible) top = sel - max_visible + 1;
        if(sel < top) top = sel;
    }
    return top;
}

static void draw_selection_list(Canvas* c, int sel, int count,
                         const char* const* labels, int start_y, int max_visible) {
    int top = scroll_window_top(sel, count, max_visible);
    for(int i = top; i < count && (i - top) < max_visible; i++) {
        int y = start_y + (i - top) * 10;
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
    if(furi_mutex_acquire(a->mutex, 10) != FuriStatusOk) return;
    canvas_clear(c);
    canvas_set_font(c, FontPrimary);
    canvas_draw_str(c, 0, 10, "Bio Mapping");
    canvas_set_font(c, FontSecondary);
    draw_selection_list(c, (int)m_ctx->selection, MENU_COUNT, menu_labels, 22, 5);
    furi_mutex_release(a->mutex);
}

void options_render(Canvas* c, void* ctx) {
    OptionsContext* o_ctx = (OptionsContext*)ctx;
    BioMapApp* a = o_ctx->app;
    if(furi_mutex_acquire(a->mutex, 10) != FuriStatusOk) return;
    canvas_clear(c);
    canvas_set_font(c, FontPrimary);
    canvas_draw_str(c, 0, 10, "Options");
    canvas_set_font(c, FontSecondary);
    int sel = (int)o_ctx->selection;

    int max_visible = 5;
    int top = scroll_window_top(sel, OPTIONS_COUNT, max_visible);

    draw_selection_list(c, sel, OPTIONS_COUNT, options_labels, 22, max_visible);

    // Overlay toggle state on selectable items
    for(int i = top; i < OPTIONS_COUNT && (i - top) < max_visible; i++) {
        if(i == OptResetGps || i == OptDiagnostics) continue; // no right-aligned state text
        int y = 22 + (i - top) * 10;
        const char* state;
        if(i == OptGpsProfile) {
            // Indexed by GpsNavModel's enum ordinal (biomap_config.h) —
            // Pedestrian/Wrist/Vehicle/Stationary/Sea/Bike/Flight = 0..6.
            static const char* const nav_model_labels[7] = {
                "PED", "WRIST", "VEHICLE", "STATION", "SEA", "BIKE", "FLIGHT",
            };
            state = nav_model_labels[a->nav_model];
        } else if(i == OptAutoZoom) {
            state = a->zoom_enabled ? "ON" : "OFF";
        } else if(i == OptGsrCalibration) {
            state = a->cal_active ? "YES" : "NO";
        } else if(i == OptRfCalibration) {
            state = a->rf_calibrated ? "YES" : "NO";
        } else if(i == OptBacklight) {
            state = a->backlight_on ? "ON" : "OFF";
        } else if(i == OptSound) {
            state = a->sound_enabled ? "ON" : "OFF";
        } else {
            continue;
        }
        int sx = 128 - canvas_string_width(c, state) - 2;
        if(i == sel) canvas_invert_color(c);
        canvas_draw_str(c, sx, y, state);
        if(i == sel) canvas_invert_color(c);
    }
    canvas_set_font(c, FontSecondary);
    furi_mutex_release(a->mutex);
}

// Shared render body for the GSR and RF calibration menus (run_cal_submenu,
// biomap_gui.c) — same "Start Wizard / Reset to Default / Show Current"
// 3-item list, differing only in the title. Previously two copies.
//
// ctx is a CalSubmenuContext* (biomap.h) — guarded by app->mutex against
// run_cal_submenu()'s key-handling loop, same as menu_render/options_render
// below. Was a bare int* read with no lock at all until the 2026-07-31
// mutex audit found it.
static void draw_cal_submenu(Canvas* c, void* ctx, const char* title) {
    CalSubmenuContext* sm = (CalSubmenuContext*)ctx;
    if(furi_mutex_acquire(sm->app->mutex, 10) != FuriStatusOk) return;
    int sel = (int)sm->selection;
    canvas_clear(c);
    canvas_set_font(c, FontPrimary);
    canvas_draw_str(c, 0, 10, title);
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
    furi_mutex_release(sm->app->mutex);
}

void calibration_menu_render(Canvas* c, void* ctx) {
    draw_cal_submenu(c, ctx, "GSR Calibration");
}

void calibration_wizard_render(Canvas* c, void* ctx) {
    WizardState* w = (WizardState*)ctx;

    // Guards against run_calibration_wizard()'s measurement loop (main
    // thread), which rewrites step/measured[]/gain/offset/r_squared as
    // each resistor is measured — see WizardState's doc comment in
    // biomap.h.
    furi_mutex_acquire(w->mutex, FuriWaitForever);
    int step = w->step;
    float gain = w->gain;
    float offset = w->offset;
    float r_squared = w->r_squared;
    furi_mutex_release(w->mutex);

    canvas_clear(c);
    canvas_set_font(c, FontPrimary);
    canvas_draw_str(c, 0, 10, "GSR Calibration");
    canvas_set_font(c, FontSecondary);

    switch(step) {
    case 0: case 1: case 2: case 3: case 4: case 5: {
        static const struct { const char* level; const char* resistor; } cal_steps[3] = {
            {"Low", "470k"}, {"Mid", "100k"}, {"High", "47k"},
        };
        int idx = step / 2;
        if(step % 2 == 0) { // Prompt
            draw_fmt(c, 0, 25, "Step %d/3: %s (%s)",
                     idx + 1, cal_steps[idx].level, cal_steps[idx].resistor);
            draw_fmt(c, 0, 37, "Connect %s resistor", cal_steps[idx].resistor);
            canvas_draw_str(c, 0, 49, "[Press OK to measure]");
        } else { // Measuring
            draw_fmt(c, 0, 25, "Measuring %s...", cal_steps[idx].resistor);
            canvas_draw_str(c, 0, 40, "Keep resistor connected");
        }
        break;
    }
    case 8: // Success
        canvas_draw_str(c, 0, 23, "Calibration Success!");
        draw_fmt(c, 0, 35, "Gain: %.3fx  R\xb2: %.4f", (double)gain, (double)r_squared);
        draw_fmt(c, 0, 47, "Offset: %.0f nS", (double)offset);
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
        draw_fmt(c, 0, 49, "Gain: %.3fx  R\xb2: %.4f", (double)gain, (double)r_squared);
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

    if(furi_mutex_acquire(app->mutex, 10) != FuriStatusOk) return;
    bool active = app->cal_active;
    float gain = app->cal_gain;
    float offset = app->cal_offset;
    furi_mutex_release(app->mutex);

    draw_fmt(c, 0, 23, "Active %s Cal:", active ? "Custom" : "Default");
    draw_fmt(c, 0, 35, "Gain: %.3fx", (double)gain);
    draw_fmt(c, 0, 47, "Offset: %.0f nS", (double)offset);
    canvas_draw_str(c, 0, 60, "[Press OK or Back to return]");
}

// ==========================================================================
// RF Faraday calibration menu & wizard rendering
// ==========================================================================

void rf_calibration_menu_render(Canvas* c, void* ctx) {
    draw_cal_submenu(c, ctx, "RF Calibration");
}

void rf_calibration_wizard_prep_render(Canvas* c, void* ctx) {
    RfCalWizardState* w = (RfCalWizardState*)ctx;
    canvas_clear(c);
    canvas_set_font(c, FontPrimary);
    canvas_draw_str(c, 0, 10, "RF Faraday Calibration");
    canvas_set_font(c, FontSecondary);
    canvas_draw_str(c, 0, 25, "Place Flipper inside RF");
    canvas_draw_str(c, 0, 35, "shielding bag/box & seal.");

    // Guards against run_rf_calibration_wizard()'s prep-countdown loop
    // (main thread), which rewrites seconds_left every ~1s — see
    // RfCalWizardState's doc comment in biomap.h.
    furi_mutex_acquire(w->mutex, FuriWaitForever);
    uint32_t seconds_left = w->seconds_left;
    furi_mutex_release(w->mutex);

    char buf[32];
    snprintf(buf, sizeof(buf), "Pre-bagging: %lus", (unsigned long)seconds_left);
    canvas_draw_str(c, 0, 47, buf);
    canvas_draw_str(c, 0, 60, "[OK=Skip wait, Back=Cancel]");
}

void rf_calibration_wizard_sampling_render(Canvas* c, void* ctx) {
    RfCalWizardState* w = (RfCalWizardState*)ctx;
    canvas_clear(c);
    canvas_set_font(c, FontPrimary);
    canvas_draw_str(c, 0, 10, "Zeroing CC1101...");
    canvas_set_font(c, FontSecondary);

    furi_mutex_acquire(w->mutex, FuriWaitForever);
    uint32_t seconds_left = w->seconds_left;
    float rssi_dbm[EM_SCAN_NUM_FREQS];
    memcpy(rssi_dbm, w->rssi_dbm, sizeof(rssi_dbm));
    furi_mutex_release(w->mutex);

    draw_fmt(c, 0, 25, "Sampling: %lus", (unsigned long)seconds_left);
    draw_fmt(c, 0, 37, "%s:%.0f %s:%.0f %s:%.0f",
             em_scan_freq_label[0], (double)rssi_dbm[0],
             em_scan_freq_label[1], (double)rssi_dbm[1],
             em_scan_freq_label[2], (double)rssi_dbm[2]);
    canvas_draw_str(c, 0, 60, "[Back = Cancel]");
}

void rf_calibration_wizard_stats_render(Canvas* c, void* ctx) {
    RfCalWizardState* w = (RfCalWizardState*)ctx;

    // Not racing against a live writer by this point (see the "no mutex
    // needed here" comment where these are computed in biomap_rf_cal.c),
    // but taking the lock anyway costs nothing and keeps this function
    // honest about being a reader of shared state — snapshotted up front,
    // before any use, rather than reading w-> directly further down.
    furi_mutex_acquire(w->mutex, FuriWaitForever);
    bool passed = w->passed;
    uint32_t sweep_count = w->sweep_count;
    float computed_floors[EM_SCAN_NUM_FREQS];
    float computed_std_devs[EM_SCAN_NUM_FREQS];
    memcpy(computed_floors, w->computed_floors, sizeof(computed_floors));
    memcpy(computed_std_devs, w->computed_std_devs, sizeof(computed_std_devs));
    furi_mutex_release(w->mutex);

    canvas_clear(c);
    canvas_set_font(c, FontPrimary);
    canvas_draw_str(c, 0, 10, passed ? "Calibration Passed!" : "Calibration Failed!");
    canvas_set_font(c, FontSecondary);

    char buf[48];
    if(passed) {
        float min_f = computed_floors[0];
        float max_f = computed_floors[0];
        float max_std = computed_std_devs[0];
        for(int i = 1; i < EM_SCAN_NUM_FREQS; i++) {
            if(computed_floors[i] < min_f) min_f = computed_floors[i];
            if(computed_floors[i] > max_f) max_f = computed_floors[i];
            if(computed_std_devs[i] > max_std) max_std = computed_std_devs[i];
        }
        draw_fmt(c, 0, 24, "Floors: %.1f to %.1f dBm", (double)min_f, (double)max_f);
        draw_fmt(c, 0, 36, "Max StdDev: %.2fdB (OK)", (double)max_std);
        canvas_draw_str(c, 0, 60, "[OK=Save, Back=Discard]");
    } else if(sweep_count < 5) {
        snprintf(buf, sizeof(buf), "Too few sweeps: %lu (need 5+)", (unsigned long)sweep_count);
        canvas_draw_str(c, 0, 24, buf);
        canvas_draw_str(c, 0, 36, "Sampling ran too slow/short");
        canvas_draw_str(c, 0, 60, "[OK/Back = Exit]");
    } else {
        int worst_std_idx = 0;
        float worst_std = computed_std_devs[0];
        int worst_floor_idx = -1;
        float worst_floor_margin = 0.0f;

        for(int i = 0; i < EM_SCAN_NUM_FREQS; i++) {
            if(computed_std_devs[i] > worst_std) {
                worst_std = computed_std_devs[i];
                worst_std_idx = i;
            }
            float margin = computed_floors[i] - em_scan_cal_max_floor_dbm[i];
            if(margin > worst_floor_margin) {
                worst_floor_margin = margin;
                worst_floor_idx = i;
            }
        }

        if(worst_floor_idx >= 0) {
            draw_fmt(c, 0, 24, "Unshielded (>%.0fdBm)", (double)em_scan_cal_max_floor_dbm[worst_floor_idx]);
            draw_fmt(c, 0, 36, "Worst: %sMHz %.1fdBm",
                     em_scan_freq_label[worst_floor_idx], (double)computed_floors[worst_floor_idx]);
            canvas_draw_str(c, 0, 48, "Place Flipper in Faraday bag!");
        } else {
            canvas_draw_str(c, 0, 24, "High Noise Variance (>3.5dB)");
            draw_fmt(c, 0, 36, "Worst: %sMHz %.2fdB",
                     em_scan_freq_label[worst_std_idx], (double)worst_std);
            canvas_draw_str(c, 0, 48, "Check bag seal for leaks!");
        }
        canvas_draw_str(c, 0, 60, "[OK/Back = Exit]");
    }
}

void rf_show_current_calibration_render(Canvas* c, void* ctx) {
    BioMapApp* app = (BioMapApp*)ctx;
    canvas_clear(c);
    canvas_set_font(c, FontPrimary);
    canvas_draw_str(c, 0, 10, "RF Calibration");
    canvas_set_font(c, FontSecondary);

    if(furi_mutex_acquire(app->mutex, 10) != FuriStatusOk) return;
    bool calibrated = app->rf_calibrated;
    EmScanCal cal = app->rf_cal_data;
    furi_mutex_release(app->mutex);

    if(!calibrated) {
        canvas_draw_str(c, 0, 24, "Not calibrated.");
    } else {
        int y = 24;
        y = draw_fmt(c, 0, y, "Band Floors (dBm):");
        for(int i = 0; i < EM_SCAN_NUM_FREQS; i++) {
            y = draw_fmt(c, 0, y, "%s: %.1f  (std %.2f)",
                         em_scan_freq_label[i],
                         (double)cal.noise_floor_dbm[i],
                         (double)cal.noise_std_dev_db[i]);
        }
    }
    canvas_draw_str(c, 0, 60, "[Press OK or Back to return]");
}
