#include "splash_anim.h"

#include <math.h>
#include <string.h>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

static const float DEG_TO_RAD = (float)(M_PI / 180.0);
static const float TWO_PI = (float)(2.0 * M_PI);

static float clamp01(float x) {
    if(x < 0.0f) return 0.0f;
    if(x > 1.0f) return 1.0f;
    return x;
}

float splash_ease(SplashEase ease, float t) {
    t = clamp01(t);
    switch(ease) {
    case SplashEaseLinear:
        return t;
    case SplashEaseOutCubic: {
        float u = 1.0f - t;
        return 1.0f - u * u * u;
    }
    case SplashEaseInOutCubic:
        if(t < 0.5f) {
            return 4.0f * t * t * t;
        } else {
            float u = -2.0f * t + 2.0f;
            return 1.0f - (u * u * u) * 0.5f;
        }
    case SplashEaseOutQuart: {
        float u = 1.0f - t;
        float u2 = u * u;
        return 1.0f - u2 * u2;
    }
    case SplashEaseOutBack: {
        // Standard smooth_ui_toolkit / easings.net back overshoot (c1 = 1.70158).
        const float c1 = 1.70158f;
        const float c3 = c1 + 1.0f;
        float u = t - 1.0f;
        return 1.0f + c3 * u * u * u + c1 * u * u;
    }
    }
    return t;
}

// `from` until start_ms, then eased towards `to` over dur_ms.
static float splash_tween(uint32_t t_ms, uint32_t start_ms, uint32_t dur_ms,
                          float from, float to, SplashEase ease) {
    if(t_ms <= start_ms) return from;
    if(dur_ms == 0 || t_ms >= start_ms + dur_ms) return to;
    float u = (float)(t_ms - start_ms) / (float)dur_ms;
    return from + (to - from) * splash_ease(ease, u);
}

