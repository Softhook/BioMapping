// Bio Mapping — GSR + GPS data logger for Flipper Zero.
// Launch menu: GPS+GSR | GPS Only | GSR Only | Convert CSV→GPX | Hot Start GPS

#include <furi.h>
#include <furi_hal.h>
#include <furi_hal_power.h>
#include <furi_hal_rtc.h>
#include <gui/gui.h>
#include <gui/view_port.h>
#include <notification/notification_messages.h>
#include <storage/storage.h>
#include <string.h>
#include <stdio.h>
#include <math.h>

#include "biomap_config.h"
#include "biomap_events.h"
#include "modules/gps_uart.h"
#include "modules/gsr_sensor.h"
#include "modules/sd_logger.h"
#include "modules/gpx_converter.h"

#define TICK_HZ          10
#define ZOOM_STEP        0.25f
#define ZOOM_MIN         0.25f
#define ZOOM_MAX         4.0f
#define DISPLAY_EMA_A    0.2f

// Graph layout per mode
#define GX_GPSGSR  65
#define GY_GPSGSR  20
#define GW_GPSGSR  61
#define GH_GPSGSR  40
#define GX_GSR     2
#define GY_GSR     20
#define GW_GSR     124
#define GH_GSR     40
#define GRAPH_N    (GW_GSR - 2)

typedef struct {
    BioMapMode         mode;
    GpsUart*           gps;
    GsrSensor*         gsr;
    SdLogger*          logger;
    FuriMessageQueue*  event_queue;
    FuriMutex*         mutex;
    Storage*            storage;
    NotificationApp*   notifications;

    int32_t  gsr_raw_sum;
    int      raw_count;
    int      tick_counter;

    float    display_smoothed;
    bool     display_primed;
    float    graph_buf[GRAPH_N];
    int      graph_head;

    float    zoom_level;
    bool     running;
    bool     recording_active;
    char     recording_filename[64];
    bool     otg_was_enabled;
    volatile int32_t menu_selection;
} BioMapApp;

static inline bool has_gps(BioMapMode m) { return m == BioMapModeGpsGsr || m == BioMapModeGpsOnly; }
static inline bool has_gsr(BioMapMode m) { return m == BioMapModeGpsGsr || m == BioMapModeGsrOnly; }

static void format_timestamp(BioMapApp* app, char* buf, size_t sz) {
    if(app->gps) {
        GpsStatus g = gps_uart_get_status(app->gps);
        if(g.date.year) {
            int y = g.date.year + (g.date.year < 80 ? 2000 : 1900);
            snprintf(buf, sz, "%04d-%02d-%02dT%02d:%02d:%02dZ",
                y, g.date.month, g.date.day,
                g.time.hours, g.time.minutes, g.time.seconds);
            return;
        }
    }
    DateTime dt;
    furi_hal_rtc_get_datetime(&dt);
    snprintf(buf, sz, "%04d-%02d-%02dT%02d:%02d:%02dZ",
        (int)dt.year, (int)dt.month, (int)dt.day,
        (int)dt.hour, (int)dt.minute, (int)dt.second);
}

// Draw scrolling waveform graph
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

