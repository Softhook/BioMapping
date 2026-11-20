// BioMapping on the M5Stack Cardputer ADV.
//
// Step 7 of the port (docs/cardputer_port.md, section 7): the project
// builds the shared code in core/, shows a start screen and reads the
// keys as the Flipper's six buttons. Recording comes in the next steps.

#include <M5Cardputer.h>

#include "biomap_format.h"
#include "keys.h"

static M5Canvas canvas(&M5Cardputer.Display);

// What the start screen shows.
static char core_stamp[24];       // made by the shared code, to show it runs
static const char* last_name = "-";
static char last_key = 0;         // the key itself, or 0 for Enter/Del
static uint32_t press_count = 0;  // presses of the six buttons
static uint32_t other_count = 0;  // presses of any other key

static void draw_screen(void) {
    canvas.fillSprite(TFT_BLACK);

    canvas.setFont(&fonts::Font4);
    canvas.setTextColor(TFT_WHITE, TFT_BLACK);
    canvas.setCursor(4, 2);
    canvas.print("BioMapping");

    canvas.setFont(&fonts::Font2);
    canvas.setTextColor(TFT_DARKGREY, TFT_BLACK);
    canvas.setCursor(4, 30);
    canvas.print("Cardputer port, step 7");

    canvas.setTextColor(TFT_GREEN, TFT_BLACK);
    canvas.setCursor(4, 50);
    canvas.printf("Core: %s", core_stamp);

    canvas.setTextColor(TFT_YELLOW, TFT_BLACK);
    canvas.setCursor(4, 70);
    if(last_key) canvas.printf("Key: %s  (%c)", last_name, last_key);
    else canvas.printf("Key: %s", last_name);
    canvas.setTextColor(TFT_DARKGREY, TFT_BLACK);
    canvas.setCursor(4, 86);
    canvas.printf("buttons %lu  other keys %lu", (unsigned long)press_count,
                  (unsigned long)other_count);

    canvas.setTextColor(TFT_LIGHTGREY, TFT_BLACK);
    canvas.setCursor(4, 102);
    canvas.print("; . , /  arrows    Enter  OK");
    canvas.setCursor(4, 118);
    canvas.print("Esc or Del  Back");

    canvas.pushSprite(0, 0);
}

static void keys_poll(void) {
    if(!M5Cardputer.Keyboard.isChange() || !M5Cardputer.Keyboard.isPressed()) return;
    auto& st = M5Cardputer.Keyboard.keysState();
    SessionKey key;
    if(keys_to_session(st, &key)) {
        press_count++;
        last_name = keys_session_name(key);
        last_key = (st.enter || st.del || st.word.empty()) ? 0 : st.word.back();
        Serial.printf("key %s\n", last_name);
    } else {
        other_count++;
    }
    draw_screen();
}

void setup() {
    auto cfg = M5.config();
    M5Cardputer.begin(cfg, true);
    // M5GFX already turns the ADV's panel to landscape; rotation 0 keeps it there.
    M5Cardputer.Display.setRotation(0);
    M5Cardputer.Display.setBrightness(128);
    canvas.createSprite(M5Cardputer.Display.width(), M5Cardputer.Display.height());

    Serial.begin(115200);
    Serial.setTxTimeoutMs(0);  // don't stall when no computer is listening

    // Any shared function would do; a file name stamp is easy to read.
    if(biomap_format_file_stamp(core_stamp, sizeof core_stamp, 2026, 11, 20, 14, 32, 5) < 0) {
        snprintf(core_stamp, sizeof core_stamp, "FAILED");
    }
    Serial.printf("BioMapping Cardputer start, core stamp %s\n", core_stamp);
    draw_screen();
}

void loop() {
    M5Cardputer.update();
    keys_poll();
    delay(1);
}
