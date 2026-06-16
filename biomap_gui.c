// Bio Mapping — GUI: menus, recording view, conversion status.
#include "biomap.h"

// -- recording view --------------------------------------------------------

static void draw_graph(Canvas* c, BioMapApp* a, int gx, int gy, int gw, int gh) {
    int n  = gw - 2;
    int cy = gy + gh / 2;
    const float sc = (float)(gh / 2 - 2) / 100.0f;

    canvas_draw_frame(c, gx, gy, gw, gh);
    canvas_draw_line(c, gx, cy, gx + gw - 1, cy);

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
    char buf[48];

    canvas_set_font(c, FontPrimary);
    canvas_draw_str(c, 0, 10, "Bio Mapping");
    canvas_set_font(c, FontSecondary);

    if(a->recording_active) {
        canvas_draw_box(c, 118, 1, 8, 8);
        const char* fn = a->recording_filename;
        canvas_draw_str(c, 0, 20, (strlen(fn) > 7) ? fn + 7 : fn);
    }

    if(has_gps(a->mode)) {
        GpsStatus g = gps_uart_get_status(a->gps);
        if(!gps_uart_is_ready(a->gps)) {
            canvas_draw_str(c, 0, 30, "GPS: UART locked");
        } else if(g.fix_valid || g.fix_quality > 0) {
            snprintf(buf, sizeof(buf), "%.5f", (double)g.latitude);
            canvas_draw_str(c, 0, 30, buf);
            snprintf(buf, sizeof(buf), "%.5f", (double)g.longitude);
            canvas_draw_str(c, 0, 40, buf);
        } else {
            canvas_draw_str(c, 0, 30, "Waiting for fix...");
        }
        snprintf(buf, sizeof(buf), "Sats:%d Q:%d", g.satellites_tracked, g.fix_quality);
        canvas_draw_str(c, 0, 50, buf);
    }

    if(has_gsr(a->mode)) {
        snprintf(buf, sizeof(buf), "Z:%.2f", (double)a->zoom_level);
        canvas_draw_str(c, 0, 63, buf);
        if(a->gsr && gsr_sensor_available(a->gsr)) {
            snprintf(buf, sizeof(buf), "GSR:%d", (int)gsr_sensor_get_raw(a->gsr));
        } else {
            snprintf(buf, sizeof(buf), "GSR:off");
        }
        canvas_draw_str(c, 35, 63, buf);

        bool full = (a->mode == BioMapModeGsrOnly);
        draw_graph(c, a,
            full ? GX_GSR : GX_GPSGSR, full ? GY_GSR : GY_GPSGSR,
            full ? GW_GSR : GW_GPSGSR, full ? GH_GSR : GH_GPSGSR);
    }

    furi_mutex_release(a->mutex);
}

// -- callbacks -------------------------------------------------------------

void biomap_input_callback(InputEvent* e, void* ctx) {
    PluginEvent ev = {.type = EventTypeKey, .input = *e};
    furi_message_queue_put((FuriMessageQueue*)ctx, &ev, FuriWaitForever);
}

void biomap_timer_callback(void* ctx) {
    PluginEvent ev = {.type = EventTypeTick};
    furi_message_queue_put((FuriMessageQueue*)ctx, &ev, 0);
}

// -- conversion status screen ----------------------------------------------

static bool  conv_ok;
static char  conv_name[32];
static int   conv_points;

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
    Gui* gui = furi_record_open(RECORD_GUI);
    gui_add_view_port(gui, vp, GuiLayerFullscreen);
    view_port_update(vp);

    // Drain stale events, then wait for Back
    PluginEvent ev;
    while(furi_message_queue_get(app->event_queue, &ev, 0) == FuriStatusOk);
    while(furi_message_queue_get(app->event_queue, &ev, FuriWaitForever) == FuriStatusOk) {
        if(ev.type == EventTypeKey && ev.input.type == InputTypeShort
            && ev.input.key == InputKeyBack) break;
    }

    gui_remove_view_port(gui, vp);
    view_port_free(vp);
    furi_record_close(RECORD_GUI);
}

static void do_convert(GpxConverter* c, const char* name, BioMapApp* app) {
    FURI_LOG_I("BioMap", "Converting %s", name);
    strncpy(conv_name, name, sizeof(conv_name) - 1);
    conv_points = gpx_converter_run(c, name);
    conv_ok = (conv_points > 0);
    notification_message(app->notifications,
        conv_ok ? &sequence_blink_green_100 : &sequence_blink_red_100);
    show_status_screen(app);
}

// -- main menu -------------------------------------------------------------

#define MENU_COUNT 5
static const char* menu_labels[MENU_COUNT] = {
    "GPS + GSR", "GPS Only", "GSR Only", "Convert CSV to GPX", "Reset GPS",
};

static void menu_render(Canvas* c, void* ctx) {
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
    ViewPort* vp = view_port_alloc();
    view_port_draw_callback_set(vp, menu_render, app);
    view_port_input_callback_set(vp, biomap_input_callback, app->event_queue);
    Gui* gui = furi_record_open(RECORD_GUI);
    gui_add_view_port(gui, vp, GuiLayerFullscreen);

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
            view_port_update(vp);
            break;
        case InputKeyDown:
            furi_mutex_acquire(app->mutex, FuriWaitForever);
            if(app->menu_selection < MENU_COUNT - 1) app->menu_selection++;
            furi_mutex_release(app->mutex);
            view_port_update(vp);
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

    gui_remove_view_port(gui, vp);
    view_port_free(vp);
    furi_record_close(RECORD_GUI);
    return result;
}

// -- converter flow --------------------------------------------------------

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

    // Convert the latest file found
    do_convert(c, gpx_converter_get_name(c, n - 1), app);
    gpx_converter_free(c);
}
