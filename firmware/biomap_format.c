// biomap_format.c — see biomap_format.h.
//
// The only SDK surface used here is FURI_LOG_W (calibration-fit diagnostics).
// The host test build resolves <furi.h> to tests/shims/furi.h, which stubs
// the FURI_LOG_* macros to no-ops — same mechanism the other module tests
// use, so this file needs no build-time conditionals.

#include "biomap_format.h"

#include <furi.h>
#include <math.h>
#include <stdio.h>

int biomap_format_gps_row(char* out, size_t cap, bool debug_fields,
                          const GpsPosition* pos, double rel, float raw,
                          const float* rf_rssi, const RowDiag* diag) {
    bool gps_ok = pos->valid;
    int n;
    if(gps_ok) {
        // Speed and course are independent: the receiver leaves course empty
        // when nearly still (integration manual §2.2.6, course freezing) but
        // still reports the speed — which is what tells a stop apart.
        char speed[16] = "";
        char course[16] = "";
        if(!isnan(pos->speed_kts)) snprintf(speed, sizeof(speed), "%.2f", (double)pos->speed_kts);
        if(!isnan(pos->course_deg)) snprintf(course, sizeof(course), "%.1f", (double)pos->course_deg);
        n = snprintf(out, cap,
            "%.2f,%.7f,%.7f,%.1f,%.1f,%d,%d,%s,%s,%.1f,%.1f",
            rel, pos->lat, pos->lon,
            (double)pos->hdop, (double)pos->pdop,
            pos->sats, pos->fix_type,
            speed, course, (double)raw,
            (double)pos->hacc);
    } else {
        n = snprintf(out, cap, "%.2f,,,,,,,,,%.1f,", rel, (double)raw);
    }
    if(n <= 0 || (size_t)n >= cap) return -1;

    // Optional RF columns (raw per-band RSSI).
    int n2 = rf_rssi
        ? snprintf(out + n, cap - (size_t)n, ",%.1f,%.1f,%.1f",
                   (double)rf_rssi[0], (double)rf_rssi[1], (double)rf_rssi[2])
        : 0;
    if(n2 < 0 || (size_t)(n + n2) >= cap) return -1;
    n += n2;

    // Debug columns are always appended at the very end so production
    // columns stay contiguous and easy to consume.
    int nd = debug_fields
        ? snprintf(out + n, cap - (size_t)n,
                   ",%u,%u,%u,%u,%.1f,%u,%u,%u,%u,%u,%u,%u,%u,%u,%u,%u\n",
                   (unsigned)diag->tick_dt_ms, (unsigned)diag->gps_rx_drops,
                   (unsigned)diag->nmea_fail, (unsigned)diag->gps_reinit_count,
                   (double)diag->gsr_hz,
                   (unsigned)diag->i2c_peak_ms, (unsigned)diag->rf_rssi_peak_ms,
                   (unsigned)diag->rf_retune_peak_ms, (unsigned)diag->flush_peak_ms,
                   (unsigned)diag->log_fill_bytes, (unsigned)diag->log_fill_peak_bytes,
                   (unsigned)diag->log_overflow_count, (unsigned)diag->log_flush_fail_count,
                   (unsigned)diag->pga_change_count, (unsigned)diag->i2c_consec_fail,
                   (unsigned)diag->prealloc_ms)
        : snprintf(out + n, cap - (size_t)n, "\n");
    if(nd <= 0 || (size_t)(n + nd) >= cap) return -1;
    n += nd;

    return n;
}

int biomap_format_gsr_row(char* out, size_t cap, bool debug_fields,
                          double rel, float raw, const RowDiag* diag) {
    int n = debug_fields
        ? snprintf(out, cap, "%.2f,%.1f,%u,%u,%u,%u,%u,%u,%u\n",
                   rel, (double)raw,
                   (unsigned)diag->log_fill_bytes, (unsigned)diag->log_fill_peak_bytes,
                   (unsigned)diag->log_overflow_count, (unsigned)diag->log_flush_fail_count,
                   (unsigned)diag->pga_change_count, (unsigned)diag->i2c_consec_fail,
                   (unsigned)diag->prealloc_ms)
        : snprintf(out, cap, "%.2f,%.1f\n", rel, (double)raw);
    if(n <= 0 || (size_t)n >= cap) return -1;
    return n;
}

int32_t cycle_selection(int32_t sel, int32_t count, bool down) {
    if(down) {
        return (sel + 1 >= count) ? 0 : sel + 1;
    } else {
        return (sel - 1 < 0) ? count - 1 : sel - 1;
    }
}

