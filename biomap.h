// biomap.h — Bio Mapping app-level declarations and shared includes.
//
// Includes the full Flipper Zero SDK, all module headers, and defines
// BioMapApp with fully typed pointers.  For files that only need sub-structs
// and constants, include biomap_types.h directly.

#pragma once

// ── Core types (DisplayState, GraphState, etc., constants, helpers) ────
#include "biomap_types.h"

// ── Event types shared between biomap.c and modules/gps_uart.c ─────────
#include "biomap_events.h"

// ── Flipper Zero SDK ───────────────────────────────────────────────────
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

// ── Module headers ─────────────────────────────────────────────────────
#include "biomap_session.h"
#include "biomap_render.h"
#include "modules/gps_uart.h"
#include "modules/gsr_sensor.h"
#include "modules/sd_logger.h"
#include "modules/gpx_converter.h"

// ── BioMapApp — shared application state (fully typed) ─────────────────

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

    DisplayState       display;
    GraphState         graph;
    ZoomState          zoom;
    RecordingState     recording;

    // Render cache — avoids snprintf + canvas_string_width every frame
    char               zoom_label[16];
    float              zoom_label_last;
    int                zoom_label_width;

    bool               running;
    bool               backlight_on;
} BioMapApp;

// ── Menu & conversion UI types ─────────────────────────────────────────

#define MENU_COUNT      5
#define OPTIONS_COUNT   3

typedef struct {
    bool conv_ok;
    char conv_name[32];
    int  conv_points;
} ConvResult;

// Progress screen context — bundles the immutable conversion result info
// with a mutable spinner frame that the GPX converter advances.
typedef struct {
    ConvResult result;
    int        spinner_frame;   // 0-3, advanced by gpx_converter_run, read by render
} ConvProgressCtx;

typedef struct {
    BioMapApp* app;
    int32_t    selection;
} MenuContext;

typedef struct {
    BioMapApp* app;
    int32_t    selection;
} OptionsContext;

// ── App-level function declarations ────────────────────────────────────

void format_timestamp(BioMapApp* app, char* buf, size_t sz);
void run_gps_hot_start(BioMapApp* app);
void run_converter(BioMapApp* app);
void run_options_screen(BioMapApp* app);

void biomap_input_callback(InputEvent* e, void* ctx);
void biomap_timer_callback(void* ctx);
int32_t biomap_gui_show_menu(BioMapApp* app);
