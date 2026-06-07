#include <furi.h>
#include <furi_hal.h>
#include <gui/gui.h>
#include <storage/storage.h>
#include <string.h>
#include <stdio.h>
#include <math.h>
#include <expansion/expansion.h>
#include "minmea.h"

#define ADS1115_ADDR (0x48 << 1)
#define ADS1115_CONV_REG 0x00
#define ADS1115_CONFIG_REG 0x01

// Math Configuration
const float EMA_ALPHA = 0.2f;
const float ELEVATION_SCALE = 0.5f;
const float ZOOM_STEP = 0.25f;
const float ZOOM_MIN = 0.25f;
const float ZOOM_MAX = 4.0f;

// Event Types for the FURI Message Queue
typedef enum {
    EventTypeTick,
    EventTypeKey
    // Note: UART ISR communicates via the nmea_ready flag, not the queue
} EventType;

typedef struct {
    EventType type;
    InputEvent input;
} PluginEvent;

typedef struct {
    float lat;
    float lon;
    struct minmea_time time;
    struct minmea_date date;
    bool fix_valid;
    int sats;
    int quality;
} GpsData;

// Global Application State
typedef struct {
    // GSR Data
    int16_t raw_diff;
    float smoothed_value;
    // rate_of_change is not a stored field — it is computed and consumed
    float elevation_base; // zoom-independent elevation, accumulated for GPX 1-sec average
    float elevation_sum;  // sum of per-tick elevation_base values; divided at write time
    bool smoothed_primed; // false until EMA is seeded from a real reading (prevents cold-start spike)
    bool gsr_available;

    // NMEA ISR staging buffer
    char nmea_staging[128];
    uint8_t nmea_staging_index;

    // Double-buffered GPS Data (Lock-free ISR-to-main communication)
    volatile uint8_t gps_data_idx;
    GpsData gps_data[2];

    // System
    int tick_counter;
    int raw_count; // number of ticks accumulated in current 1-second window
    File* gpx_file;
    Storage* storage; // kept open for entire app lifetime, not just recording start
    FuriHalSerialHandle* serial_handle; // acquired on init, released on shutdown
    FuriMessageQueue* event_queue;
    FuriMutex* mutex;

    // Recording
    bool recording;
    float zoom_level;
} BioMapApp;

// --- 1. GUI DRAWING CALLBACK ---
// This runs every time the screen needs to refresh
static void render_callback(Canvas* canvas, void* ctx) {
    BioMapApp* app = ctx;
    furi_mutex_acquire(app->mutex, FuriWaitForever);

    canvas_clear(canvas);
    canvas_set_font(canvas, FontPrimary);
    canvas_draw_str(canvas, 5, 12, "BioMapping 2.0");

    canvas_set_font(canvas, FontSecondary);

    // Record indicator (top right)
    if(app->recording) {
        canvas_draw_box(canvas, 118, 1, 8, 8); // Filled square = recording
    }

    // GSR status
    char gsr_str[64];
    if(app->gsr_available) {
        snprintf(gsr_str, sizeof(gsr_str), "Raw GSR: %d", app->raw_diff);
    } else {
        snprintf(gsr_str, sizeof(gsr_str), "Raw GSR: N/A (no sensor)");
    }
    canvas_draw_str(canvas, 5, 25, gsr_str);

    // Elevation — apply zoom here for display only (zoom not stored in elevation_base)
    snprintf(gsr_str, sizeof(gsr_str), "Elevation: %.2f", (double)(app->elevation_base * app->zoom_level));
    canvas_draw_str(canvas, 5, 35, gsr_str);

    // Zoom level
    snprintf(gsr_str, sizeof(gsr_str), "Zoom: %.2f", (double)app->zoom_level);
    canvas_draw_str(canvas, 5, 45, gsr_str);

    // Fetch the active GPS data block atomically
    GpsData gps = app->gps_data[app->gps_data_idx];

    // GPS status on the right side of the screen
    if(app->serial_handle != NULL) {
        char sat_str[32];
        snprintf(sat_str, sizeof(sat_str), "Sats: %d", gps.sats);
        canvas_draw_str(canvas, 80, 45, sat_str);

        char fix_str[32];
        const char* fix_type = "None";
        if(gps.quality == 1) fix_type = "GPS";
        else if(gps.quality == 2) fix_type = "DGPS";
        snprintf(fix_str, sizeof(fix_str), "Fix: %s", fix_type);
        canvas_draw_str(canvas, 80, 35, fix_str);
    }

    // GPS coordinates — formatted from parsed float values
    char gps_str[64];
    if(app->serial_handle == NULL) {
        snprintf(gps_str, sizeof(gps_str), "Lat: UART Locked!");
    } else if(gps.fix_valid && !isnan(gps.lat)) {
        snprintf(gps_str, sizeof(gps_str), "Lat: %.5f", (double)gps.lat);
    } else {
        snprintf(gps_str, sizeof(gps_str), "Lat: Waiting...");
    }
    canvas_draw_str(canvas, 5, 56, gps_str);

    if(app->serial_handle == NULL) {
        snprintf(gps_str, sizeof(gps_str), "Lon: Check System Debug");
    } else if(gps.fix_valid && !isnan(gps.lon)) {
        snprintf(gps_str, sizeof(gps_str), "Lon: %.5f", (double)gps.lon);
    } else {
        snprintf(gps_str, sizeof(gps_str), "Lon: Waiting...");
    }
    canvas_draw_str(canvas, 5, 63, gps_str); // Y=63 is the last visible row (display: 0-63)

    furi_mutex_release(app->mutex);
}