bool calibration_wizard_compute_fit(const float measured[CAL_POINTS],
                                    const float targets[CAL_POINTS],
                                    float* out_gain, float* out_offset,
                                    float* out_r_squared) {
    // Three-point linear least-squares:  y = gain * x + offset
    // Σx, Σy, Σxx, Σxy  where x = measured, y = target
    float sx = 0, sy = 0, sxx = 0, sxy = 0;
    for(int i = 0; i < CAL_POINTS; i++) {
        float xi = measured[i];
        float yi = targets[i];
        sx  += xi;
        sy  += yi;
        sxx += xi * xi;
        sxy += xi * yi;
    }
    float n     = (float)CAL_POINTS;
    float denom = n * sxx - sx * sx;
    if(denom <= 1e-9f) {
        // Degenerate fit (measurements collinear/identical) — no meaningful
        // gain/offset/R² exist. Report neutral defaults rather than leaving
        // the caller's variables untouched.
        *out_gain = 1.0f;
        *out_offset = 0.0f;
        *out_r_squared = 0.0f;
        FURI_LOG_W("BioMap", "Calibration fit degenerate (measurements not distinct)");
        return false;
    }

    float gain   = (n * sxy - sx * sy) / denom;
    float offset = (sy - gain * sx) / n;

    // R² goodness-of-fit
    float y_mean = sy / n;
    float ss_res = 0, ss_tot = 0;
    for(int i = 0; i < CAL_POINTS; i++) {
        float yi     = targets[i];
        float y_pred = gain * measured[i] + offset;
        float res    = yi - y_pred;
        ss_res += res * res;
        float dev    = yi - y_mean;
        ss_tot += dev * dev;
    }
    float r_squared = (ss_tot > 1e-9f) ? (1.0f - ss_res / ss_tot) : 1.0f;

    // Always publish the computed fit so the caller (and the fit-fail
    // screen) can show the user what was actually measured.
    *out_gain = gain;
    *out_offset = offset;
    *out_r_squared = r_squared;

    // Validate bounds (nS domain) and linearity (R² ≥ 0.95)
    bool ok = gain >= CAL_GAIN_MIN && gain <= CAL_GAIN_MAX &&
              offset >= CAL_OFFSET_MIN && offset <= CAL_OFFSET_MAX &&
              r_squared >= 0.95f;
    if(!ok) {
        FURI_LOG_W("BioMap", "Calibration out of bounds: gain=%.4f off=%.1f R²=%.4f",
                   (double)gain, (double)offset, (double)r_squared);
    }
    return ok;
}

CalNoiseGrade calibration_noise_grade(float std_dev_ns) {
    if(std_dev_ns < CAL_NOISE_EXCELLENT_NS) return CalNoiseExcellent;
    if(std_dev_ns < CAL_NOISE_ACCEPTABLE_NS) return CalNoiseAcceptable;
    return CalNoisePoor;
}

// FNV-1a — shared by the calibration and settings checksums.
static uint32_t fnv1a_checksum(const void* data, size_t n) {
    uint32_t h = 0x811C9DC5u;
    const uint8_t* p = (const uint8_t*)data;
    for(size_t i = 0; i < n; i++) {
        h ^= p[i];
        h *= 0x01000193u;  // FNV-1a prime
    }
    return h;
}

uint32_t biomap_calibration_checksum(const BioMapCalibration* cal) {
    return fnv1a_checksum(cal, offsetof(BioMapCalibration, checksum));
}

CalRecordStatus biomap_calibration_check(const BioMapCalibration* cal) {
    if(cal->magic != BIOMAP_CAL_MAGIC) return CalRecordBadMagic;
    if(cal->version != BIOMAP_CAL_VERSION) return CalRecordBadVersion;
    if(cal->checksum != biomap_calibration_checksum(cal)) return CalRecordBadChecksum;

    // Written as "inside the range" so a NaN gain or offset fails too.
    if(!(cal->gain >= CAL_GAIN_MIN && cal->gain <= CAL_GAIN_MAX)) return CalRecordOutOfBounds;
    if(!(cal->offset >= CAL_OFFSET_MIN && cal->offset <= CAL_OFFSET_MAX)) return CalRecordOutOfBounds;
    for(int i = 0; i < CAL_POINTS; i++) {
        float sd = cal->noise_std_dev[i];
        if(isnan(sd) || sd < 0.0f || sd >= CAL_NOISE_ACCEPTABLE_NS) return CalRecordOutOfBounds;
    }
    return CalRecordOk;
}

uint32_t biomap_settings_checksum(const BioMapSettings* s) {
    return fnv1a_checksum(s, offsetof(BioMapSettings, checksum));
}

bool biomap_settings_valid(const BioMapSettings* s) {
    return s->magic == BIOMAP_SETTINGS_MAGIC &&
           s->version == BIOMAP_SETTINGS_VERSION &&
           s->checksum == biomap_settings_checksum(s) &&
           s->nav_model < GpsNavModelCount;
}
