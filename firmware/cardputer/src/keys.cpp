#include "keys.h"

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
    case ';': *out = SessionKeyUp; return true;
    case '.': *out = SessionKeyDown; return true;
    case ',': *out = SessionKeyLeft; return true;
    case '/': *out = SessionKeyRight; return true;
    case '`': *out = SessionKeyBack; return true;
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
