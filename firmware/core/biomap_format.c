// biomap_format.c — see biomap_format.h.
//
// Plain C with no device code: shared by every device build. Failures are
// reported through return values; the caller decides whether to log them.

#include "biomap_format.h"

#include <math.h>
#include <stdio.h>
#include <string.h>

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
                   ",%u,%u,%u,%u,%.1f,%u,%u,%u,%u,%u,%u,%u,%u,%u,%u,%u,%.2f\n",
                   (unsigned)diag->tick_dt_ms, (unsigned)diag->gps_rx_drops,
                   (unsigned)diag->nmea_fail, (unsigned)diag->gps_reinit_count,
                   (double)diag->gsr_hz,
                   (unsigned)diag->i2c_peak_ms, (unsigned)diag->rf_rssi_peak_ms,
                   (unsigned)diag->rf_retune_peak_ms, (unsigned)diag->flush_peak_ms,
                   (unsigned)diag->log_fill_bytes, (unsigned)diag->log_fill_peak_bytes,
                   (unsigned)diag->log_overflow_count, (unsigned)diag->log_flush_fail_count,
                   (unsigned)diag->pga_change_count, (unsigned)diag->i2c_consec_fail,
                   (unsigned)diag->prealloc_ms, (double)diag->gsr_spread_ns)
        : snprintf(out + n, cap - (size_t)n, "\n");
    if(nd <= 0 || (size_t)(n + nd) >= cap) return -1;
    n += nd;

    return n;
}

int biomap_format_gsr_row(char* out, size_t cap, bool debug_fields,
                          double rel, float raw, const RowDiag* diag) {
    int n = debug_fields
        ? snprintf(out, cap, "%.2f,%.1f,%u,%u,%u,%u,%u,%u,%u,%.2f\n",
                   rel, (double)raw,
                   (unsigned)diag->log_fill_bytes, (unsigned)diag->log_fill_peak_bytes,
                   (unsigned)diag->log_overflow_count, (unsigned)diag->log_flush_fail_count,
                   (unsigned)diag->pga_change_count, (unsigned)diag->i2c_consec_fail,
                   (unsigned)diag->prealloc_ms, (double)diag->gsr_spread_ns)
        : snprintf(out, cap, "%.2f,%.1f\n", rel, (double)raw);
    if(n <= 0 || (size_t)n >= cap) return -1;
    return n;
}

