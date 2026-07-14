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
#include "modules/util.h"

// ── Session — per-recording-session state ──────────────────────────────
//
// Owns all module pointers (GPS, GSR, logger), pipeline state, ViewPort,
// timer, and render cache.  Initialised by session_init() and torn down
// by session_deinit() — these are the ONLY places fields are reset.
// Lives inside BioMapApp; valid only while a recording session is active.

typedef struct Session {
    BioMapMode     mode;
    GpsUart*       gps;
    GsrSensor*     gsr;
    SdLogger*      logger;
    ViewPort*      vp;
    FuriTimer*     timer;

    DisplayState   display;
    GraphState     graph;
    ZoomState      zoom;          // .level + .peak reset per session; .enabled from app
    RecordingState recording;

    bool           running;

    // Render cache — avoids snprintf + canvas_string_width every frame
    char           zoom_label[16];
    float          zoom_label_last;
    int            zoom_label_width;
} Session;

// ── BioMapApp — shared application state (fully typed) ─────────────────

typedef struct BioMapApp {
    Session            session;        // per-session state (init/deinit managed)
    bool               zoom_enabled;   // survives session boundaries (toggled in Options)

    FuriMessageQueue*  event_queue;
    FuriMutex*         mutex;
    Storage*           storage;
    NotificationApp*   notifications;
    Gui*               gui;
    ViewPort*          menu_vp;

    bool               backlight_on;
    bool               cal_active;
    float              cal_gain;
    float              cal_offset;
} BioMapApp;

// ── Menu & conversion UI types ─────────────────────────────────────────

#define MENU_COUNT      4
#define OPTIONS_COUNT   4

typedef struct {
    BioMapApp* app;
    int32_t    selection;
} MenuContext;

typedef struct {
    BioMapApp* app;
    int32_t    selection;
} OptionsContext;

#define BIOMAP_CAL_MAGIC   0x424D4341
#define BIOMAP_CAL_VERSION 2
#define BIOMAP_CAL_PATH    "/ext/biomapping/biomap.cal"
#define CAL_POINTS         3

// Calibration targets — true physical skin conductance (nanosiemens).
// These are 1/R for each calibration resistor: 1e9 / R_ohms.
// Derived from the TIA circuit equation (see gsr_sensor.c):
//   nS = norm × 5 000 000 / (15 040 000 − 47 × norm)
// where norm is the ideal normalised ADC count for resistor R.
#define CAL_TARGET_470K  2127.66f   // 1e9 / 470000
#define CAL_TARGET_100K  10000.0f   // 1e9 / 100000
#define CAL_TARGET_47K   21276.6f   // 1e9 / 47000

// Valid-range gates for each resistor during calibration (nS).
// Brackets the expected true-nS reading with ±50 % margin for
// device-to-device variation.
#define CAL_LO_GATE        500.0f
#define CAL_MID_GATE_LO   4000.0f
#define CAL_MID_GATE_HI  18000.0f
#define CAL_HI_GATE      40000.0f

typedef struct {
    uint32_t magic;
    uint32_t version;
    float    gain;
    float    offset;
    uint32_t checksum;
} BioMapCalibration;

// Calibration wizard state machine.  Steps:
//   0 = prompt 470k    4 = prompt 47k      8 = success
//   1 = measure 470k   5 = measure 47k     9 = fail / retry
//   2 = prompt 100k    6 = compute fit
//   3 = measure 100k   7 = (unused)
typedef struct {
    int   step;
    float measured[CAL_POINTS];  // [470k, 100k, 47k]
    float gain;
    float offset;
    float r_squared;              // goodness-of-fit
} WizardState;

// ── App-level function declarations ────────────────────────────────────

void run_gps_hot_start(BioMapApp* app);
void run_options_screen(BioMapApp* app);
void run_calibration_menu(BioMapApp* app);
void run_calibration_wizard(BioMapApp* app);
bool biomap_load_calibration(BioMapApp* app);
void biomap_save_calibration(BioMapApp* app, float gain, float offset);
void biomap_reset_calibration(BioMapApp* app);

void biomap_input_callback(InputEvent* e, void* ctx);
void biomap_timer_callback(void* ctx);
int32_t biomap_gui_show_menu(BioMapApp* app);
