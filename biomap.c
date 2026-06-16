// BioMapping 3.0 — Main Application
// Christian Nold / 2026
//
// Records GSR (galvanic skin response) and/or GPS coordinates to a CSV file.
// GPS and GSR are independently toggleable via a launch menu.
// Post-processing converts CSV to GPX with GSR elevation.
//
// Architecture:
//   gps_uart      — UART NMEA parser (optional, based on mode)
//   gsr_sensor    — ADS1115 I2C reader (optional, based on mode)
//   sd_logger     — Auto-incremented CSV file writer
//   gpx_converter — Post-processing CSV→GPX converter
//
// Controls (recording view):
//   OK    — Toggle recording on/off
//   Up    — Zoom in  (increase GSR display sensitivity)
//   Down  — Zoom out (decrease GSR display sensitivity)
//   Back  — Return to launch menu (closes CSV file, releases hardware)

#include <furi.h>
#include <furi_hal.h>
#include <furi_hal_power.h>
#include <furi_hal_rtc.h>
#include <gui/gui.h>
#include <gui/view_port.h>
#include <gui/view_dispatcher.h>
#include <gui/modules/submenu.h>
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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
#define APP_TICK_HZ         10      // timer fires 10× per second
#define APP_TICKS_PER_SEC   10      // ticks to accumulate before CSV write
#define ZOOM_STEP           0.25f
#define ZOOM_MIN            0.25f
#define ZOOM_MAX            4.0f

// Display-only EMA for the waveform graph (not logged)
#define DISPLAY_EMA_ALPHA   0.2f

// Waveform graph dimensions — adapt based on mode
// GPS+GSR mode: graph in bottom-right
#define GRAPH_GPSGSR_X      65
#define GRAPH_GPSGSR_Y      20
#define GRAPH_GPSGSR_W      61
#define GRAPH_GPSGSR_H      40
// GSR-only mode: graph uses full width
#define GRAPH_GSRONLY_X     2
#define GRAPH_GSRONLY_Y     20
#define GRAPH_GSRONLY_W     124
#define GRAPH_GSRONLY_H     40

// Use the larger buffer to accommodate both layouts
#define GRAPH_MAX_SAMPLES   (GRAPH_GSRONLY_W - 2)

// ---------------------------------------------------------------------------
// Launch menu item IDs
// ---------------------------------------------------------------------------
typedef enum {
    MenuIdGpsGsr = 0,
    MenuIdGpsOnly,
    MenuIdGsrOnly,
    MenuIdConvert,
    MenuIdHotStart,
} MenuId;

// ---------------------------------------------------------------------------
// Application state
// ---------------------------------------------------------------------------
typedef struct {
    // Runtime mode
    BioMapMode mode;

    // Modules (NULL when not active for selected mode)
    GpsUart*       gps;
    GsrSensor*     gsr;
    SdLogger*      logger;
    GpxConverter*  converter;

    // FURI primitives
    FuriMessageQueue* event_queue;
    FuriMutex*        mutex;
    Storage*          storage;
    NotificationApp*  notifications;

    // GSR 1-second accumulator (raw values)
    int32_t gsr_raw_sum;   // sum of raw int16 readings
    int     raw_count;     // number of ticks accumulated
    int     tick_counter;  // counts up to APP_TICKS_PER_SEC

    // Display-only waveform (lightweight EMA for visual feedback, not logged)
    float  display_smoothed;
    bool   display_primed;
    float  graph_buf[GRAPH_MAX_SAMPLES];
    int    graph_head;

    // User settings
    float  zoom_level;
    bool   running;

    // Caching for thread safety (accessed by GUI thread under mutex)
    bool   recording_active;
    char   recording_filename[64];

    // OTG state
    bool   otg_was_enabled;

    // Menu result
    volatile int32_t menu_selection;
} BioMapApp;

// ---------------------------------------------------------------------------
// Helper: does the current mode use GPS?
// ---------------------------------------------------------------------------
static inline bool mode_has_gps(BioMapMode mode) {
    return mode == BioMapModeGpsGsr || mode == BioMapModeGpsOnly;
}

