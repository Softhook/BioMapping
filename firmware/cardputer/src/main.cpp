// BioMapping on the M5Stack Cardputer ADV: the main loop. It reads the
// keys, runs the menus (menu_cardputer.cpp) or the open session
// (session_cardputer.cpp), redraws the screen and logs one status line a
// second over USB. See docs/cardputer_port.md.
//
// Keys:
//   ; . , /  → Up, Down, Left, Right
//   Enter    → OK (select menu item, toggle option, start/stop recording)
//   Esc/Del  → Back (leave submenu or end recording session)
//
// The same keys also work when typed into a serial monitor over USB
// (`pio device monitor`), with Enter as OK and Esc or ` as Back.

#include <M5Cardputer.h>
#include <atomic>

#include "bt_cardputer.h"
#include "clock_cardputer.h"
#include "cues_cardputer.h"
#include "gps_cardputer.h"
#include "gsr_audio_cardputer.h"
#include "key_map.h"
#include "keys.h"
#include "menu_cardputer.h"
#include "screen_cardputer.h"
#include "sd_cardputer.h"
#include "session_cardputer.h"
#include "settings_cardputer.h"
#include "splash_cardputer.h"
#include "ui_theme.h"
#include "wifi_files_cardputer.h"

static M5Canvas canvas(&M5Cardputer.Display);

static uint32_t key_count = 0;     // every key press, for the typing test
static uint32_t last_log_ms = 0;
static uint32_t last_anim_ms = 0;

static void draw_screen(void) {
    if(g_session.open && g_session.core.running) {
        screen_cardputer_draw_session(canvas);
    } else {
        menu_cardputer_draw(canvas);
    }
    canvas.pushSprite(0, 0);
}

// One line a second on USB, for watching a long run or the typing test.
static void log_second(void) {
    session_cardputer_lock();
    const SessionCore& s = g_session.core;
    bool open = g_session.open && s.running;
    bool recording = open && s.recording.active;
    bool bt_active = open && g_session.bt_active;
    float ns = open ? s.pipeline.display.filtered_ns : 0.0f;
    if(open && s.mode == BioMapModeLiveStream && s.gsr) {
        ns = gsr_sensor_get_raw(s.gsr);
    }
    float hz = 0.0f, dup_pct = 0.0f, ok_pct = 0.0f;
    uint32_t i2c_peak_ms = 0;
    const GsrSensor* session_gsr = open ? s.gsr : nullptr;
    const GsrSensor* active_gsr = session_gsr ? session_gsr : gsr_audio_cardputer_sensor();
    if(!session_gsr && active_gsr) {
        ns = gsr_sensor_get_raw(active_gsr);
    }
    if(active_gsr) {
        hz = gsr_sensor_get_worker_hz(active_gsr);
        dup_pct = gsr_sensor_get_duplicate_rate(active_gsr);
        ok_pct = gsr_sensor_get_success_rate(active_gsr);
        i2c_peak_ms = gsr_sensor_get_i2c_peak_ms(active_gsr);
    }
    uint32_t flush_peak_ms = 0, flush_fails = 0;
    if(g_session.logger) {
        flush_peak_ms = sd_cardputer_write_peak_ms();
        flush_fails = sd_logger_get_flush_fail_count(g_session.logger);
    }
    GpsUart* gps = open ? s.gps : nullptr;
    session_cardputer_unlock();

    Serial.printf("t=%lu rec=%d ns=%.2f hz=%.0f dup=%.1f ok=%.1f i2c_peak=%lu sd_peak=%lu "
                  "fails=%lu keys=%lu",
                  (unsigned long)(millis() / 1000), recording, ns, hz, dup_pct, ok_pct,
                  (unsigned long)i2c_peak_ms, (unsigned long)flush_peak_ms,
                  (unsigned long)flush_fails, (unsigned long)key_count);
    if(gps) {
        GpsStatus st = gps_uart_get_status(gps);
        bool fix = gps_status_has_fix(&st);
        uint32_t lost = gps_uart_get_rx_drop_count(gps);
        uint32_t full = gps_cardputer_buffer_full_count(gps);
        Serial.printf(" gps_fix=%d sats=%d hacc=%.1f lat=%.6f lon=%.6f gps_lost=%lu gps_full=%lu",
                      fix, st.satellites_tracked, st.hacc, st.latitude, st.longitude,
                      (unsigned long)lost, (unsigned long)full);
    }
    if(bt_active) {
        Serial.printf(" ble=%d ble_drop=%lu ble_peak=%lu",
                      (int)bt_cardputer_get_link(),
                      (unsigned long)bt_cardputer_get_drop_count(),
                      (unsigned long)bt_cardputer_get_tx_peak_ms());
    }
    if(wifi_files_active()) {
        Serial.printf(" wifi=1 wifi_clients=%d", wifi_files_client_count());
    }
    if(gsr_audio_cardputer_active()) {
        Serial.printf(" audio=1");
    }
    if(clock_cardputer_is_set()) {
        SessionDateTime now;
        clock_cardputer_now(&now);
        Serial.printf(" time=%04u-%02u-%02u_%02u:%02u:%02u", now.year, now.month, now.day,
                      now.hour, now.minute, now.second);
    }
    Serial.println();
}

