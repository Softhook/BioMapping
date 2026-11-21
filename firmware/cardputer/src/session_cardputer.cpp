#include "session_cardputer.h"

#include <M5Cardputer.h>

#include "clock_cardputer.h"
#include "cues_cardputer.h"
#include "gps_cardputer.h"
#include "gsr_cardputer.h"
#include "sd_cardputer.h"

CardputerSession g_session;

static SemaphoreHandle_t g_mutex = nullptr;
static uint32_t          g_next_tick_ms = 0;

// Settings, as the Flipper's defaults (biomap.c) until the Cardputer has an
// Options screen. No calibration yet: the calibration wizard comes with the
// Cardputer's own screens (step 10).
static const bool SOUND_ENABLED = true;
static const bool ZOOM_ENABLED = true;
static const bool DEBUG_FIELDS_ENABLED = false;
static const char* const DEVICE_NAME = "Cardputer";
static const GpsNavModel NAV_MODEL = GpsNavModelPedestrian;
static const bool SUPER_S = true;

// How long the screen says "Waiting for GPS time" after Enter was pressed
// too early.
static const uint32_t NO_TIME_NOTICE_MS = 3000;
static uint32_t g_no_time_since_ms = 0;
static bool     g_no_time_notice = false;

// After a stall (a slow SD write) the missed ticks are run straight away,
// as the Flipper's queued timer events are. Each tick is one row and 0.1 s
// on the file's time column, so a dropped tick would put every later row
// early. Up to this many are caught up: the Flipper's event queue holds 64
// events (EVENT_QUEUE_DEPTH), about 6 s of ticks. Only after a longer
// stall does the schedule start again from now. tick_dt_ms in the debug
// columns records the real gap either way.
static const uint32_t MAX_CATCH_UP_TICKS = EVENT_QUEUE_DEPTH;

// ── Device functions for the shared session (SessionPlatform) ──────────
// Every one runs on the main loop.

static void plat_lock(void* ctx) {
    (void)ctx;
    xSemaphoreTake(g_mutex, portMAX_DELAY);
}

static void plat_unlock(void* ctx) {
    (void)ctx;
    xSemaphoreGive(g_mutex);
}

static uint32_t plat_now_ms(void* ctx) {
    (void)ctx;
    return millis();
}

static void plat_delay_ms(void* ctx, uint32_t ms) {
    (void)ctx;
    delay(ms);
}

static void plat_cue(void* ctx, BioMapCue cue) {
    (void)ctx;
    cues_cardputer_play(SOUND_ENABLED, cue);
}

static void plat_log(void* ctx, SessionLogLevel level, const char* line) {
    (void)ctx;
    static const char* const LEVEL[] = {"", " warning:", " error:"};
    Serial.printf("[Session]%s %s\n", LEVEL[level], line);
}

// UK time, set from GPS (clock_cardputer.cpp). Before GPS time it is 1970,
// and the session treats the time as not set (year before 2020): the
// header's start time is 0 and the file name counts from
// 1970-01-01_00-00-00. In GPS+GSR mode a recording can't start until then
// (session_cardputer_key()).
//
// The session asks for the date and time once, at the start of a
// recording, and for the epoch at its end. The epoch is in local time, as
// on the Flipper. The UTC offset at the start is kept for the end, so a
// recording across a clock change (01:00 GMT on the last Sunday of March
// or October) doesn't get an end time an hour off: in October it would
// otherwise end before it started. The Flipper's clock doesn't change by
// itself, so this matches it.
static int32_t g_recording_utc_offset_s = 0;

static void plat_datetime_now(void* ctx, SessionDateTime* out) {
    (void)ctx;
    clock_cardputer_now(out, &g_recording_utc_offset_s);
}

static uint32_t plat_epoch_now(void* ctx) {
    (void)ctx;
    return clock_cardputer_epoch(g_recording_utc_offset_s);
}

static bool plat_file_start(void* ctx, const char* header, const char* stamp) {
    (void)ctx;
    return sd_logger_start(g_session.logger, header, stamp);
}

