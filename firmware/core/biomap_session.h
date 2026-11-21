#pragma once

// Session — one recording screen, from entering a mode to pressing Back.
// Shared by every device; plain C with no device code.
//
// What lives here: starting and stopping a recording (the file header, the
// bias check, the start and stop sounds), what each 10 Hz tick does
// (updating the GSR display and graph, building the CSV row, the Live
// Stream packet), what each second does (the heartbeat light, the SD flush
// and what happens when it fails), and what the keys do.
//
// What the device does: its own event loop. It allocates the GPS and GSR
// modules and puts them in `gps`/`gsr` below, then calls session_core_key()
// for each key press and session_core_tick() ten times a second, redrawing
// the screen when either says so. It hands everything else (the lock, the
// clock, the file, cues, the radio, Bluetooth) over in a SessionPlatform.
// The Flipper's loop is in flipper/biomap_session_flipper.c.
//
// ── Threads and the lock ────────────────────────────────────────────────
// Every function here is called from the device's main thread only. The
// device's screen code may read the session from another thread (on the
// Flipper it does), so the session takes the device's main lock
// (SessionPlatform.lock) around every change to this struct, and the
// screen must take the same lock to read it. Slow work — file writes, a
// sound, the Bluetooth send, log lines — is always done with the lock
// released, so the screen never waits long.
//
// ── Sound rules (core/biomap_cues.h) ────────────────────────────────────
// Every cue the session sends goes through one function that checks two of
// those rules: a cue with a sound sent with the lock held stops the app
// (rule 2 — a programming error), and a cue with a sound during a
// recording is left out (rule 3 — this is how key clicks are muted while
// recording).

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "biomap_config.h"
#include "biomap_cues.h"
#include "biomap_format.h"
#include "biomap_pipeline.h"
#include "biomap_types.h"
#include "gps_uart.h"
#include "gsr_sensor.h"

