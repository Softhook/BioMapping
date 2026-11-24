#include "splash_cardputer.h"

#include <math.h>
#include <stdint.h>
#include <stdlib.h>

#include "splash_anim.h"

// ── RGB565 colour helpers ────────────────────────────────────────────────

static inline uint8_t clamp_u8(int v) {
    if(v < 0) return 0;
    if(v > 255) return 255;
    return (uint8_t)v;
}

static inline uint16_t pack565(uint8_t r, uint8_t g, uint8_t b) {
    return (uint16_t)(((r & 0xF8U) << 8) | ((g & 0xFCU) << 3) | (b >> 3));
}

static inline uint16_t blend565(uint8_t r0, uint8_t g0, uint8_t b0,
                                uint8_t r1, uint8_t g1, uint8_t b1,
                                float a) {
    if(a <= 0.0f) return pack565(r0, g0, b0);
    if(a >= 1.0f) return pack565(r1, g1, b1);
    uint8_t r = clamp_u8((int)((float)r0 + ((float)r1 - (float)r0) * a));
    uint8_t g = clamp_u8((int)((float)g0 + ((float)g1 - (float)g0) * a));
    uint8_t b = clamp_u8((int)((float)b0 + ((float)b1 - (float)b0) * a));
    return pack565(r, g, b);
}

static inline uint16_t scale565(uint8_t r, uint8_t g, uint8_t b, float a) {
    if(a <= 0.0f) return 0;
    if(a >= 1.0f) return pack565(r, g, b);
    return pack565(clamp_u8((int)((float)r * a)),
                   clamp_u8((int)((float)g * a)),
                   clamp_u8((int)((float)b * a)));
}

// Bio Mapping 2 arousal ramp (matching demo.css & visualiser):
//   u = 0.0 -> calm green  (#2bd96b)
//   u = 0.5 -> warm amber  (#ffd23f)
//   u = 1.0 -> coral red   (#ff5a3c)
static void spectrum_rgb(float u, uint8_t* out_r, uint8_t* out_g, uint8_t* out_b) {
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
    *out_r = clamp_u8((int)r);
    *out_g = clamp_u8((int)g);
    *out_b = clamp_u8((int)b);
}

// ── Deterministic 3-tier starfield (allocated on stack during splash only) ─

struct Star {
    float   x;
    float   y;
    uint8_t tier;   // 0 = dim far, 1 = mid, 2 = bright near
    uint8_t phase;  // twinkle phase offset
};

static const int STAR_COUNT = 56;

static void init_stars(Star* stars) {
    uint32_t rng = 0x51A7F00DU;
    for(int i = 0; i < STAR_COUNT; i++) {
        rng = rng * 1664525U + 1013904223U;
        stars[i].x = (float)((rng >> 16) % SPLASH_W);
        rng = rng * 1664525U + 1013904223U;
        stars[i].y = (float)((rng >> 16) % SPLASH_H);
        rng = rng * 1664525U + 1013904223U;
        uint32_t v = (rng >> 24) & 0xFFU;
        stars[i].tier = (v > 220) ? 2 : ((v > 125) ? 1 : 0);
        stars[i].phase = (uint8_t)(rng & 0xFFU);
    }
}

static void draw_stars(M5Canvas& canvas, const Star* stars,
                       uint32_t t_ms, const SplashFrameState& st) {
    float alpha = st.star_alpha * st.global_alpha;
    if(alpha <= 0.01f) return;

    const float cx = (float)SPLASH_W * 0.5f;
    const float cy = (float)SPLASH_H * 0.5f;
    const float t_s = (float)t_ms * 0.001f;

    for(int i = 0; i < STAR_COUNT; i++) {
        const Star& s = stars[i];
        float drift = (0.8f + (float)s.tier * 1.1f) * t_s;
        float sx = fmodf(s.x + drift, (float)SPLASH_W);
        float sy = s.y;

        float tw = 0.72f + 0.28f * sinf(t_s * (2.6f + (float)s.tier * 1.1f) + (float)s.phase * 0.025f);
        float a = alpha * tw * (0.40f + 0.30f * (float)s.tier);

        uint8_t r = (s.tier == 2) ? 240 : ((s.tier == 1) ? 175 : 105);
        uint8_t g = (s.tier == 2) ? 245 : ((s.tier == 1) ? 205 : 135);
        uint8_t b = 255;
        uint16_t col = scale565(r, g, b, a);

        if(st.star_warp > 0.04f && s.tier >= 1) {
            float dx = sx - cx;
            float dy = sy - cy;
            float dist = sqrtf(dx * dx + dy * dy);
            if(dist > 8.0f) {
                float streak = st.star_warp * (3.0f + (float)s.tier * 4.5f) * (dist / 120.0f);
                canvas.drawLine((int)lroundf(sx), (int)lroundf(sy),
                                (int)lroundf(sx + (dx / dist) * streak),
                                (int)lroundf(sy + (dy / dist) * streak), col);
                continue;
            }
        }
        int px = (int)sx;
        int py = (int)sy;
        canvas.drawPixel(px, py, col);
        if(s.tier == 2 && tw > 0.88f) {
            uint16_t halo = scale565(120, 190, 255, a * 0.40f);
            canvas.drawPixel(px - 1, py, halo);
            canvas.drawPixel(px + 1, py, halo);
            canvas.drawPixel(px, py - 1, halo);
            canvas.drawPixel(px, py + 1, halo);
        }
    }
}

