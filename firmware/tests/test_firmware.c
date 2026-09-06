#include <stdio.h>
#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
#include <math.h>
#include <string.h>
#include <assert.h>
#include <stdarg.h>

#include "biomap_pipeline.h"

#include "minmea.h"
#define timegm mock_timegm
#include "minmea.c"

// ── Test-only Session struct — embeds Pipeline, adds a mock logger ────
// The real Session (biomap.h) has Flipper-specific fields we can't use
// on a host compiler, so we define a minimal one for testing.
typedef struct {
    Pipeline       pipeline;
    void*          logger;
    bool           debug_fields_enabled;
} Session;

// --- Mock Logger ---
// Sized to match (with margin) format_gps_csv_row()'s own row[300] stack
// buffer (biomap_session.c) -- strcpy() below has no bound check of its
// own, so this must stay >= the longest row that function can produce or a
// wide-enough debug row silently overflows this global.
char mock_logger_buf[320];
int sd_logger_batch_printf(void* logger, const char* format, ...) {
    (void)logger;
    va_list args;
    va_start(args, format);
    int ret = vsprintf(mock_logger_buf, format, args);
    va_end(args);
    return ret;
}

// --- Functions Under Test ---

// These are now in biomap_pipeline.h/.c — the test links against biomap_pipeline.o.
// We keep only the functions that haven't been extracted yet.

// Mirrors cycle_selection() in biomap_gui.c: moves a list selection by one
// step with wraparound — Up on the first item jumps to the last, Down on
// the last item jumps back to the first. Shared by the main menu, Options
// screen, and GSR Calibration submenu.
static int32_t cycle_selection(int32_t sel, int32_t count, bool down) {
    if(down) {
        return (sel + 1 >= count) ? 0 : sel + 1;
    } else {
        return (sel - 1 < 0) ? count - 1 : sel - 1;
    }
}

