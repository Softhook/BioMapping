#include <furi.h>
#include <furi_hal.h>
#include <gui/gui.h>
#include <storage/storage.h>
#include <string.h>
#include <stdio.h>
#include <math.h>

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
    EventTypeKey,
    EventTypeUart
} EventType;

typedef struct {
    EventType type;
    InputEvent input;
} PluginEvent;

// Global Application State
typedef struct {
    // GSR Data
    int16_t raw_diff;
    float smoothed_value;
    float rate_of_change;
    float elevation;
    bool gsr_available;

    // GPS Data
    char gps_lat[16];
    char gps_lon[16];
    char gps_time[16];
    char nmea_buffer[128];
    uint8_t nmea_index;
    bool nmea_ready;

    // System
    int tick_counter;
    int16_t raw_sum;
    int raw_count;
    File* gpx_file;
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

    // Elevation / rate of change
    snprintf(gsr_str, sizeof(gsr_str), "Elevation: %.2f", (double)app->elevation);
    canvas_draw_str(canvas, 5, 35, gsr_str);

    // Zoom level
    snprintf(gsr_str, sizeof(gsr_str), "Zoom: %.2f", (double)app->zoom_level);
    canvas_draw_str(canvas, 5, 45, gsr_str);

    // GPS coordinates
    char gps_str[64];
    snprintf(gps_str, sizeof(gps_str), "Lat: %s", app->gps_lat[0] != '\0' ? app->gps_lat : "Waiting...");
    canvas_draw_str(canvas, 5, 56, gps_str);
    snprintf(gps_str, sizeof(gps_str), "Lon: %s", app->gps_lon[0] != '\0' ? app->gps_lon : "Waiting...");
    canvas_draw_str(canvas, 5, 64, gps_str);

    furi_mutex_release(app->mutex);
}

// --- 2. INPUT CALLBACK ---
static void input_callback(InputEvent* input_event, void* ctx) {
    FuriMessageQueue* event_queue = ctx;
    PluginEvent event = {.type = EventTypeKey, .input = *input_event};
    furi_message_queue_put(event_queue, &event, FuriWaitForever);
}

// --- 3. UART GPS INTERRUPT CALLBACK ---
// This triggers the millisecond a character arrives from the L76K module
// ISR-safe: only buffers characters, sets a flag. Parsing happens in the main loop.
static void uart_callback(UartIrqEvent ev, uint8_t data, void* context) {
    if(ev == UartIrqEventRXNE) {
        BioMapApp* app = context;
        if(data == '\n' || app->nmea_index >= 127) {
            app->nmea_buffer[app->nmea_index] = '\0';
            app->nmea_ready = true;
            app->nmea_index = 0;
        } else {
            app->nmea_buffer[app->nmea_index++] = data;
        }
    }
}

