// Bio Mapping — GUI: menus, recording view, conversion status.
#include "biomap.h"

// ==========================================================================
// Recording view — live display during data logging
// ==========================================================================
//
//  GPS+GSR mode:                          GPS-only mode:
//  ┌───────────────────────┐        ┌───────────────────────┐
//  │ Bio Mapping            │        │ Bio Mapping        [■]│
//  │ ┌───────────────────┐ │        │ biomap_001.csv        │
//  │ │      ~~~          │ │        │ 13:42:59 UTC          │
//  │ │  ~~/   \──        │ │        │ 2026-06-16            │
//  │ │ /         \──     │ │        │ 51.55636              │
//  │ │/              \──  │ │        │ -0.07136              │
//  │ └───────────────────┘ │        │ Sats:6  Q:1           │
//  └───────────────────────┘        └───────────────────────┘
//
//  GSR-only mode:
//  ┌───────────────────────┐
//  │ Bio Mapping            │
//  │ GSR: 4523              │
//  │ ┌───────────────────┐ │
//  │ │      ~~~          │ │
//  │ │  ~~/   \──        │ │
//  │ │ /         \──     │ │
//  │ │/              \──  │ │
//  │ └───────────────────┘ │
//  └───────────────────────┘
//
//  Graph: full width (0,16,128,48). Text only on non-graph screen areas.

static void draw_graph(Canvas* c, BioMapApp* a, int gx, int gy, int gw, int gh) {
    int n  = gw - 2;
    int cy = gy + gh / 2;
    const float sc = (float)(gh / 2 - 2) / 100.0f;

    canvas_draw_frame(c, gx, gy, gw, gh);
    canvas_draw_line(c, gx, cy, gx + gw - 1, cy);

    // Time notches at the top — every 2 seconds, counting from the right
    float sec_per_px = (float)a->scroll_divider / TICK_HZ;
    int right_edge = gx + gw - 2;
    for(float t = 2.0f; t < n * sec_per_px; t += 2.0f) {
        int x = right_edge - (int)(t / sec_per_px);
        if(x >= gx + 1 && x < right_edge) {
            canvas_draw_line(c, x, gy + 1, x, gy + 4);
        }
    }

    for(int i = 0; i < n - 1; i++) {
        int si = (a->graph_head + i)     % GRAPH_N;
        int sj = (a->graph_head + i + 1) % GRAPH_N;
        float v0 = a->graph_buf[si] * a->zoom_level;
        float v1 = a->graph_buf[sj] * a->zoom_level;

        int y0 = cy - (int)(v0 * sc);
        int y1 = cy - (int)(v1 * sc);
        if(y0 < gy + 1) y0 = gy + 1;
        if(y0 > gy + gh - 2) y0 = gy + gh - 2;
        if(y1 < gy + 1) y1 = gy + 1;
        if(y1 > gy + gh - 2) y1 = gy + gh - 2;

        canvas_draw_line(c, gx + 1 + i, y0, gx + 1 + i + 1, y1);
    }
}

