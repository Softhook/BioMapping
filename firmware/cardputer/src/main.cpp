// BioMapping on the M5Stack Cardputer ADV.
//
// Step 9 of the port (docs/cardputer_port.md, section 7): records GPS+GSR
// or GSR Only to the SD card, through the shared session code in core/,
// with the clock set from GPS time. The screen is a plain status page for
// now; the real recording screen comes in step 10.
//
// Keys: Enter starts and stops a recording, Esc (or Del) ends the session,
// and U (when not recording) lends the SD card to a plugged-in computer as
// a USB thumb drive (taking it back with U needs a second press: eject on
// the computer first). With no session open, Tab switches between GPS+GSR and
// GSR Only, and Enter starts a session in that mode. Any other key is only
// counted, for the typing test (typing must not disturb the GSR reading).

#include <M5Cardputer.h>

#include "clock_cardputer.h"
#include "cues_cardputer.h"
#include "gps_cardputer.h"
#include "gsr_cardputer.h"
#include "keys.h"
#include "sd_cardputer.h"
#include "session_cardputer.h"

static M5Canvas canvas(&M5Cardputer.Display);

// The mode the next session starts in; Tab switches it between sessions.
static BioMapMode g_mode = BioMapModeGpsGsr;

static uint32_t key_count = 0;     // every key press, for the typing test
static uint32_t last_log_ms = 0;
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

// What the screen shows, copied out under the session lock so the slow
// part (pushing the picture to the display) happens without it.
struct View {
    BioMapMode mode;
    bool     open, recording, write_stopped, retrying;
    uint32_t elapsed_s;
    bool     sensor_ok, connected;
    float    ns;
    float    hz, dup_pct, ok_pct;
    uint32_t i2c_peak_ms;
    char     file[48];
    uint32_t flush_peak_ms, fill_bytes, flush_fails;
    bool     card_ok, usb_drive, usb_confirm;
    const char* usb_notice;
    bool     gps_on, gps_ready, gps_fix;
    int      gps_fix_type, gps_sats;
    float    gps_hacc;
    uint32_t gps_lost, gps_near_miss;  // overflows that lost bytes; buffer full, nothing lost
    double   lat, lon;
    bool     clock_set, no_time_notice;
    SessionDateTime now;
};

static View read_view(void) {
    View v = {};
    session_cardputer_lock();
    const SessionCore& s = g_session.core;
    v.open = g_session.open && s.running;
    v.mode = v.open ? s.mode : g_mode;
    v.recording = s.recording.active;
    v.write_stopped = s.recording.write_stopped;
    v.retrying = s.recording.flush_fail_streak > 0;
    v.elapsed_s = s.recording.total_ticks / TICK_HZ;
    // The same value and rounding as the Flipper's recording screen
    // (core/biomap_screen.c, draw_ns_top_right), so the two can be
    // compared by eye: the ~100 ms average, in whole nS.
    v.ns = s.pipeline.display.filtered_ns;
    if(s.gsr) {
        v.sensor_ok = gsr_sensor_available(s.gsr);
        v.connected = gsr_sensor_is_connected(s.gsr);
        v.hz = gsr_sensor_get_worker_hz(s.gsr);
        v.dup_pct = gsr_sensor_get_duplicate_rate(s.gsr);
        v.ok_pct = gsr_sensor_get_success_rate(s.gsr);
        v.i2c_peak_ms = gsr_sensor_get_i2c_peak_ms(s.gsr);
    }
    if(g_session.logger) {
        const char* name = sd_logger_get_filename(g_session.logger);
        // Without the "biomap_" in front, so it fits on one line.
        if(strncmp(name, "biomap_", 7) == 0) name += 7;
        snprintf(v.file, sizeof(v.file), "%s", name);
        v.flush_peak_ms = sd_logger_get_flush_peak_ms(g_session.logger);
        v.fill_bytes = sd_logger_get_batch_fill_bytes(g_session.logger);
        v.flush_fails = sd_logger_get_flush_fail_count(g_session.logger);
    }
    GpsUart* gps = v.open ? s.gps : nullptr;
    session_cardputer_unlock();
    // The GPS has its own lock; read it with the session lock released.
    if(gps) {
        v.gps_on = true;
        v.gps_ready = gps_uart_is_ready(gps);
        GpsStatus st = gps_uart_get_status(gps);
        v.gps_fix = gps_status_has_fix(&st);
        v.gps_fix_type = st.fix_type;
        v.gps_sats = st.satellites_tracked;
        v.gps_hacc = st.hacc;
        v.lat = st.latitude;
        v.lon = st.longitude;
        v.gps_lost = gps_uart_get_rx_drop_count(gps);
        v.gps_near_miss = gps_cardputer_buffer_full_count(gps);
    }
    v.card_ok = sd_card_ready();
    v.usb_drive = sd_usb_drive_active();
    v.usb_notice = g_usb_notice;
    v.usb_confirm = g_usb_confirm;
    v.clock_set = clock_cardputer_is_set();
    v.no_time_notice = session_cardputer_no_time_notice();
    clock_cardputer_now(&v.now);
    return v;
}

