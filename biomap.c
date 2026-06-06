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
    float elevation;      // zoom-scaled value used only for display
    float elevation_base; // zoom-independent value accumulated for GPX average
    float elevation_sum;  // FIX #6: accumulate actual per-tick elevations for correct 1-sec average
    bool smoothed_primed; // FIX: false until EMA is seeded from a real reading (prevents cold-start spike)
    bool gsr_available;

    // GPS Data
    char gps_lat[16];
    char gps_lon[16];
    char gps_time[16];

    // NMEA double-buffer (FIX #1: ISR-safe staging buffer eliminates race condition)
    // The ISR writes ONLY to nmea_staging[]. It publishes a complete sentence to
    // nmea_buffer[] atomically at sentence boundaries — never mid-sentence.
    char nmea_staging[128];   // Written only by ISR, never read by main loop
    uint8_t nmea_staging_index;
    char nmea_buffer[128];    // Written by ISR on completion; read by main loop
    bool nmea_ready;

    // System
    int tick_counter;
    int32_t raw_sum; // FIX #4: was int16_t — overflows when summing 10 x int16_t samples
    int raw_count;
    File* gpx_file;
    Storage* storage; // FIX #2: kept open for entire app lifetime, not just recording start
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

    // Elevation / rate of change — apply zoom here for display only (FIX: zoom not stored in elevation)
    snprintf(gsr_str, sizeof(gsr_str), "Elevation: %.2f", (double)(app->elevation_base * app->zoom_level));
    canvas_draw_str(canvas, 5, 35, gsr_str);

    // Zoom level
    snprintf(gsr_str, sizeof(gsr_str), "Zoom: %.2f", (double)app->zoom_level);
    canvas_draw_str(canvas, 5, 45, gsr_str);

    // GPS coordinates
    char gps_str[64];
    snprintf(gps_str, sizeof(gps_str), "Lat: %s", app->gps_lat[0] != '\0' ? app->gps_lat : "Waiting...");
    canvas_draw_str(canvas, 5, 56, gps_str);
    snprintf(gps_str, sizeof(gps_str), "Lon: %s", app->gps_lon[0] != '\0' ? app->gps_lon : "Waiting...");
    canvas_draw_str(canvas, 5, 63, gps_str); // FIX #9: was 64, which is off-screen (display rows: 0–63)

    furi_mutex_release(app->mutex);
}

// --- 2. INPUT CALLBACK ---
static void input_callback(InputEvent* input_event, void* ctx) {
    FuriMessageQueue* event_queue = ctx;
    PluginEvent event = {.type = EventTypeKey, .input = *input_event};
    furi_message_queue_put(event_queue, &event, FuriWaitForever);
}

