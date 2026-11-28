#include "menu_cardputer.h"

#include <math.h>
#include <stdio.h>

#include "biomap_config.h"
#include "biomap_format.h"
#include "cal_wizard.h"
#include "clock_cardputer.h"
#include "cues_cardputer.h"
#include "gps_cardputer.h"
#include "gsr_audio_cardputer.h"
#include "gsr_cardputer.h"
#include "sd_cardputer.h"
#include "session_cardputer.h"
#include "settings_cardputer.h"
#include "ui_theme.h"
#include "wifi_files_cardputer.h"

enum class ScreenId {
    MainMenu,
    Options,
    CalSubmenu,
    CalShowCurrent,
    CalWizard,
    WifiFiles,
    GsrAudio,
};

// Main menu items (Cardputer has no CC1101 radio).
enum {
    MainGpsGsr = 0,
    MainGsrOnly,
    MainLiveStream,
    MainWifiFiles,
    MainGsrAudio,
    MainOptions,
    MAIN_MENU_COUNT,
};

static const char* const MAIN_LABELS[MAIN_MENU_COUNT] = {
    "GPS + GSR",
    "GSR Only",
    "Live Stream",
    "Wi-Fi Files",
    "GSR Audio",
    "Options",
};

// Options items (all Flipper options except RF Calibration).
enum {
    OptGpsProfile = 0,
    OptSuperS,
    OptColdResetGps,
    OptAutoZoom,
    OptGsrCalibration,
    OptBacklight,
    OptSound,
    OptDiagnostics,
    OptDebugFields,
    OPTIONS_COUNT,
};

static const char* const OPTIONS_LABELS[OPTIONS_COUNT] = {
    "GPS Profile",
    "Super-S",
    "Cold Reset GPS",
    "Auto-zoom GSR",
    "GSR Calibration",
    "Backlight",
    "Sound",
    "Diagnostics",
    "Debug Fields",
};

// Calibration submenu items.
enum {
    CalSubStartWizard = 0,
    CalSubReset,
    CalSubShowCurrent,
    CAL_SUB_COUNT,
};

static const char* const CAL_SUB_LABELS[CAL_SUB_COUNT] = {
    "Start Wizard",
    "Reset to Default",
    "Show Current",
};

static ScreenId      g_screen = ScreenId::MainMenu;
static int32_t       g_main_sel = 0;
static int32_t       g_opt_sel = 0;
static int32_t       g_cal_sel = 0;
static CalWizardCore g_wiz = {};
static uint32_t      g_wiz_last_tick_ms = 0;

static void play_cue(BioMapCue cue, bool force = false) {
    cues_cardputer_play(force ? true : g_settings.sound_enabled, cue);
}

// Up or Down in a list: move the selection, wrapping round, with a click.
static void move_selection(int32_t* sel, int32_t count, bool down) {
    *sel = cycle_selection(*sel, count, down);
    play_cue(BioMapCueClick);
}

// ── Calibration wizard lifecycle & non-blocking 10 Hz driver ────────────
// The 4-step wizard state machine lives in core/cal_wizard.c; this file
// only starts/stops the GSR thread and ticks it every 100 ms on the main
// loop.

static void wizard_open(void) {
    gps_cardputer_sleep();
    GsrSensor* gsr = gsr_cardputer_start();
    if(gsr && !gsr_sensor_available(gsr)) {
        gsr_cardputer_stop(gsr);
        gsr = nullptr;
    }
    cal_wizard_init(&g_wiz, gsr);
    g_wiz_last_tick_ms = millis();
}

static void wizard_close(void) {
    if(g_wiz.gsr) {
        gsr_cardputer_stop(g_wiz.gsr);
        g_wiz.gsr = nullptr;
    }
    g_wiz.phase = CalDwellPhaseIdle;
}