static void line(int y, uint16_t colour) {
    canvas.setTextColor(colour, TFT_BLACK);
    canvas.setCursor(4, y);
}

static const char* mode_name(BioMapMode mode) {
    return mode == BioMapModeGpsGsr ? "GPS+GSR" : "GSR Only";
}

// Lines are 15 px apart in Font2, with the reading in Font4 under the top
// line.
static const int Y_FILE = 44, Y_GPS = 59, Y_TIME = 74, Y_SD = 89, Y_GSR = 104, Y_KEYS = 119;

static void draw_screen(void) {
    View v = read_view();
    canvas.fillSprite(TFT_BLACK);
    canvas.setFont(&fonts::Font2);

    // 1. Mode and state.
    line(0, TFT_WHITE);
    canvas.print(mode_name(v.mode));
    canvas.setCursor(120, 0);
    if(!v.open) {
        canvas.setTextColor(TFT_DARKGREY, TFT_BLACK);
        canvas.print("ended");
    } else if(v.write_stopped) {
        canvas.setTextColor(TFT_RED, TFT_BLACK);
        canvas.print("REC STOPPED");
    } else if(v.recording) {
        canvas.setTextColor(v.retrying ? TFT_ORANGE : TFT_RED, TFT_BLACK);
        canvas.printf("REC %02lu:%02lu:%02lu", (unsigned long)(v.elapsed_s / 3600),
                      (unsigned long)(v.elapsed_s / 60 % 60), (unsigned long)(v.elapsed_s % 60));
    } else if(v.gps_on && !v.clock_set) {
        canvas.setTextColor(TFT_YELLOW, TFT_BLACK);
        canvas.print("no GPS time");
    } else {
        canvas.setTextColor(TFT_GREEN, TFT_BLACK);
        canvas.print("ready");
    }

    // 2. The reading.
    canvas.setFont(&fonts::Font4);
    line(18, TFT_WHITE);
    if(!v.open) {
        canvas.setTextColor(TFT_DARKGREY, TFT_BLACK);
        canvas.print("-");
    } else if(!v.sensor_ok) {
        canvas.setTextColor(TFT_RED, TFT_BLACK);
        canvas.print("No GSR sensor");
    } else if(!v.connected) {
        canvas.setTextColor(TFT_YELLOW, TFT_BLACK);
        canvas.print("Cuffs off");
    } else {
        canvas.printf("%.0f nS", v.ns);
    }
    canvas.setFont(&fonts::Font2);

    // 3. The file, USB drive state, or why a recording didn't start.
    if(v.usb_drive && v.usb_confirm) {
        line(Y_FILE, TFT_YELLOW);
        canvas.print("Eject on computer first!");
    } else if(v.usb_drive) {
        line(Y_FILE, TFT_CYAN);
        canvas.print("USB drive on computer");
    } else if(v.usb_notice) {
        line(Y_FILE, TFT_YELLOW);
        canvas.print(v.usb_notice);
    } else if(v.no_time_notice) {
        line(Y_FILE, TFT_YELLOW);
        canvas.print("Waiting for GPS time");
    } else if(!v.card_ok) {
        line(Y_FILE, TFT_RED);
        canvas.print("No SD card");
    } else if(v.file[0]) {
        line(Y_FILE, TFT_LIGHTGREY);
        canvas.print(v.file);
    } else {
        line(Y_FILE, TFT_DARKGREY);
        canvas.print("SD card ready");
    }

    // 4. GPS.
    if(!v.gps_on) {
        line(Y_GPS, TFT_DARKGREY);
        canvas.print(v.mode == BioMapModeGpsGsr && !v.open ? "GPS asleep" : "GPS off");
    } else if(!v.gps_ready) {
        line(Y_GPS, TFT_RED);
        canvas.print("GPS port not open");
    } else if(!v.gps_fix) {
        line(Y_GPS, TFT_YELLOW);
        canvas.printf("GPS no fix  %d sats", v.gps_sats);
    } else {
        line(Y_GPS, TFT_GREEN);
        canvas.printf("GPS %dD  %d sats  hAcc %.1f m", v.gps_fix_type == 3 ? 3 : 2, v.gps_sats,
                      v.gps_hacc);
    }

    // 5. The clock, and the position once there is a fix.
    line(Y_TIME, v.clock_set ? TFT_LIGHTGREY : TFT_DARKGREY);
    if(v.clock_set) {
        canvas.printf("%02u:%02u:%02u", v.now.hour, v.now.minute, v.now.second);
    } else {
        canvas.print("--:--:--");
    }
    if(v.gps_fix && !isnan(v.lat)) {
        canvas.setCursor(76, Y_TIME);
        canvas.printf("%.5f %.5f", v.lat, v.lon);
    }

    // 6. SD writing and GSR reading.
    line(Y_SD, TFT_DARKGREY);
    canvas.printf("SD %lums  buf %lu  fail %lu  keys %lu", (unsigned long)v.flush_peak_ms,
                  (unsigned long)v.fill_bytes, (unsigned long)v.flush_fails,
                  (unsigned long)key_count);
    line(Y_GSR, TFT_DARKGREY);
    canvas.printf("GSR %.0f/s  dup %.0f%%  ok %.0f%%  i2c %lums", v.hz, v.dup_pct, v.ok_pct,
                  (unsigned long)v.i2c_peak_ms);

    // 7. What the keys do.
    line(Y_KEYS, TFT_LIGHTGREY);
    if(v.usb_drive) {
        canvas.print(v.usb_confirm ? "Press U again to take card" : "Eject on computer to finish");
    } else if(v.open) {
        canvas.print(v.recording ? "Enter stop   Esc end" : "Enter record   U USB   Esc end");
    } else {
        canvas.print("Enter session   Tab mode   U USB");
    }

    canvas.pushSprite(0, 0);
}

