#include "menu_cardputer.h"

#include <math.h>
#include <stdio.h>
#include <string.h>

#include "biomap_config.h"
#include "biomap_format.h"
#include "clock_cardputer.h"
#include "cues_cardputer.h"
#include "gps_cardputer.h"
#include "gsr_cardputer.h"
#include "sd_cardputer.h"
#include "session_cardputer.h"
#include "settings_cardputer.h"

// Custom RGB565 theme colours for the 240 × 135 colour UI.
static const uint16_t COL_HEADER_BG = 0x10A4;  // deep navy
static const uint16_t COL_SEL_BG    = 0x02B3;  // rich blue highlight
static const uint16_t COL_SEL_EDGE  = 0x07FF;  // cyan accent bar
static const uint16_t COL_FOOTER_BG = 0x1082;  // dark slate footer
static const uint16_t COL_MUTED     = 0x8410;  // mid grey

enum class ScreenId {
    MainMenu,
    Options,
    CalSubmenu,
    CalShowCurrent,
    CalWizard,
};

// Main menu items (Cardputer has no CC1101 radio).
enum {
    MainGpsGsr = 0,
    MainGsrOnly,
    MainLiveStream,
    MainOptions,
    MAIN_MENU_COUNT,
};

static const char* const MAIN_LABELS[MAIN_MENU_COUNT] = {
    "GPS + GSR",
    "GSR Only",
    "Live Stream",
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

static int scroll_window_top(int sel, int count, int max_visible) {
    if(count > max_visible && sel >= max_visible) return sel - max_visible + 1;
    return 0;
}

// ── Calibration wizard lifecycle & non-blocking 10 Hz driver ────────────
// The 4-step wizard state machine lives in core/biomap_session.c
// (CalWizardCore); this file only starts/stops the GSR thread and ticks it
// every 100 ms on the main loop.

static void wizard_open(void) {
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
        if(g_wiz.step == WizardStepBiasFailed) {
            Serial.printf("[Cal] Bias check failed: %.4f V\n", (double)g_wiz.bias_measured_v);
        } else if(g_wiz.step == WizardStepZeroFailed && !cal_dwell_ok(&g_wiz.dwell)) {
            Serial.printf("[Cal] Zero failed: mean=%.1f in=%d/%d (limit ±%.0f)\n",
                          (double)g_wiz.zero_counts, g_wiz.dwell.in_gate, g_wiz.dwell.all,
                          (double)CAL_ZERO_MAX_COUNTS);
        } else if(g_wiz.step == WizardStepMeasureFailed) {
            int idx = g_wiz.fail_idx;
            Serial.printf("[Cal] Resistor %d failed: first=%.1f in=%d below=%d above=%d gate=[%.0f, %.0f]\n",
                          idx, (double)g_wiz.first_raw, g_wiz.dwell.in_gate,
                          g_wiz.dwell.below, g_wiz.dwell.above,
                          (double)biomap_cal_gates[idx][0], (double)biomap_cal_gates[idx][1]);
        } else if(g_wiz.step == WizardStepFitFailed) {
            Serial.printf("[Cal] Fit failed: gain=%.4f R2=%.4f\n",
                          (double)g_wiz.gain, (double)g_wiz.r_squared);
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
    canvas.fillSprite(TFT_BLACK);
    canvas.fillRect(0, 0, 240, 22, COL_HEADER_BG);
    canvas.setFont(&fonts::Font2);
    canvas.setTextColor(TFT_WHITE);
    canvas.drawString(title, 6, 3);
    canvas.setTextColor(subtitle_col);
    canvas.drawString(subtitle, 6, 60);
    canvas.pushSprite(0, 0);
}

static void launch_session(BioMapMode mode, M5Canvas& canvas) {
    if(session_mode_needs_gps(mode)) {
        const char* title = (mode == BioMapModeGpsGsr)     ? "GPS + GSR"
                          : (mode == BioMapModeLiveStream) ? "Live Stream"
                                                           : "Session";
        show_splash_banner(canvas, title, "Starting GPS...", TFT_YELLOW);
    }
    session_cardputer_begin(mode);
}

static void run_cold_reset_gps(M5Canvas& canvas) {
    show_splash_banner(canvas, "Cold Reset GPS", "Resetting GPS module...", TFT_YELLOW);
    bool ok = gps_cardputer_cold_reset(g_settings.nav_model, g_settings.super_s);
    play_cue(ok ? BioMapCueGpsColdStartDone : BioMapCueGpsColdStartFailed);
}

static void toggle_option_bool(bool* field, bool force_tone = false) {
    if(sd_usb_drive_active()) {
        play_cue(BioMapCueError, force_tone);
        return;
    }
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

bool menu_cardputer_active(void) {
    return !g_session.open;
}

bool menu_cardputer_can_lend_sd(void) {
    return !g_session.open && g_screen != ScreenId::CalWizard;
}

bool menu_cardputer_poll(void) {
    if(!menu_cardputer_active()) return false;
    if(g_screen == ScreenId::CalWizard) {
        return wizard_poll();
    }
    return false;
}

bool menu_cardputer_key(SessionKey key, M5Canvas& canvas) {
    switch(g_screen) {
    case ScreenId::MainMenu:
        switch(key) {
        case SessionKeyUp:
            g_main_sel = cycle_selection(g_main_sel, MAIN_MENU_COUNT, false);
            play_cue(BioMapCueClick);
            return true;
        case SessionKeyDown:
            g_main_sel = cycle_selection(g_main_sel, MAIN_MENU_COUNT, true);
            play_cue(BioMapCueClick);
            return true;
        case SessionKeyOk:
            if(g_main_sel == MainGpsGsr || g_main_sel == MainGsrOnly) {
                if(sd_usb_drive_active()) {
                    play_cue(BioMapCueError);
                    return true;
                }
                play_cue(BioMapCueConfirm);
                launch_session(
                    g_main_sel == MainGpsGsr ? BioMapModeGpsGsr : BioMapModeGsrOnly, canvas);
            } else if(g_main_sel == MainLiveStream) {
                play_cue(BioMapCueConfirm);
                launch_session(BioMapModeLiveStream, canvas);
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
            g_opt_sel = cycle_selection(g_opt_sel, OPTIONS_COUNT, false);
            play_cue(BioMapCueClick);
            return true;
        case SessionKeyDown:
            g_opt_sel = cycle_selection(g_opt_sel, OPTIONS_COUNT, true);
            play_cue(BioMapCueClick);
            return true;
        case SessionKeyOk:
        case SessionKeyLeft:
        case SessionKeyRight:
            switch(g_opt_sel) {
            case OptGpsProfile:
                if(!sd_usb_drive_active()) {
                    bool down = (key != SessionKeyLeft);
                    g_settings.nav_model = (GpsNavModel)cycle_selection(
                        (int32_t)g_settings.nav_model, GpsNavModelCount, down);
                    settings_cardputer_save();
                    play_cue(BioMapCueClick);
                } else {
                    play_cue(BioMapCueError);
                }
                return true;
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
            g_cal_sel = cycle_selection(g_cal_sel, CAL_SUB_COUNT, false);
            play_cue(BioMapCueClick);
            return true;
        case SessionKeyDown:
            g_cal_sel = cycle_selection(g_cal_sel, CAL_SUB_COUNT, true);
            play_cue(BioMapCueClick);
            return true;
        case SessionKeyOk:
            if(g_cal_sel == CalSubStartWizard) {
                if(sd_usb_drive_active()) {
                    play_cue(BioMapCueError);
                    return true;
                }
                play_cue(BioMapCueConfirm);
                wizard_open();
                g_screen = ScreenId::CalWizard;
            } else if(g_cal_sel == CalSubReset) {
                if(sd_usb_drive_active()) {
                    play_cue(BioMapCueError);
                    return true;
                }
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
        play_cue(cue);
        g_wiz_last_tick_ms = millis();
        if(out == CalKeyOutcomeSaveAndExit) {
            settings_cardputer_save_cal(g_wiz.gain, g_wiz.zero_counts,
                                        g_wiz.r_squared, g_wiz.noise_std_dev);
            wizard_close();
            g_screen = ScreenId::Options;
        } else if(out == CalKeyOutcomeCancelAndExit) {
            wizard_close();
            g_screen = ScreenId::CalSubmenu;
        } else {
            BioMapCue err_cue = BioMapCueCount;
            if(cal_wizard_check_sensor(&g_wiz, &err_cue)) {
                play_cue(err_cue);
            }
        }
        return true;
    }
    }
    return false;
}

// ── Colour UI drawing ────────────────────────────────────────────────────

static void draw_header(M5Canvas& canvas, const char* title, const char* right_text = nullptr,
                        uint16_t right_col = TFT_LIGHTGREY) {
    canvas.fillRect(0, 0, 240, 22, COL_HEADER_BG);
    canvas.drawFastHLine(0, 22, 240, COL_SEL_EDGE);
    canvas.setFont(&fonts::Font2);
    canvas.setTextDatum(textdatum_t::top_left);
    canvas.setTextColor(TFT_WHITE);
    canvas.drawString(title, 6, 3);
    canvas.drawString(title, 7, 3);  // bold title
    if(right_text && right_text[0]) {
        canvas.setTextColor(right_col);
        int w = canvas.textWidth(right_text);
        canvas.drawString(right_text, 240 - w - 6, 3);
    }
}

static void draw_footer(M5Canvas& canvas, const char* text, uint16_t col = TFT_LIGHTGREY) {
    canvas.fillRect(0, 117, 240, 18, COL_FOOTER_BG);
    canvas.drawFastHLine(0, 116, 240, TFT_DARKGREY);
    canvas.setFont(&fonts::Font2);
    canvas.setTextDatum(textdatum_t::top_left);
    canvas.setTextColor(col);
    canvas.drawString(text, 6, 118);
}

static void draw_list_row(M5Canvas& canvas, int row_vis, bool selected,
                          const char* label, const char* value = nullptr,
                          uint16_t value_col = TFT_LIGHTGREY) {
    int y = 25 + row_vis * 18;
    if(selected) {
        canvas.fillRect(2, y, 236, 17, COL_SEL_BG);
        canvas.fillRect(2, y, 3, 17, COL_SEL_EDGE);
        canvas.setTextColor(TFT_WHITE);
    } else {
        canvas.setTextColor(TFT_LIGHTGREY);
    }
    canvas.drawString(label, 10, y + 1);
    if(value && value[0]) {
        canvas.setTextColor(value_col);
        int w = canvas.textWidth(value);
        canvas.drawString(value, 234 - w, y + 1);
    }
}

static void draw_main_menu(M5Canvas& canvas, bool usb_drive, bool usb_confirm,
                           const char* usb_notice) {
    // Show clock in header if GPS time has been acquired, plus battery voltage.
    char right[32] = "";
    SessionDateTime now;
    clock_cardputer_now(&now);
    int batt_mv = M5.Power.getBatteryVoltage();
    if(clock_cardputer_is_set() && batt_mv > 0) {
        snprintf(right, sizeof(right), "%02u:%02u  %.2fV",
                 now.hour, now.minute, (double)(batt_mv / 1000.0f));
    } else if(clock_cardputer_is_set()) {
        snprintf(right, sizeof(right), "%02u:%02u:%02u", now.hour, now.minute, now.second);
    } else if(batt_mv > 0) {
        snprintf(right, sizeof(right), "%.2fV", (double)(batt_mv / 1000.0f));
    }
    draw_header(canvas, "Bio Mapping", right, TFT_CYAN);

    for(int i = 0; i < MAIN_MENU_COUNT; i++) {
        const char* badge = nullptr;
        uint16_t badge_col = COL_MUTED;
        if(i == MainGpsGsr || i == MainGsrOnly) {
            badge = g_settings.cal_active ? "CAL" : "";
            badge_col = TFT_GREEN;
        } else if(i == MainLiveStream) {
            badge = "BLE";
            badge_col = TFT_CYAN;
        } else if(i == MainOptions) {
            badge = ">";
            badge_col = TFT_CYAN;
        }
        draw_list_row(canvas, i, i == g_main_sel, MAIN_LABELS[i], badge, badge_col);
    }

    // Status card above the footer: SD card / USB thumb drive state.
    int sy = 100;
    canvas.drawFastHLine(6, sy - 2, 228, TFT_DARKGREY);
    if(usb_drive && usb_confirm) {
        canvas.setTextColor(TFT_YELLOW);
        canvas.drawString("Eject on computer first!", 6, sy);
        draw_footer(canvas, "Press U again to force take card", TFT_YELLOW);
    } else if(usb_drive) {
        canvas.setTextColor(TFT_CYAN);
        canvas.drawString("USB drive mounted on computer", 6, sy);
        draw_footer(canvas, "Eject on computer to finish", TFT_CYAN);
    } else if(usb_notice) {
        canvas.setTextColor(TFT_YELLOW);
        canvas.drawString(usb_notice, 6, sy);
        draw_footer(canvas, "Enter: Select   U: USB Drive");
    } else if(!sd_card_ready()) {
        canvas.setTextColor(TFT_RED);
        canvas.drawString("No SD card", 6, sy);
        draw_footer(canvas, "Enter: Select   U: USB Drive");
    } else {
        canvas.setTextColor(TFT_GREEN);
        canvas.drawString("SD card ready", 6, sy);
        canvas.setTextColor(COL_MUTED);
        canvas.drawString(clock_cardputer_is_set() ? "GPS clock set" : "GPS asleep", 136, sy);
        draw_footer(canvas, "Enter: Select   U: USB Drive");
    }
}

static void option_value(int idx, const char** out_text, uint16_t* out_col) {
    static const char* const NAV_LABELS[7] = {
        "PED", "WRIST", "VEHICLE", "STATION", "SEA", "BIKE", "FLIGHT",
    };
    *out_text = nullptr;
    *out_col = TFT_LIGHTGREY;
    switch(idx) {
    case OptGpsProfile:
        *out_text = NAV_LABELS[g_settings.nav_model < GpsNavModelCount ? g_settings.nav_model : 0];
        *out_col = TFT_CYAN;
        break;
    case OptSuperS:
        *out_text = g_settings.super_s ? "AUTO" : "OFF";
        *out_col = g_settings.super_s ? TFT_GREEN : COL_MUTED;
        break;
    case OptAutoZoom:
        *out_text = g_settings.zoom_enabled ? "ON" : "OFF";
        *out_col = g_settings.zoom_enabled ? TFT_GREEN : COL_MUTED;
        break;
    case OptGsrCalibration:
        *out_text = g_settings.cal_active ? "YES >" : "NO >";
        *out_col = g_settings.cal_active ? TFT_GREEN : TFT_YELLOW;
        break;
    case OptBacklight:
        *out_text = g_settings.backlight_on ? "ON" : "DIM";
        *out_col = g_settings.backlight_on ? TFT_GREEN : COL_MUTED;
        break;
    case OptSound:
        *out_text = g_settings.sound_enabled ? "ON" : "OFF";
        *out_col = g_settings.sound_enabled ? TFT_GREEN : COL_MUTED;
        break;
    case OptDebugFields:
        *out_text = g_settings.debug_fields_enabled ? "ON" : "OFF";
        *out_col = g_settings.debug_fields_enabled ? TFT_YELLOW : COL_MUTED;
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
    draw_header(canvas, "Options", pos, COL_MUTED);

    const int max_vis = 5;
    int top = scroll_window_top((int)g_opt_sel, OPTIONS_COUNT, max_vis);
    for(int i = top; i < OPTIONS_COUNT && (i - top) < max_vis; i++) {
        const char* val = nullptr;
        uint16_t col = TFT_LIGHTGREY;
        option_value(i, &val, &col);
        draw_list_row(canvas, i - top, i == g_opt_sel, OPTIONS_LABELS[i], val, col);
    }

    draw_footer(canvas, "Enter: Toggle/Open   Esc: Back");
}

static void draw_cal_submenu(M5Canvas& canvas) {
    draw_header(canvas, "GSR Calibration",
                g_settings.cal_active ? "Custom" : "Default",
                g_settings.cal_active ? TFT_GREEN : COL_MUTED);

    for(int i = 0; i < CAL_SUB_COUNT; i++) {
        draw_list_row(canvas, i, i == g_cal_sel, CAL_SUB_LABELS[i]);
    }
    draw_footer(canvas, "Enter: Select   Esc: Back");
}

static void draw_cal_show_current(M5Canvas& canvas) {
    bool active = g_settings.cal_active;
    draw_header(canvas, "GSR Calibration",
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

        canvas.setTextColor( TFT_LIGHTGREY);
        snprintf(line, sizeof(line), "470k: %.2f  100k: %.2f  47k: %.2f nS",
                 (double)g_settings.cal_noise_std_dev[0],
                 (double)g_settings.cal_noise_std_dev[1],
                 (double)g_settings.cal_noise_std_dev[2]);
        canvas.drawString(line, 8, y);
        y += 20;

        uint32_t now = clock_cardputer_epoch_now();
        uint32_t saved = g_settings.cal_timestamp;
        canvas.setTextColor(COL_MUTED);
        if(saved == 0 || now == 0 || now < saved) {
            canvas.drawString("Age: unknown", 8, y);
        } else {
            snprintf(line, sizeof(line), "Age: %lu d",
                     (unsigned long)((now - saved) / 86400UL));
            canvas.drawString(line, 8, y);
        }
    } else {
        canvas.setTextColor(TFT_LIGHTGREY);
        snprintf(line, sizeof(line), "Gain: %.3fx (uncalibrated)", (double)g_settings.cal_gain);
        canvas.drawString(line, 8, y);
        y += 20;
        snprintf(line, sizeof(line), "Zero: %.0f counts", (double)g_settings.cal_zero_counts);
        canvas.drawString(line, 8, y);
    }

    draw_footer(canvas, "Enter / Esc: Back");
}

static void draw_wizard_progress_bar(M5Canvas& canvas, int y, uint32_t seconds_left) {
    int elapsed = (int)CAL_DWELL_SECONDS - (int)seconds_left;
    if(elapsed < 0) elapsed = 0;
    if(elapsed > CAL_DWELL_SECONDS) elapsed = CAL_DWELL_SECONDS;
    int w = (elapsed * 224) / CAL_DWELL_SECONDS;
    canvas.drawRect(8, y, 224, 10, TFT_DARKGREY);
    if(w > 2) canvas.fillRect(9, y + 1, w - 2, 8, TFT_CYAN);
}

static void draw_cal_wizard(M5Canvas& canvas) {
    static const struct { const char* level; const char* resistor; } STEPS[3] = {
        {"Low", "470k"}, {"Mid", "100k"}, {"High", "47k"},
    };
    char buf[64];
    int step = g_wiz.step;

    switch(step) {
    case WizardStepPromptZero:
        draw_header(canvas, "GSR Calibration", "Step 1/4", TFT_CYAN);
        canvas.setTextColor(TFT_WHITE);
        canvas.drawString("Step 1/4: Open-Circuit Zero", 8, 30);
        canvas.setTextColor(TFT_YELLOW);
        canvas.drawString("Disconnect everything from cuffs", 8, 52);
        canvas.setTextColor(COL_MUTED);
        canvas.drawString("Measures board & ADC zero offset", 8, 74);
        draw_footer(canvas, "Enter: Measure   Esc: Cancel");
        break;

    case WizardStepMeasuringZero:
        draw_header(canvas, "GSR Calibration", "Step 1/4", TFT_CYAN);
        canvas.setTextColor(TFT_CYAN);
        canvas.drawString("Measuring zero...", 8, 28);
        canvas.setTextColor(TFT_LIGHTGREY);
        canvas.drawString("Keep nothing connected", 8, 48);
        snprintf(buf, sizeof(buf), "%lus remaining   (%.0f cts)",
                 (unsigned long)g_wiz.seconds_left, (double)g_wiz.live_reading);
        canvas.setTextColor(TFT_WHITE);
        canvas.drawString(buf, 8, 68);
        draw_wizard_progress_bar(canvas, 92, g_wiz.seconds_left);
        draw_footer(canvas, "Esc: Cancel");
        break;

    case WizardStepPrompt470k:
    case WizardStepPrompt100k:
    case WizardStepPrompt47k: {
        int idx = step / 2;
        snprintf(buf, sizeof(buf), "Step %d/4", idx + 2);
        draw_header(canvas, "GSR Calibration", buf, TFT_CYAN);
        snprintf(buf, sizeof(buf), "Step %d/4: %s (%s)",
                 idx + 2, STEPS[idx].level, STEPS[idx].resistor);
        canvas.setTextColor(TFT_WHITE);
        canvas.drawString(buf, 8, 30);
        snprintf(buf, sizeof(buf), "Connect %s 0.1%% resistor", STEPS[idx].resistor);
        canvas.setTextColor(TFT_YELLOW);
        canvas.drawString(buf, 8, 52);
        draw_footer(canvas, "Enter: Measure   Esc: Cancel");
        break;
    }

    case WizardStepMeasuring470k:
    case WizardStepMeasuring100k:
    case WizardStepMeasuring47k: {
        int idx = step / 2;
        snprintf(buf, sizeof(buf), "Step %d/4", idx + 2);
        draw_header(canvas, "GSR Calibration", buf, TFT_CYAN);
        snprintf(buf, sizeof(buf), "Measuring %s...", STEPS[idx].resistor);
        canvas.setTextColor(TFT_CYAN);
        canvas.drawString(buf, 8, 28);
        canvas.setTextColor(TFT_LIGHTGREY);
        canvas.drawString("Keep resistor connected", 8, 48);
        snprintf(buf, sizeof(buf), "%lus remaining   (%.0f nS)",
                 (unsigned long)g_wiz.seconds_left, (double)g_wiz.live_reading);
        canvas.setTextColor(TFT_WHITE);
        canvas.drawString(buf, 8, 68);
        draw_wizard_progress_bar(canvas, 92, g_wiz.seconds_left);
        draw_footer(canvas, "Esc: Cancel");
        break;
    }

    case WizardStepSuccess: {
        draw_header(canvas, "GSR Calibration", "Passed", TFT_GREEN);
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
        draw_footer(canvas, "Enter: Save   Esc: Discard", TFT_GREEN);
        break;
    }

    case WizardStepZeroFailed:
        draw_header(canvas, "GSR Calibration", "Failed", TFT_RED);
        canvas.setTextColor(TFT_RED);
        canvas.drawString("Zero Check Failed!", 8, 28);
        canvas.setTextColor(TFT_WHITE);
        if(g_wiz.zero_noise_ns >= CAL_NOISE_ACCEPTABLE_NS) {
            snprintf(buf, sizeof(buf), "Too noisy: %.1f nS (max %.0f)",
                     (double)g_wiz.zero_noise_ns, (double)CAL_NOISE_ACCEPTABLE_NS);
            canvas.drawString(buf, 8, 50);
            canvas.setTextColor(TFT_YELLOW);
            canvas.drawString("Keep cables still.", 8, 72);
        } else {
            snprintf(buf, sizeof(buf), "Read %.0f counts (max %.0f)",
                     (double)g_wiz.zero_counts, (double)CAL_ZERO_MAX_COUNTS);
            canvas.drawString(buf, 8, 50);
            canvas.setTextColor(TFT_YELLOW);
            canvas.drawString("Disconnect everything.", 8, 72);
        }
        draw_footer(canvas, "Enter: Retry   Esc: Cancel");
        break;

    case WizardStepMeasureFailed:
        draw_header(canvas, "GSR Calibration", "Failed", TFT_RED);
        canvas.setTextColor(TFT_RED);
        canvas.drawString("Calibration Failed!", 8, 28);
        canvas.setTextColor(TFT_WHITE);
        canvas.drawString(g_wiz.sensor_ok ? "Reading out of range." : "No GSR sensor found.", 8, 50);
        canvas.setTextColor(TFT_YELLOW);
        canvas.drawString("Check resistor & connections.", 8, 72);
        draw_footer(canvas, "Enter: Retry   Esc: Cancel");
        break;

    case WizardStepFitFailed:
        draw_header(canvas, "GSR Calibration", "Failed", TFT_RED);
        canvas.setTextColor(TFT_RED);
        canvas.drawString("Calibration Fit Failed!", 8, 28);
        canvas.setTextColor(TFT_WHITE);
        canvas.drawString("Device out of range.", 8, 50);
        snprintf(buf, sizeof(buf), "Gain: %.3fx   R2: %.4f",
                 (double)g_wiz.gain, (double)g_wiz.r_squared);
        canvas.setTextColor(TFT_YELLOW);
        canvas.drawString(buf, 8, 72);
        draw_footer(canvas, "Enter: Retry   Esc: Cancel");
        break;

    case WizardStepNoiseFailed:
        draw_header(canvas, "GSR Calibration", "Failed", TFT_RED);
        canvas.setTextColor(TFT_RED);
        canvas.drawString("Pre-flight Check Failed!", 8, 28);
        snprintf(buf, sizeof(buf), "%s resistor too noisy/unstable.",
                 STEPS[g_wiz.fail_idx].resistor);
        canvas.setTextColor(TFT_WHITE);
        canvas.drawString(buf, 8, 50);
        snprintf(buf, sizeof(buf), "Sigma: %.2f nS (max %.0f nS)",
                 (double)g_wiz.noise_std_dev[g_wiz.fail_idx], (double)CAL_NOISE_ACCEPTABLE_NS);
        canvas.setTextColor(TFT_YELLOW);
        canvas.drawString(buf, 8, 72);
        draw_footer(canvas, "Enter: Retry   Esc: Cancel");
        break;

    case WizardStepBiasFailed:
        draw_header(canvas, "GSR Calibration", "Failed", TFT_RED);
        canvas.setTextColor(TFT_RED);
        canvas.drawString("Bias Check Failed!", 8, 28);
        canvas.setTextColor(TFT_WHITE);
        if(isnan(g_wiz.bias_measured_v)) {
            canvas.drawString("No reading. Check wiring.", 8, 50);
        } else {
            snprintf(buf, sizeof(buf), "Bias %.0f mV (need %.0f-%.0f mV)",
                     (double)(g_wiz.bias_measured_v * 1000.0f),
                     (double)(GSR_BIAS_MIN_V * 1000.0f),
                     (double)(GSR_BIAS_MAX_V * 1000.0f));
            canvas.drawString(buf, 8, 50);
        }
        canvas.setTextColor(TFT_YELLOW);
        canvas.drawString("Check 3.3 V supply.", 8, 72);
        draw_footer(canvas, "Enter: Retry   Esc: Cancel");
        break;

    default:
        break;
    }
}

void menu_cardputer_draw(M5Canvas& canvas, bool usb_drive, bool usb_confirm,
                         const char* usb_notice) {
    canvas.fillSprite(TFT_BLACK);
    canvas.setFont(&fonts::Font2);
    canvas.setTextDatum(textdatum_t::top_left);

    switch(g_screen) {
    case ScreenId::MainMenu:
        draw_main_menu(canvas, usb_drive, usb_confirm, usb_notice);
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
    }
}