static bool wizard_poll(void) {
    if(!cal_wizard_measuring(&g_wiz)) return false;
    uint32_t now = millis();
    if(now - g_wiz_last_tick_ms < (1000 / TICK_HZ)) return false;
    g_wiz_last_tick_ms += (1000 / TICK_HZ);
    if(now - g_wiz_last_tick_ms >= (1000 / TICK_HZ)) g_wiz_last_tick_ms = now;

    BioMapCue done_cue = BioMapCueCount;
    bool was_bias_check = (g_wiz.phase == CalDwellPhaseBiasCheck);
    bool finished = cal_wizard_tick(&g_wiz, &done_cue);
    if(was_bias_check) {
        // The blocking ~50 ms bias check just ran: reset the 100 ms tick
        // anchor so the two post-bias flush ticks are spaced by 100 ms.
        g_wiz_last_tick_ms = millis();
    }
    if(finished) {
        char why[96];
        if(cal_wizard_fail_reason(&g_wiz, why, sizeof(why))) {
            Serial.printf("[Cal] %s\n", why);
        }
        play_cue(done_cue);
        if(g_wiz.fit_cue != BioMapCueCount) {
            play_cue(g_wiz.fit_cue);
        }
    }
    return true;
}

// ── Screen transitions & actions ─────────────────────────────────────────

static void show_splash_banner(M5Canvas& canvas, const char* title, const char* subtitle,
                               uint16_t subtitle_col) {
    ui_reset_canvas(canvas);
    ui_draw_header(canvas, title);
    canvas.setTextColor(subtitle_col);
    canvas.drawString(subtitle, 6, 60);
    canvas.pushSprite(0, 0);
}

static void launch_session(BioMapMode mode, M5Canvas& canvas) {
    if(session_mode_needs_gps(mode)) {
        show_splash_banner(canvas, biomap_mode_name(mode), "Starting GPS...", TFT_YELLOW);
    }
    session_cardputer_begin(mode);
}

static void run_cold_reset_gps(M5Canvas& canvas) {
    show_splash_banner(canvas, "Cold Reset GPS", "Resetting GPS module...", TFT_YELLOW);
    bool ok = gps_cardputer_cold_reset(g_settings.nav_model, g_settings.super_s);
    play_cue(ok ? BioMapCueGpsColdStartDone : BioMapCueGpsColdStartFailed);
}

static void toggle_option_bool(bool* field, bool force_tone = false) {
    *field = !*field;
    settings_cardputer_save();
    play_cue(*field ? BioMapCueToggleOn : BioMapCueToggleOff, force_tone);
}

// ── Public interface ─────────────────────────────────────────────────────

void menu_cardputer_begin(void) {
    g_screen = ScreenId::MainMenu;
    g_main_sel = 0;
    g_opt_sel = 0;
    g_cal_sel = 0;
}

bool menu_cardputer_poll(M5Canvas& canvas) {
    if(g_session.open) return false;
    if(g_screen == ScreenId::CalWizard) {
        return wizard_poll();
    }
    if(g_screen == ScreenId::WifiFiles) {
        bool redraw = wifi_files_poll(canvas);
        if(wifi_files_wants_exit()) {
            wifi_files_stop();
            play_cue(BioMapCueBack);
            g_screen = ScreenId::MainMenu;
            return true;
        }
        return redraw;
    }
    if(g_screen == ScreenId::GsrAudio) {
        return gsr_audio_cardputer_poll();
    }
    return false;
}