// ── Fast clipped scanline polygon filler for 3D continents ───────────────

static void fill_polygon_clipped(M5Canvas& canvas, const SplashPt2* pts, size_t n, uint16_t col) {
    if(n < 3) return;
    float min_yf = pts[0].y;
    float max_yf = pts[0].y;
    for(size_t i = 1; i < n; i++) {
        if(pts[i].y < min_yf) min_yf = pts[i].y;
        if(pts[i].y > max_yf) max_yf = pts[i].y;
    }
    int y_start = (int)ceilf(min_yf);
    int y_end   = (int)floorf(max_yf);
    if(y_start < 0) y_start = 0;
    if(y_end >= SPLASH_H) y_end = SPLASH_H - 1;
    if(y_start > y_end) return;

    float nodes[48];
    for(int y = y_start; y <= y_end; y++) {
        float yf = (float)y + 0.5f;
        int count = 0;
        size_t j = n - 1;
        for(size_t i = 0; i < n; i++) {
            float yi = pts[i].y;
            float yj = pts[j].y;
            if((yi < yf && yj >= yf) || (yj < yf && yi >= yf)) {
                if(count < 48) {
                    nodes[count++] = pts[i].x + (yf - yi) / (yj - yi) * (pts[j].x - pts[i].x);
                }
            }
            j = i;
        }
        for(int a = 1; a < count; a++) {
            float key = nodes[a];
            int b = a - 1;
            while(b >= 0 && nodes[b] > key) {
                nodes[b + 1] = nodes[b];
                b--;
            }
            nodes[b + 1] = key;
        }
        for(int k = 0; k + 1 < count; k += 2) {
            int x0 = (int)ceilf(nodes[k]);
            int x1 = (int)floorf(nodes[k + 1]);
            if(x1 < 0 || x0 >= SPLASH_W) continue;
            if(x0 < 0) x0 = 0;
            if(x1 >= SPLASH_W) x1 = SPLASH_W - 1;
            if(x1 >= x0) {
                canvas.drawFastHLine(x0, y, x1 - x0 + 1, col);
            }
        }
    }
}

// ── Stage 1 & 2: 3D Stylized Earth & Orbital Dive into London ────────────