// One of the six buttons, to the open session or else the menus. Returns
// true when the screen should be redrawn.
static bool dispatch_key(SessionKey key) {
    return g_session.open ? session_cardputer_key(key) : menu_cardputer_key(key, canvas);
}

static bool keys_poll(void) {
    if(!M5Cardputer.Keyboard.isChange() || !M5Cardputer.Keyboard.isPressed()) return false;
    key_count++;
    const auto& st = M5Cardputer.Keyboard.keysState();
    // GSR Audio's extra keys (they do nothing on any other screen).
    if(st.tab && gsr_audio_cardputer_char('\t')) return true;
    if(!st.word.empty() && gsr_audio_cardputer_char(st.word.back())) return true;
    SessionKey key;
    if(!keys_to_session(st, &key)) return false;  // count only
    return dispatch_key(key);
}

// Keys typed into a serial monitor (key_map.h). A terminal's Enter can send
// "\r\n" (pio device monitor does by default), "\r" or "\n": keys_serial_read_char()
// folds "\r\n" into one Enter across both the main loop and Wi-Fi transfers.
static bool serial_keys_poll(void) {
    bool redraw = false;
    int ch = 0;
    while(keys_serial_read_char(&ch)) {
        if(gsr_audio_cardputer_char(ch)) {  // GSR Audio's extra keys only
            redraw = true;
            continue;
        }
        SessionKey key;
        if(key_map_char(ch, &key) && dispatch_key(key)) redraw = true;
    }
    return redraw;
}

// Bringing up the GPS at power-up (and polling its backup RTC) runs on its
// own task while the start-up animation plays; the animation doesn't end
// until it is done. The task runs on this core, as the code did before,
// because the serial driver sets up its interrupt on the core that opens
// the port, and the other core carries Bluetooth and Wi-Fi. One priority
// above the animation, so its short waits keep their timing; same stack as
// setup().
static std::atomic<bool> g_gps_boot_done{false};
static bool              g_boot_utc_ok = false;
static GpsUtcTime        g_boot_utc = {};

static void gps_boot_task(void* arg) {
    (void)arg;
    g_boot_utc_ok = gps_cardputer_port_open(&g_boot_utc);
    g_gps_boot_done.store(true, std::memory_order_release);
    vTaskDelete(nullptr);
}

static bool gps_boot_done(void) {
    return g_gps_boot_done.load(std::memory_order_acquire);
}

void setup() {
    auto cfg = M5.config();
    M5Cardputer.begin(cfg, true);
    // M5GFX already turns the ADV's panel to landscape; rotation 0 keeps it there.
    M5Cardputer.Display.setRotation(0);
    M5Cardputer.Display.setBrightness(UI_BRIGHTNESS_ON);
    canvas.createSprite(M5Cardputer.Display.width(), M5Cardputer.Display.height());
    cues_cardputer_begin();

    Serial.begin(115200);
    Serial.setTxTimeoutMs(0);  // don't stall when no computer is listening
    Serial.println("BioMapping Cardputer start");

    clock_cardputer_begin();
    settings_cardputer_load();
    menu_cardputer_begin();

    // The GPS port is opened once and held until power-off; opening it brings
    // the module up at 115200, polls its battery-backed RTC, and leaves it
    // awake acquiring satellites while the start-up animation plays.
    if(xTaskCreatePinnedToCore(gps_boot_task, "gps_boot", 8192, nullptr,
                               uxTaskPriorityGet(nullptr) + 1, nullptr, xPortGetCoreID()) == pdPASS) {
        splash_cardputer_play(canvas, gps_boot_done, g_settings.sound_enabled);
    } else {
        g_boot_utc_ok = gps_cardputer_port_open(&g_boot_utc);
        splash_cardputer_play(canvas, nullptr, g_settings.sound_enabled);
    }
    if(g_boot_utc_ok) {
        clock_cardputer_set_from_gps_rtc(&g_boot_utc);
    }

    settings_cardputer_log_in_use();
    draw_screen();
    last_log_ms = millis();
}

void loop() {
    M5Cardputer.update();
    keys_unstick_poll();
    bool redraw = keys_poll() || serial_keys_poll();
    if(menu_cardputer_poll(canvas)) redraw = true;
    if(session_cardputer_poll()) redraw = true;
    // Back pressed: the session has stopped any recording and finished.
    if(g_session.open && !g_session.core.running) {
        session_cardputer_end();
        redraw = true;
    }
    if(g_session.open && g_session.core.running &&
       mode_has_graph(g_session.core.mode) &&
       millis() - last_anim_ms >= UI_ANIM_MS) {
        redraw = true;
    }
    if(redraw) {
        last_anim_ms = millis();
        draw_screen();
    }
    if(millis() - last_log_ms >= 1000) {
        last_log_ms += 1000;
        if(millis() - last_log_ms >= 1000) last_log_ms = millis();
        log_second();
    }
    delay(1);
}