bool menu_cardputer_key(SessionKey key, M5Canvas& canvas) {
    switch(g_screen) {
    case ScreenId::MainMenu:
        switch(key) {
        case SessionKeyUp:
        case SessionKeyDown:
            move_selection(&g_main_sel, MAIN_MENU_COUNT, key == SessionKeyDown);
            return true;
        case SessionKeyOk:
            if(g_main_sel == MainGpsGsr || g_main_sel == MainGsrOnly) {
                play_cue(BioMapCueConfirm);
                launch_session(
                    g_main_sel == MainGpsGsr ? BioMapModeGpsGsr : BioMapModeGsrOnly, canvas);
            } else if(g_main_sel == MainLiveStream) {
                play_cue(BioMapCueConfirm);
                launch_session(BioMapModeLiveStream, canvas);
            } else if(g_main_sel == MainWifiFiles) {
                if(!sd_card_mount()) {
                    play_cue(BioMapCueError);
                    return true;
                }
                show_splash_banner(canvas, "Wi-Fi Files", "Starting hotspot...", TFT_YELLOW);
                gps_cardputer_sleep();
                if(wifi_files_start(canvas)) {
                    play_cue(BioMapCueConfirm);
                    g_screen = ScreenId::WifiFiles;
                } else {
                    play_cue(BioMapCueError);
                }
            } else if(g_main_sel == MainGsrAudio) {
                show_splash_banner(canvas, "GSR Audio", "Starting sensor...", TFT_CYAN);
                gps_cardputer_sleep();
                if(gsr_audio_cardputer_start()) {
                    play_cue(BioMapCueConfirm);
                    g_screen = ScreenId::GsrAudio;
                } else {
                    play_cue(BioMapCueError);
                }
            } else if(g_main_sel == MainOptions) {
                play_cue(BioMapCueConfirm);
                g_screen = ScreenId::Options;
            }
            return true;
        default:
            return false;
        }

    case ScreenId::Options:
        switch(key) {
        case SessionKeyBack:
            play_cue(BioMapCueBack);
            g_screen = ScreenId::MainMenu;
            return true;
        case SessionKeyUp:
        case SessionKeyDown:
            move_selection(&g_opt_sel, OPTIONS_COUNT, key == SessionKeyDown);
            return true;
        case SessionKeyOk:
        case SessionKeyLeft:
        case SessionKeyRight:
            switch(g_opt_sel) {
            case OptGpsProfile: {
                bool down = (key != SessionKeyLeft);
                g_settings.nav_model = (GpsNavModel)cycle_selection(
                    (int32_t)g_settings.nav_model, GpsNavModelCount, down);
                settings_cardputer_save();
                play_cue(BioMapCueClick);
                return true;
            }
            case OptSuperS:
                toggle_option_bool(&g_settings.super_s);
                return true;
            case OptColdResetGps:
                if(key == SessionKeyOk) {
                    run_cold_reset_gps(canvas);
                    return true;
                }
                return false;
            case OptAutoZoom:
                toggle_option_bool(&g_settings.zoom_enabled);
                return true;
            case OptGsrCalibration:
                if(key == SessionKeyOk) {
                    play_cue(BioMapCueConfirm);
                    g_cal_sel = 0;
                    g_screen = ScreenId::CalSubmenu;
                    return true;
                }
                return false;
            case OptBacklight:
                toggle_option_bool(&g_settings.backlight_on);
                settings_cardputer_apply_backlight();
                return true;
            case OptSound:
                toggle_option_bool(&g_settings.sound_enabled, true);
                return true;
            case OptDiagnostics:
                if(key == SessionKeyOk) {
                    play_cue(BioMapCueConfirm);
                    launch_session(BioMapModeDiagnostics, canvas);
                    return true;
                }
                return false;
            case OptDebugFields:
                toggle_option_bool(&g_settings.debug_fields_enabled);
                return true;
            }
            return false;
        }
        return false;

    case ScreenId::CalSubmenu:
        switch(key) {
        case SessionKeyBack:
            play_cue(BioMapCueBack);
            g_screen = ScreenId::Options;
            return true;
        case SessionKeyUp:
        case SessionKeyDown:
            move_selection(&g_cal_sel, CAL_SUB_COUNT, key == SessionKeyDown);
            return true;
        case SessionKeyOk:
            if(g_cal_sel == CalSubStartWizard) {
                play_cue(BioMapCueConfirm);
                wizard_open();
                g_screen = ScreenId::CalWizard;
            } else if(g_cal_sel == CalSubReset) {
                play_cue(BioMapCueReset);
                settings_cardputer_reset_cal();
                g_screen = ScreenId::Options;
            } else if(g_cal_sel == CalSubShowCurrent) {
                play_cue(BioMapCueConfirm);
                g_screen = ScreenId::CalShowCurrent;
            }
            return true;
        default:
            return false;
        }

    case ScreenId::CalShowCurrent:
        if(key == SessionKeyBack || key == SessionKeyOk) {
            play_cue(BioMapCueBack);
            g_screen = ScreenId::CalSubmenu;
            return true;
        }
        return false;

    case ScreenId::CalWizard: {
        if(key != SessionKeyOk && key != SessionKeyBack) return false;
        BioMapCue cue = BioMapCueCount;
        CalKeyOutcome out = cal_wizard_key(&g_wiz, key == SessionKeyOk, &cue);
        if(out == CalKeyOutcomeNone) return false;
        g_wiz_last_tick_ms = millis();
        if(out == CalKeyOutcomeSaveAndExit) {
            bool saved = settings_cardputer_save_cal(g_wiz.gain, g_wiz.zero_counts,
                                                     g_wiz.r_squared, g_wiz.noise_std_dev);
            play_cue(saved ? cue : BioMapCueError);
            wizard_close();
            g_screen = ScreenId::Options;
        } else if(out == CalKeyOutcomeCancelAndExit) {
            play_cue(cue);
            wizard_close();
            g_screen = ScreenId::CalSubmenu;
        } else {
            play_cue(cue);
            BioMapCue err_cue = BioMapCueCount;
            if(cal_wizard_check_sensor(&g_wiz, &err_cue)) {
                play_cue(err_cue);
            }
        }
        return true;
    }

    case ScreenId::WifiFiles:
        if(key == SessionKeyBack) {
            wifi_files_stop();
            play_cue(BioMapCueBack);
            g_screen = ScreenId::MainMenu;
            return true;
        }
        return wifi_files_key(key);

    case ScreenId::GsrAudio:
        if(key == SessionKeyBack) {
            gsr_audio_cardputer_stop();
            play_cue(BioMapCueBack);
            g_screen = ScreenId::MainMenu;
            return true;
        }
        return gsr_audio_cardputer_key(key);
    }
    return false;
}

