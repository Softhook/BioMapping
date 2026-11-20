// core_fatal() for the Flipper: see core/core_check.h.

#include "core/core_check.h"
#include <furi.h>

void core_fatal(const char* msg) {
    furi_crash(msg);
}
