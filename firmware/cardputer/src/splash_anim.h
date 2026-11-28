#pragma once

// The maths behind the Cardputer's start-up animation (splash_cardputer.cpp),
// in plain C so the host tests can run it without Arduino or M5GFX:
//   - easing curves and the timeline (after Forairaaaaa/smooth_ui_toolkit)
//   - the zoom: outer space -> 3D Earth -> London -> a person's body -> the
//     square-wave symbol inside it, growing into the Bio Mapping 2 logo
//   - projecting the globe and clipping continents to its visible half
//   - the 10x10 Bio Mapping 2 favicon waveform
//   - the bell note and the melody's timing

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// Display dimensions (Cardputer ADV IPS panel).
#define SPLASH_W 240
#define SPLASH_H 135

// Target location for the orbital dive (London, where Bio Mapping began in 2004).
#define SPLASH_TARGET_LAT_DEG 51.51f
#define SPLASH_TARGET_LON_DEG (-0.13f)

// The animation holds at SPLASH_HOLD_MS (about 2.6 s on the finished title)
// if the GPS is still going to sleep, then fades out into the menu.
#define SPLASH_HOLD_MS     9100U
#define SPLASH_FADE_OUT_MS  250U
#define SPLASH_TOTAL_MS    (SPLASH_HOLD_MS + SPLASH_FADE_OUT_MS)

// One bell sample, pitched for each note by its playback rate, so each note
// plays whole on its own speaker channel. 1.40 s at 12 kHz (a 33.6 KB buffer,
// freed when the animation ends), so even the highest notes ring out fully.
#define SPLASH_BELL_BASE_RATE  12000U
#define SPLASH_BELL_BASE_HZ    440.0f
#define SPLASH_BELL_SAMPLES    16800U

typedef enum {
    SplashEaseLinear = 0,
    SplashEaseOutCubic,
    SplashEaseInOutCubic,
    SplashEaseOutQuart,
    SplashEaseOutBack,
} SplashEase;

// Easing curves from 0 to 1: t is clamped to [0, 1].
float splash_ease(SplashEase ease, float t);

// Animated state of every visual element at elapsed time t_ms.
typedef struct {
    float global_alpha;     // 0..1 master fade-in / fade-out
    float star_alpha;       // 0..1 starfield visibility
    float star_warp;        // 0..1 radial streak intensity during orbital dive
    float globe_alpha;      // 0..1 3D planet visibility
    float globe_radius;     // planet radius in pixels (46 px orbit -> 460 px London)
    float globe_cx;         // planet centre X in pixels
    float globe_cy;         // planet centre Y in pixels
    float cam_lat_deg;      // camera nadir latitude (degrees)
    float cam_lon_deg;      // camera nadir longitude (degrees)
    float beacon_alpha;     // 0..1 London target reticle & beacon
    float beacon_phase;     // continuously advancing ripple phase

    // Person's body stage (emerges directly from London, fades to 0 before title):
    float body_alpha;       // 0..1 luminous human silhouette
    float body_scale;       // logarithmic zoom into the person (0.42 -> 4.2)

    // Bio Mapping 2 square-wave symbol (starts inside the body, grows & glides
    // into the final project logo on a completely clean dark background):
    float symbol_progress;  // 0..1 progressive trace of the exact 10x10 waveform
    float symbol_alpha;     // 0..1 symbol opacity
    float symbol_cell;      // cell size in pixels (1.5 px in body -> 5.5 px hero logo)
    float symbol_cy;        // vertical centre of active waveform (67.5 px -> 31 px)
    float symbol_glow;      // 0..1 soft glow that settles cleanly on the final logo

    // Final title lockup (clean dark background, no background animations):
    float title_alpha;      // 0..1 "Bio Mapping 2" text opacity
    float title_y_offset;   // vertical slide-up offset in pixels (positive = lower)
    float bar_progress;     // 0..1 green->yellow->red accent bar reveal
    float coord_alpha;      // 0..1 "Christian Nold 2004-2026" subtitle opacity
} SplashFrameState;

// Evaluates all tweens for the given elapsed time since splash start.
void splash_eval_frame(uint32_t t_ms, SplashFrameState* out);

// Compact geographic point stored in tenths of a degree.
typedef struct {
    int16_t lat10;
    int16_t lon10;
} SplashGeoPt;

typedef struct {
    const SplashGeoPt* pts;
    size_t             count;
    bool               is_focus;  // true for Great Britain (extra highlight on dive)
} SplashContinent;

// Returns the table of simplified world continent polygons.
const SplashContinent* splash_continents(size_t* out_count);

// 2D projected screen point.
typedef struct {
    float x;
    float y;
} SplashPt2;

// Projects (lat_deg, lon_deg) onto the unit sphere rotated so (cam_lat, cam_lon)
// sits at (0, 0, +1). Returns true when on the visible front hemisphere (z > 0).
bool splash_project_latlon(float lat_deg, float lon_deg,
                           float cam_lat_deg, float cam_lon_deg,
                           float cx, float cy, float radius,
                           float* out_sx, float* out_sy, float* out_z);

// Projects a closed continent polygon and clips it to the front hemisphere.
size_t splash_clip_continent(const SplashContinent* cont,
                             float cam_lat_deg, float cam_lon_deg,
                             float cx, float cy, float radius,
                             SplashPt2* out_pts, size_t max_out);

// Exact polyline vertices of the 10x10 Bio Mapping 2 favicon waveform
// (visualiser/assets/biomap_icon.png), in grid cell coordinates [0..9].
#define SPLASH_SYMBOL_VERTS 8
typedef struct {
    uint8_t x;
    uint8_t y;
} SplashSymPt;

const SplashSymPt* splash_symbol_path(size_t* out_vert_count, float* out_total_len);

// ── Bell melody (each note one whole sample on its own channel) ──────────
typedef struct {
    uint32_t t_ms;     // when to trigger this note
    float    freq_hz;  // target pitch (in the app's existing G/D/E/A/B cue palette)
    uint8_t  channel;  // hardware-mixed M5Unified speaker channel (0..7)
} SplashMelodyNote;

// Returns the ascending melody + final G-major resolution chord schedule.
const SplashMelodyNote* splash_melody_notes(size_t* out_count);

// Fills `count` samples (SPLASH_BELL_SAMPLES) with a 440 Hz sine bell: a
// smooth cosine attack and a decay that ends at exactly 0, so it never clicks.
void splash_audio_make_bell(int16_t* out, size_t count);

#ifdef __cplusplus
}
#endif