// ── Colour UI drawing ────────────────────────────────────────────────────

static void draw_list_row(M5Canvas& canvas, int row_vis, bool selected,
                          const char* label, const char* value = nullptr,
                          uint16_t value_col = TFT_LIGHTGREY) {
    int y = 25 + row_vis * 18;
    if(selected) {
        canvas.fillRect(2, y, UI_SCREEN_W - 4, 17, UI_COL_SEL_BG);
        canvas.fillRect(2, y, 3, 17, UI_COL_SEL_EDGE);
        canvas.setTextColor(TFT_WHITE);
    } else {
        canvas.setTextColor(TFT_LIGHTGREY);
    }
    canvas.drawString(label, 10, y + 1);
    if(value && value[0]) {
        canvas.setTextColor(value_col);
        int w = canvas.textWidth(value);
        canvas.drawString(value, UI_SCREEN_W - 6 - w, y + 1);
    }
}

static void draw_main_menu(M5Canvas& canvas) {
    // Show clock in header if GPS time has been acquired, plus battery percentage.
    char right[32] = "";
    SessionDateTime now;
    clock_cardputer_now(&now);
    int batt_pct = M5.Power.getBatteryLevel();
    if(clock_cardputer_is_set() && batt_pct >= 0) {
        snprintf(right, sizeof(right), "%02u:%02u  %d%%", now.hour, now.minute, batt_pct);
    } else if(clock_cardputer_is_set()) {
        snprintf(right, sizeof(right), "%02u:%02u:%02u", now.hour, now.minute, now.second);
    } else if(batt_pct >= 0) {
        snprintf(right, sizeof(right), "%d%%", batt_pct);
    }
    ui_draw_header(canvas, "Bio Mapping", right, TFT_CYAN);

    const int max_vis = 4;
    int top = scroll_window_top((int)g_main_sel, MAIN_MENU_COUNT, max_vis);
    for(int i = top; i < MAIN_MENU_COUNT && (i - top) < max_vis; i++) {
        const char* badge = nullptr;
        uint16_t badge_col = UI_COL_MUTED;
        if(i == MainGpsGsr || i == MainGsrOnly) {
            badge = g_settings.cal_active ? "CAL" : "";
            badge_col = TFT_GREEN;
        } else if(i == MainLiveStream) {
            badge = "BLE";
            badge_col = TFT_CYAN;
        } else if(i == MainWifiFiles) {
            badge = "WiFi";
            badge_col = TFT_CYAN;
        } else if(i == MainGsrAudio) {
            badge = "Sound";
            badge_col = TFT_CYAN;
        } else if(i == MainOptions) {
            badge = ">";
            badge_col = TFT_CYAN;
        }
        draw_list_row(canvas, i - top, i == g_main_sel, MAIN_LABELS[i], badge, badge_col);
    }

    // Status card above the footer: SD card and GPS/clock state.
    int sy = 100;
    canvas.drawFastHLine(6, sy - 2, UI_SCREEN_W - 12, TFT_DARKGREY);
    if(!sd_card_ready()) {
        canvas.setTextColor(TFT_RED);
        canvas.drawString("No SD card", 6, sy);
    } else {
        canvas.setTextColor(TFT_GREEN);
        canvas.drawString("SD card ready", 6, sy);
    }
    const char* gps_text = gps_cardputer_is_asleep() ? "GPS asleep"
                         : clock_cardputer_is_set()  ? "GPS clock set"
                                                     : "No GPS time";
    canvas.setTextColor(UI_COL_MUTED);
    canvas.drawString(gps_text, 136, sy);
    ui_draw_footer(canvas, "Enter: Select");
}

