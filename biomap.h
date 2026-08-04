// biomap.h — Bio Mapping app-level declarations and shared includes.
//
// Includes the full Flipper Zero SDK, all module headers, and defines
// BioMapApp with fully typed pointers.  For files that only need sub-structs
// and constants, include biomap_types.h directly.

#pragma once

// ── Core types (DisplayState, GraphState, etc., constants, helpers) ────
#include "biomap_types.h"
// ── Pure math pipeline (platform-independent GSR signal processing) ────
#include "biomap_pipeline.h"

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
#include "modules/sound.h"
#include "modules/util.h"
#include "modules/em_scan_rf.h"
#include "modules/em_scan_cal.h"

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
    ViewPort*      vp;          // == app->screen_vp while a session is active; not owned/freed here
    FuriTimer*     timer;

    Pipeline      pipeline;     // display + graph + zoom (pure math, platform-independent)
    RecordingState recording;

    bool           running;

    // Edge-trigger latch for the GSR-disconnect audio warning: true once
    // biomap_sound_warning() has fired for the CURRENT disconnect episode,
    // so the alert plays once per episode (not once per second alongside
    // the LED blink). Reset to false as soon as the sensor reads connected
    // again. Lives on Session (not DisplayState) because it's a one-shot
    // UI-event latch, not a signal-processing value.
    bool           gsr_alert_sounded;

    // Render cache — avoids snprintf + canvas_string_width every frame
    char           zoom_label[16];
    float          zoom_label_last;
    int            zoom_label_width;

    // Render cache — nS value (top-right corner)
    char           ns_label[16];
    float          ns_label_last;
    int            ns_label_width;
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
    // Single persistent fullscreen ViewPort shared by EVERY screen (menu,
    // options, calibration menu/wizard, recording session). It is added to
    // the GUI stack once at startup and never removed until app exit —
    // screen transitions only toggle enabled/disabled and swap the draw
    // callback. This is required to avoid a frame where zero fullscreen
    // ViewPorts are enabled, which lets the desktop/dolphin layer flash
    // through underneath during the transition.
    ViewPort*          screen_vp;

    bool               backlight_on;   // Options > Backlight — user preference
    // Whether this app currently holds an active
    // sequence_display_backlight_enforce_on claim. NotificationSrv's
    // enforce_auto decrements an internal lock counter and logs "Incorrect
    // BacklightEnforce use" if it's already 0 — enforce_auto must only ever
    // be sent to release a claim THIS app actually made via enforce_on, never
    // unconditionally. Tracked here (not derived from backlight_on) because
    // the two can differ: backlight_on may change between sessions, but this
    // reflects what was actually claimed for the currently-running session.
    // Always go through biomap_backlight_claim()/biomap_backlight_release()
    // below rather than touching this flag directly.
    bool               backlight_enforced;
    bool               sound_enabled;  // Options > Sound; survives session boundaries
    GpsNavModel        nav_model;      // Options > GPS Profile (Pedestrian/Wrist/Vehicle)
    bool               cal_active;
    float              cal_gain;
    float              cal_offset;
    EmScanCal          rf_cal_data;     // RF Faraday calibration (em_scan_cal.h)
    bool               rf_calibrated;
} BioMapApp;

// ── Menu & conversion UI types ─────────────────────────────────────────

#define MENU_COUNT      5
#define OPTIONS_COUNT   8

// Options screen selection indices — matches OPTIONS_COUNT above and the
// item order drawn by options_render() (biomap_render.c). Shared between
// biomap_gui.c (key handling) and biomap_render.c (toggle-state overlay) so
// the two stay in sync by construction rather than by comment.
enum {
    OptGpsProfile = 0,
    OptResetGps,
    OptAutoZoom,
    OptGsrCalibration,
    OptRfCalibration,
    OptBacklight,
    OptSound,
    OptDiagnostics,
};

typedef struct {
    BioMapApp* app;
    int32_t    selection;
} MenuContext;

typedef struct {
    BioMapApp* app;
    int32_t    selection;
} OptionsContext;

// run_cal_submenu()'s (biomap_gui.c) stack-local ctx — same shape/lock
// reasoning as MenuContext/OptionsContext above: `selection` is written by
// the main thread's key-handling loop and read by draw_cal_submenu()
// (biomap_render.c) on the GUI service's own render thread, so it's guarded
// by app->mutex like the other two, rather than a dedicated mutex (unlike
// WizardState/RfCalWizardState, which have no BioMapApp* to reuse). Found
// unguarded — a plain int race — during the 2026-07-31 mutex audit.
typedef struct {
    BioMapApp* app;
    int32_t    selection;
} CalSubmenuContext;