// --- 2. INPUT CALLBACK ---
static void input_callback(InputEvent* input_event, void* ctx) {
    FuriMessageQueue* event_queue = ctx;
    PluginEvent event = {.type = EventTypeKey, .input = *input_event};
    furi_message_queue_put(event_queue, &event, FuriWaitForever);
}

// --- 3. UART GPS INTERRUPT CALLBACK ---
// ISR-safe: parses NMEA sentences directly on completion, updating the
// double-buffered lock-free state.
static void parse_nmea_isr(BioMapApp* app, const char* line) {
    int sentence = minmea_sentence_id(line, false);
    if(sentence == MINMEA_INVALID) return;
    if(sentence != MINMEA_SENTENCE_RMC && sentence != MINMEA_SENTENCE_GGA) return;

    uint8_t next_idx = 1 - app->gps_data_idx;
    
    // Copy the current active state to the staging slot
    memcpy(&app->gps_data[next_idx], &app->gps_data[app->gps_data_idx], sizeof(GpsData));

    bool updated = false;

    if(sentence == MINMEA_SENTENCE_RMC) {
        struct minmea_sentence_rmc frame;
        if(minmea_parse_rmc(&frame, line)) {
            app->gps_data[next_idx].fix_valid = frame.valid;
            if(frame.valid) {
                app->gps_data[next_idx].lat = minmea_tocoord(&frame.latitude);
                app->gps_data[next_idx].lon = minmea_tocoord(&frame.longitude);
                app->gps_data[next_idx].time = frame.time;
                app->gps_data[next_idx].date = frame.date;
            }
            updated = true;
        }
    } else if(sentence == MINMEA_SENTENCE_GGA) {
        struct minmea_sentence_gga frame;
        if(minmea_parse_gga(&frame, line)) {
            app->gps_data[next_idx].sats = frame.satellites_tracked;
            app->gps_data[next_idx].quality = frame.fix_quality;
            if(frame.fix_quality > 0) {
                float lat = minmea_tocoord(&frame.latitude);
                float lon = minmea_tocoord(&frame.longitude);
                if(!app->gps_data[next_idx].fix_valid && !isnan(lat) && !isnan(lon)) {
                    app->gps_data[next_idx].lat = lat;
                    app->gps_data[next_idx].lon = lon;
                    app->gps_data[next_idx].time = frame.time;
                }
            }
            updated = true;
        }
    }

    if(updated) {
        app->gps_data_idx = next_idx;
    }
}

// New SDK (>= 0.19) serial API: callback receives (handle, event, context).
static void uart_callback(
    FuriHalSerialHandle* handle,
    FuriHalSerialRxEvent event,
    void* context) {
    if(event == FuriHalSerialRxEventData) {
        BioMapApp* app = context;
        while(furi_hal_serial_async_rx_available(handle)) {
            uint8_t data = furi_hal_serial_async_rx(handle);
            if(data == '\n' || app->nmea_staging_index >= 127) {
                app->nmea_staging[app->nmea_staging_index] = '\0';
                parse_nmea_isr(app, app->nmea_staging);
                app->nmea_staging_index = 0;
            } else {
                app->nmea_staging[app->nmea_staging_index++] = data;
            }
        }
    }
}

// --- 4. HARDWARE TIMER CALLBACK (10Hz) ---
static void timer_callback(void* context) {
    FuriMessageQueue* event_queue = context;
    PluginEvent event = {.type = EventTypeTick};
    furi_message_queue_put(event_queue, &event, 0); // Send Tick event to main loop
}