void splash_eval_frame(uint32_t t_ms, SplashFrameState* out) {
    if(!out) return;

    // Master fade-in (0..260 ms) and fade-out (9100..9350 ms).
    float fade_in = splash_tween(t_ms, 0, 260, 0.0f, 1.0f, SplashEaseOutCubic);
    float fade_out = splash_tween(t_ms, SPLASH_HOLD_MS, SPLASH_FADE_OUT_MS,
                                  1.0f, 0.0f, SplashEaseInOutCubic);
    out->global_alpha = fade_in * fade_out;

    // ── Stage 1 & 2: Extended spinning Earth -> orbital dive into London ─
    // Starfield stays bright while Earth spins in space, dims during the dive.
    float star_dim = splash_tween(t_ms, 3050, 750, 1.0f, 0.0f, SplashEaseInOutCubic);
    out->star_alpha = fade_in * star_dim;

    float warp_in  = splash_tween(t_ms, 2100, 550, 0.0f, 1.0f, SplashEaseInOutCubic);
    float warp_out = splash_tween(t_ms, 3100, 600, 1.0f, 0.0f, SplashEaseOutCubic);
    out->star_warp = warp_in * warp_out;

    // Planet eases into space (0..450 ms), spins gracefully for ~1.65 s (until
    // 2100 ms), then dives smoothly & logarithmically into London (2100..3900 ms).
    if(t_ms < 2100) {
        out->globe_radius = splash_tween(t_ms, 0, 450, 14.0f, 46.0f, SplashEaseOutBack);
    } else {
        float zoom_u = splash_tween(t_ms, 2100, 1800, 0.0f, 1.0f, SplashEaseInOutCubic);
        out->globe_radius = 46.0f * powf(460.0f / 46.0f, zoom_u);
    }
    out->globe_cx = (float)SPLASH_W * 0.5f;
    out->globe_cy = splash_tween(t_ms, 2100, 1500, 71.0f, (float)SPLASH_H * 0.5f,
                                 SplashEaseInOutCubic);

    // Sweeps west-to-east across +78 deg -> +14 deg in space (Middle East,
    // Africa, Europe, and Great Britain turning smoothly across the sunlit disk),
    // then locks onto London (-0.13 deg, +51.51 deg) during the dive.
    if(t_ms < 2100) {
        out->cam_lon_deg = splash_tween(t_ms, 0, 2100, 78.0f, 14.0f, SplashEaseLinear);
        out->cam_lat_deg = splash_tween(t_ms, 0, 2100, 15.0f, 30.0f, SplashEaseInOutCubic);
    } else {
        out->cam_lon_deg = splash_tween(t_ms, 2100, 1600, 14.0f, SPLASH_TARGET_LON_DEG,
                                        SplashEaseInOutCubic);
        out->cam_lat_deg = splash_tween(t_ms, 2100, 1600, 30.0f, SPLASH_TARGET_LAT_DEG,
                                        SplashEaseInOutCubic);
    }

    // Globe melts smoothly into pure #04060c dark space (3480..4020 ms) BEFORE
    // the human silhouette fades in, eliminating any cross-layer visual clash.
    out->globe_alpha = splash_tween(t_ms, 3480, 540, 1.0f, 0.0f, SplashEaseInOutCubic);

    // London target beacon ignites as Britain rotates to front (~1350 ms) and
    // bridges the map-to-body handoff cleanly at screen centre.
    float b_in  = splash_tween(t_ms, 1350, 320, 0.0f, 1.0f, SplashEaseOutCubic);
    float b_out = splash_tween(t_ms, 3960, 420, 1.0f, 0.0f, SplashEaseInOutCubic);
    out->beacon_alpha = b_in * b_out;
    out->beacon_phase = (t_ms > 1350) ? ((float)(t_ms - 1350) * 0.0017f) : 0.0f;

    // ── Stage 3: Directly into the person's body (4000..5920 ms) ─────────
    // Emerges cleanly out of the London beacon once the map has vanished,
    // grows steadily, and dissolves completely to 0 before the title lockup.
    float bd_in  = splash_tween(t_ms, 4000, 420, 0.0f, 1.0f, SplashEaseOutCubic);
    float bd_out = splash_tween(t_ms, 5260, 660, 1.0f, 0.0f, SplashEaseInOutCubic);
    out->body_alpha = bd_in * bd_out;
    float bd_u = splash_tween(t_ms, 4000, 1920, 0.0f, 1.0f, SplashEaseLinear);
    out->body_scale = 0.42f * powf(4.2f / 0.42f, bd_u);

    // ── Stage 4: Square-wave symbol inside body -> final project logo ────
    // Traces cleanly inside the chest (4520..5200 ms), grows continuously with
    // the body zoom, and glides up into the bold Bio Mapping 2 project logo.
    out->symbol_alpha = splash_tween(t_ms, 4500, 220, 0.0f, 1.0f, SplashEaseOutCubic);
    out->symbol_progress = splash_tween(t_ms, 4520, 680, 0.0f, 1.0f, SplashEaseOutCubic);
    float sym_u = splash_tween(t_ms, 4500, 1480, 0.0f, 1.0f, SplashEaseInOutCubic);
    out->symbol_cell = 1.5f * powf(5.5f / 1.5f, sym_u);
    out->symbol_cy = splash_tween(t_ms, 5260, 760, (float)SPLASH_H * 0.5f, 31.0f,
                                  SplashEaseInOutCubic);
    float glow_in  = splash_tween(t_ms, 4500, 300, 0.0f, 1.0f, SplashEaseOutCubic);
    float glow_out = splash_tween(t_ms, 5400, 560, 1.0f, 0.0f, SplashEaseInOutCubic);
    out->symbol_glow = glow_in * glow_out;

    // ── Stage 5: Clean Bio Mapping 2 title lockup (5900..9100 ms) ────────
    out->title_alpha = splash_tween(t_ms, 5900, 360, 0.0f, 1.0f, SplashEaseOutCubic);
    out->title_y_offset = splash_tween(t_ms, 5900, 420, 10.0f, 0.0f, SplashEaseOutCubic);

    out->bar_progress = splash_tween(t_ms, 6040, 380, 0.0f, 1.0f, SplashEaseOutQuart);

    // "Christian Nold 2004-2026" fades in cleanly (6180..6480 ms), leaving ~2.62 s
    // of calm, steady hold on the finished title screen before fade-out.
    out->coord_alpha = splash_tween(t_ms, 6180, 300, 0.0f, 1.0f, SplashEaseOutCubic);

}

// ── Simplified world continent outlines (tenths of a degree) ─────────────

static const SplashGeoPt CONT_GREAT_BRITAIN[] = {
    {501, -55}, {506, -24}, {511,  14}, {515,   7}, {527,  17},
    {537,   1}, {550, -14}, {560, -31}, {572, -20}, {586, -31},
    {585, -51}, {568, -56}, {556, -49}, {545, -36}, {533, -45},
    {516, -50}, {514, -30},
};

