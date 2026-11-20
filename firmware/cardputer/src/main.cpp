// BioMapping on the M5Stack Cardputer ADV.
//
// Step 8 of the port (docs/cardputer_port.md, section 7): records GSR to
// the SD card in GSR Only mode, through the shared session code in core/.
// The screen is a plain status page for now; the real recording screen
// comes in step 10.
//
// Keys: Enter starts and stops a recording, Esc (or Del) ends the session.
// Any other key is only counted, for the typing test (typing must not
// disturb the GSR reading).

#include <M5Cardputer.h>

#include "cues_cardputer.h"
#include "gsr_cardputer.h"
#include "keys.h"
#include "sd_cardputer.h"
#include "serial_files.h"
#include "session_cardputer.h"

static M5Canvas canvas(&M5Cardputer.Display);

static const BioMapMode MODE = BioMapModeGsrOnly;

static uint32_t key_count = 0;     // every key press, for the typing test
static uint32_t last_log_ms = 0;

// What the screen shows, copied out under the session lock so the slow
// part (pushing the picture to the display) happens without it.
struct View {
    bool     open, recording, write_stopped, retrying;
    uint32_t elapsed_s;
    bool     sensor_ok, connected;
    float    ns;
    float    hz, dup_pct, ok_pct;
    uint32_t i2c_peak_ms;
    char     file[48];
    uint32_t flush_peak_ms, fill_bytes, flush_fails;
    bool     card_ok;
};

static View read_view(void) {
    View v = {};
    session_cardputer_lock();
    const SessionCore& s = g_session.core;
    v.open = g_session.open && s.running;
    v.recording = s.recording.active;
    v.write_stopped = s.recording.write_stopped;
    v.retrying = s.recording.flush_fail_streak > 0;
    v.elapsed_s = s.recording.total_ticks / TICK_HZ;
    v.ns = s.pipeline.display.last_displayed;
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
    session_cardputer_unlock();
    v.card_ok = sd_card_ready();
    return v;
}

static void line(int y, uint16_t colour) {
    canvas.setTextColor(colour, TFT_BLACK);
    canvas.setCursor(4, y);
}

static void draw_screen(void) {
    View v = read_view();
    canvas.fillSprite(TFT_BLACK);
    canvas.setFont(&fonts::Font2);

    // 1. Mode and state.
    line(0, TFT_WHITE);
    canvas.print("GSR Only");
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
    } else {
        canvas.setTextColor(TFT_GREEN, TFT_BLACK);
        canvas.print("ready");
    }

    // 2. The reading.
    canvas.setFont(&fonts::Font4);
    line(20, TFT_WHITE);
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
        canvas.printf("%.1f nS", v.ns);
    }
    canvas.setFont(&fonts::Font2);

    // 3. The file.
    if(!v.card_ok) {
        line(48, TFT_RED);
        canvas.print("No SD card");
    } else if(v.file[0]) {
        line(48, TFT_LIGHTGREY);
        canvas.print(v.file);
    } else {
        line(48, TFT_DARKGREY);
        canvas.print("SD card ready");
    }

    // 4. SD writing and GSR reading, for the checks in step 8.
    line(66, TFT_DARKGREY);
    canvas.printf("SD max %lums  buf %lu  fails %lu", (unsigned long)v.flush_peak_ms,
                  (unsigned long)v.fill_bytes, (unsigned long)v.flush_fails);
    line(84, TFT_DARKGREY);
    canvas.printf("GSR %.0f/s  dup %.0f%%  ok %.0f%%  i2c %lums", v.hz, v.dup_pct, v.ok_pct,
                  (unsigned long)v.i2c_peak_ms);
    line(102, TFT_DARKGREY);
    canvas.printf("keys %lu", (unsigned long)key_count);

    // 5. What the keys do.
    line(119, TFT_LIGHTGREY);
    if(v.open) canvas.print(v.recording ? "Enter stop   Esc end" : "Enter record   Esc end");
    else canvas.print("Enter new session");

    canvas.pushSprite(0, 0);
}

// One line a second on USB, for watching a long run or the typing test.
static void log_second(void) {
    View v = read_view();
    Serial.printf("t=%lu rec=%d ns=%.2f hz=%.0f dup=%.1f ok=%.1f i2c_peak=%lu sd_peak=%lu "
                  "fails=%lu keys=%lu\n",
                  (unsigned long)(millis() / 1000), v.recording, v.ns, v.hz, v.dup_pct, v.ok_pct,
                  (unsigned long)v.i2c_peak_ms, (unsigned long)v.flush_peak_ms,
                  (unsigned long)v.flush_fails, (unsigned long)key_count);
}

static bool keys_poll(void) {
    if(!M5Cardputer.Keyboard.isChange() || !M5Cardputer.Keyboard.isPressed()) return false;
    key_count++;
    SessionKey key;
    if(!keys_to_session(M5Cardputer.Keyboard.keysState(), &key)) return true;  // count only
    if(g_session.open) {
        session_cardputer_key(key);
    } else if(key == SessionKeyOk) {
        session_cardputer_begin(MODE);
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

    session_cardputer_begin(MODE);
    draw_screen();
    last_log_ms = millis();
}

void loop() {
    M5Cardputer.update();
    bool redraw = keys_poll();
    if(session_cardputer_poll()) redraw = true;
    // Back pressed: the session has stopped any recording and finished.
    if(g_session.open && !g_session.core.running) {
        session_cardputer_end();
        redraw = true;
    }
    if(redraw) draw_screen();
    serial_files_poll(g_session.open && g_session.core.recording.active);
    if(millis() - last_log_ms >= 1000) {
        last_log_ms += 1000;
        log_second();
    }
    delay(1);
}