// ---------------------------------------------------------------------------
// Helper: does the current mode use GSR?
// ---------------------------------------------------------------------------
static inline bool mode_has_gsr(BioMapMode mode) {
    return mode == BioMapModeGpsGsr || mode == BioMapModeGsrOnly;
}

// ---------------------------------------------------------------------------
// Helper: format timestamp from GPS or Flipper RTC
// ---------------------------------------------------------------------------
static void format_timestamp(BioMapApp* app, char* buf, size_t buf_size) {
    if(app->gps) {
        GpsStatus gps = gps_uart_get_status(app->gps);
        if(gps.date.year != 0) {
            int full_year = (gps.date.year < 80)
                ? 2000 + gps.date.year
                : 1900 + gps.date.year;
            snprintf(buf, buf_size, "%04d-%02d-%02dT%02d:%02d:%02dZ",
                full_year, gps.date.month, gps.date.day,
                gps.time.hours, gps.time.minutes, gps.time.seconds);
            return;
        }
    }

    // Fallback to Flipper RTC
    FuriHalRtcDateTime dt;
    furi_hal_rtc_get_datetime(&dt);
    snprintf(buf, buf_size, "%04d-%02d-%02dT%02d:%02d:%02dZ",
        (int)dt.year, (int)dt.month, (int)dt.day,
        (int)dt.hour, (int)dt.minute, (int)dt.second);
}

