#include "settings_cardputer.h"

#include <M5Cardputer.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

#include "clock_cardputer.h"
#include "sd_cardputer.h"
#include "ui_theme.h"

CardputerSettings g_settings;

static const char* const SETTINGS_PATH     = SD_BIOMAP_DIR "/biomap.settings";
static const char* const SETTINGS_PATH_TMP = SD_BIOMAP_DIR "/biomap.settings.tmp";
static const char* const CAL_PATH          = SD_BIOMAP_DIR "/biomap.cal";
static const char* const CAL_PATH_TMP      = SD_BIOMAP_DIR "/biomap.cal.tmp";

static bool read_file_exact(const char* path, void* out, size_t size) {
    if(!sd_card_mount()) return false;
    int fd = open(path, O_RDONLY);
    if(fd < 0) return false;
    uint8_t* p = static_cast<uint8_t*>(out);
    size_t got = 0;
    while(got < size) {
        ssize_t n = read(fd, p + got, size - got);
        if(n <= 0) break;
        got += (size_t)n;
    }
    close(fd);
    return got == size;
}

// Writes `size` bytes to `tmp_path`, syncs, and renames over `path`, so a
// power cut mid-save never leaves a half-written record. On FAT, rename()
// fails if the target exists, so unlink(path) runs just before rename().
static bool write_file_atomic(const char* tmp_path, const char* path,
                              const void* data, size_t size, const char* what) {
    if(!sd_card_mount()) return false;
    int fd = open(tmp_path, O_WRONLY | O_CREAT | O_TRUNC, 0666);
    if(fd < 0) {
        Serial.printf("[Settings] error: can't open %s\n", tmp_path);
        return false;
    }
    size_t done = sd_write_all(fd, data, size);
    bool synced = (done == size) && (fsync(fd) == 0);
    close(fd);
    if(!synced) {
        Serial.printf("[Settings] error: %s temp write failed (%u/%u)\n",
                      what, (unsigned)done, (unsigned)size);
        unlink(tmp_path);
        return false;
    }
    unlink(path);
    if(rename(tmp_path, path) != 0) {
        Serial.printf("[Settings] error: %s rename failed\n", what);
        return false;
    }
    return true;
}

void settings_cardputer_apply_backlight(void) {
    M5Cardputer.Display.setBrightness(
        g_settings.backlight_on ? UI_BRIGHTNESS_ON : UI_BRIGHTNESS_DIM);
}

void settings_cardputer_log_in_use(void) {
    const CardputerSettings& s = g_settings;
    Serial.printf("[Settings] In use: zoom=%d backlight=%d sound=%d nav=%lu super_s=%d debug=%d cal=%d\n",
                  s.zoom_enabled, s.backlight_on, s.sound_enabled, (unsigned long)s.nav_model,
                  s.super_s, s.debug_fields_enabled, s.cal_active);
}

void settings_cardputer_load(void) {
    g_settings = CardputerSettings{};
    if(!sd_card_mount()) {
        settings_cardputer_apply_backlight();
        return;
    }

    BioMapSettings s = {};
    if(read_file_exact(SETTINGS_PATH, &s, sizeof(s))) {
        if(biomap_settings_valid(&s)) {
            g_settings.zoom_enabled         = s.zoom_enabled;
            g_settings.backlight_on         = s.backlight_on;
            g_settings.sound_enabled        = s.sound_enabled;
            g_settings.nav_model            = (GpsNavModel)s.nav_model;
            g_settings.super_s              = s.super_s;
            g_settings.debug_fields_enabled = s.debug_fields_enabled;
            Serial.printf("[Settings] Loaded settings: zoom=%d backlight=%d sound=%d nav=%lu super_s=%d debug=%d\n",
                          s.zoom_enabled, s.backlight_on, s.sound_enabled,
                          (unsigned long)s.nav_model, s.super_s, s.debug_fields_enabled);
        } else {
            Serial.println("[Settings] warning: settings file invalid — using defaults");
        }
    }

    BioMapCalibration cal = {};
    if(read_file_exact(CAL_PATH, &cal, sizeof(cal))) {
        CalRecordStatus status = biomap_calibration_check(&cal);
        if(status == CalRecordOk) {
            g_settings.set_calibration(cal.gain, cal.zero_counts, cal.timestamp,
                                       cal.r_squared, cal.noise_std_dev);
            Serial.printf("[Settings] Loaded calibration v%lu: gain=%.4f zero=%.1f r2=%.4f time=%lu\n",
                          (unsigned long)cal.version, (double)cal.gain, (double)cal.zero_counts,
                          (double)cal.r_squared, (unsigned long)cal.timestamp);
        } else {
            Serial.printf("[Settings] warning: calibration file ignored: %s\n",
                          biomap_calibration_status_text(status));
        }
    }

    settings_cardputer_apply_backlight();
}

bool settings_cardputer_save(void) {
    BioMapSettings s = biomap_settings_make(
        g_settings.zoom_enabled, g_settings.backlight_on, g_settings.sound_enabled,
        g_settings.nav_model, g_settings.super_s, g_settings.debug_fields_enabled);
    return write_file_atomic(SETTINGS_PATH_TMP, SETTINGS_PATH, &s, sizeof(s), "Settings");
}

bool settings_cardputer_save_cal(float gain, float zero_counts, float r_squared,
                                 const float noise_std_dev[CAL_POINTS]) {
    uint32_t timestamp = clock_cardputer_epoch_now();
    BioMapCalibration cal =
        biomap_calibration_make(gain, zero_counts, timestamp, r_squared, noise_std_dev);
    bool ok = write_file_atomic(CAL_PATH_TMP, CAL_PATH, &cal, sizeof(cal), "Calibration");
    if(ok) {
        g_settings.set_calibration(gain, zero_counts, timestamp, r_squared, noise_std_dev);
        Serial.printf("[Settings] Saved calibration v%d: gain=%.4f zero=%.1f r2=%.4f time=%lu\n",
                      BIOMAP_CAL_VERSION, (double)gain, (double)zero_counts,
                      (double)r_squared, (unsigned long)timestamp);
    }
    return ok;
}

void settings_cardputer_reset_cal(void) {
    if(sd_card_mount()) {
        unlink(CAL_PATH);
        unlink(CAL_PATH_TMP);
    }
    g_settings.clear_calibration();
    Serial.println("[Settings] Reset calibration to default");
}