#define BIOMAP_CAL_MAGIC   0x424D4341
#define BIOMAP_CAL_VERSION 2
#define BIOMAP_CAL_PATH    "/ext/biomapping/biomap.cal"
#define BIOMAP_CAL_PATH_TMP "/ext/biomapping/biomap.cal.tmp"
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
// Each gate is independent — a device with gain as low as CAL_GAIN_MIN
// (below) must still pass. Example for 47k at CAL_GAIN_MIN (0.2×):
//   21276.6 × 0.2 ≈ 4255 nS  → lower gate must be ≤ 4255.
//
// CORRECTED 2026-07-30: this comment previously said "0.5× (the
// calibration minimum)" — stale relative to CAL_GAIN_MIN, which has been
// 0.2 since before this comment was last touched (the two had drifted
// apart; CAL_GAIN_MIN is now the single source of truth both use).
// NOTE: CAL_LO_GATE_47K (5000) is still ABOVE the 4255 the corrected
// example above requires, and CAL_MID_GATE_LO (3000, the 100k floor)
// is similarly above its own 0.2×-derived floor (10000 × 0.2 = 2000) —
// neither gate has actually been re-derived for a genuine 0.2×-gain
// device yet. Lowering CAL_MID_GATE_LO in particular isn't a simple
// number change: it doubles as the 470k gate's UPPER bound, and dropping
// it below 470k's own nominal target (2127.66, CAL_TARGET_470K) would
// break ordinary-gain 470k measurement. Left as-is pending a real
// hardware-informed re-tuning rather than a guessed value.
#define CAL_LO_GATE        200.0f
#define CAL_MID_GATE_LO   3000.0f
#define CAL_MID_GATE_HI  25000.0f
#define CAL_LO_GATE_47K   5000.0f
#define CAL_HI_GATE      45000.0f

// Valid-range bounds for a computed or loaded gain/offset — a wizard fit
// (biomap_gui.c's calibration_wizard_compute_fit) or a loaded calibration
// file (biomap_load_calibration below) failing either of these is
// rejected. Previously two separately-written copies of the same four
// literals, one per call site.
#define CAL_GAIN_MIN     0.2f
#define CAL_GAIN_MAX     5.0f
#define CAL_OFFSET_MIN  -20000.0f
#define CAL_OFFSET_MAX   20000.0f

typedef struct {
    uint32_t magic;
    uint32_t version;
    float    gain;
    float    offset;
    uint32_t checksum;
} BioMapCalibration;

// ── Options persistence ─────────────────────────────────────────────────
// Every Options-menu toggle (Auto-zoom, Backlight, Sound, GPS Profile)
// previously only lived in the BioMapApp struct literal's defaults
// (biomap.c) — reset to those hardcoded defaults on every app launch,
// never saved. Same load/save/atomic-rename shape as BioMapCalibration
// above, kept as a separate file/struct rather than folded into it since
// these are independent, unrelated settings with their own versioning
// needs.
//
// rf_scan_enabled removed and version bumped to 2 (2026-07-29): RF is no
// longer a standalone Options toggle — it's now purely a function of which
// main-menu mode is chosen (GPS+GSR+RF / GPS+GSR / GPS+RF / GSR Only), not
// a persisted setting. An old v1 file on disk will simply fail the version
// check in biomap_load_settings() and fall back to defaults, same as any
// other format change.
#define BIOMAP_SETTINGS_MAGIC    0x424D4753
#define BIOMAP_SETTINGS_VERSION  2
#define BIOMAP_SETTINGS_PATH     "/ext/biomapping/biomap.settings"
#define BIOMAP_SETTINGS_PATH_TMP "/ext/biomapping/biomap.settings.tmp"

typedef struct {
    uint32_t magic;
    uint32_t version;
    bool     zoom_enabled;
    bool     backlight_on;
    bool     sound_enabled;
    uint32_t nav_model;
    uint32_t checksum;
} BioMapSettings;

// Calibration wizard state machine.  Steps:
//   0 = prompt 470k    4 = prompt 47k      8 = success
//   1 = measure 470k   5 = measure 47k     9 = measurement fail
//   2 = prompt 100k    6 = compute fit     10 = fit fail (bounds / R²)
//   3 = measure 100k   7 = (unused)
//
// Lives as a stack-local in run_calibration_wizard() (biomap_gui.c), but
// its draw callback (biomap_render.c's calibration_wizard_render()) runs
// on the GUI service's own thread, triggered asynchronously by
// view_port_update() — genuinely cross-thread shared for as long as the
// wizard's ViewPort points at it. `mutex` guards every field below.
// Structurally identical to RfCalWizardState below (same stack-local /
// async-render-callback shape), which got this same mutex after a forensic
// audit found it missing there (2026-07-29) — this struct was missed by
// that audit and had no lock at all until the 2026-07-30 mutex review.
typedef struct {
    FuriMutex* mutex;
    int   step;
    float measured[CAL_POINTS];  // [470k, 100k, 47k]
    float gain;
    float offset;
    float r_squared;              // goodness-of-fit
} WizardState;