static void option_value(int idx, const char** out_text, uint16_t* out_col) {
    *out_text = nullptr;
    *out_col = TFT_LIGHTGREY;
    switch(idx) {
    case OptGpsProfile:
        *out_text = biomap_nav_model_label(g_settings.nav_model);
        *out_col = TFT_CYAN;
        break;
    case OptSuperS:
        *out_text = g_settings.super_s ? "AUTO" : "OFF";
        *out_col = g_settings.super_s ? TFT_GREEN : UI_COL_MUTED;
        break;
    case OptAutoZoom:
        *out_text = g_settings.zoom_enabled ? "ON" : "OFF";
        *out_col = g_settings.zoom_enabled ? TFT_GREEN : UI_COL_MUTED;
        break;
    case OptGsrCalibration:
        *out_text = g_settings.cal_active ? "YES >" : "NO >";
        *out_col = g_settings.cal_active ? TFT_GREEN : TFT_YELLOW;
        break;
    case OptBacklight:
        *out_text = g_settings.backlight_on ? "ON" : "DIM";
        *out_col = g_settings.backlight_on ? TFT_GREEN : UI_COL_MUTED;
        break;
    case OptSound:
        *out_text = g_settings.sound_enabled ? "ON" : "OFF";
        *out_col = g_settings.sound_enabled ? TFT_GREEN : UI_COL_MUTED;
        break;
    case OptDebugFields:
        *out_text = g_settings.debug_fields_enabled ? "ON" : "OFF";
        *out_col = g_settings.debug_fields_enabled ? TFT_YELLOW : UI_COL_MUTED;
        break;
    case OptDiagnostics:
        *out_text = ">";
        *out_col = TFT_CYAN;
        break;
    default:
        break;
    }
}