#ifdef __cplusplus
extern "C" {
#endif

// The keys a session reacts to (short presses only).
typedef enum {
    SessionKeyOk,     // start or stop a recording
    SessionKeyBack,   // stop any recording and leave the screen
    SessionKeyUp,     // graph: zoom in vertically
    SessionKeyDown,   // graph: zoom out vertically
    SessionKeyLeft,   // graph: show a longer stretch of time
    SessionKeyRight,  // graph: show a shorter stretch of time
} SessionKey;

typedef enum {
    SessionLogInfo,
    SessionLogWarning,
    SessionLogError,
} SessionLogLevel;

typedef struct {
    uint16_t year;  // 4 digits; below 2020 means the clock isn't set
    uint8_t  month, day, hour, minute, second;
} SessionDateTime;

typedef struct SessionCore SessionCore;

// ── What each device supplies ───────────────────────────────────────────
// Every function gets `ctx` back as its first argument. "Optional" ones
// may be NULL.
typedef struct {
    void* ctx;

    // The device's main lock, which its screen code also takes. Not
    // recursive.
    void (*lock)(void* ctx);
    void (*unlock)(void* ctx);
    // A millisecond clock that counts up and wraps at 2^32.
    uint32_t (*now_ms)(void* ctx);
    // Wait at least `ms`. Used only for the settle time after the
    // recording-start sound.
    void (*delay_ms)(void* ctx, uint32_t ms);
    // Show or play a cue, obeying the Options > Sound setting.
    void (*cue)(void* ctx, BioMapCue cue);
    // Optional: one log line.
    void (*log)(void* ctx, SessionLogLevel level, const char* line);

    // Real time, for the file name and header. epoch_now() is Unix seconds,
    // or 0 if the clock isn't set.
    void     (*datetime_now)(void* ctx, SessionDateTime* out);
    uint32_t (*epoch_now)(void* ctx);

    // The recording file. Required in modes that record (every mode but
    // Live Stream and Diagnostics). file_append() adds one whole row to the
    // device's write buffer, or adds nothing and returns false when the
    // buffer is full. file_flush() writes the buffer to the card: < 0 on
    // failure, and then the buffer is kept for the next try. With `all`
    // false (the flush every FLUSH_INTERVAL seconds) a device that writes
    // whole blocks may keep back less than one block for next time; with
    // `all` true (the final write before a stop) it writes everything, so
    // a result >= 0 means nothing is left in the buffer.
    bool (*file_start)(void* ctx, const char* header, const char* stamp);
    void (*file_stop)(void* ctx, uint32_t end_epoch);
    bool (*file_append)(void* ctx, const char* row, size_t len);
    int  (*file_flush)(void* ctx, bool all);

    // The latest radio reading, one per band (RF_BAND_COUNT). Called with
    // the lock held, so it must be quick. Required in the radio modes that
    // record (has_rf(): GPS + GSR + RF and GPS Only), because their file
    // header always lists the radio columns. NULL is allowed only on a
    // device that doesn't offer those modes.
    void (*rf_snapshot)(void* ctx, float out_dbm[RF_BAND_COUNT]);

    // Optional, only used with debug fields on. fill_diag() adds the
    // device's own figures (radio, SD buffer) to a row's RowDiag; called
    // with the lock held. second_diag() runs once a second with the lock
    // released, for the device's own log lines (memory, stack, Bluetooth).
    void (*fill_diag)(void* ctx, RowDiag* diag);
    void (*second_diag)(void* ctx, const SessionCore* s);

    // Live Stream only. live_connected(): is a phone connected now?
    // live_send(): send one packet; called with the lock released.
    bool (*live_connected)(void* ctx);
    void (*live_send)(void* ctx, const uint8_t* packet, size_t len);
} SessionPlatform;

// Fixed for the whole session: the settings and calibration the device
// read when the session started (they can only change in Options, outside
// a session).
typedef struct {
    bool  sound_enabled;          // Options > Sound (decides the settle wait)
    bool  zoom_enabled;           // Options > Auto Zoom
    bool  debug_fields_enabled;   // Options > Debug Fields
    const char* device_name;      // for the "# DeviceName" header line; may be NULL

    bool  rf_calibrated;
    float rf_floors_dbm[RF_BAND_COUNT];

    bool     cal_active;
    float    cal_gain;
    float    cal_zero_counts;
    float    cal_r_squared;
    float    cal_noise_std_dev[CAL_POINTS];
    uint32_t cal_timestamp;
} SessionSettings;

// The session. The screen (core/biomap_screen.c) reads `mode`, `gps`,
// `gsr`, `pipeline` and `recording` (under the lock), and `settings` (the
// radio floors, the calibration flag), which are fixed for the session.
// Only this file's functions change them.
struct SessionCore {
    BioMapMode mode;
    // Set by the device after session_core_init(), NULL when the mode
    // doesn't use them (session_mode_needs_gps()/_gsr()). The device frees
    // them when the session ends.
    GpsUart*   gps;
    GsrSensor* gsr;

    Pipeline       pipeline;   // display + graph + zoom
    RecordingState recording;
    // False once Back has been pressed: the device leaves its loop.
    bool running;

    SessionSettings settings;
    SessionPlatform platform;

    // Live Stream: set once the bias check on the first phone connect has
    // finished (or been given up on), so a reconnect doesn't repeat it;
    // live_bias_tries counts the ticks spent trying.
    bool    live_bias_checked;
    uint8_t live_bias_tries;

    // True while the session holds the device lock (rule 2 check).
    bool locked;
};

// Which modules a mode needs. Live Stream is not in has_gps()/has_gsr()
// (those also choose the CSV layout) but still reads both; the radio modes
// need a GSR sensor even without GSR, because the radio scan runs on the
// GSR thread.
static inline bool session_mode_needs_gps(BioMapMode mode) {
    return has_gps(mode) || mode == BioMapModeLiveStream;
}
static inline bool session_mode_needs_gsr(BioMapMode mode) {
    return has_gsr(mode) || has_rf(mode) || mode == BioMapModeLiveStream;
}
// Live Stream sends to a phone instead, and Diagnostics is a read-only
// screen: neither records to a file.
static inline bool session_mode_records(BioMapMode mode) {
    return mode != BioMapModeLiveStream && mode != BioMapModeDiagnostics;
}

// Resets every field. `platform` and `settings` are copied. Stops
// (core_fatal) if `platform` lacks a function the mode needs. Every field
// is set here; a new field must be too.
void session_core_init(SessionCore* s, BioMapMode mode, const SessionPlatform* platform,
                       const SessionSettings* settings);

// One short key press. Returns true when the screen should be redrawn.
bool session_core_key(SessionCore* s, SessionKey key);

// One 10 Hz tick. Returns true when the screen should be redrawn (every
// fifth tick, 2 Hz).
bool session_core_tick(SessionCore* s);

// The session is ending some other way than Back (the device's last-resort
// clean-up). Closes a recording that is still active, warning if its last
// seconds were lost. Does nothing otherwise.
void session_core_end(SessionCore* s);

// Sends a cue, checking sound rules 2 and 3 (see the top of this file).
// For the device's own cues during a session too.
void session_core_cue(SessionCore* s, BioMapCue cue);

// The settle time after the recording-start sound: the GSR ring buffer
// (SENSOR_BUFFER_SIZE, about 128 ms of readings) must refill with readings
// taken after the sound ended. The start sound itself lasts about 168 ms,
// longer than the buffer, so by its end every reading in the buffer was
// taken while the speaker was driven. 200 ms is the 128 ms needed plus
// room for the GSR thread's timing jitter.
#define GSR_TONE_SETTLE_MS 200

// Live Stream: how many ticks after a phone connects the bias check is
// tried, if it times out or the sensor isn't answering. Keeps any retry in
// the first few hundred ms of the stream.
#define LIVE_BIAS_MAX_TRIES 3

// ── Shared 4-step GSR calibration wizard state machine ────────────────
// Drives the open-circuit zero step (step 13 → 14) followed by the 470k,
// 100k, and 47k resistor steps (steps 0 → 5), computing the origin-locked
// least-squares gain fit and grading per-resistor noise σ.
//
// Runs at 10 Hz (TICK_HZ): each device calls cal_wizard_tick() once every
// 100 ms while cal_wizard_measuring() is true (either from a blocking loop
// on the Flipper or from the non-blocking main loop on the Cardputer), and
// calls cal_wizard_key() on OK or Back.

typedef enum {
    CalDwellPhaseIdle = 0,
    CalDwellPhaseFlushBefore,
    CalDwellPhaseBiasCheck,
    CalDwellPhaseFlushAfterBias,
    CalDwellPhaseSampling,
} CalDwellPhase;

typedef enum {
    CalKeyOutcomeNone = 0,       // key ignored
    CalKeyOutcomeStepChanged,    // moved to a new step or started measuring (*out_cue set)
    CalKeyOutcomeSaveAndExit,    // OK on WizardStepSuccess: save gain/zero/r2/noise and close (*out_cue set)
    CalKeyOutcomeCancelAndExit,  // Back: cancel and close (*out_cue set)
} CalKeyOutcome;

typedef struct {
    GsrSensor*    gsr;
    bool          sensor_ok;
    int           step;                        // WizardStep* (biomap_config.h)
    float         measured[CAL_POINTS];        // [470k, 100k, 47k], nS
    float         noise_std_dev[CAL_POINTS];   // per-resistor σ from the dwell, nS
    int           fail_idx;                    // resistor index behind step 9/11/12's fail screen
    float         bias_measured_v;             // last bias check, V (NAN = failed) — step 12's fail screen
    uint32_t      seconds_left;                // live dwell countdown during Measuring steps
    float         zero_counts;                 // open-circuit reading, normalised counts (step 14)
    float         zero_noise_ns;               // σ of the zero dwell, as nS near zero — step 15's fail screen
    float         gain;
    float         r_squared;

    // 10 Hz dwell state machine (active while phase != CalDwellPhaseIdle)
    CalDwellPhase phase;
    bool          zero_step;
    int           resistor_idx;
    uint32_t      phase_ticks;
    uint32_t      phase_target;
    CalDwell      dwell;
    float         first_raw;
    float         live_reading;
    BioMapCue     fit_cue;                     // post-confirm fit cue on final step (BioMapCueSuccess/Error, else BioMapCueCount)
} CalWizardCore;

// Initialise the wizard at WizardStepPromptZero. `gsr` may be NULL if the
// sensor could not be opened (`sensor_ok` is set from gsr_sensor_available).
void cal_wizard_init(CalWizardCore* w, GsrSensor* gsr);

// True while a measurement dwell (flush, bias check, or 20 s sampling) is
// actively running and needs 10 Hz cal_wizard_tick() calls.
static inline bool cal_wizard_measuring(const CalWizardCore* w) {
    return w->phase != CalDwellPhaseIdle;
}

// Handle OK (`is_ok == true`) or Back (`is_ok == false`). When the return
// value is not CalKeyOutcomeNone, `*out_cue` receives the feedback cue the
// caller should play (for example BioMapCueClick when a prompt is accepted,
// BioMapCueConfirm on save, BioMapCueBack on cancel). If the prompt started
// a measurement step with `!w->sensor_ok`, `cal_wizard_check_sensor()`
// below immediately transitions to WizardStepMeasureFailed with
// BioMapCueError so the caller plays the click first, updates the screen,
// and then plays the error sound.
CalKeyOutcome cal_wizard_key(CalWizardCore* w, bool is_ok, BioMapCue* out_cue);

// Call right after cal_wizard_key() (once its click has played): if a
// Measuring step was entered with `!w->sensor_ok`, transitions to
// WizardStepMeasureFailed, sets `*out_cue = BioMapCueError`, and returns
// true. Returns false otherwise.
bool cal_wizard_check_sensor(CalWizardCore* w, BioMapCue* out_cue);

// Advance an active measurement by one 10 Hz (100 ms) tick. Returns true
// when the dwell finished (reaching the next prompt, success, or a fail
// screen), in which case `*out_cue` is set to BioMapCueConfirm,
// BioMapCueSuccess, or BioMapCueError for the caller to play. While false,
// no sound may be played (GSR + Sound rule).
bool cal_wizard_tick(CalWizardCore* w, BioMapCue* out_cue);

#ifdef __cplusplus
}
#endif
