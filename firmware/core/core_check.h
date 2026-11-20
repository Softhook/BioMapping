#pragma once

// Stopping on a broken rule in the shared code (a NULL pointer, memory
// running out). Unlike assert(), CORE_CHECK is never compiled out: the
// Flipper build defines FURI_NDEBUG, which would silence an assert, and on
// the Flipper's chip reading through a NULL pointer doesn't fault (address
// 0 is flash), so an unchecked NULL would carry on with garbage.
//
// Each device supplies core_fatal(): the Flipper crashes with the message
// (flipper/core_fatal.c), the host tests abort through the same file.

#ifdef __cplusplus
extern "C" {
#endif

__attribute__((noreturn)) void core_fatal(const char* msg);

#ifdef __cplusplus
}
#endif

#define CORE_CHECK(cond, msg) \
    do {                      \
        if(!(cond)) core_fatal(msg); \
    } while(0)