// ---------------------------------------------------------------------------
// UI rendering — recording view
// ---------------------------------------------------------------------------
static void render_callback(Canvas* canvas, void* ctx) {
    BioMapApp* app = (BioMapApp*)ctx;
    furi_mutex_acquire(app->mutex, FuriWaitForever);

    canvas_clear(canvas);

    // --- Title bar ---
    canvas_set_font(canvas, FontPrimary);
    if(app->mode == BioMapModeGsrOnly)
        canvas_draw_str(canvas, 0, 10, "BioMap GSR");
    else if(app->mode == BioMapModeGpsOnly)
        canvas_draw_str(canvas, 0, 10, "BioMap GPS");
    else
        canvas_draw_str(canvas, 0, 10, "BioMap 3.0");

    canvas_set_font(canvas, FontSecondary);

    // --- Recording indicator ---
    if(app->recording_active) {
        canvas_draw_box(canvas, 118, 1, 8, 8); // filled square = recording
        const char* fname = app->recording_filename;
        const char* short_name = (strlen(fname) > 7) ? fname + 7 : fname;
        canvas_draw_str(canvas, 0, 20, short_name);
    }

    char buf[48];

    // --- GPS status (when GPS is active) ---
    if(mode_has_gps(app->mode)) {
        GpsStatus gps = gps_uart_get_status(app->gps);

        if(!gps_uart_is_ready(app->gps)) {
            canvas_draw_str(canvas, 0, 30, "GPS: UART locked");
            canvas_draw_str(canvas, 0, 40, "Check system debug");
        } else if(gps.fix_valid || gps.fix_quality > 0) {
            snprintf(buf, sizeof(buf), "%.5f", (double)gps.latitude);
            canvas_draw_str(canvas, 0, 30, buf);
            snprintf(buf, sizeof(buf), "%.5f", (double)gps.longitude);
            canvas_draw_str(canvas, 0, 40, buf);
        } else {
            canvas_draw_str(canvas, 0, 30, "Waiting for fix...");
        }

        snprintf(buf, sizeof(buf), "Sats:%d Q:%d", gps.satellites_tracked, gps.fix_quality);
        canvas_draw_str(canvas, 0, 50, buf);
    }

    // --- Zoom level (when GSR is active) ---
    if(mode_has_gsr(app->mode)) {
        snprintf(buf, sizeof(buf), "Z:%.2f", (double)app->zoom_level);
        canvas_draw_str(canvas, 0, 63, buf);
    }

    // --- GSR raw value ---
    if(mode_has_gsr(app->mode) && app->gsr) {
        if(gsr_sensor_available(app->gsr)) {
            snprintf(buf, sizeof(buf), "GSR:%d", (int)gsr_sensor_get_raw(app->gsr));
            canvas_draw_str(canvas, 35, 63, buf);
        } else {
            canvas_draw_str(canvas, 35, 63, "GSR:off");
        }
    }

    // --- Waveform graph (when GSR is active) ---
    if(mode_has_gsr(app->mode)) {
        int gx, gy, gw, gh;
        if(app->mode == BioMapModeGsrOnly) {
            gx = GRAPH_GSRONLY_X; gy = GRAPH_GSRONLY_Y;
            gw = GRAPH_GSRONLY_W; gh = GRAPH_GSRONLY_H;
        } else {
            gx = GRAPH_GPSGSR_X; gy = GRAPH_GPSGSR_Y;
            gw = GRAPH_GPSGSR_W; gh = GRAPH_GPSGSR_H;
        }
        int graph_samples = gw - 2;
        int graph_centre_y = gy + gh / 2;

        // Draw border
        canvas_draw_frame(canvas, gx, gy, gw, gh);
        // Centre line
        canvas_draw_line(canvas, gx, graph_centre_y, gx + gw - 1, graph_centre_y);

        // Scale: map value to pixel offset.
        // Full-scale ±100 units → ±(gh/2 - 2) pixels
        const float scale = (float)(gh / 2 - 2) / 100.0f;

        for(int i = 0; i < graph_samples - 1; i++) {
            int src_i = (app->graph_head + i) % GRAPH_MAX_SAMPLES;
            int src_j = (app->graph_head + i + 1) % GRAPH_MAX_SAMPLES;

            float v0 = app->graph_buf[src_i] * app->zoom_level;
            float v1 = app->graph_buf[src_j] * app->zoom_level;

            int y0 = graph_centre_y - (int)(v0 * scale);
            int y1 = graph_centre_y - (int)(v1 * scale);
            int ymin = gy + 1;
            int ymax = gy + gh - 2;
            if(y0 < ymin) y0 = ymin;
            if(y0 > ymax) y0 = ymax;
            if(y1 < ymin) y1 = ymin;
            if(y1 > ymax) y1 = ymax;

            int x0 = gx + 1 + i;
            int x1 = gx + 1 + i + 1;
            canvas_draw_line(canvas, x0, y0, x1, y1);
        }
    }

    furi_mutex_release(app->mutex);
}

// ---------------------------------------------------------------------------
// Input callback — pushes button events into the queue
// ---------------------------------------------------------------------------
static void input_callback(InputEvent* event, void* ctx) {
    FuriMessageQueue* q = (FuriMessageQueue*)ctx;
    PluginEvent ev = {.type = EventTypeKey, .input = *event};
    furi_message_queue_put(q, &ev, FuriWaitForever);
}

// ---------------------------------------------------------------------------
// 10 Hz timer callback — posts tick events
// ---------------------------------------------------------------------------
static void timer_callback(void* ctx) {
    FuriMessageQueue* q = (FuriMessageQueue*)ctx;
    PluginEvent ev = {.type = EventTypeTick};
    furi_message_queue_put(q, &ev, 0);
}

// ---------------------------------------------------------------------------
// Launch menu callback
// ---------------------------------------------------------------------------
static void menu_callback(void* context, uint32_t index) {
    BioMapApp* app = (BioMapApp*)context;
    app->menu_selection = (int32_t)index;
}

// ---------------------------------------------------------------------------
// Converter submenu callback — writes selection into the pointed int32_t
// ---------------------------------------------------------------------------
static void converter_selection_callback(void* context, uint32_t index) {
    volatile int32_t* sel = (volatile int32_t*)context;
    *sel = (int32_t)index;
}

