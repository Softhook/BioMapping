// BioMapping 3.0 — Main Application
// Christian Nold / 2026
//
// Records GSR (galvanic skin response) mapped to GPS coordinates as a GPX
// tracklog. GSR fluctuations are encoded as topographic elevation so the walk
// can be visualised in Google Earth as a stress/relaxation landscape.
//
// Architecture:
//   gps_uart  — UART NMEA parser (based on ezod/flipperzero-gps)
//   gsr_sensor — ADS1115 I2C reader (disabled until hardware mod complete)
//   sd_logger  — Auto-incremented GPX file writer
//
// Controls:
//   OK    — Toggle recording on/off
//   Up    — Zoom in  (increase GSR elevation sensitivity)
//   Down  — Zoom out (decrease GSR elevation sensitivity)
//   Back  — Safe exit (closes GPX file, releases all hardware)

#include <furi.h>
#include <furi_hal.h>
#include <furi_hal_power.h>
#include <gui/gui.h>
#include <notification/notification_messages.h>
#include <storage/storage.h>
#include <string.h>
#include <stdio.h>
#include <math.h>

#include "biomap_events.h"
#include "modules/gps_uart.h"
#include "modules/gsr_sensor.h"
#include "modules/sd_logger.h"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
#define APP_TICK_HZ         10      // timer fires 10× per second
#define APP_TICKS_PER_SEC   10      // ticks to accumulate before GPX write
#define ZOOM_STEP           0.25f
#define ZOOM_MIN            0.25f
#define ZOOM_MAX            4.0f

// Waveform graph dimensions (bottom-right area of 128×64 display)
#define GRAPH_X             65
#define GRAPH_Y             20
#define GRAPH_W             61
#define GRAPH_H             40
#define GRAPH_SAMPLES       (GRAPH_W - 2) // one pixel per sample column inside border
#define GRAPH_CENTRE_Y      (GRAPH_Y + GRAPH_H / 2)

// ---------------------------------------------------------------------------
// Application state
// ---------------------------------------------------------------------------
typedef struct {
    // Modules
    GpsUart*   gps;
    GsrSensor* gsr;
    SdLogger*  logger;

    // FURI primitives
    FuriMessageQueue* event_queue;
    FuriMutex*        mutex;
    Storage*          storage;
    NotificationApp*  notifications;

    // GSR 1-second accumulator
    float  elevation_sum; // sum of zoom-free elevation_base values
    int    raw_count;     // number of ticks accumulated
    int    tick_counter;  // counts up to APP_TICKS_PER_SEC

    // Waveform ring buffer (zoom-applied elevation values for display)
    float  graph_buf[GRAPH_SAMPLES];
    int    graph_head; // next write position

    // User settings
    float  zoom_level;
    bool   running;

    // Caching for thread safety (accessed by GUI thread under mutex)
    bool   recording_active;
    char   recording_filename[64];
} BioMapApp;

