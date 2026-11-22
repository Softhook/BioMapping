// biomap.h — Bio Mapping app-level declarations and shared includes.
//
// Includes the full Flipper Zero SDK, all module headers, and defines
// BioMapApp with fully typed pointers.  For files that only need sub-structs
// and constants, include biomap_types.h directly.

#pragma once

// ── Core types (DisplayState, GraphState, etc., constants, helpers) ────
#include "core/biomap_types.h"
// ── Pure math pipeline (platform-independent GSR signal processing) ────
#include "core/biomap_pipeline.h"
// ── Host-testable CSV row formatter + pure numeric helpers ────────────
#include "core/biomap_format.h"

// ── Event types shared between biomap.c and flipper/gps_uart_flipper.c ─────────
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
#include "core/biomap_session.h"
#include "core/cal_wizard.h"
#include "flipper/biomap_session_flipper.h"
#include "core/biomap_screen.h"
#include "flipper/biomap_screen_flipper.h"
#include "biomap_render.h"
#include "flipper/gps_uart_flipper.h"
#include "flipper/gsr_sensor_flipper.h"
#include "flipper/sd_logger_flipper.h"
#include "flipper/biomap_cues_flipper.h"
#include "modules/em_scan_rf.h"
#include "modules/em_scan_sampler.h"
#include "modules/em_scan_cal.h"
#include "modules/bt_stream.h"

// ── Session — the recording screen's state ─────────────────────────────
//
// `core` is the shared session (core/biomap_session.h): mode, the GPS and
// GSR modules, the display pipeline and the recording state. The rest is
// the Flipper's own: the radio, file and Bluetooth modules, the screen and
// timer, and the screen's text cache. Reset at the start of each session
// by flipper/biomap_session_flipper.c; valid only while a session runs.

typedef struct Session {
    SessionCore    core;
    // Radio-scan modes only (has_rf()) — NULL otherwise. Runs on the GSR
    // sensor's worker thread via its worker hook, so it is freed after it.
    EmScanSampler* em;
    // NULL in Live Stream, which has no file.
    SdLogger*      logger;
    // Live Stream only — NULL in every other mode.
    BtStream*      bt_stream;
    ViewPort*      vp;          // == app->screen_vp while a session is active; not owned/freed here
    FuriTimer*     timer;

    // The recording screen's text kept between frames (core/biomap_screen.h)
    ScreenCache    screen;
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
    bool               super_s;        // Options > Super-S: true = AUTO (module default), false = OFF
    bool               cal_active;
    float              cal_gain;
    float              cal_zero_counts; // open-circuit zero, normalised counts (BioMapCalibration::zero_counts)
    // Unix epoch (RTC) at which the active GSR calibration was saved; 0 when
    // none is active, or when the RTC was unset at save time. Loaded from
    // BioMapCalibration::timestamp, surfaced by show_current_calibration_render().
    uint32_t           cal_timestamp;
    // Least-squares fit R² from the calibration wizard that produced the
    // active custom cal; 0 when none is active. Loaded from
    // BioMapCalibration::r_squared, surfaced by show_current_calibration_render().
    float              cal_r_squared;
    // Per-resistor σ (nS) from the wizard's pre-flight noise/resolution
    // check (see CalNoiseGrade, biomap_format.h); all-zero when no custom
    // cal is active. Loaded from BioMapCalibration::noise_std_dev, graded
    // and surfaced by show_current_calibration_render() via
    // calibration_noise_grade().
    float              cal_noise_std_dev[CAL_POINTS];
    EmScanCal          rf_cal_data;     // RF Faraday calibration (em_scan_cal.h)
    bool               rf_calibrated;
    // Options > Debug Fields — runtime, persisted toggle for the diagnostic
    // CSV columns and RowDiag instrumentation (always compiled in; this only
    // decides whether a given session's CSV includes them). Off by default
    // (see biomap_app()'s defaults). Snapshotted into
    // SessionSettings::debug_fields_enabled when a session starts, same lifecycle as
    // zoom_enabled.
    bool               debug_fields_enabled;
} BioMapApp;

// ── Menu & conversion UI types ─────────────────────────────────────────

#define MENU_COUNT      6
#define OPTIONS_COUNT   10

// Menu screen selection indices — matches MENU_COUNT above and the
// item order drawn by menu_render() (biomap_render.c).
enum {
    MenuGpsGsrRf = 0,
    MenuGpsGsr,
    MenuGpsOnly,
    MenuGsrOnly,
    MenuLiveStream,
    MenuOptions,
};

// Options screen selection indices — matches OPTIONS_COUNT above and the
// item order drawn by options_render() (biomap_render.c). Shared between
// biomap_gui.c (key handling) and biomap_render.c (toggle-state overlay) so
// the two stay in sync by construction rather than by comment.
enum {
    OptGpsProfile = 0,
    OptSuperS,
    OptColdResetGps,
    OptAutoZoom,
    OptGsrCalibration,
    OptRfCalibration,
    OptBacklight,
    OptSound,
    OptDiagnostics,
    OptDebugFields,
};

