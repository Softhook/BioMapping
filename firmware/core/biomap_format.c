// biomap_format.c — see biomap_format.h.
//
// Plain C with no device code: shared by every device build. Failures are
// reported through return values; the caller decides whether to log them.

#include "biomap_format.h"

#include <math.h>
#include <stdio.h>
#include <string.h>

// Shared trailing 8 debug columns carried by both GPS+GSR and GSR-only rows.
static int format_common_diag_tail(char* buf, size_t cap, const RowDiag* diag) {
    int n = snprintf(buf, cap, "%u,%u,%u,%u,%u,%u,%u,%.2f\n",
                     (unsigned)diag->log_fill_bytes, (unsigned)diag->log_fill_peak_bytes,
                     (unsigned)diag->log_overflow_count, (unsigned)diag->log_flush_fail_count,
                     (unsigned)diag->pga_change_count, (unsigned)diag->i2c_consec_fail,
                     (unsigned)diag->prealloc_ms, (double)diag->gsr_spread_ns);
    return (n <= 0 || (size_t)n >= cap) ? -1 : n;
}

int biomap_format_gps_row(char* out, size_t cap, bool debug_fields,
                          const GpsPosition* pos, double rel, float raw,
                          const float* rf_rssi, const RowDiag* diag) {
    _Static_assert(RF_BAND_COUNT == 3, "update rf_rssi snprintf for RF_BAND_COUNT");
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
    if(n2 < 0 || (size_t)n2 >= cap - (size_t)n) return -1;
    n += n2;

    // Debug columns are always appended at the very end so production
    // columns stay contiguous and easy to consume.
    if(!debug_fields) {
        int nd = snprintf(out + n, cap - (size_t)n, "\n");
        return (nd <= 0 || (size_t)nd >= cap - (size_t)n) ? -1 : n + nd;
    }
    int nd = snprintf(out + n, cap - (size_t)n,
                      ",%u,%u,%u,%u,%.1f,%u,%u,%u,%u,",
                      (unsigned)diag->tick_dt_ms, (unsigned)diag->gps_rx_drops,
                      (unsigned)diag->nmea_fail, (unsigned)diag->gps_reinit_count,
                      (double)diag->gsr_hz,
                      (unsigned)diag->i2c_peak_ms, (unsigned)diag->rf_rssi_peak_ms,
                      (unsigned)diag->rf_retune_peak_ms, (unsigned)diag->flush_peak_ms);
    if(nd <= 0 || (size_t)nd >= cap - (size_t)n) return -1;
    n += nd;
    int nt = format_common_diag_tail(out + n, cap - (size_t)n, diag);
    return (nt <= 0) ? -1 : n + nt;
}