// ---------------------------------------------------------------------------
// UI rendering
// ---------------------------------------------------------------------------
static void render_callback(Canvas* canvas, void* ctx) {
    BioMapApp* app = (BioMapApp*)ctx;
    furi_mutex_acquire(app->mutex, FuriWaitForever);

    canvas_clear(canvas);

    // --- Title bar (left side) ---
    canvas_set_font(canvas, FontPrimary);
    canvas_draw_str(canvas, 0, 10, "BioMap 3.0");

    canvas_set_font(canvas, FontSecondary);

    // --- Recording indicator ---
    if(app->recording_active) {
        canvas_draw_box(canvas, 118, 1, 8, 8); // filled square = recording
        // Show filename (e.g. "042.gpx") trimmed to fit
        const char* fname = app->recording_filename;
        // Skip "biomap_" prefix (7 chars) to show just "042.gpx"
        const char* short_name = (strlen(fname) > 7) ? fname + 7 : fname;
        canvas_draw_str(canvas, 0, 20, short_name);
    }

    // --- GPS status ---
    GpsStatus gps = gps_uart_get_status(app->gps);

    char buf[48];
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

    // --- Satellites + fix quality (bottom left) ---
    snprintf(buf, sizeof(buf), "Sats:%d Q:%d", gps.satellites_tracked, gps.fix_quality);
    canvas_draw_str(canvas, 0, 50, buf);

    // --- Zoom level ---
    snprintf(buf, sizeof(buf), "Z:%.2f", (double)app->zoom_level);
    canvas_draw_str(canvas, 0, 63, buf);

    // --- GSR status (bottom left, below zoom) ---
    if(gsr_sensor_available(app->gsr)) {
        snprintf(buf, sizeof(buf), "GSR:%d", (int)gsr_sensor_get_raw(app->gsr));
        canvas_draw_str(canvas, 35, 63, buf);
    } else {
        canvas_draw_str(canvas, 35, 63, "GSR:off");
    }

    // --- Waveform graph (right panel) ---
    // Draw border
    canvas_draw_frame(canvas, GRAPH_X, GRAPH_Y, GRAPH_W, GRAPH_H);
    // Centre line
    canvas_draw_line(canvas, GRAPH_X, GRAPH_CENTRE_Y, GRAPH_X + GRAPH_W - 1, GRAPH_CENTRE_Y);

    // Scale: map elevation_base to pixel offset.
    // Full-scale ±100 elevation units → ±(GRAPH_H/2 - 2) pixels
    const float scale = (float)(GRAPH_H / 2 - 2) / 100.0f;

    for(int i = 0; i < GRAPH_SAMPLES - 1; i++) {
        int src_i = (app->graph_head + i) % GRAPH_SAMPLES;
        int src_j = (app->graph_head + i + 1) % GRAPH_SAMPLES;

        float v0 = app->graph_buf[src_i] * app->zoom_level;
        float v1 = app->graph_buf[src_j] * app->zoom_level;

        // Clamp to graph bounds
        int y0 = GRAPH_CENTRE_Y - (int)(v0 * scale);
        int y1 = GRAPH_CENTRE_Y - (int)(v1 * scale);
        int ymin = GRAPH_Y + 1;
        int ymax = GRAPH_Y + GRAPH_H - 2;
        if(y0 < ymin) y0 = ymin;
        if(y0 > ymax) y0 = ymax;
        if(y1 < ymin) y1 = ymin;
        if(y1 > ymax) y1 = ymax;

        int x0 = GRAPH_X + 1 + i;
        int x1 = GRAPH_X + 1 + i + 1;
        canvas_draw_line(canvas, x0, y0, x1, y1);
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
// Main entry point
// ---------------------------------------------------------------------------
int32_t biomap_app(void* p) {
    UNUSED(p);

    // --- Allocate app state ---
    BioMapApp* app = malloc(sizeof(BioMapApp));
    furi_assert(app);

    app->event_queue   = furi_message_queue_alloc(16, sizeof(PluginEvent));
    app->mutex         = furi_mutex_alloc(FuriMutexTypeNormal);
    app->zoom_level    = 1.0f;
    app->elevation_sum = 0.0f;
    app->raw_count     = 0;
    app->tick_counter  = 0;
    app->graph_head    = 0;
    app->running       = true;
    app->recording_active = false;
    app->recording_filename[0] = '\0';

    // Zero the waveform buffer
    for(int i = 0; i < GRAPH_SAMPLES; i++) app->graph_buf[i] = 0.0f;

    // --- Enable OTG 5V power for GPS module ---
    // The L76K GNSS Shield needs 5V via the Flipper's OTG line.
    // Without this the GPS never powers on and shows "Waiting for fix...".
    bool otg_was_enabled = furi_hal_power_is_otg_enabled();
    {
        uint8_t otg_attempts = 5;
        while(--otg_attempts > 0) {
            if(furi_hal_power_enable_otg()) break;
        }
        if(otg_attempts == 0) {
            FURI_LOG_E("BioMap", "OTG power enable failed — GPS may not work");
        }
    }

    // --- Open shared records ---
    app->notifications = furi_record_open(RECORD_NOTIFICATION);
    notification_message_block(app->notifications, &sequence_display_backlight_enforce_auto);
    app->storage = furi_record_open(RECORD_STORAGE);

    // --- Allocate modules ---
    app->gps    = gps_uart_alloc(app->event_queue, app->notifications);
    app->gsr    = gsr_sensor_alloc();
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

    // -----------------------------------------------------------------------
    // MAIN EVENT LOOP
    // -----------------------------------------------------------------------
    PluginEvent event;
    while(app->running) {
        if(furi_message_queue_get(app->event_queue, &event, FuriWaitForever) != FuriStatusOk) {
            continue;
        }

        // --- UART RX: drain stream buffer, parse NMEA ---
        if(event.type == EventTypeUart) {
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
                    // Start recording (SD access outside lock)
                    if(sd_logger_start(app->logger)) {
                        furi_mutex_acquire(app->mutex, FuriWaitForever);
                        app->recording_active = true;
                        strncpy(app->recording_filename, sd_logger_get_filename(app->logger), sizeof(app->recording_filename));
                        app->recording_filename[sizeof(app->recording_filename) - 1] = '\0';
                        // Reset 1-second accumulator for fresh session
                        app->tick_counter  = 0;
                        app->raw_count     = 0;
                        app->elevation_sum = 0.0f;
                        gsr_sensor_reset_primer(app->gsr);
                        furi_mutex_release(app->mutex);
                        notification_message(app->notifications, &sequence_blink_blue_10);
                    }
                } else if(stop_recording) {
                    // Stop recording (SD access outside lock)
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
                furi_mutex_acquire(app->mutex, FuriWaitForever);
                app->zoom_level = fminf(app->zoom_level + ZOOM_STEP, ZOOM_MAX);
                furi_mutex_release(app->mutex);
                view_port_update(view_port);
                break;

            case InputKeyDown:
                furi_mutex_acquire(app->mutex, FuriWaitForever);
                app->zoom_level = fmaxf(app->zoom_level - ZOOM_STEP, ZOOM_MIN);
                furi_mutex_release(app->mutex);
                view_port_update(view_port);
                break;

            default:
                break;
            }
        }

        // --- 10 Hz tick: sample GSR, accumulate, write GPX at 1 Hz ---
        else if(event.type == EventTypeTick) {
            furi_mutex_acquire(app->mutex, FuriWaitForever);

            // Read GSR sensor (no-op when disabled)
            gsr_sensor_tick(app->gsr);

            float elev_base = gsr_sensor_get_elevation_base(app->gsr);

            // Push zoom-free elevation into graph ring buffer (display
            // applies zoom at render time so Up/Down is live)
            app->graph_buf[app->graph_head] = elev_base;
            app->graph_head = (app->graph_head + 1) % GRAPH_SAMPLES;

            // Accumulate for 1-second average
            app->elevation_sum += elev_base;
            app->raw_count++;
            app->tick_counter++;

            // --- 1-Second boundary: write GPX point ---
            if(app->tick_counter >= APP_TICKS_PER_SEC) {
                float avg_base = (app->raw_count > 0)
                    ? (app->elevation_sum / (float)app->raw_count)
                    : 0.0f;
                float avg_zoomed = avg_base * app->zoom_level;

                // Snapshot GPS status under the mutex
                GpsStatus gps = gps_uart_get_status(app->gps);

                if(app->recording_active) {
                    sd_logger_write_point(app->logger, &gps, avg_zoomed);
                }

                // Reset accumulator
                app->tick_counter  = 0;
                app->raw_count     = 0;
                app->elevation_sum = 0.0f;
            }

            furi_mutex_release(app->mutex);
            view_port_update(view_port);
        }
    }

    // -----------------------------------------------------------------------
    // GRACEFUL SHUTDOWN
    // -----------------------------------------------------------------------

    // Stop timer first so no more tick events arrive
    furi_timer_stop(timer);
    furi_timer_free(timer);

    // Stop recording (writes GPX footer, closes file)
    if(app->recording_active) {
        sd_logger_stop(app->logger);
    }

    // Free modules (releases serial, GPIO, etc.)
    sd_logger_free(app->logger);
    gsr_sensor_free(app->gsr);
    gps_uart_free(app->gps);

    // Disable OTG power if we enabled it
    if(furi_hal_power_is_otg_enabled() && !otg_was_enabled) {
        furi_hal_power_disable_otg();
    }

    // Reset backlight
    notification_message_block(app->notifications, &sequence_display_backlight_enforce_auto);
    furi_record_close(RECORD_NOTIFICATION);
    furi_record_close(RECORD_STORAGE);

    // Tear down GUI
    gui_remove_view_port(gui, view_port);
    view_port_free(view_port);
    furi_record_close(RECORD_GUI);

    // Free FURI primitives
    furi_message_queue_free(app->event_queue);
    furi_mutex_free(app->mutex);
    free(app);

    return 0;
}