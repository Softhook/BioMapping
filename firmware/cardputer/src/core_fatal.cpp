// core_fatal() for the Cardputer: see core/core_check.h.
//
// The shared code calls this when one of its rules is broken (a NULL
// pointer, memory running out). Like the Flipper's crash screen, it shows
// the message and stops. It writes straight to the display, not through a
// sprite, so it works even when memory has run out.

#include <M5Cardputer.h>

#include "core_check.h"

void core_fatal(const char* msg) {
    Serial.printf("core_fatal: %s\n", msg);
    Serial.flush();
    auto& d = M5Cardputer.Display;
    d.fillScreen(TFT_RED);
    d.setTextColor(TFT_WHITE, TFT_RED);
    d.setFont(&fonts::Font2);
    d.setCursor(4, 4);
    d.println("BioMapping stopped:");
    d.println(msg);
    d.println();
    d.println("Restart the Cardputer.");
    for(;;) delay(1000);
}
