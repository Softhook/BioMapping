// Bio Mapping — Canvas rendering callbacks for all ViewPorts.
#include "biomap.h"

// ── Label arrays for menu and options screens ──────────────────────────────

static const char* const menu_labels[MENU_COUNT] = {
    "GPS + GSR + RF", "GPS + GSR", "GPS + RF", "GSR Only", "Options",
};

static const char* const options_labels[OPTIONS_COUNT] = {
    "Reset GPS",
    "Auto-zoom GSR",
    "Backlight",
    "GSR Calibration",
    "Diagnostics",
    "Sound",
    "GPS Profile",
    "RF Calibration",
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
        float hacc_disp = (g.hacc < 50.0f) ? g.hacc : ((g.hdop < 50.0f) ? g.hdop * 2.5f : 99.9f);
        if(hacc_disp < 50.0f) {
            snprintf(buf, sizeof(buf), "%.1fm  %s%s",
                     (double)hacc_disp, fix_str, g.sbas_active ? " SBAS" : "");
        } else {
            snprintf(buf, sizeof(buf), "%s%s",
                     fix_str, g.sbas_active ? " SBAS" : "");
        }
        canvas_draw_str(c, 0, y, buf);
    } else {
        canvas_draw_str(c, 0, y, "GPS: no signal");
    }
}

// Render the zoom label (bottom-left corner), caching format/width to
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

// ── Live RF band indicator ──────────────────────────────────────────────
// Three tiny bars, one per em_scan_freq_hz/em_scan_freq_label band
// (815/868/915 MHz), height = live RSSI on a fixed dBm scale — but nothing
// is drawn at all for a band sitting at/below RF_VIZ_FLOOR_DBM, so the
// corner stays blank during ordinary ambient conditions and a bar only
// appears once that band is actually elevated. Deliberately no numbers or
// labels — a glanceable "is anything elevated right now" instrument, not a
// data readout (the real per-band dBm values already go to the CSV via
// format_gps_csv_row, biomap_session.c). Drawn in
// BioMapModeGpsGsrRf (bottom-right, mirroring render_zoom_label's
// bottom-left corner above) and BioMapModeGpsOnly ("GPS + RF" — top-right,
// where GpsGsr's nS value/GPS badge would go but don't apply to this
// GSR-less mode) — see biomap_render_callback.
#define RF_VIZ_FLOOR_DBM  (-90.0f) // ambient-noise reference — matches em_scan_cal_max_floor_dbm; real-world idle (tracks/biomap_111.csv) sits -92.5..-90.5 dBm
#define RF_VIZ_CEIL_DBM   (-72.0f) // "strong signal" reference — real-world elevated peaks (tracks/biomap_111.csv) top out around -72.5 dBm
#define RF_VIZ_BAR_W          3
#define RF_VIZ_BAR_GAP        1
#define RF_VIZ_BAR_MAX_H      8

// Draws EM_SCAN_NUM_FREQS bars growing upward from (right_x, baseline_y),
// right-aligned so right_x is always the rightmost pixel regardless of
// which corner the caller places them in. At or below RF_VIZ_FLOOR_DBM a
// band draws NOTHING at all — no sliver, no placeholder — so the corner is
// genuinely blank during ordinary ambient conditions, and a bar only
// appears once that band's reading has actually risen above the floor.
static void draw_rf_bars(Canvas* c, const float rssi_dbm[EM_SCAN_NUM_FREQS],
                          int right_x, int baseline_y) {
    int total_w = EM_SCAN_NUM_FREQS * RF_VIZ_BAR_W + (EM_SCAN_NUM_FREQS - 1) * RF_VIZ_BAR_GAP;
    int left_x = right_x - total_w + 1;
    for(int i = 0; i < EM_SCAN_NUM_FREQS; i++) {
        float frac = (rssi_dbm[i] - RF_VIZ_FLOOR_DBM) / (RF_VIZ_CEIL_DBM - RF_VIZ_FLOOR_DBM);
        frac = fmaxf(0.0f, fminf(1.0f, frac));
        int h = (int)(frac * RF_VIZ_BAR_MAX_H + 0.5f);
        if(h <= 0) continue; // at/below the floor — draw nothing for this band
        int bx = left_x + i * (RF_VIZ_BAR_W + RF_VIZ_BAR_GAP);
        canvas_draw_box(c, bx, baseline_y - h, RF_VIZ_BAR_W, h);
    }
}