int biomap_format_gsr_bias_line(char* out, size_t cap, float measured_v, float used_v) {
    int n = isfinite(measured_v)
        ? snprintf(out, cap, "# GSR Bias: measured_mv:%.1f,used_mv:%.1f\n",
                   (double)(measured_v * 1000.0f), (double)(used_v * 1000.0f))
        : snprintf(out, cap, "# GSR Bias: measured_mv:none,used_mv:%.1f\n",
                   (double)(used_v * 1000.0f));
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

void cal_dwell_init(CalDwell* d) {
    d->in_gate = 0;
    d->below = 0;
    d->above = 0;
    d->mean = 0.0f;
    d->m2 = 0.0f;
    d->all = 0;
    d->sum_all = 0.0f;
}

void cal_dwell_add(CalDwell* d, float v, float lo, float hi) {
    d->sum_all += v;
    d->all++;
    if(v >= lo && v <= hi) {
        d->in_gate++;
        float delta = v - d->mean;
        d->mean += delta / (float)d->in_gate;
        d->m2 += delta * (v - d->mean);
    } else if(v < lo) {
        d->below++;
    } else {
        d->above++;
    }
}

bool cal_dwell_ok(const CalDwell* d) {
    return d->in_gate >= CAL_MIN_VALID;
}

float cal_dwell_std(const CalDwell* d) {
    if(d->in_gate < 2) return 0.0f;
    return sqrtf(d->m2 / (float)(d->in_gate - 1));
}

float cal_dwell_mean_all(const CalDwell* d) {
    return d->all > 0 ? d->sum_all / (float)d->all : 0.0f;
}

const float biomap_cal_targets[CAL_POINTS] = {
    CAL_TARGET_470K, CAL_TARGET_100K, CAL_TARGET_47K,
};

const float biomap_cal_gates[CAL_POINTS][2] = {
    {CAL_LO_GATE,     CAL_MID_GATE_LO},
    {CAL_MID_GATE_LO, CAL_MID_GATE_HI},
    {CAL_LO_GATE_47K, CAL_HI_GATE},
};

float biomap_cal_worst_noise_std_dev(const float noise_std_dev[CAL_POINTS]) {
    float worst = noise_std_dev[0];
    for(int i = 1; i < CAL_POINTS; i++) {
        if(noise_std_dev[i] > worst) worst = noise_std_dev[i];
    }
    return worst;
}

bool calibration_wizard_compute_fit(const float measured[CAL_POINTS],
                                    const float targets[CAL_POINTS],
                                    float* out_gain, float* out_r_squared) {
    // Equal-weight (relative) least squares through the origin:
    // minimizes Σ ((gain * x_i - y_i) / y_i)² = Σ (gain * r_i - 1)²
    // where r_i = x_i / y_i, so gain = Σ r_i / Σ r_i².
    // Unweighted OLS (Σxy / Σxx) weighted 47k (~21k nS) at ~81% and 470k
    // (~2k nS) at <1%; relative weighting gives all three 0.1% resistors
    // equal say across the usable GSR range.
    float sy = 0, sr = 0, srr = 0;
    for(int i = 0; i < CAL_POINTS; i++) {
        float xi = measured[i];
        float yi = targets[i];
        if(yi <= 1e-9f) {
            *out_gain = 1.0f;
            *out_r_squared = 0.0f;
            return false;
        }
        float ri = xi / yi;
        sy  += yi;
        sr  += ri;
        srr += ri * ri;
    }
    float n = (float)CAL_POINTS;
    if(srr <= 1e-9f) {
        // Every measurement ~0 nS: no meaningful gain/R² exist. Report
        // neutral defaults rather than leaving the caller's variables
        // untouched.
        *out_gain = 1.0f;
        *out_r_squared = 0.0f;
        return false;
    }

    float gain = sr / srr;

    // R² goodness-of-fit, against the targets' own mean (same scale as the
    // earlier gain+offset fit, so the 0.95 gate means the same thing).
    float y_mean = sy / n;
    float ss_res = 0, ss_tot = 0;
    for(int i = 0; i < CAL_POINTS; i++) {
        float yi     = targets[i];
        float y_pred = gain * measured[i];
        float res    = yi - y_pred;
        ss_res += res * res;
        float dev    = yi - y_mean;
        ss_tot += dev * dev;
    }
    float r_squared = (ss_tot > 1e-9f) ? (1.0f - ss_res / ss_tot) : 1.0f;

    // Always publish the computed fit so the caller (and the fit-fail
    // screen) can show the user what was actually measured.
    *out_gain = gain;
    *out_r_squared = r_squared;

    // Validate gain bounds and linearity (R² ≥ 0.95)
    return gain >= CAL_GAIN_MIN && gain <= CAL_GAIN_MAX && r_squared >= 0.95f;
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

    // Written as "inside the range" so a NaN gain or zero fails too.
    if(!(cal->gain >= CAL_GAIN_MIN && cal->gain <= CAL_GAIN_MAX)) return CalRecordOutOfBounds;
    if(!(fabsf(cal->zero_counts) <= CAL_ZERO_MAX_COUNTS)) return CalRecordOutOfBounds;
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

int biomap_format_file_stamp(char* out, size_t cap, uint16_t year, uint8_t month, uint8_t day,
                             uint8_t hour, uint8_t minute, uint8_t second) {
    int n = snprintf(out, cap, "%04u-%02u-%02u_%02u-%02u-%02u",
                     (unsigned)year, (unsigned)month, (unsigned)day,
                     (unsigned)hour, (unsigned)minute, (unsigned)second);
    return (n < 0 || (size_t)n >= cap) ? -1 : n;
}

void bt_stream_pack_packet(uint8_t out[BT_STREAM_PACKET_SIZE],
                           uint32_t timestamp_ms,
                           const GpsPosition* pos,
                           float gsr_raw) {
    out[0] = 0x42; // 'B'
    out[1] = 0x4e; // 'N'
    memcpy(out + 2, &timestamp_ms, sizeof(timestamp_ms));
    // Not a `pos->valid ? pos->lat : 0.0` ternary — this project's build
    // treats -Wdouble-promotion as an error, and GCC's conditional-operator
    // type unification flags that form even though both branches are
    // already double.
    double lat = 0.0, lon = 0.0;
    if(pos->valid) {
        lat = pos->lat;
        lon = pos->lon;
    }
    memcpy(out + 6,  &lat, sizeof(lat));
    memcpy(out + 14, &lon, sizeof(lon));
    memcpy(out + 22, &gsr_raw, sizeof(gsr_raw));
    memcpy(out + 26, &pos->hdop, sizeof(pos->hdop));
    memcpy(out + 30, &pos->pdop, sizeof(pos->pdop));
    // speed_kts/course_deg are NaN when GPS has no velocity fix (see
    // get_gps_position) — the wire format has no separate "no velocity"
    // flag, so send 0 rather than propagating a NaN the frontend would
    // have to special-case.
    float speed = isnan(pos->speed_kts) ? 0.0f : pos->speed_kts;
    float course = isnan(pos->course_deg) ? 0.0f : pos->course_deg;
    memcpy(out + 34, &speed, sizeof(speed));
    memcpy(out + 38, &course, sizeof(course));
    out[42] = (uint8_t)pos->sats;
    out[43] = (uint8_t)pos->fix_type;
    out[44] = pos->valid ? 1 : 0;
    // u-blox hAcc (m), 99.9 when unknown — as in the SD log's hacc_m column.
    memcpy(out + 45, &pos->hacc, sizeof(pos->hacc));
}
