// biomap_render.h — Canvas rendering callbacks for Bio Mapping
//
// Extracted from biomap_gui.c: all draw-callback functions used by
// ViewPorts throughout the application, plus shared context structs.

#pragma once

#include <gui/gui.h>
#include <stdbool.h>

typedef struct BioMapApp BioMapApp;

// ── Menu & options constants (shared with biomap_gui.c) ────────────────────

#define MENU_COUNT      5
#define OPTIONS_COUNT   3

extern const char* const menu_labels[MENU_COUNT];
extern const char* const options_labels[OPTIONS_COUNT];

// ── Context structs shared between GUI orchestration and renderers ─────────

typedef struct {
    bool conv_ok;
    char conv_name[32];
    int  conv_points;
    int  spinner_frame;   // spinner animation frame (0-3)
} ConvResult;

typedef struct {
    BioMapApp* app;
    int32_t    selection;
} MenuContext;

typedef struct {
    BioMapApp* app;
    int32_t    selection;
} OptionsContext;

// ── Render callbacks ───────────────────────────────────────────────────────

// Recording view — live display during data logging (GPS+GSR / GPS-only / GSR-only)
void biomap_render_callback(Canvas* c, void* ctx);

// "Converting..." spinner screen shown during GPX conversion
void conv_progress_render(Canvas* c, void* ctx);

// Conversion result screen (OK / FAILED with CSV, GPX, point count)
void conv_status_render(Canvas* c, void* ctx);

// Main launch menu renderer (GPS+GSR, GPS Only, GSR Only, Convert, Options)
void menu_render(Canvas* c, void* ctx);

// Options screen renderer (Reset GPS, Auto-zoom, Backlight toggles)
void options_render(Canvas* c, void* ctx);

// Shared helper: draw a vertical selection list with inverse-bar highlight
void draw_selection_list(Canvas* c, int sel, int count,
                         const char* const* labels, int start_y);