// --- 3b. NMEA SENTENCE PARSER (runs in main loop, not ISR) ---
static void parse_nmea(BioMapApp* app) {
    // Only parse $GPGGA or $GNGGA sentences
    if(strncmp(app->nmea_buffer, "$GPGGA", 6) != 0 && strncmp(app->nmea_buffer, "$GNGGA", 6) != 0) {
        return;
    }

    // Make a local copy so strtok doesn't corrupt the shared buffer
    char copy[128];
    strncpy(copy, app->nmea_buffer, 128);
    copy[127] = '\0';

    int commas = 0;
    char* token = strtok(copy, ",");
    while(token != NULL) {
        switch(commas) {
        case 1: // UTC Time (HHMMSS.SS)
            strncpy(app->gps_time, token, 15);
            break;
        case 2: // Latitude
            strncpy(app->gps_lat, token, 15);
            break;
        case 4: // Longitude
            strncpy(app->gps_lon, token, 15);
            break;
        }
        token = strtok(NULL, ",");
        commas++;
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
    app->event_queue = furi_message_queue_alloc(8, sizeof(PluginEvent));
    app->mutex = furi_mutex_alloc(FuriMutexTypeNormal);
    app->smoothed_value = 0.0f;
    app->tick_counter = 0;
    app->raw_sum = 0;
    app->raw_count = 0;
    app->nmea_index = 0;
    app->nmea_ready = false;
    app->gsr_available = true;
    app->recording = false;
    app->zoom_level = 1.0f;
    memset(app->gps_lat, 0, 16);
    memset(app->gps_lon, 0, 16);
    memset(app->gps_time, 0, 16);
    app->gpx_file = NULL;

    // Setup GUI ViewPort
    ViewPort* view_port = view_port_alloc();
    view_port_draw_callback_set(view_port, render_callback, app);
    view_port_input_callback_set(view_port, input_callback, app->event_queue);
    Gui* gui = furi_record_open(RECORD_GUI);
    gui_add_view_port(gui, view_port, GuiLayerFullscreen);

    // Hardware Setup: Reroute GPS Controls
    furi_hal_gpio_init(&gpio_ext_pc3, GpioModeOutputPushPull, GpioPullNo, GpioSpeedLow); // RESET
    furi_hal_gpio_init(&gpio_ext_pb2, GpioModeOutputPushPull, GpioPullNo, GpioSpeedLow); // STANDBY
    
    // Setup UART (GPS Module on TX:13, RX:14)
    furi_hal_uart_init(FuriHalUartIdUSART1, 9600);
    furi_hal_uart_set_irq_cb(FuriHalUartIdUSART1, uart_callback, app);

    // Setup ADS1115 via I2C: Continuous conversion, ±2.048V, 1600SPS
    // Config = 0x8483: OS=1, MUX=000(AIN0-AIN1), PGA=010(±2.048V),
    //                  MODE=0(continuous), DR=100(1600SPS), COMP_QUE=11(disabled)
    uint8_t config[2] = {0x84, 0x83};
    if(!furi_hal_i2c_write_mem(&furi_hal_i2c_handle_external, ADS1115_ADDR, ADS1115_CONFIG_REG, config, 2, 100)) {
        app->gsr_available = false; // ADS1115 not found — fall back to zeros
    }

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
                        // Open GPX file on start
                        Storage* storage = furi_record_open(RECORD_STORAGE);
                        app->gpx_file = storage_file_alloc(storage);
                        if(storage_file_open(app->gpx_file, EXT_PATH("biomap_walk.gpx"),
                                             FSAM_WRITE, FSOM_CREATE_ALWAYS)) {
                            const char* hdr =
                                "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
                                "<gpx version=\"1.1\" creator=\"FlipperZero BioMapping\">\n"
                                "  <trk>\n"
                                "    <name>Stress &amp; Relaxation Walk</name>\n"
                                "    <trkseg>\n";
                            storage_file_write(app->gpx_file, hdr, strlen(hdr));
                        }
                        furi_record_close(RECORD_STORAGE);
                        app->tick_counter = 0; // Reset buffer on new recording
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

                // --- Parse any fresh NMEA sentence (safe in main loop) ---
                if(app->nmea_ready) {
                    parse_nmea(app);
                    app->nmea_ready = false;
                }

                // --- Read ADS1115 (fall back to 0 if unavailable) ---
                if(app->gsr_available) {
                    uint8_t data[2];
                    if(furi_hal_i2c_read_mem(&furi_hal_i2c_handle_external, ADS1115_ADDR,
                                             ADS1115_CONV_REG, data, 2, 10)) {
                        app->raw_diff = (data[0] << 8) | data[1];
                    } else {
                        app->raw_diff = 0; // I2C glitch — use zero
                    }
                } else {
                    app->raw_diff = 0; // No sensor — always zero
                }

                // Signal Processing: EMA Smoothing + Derivative
                float current_smoothed = (EMA_ALPHA * (float)app->raw_diff) +
                                         ((1.0f - EMA_ALPHA) * app->smoothed_value);
                app->rate_of_change = current_smoothed - app->smoothed_value;
                app->smoothed_value = current_smoothed;
                app->elevation = -(app->rate_of_change) * ELEVATION_SCALE * app->zoom_level;

                // Accumulate raw readings for 1-second average
                app->raw_sum += app->raw_diff;
                app->raw_count++;
                app->tick_counter++;

                // --- 1-Second Buffer: average 10 readings, write to SD ---
                if(app->tick_counter >= 10) {
                    // Compute 1-second average elevation from accumulated readings
                    float avg_elevation = 0.0f;
                    if(app->raw_count > 0) {
                        int16_t avg_raw = app->raw_sum / app->raw_count;
                        float avg_smoothed = (EMA_ALPHA * (float)avg_raw) +
                                             ((1.0f - EMA_ALPHA) * app->smoothed_value);
                        float avg_rate = avg_smoothed - app->smoothed_value;
                        avg_elevation = -(avg_rate) * ELEVATION_SCALE * app->zoom_level;
                    }

                    if(app->recording && app->gpx_file && app->gps_lat[0] != '\0') {
                        // Build a time string from NMEA time if available
                        char time_str[32] = "1970-01-01T00:00:00Z";
                        if(app->gps_time[0] != '\0' && strlen(app->gps_time) >= 6) {
                            // NMEA time is HHMMSS.SS → ISO8601
                            char h[3] = {app->gps_time[0], app->gps_time[1], '\0'};
                            char m[3] = {app->gps_time[2], app->gps_time[3], '\0'};
                            char s[3] = {app->gps_time[4], app->gps_time[5], '\0'};
                            snprintf(time_str, sizeof(time_str),
                                     "2026-06-05T%02s:%02s:%02sZ", h, m, s);
                        }

                        char gpx_string[256];
                        snprintf(gpx_string, sizeof(gpx_string),
                            "      <trkpt lat=\"%s\" lon=\"%s\">\n"
                            "        <ele>%.2f</ele>\n"
                            "        <time>%s</time>\n"
                            "      </trkpt>\n",
                            app->gps_lat, app->gps_lon,
                            (double)avg_elevation, time_str);
                        storage_file_write(app->gpx_file, gpx_string, strlen(gpx_string));
                    }
                    // Reset 1-second buffer
                    app->tick_counter = 0;
                    app->raw_sum = 0;
                    app->raw_count = 0;
                }

                furi_mutex_release(app->mutex);
                view_port_update(view_port); // Refresh screen
            }
        }
    }

    // --- GRACEFUL SHUTDOWN (Runs when user presses 'Back') ---
    furi_timer_stop(timer);
    furi_timer_free(timer);
    furi_hal_uart_set_irq_cb(FuriHalUartIdUSART1, NULL, NULL); // Stop GPS UART

    // Close GPX if still open (user pressed Back while recording)
    if(app->gpx_file) {
        const char* ftr = "    </trkseg>\n  </trk>\n</gpx>\n";
        storage_file_write(app->gpx_file, ftr, strlen(ftr));
        storage_file_close(app->gpx_file);
        storage_file_free(app->gpx_file);
    }

    gui_remove_view_port(gui, view_port);
    view_port_free(view_port);
    furi_record_close(RECORD_GUI);
    
    furi_message_queue_free(app->event_queue);
    furi_mutex_free(app->mutex);
    free(app);
    
    return 0;
}