static void render_callback(Canvas* c, void* ctx) {
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

static void input_callback(InputEvent* e, void* ctx) {
    PluginEvent ev = {.type = EventTypeKey, .input = *e};
    furi_message_queue_put((FuriMessageQueue*)ctx, &ev, FuriWaitForever);
}

static void timer_callback(void* ctx) {
    PluginEvent ev = {.type = EventTypeTick};
    furi_message_queue_put((FuriMessageQueue*)ctx, &ev, 0);
}

// Conversion result state for on-screen display
static bool  conv_result_ok;
static char  conv_result_name[32];
static int   conv_result_points;

static void conv_status_render(Canvas* c, void* ctx) {
    UNUSED(ctx);
    canvas_clear(c);
    canvas_set_font(c, FontPrimary);
    canvas_draw_str(c, 0, 10, conv_result_ok ? "Conversion OK" : "Conversion FAILED");
    canvas_set_font(c, FontSecondary);
    char buf[64];
    // Show GPX output name (swap .csv → .gpx)
    char gpx_name[32];
    strncpy(gpx_name, conv_result_name, sizeof(gpx_name) - 1);
    size_t len = strlen(gpx_name);
    if(len > 4 && strcmp(gpx_name + len - 4, ".csv") == 0) {
        gpx_name[len - 3] = 'g'; gpx_name[len - 2] = 'p'; gpx_name[len - 1] = 'x';
    }
    snprintf(buf, sizeof(buf), "Source: %s", conv_result_name);
    canvas_draw_str(c, 0, 24, buf);
    snprintf(buf, sizeof(buf), "Output: %s", gpx_name);
    canvas_draw_str(c, 0, 34, buf);
    snprintf(buf, sizeof(buf), "Points: %d", conv_result_points);
    canvas_draw_str(c, 0, 44, buf);
    canvas_draw_str(c, 0, 58, "Press Back");
}

static void show_status_screen(BioMapApp* app) {
    ViewPort* vp = view_port_alloc();
    view_port_draw_callback_set(vp, conv_status_render, NULL);
    view_port_input_callback_set(vp, input_callback, app->event_queue);
    Gui* gui = furi_record_open(RECORD_GUI);
    gui_add_view_port(gui, vp, GuiLayerFullscreen);

    PluginEvent ev;
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
    strncpy(conv_result_name, name, sizeof(conv_result_name) - 1);

    int points = gpx_converter_run(c, name);
    conv_result_ok = (points > 0);
    conv_result_points = points;

    notification_message(app->notifications,
        conv_result_ok ? &sequence_blink_green_100 : &sequence_blink_red_100);
    show_status_screen(app);
}

// ---------------------------------------------------------------------------
// Canvas-based menu — avoids ViewDispatcher input issues
// ---------------------------------------------------------------------------
#define MENU_ITEMS 5
static const char* menu_labels[MENU_ITEMS] = {
    "GPS + GSR",
    "GPS Only",
    "GSR Only",
    "Convert CSV to GPX",
    "Hot Start GPS",
};

static void menu_render(Canvas* c, void* ctx) {
    BioMapApp* a = (BioMapApp*)ctx;
    furi_mutex_acquire(a->mutex, FuriWaitForever);
    canvas_clear(c);
    canvas_set_font(c, FontPrimary);
    canvas_draw_str(c, 0, 10, "Bio Mapping");
    canvas_set_font(c, FontSecondary);
    int sel = (int)a->menu_selection;
    for(int i = 0; i < MENU_ITEMS; i++) {
        int y = 22 + i * 10;
        if(i == sel) {
            canvas_draw_box(c, 0, y - 7, 128, 10);   // black selection bar
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

static void menu_input(InputEvent* e, void* ctx) {
    PluginEvent ev = {.type = EventTypeKey, .input = *e};
    furi_message_queue_put((FuriMessageQueue*)ctx, &ev, FuriWaitForever);
}

static int32_t show_menu(BioMapApp* app) {
    app->menu_selection = 0;

    ViewPort* vp = view_port_alloc();
    view_port_draw_callback_set(vp, menu_render, app);
    view_port_input_callback_set(vp, menu_input, app->event_queue);
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
            if(app->menu_selection < MENU_ITEMS - 1) app->menu_selection++;
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

static void run_converter(BioMapApp* app) {
    GpxConverter* c = gpx_converter_alloc(app->storage);
    int n = gpx_converter_scan(c);

    if(n == 0) {
        conv_result_ok = false;
        conv_result_points = 0;
        strncpy(conv_result_name, "(none)", sizeof(conv_result_name) - 1);
        notification_message(app->notifications, &sequence_blink_red_100);
        show_status_screen(app);
        gpx_converter_free(c);
        return;
    }

    do_convert(c, gpx_converter_get_name(c, 0), app);
    gpx_converter_free(c);
}

static void run_gps_hot_start(BioMapApp* app) {
    GpsUart* g = gps_uart_alloc(app->event_queue, app->notifications);
    bool ok = g && gps_uart_is_ready(g);
    if(ok) { gps_uart_send_hot_start(g); furi_delay_ms(300); }
    notification_message(app->notifications,
        ok ? &sequence_blink_green_100 : &sequence_blink_red_100);
    if(g) gps_uart_free(g);
}

static void run_recording_session(BioMapApp* app, BioMapMode mode) {
    app->mode = mode;
    app->gsr_raw_sum = app->raw_count = app->tick_counter = app->graph_head = 0;
    app->display_smoothed = 0.0f;
    app->display_primed   = false;
    app->recording_active = false;
    app->recording_filename[0] = '\0';
    app->running = true;
    memset(app->graph_buf, 0, sizeof(app->graph_buf));

    // OTG power for GPS
    app->otg_was_enabled = furi_hal_power_is_otg_enabled();
    if(has_gps(mode)) {
        for(int i = 5; i > 0 && !furi_hal_power_enable_otg(); i--);
    }

    app->gps = has_gps(mode) ? gps_uart_alloc(app->event_queue, app->notifications) : NULL;
    app->gsr = has_gsr(mode) ? gsr_sensor_alloc() : NULL;
    app->logger = sd_logger_alloc(app->storage);

    ViewPort* vp = view_port_alloc();
    view_port_draw_callback_set(vp, render_callback, app);
    view_port_input_callback_set(vp, input_callback, app->event_queue);
    Gui* gui = furi_record_open(RECORD_GUI);
    gui_add_view_port(gui, vp, GuiLayerFullscreen);

    FuriTimer* timer = furi_timer_alloc(timer_callback, FuriTimerTypePeriodic, app->event_queue);
    furi_timer_start(timer, furi_kernel_get_tick_frequency() / TICK_HZ);

    PluginEvent ev;
    while(app->running) {
        if(furi_message_queue_get(app->event_queue, &ev, FuriWaitForever) != FuriStatusOk)
            continue;

        if(ev.type == EventTypeUart && app->gps) {
            furi_mutex_acquire(app->mutex, FuriWaitForever);
            gps_uart_process_rx(app->gps);
            furi_mutex_release(app->mutex);
            view_port_update(vp);
            continue;
        }

        if(ev.type == EventTypeKey && ev.input.type == InputTypeShort) {
            switch(ev.input.key) {
            case InputKeyBack:
                app->running = false;
                break;
            case InputKeyOk: {
                bool start;
                furi_mutex_acquire(app->mutex, FuriWaitForever);
                start = !app->recording_active;
                furi_mutex_release(app->mutex);

                if(start) {
                    if(sd_logger_start(app->logger)) {
                        furi_mutex_acquire(app->mutex, FuriWaitForever);
                        app->recording_active = true;
                        strncpy(app->recording_filename,
                            sd_logger_get_filename(app->logger),
                            sizeof(app->recording_filename) - 1);
                        app->tick_counter = app->raw_count = app->gsr_raw_sum = 0;
                        furi_mutex_release(app->mutex);
                        notification_message(app->notifications, &sequence_blink_blue_10);
                    }
                } else {
                    sd_logger_stop(app->logger);
                    furi_mutex_acquire(app->mutex, FuriWaitForever);
                    app->recording_active = false;
                    app->recording_filename[0] = '\0';
                    furi_mutex_release(app->mutex);
                    notification_message(app->notifications, &sequence_blink_blue_100);
                }
                view_port_update(vp);
                break;
            }
            case InputKeyUp:
                if(has_gsr(mode)) {
                    furi_mutex_acquire(app->mutex, FuriWaitForever);
                    app->zoom_level = fminf(app->zoom_level + ZOOM_STEP, ZOOM_MAX);
                    furi_mutex_release(app->mutex);
                    view_port_update(vp);
                }
                break;
            case InputKeyDown:
                if(has_gsr(mode)) {
                    furi_mutex_acquire(app->mutex, FuriWaitForever);
                    app->zoom_level = fmaxf(app->zoom_level - ZOOM_STEP, ZOOM_MIN);
                    furi_mutex_release(app->mutex);
                    view_port_update(vp);
                }
                break;
            default: break;
            }
            continue;
        }

        if(ev.type == EventTypeTick) {
            furi_mutex_acquire(app->mutex, FuriWaitForever);

            int16_t raw = 0;
            if(app->gsr) {
                gsr_sensor_tick(app->gsr);
                raw = gsr_sensor_get_raw(app->gsr);

                float rf = (float)raw;
                if(!app->display_primed) { app->display_smoothed = rf; app->display_primed = true; }
                float ns = DISPLAY_EMA_A * rf + (1.0f - DISPLAY_EMA_A) * app->display_smoothed;
                float rate = ns - app->display_smoothed;
                app->display_smoothed = ns;
                app->graph_buf[app->graph_head] = -(rate) * 0.5f;
                app->graph_head = (app->graph_head + 1) % GRAPH_N;
                app->gsr_raw_sum += raw;
                app->raw_count++;
            }

            if(++app->tick_counter >= TICK_HZ) {
                float lat = 0, lon = 0, alt = 0;
                int   sats = 0, fix = 0;
                if(app->gps) {
                    GpsStatus gs = gps_uart_get_status(app->gps);
                    if((gs.fix_valid || gs.fix_quality > 0)
                        && !isnan(gs.latitude) && !isnan(gs.longitude)) {
                        lat = gs.latitude; lon = gs.longitude; alt = gs.altitude;
                    }
                    sats = gs.satellites_tracked;
                    fix  = gs.fix_quality;
                }

                int16_t avg = app->raw_count ? (int16_t)(app->gsr_raw_sum / app->raw_count) : 0;
                char ts[32];
                format_timestamp(app, ts, sizeof(ts));

                if(app->recording_active)
                    sd_logger_write_row(app->logger, ts, lat, lon, alt, sats, fix, avg);

                app->tick_counter = app->raw_count = app->gsr_raw_sum = 0;
            }

            furi_mutex_release(app->mutex);
            view_port_update(vp);
        }
    }

    // Shutdown
    furi_timer_stop(timer);
    furi_timer_free(timer);
    if(app->recording_active) sd_logger_stop(app->logger);

    sd_logger_free(app->logger); app->logger = NULL;
    if(app->gsr) { gsr_sensor_free(app->gsr); app->gsr = NULL; }
    if(app->gps) { gps_uart_free(app->gps); app->gps = NULL; }

    if(has_gps(mode) && furi_hal_power_is_otg_enabled() && !app->otg_was_enabled)
        furi_hal_power_disable_otg();

    gui_remove_view_port(gui, vp);
    view_port_free(vp);
    furi_record_close(RECORD_GUI);
}

int32_t biomap_app(void* p) {
    UNUSED(p);
    BioMapApp* app = malloc(sizeof(BioMapApp));
    furi_assert(app);
    *app = (BioMapApp){.zoom_level = 1.0f};

    app->event_queue   = furi_message_queue_alloc(16, sizeof(PluginEvent));
    app->mutex         = furi_mutex_alloc(FuriMutexTypeNormal);
    app->notifications = furi_record_open(RECORD_NOTIFICATION);
    app->storage       = furi_record_open(RECORD_STORAGE);
    notification_message_block(app->notifications, &sequence_display_backlight_enforce_auto);

    bool running = true;
    while(running) {
        int32_t sel = show_menu(app);

        switch(sel) {
        case 0: run_recording_session(app, BioMapModeGpsGsr);  break;
        case 1: run_recording_session(app, BioMapModeGpsOnly); break;
        case 2: run_recording_session(app, BioMapModeGsrOnly); break;
        case 3: run_converter(app);                             break;
        case 4: run_gps_hot_start(app);                         break;
        default: running = false;                               break;
        }
    }

    notification_message_block(app->notifications, &sequence_display_backlight_enforce_auto);
    furi_record_close(RECORD_NOTIFICATION);
    furi_record_close(RECORD_STORAGE);
    furi_message_queue_free(app->event_queue);
    furi_mutex_free(app->mutex);
    free(app);
    return 0;
}