// ---------------------------------------------------------------------------
// Convert CSV→GPX flow (called from menu)
// ---------------------------------------------------------------------------
static void run_converter(BioMapApp* app) {
    GpxConverter* conv = gpx_converter_alloc(app->storage);
    int count = gpx_converter_scan(conv);

    if(count == 0) {
        FURI_LOG_I("BioMap", "No CSV files found for conversion");
        notification_message(app->notifications, &sequence_blink_red_100);
        gpx_converter_free(conv);
        return;
    }

    // If only one file, convert directly without showing a menu
    if(count == 1) {
        const char* csv_name = gpx_converter_get_name(conv, 0);
        FURI_LOG_I("BioMap", "Converting %s", csv_name);
        if(gpx_converter_run(conv, csv_name)) {
            FURI_LOG_I("BioMap", "Conversion complete");
            notification_message(app->notifications, &sequence_blink_green_100);
        } else {
            FURI_LOG_E("BioMap", "Conversion failed");
            notification_message(app->notifications, &sequence_blink_red_100);
        }
        gpx_converter_free(conv);
        return;
    }

    // Multiple files — show a submenu so the user can pick one
    volatile int32_t selection = -1;
    Submenu* submenu = submenu_alloc();
    submenu_set_header(submenu, "Select CSV to convert");
    for(int i = 0; i < count; i++) {
        const char* name = gpx_converter_get_name(conv, i);
        if(name) {
            submenu_add_item(
                submenu, name, (uint32_t)i,
                converter_selection_callback, (void*)&selection);
        }
    }

    View* submenu_view = submenu_get_view(submenu);
    Gui* gui = furi_record_open(RECORD_GUI);
    ViewDispatcher* view_dispatcher = view_dispatcher_alloc();
    view_dispatcher_enable_queue(view_dispatcher);
    view_dispatcher_add_view(view_dispatcher, 0, submenu_view);
    view_dispatcher_attach_to_gui(view_dispatcher, gui, ViewDispatcherTypeFullscreen);
    view_dispatcher_switch_to_view(view_dispatcher, 0);
    view_dispatcher_run(view_dispatcher);

    view_dispatcher_remove_view(view_dispatcher, 0);
    view_dispatcher_free(view_dispatcher);
    furi_record_close(RECORD_GUI);

    int32_t sel = selection;
    submenu_free(submenu);

    if(sel >= 0 && sel < count) {
        const char* csv_name = gpx_converter_get_name(conv, sel);
        FURI_LOG_I("BioMap", "Converting %s", csv_name);
        if(gpx_converter_run(conv, csv_name)) {
            FURI_LOG_I("BioMap", "Conversion complete");
            notification_message(app->notifications, &sequence_blink_green_100);
        } else {
            FURI_LOG_E("BioMap", "Conversion failed");
            notification_message(app->notifications, &sequence_blink_red_100);
        }
    }

    gpx_converter_free(conv);
}

static void run_gps_hot_start(BioMapApp* app) {
    FURI_LOG_I("BioMap", "Running manual GPS Hot Start reset");
    GpsUart* gps = gps_uart_alloc(app->event_queue, app->notifications);
    if(gps && gps_uart_is_ready(gps)) {
        gps_uart_send_hot_start(gps);
        notification_message(app->notifications, &sequence_blink_green_100);
        furi_delay_ms(300); // let it transmit
    } else {
        notification_message(app->notifications, &sequence_blink_red_100);
    }
    if(gps) {
        gps_uart_free(gps);
    }
}