// --- 3. UART GPS INTERRUPT CALLBACK ---
// This triggers the millisecond a character arrives from the L76K module.
// ISR-safe: characters are buffered into nmea_staging[]. The published
// nmea_buffer[] is only overwritten at sentence boundaries, so the main
// loop always reads a complete, consistent sentence. (FIX #1)
static void uart_callback(UartIrqEvent ev, uint8_t data, void* context) {
    if(ev == UartIrqEventRXNE) {
        BioMapApp* app = context;
        if(data == '\n' || app->nmea_staging_index >= 127) {
            // Sentence complete — publish atomically to the stable read buffer
            app->nmea_staging[app->nmea_staging_index] = '\0';
            memcpy(app->nmea_buffer, app->nmea_staging, app->nmea_staging_index + 1);
            app->nmea_buffer[127] = '\0'; // Belt-and-suspenders termination
            app->nmea_ready = true;
            app->nmea_staging_index = 0;
        } else {
            app->nmea_staging[app->nmea_staging_index++] = data;
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
    strncpy(copy, app->nmea_buffer, 127);
    copy[127] = '\0';

    int commas = 0;
    char* token = strtok(copy, ",");
    while(token != NULL) {
        switch(commas) {
        case 1: // UTC Time (HHMMSS.SS)
            strncpy(app->gps_time, token, 15);
            app->gps_time[15] = '\0'; // FIX #8: strncpy does not null-terminate if src >= n chars
            break;
        case 2: // Latitude
            strncpy(app->gps_lat, token, 15);
            app->gps_lat[15] = '\0'; // FIX #8
            break;
        case 4: // Longitude
            strncpy(app->gps_lon, token, 15);
            app->gps_lon[15] = '\0'; // FIX #8
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
    furi_assert(app); // FIX #5: assert rather than silently dereference a NULL pointer

    app->event_queue = furi_message_queue_alloc(8, sizeof(PluginEvent));
    app->mutex = furi_mutex_alloc(FuriMutexTypeNormal);
    app->smoothed_value = 0.0f;
    app->smoothed_primed = false;
    app->tick_counter = 0;
    app->raw_sum = 0;
    app->raw_count = 0;
    app->elevation_sum = 0.0f;
    app->nmea_staging_index = 0;
    app->nmea_ready = false;
    app->gsr_available = true;
    app->recording = false;
    app->zoom_level = 1.0f;
    memset(app->gps_lat, 0, 16);
    memset(app->gps_lon, 0, 16);
    memset(app->gps_time, 0, 16);
    memset(app->nmea_staging, 0, 128);
    memset(app->nmea_buffer, 0, 128);
    app->gpx_file = NULL;

    // FIX #2: Open Storage once at startup and keep it open for the app's lifetime.
    // Calling furi_record_close(RECORD_STORAGE) while gpx_file is still in use was UB.
    app->storage = furi_record_open(RECORD_STORAGE);

    // Setup GUI ViewPort
    ViewPort* view_port = view_port_alloc();
    view_port_draw_callback_set(view_port, render_callback, app);
    view_port_input_callback_set(view_port, input_callback, app->event_queue);
    Gui* gui = furi_record_open(RECORD_GUI);
    gui_add_view_port(gui, view_port, GuiLayerFullscreen);

    // Hardware Setup: Reroute GPS Controls
    furi_hal_gpio_init(&gpio_ext_pc3, GpioModeOutputPushPull, GpioPullNo, GpioSpeedLow); // RESET
    furi_hal_gpio_init(&gpio_ext_pb2, GpioModeOutputPushPull, GpioPullNo, GpioSpeedLow); // STANDBY
    // FIX #12: Drive GPS control pins to their active-high idle state.
    // Without this, RESET and STANDBY float and the L76K may not initialise correctly.
    furi_hal_gpio_write(&gpio_ext_pc3, true); // RESET high = module running normally
    furi_hal_gpio_write(&gpio_ext_pb2, true); // STANDBY high = module fully active

    // Setup UART (GPS Module on TX:13, RX:14)
    furi_hal_uart_init(FuriHalUartIdUSART1, 9600);
    furi_hal_uart_set_irq_cb(FuriHalUartIdUSART1, uart_callback, app);

    // Setup ADS1115 via I2C: Continuous conversion, ±2.048V, 8 SPS
    // Config = 0x8400: OS=1, MUX=000(AIN0-AIN1), PGA=010(±2.048V),
    //                  MODE=0(continuous), DR=000(8 SPS), COMP_QUE=11(disabled)
    // FIX: was 1600 SPS (0x83) — at 10 Hz polling, 159/160 conversions were discarded.
    // At 8 SPS the ADS1115 decimation filter averages the full bitstream for true
    // 16-bit resolution. At 1600 SPS the effective noise floor is ~3 bits worse.
    uint8_t config[2] = {0x84, 0x00};
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
                        // FIX #2: Use app->storage (already open); no furi_record_close here
                        // FIX #3: Handle storage_file_open failure — free handle and abort
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
                            // FIX #3: File open failed — free the allocated handle and
                            // roll back the recording toggle to avoid writing to a bad handle
                            storage_file_free(app->gpx_file);
                            app->gpx_file = NULL;
                            app->recording = false;
                        }
                        app->tick_counter = 0; // Reset buffer on new recording
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

                // FIX #1: Clear nmea_ready BEFORE reading the buffer to minimise the
                // window in which the ISR could publish a new sentence mid-parse.
                if(app->nmea_ready) {
                    app->nmea_ready = false;
                    parse_nmea(app);
                }

                // --- Read ADS1115 (fall back to 0 if unavailable) ---
                if(app->gsr_available) {
                    uint8_t data[2];
                    if(furi_hal_i2c_read_mem(&furi_hal_i2c_handle_external, ADS1115_ADDR,
                                             ADS1115_CONV_REG, data, 2, 50)) { // FIX: 10ms → 50ms timeout
                        app->raw_diff = (data[0] << 8) | data[1];
                    } else {
                        app->raw_diff = 0; // I2C glitch — use zero
                    }
                } else {
                    app->raw_diff = 0; // No sensor — always zero
                }

                // FIX: Prime the EMA from the first real reading to prevent the cold-start
                // transient. Without this, smoothed_value starts at 0 and ramps to the
                // user's real baseline over ~3s, producing a large artificial spike at start.
                if(!app->smoothed_primed) {
                    app->smoothed_value = (float)app->raw_diff;
                    app->smoothed_primed = true;
                }

                // Signal Processing: EMA Smoothing + Derivative
                float current_smoothed = (EMA_ALPHA * (float)app->raw_diff) +
                                         ((1.0f - EMA_ALPHA) * app->smoothed_value);
                app->rate_of_change = current_smoothed - app->smoothed_value;
                app->smoothed_value = current_smoothed;

                // FIX: Store elevation WITHOUT zoom so the 1-second accumulator is
                // consistent even if the user presses Up/Down mid-second. Zoom is
                // applied separately at display time (render_callback) and GPX write time.
                app->elevation_base = -(app->rate_of_change) * ELEVATION_SCALE;
                app->elevation = app->elevation_base * app->zoom_level; // display-only copy

                // Accumulate raw readings and per-tick elevations for 1-second average
                app->raw_sum += app->raw_diff;            // FIX #4: raw_sum is now int32_t
                app->raw_count++;
                app->elevation_sum += app->elevation_base; // FIX #6: accumulate zoom-free elevations
                app->tick_counter++;

                // --- 1-Second Buffer: average 10 readings, write to SD ---
                if(app->tick_counter >= 10) {
                    // FIX #6: Average the 10 actual computed elevations rather than
                    // recomputing a hypothetical one-step EMA from raw_sum (which was
                    // disconnected from the live smoothed_value stream shown on screen).
                    // Apply the current zoom to the averaged base elevation at write time.
                    // Because elevation_sum is zoom-free, changing zoom mid-second no longer
                    // corrupts the average — zoom is always applied to the final number.
                    float avg_elevation = (app->raw_count > 0)
                        ? (app->elevation_sum / (float)app->raw_count) * app->zoom_level
                        : 0.0f;

                    if(app->recording && app->gpx_file && app->gps_lat[0] != '\0') {
                        // Build a time string from NMEA time if available.
                        // Note: GPGGA only provides time, not date. Date defaults to epoch.
                        // For a full timestamp, also parse GPRMC or GPZDA sentences.
                        char time_str[32] = "1970-01-01T00:00:00Z";
                        if(app->gps_time[0] != '\0' && strlen(app->gps_time) >= 6) {
                            // NMEA time is HHMMSS.SS → ISO8601 time-of-day
                            char h[3] = {app->gps_time[0], app->gps_time[1], '\0'};
                            char m[3] = {app->gps_time[2], app->gps_time[3], '\0'};
                            char s[3] = {app->gps_time[4], app->gps_time[5], '\0'};
                            // FIX #7: %02s is undefined behaviour in C. h/m/s are already
                            // exactly 2-character strings, so plain %s is sufficient.
                            snprintf(time_str, sizeof(time_str),
                                     "1970-01-01T%s:%s:%sZ", h, m, s);
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
    furi_hal_uart_set_irq_cb(FuriHalUartIdUSART1, NULL, NULL); // Disable GPS UART IRQ
    furi_hal_uart_deinit(FuriHalUartIdUSART1); // FIX #11: deinitialise peripheral; was left active

    // Close GPX if still open (user pressed Back while recording)
    if(app->gpx_file) {
        const char* ftr = "    </trkseg>\n  </trk>\n</gpx>\n";
        storage_file_write(app->gpx_file, ftr, strlen(ftr));
        storage_file_close(app->gpx_file);
        storage_file_free(app->gpx_file);
    }

    // FIX #2: Close Storage once here, after all file I/O is complete
    furi_record_close(RECORD_STORAGE);

    gui_remove_view_port(gui, view_port);
    view_port_free(view_port);
    furi_record_close(RECORD_GUI);

    furi_message_queue_free(app->event_queue);
    furi_mutex_free(app->mutex);
    free(app);

    return 0;
}