static void draw_globe_body(M5Canvas& canvas, const SplashFrameState& st, float ga) {
    const int cx = (int)lroundf(st.globe_cx);
    const int cy = (int)lroundf(st.globe_cy);
    const float R = st.globe_radius;

    // Deep-dive target ocean colour (converges smoothly over R = 105..175 so
    // there is zero brightness or position pop when the horizon leaves screen).
    const float bg_r = 4.0f  * st.global_alpha;
    const float bg_g = 6.0f  * st.global_alpha;
    const float bg_b = 12.0f * st.global_alpha;
    const float oc_r = 10.0f;
    const float oc_g = 38.0f;
    const float oc_b = 68.0f;

    float dive_blend = (R - 105.0f) / 70.0f;
    if(dive_blend < 0.0f) dive_blend = 0.0f;
    if(dive_blend > 1.0f) dive_blend = 1.0f;

    if(R >= 175.0f) {
        canvas.fillSprite(blend565((uint8_t)bg_r, (uint8_t)bg_g, (uint8_t)bg_b,
                                   (uint8_t)oc_r, (uint8_t)oc_g, (uint8_t)oc_b, ga));
        return;
    }

    int ri = (int)lroundf(R);
    if(ri < 2) return;

    // Atmospheric limb halo fades smoothly out as the horizon sweeps off screen.
    float halo_a = ga * (1.0f - dive_blend) * 0.85f;
    if(halo_a > 0.01f) {
        static const struct { int dr; uint8_t r, g, b; } HALO[] = {
            {7,  6,  28,  68},
            {5, 11,  52, 116},
            {3, 20,  94, 178},
            {2, 36, 146, 224},
            {1, 74, 204, 248},
        };
        for(size_t i = 0; i < sizeof(HALO) / sizeof(HALO[0]); i++) {
            canvas.fillCircle(cx, cy, ri + HALO[i].dr,
                              blend565((uint8_t)bg_r, (uint8_t)bg_g, (uint8_t)bg_b,
                                       HALO[i].r, HALO[i].g, HALO[i].b, halo_a));
        }
    }

    // Ocean base smoothly blends from night-side navy into the deep-dive ocean.
    uint8_t base_r = clamp_u8((int)(6.0f  + (oc_r - 6.0f)  * dive_blend));
    uint8_t base_g = clamp_u8((int)(20.0f + (oc_g - 20.0f) * dive_blend));
    uint8_t base_b = clamp_u8((int)(42.0f + (oc_b - 42.0f) * dive_blend));
    canvas.fillCircle(cx, cy, ri,
                      blend565((uint8_t)bg_r, (uint8_t)bg_g, (uint8_t)bg_b,
                               base_r, base_g, base_b, ga));

    // Sunlit inner shading circles converge to the uniform dive ocean colour
    // by R = 175 px, so the hand-over has no flash or jump.
    if(dive_blend < 0.99f) {
        static const struct { float frac; float r, g, b; } SHADE[] = {
            {0.93f,  8.0f, 30.0f,  62.0f},
            {0.82f, 11.0f, 44.0f,  86.0f},
            {0.68f, 15.0f, 60.0f, 112.0f},
            {0.52f, 20.0f, 78.0f, 138.0f},
            {0.34f, 26.0f, 96.0f, 162.0f},
        };
        float shift_scale = 1.0f - dive_blend;
        for(size_t i = 0; i < sizeof(SHADE) / sizeof(SHADE[0]); i++) {
            float rs = R * SHADE[i].frac;
            float margin = (R - rs) * shift_scale;
            int sx = cx - (int)lroundf(margin * 0.62f);
            int sy = cy - (int)lroundf(margin * 0.52f);
            int rsi = (int)lroundf(rs);
            if(rsi >= 1) {
                uint8_t sr = clamp_u8((int)(SHADE[i].r + (oc_r - SHADE[i].r) * dive_blend));
                uint8_t sg = clamp_u8((int)(SHADE[i].g + (oc_g - SHADE[i].g) * dive_blend));
                uint8_t sb = clamp_u8((int)(SHADE[i].b + (oc_b - SHADE[i].b) * dive_blend));
                canvas.fillCircle(sx, sy, rsi,
                                  blend565((uint8_t)bg_r, (uint8_t)bg_g, (uint8_t)bg_b,
                                           sr, sg, sb, ga));
            }
        }
        canvas.drawCircle(cx, cy, ri,
                          blend565((uint8_t)bg_r, (uint8_t)bg_g, (uint8_t)bg_b,
                                   96, 222, 255, halo_a));
    }
}

static void draw_graticule_arc(M5Canvas& canvas,
                               float lat0, float lon0, float lat1, float lon1,
                               int steps, const SplashFrameState& st,
                               uint8_t br, uint8_t bg, uint8_t bb,
                               uint8_t r, uint8_t g, uint8_t b, float alpha) {
    float px = 0, py = 0, pz = 0;
    bool prev_ok = false;
    for(int s = 0; s <= steps; s++) {
        float u = (float)s / (float)steps;
        float lat = lat0 + (lat1 - lat0) * u;
        float lon = lon0 + (lon1 - lon0) * u;
        float sx, sy, z;
        bool ok = splash_project_latlon(lat, lon, st.cam_lat_deg, st.cam_lon_deg,
                                        st.globe_cx, st.globe_cy, st.globe_radius,
                                        &sx, &sy, &z);
        if(ok && prev_ok && z > 0.03f && pz > 0.03f) {
            if(!((sx < -4 && px < -4) || (sx > SPLASH_W + 4 && px > SPLASH_W + 4) ||
                 (sy < -4 && py < -4) || (sy > SPLASH_H + 4 && py > SPLASH_H + 4))) {
                float zm = 0.5f * (z + pz);
                float a = alpha * (0.25f + 0.75f * zm);
                canvas.drawLine((int)lroundf(px), (int)lroundf(py),
                                (int)lroundf(sx), (int)lroundf(sy),
                                blend565(br, bg, bb, r, g, b, a));
            }
        }
        px = sx;
        py = sy;
        pz = z;
        prev_ok = ok;
    }
}

