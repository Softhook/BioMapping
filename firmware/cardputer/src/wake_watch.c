#include "wake_watch.h"

#include <string.h>

// For the driver's task to pass the report on, and for the bytes to be
// moved off the chip after the line goes quiet.
#define GUARD_MARGIN_MS 25

void wake_watch_reset(WakeWatch* w) {
    memset(w, 0, sizeof(*w));
}

bool wake_watch_bytes_are_text(const uint8_t* bytes, size_t len) {
    for(size_t i = 0; i < len; i++) {
        uint8_t b = bytes[i];
        if(!((b >= 0x20 && b <= 0x7E) || b == '\r' || b == '\n')) return false;
    }
    return true;
}

uint32_t wake_watch_guard_ms(uint32_t baud, uint32_t fifo_full_bytes) {
    if(baud == 0) baud = 9600;
    // 10 bits a byte (start, 8 data, stop), rounded up.
    uint32_t bytes_ms = (fifo_full_bytes * 10u * 1000u + baud - 1u) / baud;
    return bytes_ms + GUARD_MARGIN_MS;
}

void wake_watch_look(WakeWatch* w, uint32_t now_ms, bool error, bool got_bytes, uint32_t guard_ms) {
    if(w->seen) return;
    if(error) {
        // Bytes read in this look, and any until the guard ends, may hold
        // the garbled byte.
        w->guarding = true;
        w->guard_until_ms = now_ms + guard_ms;
        w->candidate = false;
        return;
    }
    if(w->guarding) {
        if((int32_t)(now_ms - w->guard_until_ms) < 0) return;
        w->guarding = false;
    }
    if(w->candidate) {
        w->seen = true;
        w->seen_ms = w->candidate_ms;
    } else if(got_bytes) {
        w->candidate = true;
        w->candidate_ms = now_ms;
    }
}
