#include <stdio.h>
#include <stdbool.h>
#include <math.h>
#include <string.h>
#include <assert.h>
#include <stdarg.h>

#include "minmea.h"
#define timegm mock_timegm
#include "minmea.c"

#define GRAPH_N          126
#define GRAPH_HALF       63
#define TICK_HZ          10
#define SMOOTH_IIR_A     0.848f
#define SMOOTH_IIR_B     0.152f
#define DISPLAY_EMA_A    0.2f
#define DISPLAY_EMA_B    0.8f
#define ZOOM_PEAK_DECAY   0.997f
#define ZOOM_LERP_RATE    0.02f
#define ZOOM_TARGET_DIV   80.0f
#define ZOOM_PEAK_FLOOR   0.5f
#define GRAPH_RATE_SCALE  0.2f
#define REFRESH_EVERY     5
#define ZOOM_MIN         0.25f
#define ZOOM_MAX         16.0f
#define GPS_HDOP_GATE    5.0f

typedef struct {
    float    smooth_iir;
    bool     smooth_iir_primed;
    float    smoothed;
    bool     primed;
    float    last_displayed;
    int      refresh_counter;
} DisplayState;

typedef struct {
    float    buf[GRAPH_N];
    int      head;
    int      tick_counter;
    float    last_smoothed;
    int      scroll_divider;
} GraphState;

typedef struct {
    float    level;
    float    peak;
    bool     enabled;
    int      manual_timeout;
} ZoomState;

typedef struct {
    bool   valid;
    double lat;
    double lon;
    float  hdop;
    float  pdop;
    int    sats;
    int    fix_type;
    float  speed_kts;
    float  course_deg;
} GpsPosition;

typedef struct {
    DisplayState   display;
    GraphState     graph;
    ZoomState      zoom;
    void*          logger;
} Session;

// --- Mock Logger ---
char mock_logger_buf[256];
int sd_logger_batch_printf(void* logger, const char* format, ...) {
    va_list args;
    va_start(args, format);
    int ret = vsprintf(mock_logger_buf, format, args);
    va_end(args);
    return ret;
}

// --- Functions Under Test ---

static float smooth_iir_filter(DisplayState* d, float raw) {
    if(!d->smooth_iir_primed) {
        d->smooth_iir = raw;
        d->smooth_iir_primed = true;
        return raw;
    }
    d->smooth_iir = SMOOTH_IIR_A * raw + SMOOTH_IIR_B * d->smooth_iir;
    return d->smooth_iir;
}

static void update_display_pipeline(Session* s, float raw) {
    float filtered = smooth_iir_filter(&s->display, raw);

    if(!s->display.primed) {
        s->display.smoothed = filtered;
        s->graph.last_smoothed = filtered;
        s->display.last_displayed = filtered;
        s->display.primed = true;
    }
    float ns = DISPLAY_EMA_A * filtered + DISPLAY_EMA_B * s->display.smoothed;
    s->display.smoothed = ns;

    s->display.refresh_counter++;
    if(s->display.refresh_counter >= REFRESH_EVERY) {
        s->display.last_displayed = filtered;
        s->display.refresh_counter = 0;
    }
}

static void update_graph_pipeline(Session* s) {
    if(s->zoom.manual_timeout > 0) {
        s->zoom.manual_timeout--;
        if(s->zoom.manual_timeout == 0) {
            s->zoom.peak = ZOOM_TARGET_DIV / s->zoom.level;
            if(s->zoom.peak < ZOOM_PEAK_FLOOR) s->zoom.peak = ZOOM_PEAK_FLOOR;
        }
    }

    bool auto_active = s->zoom.enabled && s->zoom.manual_timeout == 0;

    if(auto_active) {
        s->zoom.peak *= ZOOM_PEAK_DECAY;
    }

    s->graph.tick_counter++;
    if(s->graph.tick_counter >= s->graph.scroll_divider) {
        float rate = s->display.smoothed - s->graph.last_smoothed;
        s->graph.buf[s->graph.head] = -(rate / (float)s->graph.scroll_divider) * GRAPH_RATE_SCALE;
        if(++s->graph.head >= GRAPH_N) s->graph.head = 0;
        s->graph.last_smoothed = s->display.smoothed;
        s->graph.tick_counter = 0;

        if(auto_active) {
            int just_written = s->graph.head - 1;
            if(just_written < 0) just_written = GRAPH_N - 1;
            float newest = fabsf(s->graph.buf[just_written]);
            if(newest > s->zoom.peak) s->zoom.peak = newest;
            if(s->zoom.peak < ZOOM_PEAK_FLOOR) s->zoom.peak = ZOOM_PEAK_FLOOR;
        }
    }

    if(auto_active && s->zoom.peak >= ZOOM_PEAK_FLOOR) {
        float target = ZOOM_TARGET_DIV / s->zoom.peak;
        target = fmaxf(ZOOM_MIN, fminf(ZOOM_MAX, target));
        s->zoom.level += (target - s->zoom.level) * ZOOM_LERP_RATE;
    }
}