// A list screen's selection (the main menu, Options, a calibration
// submenu). Written by the screen's key loop (biomap_gui.c) on the main
// thread and read by its draw callback (biomap_render.c) on the GUI
// service's own thread, so both sides take app->mutex.
typedef struct {
    BioMapApp* app;
    int32_t    selection;
} ListContext;

// BioMapCalibration (the record format), BIOMAP_CAL_MAGIC/VERSION and the
// validity check live in biomap_format.h; biomap.c owns the file I/O.
#define BIOMAP_CAL_PATH    "/ext/biomapping/biomap.cal"
#define BIOMAP_CAL_PATH_TMP "/ext/biomapping/biomap.cal.tmp"

// CAL_POINTS, CAL_TARGET_*, CAL_*_GATE, CAL_GAIN_*, CAL_ZERO_MAX_COUNTS,
// CAL_DWELL_SECONDS, CAL_MIN_VALID, CAL_*_FLUSH_TICKS and CAL_NOISE_*_NS
// live in core/biomap_config.h, the WizardStep* enum in core/cal_wizard.h,
// so both devices share one source of truth.

// ── Options persistence ─────────────────────────────────────────────────
// BioMapSettings (the record format) and its validity check live in
// biomap_format.h; biomap.c owns the file I/O.
#define BIOMAP_SETTINGS_PATH     "/ext/biomapping/biomap.settings"
#define BIOMAP_SETTINGS_PATH_TMP "/ext/biomapping/biomap.settings.tmp"

// Calibration wizard state: the shared state machine (CalWizardCore and
// its step numbers, core/cal_wizard.h) plus the mutex below.
//
// Lives as a stack-local in run_calibration_wizard() (biomap_gui.c), but
// its draw callback (biomap_render.c's calibration_wizard_render()) runs
// on the GUI service's own thread, triggered asynchronously by
// view_port_update() — genuinely cross-thread shared for as long as the
// wizard's ViewPort points at it. `mutex` guards `core`, including
// seconds_left, which the 20 s dwell rewrites roughly once per second while
// a Measuring step is showing. run_calibration_wizard() ticks a copy and
// takes the lock only to publish it, so the render never waits on a GSR
// read or the bias check.
typedef struct {
    FuriMutex*    mutex;
    CalWizardCore core;
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
// guards every field below during the active-sampling step, where the main
// thread rewrites rssi_dbm[]/seconds_left every ~100 ms in a loop.
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

// Current wall-clock time as Unix epoch seconds, or 0 if the RTC is unset
// (pipeline_unix_epoch()'s year<2020 sentinel). The 0 sentinel is deliberate:
// callers writing it into a file (CSV RecordingStartTime header, integrity
// trailer end_time, RF/GSR calibration timestamp) rely on the reader/logger
// omitting the token rather than recording a misleading 1970 date.
uint32_t biomap_rtc_now_epoch(void);

void run_gps_cold_start(BioMapApp* app);
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
void biomap_save_calibration(BioMapApp* app, float gain, float zero_counts, float r_squared,
                             const float noise_std_dev[CAL_POINTS]);
void biomap_reset_calibration(BioMapApp* app);

bool biomap_load_settings(BioMapApp* app);
void biomap_save_settings(BioMapApp* app);

void run_rf_calibration_menu(BioMapApp* app);
void run_rf_calibration_wizard(BioMapApp* app);
bool biomap_load_rf_calibration(BioMapApp* app);
void biomap_save_rf_calibration(BioMapApp* app, const EmScanCal* cal);
void biomap_reset_rf_calibration(BioMapApp* app);

// A cue (core/biomap_cues.h) with the app's own Options > Sound setting.
static inline void biomap_app_cue(BioMapApp* app, BioMapCue cue) {
    biomap_cue(app->notifications, app->sound_enabled, cue);
}

void biomap_input_callback(InputEvent* e, void* ctx);
void biomap_timer_callback(void* ctx);
int32_t biomap_gui_show_menu(BioMapApp* app);

// ── Shared sub-screen helpers (biomap_gui.c) ────────────────────────────
// Reused by biomap_rf_cal.c's RF calibration menu/wizard — see biomap_gui.c
// for the single-persistent-ViewPort rationale.
ViewPort* vp_push(BioMapApp* app, ViewPortDrawCallback draw, void* ctx);
void      vp_pop(BioMapApp* app, ViewPort* vp);
void      drain_stale_events(FuriMessageQueue* q);
// cycle_selection() is declared in biomap_format.h (SDK-free, host-tested).

// One of a submenu's fixed actions (start wizard / reset / show current) —
// see run_cal_submenu below.
typedef void (*SubmenuAction)(BioMapApp* app);

// Generic "Start Wizard / Reset to Default / Show Current" 3-item submenu
// loop behind run_calibration_menu (biomap_gui.c, GSR) and
// run_rf_calibration_menu (biomap_rf_cal.c, RF).
void run_cal_submenu(BioMapApp* app, ViewPortDrawCallback render,
                      SubmenuAction start_wizard, SubmenuAction reset,
                      SubmenuAction show_current);

// Simple pop-up viewer: pushes `render`, waits for OK or Back to dismiss,
// then pops. Shared by the GSR and RF "Show Current" calibration screens.
void run_simple_viewer(BioMapApp* app, ViewPortDrawCallback render, void* ctx);