// RF Faraday calibration wizard state. Steps:
//   0 = prep countdown (30s, place Flipper in shielding bag)
//   1 = active sampling (20s round-robin CC1101 dwell)
//   2 = stats/result (pass/fail, save decision)
//
// Lives as a stack-local in run_rf_calibration_wizard() (biomap_rf_cal.c),
// but its draw callbacks (biomap_render.c's rf_calibration_wizard_*_render)
// run on the GUI service's own thread, triggered asynchronously by
// view_port_update() — so this struct is genuinely cross-thread shared for
// as long as the wizard's ViewPort callback points at it, unlike most
// other per-screen state structs in this app (which are read-only from the
// GUI thread's perspective, or don't update on a tight loop). `mutex`
// guards every field below during the active-sampling step, where the
// main thread rewrites rssi_dbm[]/seconds_left every ~100ms in a loop —
// found missing during a forensic audit of cross-thread access (2026-07-29)
// alongside biomap_session.c's Session, which already used app->mutex for
// this same reason.
typedef struct {
    FuriMutex* mutex;
    int      step;
    uint32_t seconds_left;                          // countdown display (prep or sampling)
    uint32_t sweep_count;
    float    rssi_dbm[EM_SCAN_NUM_FREQS];            // live per-band reading during sampling
    float    computed_floors[EM_SCAN_NUM_FREQS];
    float    computed_std_devs[EM_SCAN_NUM_FREQS];
    bool     passed;
} RfCalWizardState;

// ── App-level function declarations ────────────────────────────────────

void run_gps_hot_start(BioMapApp* app);
// Claims/releases the backlight enforce_on lock according to
// app->backlight_on, keeping app->backlight_enforced in sync so the pair
// can never go unbalanced (see the field's doc comment above). release()
// is a no-op if no claim is currently held. Pass block=true only where the
// caller is about to tear down NotificationSrv's record right after (app
// shutdown) and needs the message to have gone out first.
void biomap_backlight_claim(BioMapApp* app);
void biomap_backlight_release(BioMapApp* app, bool block);
void run_options_screen(BioMapApp* app);
void run_calibration_menu(BioMapApp* app);
void run_calibration_wizard(BioMapApp* app);
bool biomap_load_calibration(BioMapApp* app);
void biomap_save_calibration(BioMapApp* app, float gain, float offset);
void biomap_reset_calibration(BioMapApp* app);

bool biomap_load_settings(BioMapApp* app);
void biomap_save_settings(BioMapApp* app);

void run_rf_calibration_menu(BioMapApp* app);
void run_rf_calibration_wizard(BioMapApp* app);
bool biomap_load_rf_calibration(BioMapApp* app);
void biomap_save_rf_calibration(BioMapApp* app, const EmScanCal* cal);
void biomap_reset_rf_calibration(BioMapApp* app);

void biomap_input_callback(InputEvent* e, void* ctx);
void biomap_timer_callback(void* ctx);
int32_t biomap_gui_show_menu(BioMapApp* app);

// ── Shared sub-screen helpers (biomap_gui.c) ────────────────────────────
// Reused by biomap_rf_cal.c's RF calibration menu/wizard — see biomap_gui.c
// for the single-persistent-ViewPort rationale.
ViewPort* vp_push(BioMapApp* app, ViewPortDrawCallback draw, void* ctx);
void      vp_pop(BioMapApp* app, ViewPort* vp);
void      drain_stale_events(FuriMessageQueue* q);
int32_t   cycle_selection(int32_t sel, int32_t count, bool down);

// One of a submenu's fixed actions (start wizard / reset / show current) —
// see run_cal_submenu below.
typedef void (*SubmenuAction)(BioMapApp* app);

// Generic "Start Wizard / Reset to Default / Show Current" 3-item submenu
// loop — shared shape behind run_calibration_menu (biomap_gui.c, GSR) and
// run_rf_calibration_menu (biomap_rf_cal.c, RF), which were previously two
// copies of the identical Up/Down/OK/Back loop differing only in which
// three functions and render callback they called.
void run_cal_submenu(BioMapApp* app, ViewPortDrawCallback render,
                      SubmenuAction start_wizard, SubmenuAction reset,
                      SubmenuAction show_current);

// Simple pop-up viewer: pushes `render`, waits for OK or Back to dismiss,
// then pops. Shared by the GSR and RF "Show Current" calibration screens.
void run_simple_viewer(BioMapApp* app, ViewPortDrawCallback render, void* ctx);