// nS value, top-right corner — shared by the GSR-Only layout (top-left
// occupied by the time-span label) and the GPS+GSR/GPS+GSR+RF top bar
// (top-left occupied by the GPS badge); previously two copies of the same
// four lines. Returns the fixed worst-case left edge of this element
// ("-99999 nS", not this frame's actual width — see the elapsed-time
// comment in biomap_render_callback for why a fixed placeholder is used).
static int draw_ns_top_right(Canvas* c, BioMapApp* a) {
    char buf[16];
    snprintf(buf, sizeof(buf), "%.0f nS", (double)a->session.pipeline.display.filtered_ns);
    int right_margin = a->session.recording.active ? 12 : 2;
    int x = 128 - canvas_string_width(c, buf) - right_margin;
    canvas_draw_str(c, x, 10, buf);
    return 128 - canvas_string_width(c, "-99999 nS") - right_margin;
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
    if(furi_mutex_acquire(a->mutex, 10) != FuriStatusOk) return;
    canvas_clear(c);

    bool has_graph = has_gsr(a->session.mode)
                  && a->session.mode != BioMapModeDiagnostics;
    bool is_diag   = (a->session.mode == BioMapModeDiagnostics);
    // GPS+GSR-style top bar (badge top-left, nS top-right) applies to both
    // GpsGsr and GpsGsrRf — anything with both GPS and GSR but not the
    // GsrOnly time-span layout below. Added as its own flag (2026-07-29)
    // rather than adding a second `|| mode == BioMapModeGpsGsrRf` at each
    // call site, after BioMapModeGpsGsrRf's addition broke both direct
    // `mode == BioMapModeGpsGsr` checks below — the top-left badge and the
    // top-right nS value silently stopped rendering in the new mode
    // because neither check was updated when the enum gained a new value.
    bool gps_gsr_top_bar = (a->session.mode == BioMapModeGpsGsr
                          || a->session.mode == BioMapModeGpsGsrRf);

    // Live RF band-bar snapshot (see draw_rf_bars above) — fetched once
    // here rather than separately in each branch below. Scoped to exactly
    // GpsGsrRf/GpsOnly, NOT has_rf()'s full set — Diagnostics also has RF
    // active (see has_rf's doc comment in biomap_types.h) but shows its own
    // dedicated diagnostic counters instead, so it doesn't need these bars
    // and shouldn't pay for the snapshot's mutex acquisition either. Since
    // has_graph's mode set ({GpsGsrRf, GpsGsr, GsrOnly}) and rf_viz's mode
    // set ({GpsGsrRf, GpsOnly}) only overlap at GpsGsrRf, and the no-graph
    // branch further down only reaches GpsOnly among rf_viz's set, plain
    // `if(rf_viz)` at each draw_rf_bars call site below is already
    // equivalent to checking the specific mode — no need to re-check it.
    float rf_rssi[EM_SCAN_NUM_FREQS];
    bool rf_viz = (a->session.mode == BioMapModeGpsGsrRf || a->session.mode == BioMapModeGpsOnly)
               && a->session.gsr;
    if(rf_viz) gsr_sensor_get_rf_snapshot(a->session.gsr, rf_rssi);

    // Right/left edges of whatever ends up occupying the top-left label
    // (GPS badge / time-span) and top-right nS value slots on this frame.
    // Populated below as those elements are drawn, then used to place the
    // elapsed-recording-time text so it can never overlap either one.
    int top_left_edge  = 0;
    int top_right_edge = 128;

    // Graph + zoom label (GSR modes except diagnostics)
    if(has_graph) {
        draw_graph(c, a, 0, 16, 128, 48);
        render_zoom_label(c, a);
        // RF bars, bottom-right — mirrors render_zoom_label's bottom-left
        // corner above. Independent of GSR connect state (the cuffs being
        // disconnected doesn't affect RF), so this sits outside the
        // gsr_sensor_is_connected() branch below.
        if(rf_viz) draw_rf_bars(c, rf_rssi, 126, 63);
    }

    // Recording indicator only — no title to maximise data visibility
    canvas_set_font(c, FontSecondary);
    if(a->session.recording.active) {
        canvas_draw_box(c, 118, 1, 8, 8);
    }

    // GPS quality badge — GPS+GSR / GPS+GSR+RF, top-left
    if(gps_gsr_top_bar && a->session.gps) {
        GpsStatus g = gps_uart_get_status(a->session.gps);
        bool has_fix = gps_has_fix(&g);
        char badge[16];
        float hacc_disp = (g.hacc < 50.0f) ? g.hacc : ((g.hdop < 50.0f) ? g.hdop * 2.5f : 99.9f);
        if(!has_fix) {
            snprintf(badge, sizeof(badge), "No fix");
        } else if(hacc_disp < 50.0f) {
            snprintf(badge, sizeof(badge), "%.1fm", (double)hacc_disp);
        } else {
            snprintf(badge, sizeof(badge), "3D Fix");
        }
        canvas_set_font(c, FontSecondary);
        canvas_draw_str(c, 1, 10, badge);
        // Fixed worst-case reservation ("No fix", the widest candidate),
        // NOT this frame's actual badge width — using the real width here
        // means every hacc digit-count change moves this boundary, which
        // visibly shifts the elapsed-time text sideways as it re-centers
        // against a moving target every frame. See the elapsed-time
        // comment below for the fuller rationale.
        top_left_edge = 1 + canvas_string_width(c, "No fix");
    }

    // ── Diagnostics: GSR only, 6 labeled lines ─────────────────────────
    // Deliberately raw-count values (Sngl/Mean), not the nS-converted
    // Raw/Filt this used to also show: TIA conversion is a pure,
    // already-unit-tested function of Sngl (test_tia_conversion), and
    // Filt is the smoothed display-path value the docs already describe
    // as cosmetic-only — neither adds diagnostic signal beyond what
    // Sngl/Mean give closer to the hardware. Chg/F/DG/Gap/P2P/50Hz are
    // folded onto the line they're most related to rather than each
    // getting their own, to stay within 6 lines at comfortable 10 px
    // spacing (7+ needs cramped 8 px spacing — see git history). DG
    // (duplicate-specific gap) sits with Dup/Cn since it's a property of
    // the flagged-duplicate reads; Gap (general window minimum) sits
    // with P2P/50Hz as a general pacing stat instead — see
    // gsr_sensor_get_duplicate_gap_min_ticks()'s doc comment for why
    // they answer different questions.
    if(is_diag) {
        canvas_set_font(c, FontSecondary);

        if(a->session.gsr && gsr_sensor_available(a->session.gsr)) {
            uint8_t pga = gsr_sensor_get_pga_index(a->session.gsr);
            int32_t mean_cnt = gsr_sensor_get_mean_count(a->session.gsr);
            int32_t window_n = gsr_sensor_get_window_samples(a->session.gsr);
            char buf[32];
            int y = 8;

            snprintf(buf, sizeof(buf), "PGA:%u Cal:%s Chg:%lu",
                     (unsigned)pga, a->cal_active ? "yes" : "no",
                     (unsigned long)gsr_sensor_get_pga_change_count(a->session.gsr));
            canvas_draw_str(c, 0, y, buf);  y += 10;

            snprintf(buf, sizeof(buf), "Sngl: %ld",
                     (long)a->session.pipeline.display.raw_sample_count);
            canvas_draw_str(c, 0, y, buf);  y += 10;

            snprintf(buf, sizeof(buf), "Mean: %ld (N=%ld)", (long)mean_cnt, (long)window_n);
            canvas_draw_str(c, 0, y, buf);  y += 10;

            snprintf(buf, sizeof(buf), "Hz:%.0f OK:%.0f%% F:%lu",
                     (double)gsr_sensor_get_worker_hz(a->session.gsr),
                     (double)gsr_sensor_get_success_rate(a->session.gsr),
                     (unsigned long)gsr_sensor_get_consecutive_failures(a->session.gsr));
            canvas_draw_str(c, 0, y, buf);  y += 10;

            // DG (duplicate-gap-min) sits on the Dup line since it's a
            // direct property of the reads that were flagged duplicate,
            // not a general pacing stat — see
            // gsr_sensor_get_duplicate_gap_min_ticks()'s doc comment for
            // why it's a stronger check than the general window Gap
            // (moved to the P2P/50Hz line below) for the "did a fast
            // loop iteration actually cause this duplicate" question.
            // UINT32_MAX means no duplicates happened this window —
            // shown as "-", not a nonsense huge number.
            uint32_t dup_gap = gsr_sensor_get_duplicate_gap_min_ticks(a->session.gsr);
            if(dup_gap == UINT32_MAX) {
                snprintf(buf, sizeof(buf), "Dup:%.0f%% Stl:%.0f%% DG:-",
                         (double)gsr_sensor_get_duplicate_rate(a->session.gsr),
                         (double)gsr_sensor_get_stale_rate(a->session.gsr));
            } else {
                snprintf(buf, sizeof(buf), "Dup:%.0f%% Stl:%.0f%% DG:%lu",
                         (double)gsr_sensor_get_duplicate_rate(a->session.gsr),
                         (double)gsr_sensor_get_stale_rate(a->session.gsr),
                         (unsigned long)dup_gap);
            }
            canvas_draw_str(c, 0, y, buf);  y += 10;

            snprintf(buf, sizeof(buf), "P2P:%ld 50Hz:%.0f Gap:%lu",
                     (long)gsr_sensor_get_window_ptp(a->session.gsr),
                     (double)gsr_sensor_get_mains_hum_mag(a->session.gsr),
                     (unsigned long)gsr_sensor_get_window_min_gap_ticks(a->session.gsr));
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
                        // Fixed worst-case reservation, not this frame's
                        // actual width — see the elapsed-time comment below.
                        top_left_edge = 1 + canvas_string_width(c, "59m59s");
                        // nS value — top-right. Real readings have been
                        // observed up to 5 digits (e.g. 10767).
                        top_right_edge = draw_ns_top_right(c, a);
                    } else if(gps_gsr_top_bar) {
                        // nS value — top-right (GPS badge already at top-left)
                        top_right_edge = draw_ns_top_right(c, a);
                    }
                } else {
                    draw_sensor_alert(c, "NO SIGNAL");
                }
            } else {
                draw_sensor_alert(c, "NO SENSOR");
            }
        }

        // Elapsed recording time — centered in whatever gap remains between
        // the top-left label and top-right nS value, clamped to fixed
        // worst-case edges so it can never overlap either one. Minutes only
        // (no seconds — not useful at a glance); rolls over to "1h05m"
        // past 60 minutes.
        //
        // top_left_edge/top_right_edge are deliberately sized from fixed
        // placeholder strings ("No fix", "-99999 nS", etc.) above, NOT
        // from this frame's actual badge/nS-value text. Using the real
        // width made this text visibly slide sideways every frame: as the
        // GSR reading's digit count changes (real readings span 4-5
        // digits, e.g. 4565 to 10767) or GPS accuracy's digit count
        // changes, the boundary it's centered against moved with it. The
        // fixed placeholders are conservative (real content is always
        // narrower or equal), so the elapsed-time text can still never
        // overlap the badge/nS value — it just no longer chases them.
        if(a->session.recording.active) {
            char elapsed_buf[16];
            int elapsed_min = (int)(a->session.recording.total_ticks / TICK_HZ) / 60;
            if(elapsed_min >= 60) {
                snprintf(elapsed_buf, sizeof(elapsed_buf), "%dh%02dm",
                         elapsed_min / 60, elapsed_min % 60);
            } else {
                snprintf(elapsed_buf, sizeof(elapsed_buf), "%dm", elapsed_min);
            }
            canvas_set_font(c, FontSecondary);
            int elapsed_w = canvas_string_width(c, elapsed_buf);
            int gap_left  = top_left_edge + 3;
            int gap_right = top_right_edge - 3;
            int elapsed_x = (gap_left + gap_right - elapsed_w) / 2;
            if(elapsed_x < gap_left) elapsed_x = gap_left;
            if(elapsed_x + elapsed_w > gap_right) elapsed_x = gap_right - elapsed_w;
            canvas_draw_str(c, elapsed_x, 10, elapsed_buf);
        }
    } else if(!is_diag && a->session.gps) {
        render_gps_detail(c, a);
        // RF bars, top-right — this mode (GpsOnly, "GPS + RF") has no GSR
        // badge/nS value up there (gps_gsr_top_bar doesn't apply to it), so
        // the corner is otherwise empty EXCEPT for the recording indicator
        // box (118,1,8x8, drawn earlier in this function) whenever
        // recording.active — same right_margin dance draw_ns_top_right
        // uses for the same reason: shift further left while that box is
        // showing so the bars don't land on top of it.
        if(rf_viz) {
            int right_margin = a->session.recording.active ? 12 : 2;
            draw_rf_bars(c, rf_rssi, 128 - right_margin, 10);
        }
    } else if(!is_diag) {
        canvas_draw_str(c, 0, 20, "GPS unavailable");
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
        if(i == 0 || i == 4) continue; // Reset GPS and Diagnostics have no right-aligned state text
        int y = 22 + (i - top) * 10;
        const char* state;
        if(i == 1) {
            state = a->zoom_enabled ? "ON" : "OFF";
        } else if(i == 2) {
            state = a->backlight_on ? "ON" : "OFF";
        } else if(i == 3) {
            state = a->cal_active ? "YES" : "NO";
        } else if(i == 5) {
            state = a->sound_enabled ? "ON" : "OFF";
        } else if(i == 7) {
            state = a->rf_calibrated ? "YES" : "NO";
        } else {
            // Indexed by GpsNavModel's enum ordinal (biomap_config.h) —
            // Pedestrian/Wrist/Vehicle/Stationary/Sea/Bike/Flight = 0..6.
            static const char* const nav_model_labels[7] = {
                "PED", "WRIST", "VEHICLE", "STATION", "SEA", "BIKE", "FLIGHT",
            };
            state = nav_model_labels[a->nav_model];
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

    char buf[64];
    switch(step) {
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
        snprintf(buf, sizeof(buf), "Gain: %.3fx  R\xb2: %.4f", (double)gain, (double)r_squared);
        canvas_draw_str(c, 0, 35, buf);
        snprintf(buf, sizeof(buf), "Offset: %.0f nS", (double)offset);
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
        snprintf(buf, sizeof(buf), "Gain: %.3fx  R\xb2: %.4f", (double)gain, (double)r_squared);
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
    if(furi_mutex_acquire(app->mutex, 10) != FuriStatusOk) return;
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

    // Guards against run_rf_calibration_wizard()'s sampling loop (main
    // thread), which rewrites rssi_dbm[]/seconds_left every ~100ms — the
    // live race this mutex was actually added for (see RfCalWizardState's
    // doc comment in biomap.h).
    furi_mutex_acquire(w->mutex, FuriWaitForever);
    uint32_t seconds_left = w->seconds_left;
    float rssi_dbm[EM_SCAN_NUM_FREQS];
    memcpy(rssi_dbm, w->rssi_dbm, sizeof(rssi_dbm));
    furi_mutex_release(w->mutex);

    char buf[32];
    snprintf(buf, sizeof(buf), "Sampling: %lus", (unsigned long)seconds_left);
    canvas_draw_str(c, 0, 25, buf);

    char live[48];
    snprintf(live, sizeof(live), "%s:%.0f %s:%.0f %s:%.0f",
             em_scan_freq_label[0], (double)rssi_dbm[0],
             em_scan_freq_label[1], (double)rssi_dbm[1],
             em_scan_freq_label[2], (double)rssi_dbm[2]);
    canvas_draw_str(c, 0, 37, live);
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
        snprintf(buf, sizeof(buf), "Floors: %.1f to %.1f dBm", (double)min_f, (double)max_f);
        canvas_draw_str(c, 0, 24, buf);
        snprintf(buf, sizeof(buf), "Max StdDev: %.2fdB (OK)", (double)max_std);
        canvas_draw_str(c, 0, 36, buf);
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
        float worst_floor_margin = 0.0f; // how far the floor sits over ITS OWN band ceiling

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
            snprintf(buf, sizeof(buf), "Unshielded (>%.0fdBm)", (double)em_scan_cal_max_floor_dbm[worst_floor_idx]);
            canvas_draw_str(c, 0, 24, buf);
            snprintf(buf, sizeof(buf), "Worst: %sMHz %.1fdBm",
                     em_scan_freq_label[worst_floor_idx], (double)computed_floors[worst_floor_idx]);
            canvas_draw_str(c, 0, 36, buf);
            canvas_draw_str(c, 0, 48, "Place Flipper in Faraday bag!");
        } else {
            canvas_draw_str(c, 0, 24, "High Noise Variance (>3.5dB)");
            snprintf(buf, sizeof(buf), "Worst: %sMHz %.2fdB",
                     em_scan_freq_label[worst_std_idx], (double)worst_std);
            canvas_draw_str(c, 0, 36, buf);
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
        canvas_draw_str(c, 0, 24, "Band Floors (dBm):");
        char buf[48];
        int y = 36;
        for(int i = 0; i < EM_SCAN_NUM_FREQS; i++) {
            snprintf(buf, sizeof(buf), "%s: %.1f  (std %.2f)",
                     em_scan_freq_label[i], (double)cal.noise_floor_dbm[i], (double)cal.noise_std_dev_db[i]);
            canvas_draw_str(c, 0, y, buf);
            y += 10;
        }
    }
    canvas_draw_str(c, 0, 60, "[Press OK or Back to return]");
}