// One line a second on USB, for watching a long run or the typing test.
static void log_second(void) {
    View v = read_view();
    Serial.printf("t=%lu rec=%d ns=%.2f hz=%.0f dup=%.1f ok=%.1f i2c_peak=%lu sd_peak=%lu "
                  "fails=%lu keys=%lu",
                  (unsigned long)(millis() / 1000), v.recording, v.ns, v.hz, v.dup_pct, v.ok_pct,
                  (unsigned long)v.i2c_peak_ms, (unsigned long)v.flush_peak_ms,
                  (unsigned long)v.flush_fails, (unsigned long)key_count);
    if(v.gps_on) {
        Serial.printf(" gps_fix=%d sats=%d hacc=%.1f lat=%.6f lon=%.6f gps_lost=%lu gps_full=%lu",
                      v.gps_fix, v.gps_sats, v.gps_hacc, v.lat, v.lon,
                      (unsigned long)v.gps_lost, (unsigned long)v.gps_near_miss);
    }
    if(v.clock_set) {
        Serial.printf(" time=%04u-%02u-%02u_%02u:%02u:%02u", v.now.year, v.now.month, v.now.day,
                      v.now.hour, v.now.minute, v.now.second);
    }
    Serial.println();
}

// Starting GPS takes a few hundred ms, so say so on the screen first.
static void start_session(void) {
    if(session_mode_needs_gps(g_mode)) {
        canvas.fillSprite(TFT_BLACK);
        canvas.setFont(&fonts::Font2);
        line(0, TFT_WHITE);
        canvas.print(mode_name(g_mode));
        line(Y_GPS, TFT_YELLOW);
        canvas.print("Starting GPS...");
        canvas.pushSprite(0, 0);
    }
    session_cardputer_begin(g_mode);
}

static bool keys_poll(void) {
    if(!M5Cardputer.Keyboard.isChange() || !M5Cardputer.Keyboard.isPressed()) return false;
    key_count++;
    const auto& st = M5Cardputer.Keyboard.keysState();
    bool recording = g_session.open && g_session.core.recording.active;
    if(!recording && !st.word.empty() && (st.word.back() == 'u' || st.word.back() == 'U')) {
        if(sd_usb_drive_active()) {
            if(!g_usb_confirm) {
                g_usb_confirm = true;
                g_usb_confirm_since_ms = millis();
                cues_cardputer_play(true, BioMapCueError);
                return true;
            }
            g_usb_confirm = false;
            sd_usb_drive_set(false);
            cues_cardputer_play(true, BioMapCueToggleOff);
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
            cues_cardputer_play(true, BioMapCueError);
        } else {
            cues_cardputer_play(true, BioMapCueToggleOn);
        }
        return true;
    }
    if(st.tab && !g_session.open) {
        g_mode = g_mode == BioMapModeGpsGsr ? BioMapModeGsrOnly : BioMapModeGpsGsr;
        return true;
    }
    SessionKey key;
    if(!keys_to_session(st, &key)) return true;  // count only
    if(g_session.open) {
        session_cardputer_key(key);
    } else if(key == SessionKeyOk) {
        start_session();
    }
    return true;
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
    // Opened once and held until power-off; puts the module to sleep
    // (up to about 2 s).
    canvas.fillSprite(TFT_BLACK);
    canvas.setFont(&fonts::Font2);
    line(0, TFT_WHITE);
    canvas.print("Putting GPS to sleep...");
    canvas.pushSprite(0, 0);
    gps_cardputer_port_open();

    start_session();
    draw_screen();
    last_log_ms = millis();
}

void loop() {
    M5Cardputer.update();
    keys_unstick_poll();
    bool redraw = keys_poll();
    if(sd_usb_drive_poll()) {
        g_usb_confirm = false;  // ejected or unplugged: nothing to confirm
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
    if(session_cardputer_poll()) redraw = true;
    // Back pressed: the session has stopped any recording and finished.
    if(g_session.open && !g_session.core.running) {
        session_cardputer_end();
        redraw = true;
    }
    if(redraw) draw_screen();
    if(millis() - last_log_ms >= 1000) {
        last_log_ms += 1000;
        if(millis() - last_log_ms >= 1000) last_log_ms = millis();
        log_second();
    }
    delay(1);
}