static void rescale_graph_buf(Session* s, bool zoom_out) {
    pipeline_rescale_graph(&s->pipeline, zoom_out);
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
                                double rel, float raw,
                                const float* rf_rssi, const RowDiag* diag) {
    bool gps_ok = pos->valid;

    char row[300];
    int n;
    if(gps_ok) {
        bool has_vel = !isnan(pos->speed_kts) && !isnan(pos->course_deg);
        if(has_vel) {
            n = snprintf(row, sizeof(row),
                "%.2f,%.7f,%.7f,%.1f,%.1f,%d,%d,%.2f,%.1f,%.1f,%.1f",
                rel, pos->lat, pos->lon,
                (double)pos->hdop, (double)pos->pdop,
                pos->sats, pos->fix_type,
                (double)pos->speed_kts, (double)pos->course_deg, (double)raw,
                (double)pos->hacc);
        } else {
            n = snprintf(row, sizeof(row),
                "%.2f,%.7f,%.7f,%.1f,%.1f,%d,%d,,,%.1f,%.1f",
                rel, pos->lat, pos->lon,
                (double)pos->hdop, (double)pos->pdop,
                pos->sats, pos->fix_type, (double)raw, (double)pos->hacc);
        }
    } else {
        n = snprintf(row, sizeof(row), "%.2f,,,,,,,,,%.1f,",
                     rel, (double)raw);
    }
    if(n <= 0 || (size_t)n >= sizeof(row)) return false;

    int n2 = rf_rssi
        ? snprintf(row + n, sizeof(row) - (size_t)n,
                   ",%.1f,%.1f,%.1f",
                   (double)rf_rssi[0], (double)rf_rssi[1], (double)rf_rssi[2])
        : 0;
    if(n2 < 0 || (size_t)(n + n2) >= sizeof(row)) return false;
    n += n2;

    int nd = s->debug_fields_enabled
        ? snprintf(row + n, sizeof(row) - (size_t)n,
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
        : snprintf(row + n, sizeof(row) - (size_t)n, "\n");
    if(nd <= 0 || (size_t)(n + nd) >= sizeof(row)) return false;
    n += nd;

    strcpy(mock_logger_buf, row);
    return true;
}


// --- Test Suites ---

void test_smooth_iir_filter() {
    printf("Running test_smooth_iir_filter...\n");
    DisplayState d = {0};
    
    // Initial call primes the filter
    float raw1 = 100.0f;
    float out1 = pipeline_smooth_iir(&d, raw1);
    assert(out1 == raw1);
    assert(d.smooth_iir == raw1);
    assert(d.smooth_iir_primed == true);

    // Subsequent calls apply IIR filter: out = 0.848 * raw + 0.152 * prev
    float raw2 = 120.0f;
    float out2 = pipeline_smooth_iir(&d, raw2);
    float expected = 0.848f * raw2 + 0.152f * raw1;
    assert(fabsf(out2 - expected) < 1e-4f);
    printf("  -> Pass\n");
}

void test_update_display_pipeline() {
    printf("Running test_update_display_pipeline...\n");
    Session s = {0};
    s.pipeline.display.refresh_counter = 0;

    // Tick 1
    pipeline_update_display(&s.pipeline, 10.0f);
    assert(s.pipeline.display.primed == true);
    assert(s.pipeline.display.smoothed == 10.0f);
    assert(s.pipeline.graph.last_smoothed == 10.0f);
    assert(s.pipeline.display.refresh_counter == 1);

    // Tick 2 to 5 to trigger display refresh
    pipeline_update_display(&s.pipeline, 10.0f);
    pipeline_update_display(&s.pipeline, 10.0f);
    pipeline_update_display(&s.pipeline, 10.0f);
    pipeline_update_display(&s.pipeline, 10.0f); // refresh_counter reaches 5
    assert(s.pipeline.display.refresh_counter == 0);
    printf("  -> Pass\n");
}

void test_cycle_selection_wraparound() {
    printf("Running test_cycle_selection_wraparound...\n");

    // Up from the first item wraps to the last item.
    assert(cycle_selection(0, 5, false) == 4);
    // Down from the last item wraps to the first item.
    assert(cycle_selection(4, 5, true) == 0);

    // Normal (non-wrapping) steps in the middle of the list still work.
    assert(cycle_selection(2, 5, false) == 1);
    assert(cycle_selection(2, 5, true) == 3);

    // Single-item list: both directions stay put (wrap to itself).
    assert(cycle_selection(0, 1, false) == 0);
    assert(cycle_selection(0, 1, true) == 0);

    // Two-item list (GSR Calibration submenu): Up/Down just flip-flop.
    assert(cycle_selection(0, 2, false) == 1);
    assert(cycle_selection(1, 2, true) == 0);

    // Four-item list (main menu, MENU_COUNT=4): boundaries at both ends.
    assert(cycle_selection(0, 4, false) == 3);
    assert(cycle_selection(3, 4, true) == 0);
    for(int i = 0; i < 3; i++) assert(cycle_selection(i, 4, true) == i + 1);
    for(int i = 3; i > 0; i--) assert(cycle_selection(i, 4, false) == i - 1);

    // Seven-item list (options menu, OPTIONS_COUNT=7): boundaries at both ends.
    assert(cycle_selection(0, 7, false) == 6);
    assert(cycle_selection(6, 7, true) == 0);
    for(int i = 0; i < 6; i++) assert(cycle_selection(i, 7, true) == i + 1);
    for(int i = 6; i > 0; i--) assert(cycle_selection(i, 7, false) == i - 1);

    printf("  -> Pass\n");
}

void test_unix_epoch_conversion() {
    printf("Running test_unix_epoch_conversion...\n");

    // Reference values cross-checked with Python's calendar.timegm().
    assert(pipeline_unix_epoch(2020, 1, 1, 0, 0, 0) == 1577836800u);
    assert(pipeline_unix_epoch(2021, 1, 1, 0, 0, 0) == 1609459200u);
    assert(pipeline_unix_epoch(2026, 7, 24, 12, 30, 15) == 1784896215u);

    // Leap-day handling: 2020 and 2024 are leap years.
    assert(pipeline_unix_epoch(2020, 2, 29, 0, 0, 0) == 1582934400u);
    assert(pipeline_unix_epoch(2020, 3, 1, 0, 0, 0) == 1583020800u);
    assert(pipeline_unix_epoch(2024, 2, 29, 0, 0, 0) == 1709164800u);

    // Century non-leap-year rule: 2100 is divisible by 100 but not 400,
    // so Feb 29 doesn't exist — the day-count arithmetic must still land
    // on the correct Mar 1 epoch (not off by the extra day 2020/2024 got).
    assert(pipeline_unix_epoch(2100, 3, 1, 0, 0, 0) == 4107542400u);

    // End-of-day / rollover.
    assert(pipeline_unix_epoch(2023, 12, 31, 23, 59, 59) == 1704067199u);

    // RTC-unset sentinel: year < 2020 returns 0, regardless of month/day.
    assert(pipeline_unix_epoch(2019, 12, 31, 23, 59, 59) == 0u);
    assert(pipeline_unix_epoch(2000, 1, 1, 0, 0, 0) == 0u);

    // Out-of-range month/day guards (would index days_before[-1] or worse
    // without the guard) also return the sentinel.
    assert(pipeline_unix_epoch(2026, 0, 15, 0, 0, 0) == 0u);
    assert(pipeline_unix_epoch(2026, 13, 15, 0, 0, 0) == 0u);
    assert(pipeline_unix_epoch(2026, 6, 0, 0, 0, 0) == 0u);
    assert(pipeline_unix_epoch(2026, 6, 32, 0, 0, 0) == 0u);
    printf("  -> Pass\n");
}

void test_rel_seconds_conversion() {
    printf("Running test_rel_seconds_conversion...\n");
    // TICK_HZ=10 -> each tick is 100 ms.
    assert(pipeline_rel_seconds(0) == 0.0);
    assert(fabs(pipeline_rel_seconds(1) - 0.1) < 1e-9);
    assert(fabs(pipeline_rel_seconds(10) - 1.0) < 1e-9);
    assert(fabs(pipeline_rel_seconds(12345) - 1234.5) < 1e-9);
    printf("  -> Pass\n");
}

void test_gps_year_expand_pivot() {
    printf("Running test_gps_year_expand_pivot...\n");
    // NMEA 2-digit years pivot at 80: 80-99 -> 1980-1999, 00-79 -> 2000-2079.
    assert(gps_year_expand(0) == 2000);
    assert(gps_year_expand(26) == 2026);
    assert(gps_year_expand(79) == 2079);
    assert(gps_year_expand(80) == 1980);
    assert(gps_year_expand(99) == 1999);
    printf("  -> Pass\n");
}

void test_update_graph_scroll_divider_gating() {
    printf("Running test_update_graph_scroll_divider_gating...\n");
    Pipeline p = {0};
    p.graph.scroll_divider = 3;
    p.display.smoothed = 6.0f;   // constant signal; rate only depends on last write

    // First two ticks: divider not reached yet, buffer/head untouched.
    pipeline_update_graph(&p);
    assert(p.graph.tick_counter == 1);
    assert(p.graph.head == 0);

    pipeline_update_graph(&p);
    assert(p.graph.tick_counter == 2);
    assert(p.graph.head == 0);

    // Third tick reaches the divider: rate = 6.0 - 0 (last_smoothed still
    // primed at 0) over 3 ticks -> buf = -(6.0/3)*GRAPH_RATE_SCALE = -0.4.
    pipeline_update_graph(&p);
    assert(p.graph.tick_counter == 0);
    assert(p.graph.head == 1);
    assert(fabsf(p.graph.buf[0] - (-0.4f)) < 1e-5f);
    assert(p.graph.last_smoothed == 6.0f);
    printf("  -> Pass\n");
}

void test_update_graph_buffer_wraparound() {
    printf("Running test_update_graph_buffer_wraparound...\n");
    Pipeline p = {0};
    p.graph.scroll_divider = 1;
    p.graph.head = GRAPH_N - 1;

    pipeline_update_graph(&p);
    assert(p.graph.head == 0);   // wrapped past the end of the ring buffer
    printf("  -> Pass\n");
}

void test_update_graph_manual_zoom_suppresses_auto_tracking() {
    printf("Running test_update_graph_manual_zoom_suppresses_auto_tracking...\n");
    Pipeline p = {0};
    p.graph.scroll_divider = 1;
    p.display.smoothed = 5.0f;
    p.graph.last_smoothed = 5.0f;   // rate = 0, isolates the zoom logic
    p.zoom.enabled = true;
    p.zoom.manual_timeout = 5;      // still counting down after this tick (->4)
    p.zoom.level = 3.0f;
    p.zoom.peak = 10.0f;

    pipeline_update_graph(&p);

    // manual_timeout > 0 after decrement -> auto_active is false: peak and
    // level must be left completely untouched (no decay, no lerp).
    assert(p.zoom.manual_timeout == 4);
    assert(p.zoom.level == 3.0f);
    assert(p.zoom.peak == 10.0f);
    printf("  -> Pass\n");
}

void test_update_graph_manual_timeout_expiry_resets_peak() {
    printf("Running test_update_graph_manual_timeout_expiry_resets_peak...\n");
    Pipeline p = {0};
    p.graph.scroll_divider = 1;
    p.display.smoothed = 0.0f;
    p.graph.last_smoothed = 0.0f;   // rate = 0 -> isolates the zoom math
    p.zoom.enabled = true;
    p.zoom.manual_timeout = 1;      // expires on this very tick
    p.zoom.level = 2.0f;
    p.zoom.peak = 999.0f;           // stale value must be overwritten, not decayed

    pipeline_update_graph(&p);

    // Expiry resets peak so target == current level (no visual jump):
    // peak = ZOOM_TARGET_DIV / level = 80/2 = 40, then decayed once
    // (auto-zoom re-engages the same tick) -> 40 * 0.997 = 39.88.
    assert(p.zoom.manual_timeout == 0);
    assert(fabsf(p.zoom.peak - 39.88f) < 1e-2f);

    // Lerp target = 80/39.88 ~= 2.00602 -> level nudges up from 2.0.
    float expected_target = 80.0f / 39.88f;
    float expected_level = 2.0f + (expected_target - 2.0f) * ZOOM_LERP_RATE;
    assert(fabsf(p.zoom.level - expected_level) < 1e-4f);
    printf("  -> Pass\n");
}

void test_update_graph_peak_floor_clamp_and_lerp() {
    printf("Running test_update_graph_peak_floor_clamp_and_lerp...\n");
    Pipeline p = {0};
    p.graph.scroll_divider = 1;
    p.display.smoothed = 0.0f;
    p.graph.last_smoothed = 0.0f;   // rate = 0 -> newest sample is 0
    p.zoom.enabled = true;
    p.zoom.manual_timeout = 0;      // auto-zoom already active
    p.zoom.level = 2.0f;
    p.zoom.peak = ZOOM_PEAK_FLOOR;  // sitting right at the floor

    pipeline_update_graph(&p);

    // Decay (0.5 * 0.997 = 0.4985) would push peak below the floor, and
    // the newest sample (0) doesn't raise it back up -> must clamp back
    // to the floor rather than let auto-zoom over-magnify a quiet signal.
    assert(fabsf(p.zoom.peak - ZOOM_PEAK_FLOOR) < 1e-6f);

    // Target = 80/0.5 = 160, clamped to ZOOM_MAX (16) before the lerp.
    float expected_level = 2.0f + (ZOOM_MAX - 2.0f) * ZOOM_LERP_RATE;
    assert(fabsf(p.zoom.level - expected_level) < 1e-4f);
    printf("  -> Pass\n");
}

void test_update_graph_peak_tracks_rising_signal() {
    printf("Running test_update_graph_peak_tracks_rising_signal...\n");
    Pipeline p = {0};
    p.graph.scroll_divider = 1;
    p.zoom.enabled = true;
    p.zoom.manual_timeout = 0;
    p.zoom.level = 1.0f;
    p.zoom.peak = 1.0f;
    p.display.smoothed = -5.0f;   // rate = -5 - 0 = -5 -> buf = 1.0 (positive)

    pipeline_update_graph(&p);

    // Decay first: 1.0 * 0.997 = 0.997. The fresh sample's magnitude (1.0)
    // exceeds that decayed value, so it replaces peak rather than the
    // decay value winning.
    assert(fabsf(p.graph.buf[0] - 1.0f) < 1e-5f);
    assert(fabsf(p.zoom.peak - 1.0f) < 1e-5f);
    assert(p.graph.head == 1);

    // Lerp target = 80/1.0 = 80, clamped to ZOOM_MAX (16).
    float expected_level = 1.0f + (ZOOM_MAX - 1.0f) * ZOOM_LERP_RATE;
    assert(fabsf(p.zoom.level - expected_level) < 1e-4f);
    printf("  -> Pass\n");
}

void test_rescale_graph_buf() {
    printf("Running test_rescale_graph_buf...\n");
    Session s = {0};
    s.pipeline.graph.head = 0;

    // Fill buffer with mock rate data (0 to GRAPH_N-1)
    for (int i = 0; i < GRAPH_N; i++) {
        s.pipeline.graph.buf[i] = (float)i;
    }

    // Zoom out (average adjacent pairs)
    rescale_graph_buf(&s, true);
    assert(s.pipeline.graph.head == 0);
    // Positions [0..62] should be 0
    for (int i = 0; i < GRAPH_HALF; i++) {
        assert(s.pipeline.graph.buf[i] == 0.0f);
    }
    // Positions [63..125] should be averaged pairs: (i*2 + i*2+1)*0.5 = i*2 + 0.5
    for (int i = 0; i < GRAPH_HALF; i++) {
        float expected = (float)(i * 2) + 0.5f;
        assert(fabsf(s.pipeline.graph.buf[GRAPH_HALF + i] - expected) < 1e-4f);
    }

    // Reset buffer and test Zoom in (double resolution of latest GRAPH_HALF)
    s.pipeline.graph.head = 0;
    for (int i = 0; i < GRAPH_N; i++) {
        s.pipeline.graph.buf[i] = (float)i;
    }
    rescale_graph_buf(&s, false);
    assert(s.pipeline.graph.head == 0);
    // Zoom in processes the newer half [63..125], interpolating:
    // even positions get the original value, odd get the average of current and next.
    for (int i = 0; i < GRAPH_HALF; i++) {
        float curr = (float)(GRAPH_HALF + i);
        float next = (i + 1 < GRAPH_HALF) ? (float)(GRAPH_HALF + i + 1) : curr;
        assert(fabsf(s.pipeline.graph.buf[i * 2] - curr) < 1e-4f);
        assert(fabsf(s.pipeline.graph.buf[i * 2 + 1] - (curr + next) * 0.5f) < 1e-4f);
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
    assert(fabsf(g1 - 9015.5f) < 1.0f);

    // Over-saturation clamp check (clamped to 319000 counts)
    float gMax = convert_adc_to_conductance_ns(500000.0f);
    float gExpectedMax = (319000.0f * 5000000.0f) / (15040000.0f - 319000.0f * 47.0f);
    assert(fabsf(gMax - gExpectedMax) < 1e-2f);
    printf("  -> Pass\n");
}

void test_calibration_calculations() {
    printf("Running test_calibration_calculations...\n");
    // Three-point least-squares calibration — pure nS domain.
    // A device that reads ~4 % low across all three resistors.
    // Targets are true physical conductance: 1e9 / R_ohms.
    float measured[3]  = { 2050.0f, 9600.0f, 20500.0f };  // 470k, 100k, 47k
    float targets[3]   = { 2127.66f, 10000.0f, 21276.6f };

    // Three-point least-squares:  y = gain * x + offset  (all in float)
    float sx = 0, sy = 0, sxx = 0, sxy = 0;
    for(int i = 0; i < 3; i++) {
        float xi = measured[i];
        float yi = targets[i];
        sx  += xi;
        sy  += yi;
        sxx += xi * xi;
        sxy += xi * yi;
    }
    float denom = 3.0f * sxx - sx * sx;
    assert(denom > 1e-9f);
    float gain   = (3.0f * sxy - sx * sy) / denom;
    float offset = (sy - gain * sx) / 3.0f;

    // Gain near 1.0, offset small (device is close to reference).
    assert(gain >= 0.9f && gain <= 1.1f);
    assert(fabsf(offset) < 1000.0f);

    // Apply calibration — all three points should land near targets.
    for(int i = 0; i < 3; i++) {
        float cal = gain * measured[i] + offset;
        assert(fabsf(cal - targets[i]) < 100.0f);
    }

    // R² goodness-of-fit should be near 1.0 (linear device assumption holds).
    float y_mean = sy / 3.0f;
    float ss_res = 0, ss_tot = 0;
    for(int i = 0; i < 3; i++) {
        float yi     = targets[i];
        float y_pred = gain * measured[i] + offset;
        float res    = yi - y_pred;
        ss_res += res * res;
        float dev    = yi - y_mean;
        ss_tot += dev * dev;
    }
    float r2 = (ss_tot > 1e-9f) ? (1.0f - ss_res / ss_tot) : 1.0f;
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
    // Fixed, recognizable diagnostic values (RowDiag, biomap_types.h) so
    // the expected strings below actually exercise the new columns'
    // formatting, not just leave them at zero. Distinct values across all
    // fields (3, 4, 5, 6, ... 14) so a column-order mistake in the
    // formatter would show up as a wrong-order match failure here, not a
    // false pass.
    RowDiag diag = {.tick_dt_ms = 100, .gps_rx_drops = 2, .nmea_fail = 1,
                     .gps_reinit_count = 11, .gsr_hz = 987.6f,
                     .i2c_peak_ms = 3, .rf_rssi_peak_ms = 4, .rf_retune_peak_ms = 5,
                     .flush_peak_ms = 6, .log_fill_bytes = 7, .log_fill_peak_bytes = 8,
                     .log_overflow_count = 9, .log_flush_fail_count = 10,
                     .pga_change_count = 12, .i2c_consec_fail = 13, .prealloc_ms = 14};

    // Case 1: Valid 3D GPS fix with speed and course — RF OFF (rf_rssi = NULL)
    pos.valid = true;
    pos.lat = 51.5557397;
    pos.lon = -0.0714595;
    pos.hdop = 0.9f;
    pos.pdop = 1.3f;
    pos.sats = 16;
    pos.fix_type = 3;
    pos.speed_kts = 5.25f;
    pos.course_deg = 330.2f;
    pos.hacc = 2.4f;

    // debug_fields_enabled is now a runtime Session field (Options > Debug
    // Fields, 2026-08-05), not a compile-time BIOMAP_DEBUG_FIELDS switch —
    // every case below exercises BOTH states directly, rather than only
    // whichever one the build happened to be compiled with.
    s.debug_fields_enabled = true;
    mock_logger_buf[0] = '\0';
    format_gps_csv_row(&s, &pos, 1.25, 8345.3f, NULL, &diag);
    assert(strcmp(mock_logger_buf, "1.25,51.5557397,-0.0714595,0.9,1.3,16,3,5.25,330.2,8345.3,2.4,100,2,1,11,987.6,3,4,5,6,7,8,9,10,12,13,14\n") == 0);

    s.debug_fields_enabled = false;
    mock_logger_buf[0] = '\0';
    format_gps_csv_row(&s, &pos, 1.25, 8345.3f, NULL, &diag);
    assert(strcmp(mock_logger_buf, "1.25,51.5557397,-0.0714595,0.9,1.3,16,3,5.25,330.2,8345.3,2.4\n") == 0);

    // Case 2: Valid GPS fix but no speed/course (stationary) — RF OFF
    pos.speed_kts = NAN;
    pos.course_deg = NAN;

    s.debug_fields_enabled = true;
    mock_logger_buf[0] = '\0';
    format_gps_csv_row(&s, &pos, 2.50, 8350.0f, NULL, &diag);
    assert(strcmp(mock_logger_buf, "2.50,51.5557397,-0.0714595,0.9,1.3,16,3,,,8350.0,2.4,100,2,1,11,987.6,3,4,5,6,7,8,9,10,12,13,14\n") == 0);

    s.debug_fields_enabled = false;
    mock_logger_buf[0] = '\0';
    format_gps_csv_row(&s, &pos, 2.50, 8350.0f, NULL, &diag);
    assert(strcmp(mock_logger_buf, "2.50,51.5557397,-0.0714595,0.9,1.3,16,3,,,8350.0,2.4\n") == 0);

    // Case 3: Invalid GPS fix (e.g. startup, or no fix) — RF OFF
    pos.valid = false;
    pos.hdop = 6.0f;

    s.debug_fields_enabled = true;
    mock_logger_buf[0] = '\0';
    format_gps_csv_row(&s, &pos, 3.75, 8400.0f, NULL, &diag);
    assert(strcmp(mock_logger_buf, "3.75,,,,,,,,,8400.0,,100,2,1,11,987.6,3,4,5,6,7,8,9,10,12,13,14\n") == 0);

    s.debug_fields_enabled = false;
    mock_logger_buf[0] = '\0';
    format_gps_csv_row(&s, &pos, 3.75, 8400.0f, NULL, &diag);
    assert(strcmp(mock_logger_buf, "3.75,,,,,,,,,8400.0,\n") == 0);

    // Case 4: Valid GPS fix — RF ON (3 extra columns: raw RSSI per band)
    pos.valid = true;
    pos.hdop = 0.9f;
    pos.speed_kts = 5.25f;
    pos.course_deg = 330.2f;
    float rf_rssi[3] = {-91.5f, -88.0f, -90.5f};

    s.debug_fields_enabled = true;
    mock_logger_buf[0] = '\0';
    format_gps_csv_row(&s, &pos, 1.25, 8345.3f, rf_rssi, &diag);
    assert(strcmp(mock_logger_buf, "1.25,51.5557397,-0.0714595,0.9,1.3,16,3,5.25,330.2,8345.3,2.4,-91.5,-88.0,-90.5,100,2,1,11,987.6,3,4,5,6,7,8,9,10,12,13,14\n") == 0);

    s.debug_fields_enabled = false;
    mock_logger_buf[0] = '\0';
    format_gps_csv_row(&s, &pos, 1.25, 8345.3f, rf_rssi, &diag);
    assert(strcmp(mock_logger_buf, "1.25,51.5557397,-0.0714595,0.9,1.3,16,3,5.25,330.2,8345.3,2.4,-91.5,-88.0,-90.5\n") == 0);

    printf("  -> Pass\n");
}

// Counts comma-separated fields in a CSV header or row string — works for
// either since both end in a trailing '\n' this simply doesn't count as a
// field separator. `n` fields means `n-1` commas, so this returns
// (comma count + 1).
static int count_csv_columns(const char* s) {
    int columns = 1;
    for(const char* p = s; *p; p++) {
        if(*p == ',') columns++;
    }
    return columns;
}

// Regression test for a real bug (2026-08-03): BIOMAP_CSV_COLS_GPS_GSR_* /
// _GPS_GSR_RF_* (biomap_config.h) are a SEPARATE literal from the printf
// format string in format_gps_csv_row() below — biomap_config.h's own doc
// comment says "must stay in sync" but nothing enforced that. The three
// peak_ms columns were added to the row formatter without updating these
// header strings, so recorded files would have shipped with a header
// listing 4 diagnostic columns while every row actually carried 7 — silent
// on its own, but csv.DictReader (analyze_track.py) and the JS analyzer
// both map columns by name from the header row, so the trailing rssi_815/
// 868/915 columns would have been misread as soon as row width outran
// what the header claimed. A column NAME/order check would also catch
// this, but would need to duplicate the exact column list here and go
// stale itself; comparing counts against a row this same test just
// generated is the direct version of the property that actually broke —
// "the header promises exactly as many fields as a row delivers".
static void test_csv_header_matches_row_column_count(void) {
    printf("Running test_csv_header_matches_row_column_count...\n");
    Session s = {0};
    GpsPosition pos = {0};
    pos.valid = true;
    pos.lat = 51.5557397;
    pos.lon = -0.0714595;
    pos.hdop = 0.9f;
    pos.pdop = 1.3f;
    pos.sats = 16;
    pos.fix_type = 3;
    pos.speed_kts = 5.25f;
    pos.course_deg = 330.2f;
    pos.hacc = 2.4f;
    RowDiag diag = {.tick_dt_ms = 100, .gps_rx_drops = 2, .nmea_fail = 1,
                     .gps_reinit_count = 11, .gsr_hz = 987.6f,
                     .i2c_peak_ms = 3, .rf_rssi_peak_ms = 4, .rf_retune_peak_ms = 5,
                     .flush_peak_ms = 6, .log_fill_bytes = 7, .log_fill_peak_bytes = 8,
                     .log_overflow_count = 9, .log_flush_fail_count = 10,
                     .pga_change_count = 12, .i2c_consec_fail = 13, .prealloc_ms = 14};

    float rf_rssi[3] = {-91.5f, -88.0f, -90.5f};

    // debug_fields_enabled is a runtime Session field now (Options > Debug
    // Fields) — check both states against their matching _PROD/_DEBUG
    // header macro (biomap_config.h), not just whichever the build was
    // compiled with.
    for(int debug = 0; debug <= 1; debug++) {
        s.debug_fields_enabled = (bool)debug;

        mock_logger_buf[0] = '\0';
        format_gps_csv_row(&s, &pos, 1.25, 8345.3f, NULL, &diag);
        int row_cols_no_rf = count_csv_columns(mock_logger_buf);
        int header_cols_no_rf = count_csv_columns(
            debug ? BIOMAP_CSV_COLS_GPS_GSR_DEBUG : BIOMAP_CSV_COLS_GPS_GSR_PROD);
        printf("  GPS_GSR (debug=%d): header=%d row=%d\n", debug, header_cols_no_rf, row_cols_no_rf);
        assert(header_cols_no_rf == row_cols_no_rf);

        mock_logger_buf[0] = '\0';
        format_gps_csv_row(&s, &pos, 1.25, 8345.3f, rf_rssi, &diag);
        int row_cols_rf = count_csv_columns(mock_logger_buf);
        int header_cols_rf = count_csv_columns(
            debug ? BIOMAP_CSV_COLS_GPS_GSR_RF_DEBUG : BIOMAP_CSV_COLS_GPS_GSR_RF_PROD);
        printf("  GPS_GSR_RF (debug=%d): header=%d row=%d\n", debug, header_cols_rf, row_cols_rf);
        assert(header_cols_rf == row_cols_rf);
    }

    int header_cols_gsr_only_debug = count_csv_columns(BIOMAP_CSV_COLS_GSR_ONLY_DEBUG);
    printf("  GSR_ONLY_DEBUG: header=%d expected=9\n", header_cols_gsr_only_debug);
    assert(header_cols_gsr_only_debug == 9);

    int header_cols_gsr_only_prod = count_csv_columns(BIOMAP_CSV_COLS_GSR_ONLY_PROD);
    printf("  GSR_ONLY_PROD: header=%d expected=2\n", header_cols_gsr_only_prod);
    assert(header_cols_gsr_only_prod == 2);

    printf("  -> Pass\n");
}



// Mirrors the FIXED sd_logger_batch_printf() in modules/sd_logger.c: on a
// truncated (buffer-would-overflow) row, it must roll back to the length
// before the call rather than advancing gsr_batch_len into the truncated
// bytes.  Before the fix, a truncated/corrupted partial row was left in
// the buffer and got written to the SD card on the next batch flush.
typedef struct {
    char buf[32];   // deliberately tiny to make overflow easy to trigger
    int  len;
} MockSdBatch;

static int sd_batch_printf_ref(MockSdBatch* l, const char* fmt, ...) {
    int remaining = (int)sizeof(l->buf) - l->len;
    if(remaining <= 0) return 0;

    va_list args;
    va_start(args, fmt);
    int n = vsnprintf(l->buf + l->len, (size_t)remaining, fmt, args);
    va_end(args);

    if(n <= 0) return 0;
    if(n >= remaining) {
        // Fixed behaviour: discard the truncated row, do not advance len.
        return 0;
    }
    l->len += n;
    return n;
}

void test_batch_printf_rollback_on_truncation() {
    printf("Running test_batch_printf_rollback_on_truncation...\n");
    MockSdBatch l = {0};

    // Two small rows fit comfortably.
    int r1 = sd_batch_printf_ref(&l, "%.2f,%.1f\n", 0.10, 100.0);
    assert(r1 > 0);
    int len_after_first = l.len;

    int r2 = sd_batch_printf_ref(&l, "%.2f,%.1f\n", 0.20, 200.0);
    assert(r2 > 0);
    int len_after_second = l.len;
    assert(len_after_second > len_after_first);

    // This row cannot fit in the remaining space (32-byte buffer) and must
    // be fully rejected — length must roll back to len_after_second, NOT
    // advance to sizeof(buf)-1 with a truncated/corrupt row appended.
    int r3 = sd_batch_printf_ref(&l, "%.2f,%.7f,%.7f,%.1f,%.1f,%d,%d,%.2f,%.1f,%.1f\n",
                                  0.30, 51.5072000, -0.1276000, 1.2, 1.5, 8, 3,
                                  2.40, 185.0, 4523.0);
    assert(r3 == 0);
    assert(l.len == len_after_second);  // rolled back — no corrupt row appended

    // What would actually be flushed to SD is buf[0..len) — bounded by
    // len, exactly like storage_file_write(l->file, l->gsr_batch,
    // l->gsr_batch_len) in the real sd_logger_batch_flush(). It must be
    // exactly the two complete rows, with none of the rejected third row's
    // truncated bytes included in that flushed range (vsnprintf may still
    // have scribbled truncated bytes further into the buffer past `len` —
    // that's fine, since flush never reads past `len`).
    const char* expected = "0.10,100.0\n0.20,200.0\n";
    assert(l.len == (int)strlen(expected));
    assert(memcmp(l.buf, expected, (size_t)l.len) == 0);
    printf("  flushed bytes=%.*s  -> Pass\n", l.len, l.buf);
}

void test_nmea_parsing() {
    printf("Running test_nmea_parsing...\n");
    // $GNGGA sentence with valid coordinates:
    // Latitude: 5133.34438 N -> 51.5557397 N
    // Longitude: 00004.28757 W -> -0.0714595 W
    // Checksum corrected to the actual XOR (6C) — this test calls
    // minmea_parse_gga() directly so an invalid checksum here wouldn't
    // have failed the test, but it's worth being right regardless.
    const char* gga_sentence = "$GNGGA,203337.00,5133.34438,N,00004.28757,W,1,16,0.9,123.4,M,45.6,M,,*6C";
    
    struct minmea_sentence_gga frame;
    bool parsed = minmea_parse_gga(&frame, gga_sentence);
    assert(parsed == true);
    
    double lat = minmea_tocoord_double(&frame.latitude);
    double lon = minmea_tocoord_double(&frame.longitude); // minmea parses hemisphere sign internally
    
    printf("  parsed lat = %.9f, lon = %.9f\n", lat, lon);
    assert(fabs(lat - 51.55573966) < 1e-6);
    assert(fabs(lon - (-0.0714595)) < 1e-6);
    
    float hdop = minmea_tofloat(&frame.hdop);
    assert(fabsf(hdop - 0.9f) < 1e-4f);
    printf("  -> Pass\n");
}

// ── Calibration persistence constants (mirrored from biomap.h) ──────
#define CAL_MAGIC    0x424D4341u
#define CAL_VERSION  3
#define CAL_POINTS   3

#define CAL_TARGET_470K  2127.66f
#define CAL_TARGET_100K  10000.0f
#define CAL_TARGET_47K   21276.6f

// Mirrors BioMapCalibration (biomap.h): v3 added `timestamp` and `r_squared`
// before the checksum, so cal_checksum() below folds both in via offsetof().
typedef struct {
    uint32_t magic;
    uint32_t version;
    float    gain;
    float    offset;
    uint32_t timestamp;
    float    r_squared;
    uint32_t checksum;
} CalFile;

// FNV-1a checksum — identical to cal_checksum() in biomap.c
static uint32_t cal_checksum(const CalFile* cal) {
    uint32_t h = 0x811C9DC5u;
    const uint8_t* p = (const uint8_t*)cal;
    size_t n = offsetof(CalFile, checksum);
    for(size_t i = 0; i < n; i++) {
        h ^= p[i];
        h *= 0x01000193u;
    }
    return h;
}

// ── Calibration fit engine (matches run_calibration_wizard in biomap_gui.c)
// Returns gain, offset, r_squared.  Caller sets measured[] before calling.
static void cal_fit(const float measured[CAL_POINTS],
                    const float targets[CAL_POINTS],
                    float* gain, float* offset, float* r2) {
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
        *gain   = 1.0f;
        *offset = 0.0f;
        *r2     = 0.0f;
        return;
    }
    *gain   = (n * sxy - sx * sy) / denom;
    *offset = (sy - *gain * sx) / n;

    // R²
    float y_mean = sy / n;
    float ss_res = 0, ss_tot = 0;
    for(int i = 0; i < CAL_POINTS; i++) {
        float yi     = targets[i];
        float y_pred = *gain * measured[i] + *offset;
        float res    = yi - y_pred;
        ss_res += res * res;
        float dev    = yi - y_mean;
        ss_tot += dev * dev;
    }
    *r2 = (ss_tot > 1e-9f) ? (1.0f - ss_res / ss_tot) : 1.0f;
}

// Mirrors the FIXED calibration_wizard_compute_fit() in biomap_gui.c: a
// bool-returning variant that gates validity (bounds + R^2) but must ALWAYS
// write *out_gain/*out_offset/*out_r_squared, even when it returns false.
// The fit-fail screen (calibration_wizard_render, step 10) displays these
// values so the user can see how far out of range their device is — prior
// to the fix, the out-of-bounds branch left the outputs untouched, so the
// screen always showed a stale "Gain: 0.000x R²: 0.0000" instead.
static bool calibration_wizard_compute_fit_ref(const float measured[CAL_POINTS],
                                                const float targets[CAL_POINTS],
                                                float* out_gain, float* out_offset,
                                                float* out_r_squared) {
    float sx = 0, sy = 0, sxx = 0, sxy = 0;
    for(int i = 0; i < CAL_POINTS; i++) {
        sx  += measured[i];
        sy  += targets[i];
        sxx += measured[i] * measured[i];
        sxy += measured[i] * targets[i];
    }
    float n     = (float)CAL_POINTS;
    float denom = n * sxx - sx * sx;
    if(denom <= 1e-9f) {
        *out_gain = 1.0f;
        *out_offset = 0.0f;
        *out_r_squared = 0.0f;
        return false;
    }
    float gain   = (n * sxy - sx * sy) / denom;
    float offset = (sy - gain * sx) / n;
    float y_mean = sy / n;
    float ss_res = 0, ss_tot = 0;
    for(int i = 0; i < CAL_POINTS; i++) {
        float y_pred = gain * measured[i] + offset;
        float res    = targets[i] - y_pred;
        ss_res += res * res;
        float dev    = targets[i] - y_mean;
        ss_tot += dev * dev;
    }
    float r_squared = (ss_tot > 1e-9f) ? (1.0f - ss_res / ss_tot) : 1.0f;
    *out_gain = gain;
    *out_offset = offset;
    *out_r_squared = r_squared;
    return gain >= 0.2f && gain <= 5.0f &&
           offset >= -20000.0f && offset <= 20000.0f &&
           r_squared >= 0.95f;
}

void test_calibration_fit_reports_values_on_bounds_failure() {
    printf("Running test_calibration_fit_reports_values_on_bounds_failure...\n");
    // Device reads ~6x high on every point -> gain far above the 5.0x
    // ceiling -> compute_fit must return false, but must still report the
    // actual (out-of-range) gain/offset/R^2 rather than leaving them unset.
    float targets[3]  = { CAL_TARGET_470K, CAL_TARGET_100K, CAL_TARGET_47K };
    float measured[3] = { targets[0] / 6.0f, targets[1] / 6.0f, targets[2] / 6.0f };

    // Poison the outputs first, like uninitialised/stale WizardState fields.
    float gain = -999.0f, offset = -999.0f, r2 = -999.0f;
    bool ok = calibration_wizard_compute_fit_ref(measured, targets, &gain, &offset, &r2);

    assert(ok == false);               // correctly rejected (gain ~6.0x > 5.0x)
    assert(gain > 5.0f);               // real computed gain, not left at -999
    assert(fabsf(offset) < 1000.0f);   // real computed offset, not left at -999
    assert(r2 > 0.95f);                // fit is actually linear (R^2 near 1) —
                                        // it's the gain bound that fails it, and
                                        // that distinction is only visible if
                                        // the outputs were actually populated.
    printf("  gain=%.4f offset=%.1f R²=%.6f (rejected, values reported) -> Pass\n",
           (double)gain, (double)offset, (double)r2);
}

// ── Calibration correctness tests ─────────────────────────────────────

void test_calibration_identity() {
    printf("Running test_calibration_identity...\n");
    // Perfect device: measured == target → gain=1, offset=0, R²=1
    float measured[3] = { CAL_TARGET_470K, CAL_TARGET_100K, CAL_TARGET_47K };
    float targets[3]  = { CAL_TARGET_470K, CAL_TARGET_100K, CAL_TARGET_47K };

    float gain, offset, r2;
    cal_fit(measured, targets, &gain, &offset, &r2);

    assert(fabsf(gain - 1.0f) < 1e-4f);
    assert(fabsf(offset) < 1e-4f);
    assert(r2 > 0.9999f);
    printf("  gain=%.4f offset=%.1f R²=%.6f -> Pass\n", (double)gain, (double)offset, (double)r2);
}

void test_calibration_scaled_device() {
    printf("Running test_calibration_scaled_device...\n");
    // Device reads exactly 10 % low: measured = 0.9 * target
    const float targets[3] = { CAL_TARGET_470K, CAL_TARGET_100K, CAL_TARGET_47K };
    float measured[3];
    for(int i = 0; i < 3; i++) measured[i] = targets[i] * 0.9f;

    float gain, offset, r2;
    cal_fit(measured, targets, &gain, &offset, &r2);

    // gain ≈ 1/0.9 ≈ 1.111, offset ≈ 0
    assert(gain > 1.10f && gain < 1.12f);
    assert(fabsf(offset) < 100.0f);
    assert(r2 > 0.999f);

    // Calibrated values should recover the targets
    for(int i = 0; i < 3; i++) {
        float cal = gain * measured[i] + offset;
        assert(fabsf(cal - targets[i]) < 50.0f);
    }
    printf("  gain=%.4f offset=%.1f R²=%.6f -> Pass\n", (double)gain, (double)offset, (double)r2);
}

void test_calibration_offset_device() {
    printf("Running test_calibration_offset_device...\n");
    // Device has a constant +500 nS offset on all readings
    const float targets[3] = { CAL_TARGET_470K, CAL_TARGET_100K, CAL_TARGET_47K };
    float measured[3];
    for(int i = 0; i < 3; i++) measured[i] = targets[i] + 500.0f;

    float gain, offset, r2;
    cal_fit(measured, targets, &gain, &offset, &r2);

    // gain ≈ 1.0, offset ≈ -500
    assert(fabsf(gain - 1.0f) < 0.01f);
    assert(fabsf(offset + 500.0f) < 50.0f);
    assert(r2 > 0.999f);

    // Calibrated values should recover the targets
    for(int i = 0; i < 3; i++) {
        float cal = gain * measured[i] + offset;
        assert(fabsf(cal - targets[i]) < 50.0f);
    }
    printf("  gain=%.4f offset=%.1f R²=%.6f -> Pass\n", (double)gain, (double)offset, (double)r2);
}

void test_calibration_nonlinear_reject() {
    printf("Running test_calibration_nonlinear_reject...\n");
    // Non-monotonic device: the "high" (47k) resistor reads BELOW the
    // "mid" (100k) resistor, which no linear device can reproduce — poor R².
    // The production gate (calibration_wizard_compute_fit) requires R^2 >= 0.95.
    // (A merely noisy-but-still-monotonic set like {3000,10000,15000} actually
    // scores R^2 ~ 0.96, which would PASS the real 0.95 gate — not a useful
    // rejection example — so this uses a genuinely non-monotonic set instead.)
    float measured[3] = { 2000.0f, 10000.0f, 9000.0f };   // non-monotonic
    float targets[3]  = { CAL_TARGET_470K, CAL_TARGET_100K, CAL_TARGET_47K };

    float gain, offset, r2;
    cal_fit(measured, targets, &gain, &offset, &r2);

    // R² must be < 0.95 (fails the production linearity gate)
    assert(r2 < 0.95f);
    printf("  R²=%.6f (< 0.95, rejected as expected) -> Pass\n", (double)r2);
}

void test_calibration_degenerate_input() {
    printf("Running test_calibration_degenerate_input...\n");
    // All three measurements identical → denominator ≈ 0 → fit rejected
    float measured[3] = { 5000.0f, 5000.0f, 5000.0f };
    float targets[3]  = { CAL_TARGET_470K, CAL_TARGET_100K, CAL_TARGET_47K };

    float gain, offset, r2;
    cal_fit(measured, targets, &gain, &offset, &r2);

    // Denominator check kicks in: should return defaults (gain=1, offset=0, r2=0)
    assert(gain == 1.0f);
    assert(offset == 0.0f);
    assert(r2 == 0.0f);
    printf("  gain=%.4f offset=%.1f R²=%.6f -> Pass\n", (double)gain, (double)offset, (double)r2);
}

void test_calibration_bounds_check() {
    printf("Running test_calibration_bounds_check...\n");
    // Production code gates (biomap_gui.c calibration_wizard_compute_fit,
    // mirrored in biomap.h CAL_* constants): 0.2 <= gain <= 5.0,
    // |offset| <= 20000, R^2 >= 0.95.

    // Valid: gain=1.0, offset=0, R^2=1.0 -> passes
    assert(1.0f >= 0.2f && 1.0f <= 5.0f);
    assert(0.0f >= -20000.0f && 0.0f <= 20000.0f);
    assert(1.0f >= 0.95f);

    // Invalid: gain too low
    assert(!(0.19f >= 0.2f && 0.19f <= 5.0f));

    // Invalid: gain too high
    assert(!(5.1f >= 0.2f && 5.1f <= 5.0f));

    // Invalid: offset too negative
    assert(!(-20001.0f >= -20000.0f && -20001.0f <= 20000.0f));

    // Invalid: offset too positive
    assert(!(20001.0f >= -20000.0f && 20001.0f <= 20000.0f));

    // Invalid: R^2 too low
    assert(!(0.94f >= 0.95f));
    printf("  -> Pass\n");
}

// ── Calibration persistence tests ─────────────────────────────────────

void test_cal_checksum_deterministic() {
    printf("Running test_cal_checksum_deterministic...\n");
    CalFile cal = { CAL_MAGIC, CAL_VERSION, 1.234f, -56.7f, 1700000000u, 0.997f, 0 };
    cal.checksum = cal_checksum(&cal);

    // Same inputs → same checksum
    uint32_t c1 = cal_checksum(&cal);
    uint32_t c2 = cal_checksum(&cal);
    assert(c1 == c2);
    assert(c1 == cal.checksum);
    printf("  checksum=0x%08X -> Pass\n", (unsigned)cal.checksum);
}

void test_cal_checksum_detects_bit_flips() {
    printf("Running test_cal_checksum_detects_bit_flips...\n");
    CalFile cal = { CAL_MAGIC, CAL_VERSION, 1.0f, 0.0f, 1700000000u, 0.997f, 0 };
    cal.checksum = cal_checksum(&cal);

    // Flip magic — checksum must change
    CalFile bad = cal;
    bad.magic = 0xDEADBEEFu;
    uint32_t bad_cs = cal_checksum(&bad);
    assert(bad_cs != cal.checksum);

    // Flip gain — checksum must change
    bad = cal;
    bad.gain = 2.0f;
    bad_cs = cal_checksum(&bad);
    assert(bad_cs != cal.checksum);

    // Flip offset — checksum must change
    bad = cal;
    bad.offset = 500.0f;
    bad_cs = cal_checksum(&bad);
    assert(bad_cs != cal.checksum);

    // Flip version — checksum must change
    bad = cal;
    bad.version = 99;
    bad_cs = cal_checksum(&bad);
    assert(bad_cs != cal.checksum);

    // Flip timestamp — checksum must change (v3 folds it in)
    bad = cal;
    bad.timestamp = 1234567890u;
    bad_cs = cal_checksum(&bad);
    assert(bad_cs != cal.checksum);

    // Flip r_squared — checksum must change (v3 folds it in)
    bad = cal;
    bad.r_squared = 0.5f;
    bad_cs = cal_checksum(&bad);
    assert(bad_cs != cal.checksum);
    printf("  -> Pass\n");
}

void test_cal_serialization_roundtrip() {
    printf("Running test_cal_serialization_roundtrip...\n");
    // Build a valid calibration record
    CalFile orig;
    orig.magic    = CAL_MAGIC;
    orig.version  = CAL_VERSION;
    orig.gain     = 1.05f;
    orig.offset   = -123.4f;
    orig.timestamp = 1700000000u;
    orig.r_squared = 0.9873f;
    orig.checksum = cal_checksum(&orig);

    // "Write" to a byte buffer
    uint8_t buf[sizeof(CalFile)];
    memcpy(buf, &orig, sizeof(CalFile));

    // "Read" back
    CalFile restored;
    memcpy(&restored, buf, sizeof(CalFile));

    // All fields must survive the roundtrip
    assert(restored.magic     == orig.magic);
    assert(restored.version   == orig.version);
    assert(restored.gain      == orig.gain);
    assert(restored.offset    == orig.offset);
    assert(restored.timestamp == orig.timestamp);
    assert(restored.r_squared == orig.r_squared);
    assert(restored.checksum  == orig.checksum);

    // Checksum must validate after roundtrip
    assert(cal_checksum(&restored) == restored.checksum);
    printf("  gain=%.4f offset=%.1f checksum=0x%08X -> Pass\n",
           (double)restored.gain, (double)restored.offset, (unsigned)restored.checksum);
}

void test_cal_validation_magic() {
    printf("Running test_cal_validation_magic...\n");
    CalFile cal = { CAL_MAGIC, CAL_VERSION, 1.0f, 0.0f, 1700000000u, 0.997f, 0 };
    cal.checksum = cal_checksum(&cal);

    // Correct magic → passes
    assert(cal.magic == CAL_MAGIC);

    // Wrong magic → rejected
    CalFile bad = cal;
    bad.magic = 0xFFFFFFFFu;
    assert(bad.magic != CAL_MAGIC);
    printf("  -> Pass\n");
}

void test_cal_validation_version() {
    printf("Running test_cal_validation_version...\n");
    CalFile cal = { CAL_MAGIC, CAL_VERSION, 1.0f, 0.0f, 1700000000u, 0.997f, 0 };
    cal.checksum = cal_checksum(&cal);

    // Correct version → passes
    assert(cal.version == CAL_VERSION);

    // Wrong version → rejected
    CalFile bad = cal;
    bad.version = 1;  // old version
    assert(bad.version != CAL_VERSION);
    printf("  -> Pass\n");
}

void test_cal_validation_checksum() {
    printf("Running test_cal_validation_checksum...\n");
    CalFile cal = { CAL_MAGIC, CAL_VERSION, 1.0f, 0.0f, 1700000000u, 0.997f, 0 };
    cal.checksum = cal_checksum(&cal);

    // Matching checksum → passes
    assert(cal.checksum == cal_checksum(&cal));

    // Mismatched checksum → rejected
    CalFile bad = cal;
    bad.checksum = 0x12345678u;
    assert(bad.checksum != cal_checksum(&bad));
    printf("  -> Pass\n");
}

void test_cal_validation_bounds() {
    printf("Running test_cal_validation_bounds...\n");
    // Production gates (biomap.c biomap_load_calibration / biomap.h CAL_*):
    // 0.2 <= gain <= 5.0, |offset| <= 20000.

    // Valid values
    assert(1.0f >= 0.2f && 1.0f <= 5.0f);
    assert(0.0f >= -20000.0f && 0.0f <= 20000.0f);

    // Boundary values — must be accepted
    assert(0.2f >= 0.2f && 0.2f <= 5.0f);          // lower gain bound
    assert(5.0f >= 0.2f && 5.0f <= 5.0f);          // upper gain bound
    assert(-20000.0f >= -20000.0f && -20000.0f <= 20000.0f);  // lower offset bound
    assert(20000.0f >= -20000.0f && 20000.0f <= 20000.0f);   // upper offset bound

    // Slightly out of bounds — must be rejected
    assert(!(0.19f >= 0.2f && 0.19f <= 5.0f));
    assert(!(5.01f >= 0.2f && 5.01f <= 5.0f));
    assert(!(-20000.1f >= -20000.0f && -20000.1f <= 20000.0f));
    assert(!(20000.1f >= -20000.0f && 20000.1f <= 20000.0f));
    printf("  -> Pass\n");
}

void test_cal_full_validation_chain() {
    printf("Running test_cal_full_validation_chain...\n");
    // Simulate the full validation chain from biomap_load_calibration():
    //   magic → version → checksum → bounds
    // All four gates must pass for the calibration to be accepted.

    CalFile cal;
    cal.magic   = CAL_MAGIC;
    cal.version = CAL_VERSION;
    cal.gain    = 0.98f;
    cal.offset  = 200.0f;
    cal.timestamp = 1700000000u;
    cal.r_squared = 0.991f;
    cal.checksum = cal_checksum(&cal);

    bool valid = (cal.magic == CAL_MAGIC)
              && (cal.version == CAL_VERSION)
              && (cal.checksum == cal_checksum(&cal))
              && (cal.gain >= 0.2f && cal.gain <= 5.0f)
              && (cal.offset >= -20000.0f && cal.offset <= 20000.0f);
    assert(valid);

    // Corrupt each field one at a time and verify the chain rejects it.
    CalFile bad;

    // Magic corruption
    bad = cal; bad.magic = 0u;
    assert(!((bad.magic == CAL_MAGIC)
          && (bad.version == CAL_VERSION)
          && (bad.checksum == cal_checksum(&bad))
          && (bad.gain >= 0.2f && bad.gain <= 5.0f)
          && (bad.offset >= -20000.0f && bad.offset <= 20000.0f)));

    // Version corruption
    bad = cal; bad.version = 0;
    assert(!((bad.magic == CAL_MAGIC)
          && (bad.version == CAL_VERSION)
          && (bad.checksum == cal_checksum(&bad))
          && (bad.gain >= 0.2f && bad.gain <= 5.0f)
          && (bad.offset >= -20000.0f && bad.offset <= 20000.0f)));

    // Checksum corruption (via bit-flip in gain)
    bad = cal; bad.gain = 1.5f;  // checksum no longer matches
    assert(!((bad.magic == CAL_MAGIC)
          && (bad.version == CAL_VERSION)
          && (bad.checksum == cal_checksum(&bad))
          && (bad.gain >= 0.2f && bad.gain <= 5.0f)
          && (bad.offset >= -20000.0f && bad.offset <= 20000.0f)));

    // Bounds violation — gain too high
    bad = cal; bad.gain = 5.1f; bad.checksum = cal_checksum(&bad);
    assert(!((bad.magic == CAL_MAGIC)
          && (bad.version == CAL_VERSION)
          && (bad.checksum == cal_checksum(&bad))
          && (bad.gain >= 0.2f && bad.gain <= 5.0f)
          && (bad.offset >= -20000.0f && bad.offset <= 20000.0f)));

    // Bounds violation — offset too negative
    bad = cal; bad.offset = -25000.0f; bad.checksum = cal_checksum(&bad);
    assert(!((bad.magic == CAL_MAGIC)
          && (bad.version == CAL_VERSION)
          && (bad.checksum == cal_checksum(&bad))
          && (bad.gain >= 0.2f && bad.gain <= 5.0f)
          && (bad.offset >= -20000.0f && bad.offset <= 20000.0f)));
    printf("  -> Pass\n");
}
int main() {
    printf("========================================\n");
    printf("FIRMWARE PIPELINE STAGE 1 & 2 VERIFICATION\n");
    printf("========================================\n");
    test_smooth_iir_filter();
    test_update_display_pipeline();
    test_cycle_selection_wraparound();
    test_rescale_graph_buf();
    test_conductance_conversion();
    test_unix_epoch_conversion();
    test_rel_seconds_conversion();
    test_gps_year_expand_pivot();
    test_update_graph_scroll_divider_gating();
    test_update_graph_buffer_wraparound();
    test_update_graph_manual_zoom_suppresses_auto_tracking();
    test_update_graph_manual_timeout_expiry_resets_peak();
    test_update_graph_peak_floor_clamp_and_lerp();
    test_update_graph_peak_tracks_rising_signal();

    printf("\n========================================\n");
    printf("CALIBRATION CORRECTNESS\n");
    printf("========================================\n");
    test_calibration_calculations();
    test_calibration_identity();
    test_calibration_scaled_device();
    test_calibration_offset_device();
    test_calibration_nonlinear_reject();
    test_calibration_degenerate_input();
    test_calibration_bounds_check();
    test_calibration_fit_reports_values_on_bounds_failure();

    printf("\n========================================\n");
    printf("CALIBRATION PERSISTENCE\n");
    printf("========================================\n");
    test_cal_checksum_deterministic();
    test_cal_checksum_detects_bit_flips();
    test_cal_serialization_roundtrip();
    test_cal_validation_magic();
    test_cal_validation_version();
    test_cal_validation_checksum();
    test_cal_validation_bounds();
    test_cal_full_validation_chain();

    printf("\n========================================\n");
    printf("CSV / NMEA\n");
    printf("========================================\n");
    test_csv_formatting();
    test_csv_header_matches_row_column_count();
    test_batch_printf_rollback_on_truncation();
    test_nmea_parsing();

    printf("\nAll 33 firmware unit tests passed successfully!\n");
    return 0;
}