static void draw_graticule(M5Canvas& canvas, const SplashFrameState& st, float ga) {
    // Blend graticule lines over the ocean tone so faint lines never turn dark/black.
    uint8_t br = clamp_u8((int)(4.0f  + (10.0f - 4.0f)  * ga));
    uint8_t bg = clamp_u8((int)(6.0f  + (38.0f - 6.0f)  * ga));
    uint8_t bb = clamp_u8((int)(12.0f + (68.0f - 12.0f) * ga));

    for(int lat = -60; lat <= 60; lat += 30) {
        float a = (lat == 0) ? (ga * 0.42f) : (ga * 0.26f);
        draw_graticule_arc(canvas, (float)lat, -180.0f, (float)lat, 180.0f,
                           36, st, br, bg, bb, 52, 168, 212, a);
    }
    for(int lon = -180; lon < 180; lon += 30) {
        draw_graticule_arc(canvas, -80.0f, (float)lon, 80.0f, (float)lon,
                           20, st, br, bg, bb, 52, 168, 212, ga * 0.26f);
    }
}

static void draw_continents(M5Canvas& canvas, const SplashFrameState& st, float ga) {
    size_t count = 0;
    const SplashContinent* list = splash_continents(&count);
    SplashPt2 clipped[48];

    // Blend continents toward the #04060c deep-space background (never pure black)
    // so fading landmasses dissolve invisibly instead of turning into dark cutouts.
    uint8_t bg_r = clamp_u8((int)(4.0f  * st.global_alpha));
    uint8_t bg_g = clamp_u8((int)(6.0f  * st.global_alpha));
    uint8_t bg_b = clamp_u8((int)(12.0f * st.global_alpha));

    for(size_t c = 0; c < count; c++) {
        const SplashContinent& cont = list[c];
        size_t cn = splash_clip_continent(&cont, st.cam_lat_deg, st.cam_lon_deg,
                                          st.globe_cx, st.globe_cy, st.globe_radius,
                                          clipped, 48);
        if(cn < 3) continue;

        uint16_t fill_col = cont.is_focus
            ? blend565(bg_r, bg_g, bg_b, 22, 108, 92, ga)
            : blend565(bg_r, bg_g, bg_b, 16,  82, 74, ga);
        fill_polygon_clipped(canvas, clipped, cn, fill_col);

        uint8_t cr = cont.is_focus ? 82  : 46;
        uint8_t cg = cont.is_focus ? 245 : 212;
        uint8_t cb = cont.is_focus ? 175 : 148;
        uint16_t edge_col = blend565(bg_r, bg_g, bg_b, cr, cg, cb, ga);

        for(size_t i = 0; i < cont.count; i++) {
            size_t j = (i + 1) % cont.count;
            float x0, y0, z0, x1, y1, z1;
            bool ok0 = splash_project_latlon((float)cont.pts[i].lat10 * 0.1f,
                                             (float)cont.pts[i].lon10 * 0.1f,
                                             st.cam_lat_deg, st.cam_lon_deg,
                                             st.globe_cx, st.globe_cy, st.globe_radius,
                                             &x0, &y0, &z0);
            bool ok1 = splash_project_latlon((float)cont.pts[j].lat10 * 0.1f,
                                             (float)cont.pts[j].lon10 * 0.1f,
                                             st.cam_lat_deg, st.cam_lon_deg,
                                             st.globe_cx, st.globe_cy, st.globe_radius,
                                             &x1, &y1, &z1);
            if(ok0 && ok1 && z0 > 0.02f && z1 > 0.02f) {
                if(!((x0 < -4 && x1 < -4) || (x0 > SPLASH_W + 4 && x1 > SPLASH_W + 4) ||
                     (y0 < -4 && y1 < -4) || (y0 > SPLASH_H + 4 && y1 > SPLASH_H + 4))) {
                    canvas.drawLine((int)lroundf(x0), (int)lroundf(y0),
                                    (int)lroundf(x1), (int)lroundf(y1), edge_col);
                }
            }
        }
    }
}

