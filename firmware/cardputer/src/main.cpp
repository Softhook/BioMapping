// BioMapping on the M5Stack Cardputer ADV.
//
// Steps 10–11 of the port (docs/cardputer_port.md, section 7): colour menus,
// Options and 4-step GSR Calibration wizard on the 240 × 135 screen, settings
// and calibration persisted on the SD card (/sd/biomapping/), BLE Live Stream,
// and the shared recording screen (core/biomap_screen.c) stretched to fit the
// display with a smooth 30 FPS spline waveform.
//
// Keys:
//   ; . , /  → Up, Down, Left, Right
//   Enter    → OK (select menu item, toggle option, start/stop recording)
//   Esc/Del  → Back (leave submenu or end recording session)
//   U        → Lend SD card to a plugged-in computer as a USB thumb drive
//              (from the menus; taking it back with U needs a second
//              press within 3 s: eject on the computer first).
//
// The same keys also work when typed into a serial monitor over USB
// (`pio device monitor`), with Enter as OK and Esc or ` as Back.

#include <M5Cardputer.h>

#include "bt_cardputer.h"
#include "clock_cardputer.h"
#include "cues_cardputer.h"
#include "gps_cardputer.h"
#include "gsr_cardputer.h"
#include "keys.h"
#include "menu_cardputer.h"
#include "screen_cardputer.h"
#include "sd_cardputer.h"
#include "session_cardputer.h"
#include "settings_cardputer.h"
#include "wifi_files_cardputer.h"

static M5Canvas canvas(&M5Cardputer.Display);

static uint32_t key_count = 0;     // every key press, for the typing test
static uint32_t last_log_ms = 0;
static uint32_t last_anim_ms = 0;
// Smooth 30 FPS screen updates while a GSR graph session is open, so the
// spline waveform glides continuously across the screen.
static const uint32_t GRAPH_ANIM_MS = 33;
// Why U couldn't lend the card, shown for a few seconds (nullptr: none).
static const uint32_t USB_NOTICE_MS = 3000;
static const char* g_usb_notice = nullptr;
static uint32_t    g_usb_notice_since_ms = 0;
// Taking the card back with U while the computer still has the drive open
// can lose changes the computer hasn't written yet, so U asks for a second
// press within this time. Ejecting on the computer needs no confirming.
static const uint32_t USB_CONFIRM_MS = 3000;
static bool     g_usb_confirm = false;
static uint32_t g_usb_confirm_since_ms = 0;

static void draw_screen(void) {
    if(g_session.open && g_session.core.running) {
        screen_cardputer_draw_session(canvas);
    } else {
        menu_cardputer_draw(canvas, sd_usb_drive_active(), g_usb_confirm, g_usb_notice);
    }
    canvas.pushSprite(0, 0);
}