static void draw_options(M5Canvas& canvas) {
    char pos[16];
    snprintf(pos, sizeof(pos), "%d/%d", (int)g_opt_sel + 1, OPTIONS_COUNT);
    ui_draw_header(canvas, "Options", pos, UI_COL_MUTED);

    const int max_vis = 5;
    int top = scroll_window_top((int)g_opt_sel, OPTIONS_COUNT, max_vis);
    for(int i = top; i < OPTIONS_COUNT && (i - top) < max_vis; i++) {
        const char* val = nullptr;
        uint16_t col = TFT_LIGHTGREY;
        option_value(i, &val, &col);
        draw_list_row(canvas, i - top, i == g_opt_sel, OPTIONS_LABELS[i], val, col);
    }

    ui_draw_footer(canvas, "Enter: Toggle/Open   Esc: Back");
}

static void draw_cal_submenu(M5Canvas& canvas) {
    ui_draw_header(canvas, "GSR Calibration",
                   g_settings.cal_active ? "Custom" : "Default",
                   g_settings.cal_active ? TFT_GREEN : UI_COL_MUTED);

    for(int i = 0; i < CAL_SUB_COUNT; i++) {
        draw_list_row(canvas, i, i == g_cal_sel, CAL_SUB_LABELS[i]);
    }
    ui_draw_footer(canvas, "Enter: Select   Esc: Back");
}

static void draw_cal_show_current(M5Canvas& canvas) {
    bool active = g_settings.cal_active;
    ui_draw_header(canvas, "GSR Calibration",
                   active ? "Custom" : "Default",
                   active ? TFT_GREEN : TFT_YELLOW);

    char line[64];
    int y = 28;
    canvas.setTextColor(TFT_WHITE);
    if(active) {
        snprintf(line, sizeof(line), "Gain: %.4fx   R2: %.4f",
                 (double)g_settings.cal_gain, (double)g_settings.cal_r_squared);
        canvas.drawString(line, 8, y);
        y += 20;

        float worst = biomap_cal_worst_noise_std_dev(g_settings.cal_noise_std_dev);
        snprintf(line, sizeof(line), "Zero: %.1f cts   Max sigma: %.2f nS",
                 (double)g_settings.cal_zero_counts, (double)worst);
        canvas.drawString(line, 8, y);
        y += 20;

        canvas.setTextColor(TFT_LIGHTGREY);
        snprintf(line, sizeof(line), "470k: %.2f  100k: %.2f  47k: %.2f nS",
                 (double)g_settings.cal_noise_std_dev[0],
                 (double)g_settings.cal_noise_std_dev[1],
                 (double)g_settings.cal_noise_std_dev[2]);
        canvas.drawString(line, 8, y);
        y += 20;

        biomap_format_cal_age(line, sizeof(line), g_settings.cal_timestamp,
                              clock_cardputer_epoch_now());
        canvas.setTextColor(UI_COL_MUTED);
        canvas.drawString(line, 8, y);
    } else {
        canvas.setTextColor(TFT_LIGHTGREY);
        snprintf(line, sizeof(line), "Gain: %.3fx (uncalibrated)", (double)g_settings.cal_gain);
        canvas.drawString(line, 8, y);
        y += 20;
        snprintf(line, sizeof(line), "Zero: %.0f counts", (double)g_settings.cal_zero_counts);
        canvas.drawString(line, 8, y);
    }

    ui_draw_footer(canvas, "Enter / Esc: Back");
}

static void draw_wizard_progress_bar(M5Canvas& canvas, int y, uint32_t seconds_left) {
    int elapsed = clampi((int)CAL_DWELL_SECONDS - (int)seconds_left, 0, CAL_DWELL_SECONDS);
    int w = (elapsed * 224) / CAL_DWELL_SECONDS;
    canvas.drawRect(8, y, 224, 10, TFT_DARKGREY);
    if(w > 2) canvas.fillRect(9, y + 1, w - 2, 8, TFT_CYAN);
}