int biomap_format_gsr_row(char* out, size_t cap, bool debug_fields,
                          double rel, float raw, const RowDiag* diag) {
    if(!debug_fields) {
        int n = snprintf(out, cap, "%.2f,%.1f\n", rel, (double)raw);
        return (n <= 0 || (size_t)n >= cap) ? -1 : n;
    }
    int n = snprintf(out, cap, "%.2f,%.1f,", rel, (double)raw);
    if(n <= 0 || (size_t)n >= cap) return -1;
    int nt = format_common_diag_tail(out + n, cap - (size_t)n, diag);
    return (nt <= 0) ? -1 : n + nt;
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

int scroll_window_top(int sel, int count, int max_visible) {
    if(count > max_visible && sel >= max_visible) return sel - max_visible + 1;
    return 0;
}

const char* biomap_nav_model_label(GpsNavModel model) {
    static const char* const LABEL[] = {
        "PED", "WRIST", "VEHICLE", "STATION", "SEA", "BIKE", "FLIGHT",
    };
    _Static_assert(sizeof(LABEL) / sizeof(LABEL[0]) == GpsNavModelCount,
                   "one label per GpsNavModel");
    return ((unsigned)model < GpsNavModelCount) ? LABEL[model] : "?";
}

const char* biomap_mode_name(BioMapMode mode) {
    switch(mode) {
    case BioMapModeGpsGsrRf:    return "GPS + GSR + RF";
    case BioMapModeGpsGsr:      return "GPS + GSR";
    case BioMapModeGpsOnly:     return "GPS + RF";
    case BioMapModeGsrOnly:     return "GSR Only";
    case BioMapModeDiagnostics: return "Diagnostics";
    case BioMapModeLiveStream:  return "Live Stream";
    }
    return "?";
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

const CalStepInfo biomap_cal_steps[CAL_POINTS] = {
    {"Low",  "470k"},
    {"Mid",  "100k"},
    {"High", "47k"},
};

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

int biomap_format_cal_age(char* buf, size_t cap, uint32_t saved_epoch, uint32_t now_epoch) {
    int n = (saved_epoch == 0 || now_epoch == 0 || now_epoch < saved_epoch)
        ? snprintf(buf, cap, "Age: unknown")
        : snprintf(buf, cap, "Age: %lu d", (unsigned long)((now_epoch - saved_epoch) / 86400UL));
    return (n < 0 || (size_t)n >= cap) ? -1 : n;
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

    // Validate gain bounds and linearity (R² ≥ CAL_MIN_R_SQUARED)
    return gain >= CAL_GAIN_MIN && gain <= CAL_GAIN_MAX && r_squared >= CAL_MIN_R_SQUARED;
}

CalNoiseGrade calibration_noise_grade(float std_dev_ns) {
    if(std_dev_ns < CAL_NOISE_EXCELLENT_NS) return CalNoiseExcellent;
    if(std_dev_ns < CAL_NOISE_ACCEPTABLE_NS) return CalNoiseAcceptable;
    return CalNoisePoor;
}

// Table-driven: the SD logger folds each ~11–17 kB flush into the CRC on
// the main thread, next to the SD write, so the byte loop is kept cheap.
// The table is const, so it lives in flash and costs no RAM.
static const uint32_t crc32_table[256] = {
    0x00000000, 0x77073096, 0xee0e612c, 0x990951ba,
    0x076dc419, 0x706af48f, 0xe963a535, 0x9e6495a3,
    0x0edb8832, 0x79dcb8a4, 0xe0d5e91e, 0x97d2d988,
    0x09b64c2b, 0x7eb17cbd, 0xe7b82d07, 0x90bf1d91,
    0x1db71064, 0x6ab020f2, 0xf3b97148, 0x84be41de,
    0x1adad47d, 0x6ddde4eb, 0xf4d4b551, 0x83d385c7,
    0x136c9856, 0x646ba8c0, 0xfd62f97a, 0x8a65c9ec,
    0x14015c4f, 0x63066cd9, 0xfa0f3d63, 0x8d080df5,
    0x3b6e20c8, 0x4c69105e, 0xd56041e4, 0xa2677172,
    0x3c03e4d1, 0x4b04d447, 0xd20d85fd, 0xa50ab56b,
    0x35b5a8fa, 0x42b2986c, 0xdbbbc9d6, 0xacbcf940,
    0x32d86ce3, 0x45df5c75, 0xdcd60dcf, 0xabd13d59,
    0x26d930ac, 0x51de003a, 0xc8d75180, 0xbfd06116,
    0x21b4f4b5, 0x56b3c423, 0xcfba9599, 0xb8bda50f,
    0x2802b89e, 0x5f058808, 0xc60cd9b2, 0xb10be924,
    0x2f6f7c87, 0x58684c11, 0xc1611dab, 0xb6662d3d,
    0x76dc4190, 0x01db7106, 0x98d220bc, 0xefd5102a,
    0x71b18589, 0x06b6b51f, 0x9fbfe4a5, 0xe8b8d433,
    0x7807c9a2, 0x0f00f934, 0x9609a88e, 0xe10e9818,
    0x7f6a0dbb, 0x086d3d2d, 0x91646c97, 0xe6635c01,
    0x6b6b51f4, 0x1c6c6162, 0x856530d8, 0xf262004e,
    0x6c0695ed, 0x1b01a57b, 0x8208f4c1, 0xf50fc457,
    0x65b0d9c6, 0x12b7e950, 0x8bbeb8ea, 0xfcb9887c,
    0x62dd1ddf, 0x15da2d49, 0x8cd37cf3, 0xfbd44c65,
    0x4db26158, 0x3ab551ce, 0xa3bc0074, 0xd4bb30e2,
    0x4adfa541, 0x3dd895d7, 0xa4d1c46d, 0xd3d6f4fb,
    0x4369e96a, 0x346ed9fc, 0xad678846, 0xda60b8d0,
    0x44042d73, 0x33031de5, 0xaa0a4c5f, 0xdd0d7cc9,
    0x5005713c, 0x270241aa, 0xbe0b1010, 0xc90c2086,
    0x5768b525, 0x206f85b3, 0xb966d409, 0xce61e49f,
    0x5edef90e, 0x29d9c998, 0xb0d09822, 0xc7d7a8b4,
    0x59b33d17, 0x2eb40d81, 0xb7bd5c3b, 0xc0ba6cad,
    0xedb88320, 0x9abfb3b6, 0x03b6e20c, 0x74b1d29a,
    0xead54739, 0x9dd277af, 0x04db2615, 0x73dc1683,
    0xe3630b12, 0x94643b84, 0x0d6d6a3e, 0x7a6a5aa8,
    0xe40ecf0b, 0x9309ff9d, 0x0a00ae27, 0x7d079eb1,
    0xf00f9344, 0x8708a3d2, 0x1e01f268, 0x6906c2fe,
    0xf762575d, 0x806567cb, 0x196c3671, 0x6e6b06e7,
    0xfed41b76, 0x89d32be0, 0x10da7a5a, 0x67dd4acc,
    0xf9b9df6f, 0x8ebeeff9, 0x17b7be43, 0x60b08ed5,
    0xd6d6a3e8, 0xa1d1937e, 0x38d8c2c4, 0x4fdff252,
    0xd1bb67f1, 0xa6bc5767, 0x3fb506dd, 0x48b2364b,
    0xd80d2bda, 0xaf0a1b4c, 0x36034af6, 0x41047a60,
    0xdf60efc3, 0xa867df55, 0x316e8eef, 0x4669be79,
    0xcb61b38c, 0xbc66831a, 0x256fd2a0, 0x5268e236,
    0xcc0c7795, 0xbb0b4703, 0x220216b9, 0x5505262f,
    0xc5ba3bbe, 0xb2bd0b28, 0x2bb45a92, 0x5cb36a04,
    0xc2d7ffa7, 0xb5d0cf31, 0x2cd99e8b, 0x5bdeae1d,
    0x9b64c2b0, 0xec63f226, 0x756aa39c, 0x026d930a,
    0x9c0906a9, 0xeb0e363f, 0x72076785, 0x05005713,
    0x95bf4a82, 0xe2b87a14, 0x7bb12bae, 0x0cb61b38,
    0x92d28e9b, 0xe5d5be0d, 0x7cdcefb7, 0x0bdbdf21,
    0x86d3d2d4, 0xf1d4e242, 0x68ddb3f8, 0x1fda836e,
    0x81be16cd, 0xf6b9265b, 0x6fb077e1, 0x18b74777,
    0x88085ae6, 0xff0f6a70, 0x66063bca, 0x11010b5c,
    0x8f659eff, 0xf862ae69, 0x616bffd3, 0x166ccf45,
    0xa00ae278, 0xd70dd2ee, 0x4e048354, 0x3903b3c2,
    0xa7672661, 0xd06016f7, 0x4969474d, 0x3e6e77db,
    0xaed16a4a, 0xd9d65adc, 0x40df0b66, 0x37d83bf0,
    0xa9bcae53, 0xdebb9ec5, 0x47b2cf7f, 0x30b5ffe9,
    0xbdbdf21c, 0xcabac28a, 0x53b39330, 0x24b4a3a6,
    0xbad03605, 0xcdd70693, 0x54de5729, 0x23d967bf,
    0xb3667a2e, 0xc4614ab8, 0x5d681b02, 0x2a6f2b94,
    0xb40bbe37, 0xc30c8ea1, 0x5a05df1b, 0x2d02ef8d,
};

uint32_t biomap_crc32_update(uint32_t crc, const void* data, size_t len) {
    const uint8_t* p = (const uint8_t*)data;
    for(size_t i = 0; i < len; i++) {
        crc = (crc >> 8) ^ crc32_table[(crc ^ p[i]) & 0xffu];
    }
    return crc;
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

BioMapCalibration biomap_calibration_make(float gain, float zero_counts, uint32_t timestamp,
                                          float r_squared,
                                          const float noise_std_dev[CAL_POINTS]) {
    BioMapCalibration cal;
    memset(&cal, 0, sizeof(cal));
    cal.magic = BIOMAP_CAL_MAGIC;
    cal.version = BIOMAP_CAL_VERSION;
    cal.gain = gain;
    cal.zero_counts = zero_counts;
    cal.timestamp = timestamp;
    cal.r_squared = r_squared;
    memcpy(cal.noise_std_dev, noise_std_dev, sizeof(cal.noise_std_dev));
    cal.checksum = biomap_calibration_checksum(&cal);
    return cal;
}

const char* biomap_calibration_status_text(CalRecordStatus status) {
    switch(status) {
    case CalRecordOk: return "ok";
    case CalRecordBadMagic: return "not a calibration file";
    case CalRecordBadVersion: return "older format, run the wizard again";
    case CalRecordBadChecksum: return "checksum mismatch";
    case CalRecordOutOfBounds: return "values out of bounds";
    }
    return "?";
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

BioMapSettings biomap_settings_make(bool zoom_enabled, bool backlight_on, bool sound_enabled,
                                    GpsNavModel nav_model, bool super_s,
                                    bool debug_fields_enabled) {
    BioMapSettings s;
    memset(&s, 0, sizeof(s));
    s.magic = BIOMAP_SETTINGS_MAGIC;
    s.version = BIOMAP_SETTINGS_VERSION;
    s.zoom_enabled = zoom_enabled;
    s.backlight_on = backlight_on;
    s.sound_enabled = sound_enabled;
    s.nav_model = (uint32_t)nav_model;
    s.super_s = super_s;
    s.debug_fields_enabled = debug_fields_enabled;
    s.checksum = biomap_settings_checksum(&s);
    return s;
}

int biomap_format_file_stamp(char* out, size_t cap, uint16_t year, uint8_t month, uint8_t day,
                             uint8_t hour, uint8_t minute, uint8_t second) {
    int n = snprintf(out, cap, "%04u-%02u-%02u_%02u-%02u-%02u",
                     (unsigned)year, (unsigned)month, (unsigned)day,
                     (unsigned)hour, (unsigned)minute, (unsigned)second);
    return (n < 0 || (size_t)n >= cap) ? -1 : n;
}

int biomap_format_mac(char* out, size_t cap, const uint8_t mac[6]) {
    int n = snprintf(out, cap, "%02X:%02X:%02X:%02X:%02X:%02X",
                     (unsigned)mac[0], (unsigned)mac[1], (unsigned)mac[2],
                     (unsigned)mac[3], (unsigned)mac[4], (unsigned)mac[5]);
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
    // speed_kts/course_deg are NaN when unknown (see get_gps_position()),
    // and sent as NaN: a 0 would read as a real standstill or due north.
    memcpy(out + 34, &pos->speed_kts, sizeof(pos->speed_kts));
    memcpy(out + 38, &pos->course_deg, sizeof(pos->course_deg));
    out[42] = (uint8_t)pos->sats;
    out[43] = (uint8_t)pos->fix_type;
    out[44] = pos->valid ? 1 : 0;
    // u-blox hAcc (m), 99.9 when unknown — as in the SD log's hacc_m column.
    memcpy(out + 45, &pos->hacc, sizeof(pos->hacc));
}