static void plat_file_stop(void* ctx, uint32_t end_epoch) {
    (void)ctx;
    sd_logger_stop(g_session.logger, end_epoch);
}

static bool plat_file_append(void* ctx, const char* row, size_t len) {
    (void)ctx;
    return sd_logger_batch_append(g_session.logger, row, len);
}

static int plat_file_flush(void* ctx, bool all) {
    (void)ctx;
    return all ? sd_logger_batch_flush_all(g_session.logger)
               : sd_logger_batch_flush(g_session.logger);
}

// Lock held: only reads the logger's counters.
static void plat_fill_diag(void* ctx, RowDiag* d) {
    (void)ctx;
    const SdLogger* l = g_session.logger;
    d->flush_peak_ms        = sd_logger_get_flush_peak_ms(l);
    d->log_fill_bytes       = sd_logger_get_batch_fill_bytes(l);
    d->log_fill_peak_bytes  = sd_logger_get_batch_fill_peak_bytes(l);
    d->log_overflow_count   = sd_logger_get_overflow_count(l);
    d->log_flush_fail_count = sd_logger_get_flush_fail_count(l);
    d->prealloc_ms          = sd_logger_get_prealloc_ms(l);
}

// Once a second with debug fields on, lock released.
static void plat_second_diag(void* ctx, const SessionCore* s) {
    (void)ctx;
    Serial.printf("heartbeat heap:free=%u min=%u stack:main=%u gsr=%u\n",
                  (unsigned)ESP.getFreeHeap(), (unsigned)ESP.getMinFreeHeap(),
                  (unsigned)uxTaskGetStackHighWaterMark(nullptr),
                  (unsigned)(s->gsr ? gsr_cardputer_stack_free(s->gsr) : 0));
}

static SessionPlatform session_platform(void) {
    SessionPlatform p = {};
    p.lock = plat_lock;
    p.unlock = plat_unlock;
    p.now_ms = plat_now_ms;
    p.delay_ms = plat_delay_ms;
    p.cue = plat_cue;
    p.log = plat_log;
    p.datetime_now = plat_datetime_now;
    p.epoch_now = plat_epoch_now;
    p.file_start = plat_file_start;
    p.file_stop = plat_file_stop;
    p.file_append = plat_file_append;
    p.file_flush = plat_file_flush;
    p.fill_diag = plat_fill_diag;
    p.second_diag = plat_second_diag;
    // No radio, and no Live Stream yet (step 11): rf_snapshot and live_*
    // stay NULL, so session_core_init() refuses those modes.
    return p;
}

static SessionSettings session_settings(void) {
    SessionSettings cfg = {};
    cfg.sound_enabled = SOUND_ENABLED;
    cfg.zoom_enabled = ZOOM_ENABLED;
    cfg.debug_fields_enabled = DEBUG_FIELDS_ENABLED;
    cfg.device_name = DEVICE_NAME;
    cfg.cal_active = false;
    cfg.cal_gain = 1.0f;
    return cfg;
}

// ── Start, tick, keys, end ─────────────────────────────────────────────

void session_cardputer_lock(void) { plat_lock(nullptr); }
void session_cardputer_unlock(void) { plat_unlock(nullptr); }

void session_cardputer_begin(BioMapMode mode) {
    if(!g_mutex) g_mutex = xSemaphoreCreateMutex();
    SessionPlatform platform = session_platform();
    SessionSettings cfg = session_settings();
    session_cardputer_lock();
    session_core_init(&g_session.core, mode, &platform, &cfg);
    session_cardputer_unlock();

    // Mounted at the first session; does nothing once it is.
    sd_card_mount();
    // Takes a few hundred ms while the module wakes and is set up.
    GpsUart* gps = session_mode_needs_gps(mode) ? gps_cardputer_start(NAV_MODEL, SUPER_S) : nullptr;
    GsrSensor* gsr = session_mode_needs_gsr(mode) ? gsr_cardputer_start() : nullptr;
    if(gsr) gsr_sensor_set_calibration(gsr, cfg.cal_active, cfg.cal_gain, cfg.cal_zero_counts);
    SdLogger* logger = session_mode_records(mode) ? sd_cardputer_alloc() : nullptr;

    session_cardputer_lock();
    g_session.core.gps = gps;
    g_session.core.gsr = gsr;
    g_session.logger = logger;
    g_session.open = true;
    session_cardputer_unlock();
    g_next_tick_ms = millis() + 1000 / TICK_HZ;
}

