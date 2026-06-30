#pragma once

// Bio Mapping — shared app state, constants, and includes.

#include <furi.h>
#include <furi_hal.h>
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
#define ZOOM_FACTOR      1.5f    // multiplicative step for manual Up/Down zoom
#define ZOOM_MIN         0.25f
#define ZOOM_MAX         16.0f
#define DISPLAY_EMA_A    0.2f
#define DISPLAY_EMA_B    0.8f   // (1.0f - DISPLAY_EMA_A), precomputed

#define GRAPH_N    126

typedef struct BioMapApp {
    BioMapMode         mode;
    GpsUart*           gps;
    GsrSensor*         gsr;
    SdLogger*          logger;
    FuriMessageQueue*  event_queue;
    FuriMutex*         mutex;
    Storage*           storage;
    NotificationApp*   notifications;
    Gui*               gui;
    ViewPort*          menu_vp;

    int32_t  gsr_raw_sum;
    int      raw_count;
    int      tick_counter;

    float    display_smoothed;
    bool     display_primed;
    float    graph_buf[GRAPH_N];
    int      graph_head;

    float    zoom_level;
    float    auto_zoom_peak;
    bool     auto_zoom_enabled;
    bool     backlight_on;
    int      scroll_divider;
    int      graph_tick_counter;
    float    graph_last_smoothed;
    bool     running;
    bool     recording_active;
    char     recording_filename[64];
    int32_t  last_displayed_gsr;
    int      text_refresh_counter;
    volatile int32_t menu_selection;
} BioMapApp;

static inline bool has_gps(BioMapMode m) { return m == BioMapModeGpsGsr || m == BioMapModeGpsOnly; }
static inline bool has_gsr(BioMapMode m) { return m == BioMapModeGpsGsr || m == BioMapModeGsrOnly; }

void format_timestamp(BioMapApp* app, char* buf, size_t sz);
void run_recording_session(BioMapApp* app, BioMapMode mode);
void run_gps_hot_start(BioMapApp* app);
void run_converter(BioMapApp* app);
void run_options_screen(BioMapApp* app);

void biomap_input_callback(InputEvent* e, void* ctx);
void biomap_timer_callback(void* ctx);
void biomap_render_callback(Canvas* c, void* ctx);
void menu_render(Canvas* c, void* ctx);
int32_t biomap_gui_show_menu(BioMapApp* app);
