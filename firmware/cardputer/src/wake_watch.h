#pragma once

// The wake-up wait's "first clean byte" check on the Cardputer
// (gps_cardputer.cpp). Plain C with no Arduino code, so the host tests can
// run it (tests/test_cardputer_rules.c).
//
// The ESP32's serial driver doesn't flag each byte. It reports a garbled
// byte (framing, parity, break) separately, as soon as the byte reaches the
// serial chip. The byte itself can only be read later: the driver moves
// bytes off the chip once the line has been quiet for one byte's time, or
// once the chip holds a set number of bytes (RX_FIFO_FULL_BYTES in
// gps_cardputer.cpp). So the report usually comes first, and the garbled
// byte turns up some time after it.
//
// So after a report, every byte read is thrown away until the guard time
// has passed (the latest the garbled byte can turn up). After that, a byte
// counts as clean once the next look brings no report either.
//
// The time given for the first clean byte is when it could be read, so it
// can be up to the guard time later than it arrived.

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    bool     seen;  // a clean byte has been confirmed
    uint32_t seen_ms;
    bool     candidate;  // clean bytes read once, not yet confirmed
    uint32_t candidate_ms;
    bool     guarding;  // a report came; bytes don't count until guard_until_ms
    uint32_t guard_until_ms;
} WakeWatch;

void wake_watch_reset(WakeWatch* w);

// How long after a report a garbled byte can still turn up: the time for
// `fifo_full_bytes` bytes at `baud`, plus a margin for the driver's own
// task.
uint32_t wake_watch_guard_ms(uint32_t baud, uint32_t fifo_full_bytes);

// One look. `error`: a garbled-byte report since the last look, taken
// BEFORE the bytes were read. `got_bytes`: bytes were read (and thrown
// away) in this look.
void wake_watch_look(WakeWatch* w, uint32_t now_ms, bool error, bool got_bytes, uint32_t guard_ms);

#ifdef __cplusplus
}
#endif