static void draw_beacon(M5Canvas& canvas, const SplashFrameState& st) {
    float ba = st.beacon_alpha * st.global_alpha;
    if(ba <= 0.01f) return;

    float bx, by, bz;
    if(!splash_project_latlon(SPLASH_TARGET_LAT_DEG, SPLASH_TARGET_LON_DEG,
                              st.cam_lat_deg, st.cam_lon_deg,
                              st.globe_cx, st.globe_cy, st.globe_radius,
                              &bx, &by, &bz) || bz < 0.08f) {
        return;
    }

    int ix = (int)lroundf(bx);
    int iy = (int)lroundf(by);
    float zoom_norm = (st.globe_radius - 46.0f) / 414.0f;
    if(zoom_norm < 0.0f) zoom_norm = 0.0f;
    if(zoom_norm > 1.0f) zoom_norm = 1.0f;
    float max_r = 16.0f + zoom_norm * 40.0f;

    // Blend beacon rings over the current underlying ocean/space tone so fading
    // rings dissolve invisibly instead of painting dark rings over bright land.
    float ga = st.globe_alpha * st.global_alpha;
    uint8_t br_bg = clamp_u8((int)(4.0f  + (14.0f - 4.0f)  * ga));
    uint8_t bg_bg = clamp_u8((int)(6.0f  + (56.0f - 6.0f)  * ga));
    uint8_t bb_bg = clamp_u8((int)(12.0f + (78.0f - 12.0f) * ga));

    for(int ring = 0; ring < 2; ring++) {
        float p = fmodf(st.beacon_phase + (float)ring * 0.5f, 1.0f);
        float rr = 2.0f + p * max_r;
        float ra = ba * (1.0f - p) * (1.0f - p);
        if(ra < 0.08f) continue;  // stop before ring fades below background
        uint8_t cr, cg, cb;
        spectrum_rgb(1.0f - p, &cr, &cg, &cb);
        canvas.drawCircle(ix, iy, (int)lroundf(rr),
                          blend565(br_bg, bg_bg, bb_bg, cr, cg, cb, ra));
    }

    int br = (int)lroundf(13.0f - zoom_norm * 4.0f);
    int arm = 4;
    uint16_t bcol = blend565(br_bg, bg_bg, bb_bg, 255, 195, 95, ba * 0.85f);
    canvas.drawFastHLine(ix - br, iy - br, arm, bcol);
    canvas.drawFastVLine(ix - br, iy - br, arm, bcol);
    canvas.drawFastHLine(ix + br - arm + 1, iy - br, arm, bcol);
    canvas.drawFastVLine(ix + br, iy - br, arm, bcol);
    canvas.drawFastHLine(ix - br, iy + br, arm, bcol);
    canvas.drawFastVLine(ix - br, iy + br - arm + 1, arm, bcol);
    canvas.drawFastHLine(ix + br - arm + 1, iy + br, arm, bcol);
    canvas.drawFastVLine(ix + br, iy + br - arm + 1, arm, bcol);

    canvas.fillCircle(ix, iy, 4, blend565(br_bg, bg_bg, bb_bg, 255, 90, 60, ba * 0.60f));
    canvas.fillCircle(ix, iy, 2, blend565(br_bg, bg_bg, bb_bg, 255, 248, 240, ba));
}

// ── Stage 3: Zooming directly into the Person's Body ─────────────────────
// Shows a sleek minimal human silhouette; inside the chest, the Bio Mapping 2
// square-wave logo traces and then grows smoothly to become the project logo.

static void draw_human_body(M5Canvas& canvas, const SplashFrameState& st) {
    float ba = st.body_alpha * st.global_alpha;
    if(ba <= 0.02f) return;

    const float cx = (float)SPLASH_W * 0.5f;
    const float cy = (float)SPLASH_H * 0.5f;
    const float sc = st.body_scale;

    // Always draw the full silhouette (head + torso + arms) together from the
    // very first frame so arms never suddenly pop into view mid-zoom.
    uint16_t fill_col = blend565(4, 6, 12, 14, 34, 48, ba);
    uint16_t rim_col  = blend565(4, 6, 12, 96, 224, 218, ba * 0.92f);

    int head_r  = (int)lroundf(8.5f * sc);
    int head_y  = (int)lroundf(cy - 25.0f * sc);
    int torso_w = (int)lroundf(28.0f * sc);
    int torso_h = (int)lroundf(38.0f * sc);
    int sh_y    = (int)lroundf(cy - 13.0f * sc);
    int corner  = torso_w / 3;

    int arm_w = (int)lroundf(6.0f * sc);
    if(arm_w < 2) arm_w = 2;
    int arm_h = (int)lroundf(28.0f * sc);
    int arm_gap = (int)lroundf(2.0f * sc);
    if(arm_gap < 1) arm_gap = 1;
    int arm_y = (int)lroundf(cy - 9.0f * sc);
    if(arm_h >= 4) {
        int lx = (int)cx - torso_w / 2 - arm_gap - arm_w;
        int rx = (int)cx + torso_w / 2 + arm_gap;
        int ar = arm_w / 2;
        canvas.fillRoundRect(lx, arm_y, arm_w, arm_h, ar, fill_col);
        canvas.fillRoundRect(rx, arm_y, arm_w, arm_h, ar, fill_col);
        canvas.drawRoundRect(lx, arm_y, arm_w, arm_h, ar, rim_col);
        canvas.drawRoundRect(rx, arm_y, arm_w, arm_h, ar, rim_col);
    }

    if(torso_w >= 4 && torso_h >= 4) {
        canvas.fillRoundRect((int)cx - torso_w / 2, sh_y, torso_w, torso_h,
                             corner, fill_col);
        canvas.drawRoundRect((int)cx - torso_w / 2, sh_y, torso_w, torso_h,
                             corner, rim_col);
    }

    if(head_r >= 2) {
        canvas.fillCircle((int)cx, head_y, head_r, fill_col);
        canvas.drawCircle((int)cx, head_y, head_r, rim_col);
    }
}