static void rescale_graph_buf(Session* s, bool zoom_out) {
    float temp[GRAPH_N];

    for(int i = 0; i < GRAPH_N; i++) {
        temp[i] = s->graph.buf[(s->graph.head + i) % GRAPH_N];
    }
    memset(s->graph.buf, 0, sizeof(s->graph.buf));
    s->graph.head = 0;

    if(zoom_out) {
        for(int i = 0; i < GRAPH_HALF; i++) {
            s->graph.buf[GRAPH_HALF + i] = (temp[i * 2] + temp[i * 2 + 1]) * 0.5f;
        }
    } else {
        for(int i = 0; i < GRAPH_HALF; i++) {
            float curr = temp[GRAPH_HALF + i];
            float next = (i + 1 < GRAPH_HALF) ? temp[GRAPH_HALF + i + 1] : curr;
            s->graph.buf[i * 2]     = curr;
            s->graph.buf[i * 2 + 1] = (curr + next) * 0.5f;
        }
    }
}

static float convert_adc_to_conductance_ns(float avg_norm) {
    if(avg_norm <= 0) {
        return 0.0f;
    }
    float clamped = (avg_norm > 319000) ? 319000.0f : (float)avg_norm;
    float num = clamped * 5000000.0f;
    float den = 15040000.0f - clamped * 47.0f;
    return num / den;
}

static inline double minmea_tocoord_double(const struct minmea_float* f) {
    if(f->scale == 0) return (double)NAN;
    int_least32_t scale100 = f->scale * 100;
    int_least32_t deg = f->value / scale100;
    int_least32_t min = f->value % scale100;
    return (double)deg + (double)min / ((double)f->scale * 60);
}

static bool format_gps_csv_row(Session* s, const GpsPosition* pos,
                                double rel, float raw) {
    bool gps_ok = pos->valid && pos->hdop < GPS_HDOP_GATE;
    int ret;
    if(gps_ok) {
        bool has_vel = !isnan(pos->speed_kts) && !isnan(pos->course_deg);
        if(has_vel) {
            ret = sd_logger_batch_printf(s->logger,
                "%.2f,%.7f,%.7f,%.1f,%.1f,%d,%d,%.2f,%.1f,%.1f\n",
                rel, pos->lat, pos->lon,
                (double)pos->hdop, (double)pos->pdop,
                pos->sats, pos->fix_type,
                (double)pos->speed_kts, (double)pos->course_deg, (double)raw);
        } else {
            ret = sd_logger_batch_printf(s->logger,
                "%.2f,%.7f,%.7f,%.1f,%.1f,%d,%d,,,%.1f\n",
                rel, pos->lat, pos->lon,
                (double)pos->hdop, (double)pos->pdop,
                pos->sats, pos->fix_type, (double)raw);
        }
    } else {
        ret = sd_logger_batch_printf(s->logger, "%.2f,,,,,,,,,%.1f\n",
                                     rel, (double)raw);
    }
    return ret > 0;
}

// --- Test Suites ---

void test_smooth_iir_filter() {
    printf("Running test_smooth_iir_filter...\n");
    DisplayState d = {0};
    
    // Initial call primes the filter
    float raw1 = 100.0f;
    float out1 = smooth_iir_filter(&d, raw1);
    assert(out1 == raw1);
    assert(d.smooth_iir == raw1);
    assert(d.smooth_iir_primed == true);

    // Subsequent calls apply IIR filter: out = 0.848 * raw + 0.152 * prev
    float raw2 = 120.0f;
    float out2 = smooth_iir_filter(&d, raw2);
    float expected = 0.848f * raw2 + 0.152f * raw1;
    assert(fabsf(out2 - expected) < 1e-4f);
    printf("  -> Pass\n");
}