static const SplashGeoPt CONT_IRELAND[] = {
    {515, -98}, {522, -64}, {534, -61}, {552, -61}, {552, -83},
    {538, -99}, {525, -100},
};

static const SplashGeoPt CONT_ICELAND[] = {
    {640, -225}, {635, -180}, {650, -138}, {663, -155}, {660, -230},
};

static const SplashGeoPt CONT_SCANDINAVIA[] = {
    {580,   70}, {590,  108}, {556,  130}, {595,  188}, {652,  218},
    {602,  215}, {602,  275}, {650,  295}, {695,  300}, {710,  255},
    {692,  175}, {650,  112}, {624,   55}, {595,   52},
};

static const SplashGeoPt CONT_EUROPE[] = {
    {360,  -56}, {370,  -90}, {434,  -90}, {434,  -18}, {484,  -47},
    {509,   18}, {533,   53}, {542,   86}, {572,   98}, {554,  108},
    {540,  140}, {548,  205}, {595,  248}, {600,  300}, {560,  420},
    {470,  400}, {450,  295}, {410,  290}, {372,  225}, {405,  185},
    {450,  135}, {400,  155}, {438,   80}, {425,   32}, {368,  -20},
};

static const SplashGeoPt CONT_AFRICA[] = {
    {358,  -58}, {370,  105}, {320,  150}, {312,  323}, {220,  370},
    {118,  513}, { -10, 415}, {-150, 405}, {-260, 330}, {-344, 200},
    {-230, 144}, { -60, 122}, {  40,  95}, {  50, -20}, {  60, -108},
    {147, -174}, {270, -132},
};

static const SplashGeoPt CONT_MADAGASCAR[] = {
    {-122, 492}, {-165, 500}, {-252, 470}, {-245, 438}, {-160, 445},
};

static const SplashGeoPt CONT_ASIA[] = {
    {370,  270}, {415,  295}, {465,  405}, {560,  420}, {660,  620},
    {720,  860}, {730, 1250}, {660, 1700}, {540, 1580}, {420, 1320},
    {300, 1220}, {210, 1080}, { 90, 1050}, { 15, 1035}, {160,  960},
    {220,  880}, { 80,  775}, {230,  690}, {260,  560}, {130,  450},
    {280,  350}, {360,  360},
};

static const SplashGeoPt CONT_GREENLAND[] = {
    {600, -440}, {660, -360}, {760, -200}, {825, -320},
    {780, -680}, {680, -540},
};

static const SplashGeoPt CONT_NORTH_AMERICA[] = {
    {680, -1620}, {700, -1300}, {630,  -920}, {530,  -560}, {440,  -660},
    {350,  -755}, {252,  -805}, {300,  -880}, {210,  -970}, {150,  -860},
    { 85,  -795}, {155,  -930}, {230, -1060}, {325, -1170}, {485, -1250},
    {590, -1400}, {560, -1600},
};

static const SplashGeoPt CONT_SOUTH_AMERICA[] = {
    { 110, -750}, { 100, -620}, {  10, -500}, { -60, -350}, {-230, -430},
    {-350, -560}, {-545, -680}, {-460, -750}, {-180, -710}, { -50, -810},
    {  40, -775},
};

static const SplashGeoPt CONT_AUSTRALIA[] = {
    {-120, 1310}, {-120, 1425}, {-260, 1530}, {-378, 1495},
    {-350, 1360}, {-340, 1150}, {-220, 1140},
};

