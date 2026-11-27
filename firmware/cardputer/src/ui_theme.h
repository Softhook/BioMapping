#pragma once

// Shared 240 x 135 screen dimensions, backlight levels, RGB565 palette,
// Bio Mapping 2 arousal colour ramp, and header/footer bars used across the
// Cardputer UI screens.

#include <M5Cardputer.h>
#include <stdint.h>

static const int UI_SCREEN_W = 240;
static const int UI_SCREEN_H = 135;

// Bright (normal, also used for QR codes) vs dim (power-saving) backlight.
static const uint8_t UI_BRIGHTNESS_ON  = 128;
static const uint8_t UI_BRIGHTNESS_DIM = 24;

// Shared RGB565 theme palette.
static const uint16_t UI_COL_HEADER_BG = 0x10A4;  // deep navy
static const uint16_t UI_COL_SEL_BG    = 0x02B3;  // rich blue highlight
static const uint16_t UI_COL_SEL_EDGE  = 0x07FF;  // cyan accent bar
static const uint16_t UI_COL_FOOTER_BG = 0x1082;  // dark slate footer
static const uint16_t UI_COL_MUTED     = 0x8410;  // mid grey
static const uint16_t UI_COL_FRAME     = 0x2965;  // slate graph border
static const uint16_t UI_COL_GRID      = 0x10A2;  // subtle dark grid

inline uint8_t ui_clamp_u8(int v) {
    if(v < 0) return 0;
    if(v > 255) return 255;
    return (uint8_t)v;
}

inline uint16_t ui_pack565(uint8_t r, uint8_t g, uint8_t b) {
    return (uint16_t)(((r & 0xF8U) << 8) | ((g & 0xFCU) << 3) | (b >> 3));
}

inline uint16_t ui_blend565(uint8_t r0, uint8_t g0, uint8_t b0,
                            uint8_t r1, uint8_t g1, uint8_t b1,
                            float a) {
    if(a <= 0.0f) return ui_pack565(r0, g0, b0);
    if(a >= 1.0f) return ui_pack565(r1, g1, b1);
    uint8_t r = ui_clamp_u8((int)((float)r0 + ((float)r1 - (float)r0) * a));
    uint8_t g = ui_clamp_u8((int)((float)g0 + ((float)g1 - (float)g0) * a));
    uint8_t b = ui_clamp_u8((int)((float)b0 + ((float)b1 - (float)b0) * a));
    return ui_pack565(r, g, b);
}

inline uint16_t ui_scale565(uint8_t r, uint8_t g, uint8_t b, float a) {
    if(a <= 0.0f) return 0;
    if(a >= 1.0f) return ui_pack565(r, g, b);
    return ui_pack565(ui_clamp_u8((int)((float)r * a)),
                      ui_clamp_u8((int)((float)g * a)),
                      ui_clamp_u8((int)((float)b * a)));
}

// Bio Mapping 2 arousal ramp (matching demo.css & visualiser):
//   u = 0.0 -> calm green  (#2bd96b)
//   u = 0.5 -> warm amber  (#ffd23f)
//   u = 1.0 -> coral red   (#ff5a3c)
inline void ui_spectrum_rgb(float u, uint8_t* out_r, uint8_t* out_g, uint8_t* out_b) {
    if(u < 0.0f) u = 0.0f;
    if(u > 1.0f) u = 1.0f;
    float r, g, b;
    if(u < 0.5f) {
        float k = u * 2.0f;
        r = 43.0f  + (255.0f - 43.0f)  * k;
        g = 217.0f + (210.0f - 217.0f) * k;
        b = 107.0f + (63.0f  - 107.0f) * k;
    } else {
        float k = (u - 0.5f) * 2.0f;
        r = 255.0f;
        g = 210.0f + (90.0f - 210.0f) * k;
        b = 63.0f  + (60.0f - 63.0f)  * k;
    }
    *out_r = ui_clamp_u8((int)r);
    *out_g = ui_clamp_u8((int)g);
    *out_b = ui_clamp_u8((int)b);
}

inline uint16_t ui_spectrum565(float u, float brightness = 1.0f) {
    uint8_t r, g, b;
    ui_spectrum_rgb(u, &r, &g, &b);
    return ui_scale565(r, g, b, brightness);
}

inline void ui_draw_header(M5Canvas& canvas, const char* title,
                           const char* right_text = nullptr,
                           uint16_t right_col = TFT_LIGHTGREY) {
    canvas.fillRect(0, 0, UI_SCREEN_W, 22, UI_COL_HEADER_BG);
    canvas.drawFastHLine(0, 22, UI_SCREEN_W, UI_COL_SEL_EDGE);
    canvas.setFont(&fonts::Font2);
    canvas.setTextDatum(textdatum_t::top_left);
    canvas.setTextColor(TFT_WHITE);
    canvas.drawString(title, 6, 3);
    canvas.drawString(title, 7, 3);  // bold title
    if(right_text && right_text[0]) {
        canvas.setTextColor(right_col);
        int w = canvas.textWidth(right_text);
        canvas.drawString(right_text, UI_SCREEN_W - w - 6, 3);
    }
}

inline void ui_draw_footer(M5Canvas& canvas, const char* text,
                           uint16_t col = TFT_LIGHTGREY) {
    canvas.fillRect(0, 117, UI_SCREEN_W, 18, UI_COL_FOOTER_BG);
    canvas.drawFastHLine(0, 116, UI_SCREEN_W, TFT_DARKGREY);
    canvas.setFont(&fonts::Font2);
    canvas.setTextDatum(textdatum_t::top_left);
    canvas.setTextColor(col);
    canvas.drawString(text, 6, 118);
}