void biomap_render_callback(Canvas* c, void* ctx) {
    BioMapApp* a = (BioMapApp*)ctx;
    furi_mutex_acquire(a->mutex, FuriWaitForever);
    canvas_clear(c);

    bool has_graph = has_gsr(a->mode);

    // Full-width graph (behind text, when GSR active)
    if(has_graph) {
        draw_graph(c, a, 0, 16, 128, 48);

        // Zoom level in bottom-right corner of the graph
        char zoom_buf[16];
        snprintf(zoom_buf, sizeof(zoom_buf), "%.1fx", (double)a->zoom_level);
        canvas_set_font(c, FontSecondary);
        int zw = canvas_string_width(c, zoom_buf);
        canvas_draw_str(c, 128 - zw - 2, 62, zoom_buf);
    }

    // Title + recording indicator
    canvas_set_font(c, FontPrimary);
    canvas_draw_str(c, 0, 10, "Bio Mapping");
    canvas_set_font(c, FontSecondary);

    if(a->recording_active) {
        canvas_draw_box(c, 118, 1, 8, 8);
    }

    if(has_graph) {
        // GPS+GSR or GSR-only: minimal overlay — just GSR number on GSR-only
        if(a->mode == BioMapModeGsrOnly && a->gsr && gsr_sensor_available(a->gsr)) {
            char buf[32];
            snprintf(buf, sizeof(buf), "GSR: %d", (int)gsr_sensor_get_raw(a->gsr));
            int x = 128 - canvas_string_width(c, buf) - (a->recording_active ? 12 : 2);
            canvas_draw_str(c, x, 10, buf);
        }
    } else {
        // GPS-only: full detail view
        GpsStatus g = gps_uart_get_status(a->gps);
        int y = 20;

        if(a->recording_active) {
            const char* fn = a->recording_filename;
            canvas_draw_str(c, 0, y, (strlen(fn) > 7) ? fn + 7 : fn);
            y += 10;
        }

        if(gps_uart_is_ready(a->gps) && g.date.year) {
            char buf[48];
            int yr = g.date.year + (g.date.year < 80 ? 2000 : 1900);
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
    }

    furi_mutex_release(a->mutex);
}

// ==========================================================================
// Input & timer callbacks — forward events to the app's message queue
// ==========================================================================

void biomap_input_callback(InputEvent* e, void* ctx) {
    PluginEvent ev = {.type = EventTypeKey, .input = *e};
    furi_message_queue_put((FuriMessageQueue*)ctx, &ev, FuriWaitForever);
}

void biomap_timer_callback(void* ctx) {
    PluginEvent ev = {.type = EventTypeTick};
    furi_message_queue_put((FuriMessageQueue*)ctx, &ev, 0);
}

// ==========================================================================
// Conversion status — shown after "Convert CSV to GPX" runs
// ==========================================================================
//
//  ┌─────────────────────────────┐
//  │  Converting...              │   ← shown during conversion
//  │  biomap_003.csv             │
//  └─────────────────────────────┘
//
//  ┌─────────────────────────────┐
//  │  Conversion OK              │   ← shown after conversion
//  │  CSV : biomap_003.csv       │
//  │  GPX : biomap_003.gpx       │
//  │  Points : 29                │
//  │  Press Back                 │
//  └─────────────────────────────┘

static bool  conv_ok;
static char  conv_name[32];
static int   conv_points;

// Simple "Converting..." screen with a spinner that advances each time
// the converter yields (every 64 rows).  The static counter makes the
// spinner cycle through frames even though the main thread is blocked.
static void conv_progress_render(Canvas* c, void* ctx) {
    UNUSED(ctx);
    static int frame = 0;
    static const char spinner[] = {'|', '/', '-', '\\'};

    canvas_clear(c);
    canvas_set_font(c, FontPrimary);
    canvas_draw_str(c, 0, 10, "Converting...");
    canvas_set_font(c, FontSecondary);
    canvas_draw_str(c, 0, 26, conv_name);

    char buf[32];
    snprintf(buf, sizeof(buf), "%c Please wait", spinner[frame & 3]);
    canvas_draw_str(c, 0, 40, buf);

    frame++;
}

static void conv_status_render(Canvas* c, void* ctx) {
    UNUSED(ctx);
    canvas_clear(c);
    canvas_set_font(c, FontPrimary);
    canvas_draw_str(c, 0, 10, conv_ok ? "Conversion OK" : "Conversion FAILED");
    canvas_set_font(c, FontSecondary);
    char buf[64], gpx[32];
    snprintf(buf, sizeof(buf), "CSV : %s", conv_name);
    canvas_draw_str(c, 0, 24, buf);
    strncpy(gpx, conv_name, sizeof(gpx) - 1);
    gpx[sizeof(gpx) - 1] = '\0';
    size_t len = strlen(gpx);
    if(len > 4 && strcmp(gpx + len - 4, ".csv") == 0)
        { gpx[len-3]='g'; gpx[len-2]='p'; gpx[len-1]='x'; }
    snprintf(buf, sizeof(buf), "GPX : %s", gpx);
    canvas_draw_str(c, 0, 34, buf);
    snprintf(buf, sizeof(buf), "Points : %d", conv_points);
    canvas_draw_str(c, 0, 46, buf);
    canvas_draw_str(c, 0, 58, (!conv_ok && conv_points == 0) ? "No GPS fix rows found" : "Press Back");
}

static void show_status_screen(BioMapApp* app) {
    ViewPort* vp = view_port_alloc();
    view_port_draw_callback_set(vp, conv_status_render, NULL);
    view_port_input_callback_set(vp, biomap_input_callback, app->event_queue);

    // Menu VP is already in the stack (disabled) — no flash when we add on top
    gui_add_view_port(app->gui, vp, GuiLayerFullscreen);
    view_port_update(vp);

    PluginEvent ev;
    while(furi_message_queue_get(app->event_queue, &ev, 0) == FuriStatusOk); // drain stale
    while(furi_message_queue_get(app->event_queue, &ev, FuriWaitForever) == FuriStatusOk) {
        if(ev.type == EventTypeKey && ev.input.type == InputTypeShort
            && ev.input.key == InputKeyBack) break;
    }

    // Remove status VP — menu VP is still underneath, no flash
    gui_remove_view_port(app->gui, vp);
    view_port_free(vp);
}

// ==========================================================================
// Launch menu — main navigation
// ==========================================================================
//
//  ┌─────────────────────────────┐
//  │  Bio Mapping                │
//  │  ▓ GPS + GSR           ▓   │   ← selected item (inverse bar)
//  │    GPS Only                 │
//  │    GSR Only                 │
//  │    Convert CSV to GPX       │
//  │    Reset GPS                │
//  │                             │
//  └─────────────────────────────┘
//
//  Controls:  Up/Down → navigate     OK → select     Back → exit app

#define MENU_COUNT 5
static const char* menu_labels[MENU_COUNT] = {
    "GPS + GSR", "GPS Only", "GSR Only", "Convert CSV to GPX", "Reset GPS",
};

void menu_render(Canvas* c, void* ctx) {
    BioMapApp* a = (BioMapApp*)ctx;
    furi_mutex_acquire(a->mutex, FuriWaitForever);
    canvas_clear(c);
    canvas_set_font(c, FontPrimary);
    canvas_draw_str(c, 0, 10, "Bio Mapping");
    canvas_set_font(c, FontSecondary);
    int sel = (int)a->menu_selection;
    for(int i = 0; i < MENU_COUNT; i++) {
        int y = 22 + i * 10;
        if(i == sel) {
            canvas_draw_box(c, 0, y - 8, 128, 9);
            canvas_invert_color(c);
            canvas_draw_str(c, 0, y, ">");
            canvas_draw_str(c, 8, y, menu_labels[i]);
            canvas_invert_color(c);
        } else {
            canvas_draw_str(c, 8, y, menu_labels[i]);
        }
    }
    furi_mutex_release(a->mutex);
}

int32_t biomap_gui_show_menu(BioMapApp* app) {
    app->menu_selection = 0;

    // Enable menu VP so it receives input and renders
    view_port_enabled_set(app->menu_vp, true);
    view_port_update(app->menu_vp);

    PluginEvent ev;
    int32_t result = -1;
    bool running = true;
    while(running) {
        if(furi_message_queue_get(app->event_queue, &ev, FuriWaitForever) != FuriStatusOk)
            continue;
        if(ev.type != EventTypeKey || ev.input.type != InputTypeShort) continue;

        switch(ev.input.key) {
        case InputKeyUp:
            furi_mutex_acquire(app->mutex, FuriWaitForever);
            if(app->menu_selection > 0) app->menu_selection--;
            furi_mutex_release(app->mutex);
            view_port_update(app->menu_vp);
            break;
        case InputKeyDown:
            furi_mutex_acquire(app->mutex, FuriWaitForever);
            if(app->menu_selection < MENU_COUNT - 1) app->menu_selection++;
            furi_mutex_release(app->mutex);
            view_port_update(app->menu_vp);
            break;
        case InputKeyOk:
            result = (int32_t)app->menu_selection;
            running = false;
            break;
        case InputKeyBack:
            result = -1;
            running = false;
            break;
        default: break;
        }
    }

    // Disable menu VP so it stops receiving input while sub-screen runs.
    // The VP stays in the GUI stack (no flash of desktop) but passes
    // input through to any VP layered on top.
    view_port_enabled_set(app->menu_vp, false);
    return result;
}

// ==========================================================================
// Converter flow — scan CSVs, convert latest, show result
// ==========================================================================

void run_converter(BioMapApp* app) {
    GpxConverter* c = gpx_converter_alloc(app->storage);
    int n = gpx_converter_scan(c);

    if(n == 0) {
        conv_ok = false;
        conv_points = 0;
        strncpy(conv_name, "(none)", sizeof(conv_name) - 1);
        notification_message(app->notifications, &sequence_blink_red_100);
        show_status_screen(app);
        gpx_converter_free(c);
        return;
    }

    const char* name = gpx_converter_get_name(c, n - 1);
    strncpy(conv_name, name, sizeof(conv_name) - 1);

    // Show "Converting..." while the two-pass conversion runs.
    // This prevents a blank screen during what could be seconds of I/O.
    ViewPort* prog_vp = view_port_alloc();
    view_port_draw_callback_set(prog_vp, conv_progress_render, NULL);
    gui_add_view_port(app->gui, prog_vp, GuiLayerFullscreen);
    view_port_update(prog_vp);

    FURI_LOG_I("BioMap", "Converting %s", name);
    conv_points = gpx_converter_run(c, name, prog_vp);
    conv_ok = (conv_points > 0);
    notification_message(app->notifications,
        conv_ok ? &sequence_blink_green_100 : &sequence_blink_red_100);

    // Remove progress VP, show result
    gui_remove_view_port(app->gui, prog_vp);
    view_port_free(prog_vp);

    show_status_screen(app);
    gpx_converter_free(c);
}

