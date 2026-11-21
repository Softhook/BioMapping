#include "keys.h"

// ── A keyboard that stops ──────────────────────────────────────────────
// The ADV's keyboard chip (TCA8418) holds G11 low while it has key events
// waiting. M5Cardputer 1.1.1 reads only after G11 changes (an interrupt
// sets a flag), then clears its flag if the chip's status reads "nothing
// waiting". A key event that lands between that status read and the flag
// being cleared, or a failed status read (which reads as 0), leaves the
// flag clear while G11 stays low. G11 then never changes again, so no key
// is ever read until a restart. The window is short, but the GSR thread
// (higher priority, using the same bus) can pause the main loop inside it.
//
// The chip holds at most 10 events and a working reader takes one a loop
// pass, so G11 low for 20 passes and 100 ms means it is stuck. A restart of
// the reader empties the chip and sets the interrupt up again. Its old
// interrupt is taken off first: the library frees the old reader before it
// sets up the new one, and the interrupt would write into freed memory.
static const int KEY_INT_PIN = 11;
static const uint32_t STUCK_PASSES = 20;
static const uint32_t STUCK_MS = 100;

void keys_unstick_poll(void) {
    static uint32_t low_passes = 0;
    static uint32_t low_since_ms = 0;
    if(M5.getBoard() != m5::board_t::board_M5CardputerADV) return;
    if(digitalRead(KEY_INT_PIN) != LOW) {
        low_passes = 0;
        return;
    }
    if(low_passes++ == 0) low_since_ms = millis();
    if(low_passes < STUCK_PASSES || millis() - low_since_ms < STUCK_MS) return;
    low_passes = 0;
    detachInterrupt(digitalPinToInterrupt(KEY_INT_PIN));
    M5Cardputer.Keyboard.begin();
    Serial.println("[Keys] warning: keyboard had stopped (G11 held low); restarted it");
}

bool keys_to_session(const Keyboard_Class::KeysState& st, SessionKey* out) {
    if(st.enter) {
        *out = SessionKeyOk;
        return true;
    }
    if(st.del) {
        *out = SessionKeyBack;
        return true;
    }
    if(st.word.empty()) return false;
    switch(st.word.back()) {
    case ';':
    case ':': *out = SessionKeyUp; return true;
    case '.':
    case '>': *out = SessionKeyDown; return true;
    case ',':
    case '<': *out = SessionKeyLeft; return true;
    case '/':
    case '?': *out = SessionKeyRight; return true;
    case '`':
    case '~': *out = SessionKeyBack; return true;
    default: return false;
    }
}

const char* keys_session_name(SessionKey key) {
    switch(key) {
    case SessionKeyOk: return "OK";
    case SessionKeyBack: return "Back";
    case SessionKeyUp: return "Up";
    case SessionKeyDown: return "Down";
    case SessionKeyLeft: return "Left";
    case SessionKeyRight: return "Right";
    }
    return "?";
}
