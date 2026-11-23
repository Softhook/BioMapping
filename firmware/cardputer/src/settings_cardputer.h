#pragma once

// Cardputer settings and GSR calibration, kept in /sd/biomapping/ on the
// built-in SD card (biomap.settings and biomap.cal). The record formats,
// magic numbers, versions, checksums and bounds checks are shared with the
// Flipper in core/biomap_format.h.
//
// Everything here runs on the main loop.

#include "biomap_config.h"
#include "biomap_format.h"

struct CardputerSettings {
    bool        zoom_enabled = true;
    bool        backlight_on = true;   // true = bright (128), false = dim (24)
    bool        sound_enabled = true;
    GpsNavModel nav_model = GpsNavModelPedestrian;
    bool        super_s = true;
    bool        debug_fields_enabled = false;

    bool     cal_active = false;
    float    cal_gain = 1.0f;
    float    cal_zero_counts = 0.0f;
    uint32_t cal_timestamp = 0;
    float    cal_r_squared = 0.0f;
    float    cal_noise_std_dev[CAL_POINTS] = {0.0f, 0.0f, 0.0f};
};

extern CardputerSettings g_settings;

// Loads biomap.settings and biomap.cal from /sd/biomapping/ if present and
// valid; otherwise keeps the defaults above. Applies the backlight setting.
void settings_cardputer_load(void);

// Prints the settings in use as one "[Settings] In use:" line. Called once
// the start-up animation is over: the lines printed while loading go out
// before a computer has the USB port open again, so the test tool
// (tools/hw_test.py) reads this one.
void settings_cardputer_log_in_use(void);

// Saves g_settings (Options items) atomically via a .tmp file + rename.
bool settings_cardputer_save(void);

// Applies g_settings.backlight_on to the Cardputer's display brightness.
void settings_cardputer_apply_backlight(void);

// Saves a new GSR calibration to g_settings and atomically writes biomap.cal.
bool settings_cardputer_save_cal(float gain, float zero_counts, float r_squared,
                                 const float noise_std_dev[CAL_POINTS]);

// Deletes biomap.cal and resets g_settings's calibration to the default (1.0 / 0.0).
void settings_cardputer_reset_cal(void);
