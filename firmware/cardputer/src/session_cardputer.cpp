#include "session_cardputer.h"

#include <M5Cardputer.h>
#include <sys/time.h>
#include <time.h>

#include "cues_cardputer.h"
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

// The ESP32's own clock. The Cardputer has no clock chip, so this starts
// at 1 January 1970 at every power-up, and the session treats the time as
// not set (year before 2020): the header's start time is 0 and the file
// name counts from 1970-01-01_00-00-00. Step 9 sets this clock from GPS
// time (docs/cardputer_port.md, "The clock").
static void plat_datetime_now(void* ctx, SessionDateTime* out) {
    (void)ctx;
    time_t now = time(nullptr);
    struct tm tm;
    gmtime_r(&now, &tm);
    *out = SessionDateTime{};
    out->year = (uint16_t)(tm.tm_year + 1900);
    out->month = (uint8_t)(tm.tm_mon + 1);
    out->day = (uint8_t)tm.tm_mday;
    out->hour = (uint8_t)tm.tm_hour;
    out->minute = (uint8_t)tm.tm_min;
    out->second = (uint8_t)tm.tm_sec;
}

static uint32_t plat_epoch_now(void* ctx) {
    SessionDateTime dt;
    plat_datetime_now(ctx, &dt);
    return pipeline_unix_epoch(dt.year, dt.month, dt.day, dt.hour, dt.minute, dt.second);
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

    // The card is mounted again here, so one put in since start-up is found.
    sd_card_mount();
    GsrSensor* gsr = session_mode_needs_gsr(mode) ? gsr_cardputer_start() : nullptr;
    if(gsr) gsr_sensor_set_calibration(gsr, cfg.cal_active, cfg.cal_gain, cfg.cal_zero_counts);
    SdLogger* logger = session_mode_records(mode) ? sd_cardputer_alloc() : nullptr;

    session_cardputer_lock();
    g_session.core.gsr = gsr;
    g_session.logger = logger;
    g_session.open = true;
    session_cardputer_unlock();
    g_next_tick_ms = millis() + 1000 / TICK_HZ;
}

bool session_cardputer_poll(void) {
    if(!g_session.open || !g_session.core.running) return false;
    bool redraw = false;
    uint32_t now = millis();
    uint32_t ticks = 0;
    while((int32_t)(now - g_next_tick_ms) >= 0) {
        if(session_core_tick(&g_session.core)) redraw = true;
        g_next_tick_ms += 1000 / TICK_HZ;
        if(++ticks >= MAX_CATCH_UP_TICKS) {
            g_next_tick_ms = millis() + 1000 / TICK_HZ;
            break;
        }
    }
    return redraw;
}

bool session_cardputer_key(SessionKey key) {
    if(!g_session.open || !g_session.core.running) return false;
    return session_core_key(&g_session.core, key);
}

void session_cardputer_end(void) {
    if(!g_session.open) return;
    // Last resort: in normal use Back has already closed the file.
    session_core_end(&g_session.core);

    session_cardputer_lock();
    SdLogger* logger = g_session.logger;
    GsrSensor* gsr = g_session.core.gsr;
    g_session.logger = nullptr;
    g_session.core.gsr = nullptr;
    g_session.open = false;
    session_cardputer_unlock();

    if(logger) sd_cardputer_free(logger);
    if(gsr) gsr_cardputer_stop(gsr);
}