static void draw_wizard_measuring(M5Canvas& canvas, const char* step_badge,
                                  const char* heading, const char* hint,
                                  const char* unit) {
    char buf[64];
    ui_draw_header(canvas, "GSR Calibration", step_badge, TFT_CYAN);
    canvas.setTextColor(TFT_CYAN);
    canvas.drawString(heading, 8, 28);
    canvas.setTextColor(TFT_LIGHTGREY);
    canvas.drawString(hint, 8, 48);
    snprintf(buf, sizeof(buf), "%lus remaining   (%.0f %s)",
             (unsigned long)g_wiz.seconds_left, (double)g_wiz.live_reading, unit);
    canvas.setTextColor(TFT_WHITE);
    canvas.drawString(buf, 8, 68);
    draw_wizard_progress_bar(canvas, 92, g_wiz.seconds_left);
    ui_draw_footer(canvas, "Esc: Cancel");
}

static void draw_wizard_fail(M5Canvas& canvas, const char* title,
                             const char* detail, const char* hint) {
    ui_draw_header(canvas, "GSR Calibration", "Failed", TFT_RED);
    canvas.setTextColor(TFT_RED);
    canvas.drawString(title, 8, 28);
    canvas.setTextColor(TFT_WHITE);
    canvas.drawString(detail, 8, 50);
    canvas.setTextColor(TFT_YELLOW);
    canvas.drawString(hint, 8, 72);
    ui_draw_footer(canvas, "Enter: Retry   Esc: Cancel");
}