// ---------------------------------------------------------------------------
// Recording session: init hardware, run event loop, shutdown
// ---------------------------------------------------------------------------
static void run_recording_session(BioMapApp* app, BioMapMode mode) {
    app->mode = mode;

    // --- Reset session state ---
    app->gsr_raw_sum       = 0;
    app->raw_count         = 0;
    app->tick_counter      = 0;
    app->graph_head        = 0;
    app->display_smoothed  = 0.0f;
    app->display_primed    = false;
    app->recording_active  = false;
    app->recording_filename[0] = '\0';
    app->running           = true;
    for(int i = 0; i < GRAPH_MAX_SAMPLES; i++) app->graph_buf[i] = 0.0f;

    // --- Enable OTG 5V power for GPS module (only when GPS active) ---
    app->otg_was_enabled = furi_hal_power_is_otg_enabled();
    if(mode_has_gps(mode)) {
        uint8_t otg_attempts = 5;
        while(--otg_attempts > 0) {
            if(furi_hal_power_enable_otg()) break;
        }
        if(otg_attempts == 0) {
            FURI_LOG_E("BioMap", "OTG power enable failed — GPS may not work");
        }
    }

    // --- Allocate modules based on mode ---
    if(mode_has_gps(mode)) {
        app->gps = gps_uart_alloc(app->event_queue, app->notifications);
    } else {
        app->gps = NULL;
    }

    if(mode_has_gsr(mode)) {
        app->gsr = gsr_sensor_alloc();
    } else {
        app->gsr = NULL;
    }

    app->logger = sd_logger_alloc(app->storage);

    // --- GUI setup ---
    ViewPort* view_port = view_port_alloc();
    view_port_draw_callback_set(view_port, render_callback, app);
    view_port_input_callback_set(view_port, input_callback, app->event_queue);
    Gui* gui = furi_record_open(RECORD_GUI);
    gui_add_view_port(gui, view_port, GuiLayerFullscreen);

    // --- 10 Hz tick timer ---
    FuriTimer* timer = furi_timer_alloc(timer_callback, FuriTimerTypePeriodic, app->event_queue);
    furi_timer_start(timer, furi_kernel_get_tick_frequency() / APP_TICK_HZ);

    // -------------------------------------------------------------------
    // MAIN EVENT LOOP
    // -------------------------------------------------------------------
    PluginEvent event;
    while(app->running) {
        if(furi_message_queue_get(app->event_queue, &event, FuriWaitForever) != FuriStatusOk) {
            continue;
        }

        // --- UART RX: drain stream buffer, parse NMEA (GPS only) ---
        if(event.type == EventTypeUart && app->gps) {
            furi_mutex_acquire(app->mutex, FuriWaitForever);
            gps_uart_process_rx(app->gps);
            furi_mutex_release(app->mutex);
            view_port_update(view_port);
        }

        // --- Button presses ---
        else if(event.type == EventTypeKey && event.input.type == InputTypeShort) {
            switch(event.input.key) {

            case InputKeyBack:
                app->running = false;
                break;

            case InputKeyOk: {
                bool start_recording = false;
                bool stop_recording = false;

                furi_mutex_acquire(app->mutex, FuriWaitForever);
                if(!app->recording_active) {
                    start_recording = true;
                } else {
                    stop_recording = true;
                }
                furi_mutex_release(app->mutex);

                if(start_recording) {
                    if(sd_logger_start(app->logger)) {
                        furi_mutex_acquire(app->mutex, FuriWaitForever);
                        app->recording_active = true;
                        strncpy(app->recording_filename,
                                sd_logger_get_filename(app->logger),
                                sizeof(app->recording_filename));
                        app->recording_filename[sizeof(app->recording_filename) - 1] = '\0';
                        // Reset accumulator for fresh session
                        app->tick_counter = 0;
                        app->raw_count    = 0;
                        app->gsr_raw_sum  = 0;
                        furi_mutex_release(app->mutex);
                        notification_message(app->notifications, &sequence_blink_blue_10);
                    }
                } else if(stop_recording) {
                    sd_logger_stop(app->logger);
                    furi_mutex_acquire(app->mutex, FuriWaitForever);
                    app->recording_active = false;
                    app->recording_filename[0] = '\0';
                    furi_mutex_release(app->mutex);
                    notification_message(app->notifications, &sequence_blink_blue_100);
                }
                view_port_update(view_port);
                break;
            }

            case InputKeyUp:
                if(mode_has_gsr(mode)) {
                    furi_mutex_acquire(app->mutex, FuriWaitForever);
                    app->zoom_level = fminf(app->zoom_level + ZOOM_STEP, ZOOM_MAX);
                    furi_mutex_release(app->mutex);
                    view_port_update(view_port);
                }
                break;

            case InputKeyDown:
                if(mode_has_gsr(mode)) {
                    furi_mutex_acquire(app->mutex, FuriWaitForever);
                    app->zoom_level = fmaxf(app->zoom_level - ZOOM_STEP, ZOOM_MIN);
                    furi_mutex_release(app->mutex);
                    view_port_update(view_port);
                }
                break;

            default:
                break;
            }
        }

        // --- 10 Hz tick: sample GSR, accumulate, write CSV at 1 Hz ---
        else if(event.type == EventTypeTick) {
            furi_mutex_acquire(app->mutex, FuriWaitForever);

            // Read GSR sensor (only when GSR active)
            int16_t current_raw = 0;
            if(app->gsr) {
                gsr_sensor_tick(app->gsr);
                current_raw = gsr_sensor_get_raw(app->gsr);

                // Display-only EMA for the waveform graph (not logged)
                float raw_f = (float)current_raw;
                if(!app->display_primed) {
                    app->display_smoothed = raw_f;
                    app->display_primed = true;
                }
                float new_smoothed = (DISPLAY_EMA_ALPHA * raw_f)
                    + ((1.0f - DISPLAY_EMA_ALPHA) * app->display_smoothed);
                float rate = new_smoothed - app->display_smoothed;
                app->display_smoothed = new_smoothed;
                float display_elev = -(rate) * 0.5f; // visual only

                app->graph_buf[app->graph_head] = display_elev;
                app->graph_head = (app->graph_head + 1) % GRAPH_MAX_SAMPLES;

                // Accumulate raw for 1-second average
                app->gsr_raw_sum += current_raw;
                app->raw_count++;
            }

            app->tick_counter++;

            // --- 1-Second boundary: write CSV row ---
            if(app->tick_counter >= APP_TICKS_PER_SEC) {
                // Gather GPS data (if available)
                float lat = 0, lon = 0, alt = 0;
                int sats = 0, fix = 0;
                if(app->gps) {
                    GpsStatus gps_status = gps_uart_get_status(app->gps);
                    if(gps_status.fix_valid || gps_status.fix_quality > 0) {
                        if(!isnan(gps_status.latitude) && !isnan(gps_status.longitude)) {
                            lat = gps_status.latitude;
                            lon = gps_status.longitude;
                            alt = gps_status.altitude;
                        }
                    }
                    sats = gps_status.satellites_tracked;
                    fix  = gps_status.fix_quality;
                }

                // Average GSR raw value over the second
                int16_t avg_raw = 0;
                if(app->raw_count > 0) {
                    avg_raw = (int16_t)(app->gsr_raw_sum / app->raw_count);
                }

                // Format timestamp
                char timestamp[32];
                format_timestamp(app, timestamp, sizeof(timestamp));

                if(app->recording_active) {
                    sd_logger_write_row(
                        app->logger, timestamp,
                        lat, lon, alt, sats, fix, avg_raw);
                }

                // Reset accumulator
                app->tick_counter = 0;
                app->raw_count    = 0;
                app->gsr_raw_sum  = 0;
            }

            furi_mutex_release(app->mutex);
            view_port_update(view_port);
        }
    }

    // -------------------------------------------------------------------
    // SESSION SHUTDOWN
    // -------------------------------------------------------------------

    // Stop timer first so no more tick events arrive
    furi_timer_stop(timer);
    furi_timer_free(timer);

    // Stop recording (closes file)
    if(app->recording_active) {
        sd_logger_stop(app->logger);
    }

    // Free modules (only those that were allocated)
    sd_logger_free(app->logger);
    app->logger = NULL;

    if(app->gsr) {
        gsr_sensor_free(app->gsr);
        app->gsr = NULL;
    }
    if(app->gps) {
        gps_uart_free(app->gps);
        app->gps = NULL;
    }

    // Disable OTG power if we enabled it
    if(mode_has_gps(mode) && furi_hal_power_is_otg_enabled() && !app->otg_was_enabled) {
        furi_hal_power_disable_otg();
    }

    // Tear down GUI
    gui_remove_view_port(gui, view_port);
    view_port_free(view_port);
    furi_record_close(RECORD_GUI);
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------
int32_t biomap_app(void* p) {
    UNUSED(p);

    // --- Allocate app state ---
    BioMapApp* app = malloc(sizeof(BioMapApp));
    furi_assert(app);
    memset(app, 0, sizeof(BioMapApp));

    app->event_queue = furi_message_queue_alloc(16, sizeof(PluginEvent));
    app->mutex       = furi_mutex_alloc(FuriMutexTypeNormal);
    app->zoom_level  = 1.0f;

    // --- Open shared records ---
    app->notifications = furi_record_open(RECORD_NOTIFICATION);
    notification_message_block(app->notifications, &sequence_display_backlight_enforce_auto);
    app->storage = furi_record_open(RECORD_STORAGE);

    // --- Launch menu loop ---
    bool app_running = true;
    while(app_running) {
        // Build submenu
        Submenu* submenu = submenu_alloc();
        submenu_set_header(submenu, "BioMapping 3.0");
        submenu_add_item(submenu, "GPS + GSR", MenuIdGpsGsr, menu_callback, app);
        submenu_add_item(submenu, "GPS Only", MenuIdGpsOnly, menu_callback, app);
        submenu_add_item(submenu, "GSR Only", MenuIdGsrOnly, menu_callback, app);
        submenu_add_item(submenu, "Convert CSV to GPX", MenuIdConvert, menu_callback, app);
        submenu_add_item(submenu, "Hot Start GPS", MenuIdHotStart, menu_callback, app);

        // Show submenu via ViewDispatcher
        app->menu_selection = -1;
        View* submenu_view = submenu_get_view(submenu);
        Gui* gui = furi_record_open(RECORD_GUI);

        // Use a ViewDispatcher for the submenu
        ViewDispatcher* view_dispatcher = view_dispatcher_alloc();
        view_dispatcher_enable_queue(view_dispatcher);
        view_dispatcher_add_view(view_dispatcher, 0, submenu_view);
        view_dispatcher_set_event_callback_context(view_dispatcher, app);

        view_dispatcher_attach_to_gui(view_dispatcher, gui, ViewDispatcherTypeFullscreen);
        view_dispatcher_switch_to_view(view_dispatcher, 0);

        // Wait for user selection — the submenu callback sets menu_selection.
        // We also need to handle Back to exit the app.
        // ViewDispatcher handles Back automatically — it will stop when Back is pressed.
        view_dispatcher_run(view_dispatcher);

        // Clean up menu
        view_dispatcher_remove_view(view_dispatcher, 0);
        view_dispatcher_free(view_dispatcher);
        furi_record_close(RECORD_GUI);

        // Process selection
        int32_t sel = app->menu_selection;
        submenu_free(submenu);

        if(sel == MenuIdGpsGsr) {
            run_recording_session(app, BioMapModeGpsGsr);
        } else if(sel == MenuIdGpsOnly) {
            run_recording_session(app, BioMapModeGpsOnly);
        } else if(sel == MenuIdGsrOnly) {
            run_recording_session(app, BioMapModeGsrOnly);
        } else if(sel == MenuIdConvert) {
            run_converter(app);
        } else if(sel == MenuIdHotStart) {
            run_gps_hot_start(app);
        } else {
            // Back pressed or no selection — exit app
            app_running = false;
        }
    }

    // --- Final cleanup ---
    notification_message_block(app->notifications, &sequence_display_backlight_enforce_auto);
    furi_record_close(RECORD_NOTIFICATION);
    furi_record_close(RECORD_STORAGE);

    furi_message_queue_free(app->event_queue);
    furi_mutex_free(app->mutex);
    free(app);

    return 0;
}