// ── Bio Mapping 2 Favicon Symbol (emerges inside body -> becomes project logo) ─

static void draw_symbol_bar(M5Canvas& canvas, float x0, float y0, float x1, float y1,
                            float thick, int pad, uint16_t col) {
    float lx = (x0 < x1) ? x0 : x1;
    float rx = (x0 > x1) ? x0 : x1;
    float ty = (y0 < y1) ? y0 : y1;
    float by = (y0 > y1) ? y0 : y1;
    int px = (int)lroundf(lx) - pad;
    int py = (int)lroundf(ty) - pad;
    int pw = (int)lroundf(rx - lx + thick) + pad * 2;
    int ph = (int)lroundf(by - ty + thick) + pad * 2;
    if(pw > 0 && ph > 0) {
        canvas.fillRect(px, py, pw, ph, col);
    }
}

static void draw_biomapping_symbol(M5Canvas& canvas, const SplashFrameState& st) {
    float sa = st.symbol_alpha * st.global_alpha;
    if(sa <= 0.01f || st.symbol_progress <= 0.005f) return;

    size_t vcount = 0;
    float total_len = 20.0f;
    const SplashSymPt* path = splash_symbol_path(&vcount, &total_len);
    if(!path || vcount < 2) return;

    const float cell = st.symbol_cell;
    const float origin_x = ((float)SPLASH_W - 10.0f * cell) * 0.5f;
    const float origin_y = st.symbol_cy - 5.0f * cell;

    float target_dist = st.symbol_progress * total_len;
    // Soft glow blends smoothly from the dark backdrop (no abrupt pad-size jump).
    uint16_t glow_col = blend565(4, 6, 12, 48, 210, 195, sa * st.symbol_glow * 0.42f);
    uint16_t bar_col  = blend565(4, 6, 12, 244, 241, 234, sa);

    float tip_x = origin_x + (float)path[0].x * cell + cell * 0.5f;
    float tip_y = origin_y + (float)path[0].y * cell + cell * 0.5f;

    int start_pass = (st.symbol_glow > 0.06f) ? 0 : 1;
    for(int pass = start_pass; pass < 2; pass++) {
        float acc = 0.0f;
        uint16_t col = (pass == 0) ? glow_col : bar_col;
        int pad = (pass == 0) ? 1 : 0;

        for(size_t i = 0; i + 1 < vcount; i++) {
            float ax = (float)path[i].x;
            float ay = (float)path[i].y;
            float bx = (float)path[i + 1].x;
            float by = (float)path[i + 1].y;
            float seg_len = fabsf(bx - ax) + fabsf(by - ay);
            if(acc >= target_dist) break;

            float frac = 1.0f;
            if(acc + seg_len > target_dist && seg_len > 0.001f) {
                frac = (target_dist - acc) / seg_len;
            }
            float ex = ax + (bx - ax) * frac;
            float ey = ay + (by - ay) * frac;

            draw_symbol_bar(canvas,
                            origin_x + ax * cell, origin_y + ay * cell,
                            origin_x + ex * cell, origin_y + ey * cell,
                            cell, pad, col);

            if(pass == 1) {
                tip_x = origin_x + ex * cell + cell * 0.5f;
                tip_y = origin_y + ey * cell + cell * 0.5f;
            }
            acc += seg_len;
        }
    }

    // Bright tracing spark only while the square-wave is drawing inside the body.
    if(st.symbol_progress > 0.02f && st.symbol_progress < 0.99f) {
        int tx = (int)lroundf(tip_x);
        int ty = (int)lroundf(tip_y);
        canvas.fillCircle(tx, ty, 3, blend565(4, 6, 12, 255, 110, 72, sa * 0.65f));
        canvas.fillCircle(tx, ty, 2, blend565(4, 6, 12, 255, 245, 200, sa));
    }
}

// ── Title lockup ("Bio Mapping 2" + spectrum bar + "Christian Nold 2004-2026") ─

