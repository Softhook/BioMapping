// Copyright (c) 2026 Christian Nold
// Licensed under the Bio Mapping Community Licence 1.0.
// See LICENCE.md in the project root for terms.

// The recording screen on the Flipper: the ten drawing calls the shared
// layout (core/biomap_screen.c) uses, written with the Flipper's canvas,
// and the screen callback that gathers each frame's figures.

#include "biomap.h"

// ==========================================================================
// Drawing calls (ScreenDraw), ctx = the Canvas
// ==========================================================================

static void fl_clear(void* ctx) {
    canvas_clear((Canvas*)ctx);
}

static void fl_set_font(void* ctx, ScreenFont font) {
    canvas_set_font((Canvas*)ctx, font == ScreenFontPrimary ? FontPrimary : FontSecondary);
}

static void fl_draw_str(void* ctx, int x, int y, const char* text) {
    canvas_draw_str((Canvas*)ctx, x, y, text);
}

static int fl_str_width(void* ctx, const char* text) {
    return canvas_string_width((Canvas*)ctx, text);
}

static void fl_draw_dot(void* ctx, int x, int y) {
    canvas_draw_dot((Canvas*)ctx, x, y);
}

static void fl_draw_line(void* ctx, int x1, int y1, int x2, int y2) {
    canvas_draw_line((Canvas*)ctx, x1, y1, x2, y2);
}

static void fl_draw_box(void* ctx, int x, int y, int w, int h) {
    canvas_draw_box((Canvas*)ctx, x, y, (size_t)w, (size_t)h);
}

static void fl_draw_frame(void* ctx, int x, int y, int w, int h) {
    canvas_draw_frame((Canvas*)ctx, x, y, (size_t)w, (size_t)h);
}

static void fl_invert(void* ctx) {
    canvas_invert_color((Canvas*)ctx);
}

static ScreenLink screen_link(BtStatus status) {
    switch(status) {
    case BtStatusConnected:   return ScreenLinkConnected;
    case BtStatusAdvertising: return ScreenLinkAdvertising;
    case BtStatusOff:         return ScreenLinkOff;
    case BtStatusUnavailable:
    default:                  return ScreenLinkUnavailable;
    }
}

// ==========================================================================
// The screen callback
// ==========================================================================

// Runs on the GUI service's own thread. Skips the frame if the main lock
// isn't free within 10 ms, so a busy main thread never holds up the GUI.
void biomap_render_callback(Canvas* c, void* ctx) {
    BioMapApp* a = (BioMapApp*)ctx;
    if(furi_mutex_acquire(a->mutex, 10) != FuriStatusOk) return;
    Session* s = &a->session;

    // The radio reading, in the radio modes with a radio panel (not
    // Diagnostics): the sampler's snapshot is guarded by its own lock,
    // held only for a 3-float copy (em_scan_sampler.h), so it is quick
    // enough here.
    float rf_dbm[RF_BAND_COUNT];
    bool rf = mode_has_rf_panel(s->core.mode) && s->em;
    if(rf) em_scan_sampler_get_snapshot(s->em, rf_dbm);

    ScreenExtras extras = {
        .file_name    = s->logger ? sd_logger_get_filename(s->logger) : NULL,
        .rf_dbm       = rf ? rf_dbm : NULL,
        .link         = s->bt_stream ? screen_link(bt_stream_get_status(s->bt_stream))
                                     : ScreenLinkUnavailable,
        .link_dropped = s->bt_stream ? bt_stream_get_drop_count(s->bt_stream) : 0,
    };
    ScreenDraw draw = {
        .ctx = c,
        .clear = fl_clear, .set_font = fl_set_font, .draw_str = fl_draw_str,
        .str_width = fl_str_width, .draw_dot = fl_draw_dot, .draw_line = fl_draw_line,
        .draw_box = fl_draw_box, .draw_frame = fl_draw_frame, .invert = fl_invert,
    };
    screen_draw_session(&draw, &s->core, &extras, &s->screen);

    furi_mutex_release(a->mutex);
}
