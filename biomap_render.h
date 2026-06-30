// biomap_render.h — Canvas rendering callbacks for Bio Mapping ViewPorts.
//
// All shared types (ConvResult, MenuContext, OptionsContext) and screen
// constants (MENU_COUNT, OPTIONS_COUNT) live in biomap.h — this header
// declares only the draw-callback functions used by the GUI control layer.

#pragma once

#include <gui/gui.h>

// ── Render callbacks ───────────────────────────────────────────────────────

// Recording view — live display during data logging (GPS+GSR / GPS-only / GSR-only)
void biomap_render_callback(Canvas* c, void* ctx);

// "Converting..." spinner screen shown during GPX conversion
void conv_progress_render(Canvas* c, void* ctx);

// Conversion result screen (OK / FAILED with CSV, GPX, point count)
void conv_status_render(Canvas* c, void* ctx);

// Main launch menu renderer
void menu_render(Canvas* c, void* ctx);

// Options screen renderer (Reset GPS, Auto-zoom, Backlight toggles)
void options_render(Canvas* c, void* ctx);