bool session_cardputer_poll(void) {
    // GPS parsing happens without the session lock: a GPS reconfigure
    // waits for seconds.
    GpsUart* gps = g_session.open ? g_session.core.gps : nullptr;
    bool redraw = false;
    if(g_no_time_notice && millis() - g_no_time_since_ms >= NO_TIME_NOTICE_MS) {
        g_no_time_notice = false;
        redraw = true;
    }
    if(!g_session.open || !g_session.core.running) {
        gps_cardputer_poll(gps);
        clock_cardputer_poll(gps);
        return redraw;
    }

    uint32_t now = millis();
    uint32_t due = 0;  // ticks due now, up to the catch-up limit
    if((int32_t)(now - g_next_tick_ms) >= 0) {
        due = (now - g_next_tick_ms) / (1000 / TICK_HZ) + 1;
        if(due > MAX_CATCH_UP_TICKS) due = MAX_CATCH_UP_TICKS;
    }
    if(due <= 1) {
        gps_cardputer_poll(gps);
    }
    // After a pause, the GPS bytes that came in during it are parsed a
    // slice at a time between the caught-up ticks, so each row gets about
    // the position of its own moment rather than all getting the same one.
    // The waiting bytes run up to now, so before tick k of n, all but
    // (n - k) / n of them are parsed.
    int waiting = due > 1 ? gps_cardputer_waiting_bytes() : 0;
    for(uint32_t k = 1; k <= due; k++) {
        if(due > 1) gps_cardputer_parse_down_to(gps, (int)((int64_t)waiting * (due - k) / due));
        if(session_core_tick(&g_session.core)) redraw = true;
        g_next_tick_ms += 1000 / TICK_HZ;
    }
    if(due >= MAX_CATCH_UP_TICKS && (int32_t)(millis() - g_next_tick_ms) >= 0) {
        // Longer behind than the catch-up covers: start again from now.
        g_next_tick_ms = millis() + 1000 / TICK_HZ;
    }
    clock_cardputer_poll(gps);
    return redraw;
}

bool session_cardputer_key(SessionKey key) {
    if(!g_session.open || !g_session.core.running) return false;
    // The decided clock rule: in a GPS mode, wait for GPS time before
    // recording, so the file name and start time are always right. The
    // core reads `recording` only on this thread, so no lock is needed.
    if(key == SessionKeyOk && has_gps(g_session.core.mode) && !g_session.core.recording.active &&
       !clock_cardputer_is_set()) {
        session_core_cue(&g_session.core, BioMapCueError);
        g_no_time_notice = true;
        g_no_time_since_ms = millis();
        return true;
    }
    return session_core_key(&g_session.core, key);
}

bool session_cardputer_no_time_notice(void) {
    return g_no_time_notice;
}

void session_cardputer_end(void) {
    if(!g_session.open) return;
    // Last resort: in normal use Back has already closed the file.
    session_core_end(&g_session.core);

    session_cardputer_lock();
    SdLogger* logger = g_session.logger;
    GsrSensor* gsr = g_session.core.gsr;
    GpsUart* gps = g_session.core.gps;
    g_session.logger = nullptr;
    g_session.core.gsr = nullptr;
    g_session.core.gps = nullptr;
    g_session.open = false;
    session_cardputer_unlock();

    if(logger) sd_cardputer_free(logger);
    if(gsr) gsr_cardputer_stop(gsr);
    if(gps) gps_cardputer_stop(gps);  // the module goes back to sleep
}