static const SplashContinent WORLD_CONTINENTS[] = {
    {CONT_AFRICA,        sizeof(CONT_AFRICA)        / sizeof(CONT_AFRICA[0]),        false},
    {CONT_EUROPE,        sizeof(CONT_EUROPE)        / sizeof(CONT_EUROPE[0]),        false},
    {CONT_SCANDINAVIA,   sizeof(CONT_SCANDINAVIA)   / sizeof(CONT_SCANDINAVIA[0]),   false},
    {CONT_ASIA,          sizeof(CONT_ASIA)          / sizeof(CONT_ASIA[0]),          false},
    {CONT_NORTH_AMERICA, sizeof(CONT_NORTH_AMERICA) / sizeof(CONT_NORTH_AMERICA[0]), false},
    {CONT_SOUTH_AMERICA, sizeof(CONT_SOUTH_AMERICA) / sizeof(CONT_SOUTH_AMERICA[0]), false},
    {CONT_GREENLAND,     sizeof(CONT_GREENLAND)     / sizeof(CONT_GREENLAND[0]),     false},
    {CONT_ICELAND,       sizeof(CONT_ICELAND)       / sizeof(CONT_ICELAND[0]),       false},
    {CONT_IRELAND,       sizeof(CONT_IRELAND)       / sizeof(CONT_IRELAND[0]),       false},
    {CONT_GREAT_BRITAIN, sizeof(CONT_GREAT_BRITAIN) / sizeof(CONT_GREAT_BRITAIN[0]), true},
    {CONT_MADAGASCAR,    sizeof(CONT_MADAGASCAR)    / sizeof(CONT_MADAGASCAR[0]),    false},
    {CONT_AUSTRALIA,     sizeof(CONT_AUSTRALIA)     / sizeof(CONT_AUSTRALIA[0]),     false},
};

const SplashContinent* splash_continents(size_t* out_count) {
    if(out_count) *out_count = sizeof(WORLD_CONTINENTS) / sizeof(WORLD_CONTINENTS[0]);
    return WORLD_CONTINENTS;
}

static void latlon_to_cam3(float lat_deg, float lon_deg,
                           float sin_clat, float cos_clat, float cam_lon_deg,
                           float* ox, float* oy, float* oz) {
    float phi = lat_deg * DEG_TO_RAD;
    float lam = (lon_deg - cam_lon_deg) * DEG_TO_RAD;
    float cphi = cosf(phi);
    float x0 = cphi * sinf(lam);
    float y0 = sinf(phi);
    float z0 = cphi * cosf(lam);

    *ox = x0;
    *oy = y0 * cos_clat - z0 * sin_clat;
    *oz = y0 * sin_clat + z0 * cos_clat;
}

bool splash_project_latlon(float lat_deg, float lon_deg,
                           float cam_lat_deg, float cam_lon_deg,
                           float cx, float cy, float radius,
                           float* out_sx, float* out_sy, float* out_z) {
    float clat = cam_lat_deg * DEG_TO_RAD;
    float x, y, z;
    latlon_to_cam3(lat_deg, lon_deg, sinf(clat), cosf(clat), cam_lon_deg, &x, &y, &z);
    if(out_sx) *out_sx = cx + x * radius;
    if(out_sy) *out_sy = cy - y * radius;
    if(out_z) *out_z = z;
    return z > 0.0f;
}

size_t splash_clip_continent(const SplashContinent* cont,
                             float cam_lat_deg, float cam_lon_deg,
                             float cx, float cy, float radius,
                             SplashPt2* out_pts, size_t max_out) {
    if(!cont || !cont->pts || cont->count < 3 || !out_pts || max_out < 3) return 0;

    static const float Z_CLIP = 0.015f;
    float clat = cam_lat_deg * DEG_TO_RAD;
    float sin_c = sinf(clat);
    float cos_c = cosf(clat);

    float vx[32], vy[32], vz[32];
    size_t n = cont->count;
    if(n > 32) n = 32;
    bool any_front = false;
    for(size_t i = 0; i < n; i++) {
        latlon_to_cam3((float)cont->pts[i].lat10 * 0.1f,
                       (float)cont->pts[i].lon10 * 0.1f,
                       sin_c, cos_c, cam_lon_deg,
                       &vx[i], &vy[i], &vz[i]);
        if(vz[i] >= Z_CLIP) any_front = true;
    }
    if(!any_front) return 0;

    size_t out_n = 0;
    for(size_t i = 0; i < n; i++) {
        size_t j = (i + 1) % n;
        bool in_a = (vz[i] >= Z_CLIP);
        bool in_b = (vz[j] >= Z_CLIP);

        if(in_a && out_n < max_out) {
            out_pts[out_n].x = cx + vx[i] * radius;
            out_pts[out_n].y = cy - vy[i] * radius;
            out_n++;
        }
        if(in_a != in_b && out_n < max_out) {
            float denom = vz[j] - vz[i];
            float t = (fabsf(denom) > 1e-6f) ? ((Z_CLIP - vz[i]) / denom) : 0.5f;
            float ix = vx[i] + (vx[j] - vx[i]) * t;
            float iy = vy[i] + (vy[j] - vy[i]) * t;
            float len = sqrtf(ix * ix + iy * iy);
            float rim = sqrtf(1.0f - Z_CLIP * Z_CLIP);
            if(len > 1e-5f) {
                ix = (ix / len) * rim;
                iy = (iy / len) * rim;
            }
            out_pts[out_n].x = cx + ix * radius;
            out_pts[out_n].y = cy - iy * radius;
            out_n++;
        }
    }
    return (out_n >= 3) ? out_n : 0;
}