void test_update_display_pipeline() {
    printf("Running test_update_display_pipeline...\n");
    Session s = {0};
    s.display.refresh_counter = 0;

    // Tick 1
    update_display_pipeline(&s, 10.0f);
    assert(s.display.primed == true);
    assert(s.display.smoothed == 10.0f);
    assert(s.graph.last_smoothed == 10.0f);
    assert(s.display.refresh_counter == 1);

    // Tick 2 to 5 to trigger display refresh
    update_display_pipeline(&s, 10.0f);
    update_display_pipeline(&s, 10.0f);
    update_display_pipeline(&s, 10.0f);
    update_display_pipeline(&s, 10.0f); // refresh_counter reaches 5
    assert(s.display.refresh_counter == 0);
    printf("  -> Pass\n");
}

void test_rescale_graph_buf() {
    printf("Running test_rescale_graph_buf...\n");
    Session s = {0};
    s.graph.head = 0;

    // Fill buffer with mock rate data (0 to GRAPH_N-1)
    for (int i = 0; i < GRAPH_N; i++) {
        s.graph.buf[i] = (float)i;
    }

    // Zoom out (average adjacent pairs)
    rescale_graph_buf(&s, true);
    assert(s.graph.head == 0);
    // Positions [0..62] should be 0
    for (int i = 0; i < GRAPH_HALF; i++) {
        assert(s.graph.buf[i] == 0.0f);
    }
    // Positions [63..125] should be averaged pairs: (i*2 + i*2+1)*0.5 = i*2 + 0.5
    for (int i = 0; i < GRAPH_HALF; i++) {
        float expected = (float)(i * 2) + 0.5f;
        assert(fabsf(s.graph.buf[GRAPH_HALF + i] - expected) < 1e-4f);
    }

    // Reset buffer and test Zoom in (double resolution of latest GRAPH_HALF)
    s.graph.head = 0;
    for (int i = 0; i < GRAPH_N; i++) {
        s.graph.buf[i] = (float)i;
    }
    rescale_graph_buf(&s, false);
    assert(s.graph.head == 0);
    // Zoom in processes the newer half [63..125], interpolating:
    // even positions get the original value, odd get the average of current and next.
    for (int i = 0; i < GRAPH_HALF; i++) {
        float curr = (float)(GRAPH_HALF + i);
        float next = (i + 1 < GRAPH_HALF) ? (float)(GRAPH_HALF + i + 1) : curr;
        assert(fabsf(s.graph.buf[i * 2] - curr) < 1e-4f);
        assert(fabsf(s.graph.buf[i * 2 + 1] - (curr + next) * 0.5f) < 1e-4f);
    }
    printf("  -> Pass\n");
}

void test_conductance_conversion() {
    printf("Running test_conductance_conversion...\n");
    // $0 counts -> 0 nS
    assert(convert_adc_to_conductance_ns(0.0f) == 0.0f);
    assert(convert_adc_to_conductance_ns(-100.0f) == 0.0f);

    // Plug in clamped = 25000 -> G should be approx 9015.5 nS
    float g1 = convert_adc_to_conductance_ns(25000.0f);
    assert(fabs(g1 - 9015.5f) < 1.0f);

    // Over-saturation clamp check (clamped to 319000 counts)
    float gMax = convert_adc_to_conductance_ns(500000.0f);
    float gExpectedMax = (319000.0f * 5000000.0f) / (15040000.0f - 319000.0f * 47.0f);
    assert(fabs(gMax - gExpectedMax) < 1e-2f);
    printf("  -> Pass\n");
}

