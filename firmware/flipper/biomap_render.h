// biomap_render.h — the menu, Options and calibration screens' draw
// callbacks. The recording screen's is in flipper/biomap_screen_flipper.h.
//
// All shared types (ListContext, WizardState) and screen constants
// (MENU_COUNT, OPTIONS_COUNT) live in biomap.h — this header declares only
// the draw-callback functions used by the GUI control layer.

#pragma once

#include <gui/gui.h>

// ── Render callbacks ───────────────────────────────────────────────────────

// Main launch menu renderer
void menu_render(Canvas* c, void* ctx);

// Options screen renderer
void options_render(Canvas* c, void* ctx);

// Calibration menu and wizard renderers
void calibration_menu_render(Canvas* c, void* ctx);
void calibration_wizard_render(Canvas* c, void* ctx);
void show_current_calibration_render(Canvas* c, void* ctx);

// RF Faraday calibration menu and wizard renderers
void rf_calibration_menu_render(Canvas* c, void* ctx);
void rf_calibration_wizard_prep_render(Canvas* c, void* ctx);
void rf_calibration_wizard_sampling_render(Canvas* c, void* ctx);
void rf_calibration_wizard_stats_render(Canvas* c, void* ctx);
void rf_show_current_calibration_render(Canvas* c, void* ctx);

