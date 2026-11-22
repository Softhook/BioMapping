#pragma once

// The recording screen — what a session shows, from the graph and top bar
// to the GPS panel, Diagnostics and Live Stream. Shared by every device;
// plain C with no device code.
//
// The layout is in the Flipper's coordinates: 128 × 64 pixels, (0, 0) at
// the top left, text placed by its baseline. It draws only through the
// calls in ScreenDraw. A device with a different screen supplies those
// calls and stretches each position to fit (see docs/cardputer_port.md,
// "Screen and keys").
//
// ── Layout units: the rule for a stretched screen ───────────────────────
// Every number passed in or out of ScreenDraw is in layout units, where the
// screen is 128 × 64 — never in the device's own pixels. That includes
// str_width()'s answer: the layout right-aligns and centres text by it
// (the nS value ends 2 units from the right edge; the elapsed time sits
// midway between its neighbours). A device that stretches by k (the
// Cardputer: 240 / 128, about 1.9) multiplies each position and size by k
// when drawing, and divides each text width by k before returning it. If
// it reported its real width instead, right-aligned text would end short
// of the edge and centred text would sit off-centre.
//
// A dot is one layout pixel, so a stretched device draws it as a k × k
// block. The graph is one dot per column; single device pixels would
// leave gaps and the line would look dotted. Lines, boxes and frames
// likewise keep their layout thickness of 1, drawn k wide.
//
// The menus, Options and calibration screens are each device's own
// (biomap_render.c on the Flipper, cardputer/src/menu_cardputer.cpp).
//
// ── Threads and the lock ────────────────────────────────────────────────
// screen_draw_session() reads the session (core/biomap_session.h), so the
// caller must hold the device's main lock — the same lock the session
// takes around every change. It does no slow work: no waits, no file or
// radio calls. It does read the GSR sensor and GPS through their own
// read-outs, which take those modules' own locks for a moment each.

#include <stdbool.h>
#include <stdint.h>

#include "biomap_session.h"

#ifdef __cplusplus
extern "C" {
#endif

#define SCREEN_W 128
#define SCREEN_H 64

// The recording mark (a filled square, top right, while recording) and the
// "REC STOPPED - SD ERROR" banner (a filled bar across the top). Named so a
// colour screen can tell these boxes from the others and colour them.
#define SCREEN_REC_MARK_X    118
#define SCREEN_REC_MARK_Y    1
#define SCREEN_REC_MARK_SIZE 8
#define SCREEN_BANNER_H      11

// The two fonts. On the Flipper, Primary is its bold title font and
// Secondary its small one; another device should use the same u8g2 fonts
// so every text width, and so every position, comes out the same.
typedef enum {
    ScreenFontPrimary,
    ScreenFontSecondary,
} ScreenFont;

// ── What each device supplies ───────────────────────────────────────────
// Every function gets `ctx` back as its first argument. All are required
// except draw_graph. All numbers are in layout units (see "Layout units" above). Drawing is in
// the current colour: black on white, until invert().
typedef struct {
    void* ctx;
    // Clear the whole screen.
    void (*clear)(void* ctx);
    void (*set_font)(void* ctx, ScreenFont font);
    // Text with its left end at x and its baseline at y.
    void (*draw_str)(void* ctx, int x, int y, const char* text);
    // Width of `text` in the current font, in layout units: a stretched
    // device divides its real width by its stretch.
    int  (*str_width)(void* ctx, const char* text);
    // One layout pixel: a k × k block on a device that stretches by k.
    void (*draw_dot)(void* ctx, int x, int y);
    // A line including both end points.
    void (*draw_line)(void* ctx, int x1, int y1, int x2, int y2);
    // A filled box and an outline box, `w` × `h` from (x, y).
    void (*draw_box)(void* ctx, int x, int y, int w, int h);
    void (*draw_frame)(void* ctx, int x, int y, int w, int h);
    // Swap the drawing colour (white on black after a filled box). Always
    // called in pairs.
    void (*invert)(void* ctx);
    // Optional (may be NULL): draw the GSR graph in the rectangle
    // (gx, gy, gw, gh) in layout units. When NULL, screen_draw_session()
    // draws the 128 × 64 frame, 10-second notches, dot-and-line curve (when
    // `visible` is true) and bottom-left zoom label through the basic calls
    // above. A device with a higher-resolution screen (the Cardputer: 240 ×
    // 135) can supply this to render its own smooth curve instead.
    void (*draw_graph)(void* ctx, const SessionCore* s, int gx, int gy, int gw, int gh,
                       bool visible);
} ScreenDraw;

// Live Stream's Bluetooth state, as the screen names it.
typedef enum {
    ScreenLinkUnavailable,
    ScreenLinkOff,
    ScreenLinkAdvertising,
    ScreenLinkConnected,
} ScreenLink;

// What the device adds for this frame: things the session doesn't hold.
typedef struct {
    // The recording's file name ("biomap_2026-11-19_14-32-05.csv"), or
    // NULL. Its start time is shown top left in GPS + RF mode while
    // recording.
    const char* file_name;
    // The latest radio reading, one per band (RF_BAND_COUNT), or NULL when
    // there is none to show (no radio, or not a radio mode).
    const float* rf_dbm;
    // Live Stream only.
    ScreenLink link;
    uint32_t   link_dropped;  // packets dropped so far
} ScreenExtras;

// Text the screen keeps between frames so it isn't formatted and measured
// again every frame. One per session: screen_cache_init() when it starts.
typedef struct {
    char  zoom_label[16];
    float zoom_label_last;
    int   zoom_label_width;
    char  ns_label[16];
    float ns_label_last;
    int   ns_label_width;
    // Widths of fixed placeholder text, measured on first use (0 = not yet).
    int   ns_worst_width;      // "-99999 nS"
    int   no_fix_width;        // "No fix"
    int   span_worst_width;    // "59m59s"
} ScreenCache;

void screen_cache_init(ScreenCache* cache);

// Draws one frame of the session's screen. The caller holds the lock (see
// the top of this file).
void screen_draw_session(const ScreenDraw* d, const SessionCore* s, const ScreenExtras* extras,
                         ScreenCache* cache);

#ifdef __cplusplus
}
#endif