static void draw_cal_wizard(M5Canvas& canvas) {
    char buf[64];
    char buf2[64];
    int step = g_wiz.step;

    switch(step) {
    case WizardStepPromptZero:
        ui_draw_header(canvas, "GSR Calibration", "Step 1/4", TFT_CYAN);
        canvas.setTextColor(TFT_WHITE);
        canvas.drawString("Step 1/4: Open-Circuit Zero", 8, 30);
        canvas.setTextColor(TFT_YELLOW);
        canvas.drawString("Disconnect everything from cuffs", 8, 52);
        canvas.setTextColor(UI_COL_MUTED);
        canvas.drawString("Measures board & ADC zero offset", 8, 74);
        ui_draw_footer(canvas, "Enter: Measure   Esc: Cancel");
        break;

    case WizardStepMeasuringZero:
        draw_wizard_measuring(canvas, "Step 1/4", "Measuring zero...",
                              "Keep nothing connected", "cts");
        break;

    case WizardStepPrompt470k:
    case WizardStepPrompt100k:
    case WizardStepPrompt47k: {
        int idx = step / 2;
        snprintf(buf, sizeof(buf), "Step %d/4", idx + 2);
        ui_draw_header(canvas, "GSR Calibration", buf, TFT_CYAN);
        snprintf(buf, sizeof(buf), "Step %d/4: %s (%s)",
                 idx + 2, biomap_cal_steps[idx].level, biomap_cal_steps[idx].resistor);
        canvas.setTextColor(TFT_WHITE);
        canvas.drawString(buf, 8, 30);
        snprintf(buf, sizeof(buf), "Connect %s 0.1%% resistor", biomap_cal_steps[idx].resistor);
        canvas.setTextColor(TFT_YELLOW);
        canvas.drawString(buf, 8, 52);
        ui_draw_footer(canvas, "Enter: Measure   Esc: Cancel");
        break;
    }

    case WizardStepMeasuring470k:
    case WizardStepMeasuring100k:
    case WizardStepMeasuring47k: {
        int idx = step / 2;
        snprintf(buf, sizeof(buf), "Step %d/4", idx + 2);
        snprintf(buf2, sizeof(buf2), "Measuring %s...", biomap_cal_steps[idx].resistor);
        draw_wizard_measuring(canvas, buf, buf2, "Keep resistor connected", "nS");
        break;
    }

    case WizardStepSuccess: {
        ui_draw_header(canvas, "GSR Calibration", "Passed", TFT_GREEN);
        float worst_std = biomap_cal_worst_noise_std_dev(g_wiz.noise_std_dev);
        canvas.setTextColor(TFT_GREEN);
        canvas.drawString("Calibration Success!", 8, 28);
        canvas.setTextColor(TFT_WHITE);
        snprintf(buf, sizeof(buf), "Gain: %.4fx   R2: %.4f",
                 (double)g_wiz.gain, (double)g_wiz.r_squared);
        canvas.drawString(buf, 8, 50);
        snprintf(buf, sizeof(buf), "Zero: %.1f cts   Noise: %.2f nS",
                 (double)g_wiz.zero_counts, (double)worst_std);
        canvas.drawString(buf, 8, 70);
        ui_draw_footer(canvas, "Enter: Save   Esc: Discard", TFT_GREEN);
        break;
    }

    case WizardStepZeroFailed:
        if(g_wiz.zero_noise_ns >= CAL_NOISE_ACCEPTABLE_NS) {
            snprintf(buf, sizeof(buf), "Too noisy: %.1f nS (max %.0f)",
                     (double)g_wiz.zero_noise_ns, (double)CAL_NOISE_ACCEPTABLE_NS);
            draw_wizard_fail(canvas, "Zero Check Failed!", buf, "Keep cables still.");
        } else {
            snprintf(buf, sizeof(buf), "Read %.0f counts (max %.0f)",
                     (double)g_wiz.zero_counts, (double)CAL_ZERO_MAX_COUNTS);
            draw_wizard_fail(canvas, "Zero Check Failed!", buf, "Disconnect everything.");
        }
        break;

    case WizardStepMeasureFailed:
        draw_wizard_fail(canvas, "Calibration Failed!",
                         g_wiz.sensor_ok ? "Reading out of range." : "No GSR sensor found.",
                         "Check resistor & connections.");
        break;

    case WizardStepFitFailed:
        snprintf(buf, sizeof(buf), "Gain: %.3fx   R2: %.4f",
                 (double)g_wiz.gain, (double)g_wiz.r_squared);
        draw_wizard_fail(canvas, "Calibration Fit Failed!", "Device out of range.", buf);
        break;

    case WizardStepNoiseFailed: {
        int fail_idx = cal_wizard_fail_step_index(&g_wiz);
        snprintf(buf, sizeof(buf), "%s resistor too noisy/unstable.",
                 biomap_cal_steps[fail_idx].resistor);
        snprintf(buf2, sizeof(buf2), "Sigma: %.2f nS (max %.0f nS)",
                 (double)g_wiz.noise_std_dev[fail_idx], (double)CAL_NOISE_ACCEPTABLE_NS);
        draw_wizard_fail(canvas, "Pre-flight Check Failed!", buf, buf2);
        break;
    }

    case WizardStepBiasFailed:
        if(isnan(g_wiz.bias_measured_v)) {
            draw_wizard_fail(canvas, "Bias Check Failed!",
                             "No reading. Check wiring.", "Check 3.3 V supply.");
        } else {
            snprintf(buf, sizeof(buf), "Bias %.0f mV (need %.0f-%.0f mV)",
                     (double)(g_wiz.bias_measured_v * 1000.0f),
                     (double)(GSR_BIAS_MIN_V * 1000.0f),
                     (double)(GSR_BIAS_MAX_V * 1000.0f));
            draw_wizard_fail(canvas, "Bias Check Failed!", buf, "Check 3.3 V supply.");
        }
        break;

    default:
        break;
    }
}

void menu_cardputer_draw(M5Canvas& canvas) {
    ui_reset_canvas(canvas);

    switch(g_screen) {
    case ScreenId::MainMenu:
        draw_main_menu(canvas);
        break;
    case ScreenId::Options:
        draw_options(canvas);
        break;
    case ScreenId::CalSubmenu:
        draw_cal_submenu(canvas);
        break;
    case ScreenId::CalShowCurrent:
        draw_cal_show_current(canvas);
        break;
    case ScreenId::CalWizard:
        draw_cal_wizard(canvas);
        break;
    case ScreenId::WifiFiles:
        wifi_files_draw(canvas);
        break;
    case ScreenId::GsrAudio:
        gsr_audio_cardputer_draw(canvas);
        break;
    }
}