static void draw_title_lockup(M5Canvas& canvas, uint32_t t_ms,
                              const SplashFrameState& st, bool gps_waiting) {
    float ta = st.title_alpha * st.global_alpha;
    if(ta > 0.02f) {
        canvas.setFont(&fonts::FreeSansBold12pt7b);
        canvas.setTextDatum(textdatum_t::top_left);

        const char* prefix = "Bio Mapping ";
        const char* digit  = "2";
        int w_pre = canvas.textWidth(prefix);
        int w_dig = canvas.textWidth(digit);
        int total_w = w_pre + w_dig;
        int x0 = (SPLASH_W - total_w) / 2;
        int y0 = 60 + (int)lroundf(st.title_y_offset);

        uint16_t shadow = scale565(4, 8, 16, ta * 0.85f);
        canvas.setTextColor(shadow);
        canvas.drawString(prefix, x0 + 1, y0 + 1);
        canvas.drawString(digit,  x0 + w_pre + 1, y0 + 1);

        canvas.setTextColor(scale565(244, 241, 234, ta));
        canvas.drawString(prefix, x0, y0);
        canvas.setTextColor(scale565(255, 102, 68, ta));
        canvas.drawString(digit, x0 + w_pre, y0);
    }

    if(st.bar_progress > 0.01f) {
        float ba = st.global_alpha;
        const int full_w = 152;
        int half_w = (int)lroundf((float)(full_w / 2) * st.bar_progress);
        int bx0 = SPLASH_W / 2 - half_w;
        int bw  = half_w * 2;
        const int by = 90;

        float shimmer_pos = fmodf((float)t_ms * 0.0012f, 1.5f) - 0.25f;

        for(int dx = 0; dx < bw; dx++) {
            float u = (bw > 1) ? ((float)dx / (float)(bw - 1)) : 0.5f;
            uint8_t r, g, b;
            spectrum_rgb(u, &r, &g, &b);
            float glint = 0.0f;
            if(st.bar_progress > 0.85f) {
                float d = fabsf(u - shimmer_pos);
                if(d < 0.14f) glint = (1.0f - d / 0.14f) * 0.55f;
            }
            uint16_t col = blend565(
                clamp_u8((int)((float)r * ba)),
                clamp_u8((int)((float)g * ba)),
                clamp_u8((int)((float)b * ba)),
                clamp_u8((int)(255.0f * ba)),
                clamp_u8((int)(255.0f * ba)),
                clamp_u8((int)(255.0f * ba)),
                glint);
            canvas.drawFastVLine(bx0 + dx, by, 3, col);
        }
    }

    float ca = st.coord_alpha * st.global_alpha;
    if(ca > 0.02f) {
        canvas.setFont(&fonts::Font2);
        canvas.setTextDatum(textdatum_t::top_center);
        if(gps_waiting) {
            float pulse = 0.70f + 0.30f * sinf((float)t_ms * 0.007f);
            canvas.setTextColor(scale565(255, 210, 63, ca * pulse));
            canvas.drawString("Starting GPS...", SPLASH_W / 2, 102);
        } else {
            canvas.setTextColor(scale565(198, 224, 240, ca));
            canvas.drawString("Christian Nold 2004-2026", SPLASH_W / 2, 102);
        }
        canvas.setTextDatum(textdatum_t::top_left);
    }
}

static void render_frame(M5Canvas& canvas, const Star* stars, uint32_t t_ms,
                         float extra_fade, bool gps_waiting) {
    SplashFrameState st = {};
    splash_eval_frame(t_ms, &st);
    st.global_alpha *= extra_fade;

    canvas.fillSprite(scale565(4, 6, 12, st.global_alpha));

    draw_stars(canvas, stars, t_ms, st);

    float ga = st.globe_alpha * st.global_alpha;
    if(ga > 0.015f) {
        draw_globe_body(canvas, st, ga);
        draw_graticule(canvas, st, ga);
        draw_continents(canvas, st, ga);
    }

    draw_beacon(canvas, st);
    draw_human_body(canvas, st);
    draw_biomapping_symbol(canvas, st);
    draw_title_lockup(canvas, t_ms, st, gps_waiting);

    canvas.pushSprite(0, 0);
}

