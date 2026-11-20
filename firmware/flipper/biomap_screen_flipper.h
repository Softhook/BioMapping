#pragma once

// The recording screen on the Flipper (biomap_screen_flipper.c). The
// layout itself is shared: core/biomap_screen.h.

#include <gui/gui.h>

// The recording screen's draw callback; ctx is the BioMapApp.
void biomap_render_callback(Canvas* c, void* ctx);