// Exact 10x10 Bio Mapping 2 favicon waveform path (visualiser/assets/biomap_icon.png):
static const SplashSymPt BIOMAP_SYMBOL_PATH[SPLASH_SYMBOL_VERTS] = {
    {0, 5},
    {2, 5},
    {2, 2},
    {5, 2},
    {5, 7},
    {8, 7},
    {8, 4},
    {9, 4},
};

const SplashSymPt* splash_symbol_path(size_t* out_vert_count, float* out_total_len) {
    if(out_vert_count) *out_vert_count = SPLASH_SYMBOL_VERTS;
    if(out_total_len) *out_total_len = 20.0f;
    return BIOMAP_SYMBOL_PATH;
}

// ── Bell melody ──────────────────────────────────────────────────────────
// Pitches match the app's existing G/D/E/A/B cue palette (biomap_cues.h).
// Each note plays as one whole buffer on its own speaker channel, so a slow
// frame can never starve the sound and make it click.

static const SplashMelodyNote MELODY_NOTES[] = {
    // Rising pentatonic melody synced to the extended Earth spin -> London -> body:
    { 350, 392.00f, 0},  // G4: Earth enters space
    {1450, 440.00f, 1},  // A4: Britain turns to front & London lights up
    {2550, 493.88f, 2},  // B4: Diving into London
    {4100, 587.33f, 3},  // D5: Entering the person's body
    {4750, 659.25f, 4},  // E5: Square-wave pulse inside chest (rec_start pitch)
    // Complete resolved G-major arpeggio chord as the logo rises into place;
    // finishes naturally around 7.25 s, well before fade-out at 9.10 s.
    {5650, 392.00f, 0},  // G4 (rings ~1.57 s)
    {5760, 493.88f, 1},  // B4 (rings ~1.25 s)
    {5870, 587.33f, 2},  // D5 (rings ~1.05 s)
    {5980, 783.99f, 3},  // G5 tonic resolution (rings ~0.79 s cleanly to 0)
};

const SplashMelodyNote* splash_melody_notes(size_t* out_count) {
    if(out_count) *out_count = sizeof(MELODY_NOTES) / sizeof(MELODY_NOTES[0]);
    return MELODY_NOTES;
}

void splash_audio_make_bell(int16_t* out, size_t count) {
    if(!out || count == 0) return;
    const float dt = 1.0f / (float)SPLASH_BELL_BASE_RATE;
    const float dur = (float)count * dt;
    const float attack = 0.020f;
    const float tail = 0.140f;

    for(size_t i = 0; i < count; i++) {
        float t = (float)i * dt;
        // Smooth raised-cosine onset (zero click at start).
        float atk = (t < attack) ? (0.5f * (1.0f - cosf((float)M_PI * t / attack))) : 1.0f;
        // Gentle, natural bell sustain so high notes ring out completely.
        float dec = expf(-2.5f * t);
        // Smooth raised-cosine tail to exact 0 (zero click at end).
        float rel = 1.0f;
        if(t > dur - tail) {
            float u = clamp01((dur - t) / tail);
            rel = 0.5f * (1.0f - cosf((float)M_PI * u));
        }
        float env = atk * dec * rel;
        // Pure sine wave with a gentle 2nd-harmonic shimmer on the initial strike.
        float w = TWO_PI * SPLASH_BELL_BASE_HZ * t;
        float s = sinf(w) + 0.07f * sinf(2.0f * w) * dec;
        // Linear headroom (peak ~7,800) so all 4 chord notes mix cleanly with zero clipping.
        int32_t pcm = (int32_t)(s * env * 7800.0f);
        if(pcm > 14000) pcm = 14000;
        if(pcm < -14000) pcm = -14000;
        out[i] = (int16_t)pcm;
    }
    out[0] = 0;
    out[count - 1] = 0;
}