void test_calibration_calculations() {
    printf("Running test_calibration_calculations...\n");
    // Three-point least-squares calibration — pure nS domain.
    // A device that reads ~4 % low across all three resistors.
    // Targets are true physical conductance: 1e9 / R_ohms.
    float measured[3]  = { 2050.0f, 9600.0f, 20500.0f };  // 470k, 100k, 47k
    float targets[3]   = { 2127.66f, 10000.0f, 21276.6f };

    // Three-point least-squares:  y = gain * x + offset  (all in nS)
    double sx = 0, sy = 0, sxx = 0, sxy = 0;
    for(int i = 0; i < 3; i++) {
        double xi = (double)measured[i];
        double yi = (double)targets[i];
        sx  += xi;
        sy  += yi;
        sxx += xi * xi;
        sxy += xi * yi;
    }
    double denom = 3.0 * sxx - sx * sx;
    assert(denom > 1e-9);
    float gain   = (float)((3.0 * sxy - sx * sy) / denom);
    float offset = (float)((sy - (double)gain * sx) / 3.0);

    // Gain near 1.0, offset small (device is close to reference).
    assert(gain >= 0.9f && gain <= 1.1f);
    assert(fabs(offset) < 1000.0f);

    // Apply calibration — all three points should land near targets.
    for(int i = 0; i < 3; i++) {
        float cal = gain * measured[i] + offset;
        assert(fabs(cal - targets[i]) < 100.0f);
    }

    // R² goodness-of-fit should be near 1.0 (linear device assumption holds).
    double y_mean = sy / 3.0;
    double ss_res = 0, ss_tot = 0;
    for(int i = 0; i < 3; i++) {
        double yi     = (double)targets[i];
        double y_pred = (double)gain * (double)measured[i] + (double)offset;
        double res    = yi - y_pred;
        ss_res += res * res;
        double dev    = yi - y_mean;
        ss_tot += dev * dev;
    }
    float r2 = (float)(1.0 - ss_res / ss_tot);
    assert(r2 > 0.999f);

    // Verify a mid-range reading: calibrated nS must be sane.
    float mid_cal = gain * 9600.0f + offset;
    assert(mid_cal > 9800.0f && mid_cal < 10200.0f);

    printf("  gain=%.4f offset=%.1f R²=%.6f -> Pass\n", (double)gain, (double)offset, (double)r2);
}

void test_csv_formatting() {
    printf("Running test_csv_formatting...\n");
    Session s = {0};
    GpsPosition pos = {0};

    // Case 1: Valid 3D GPS fix with speed and course
    pos.valid = true;
    pos.lat = 51.5557397;
    pos.lon = -0.0714595;
    pos.hdop = 0.9f;
    pos.pdop = 1.3f;
    pos.sats = 16;
    pos.fix_type = 3;
    pos.speed_kts = 5.25f;
    pos.course_deg = 330.2f;
    
    mock_logger_buf[0] = '\0';
    format_gps_csv_row(&s, &pos, 1.25, 8345.3f);
    assert(strcmp(mock_logger_buf, "1.25,51.5557397,-0.0714595,0.9,1.3,16,3,5.25,330.2,8345.3\n") == 0);

    // Case 2: Valid GPS fix but no speed/course (stationary)
    pos.speed_kts = NAN;
    pos.course_deg = NAN;
    mock_logger_buf[0] = '\0';
    format_gps_csv_row(&s, &pos, 2.50, 8350.0f);
    assert(strcmp(mock_logger_buf, "2.50,51.5557397,-0.0714595,0.9,1.3,16,3,,,8350.0\n") == 0);

    // Case 3: Invalid GPS fix (e.g. startup, or high HDOP > 5.0)
    pos.hdop = 6.0f; // Exceeds gate limit
    mock_logger_buf[0] = '\0';
    format_gps_csv_row(&s, &pos, 3.75, 8400.0f);
    assert(strcmp(mock_logger_buf, "3.75,,,,,,,,,8400.0\n") == 0);
    printf("  -> Pass\n");
}

void test_nmea_parsing() {
    printf("Running test_nmea_parsing...\n");
    // $GNGGA sentence with valid coordinates:
    // Latitude: 5133.34438 N -> 51.5557397 N
    // Longitude: 00004.28757 W -> -0.0714595 W
    const char* gga_sentence = "$GNGGA,203337.00,5133.34438,N,00004.28757,W,1,16,0.9,123.4,M,45.6,M,,*50";
    
    struct minmea_sentence_gga frame;
    bool parsed = minmea_parse_gga(&frame, gga_sentence);
    assert(parsed == true);
    
    double lat = minmea_tocoord_double(&frame.latitude);
    double lon = minmea_tocoord_double(&frame.longitude); // minmea parses hemisphere sign internally
    
    printf("  parsed lat = %.9f, lon = %.9f\n", lat, lon);
    assert(fabs(lat - 51.55573966) < 1e-6);
    assert(fabs(lon - (-0.0714595)) < 1e-6);
    
    float hdop = minmea_tofloat(&frame.hdop);
    assert(fabs(hdop - 0.9f) < 1e-4f);
    printf("  -> Pass\n");
}

int main() {
    printf("========================================\n");
    printf("FIRMWARE PIPELINE STAGE 1 & 2 VERIFICATION\n");
    printf("========================================\n");
    test_smooth_iir_filter();
    test_update_display_pipeline();
    test_rescale_graph_buf();
    test_conductance_conversion();
    test_calibration_calculations();
    test_csv_formatting();
    test_nmea_parsing();
    printf("All 7 firmware unit tests passed successfully!\n");
    return 0;
}