void splash_cardputer_play(M5Canvas& canvas,
                           bool (*is_background_done)(void),
                           bool sound_enabled) {
    Star stars[STAR_COUNT];
    init_stars(stars);

    // One-shot bell sample (freed immediately after Speaker.stop() on exit).
    // Each melody note plays completely in one hardware-mixed channel with
    // zero chunk streaming, so frame timing can never cause audio glitches.
    int16_t* bell_buf = nullptr;
    size_t melody_count = 0;
    const SplashMelodyNote* melody = splash_melody_notes(&melody_count);
    size_t next_note = 0;
    if(sound_enabled) {
        bell_buf = static_cast<int16_t*>(malloc(SPLASH_BELL_SAMPLES * sizeof(int16_t)));
        if(bell_buf) {
            splash_audio_make_bell(bell_buf, SPLASH_BELL_SAMPLES);
        }
    }

    const uint32_t FRAME_MS = 16;  // ~60 FPS target
    const uint32_t SKIP_FADE_MS = 140;
    uint32_t start_ms = millis();
    bool skip_requested = false;
    bool skipping = false;
    uint32_t skip_start_ms = 0;
    bool finish_fading = false;
    uint32_t finish_start_ms = 0;

    // Ignore any key already held down at power-on; require a fresh press.
    M5Cardputer.update();
    bool prev_kb_pressed = M5Cardputer.Keyboard.isPressed();

    for(;;) {
        uint32_t frame_start = millis();
        uint32_t elapsed = frame_start - start_ms;
        bool bg_done = is_background_done ? is_background_done() : true;

        // Fire any due melody note as a single self-contained one-shot.
        if(bell_buf && !skipping) {
            while(next_note < melody_count && elapsed >= melody[next_note].t_ms) {
                uint32_t rate = (uint32_t)lroundf(
                    (float)SPLASH_BELL_BASE_RATE * (melody[next_note].freq_hz / SPLASH_BELL_BASE_HZ));
                M5Cardputer.Speaker.playRaw(bell_buf, SPLASH_BELL_SAMPLES, rate,
                                            false, 1, melody[next_note].channel, true);
                next_note++;
            }
        }

        // Pressing any keyboard key or the G0 button skips the animation.
        M5Cardputer.update();
        bool kb_pressed = M5Cardputer.Keyboard.isPressed();
        bool new_key = (kb_pressed && !prev_kb_pressed) || M5Cardputer.BtnA.wasPressed();
        prev_kb_pressed = kb_pressed;

        if(new_key && !skipping && !finish_fading) {
            skip_requested = true;
        }
        if(skip_requested && bg_done && !skipping && !finish_fading) {
            skipping = true;
            skip_start_ms = frame_start;
            if(bell_buf) {
                M5Cardputer.Speaker.stop();
            }
        }

        uint32_t anim_t_ms = elapsed;
        float extra_fade = 1.0f;
        bool gps_waiting = false;

        if(skipping) {
            uint32_t fe = frame_start - skip_start_ms;
            if(fe >= SKIP_FADE_MS) break;
            extra_fade = 1.0f - splash_ease(SplashEaseInOutCubic, (float)fe / (float)SKIP_FADE_MS);
            if(anim_t_ms > SPLASH_HOLD_MS) anim_t_ms = SPLASH_HOLD_MS;
        } else if(finish_fading) {
            uint32_t fe = frame_start - finish_start_ms;
            if(fe >= SPLASH_FADE_OUT_MS) break;
            anim_t_ms = SPLASH_HOLD_MS + fe;
        } else if(elapsed >= SPLASH_HOLD_MS) {
            if(bg_done) {
                finish_fading = true;
                finish_start_ms = frame_start;
                anim_t_ms = SPLASH_HOLD_MS;
            } else {
                anim_t_ms = SPLASH_HOLD_MS;
                gps_waiting = true;
            }
        }

        render_frame(canvas, stars, anim_t_ms, extra_fade, gps_waiting);

        // Always wait at least 1 ms, even after a slow frame, so the GPS task
        // and the system get a turn.
        uint32_t spent = millis() - frame_start;
        delay(spent < FRAME_MS ? FRAME_MS - spent : 1);
    }

    // Stop speaker and wait for hardware task to release bell_buf before freeing it.
    if(bell_buf) {
        M5Cardputer.Speaker.stop();
        uint32_t wait_end = millis() + 80;
        while(M5Cardputer.Speaker.isPlaying() && millis() < wait_end) {
            delay(1);
        }
        free(bell_buf);
    }

    // Drain any release event from the skip button so it doesn't trigger a menu item.
    if(skipping) {
        uint32_t drain_end = millis() + 120;
        while(millis() < drain_end) {
            M5Cardputer.update();
            if(!M5Cardputer.Keyboard.isPressed() && !M5Cardputer.BtnA.isPressed()) break;
            delay(5);
        }
        M5Cardputer.update();
    }

    // Restore clean default canvas state so nothing leaks into the rest of the UI.
    canvas.fillSprite(TFT_BLACK);
    canvas.setFont(&fonts::Font2);
    canvas.setTextDatum(textdatum_t::top_left);
    canvas.setTextColor(TFT_WHITE, TFT_BLACK);
}