// One line a second on USB, for watching a long run or the typing test.
static void log_second(void) {
    session_cardputer_lock();
    const SessionCore& s = g_session.core;
    bool open = g_session.open && s.running;
    bool recording = s.recording.active;
    float ns = s.pipeline.display.filtered_ns;
    if(s.mode == BioMapModeLiveStream && s.gsr) {
        ns = gsr_sensor_get_raw(s.gsr);
    }
    float hz = 0.0f, dup_pct = 0.0f, ok_pct = 0.0f;
    uint32_t i2c_peak_ms = 0;
    if(s.gsr) {
        hz = gsr_sensor_get_worker_hz(s.gsr);
        dup_pct = gsr_sensor_get_duplicate_rate(s.gsr);
        ok_pct = gsr_sensor_get_success_rate(s.gsr);
        i2c_peak_ms = gsr_sensor_get_i2c_peak_ms(s.gsr);
    }
    uint32_t flush_peak_ms = 0, flush_fails = 0;
    if(g_session.logger) {
        flush_peak_ms = sd_logger_get_flush_peak_ms(g_session.logger);
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
    if(g_session.bt_active) {
        Serial.printf(" ble=%d ble_drop=%lu ble_peak=%lu",
                      (int)bt_cardputer_get_link(),
                      (unsigned long)bt_cardputer_get_drop_count(),
                      (unsigned long)bt_cardputer_get_tx_peak_ms());
    }
    if(wifi_files_active()) {
        Serial.printf(" wifi=1 wifi_clients=%d", wifi_files_client_count());
    }
    if(clock_cardputer_is_set()) {
        SessionDateTime now;
        clock_cardputer_now(&now);
        Serial.printf(" time=%04u-%02u-%02u_%02u:%02u:%02u", now.year, now.month, now.day,
                      now.hour, now.minute, now.second);
    }
    Serial.println();
}

static bool keys_poll(void) {
    if(!M5Cardputer.Keyboard.isChange() || !M5Cardputer.Keyboard.isPressed()) return false;
    key_count++;
    const auto& st = M5Cardputer.Keyboard.keysState();
    bool in_session = g_session.open || !menu_cardputer_can_lend_sd();
    if(!in_session && !st.word.empty() && (st.word.back() == 'u' || st.word.back() == 'U')) {
        if(sd_usb_drive_active()) {
            if(!g_usb_confirm) {
                g_usb_confirm = true;
                g_usb_confirm_since_ms = millis();
                cues_cardputer_play(g_settings.sound_enabled, BioMapCueError);
                return true;
            }
            g_usb_confirm = false;
            sd_usb_drive_set(false);
            settings_cardputer_load();
            cues_cardputer_play(g_settings.sound_enabled, BioMapCueToggleOff);
            return true;
        }
        switch(sd_usb_drive_set(true)) {
        case SdUsbOk:         g_usb_notice = nullptr; break;
        case SdUsbNoComputer: g_usb_notice = "Plug USB into a computer"; break;
        case SdUsbNoCard:     g_usb_notice = "No SD card to lend"; break;
        case SdUsbFileOpen:   g_usb_notice = "Stop recording first"; break;
        }
        if(g_usb_notice) {
            g_usb_notice_since_ms = millis();
            cues_cardputer_play(g_settings.sound_enabled, BioMapCueError);
        } else {
            cues_cardputer_play(g_settings.sound_enabled, BioMapCueToggleOn);
        }
        return true;
    }

    SessionKey key;
    if(!keys_to_session(st, &key)) return false;  // count only
    if(g_session.open) {
        return session_cardputer_key(key);
    }
    return menu_cardputer_key(key, canvas);
}

// Keys typed into a serial monitor. A terminal's Enter can send "\r\n"
// (pio device monitor does by default), "\r" or "\n": each is one OK, so
// a "\n" straight after a "\r" is skipped.
static bool serial_keys_poll(void) {
    static int prev_ch = -1;
    bool redraw = false;
    while(Serial.available() > 0) {
        int ch = Serial.read();
        bool crlf_tail = (ch == '\n' && prev_ch == '\r');
        prev_ch = ch;
        if(crlf_tail) continue;
        SessionKey key;
        bool valid = false;
        switch(ch) {
        case ';':
        case ':':  key = SessionKeyUp;    valid = true; break;
        case '.':
        case '>':  key = SessionKeyDown;  valid = true; break;
        case ',':
        case '<':  key = SessionKeyLeft;  valid = true; break;
        case '/':
        case '?':  key = SessionKeyRight; valid = true; break;
        case '`':
        case '~':
        case 0x1B:
        case 0x7F: key = SessionKeyBack;  valid = true; break;
        case '\r':
        case '\n': key = SessionKeyOk;    valid = true; break;
        default:   break;
        }
        if(valid) {
            if(g_session.open) {
                if(session_cardputer_key(key)) redraw = true;
            } else {
                if(menu_cardputer_key(key, canvas)) redraw = true;
            }
        }
    }
    return redraw;
}

void setup() {
    auto cfg = M5.config();
    M5Cardputer.begin(cfg, true);
    // M5GFX already turns the ADV's panel to landscape; rotation 0 keeps it there.
    M5Cardputer.Display.setRotation(0);
    M5Cardputer.Display.setBrightness(128);
    canvas.createSprite(M5Cardputer.Display.width(), M5Cardputer.Display.height());
    cues_cardputer_begin();

    Serial.begin(115200);
    Serial.setTxTimeoutMs(0);  // don't stall when no computer is listening
    Serial.println("BioMapping Cardputer start");

    clock_cardputer_begin();
    settings_cardputer_load();
    menu_cardputer_begin();

    // Opened once and held until power-off; puts the module to sleep
    // (up to about 2 s) while staying on the menu until a GPS session starts.
    canvas.fillSprite(TFT_BLACK);
    canvas.setFont(&fonts::Font2);
    canvas.setTextColor(TFT_WHITE, TFT_BLACK);
    canvas.setCursor(6, 4);
    canvas.print("Bio Mapping");
    canvas.setTextColor(TFT_YELLOW, TFT_BLACK);
    canvas.setCursor(6, 60);
    canvas.print("Putting GPS to sleep...");
    canvas.pushSprite(0, 0);
    gps_cardputer_port_open();

    draw_screen();
    last_log_ms = millis();
}

void loop() {
    M5Cardputer.update();
    keys_unstick_poll();
    bool redraw = keys_poll() || serial_keys_poll();
    if(sd_usb_drive_poll()) {
        g_usb_confirm = false;  // ejected or unplugged: nothing to confirm
        settings_cardputer_load();
        redraw = true;
    }
    if(g_usb_notice && millis() - g_usb_notice_since_ms >= USB_NOTICE_MS) {
        g_usb_notice = nullptr;
        redraw = true;
    }
    if(g_usb_confirm && millis() - g_usb_confirm_since_ms >= USB_CONFIRM_MS) {
        g_usb_confirm = false;
        redraw = true;
    }
    if(menu_cardputer_poll(canvas)) redraw = true;
    if(session_cardputer_poll()) redraw = true;
    // Back pressed: the session has stopped any recording and finished.
    if(g_session.open && !g_session.core.running) {
        session_cardputer_end();
        redraw = true;
    }
    if(g_session.open && g_session.core.running &&
       has_gsr(g_session.core.mode) && g_session.core.mode != BioMapModeDiagnostics &&
       millis() - last_anim_ms >= GRAPH_ANIM_MS) {
        last_anim_ms = millis();
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