// --- 5. MAIN APPLICATION ENTRY POINT ---
int32_t biomap_app(void* p) {
    UNUSED(p);

    // Allocate Memory & Initialize App State
    BioMapApp* app = malloc(sizeof(BioMapApp));
    furi_assert(app); // assert rather than silently dereference a NULL pointer

    app->event_queue = furi_message_queue_alloc(8, sizeof(PluginEvent));
    app->mutex = furi_mutex_alloc(FuriMutexTypeNormal);
    app->smoothed_value = 0.0f;
    app->smoothed_primed = false;
    app->tick_counter = 0;
    app->raw_count = 0;
    app->elevation_sum = 0.0f;
    app->nmea_staging_index = 0;
    app->gsr_available = true;
    app->recording = false;
    app->zoom_level = 1.0f;

    // Initialise double-buffered GPS state — NaN signals "no fix yet" throughout the code
    app->gps_data_idx = 0;
    for(int i = 0; i < 2; i++) {
        app->gps_data[i].lat = NAN;
        app->gps_data[i].lon = NAN;
        app->gps_data[i].fix_valid = false;
        app->gps_data[i].sats = 0;
        app->gps_data[i].quality = 0;
        memset(&app->gps_data[i].time, -1, sizeof(struct minmea_time));
        memset(&app->gps_data[i].date, -1, sizeof(struct minmea_date));
    }

    memset(app->nmea_staging, 0, 128);
    app->gpx_file = NULL;

    // Disable expansion modules to prevent interference with the serial port
    // Wrap with furi_record_exists check to avoid crashing on firmwares without it
    Expansion* expansion = NULL;
    if(furi_record_exists(RECORD_EXPANSION)) {
        expansion = furi_record_open(RECORD_EXPANSION);
        if(expansion) {
            expansion_disable(expansion);
        }
    }

    // Open Storage once at startup and keep it open for the app's lifetime.
    app->storage = furi_record_open(RECORD_STORAGE);

    // Setup GUI ViewPort
    ViewPort* view_port = view_port_alloc();
    view_port_draw_callback_set(view_port, render_callback, app);
    view_port_input_callback_set(view_port, input_callback, app->event_queue);
    Gui* gui = furi_record_open(RECORD_GUI);
    gui_add_view_port(gui, view_port, GuiLayerFullscreen);

    // Hardware Setup: Default GPS Controls (Pins 15 & 16 / PC1 & PC0)
    // Because traces are not cut, SCL (Pin 15 / PC1) and SDA (Pin 16 / PC0) are still
    // wired to RESET and STANDBY. We drive them statically HIGH to keep the module active.
    furi_hal_gpio_init(&gpio_ext_pc1, GpioModeOutputPushPull, GpioPullNo, GpioSpeedLow);
    furi_hal_gpio_init(&gpio_ext_pc0, GpioModeOutputPushPull, GpioPullNo, GpioSpeedLow);
    // Standby HIGH (exits standby mode)
    furi_hal_gpio_write(&gpio_ext_pc0, true);
    // Perform a hardware reset pulse (active-low RESET driven low for 100ms, then high)
    furi_hal_gpio_write(&gpio_ext_pc1, false);
    furi_delay_ms(100);
    furi_hal_gpio_write(&gpio_ext_pc1, true);

    // Setup GPS Serial (L76K on USART1, 9600 8N1)
    // Acquire the handle first — this takes ownership of the peripheral and its GPIO
    // pins, preventing conflicts with the system logger or other apps.
    app->serial_handle = furi_hal_serial_control_acquire(FuriHalSerialIdUsart);
    if(app->serial_handle) {
        furi_hal_serial_init(app->serial_handle, 9600);
        // Enable internal pull-up on RX pin (gpio_ext_pa7 / Pin 14) to prevent floating noise interrupts when the GPS board is disconnected
        furi_hal_gpio_init_ex(&gpio_ext_pa7, GpioModeAltFunctionPushPull, GpioPullUp, GpioSpeedLow, GpioAltFn7USART1);
        furi_hal_serial_async_rx_start(app->serial_handle, uart_callback, app, false);
    }

    // Disable I2C communication entirely so SCL & SDA (Pins 15/16) stay statically high
    app->gsr_available = false;

    // Start 10Hz Timer
    FuriTimer* timer = furi_timer_alloc(timer_callback, FuriTimerTypePeriodic, app->event_queue);
    furi_timer_start(timer, furi_kernel_get_tick_frequency() / 10);

    // --- THE MAIN EVENT LOOP ---
    PluginEvent event;
    bool running = true;
    while(running) {
        // Wait for an event (Tick, Button, etc)
        if(furi_message_queue_get(app->event_queue, &event, FuriWaitForever) == FuriStatusOk) {

            // --- Handle Button Presses ---
            if(event.type == EventTypeKey && event.input.type == InputTypeShort) {
                switch(event.input.key) {
                case InputKeyBack:
                    running = false; // Exit app
                    break;
                case InputKeyOk:
                    app->recording = !app->recording; // Toggle recording
                    if(app->recording) {
                        app->gpx_file = storage_file_alloc(app->storage);
                        if(storage_file_open(app->gpx_file, EXT_PATH("biomap_walk.gpx"),
                                             FSAM_WRITE, FSOM_CREATE_ALWAYS)) {
                            const char* hdr =
                                "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
                                "<gpx version=\"1.1\" creator=\"FlipperZero BioMapping\">\n"
                                "  <trk>\n"
                                "    <name>Stress &amp; Relaxation Walk</name>\n"
                                "    <trkseg>\n";
                            storage_file_write(app->gpx_file, hdr, strlen(hdr));
                        } else {
                            // File open failed — free the allocated handle and abort
                            storage_file_free(app->gpx_file);
                            app->gpx_file = NULL;
                            app->recording = false;
                        }
                        app->tick_counter = 0; // Reset 1-sec buffer on new recording start
                        app->raw_count = 0;
                        app->elevation_sum = 0.0f;
                    } else {
                        // Close GPX file on stop
                        if(app->gpx_file) {
                            const char* ftr = "    </trkseg>\n  </trk>\n</gpx>\n";
                            storage_file_write(app->gpx_file, ftr, strlen(ftr));
                            storage_file_close(app->gpx_file);
                            storage_file_free(app->gpx_file);
                            app->gpx_file = NULL;
                        }
                    }
                    break;
                case InputKeyUp:
                    app->zoom_level = fminf(app->zoom_level + ZOOM_STEP, ZOOM_MAX);
                    break;
                case InputKeyDown:
                    app->zoom_level = fmaxf(app->zoom_level - ZOOM_STEP, ZOOM_MIN);
                    break;
                default:
                    break;
                }
            }

            // --- Handle 10Hz Tick (Read GSR & Buffer) ---
            if(event.type == EventTypeTick) {
                furi_mutex_acquire(app->mutex, FuriWaitForever);

                // Fetch the active GPS data block atomically
                GpsData gps = app->gps_data[app->gps_data_idx];

                // --- Read ADS1115 (fall back to 0 if unavailable) ---
                if(app->gsr_available) {
                    uint8_t data[2];
                    furi_hal_i2c_acquire(&furi_hal_i2c_handle_external);
                    if(furi_hal_i2c_read_mem(&furi_hal_i2c_handle_external, ADS1115_ADDR,
                                             ADS1115_CONV_REG, data, 2, 50)) { // 50ms timeout
                        app->raw_diff = (data[0] << 8) | data[1];
                    } else {
                        app->raw_diff = 0; // I2C glitch — use zero
                    }
                    furi_hal_i2c_release(&furi_hal_i2c_handle_external);
                } else {
                    app->raw_diff = 0; // No sensor — always zero
                }

                // Prime the EMA from the first real reading to prevent the cold-start
                // transient. Without this, smoothed_value starts at 0 and ramps to the
                // user's real baseline over ~3s, producing a large artificial spike at start.
                if(!app->smoothed_primed) {
                    app->smoothed_value = (float)app->raw_diff;
                    app->smoothed_primed = true;
                }

                // Signal Processing: EMA Smoothing + Derivative.
                // rate_of_change is a local — it is computed and consumed in the same
                // tick; there is no need to persist it across ticks in the struct.
                float current_smoothed = (EMA_ALPHA * (float)app->raw_diff) +
                                         ((1.0f - EMA_ALPHA) * app->smoothed_value);
                float rate_of_change = current_smoothed - app->smoothed_value;
                app->smoothed_value = current_smoothed;

                // Store elevation WITHOUT zoom so the 1-second accumulator is
                // consistent even if the user presses Up/Down mid-second. Zoom is
                // applied separately at display time (render_callback) and GPX write time.
                app->elevation_base = -(rate_of_change) * ELEVATION_SCALE;

                // Accumulate per-tick elevations for 1-second average
                app->raw_count++;
                app->elevation_sum += app->elevation_base; // accumulate zoom-free elevations
                app->tick_counter++;

                // --- 1-Second Buffer: average 10 readings, write to SD ---
                if(app->tick_counter >= 10) {
                    // Average the 10 actual computed elevations.
                    // Apply the current zoom to the averaged base elevation at write time.
                    // Because elevation_sum is zoom-free, changing zoom mid-second no longer
                    // corrupts the average — zoom is always applied to the final number.
                    float avg_elevation = (app->raw_count > 0)
                        ? (app->elevation_sum / (float)app->raw_count) * app->zoom_level
                        : 0.0f;

                    // Only write a trackpoint if we have a valid GPS fix
                    if(app->recording && app->gpx_file && gps.fix_valid) {
                        // Build a full ISO8601 timestamp from minmea parsed fields.
                        // RMC provides both date and time; fall back to epoch if missing.
                        char time_str[32] = "1970-01-01T00:00:00Z";
                        if(gps.time.hours != -1 && gps.date.year != -1) {
                            // minmea stores 2-digit years; add 2000 for 21st century
                            int full_year = (gps.date.year < 80)
                                ? 2000 + gps.date.year
                                : 1900 + gps.date.year;
                            snprintf(time_str, sizeof(time_str),
                                     "%04d-%02d-%02dT%02d:%02d:%02dZ",
                                     full_year,
                                     gps.date.month,
                                     gps.date.day,
                                     gps.time.hours,
                                     gps.time.minutes,
                                     gps.time.seconds);
                        } else if(gps.time.hours != -1) {
                            // Time available but no date (GGA-only)
                            snprintf(time_str, sizeof(time_str),
                                     "1970-01-01T%02d:%02d:%02dZ",
                                     gps.time.hours,
                                     gps.time.minutes,
                                     gps.time.seconds);
                        }

                        // Write trackpoint using decimal-degree coordinates from minmea
                        char gpx_string[256];
                        snprintf(gpx_string, sizeof(gpx_string),
                            "      <trkpt lat=\"%.6f\" lon=\"%.6f\">\n"
                            "        <ele>%.2f</ele>\n"
                            "        <time>%s</time>\n"
                            "      </trkpt>\n",
                            (double)gps.lat,
                            (double)gps.lon,
                            (double)avg_elevation,
                            time_str);
                        storage_file_write(app->gpx_file, gpx_string, strlen(gpx_string));
                    }
                    // Reset 1-second buffer
                    app->tick_counter = 0;
                    app->raw_count = 0;
                    app->elevation_sum = 0.0f;
                }

                furi_mutex_release(app->mutex);
                view_port_update(view_port); // Refresh screen
            }
        }
    }

    // --- GRACEFUL SHUTDOWN (Runs when user presses 'Back') ---
    furi_timer_stop(timer);
    furi_timer_free(timer);
    // Shut down GPS serial — stop RX first, then deinit, then release the handle.
    // Order matters: async_rx_stop disables the IRQ before deinit touches the hardware.
    if(app->serial_handle) {
        furi_hal_serial_async_rx_stop(app->serial_handle);
        furi_hal_serial_deinit(app->serial_handle);
        furi_hal_serial_control_release(app->serial_handle);
        app->serial_handle = NULL;
    }

    // Re-enable expansion modules
    if(expansion) {
        expansion_enable(expansion);
        furi_record_close(RECORD_EXPANSION);
    }

    // Reset Pins 15 & 16 to default analog/floating state
    furi_hal_gpio_init(&gpio_ext_pc1, GpioModeAnalog, GpioPullNo, GpioSpeedLow);
    furi_hal_gpio_init(&gpio_ext_pc0, GpioModeAnalog, GpioPullNo, GpioSpeedLow);

    // Close GPX if still open (user pressed Back while recording)
    if(app->gpx_file) {
        const char* ftr = "    </trkseg>\n  </trk>\n</gpx>\n";
        storage_file_write(app->gpx_file, ftr, strlen(ftr));
        storage_file_close(app->gpx_file);
        storage_file_free(app->gpx_file);
    }

    // Close Storage once here, after all file I/O is complete
    furi_record_close(RECORD_STORAGE);

    gui_remove_view_port(gui, view_port);
    view_port_free(view_port);
    furi_record_close(RECORD_GUI);

    furi_message_queue_free(app->event_queue);
    furi_mutex_free(app->mutex);
    free(app);

    return 0;
}