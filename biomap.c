#include <furi.h>
#include <furi_hal.h>
#include <gui/gui.h>
#include <storage/storage.h>
#include <string.h>
#include <stdio.h>

#define ADS1115_ADDR (0x48 << 1)
#define ADS1115_CONV_REG 0x00
#define ADS1115_CONFIG_REG 0x01

// Math Configuration
const float EMA_ALPHA = 0.2f;
const float ELEVATION_SCALE = 0.5f;

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
    
    // GPS Data
    char gps_lat[16];
    char gps_lon[16];
    char nmea_buffer[128];
    uint8_t nmea_index;
    
    // System
    int tick_counter;
    File* gpx_file;
    FuriMessageQueue* event_queue;
    FuriMutex* mutex;
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
    
    // Debug GSR Values
    char gsr_str[64];
    snprintf(gsr_str, sizeof(gsr_str), "Raw GSR: %d", app->raw_diff);
    canvas_draw_str(canvas, 5, 25, gsr_str);
    
    snprintf(gsr_str, sizeof(gsr_str), "Rate (Ele): %.2f", (double)app->elevation);
    canvas_draw_str(canvas, 5, 35, gsr_str);

    // Debug GPS Values
    char gps_str[64];
    snprintf(gps_str, sizeof(gps_str), "Lat: %s", app->gps_lat[0] != '\0' ? app->gps_lat : "Waiting...");
    canvas_draw_str(canvas, 5, 48, gps_str);
    snprintf(gps_str, sizeof(gps_str), "Lon: %s", app->gps_lon[0] != '\0' ? app->gps_lon : "Waiting...");
    canvas_draw_str(canvas, 5, 58, gps_str);

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
static void uart_callback(UartIrqEvent ev, uint8_t data, void* context) {
    if(ev == UartIrqEventRXNE) {
        BioMapApp* app = context;
        if(data == '\n' || app->nmea_index >= 127) {
            app->nmea_buffer[app->nmea_index] = '\0';
            
            // Extremely basic NMEA Parsing for $GPGGA or $GNGGA
            if(strncmp(app->nmea_buffer, "$GPGGA", 6) == 0 || strncmp(app->nmea_buffer, "$GNGGA", 6) == 0) {
                // Parse commas to find Lat (Field 2) and Lon (Field 4)
                int commas = 0;
                char* token = strtok(app->nmea_buffer, ",");
                while(token != NULL) {
                    if(commas == 2) strncpy(app->gps_lat, token, 15);
                    if(commas == 4) strncpy(app->gps_lon, token, 15);
                    token = strtok(NULL, ",");
                    commas++;
                }
            }
            app->nmea_index = 0; // Reset buffer
        } else {
            app->nmea_buffer[app->nmea_index++] = data;
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
    app->event_queue = furi_message_queue_alloc(8, sizeof(PluginEvent));
    app->mutex = furi_mutex_alloc(FuriMutexTypeNormal);
    app->smoothed_value = 0.0f;
    app->tick_counter = 0;
    app->nmea_index = 0;
    memset(app->gps_lat, 0, 16);
    memset(app->gps_lon, 0, 16);

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

    // Setup ADS1115 via I2C
    uint8_t config[2] = {0x83, 0x83}; // Differential AIN0-AIN1, ±2.048V
    furi_hal_i2c_write_mem(&furi_hal_i2c_handle_external, ADS1115_ADDR, ADS1115_CONFIG_REG, config, 2, 100);

    // Setup SD Card
    Storage* storage = furi_record_open(RECORD_STORAGE);
    app->gpx_file = storage_file_alloc(storage);
    storage_file_open(app->gpx_file, EXT_PATH("biomap_walk.gpx"), FSAM_WRITE, FSOM_CREATE_ALWAYS);
    const char* header = "<?xml version=\"1.0\"?>\n<gpx version=\"1.1\">\n<trk>\n<trkseg>\n";
    storage_file_write(app->gpx_file, header, strlen(header));

    // Start 10Hz Timer
    FuriTimer* timer = furi_timer_alloc(timer_callback, FuriTimerTypePeriodic, app->event_queue);
    furi_timer_start(timer, furi_kernel_get_tick_frequency() / 10);

    // --- THE MAIN EVENT LOOP ---
    PluginEvent event;
    bool running = true;
    while(running) {
        // Wait for an event (Tick, Button, etc)
        if(furi_message_queue_get(app->event_queue, &event, FuriWaitForever) == FuriStatusOk) {
            
            // Handle Button Presses
            if(event.type == EventTypeKey) {
                if(event.input.type == InputTypeShort && event.input.key == InputKeyBack) {
                    running = false; // Exit app on 'Back' press
                }
            }
            
            // Handle 10Hz Tick (Read GSR & Write SD)
            if(event.type == EventTypeTick) {
                furi_mutex_acquire(app->mutex, FuriWaitForever);
                
                // Read ADS1115
                uint8_t data[2];
                if(furi_hal_i2c_read_mem(&furi_hal_i2c_handle_external, ADS1115_ADDR, ADS1115_CONV_REG, data, 2, 10)) {
                    app->raw_diff = (data[0] << 8) | data[1];
                    
                    // Signal Processing Math
                    float current_smoothed = (EMA_ALPHA * (float)app->raw_diff) + ((1.0f - EMA_ALPHA) * app->smoothed_value);
                    app->rate_of_change = current_smoothed - app->smoothed_value;
                    app->smoothed_value = current_smoothed;
                    app->elevation = -(app->rate_of_change) * ELEVATION_SCALE;
                }

                // 1-Second SD Card Buffer Logic
                app->tick_counter++;
                if(app->tick_counter >= 10 && app->gps_lat[0] != '\0') {
                    char gpx_string[128];
                    snprintf(gpx_string, sizeof(gpx_string), 
                        "<trkpt lat=\"%s\" lon=\"%s\">\n  <ele>%.2f</ele>\n</trkpt>\n", 
                        app->gps_lat, app->gps_lon, (double)app->elevation);
                    storage_file_write(app->gpx_file, gpx_string, strlen(gpx_string));
                    app->tick_counter = 0;
                }
                
                furi_mutex_release(app->mutex);
                view_port_update(view_port); // Tell GUI to refresh screen
            }
        }
    }

    // --- GRACEFUL SHUTDOWN (Runs when user presses 'Back') ---
    furi_timer_stop(timer);
    furi_timer_free(timer);
    furi_hal_uart_set_irq_cb(FuriHalUartIdUSART1, NULL, NULL); // Stop GPS UART

    const char* footer = "</trkseg>\n</trk>\n</gpx>";
    storage_file_write(app->gpx_file, footer, strlen(footer));
    storage_file_close(app->gpx_file);
    storage_file_free(app->gpx_file);
    furi_record_close(RECORD_STORAGE);

    gui_remove_view_port(gui, view_port);
    view_port_free(view_port);
    furi_record_close(RECORD_GUI);
    
    furi_message_queue_free(app->event_queue);
    furi_mutex_free(app->mutex);
    free(app);
    
    return 0;
}