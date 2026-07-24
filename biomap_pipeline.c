// biomap_pipeline.c — Pure math pipeline for GSR signal processing.
//
// Platform-independent: includes only biomap_pipeline.h (which pulls in
// biomap_types.h).  No Flipper SDK, no module headers, no I/O.
// All functions operate on Pipeline* or individual sub-struct pointers.

#include "biomap_pipeline.h"
#include <math.h>
#include <string.h>

// ==========================================================================
// Time helpers
// ==========================================================================

uint32_t pipeline_unix_epoch(uint16_t year, uint8_t month, uint8_t day,
                             uint8_t hour, uint8_t minute, uint8_t second) {
    // Days before each month in a non-leap year
    static const uint16_t days_before[12] = {
        0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334
    };
    // Guard against uninitialised RTC: month=0 would cause days_before[-1].
    // Year < 2020 catches a completely unset RTC (typically 2000-01-01).
    // Returns 0 as sentinel — cannot collide with a valid 1970 epoch
    // because year < 2020 is rejected above.
    if(year < 2020 || month < 1 || month > 12 ||
       day   < 1   || day   > 31) {
        return 0;  // sentinel: RTC not set
    }
    // Whole days from 1970 to start of year
    uint32_t days = (year - 1970) * 365U
                  + (year - 1969) / 4U
                  - (year - 1901) / 100U
                  + (year - 1601) / 400U;
    days += days_before[month - 1];
    if(month > 2 &&
       (year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)))
        days++;  // leap day
    days += day - 1;
    return (uint32_t)(days * 86400UL + hour * 3600U +
                      minute * 60U + second);
}

double pipeline_rel_seconds(uint32_t total_ticks) {
    return (double)total_ticks / 10;
}

// ==========================================================================
// GSR signal processing
// ==========================================================================

// ── Post-decimation smoothing IIR ──────────────────────────────────────
// First-order IIR, nominal fc ≈ 3 Hz via α = 1 - e^{-2π·3/10} ≈ 0.848 —
// that continuous-RC approximation assumes fc << Fs, which is optimistic
// at Fs=10 Hz: measured attenuation at 3 Hz is only ~-1.9 dB, not -3 dB
// (see docs/gsr_filtering_analysis.md, Finding 3).
//
// IMPORTANT: called from biomap_session.c with the RAW SINGLE-SAMPLE
// value (gsr_sensor_get_raw_sample_ns()), NOT the boxcar-decimated one
// (gsr_sensor_get_raw()) — this is the display/graph path only; the
// boxcar-filtered value goes straight to CSV without ever passing
// through this filter (see handle_recording_tick() in biomap_session.c).
// That means there is NO anti-aliasing before this filter on the display
// path: it subsamples an ~860 Hz-bandwidth source at 10 Hz with no
// pre-filter, so aliasing (including 50/60 Hz mains hum) folds into the
// 0-5 Hz band before this filter ever sees it, and — aliasing being a
// one-way door — cannot be removed afterward. Intentional trade-off (the
// display shows the true instantaneous hardware reading), but it means
// the on-screen graph is meaningfully noisier than the logged CSV data,
// which uses the actually-decimated, mains-nulling boxcar path instead.
float pipeline_smooth_iir(DisplayState* d, float raw) {
    if(!d->smooth_iir_primed) {
        d->smooth_iir = raw;
        d->smooth_iir_primed = true;
        return raw;
    }
    d->smooth_iir = SMOOTH_IIR_A * raw + SMOOTH_IIR_B * d->smooth_iir;
    return d->smooth_iir;
}

// ── Display pipeline ───────────────────────────────────────────────────
// Post-decimation smoothing IIR → EMA smoothing of GSR readings.
// Measured combined cascade (sine-sweep, not the idealized per-stage
// formulas above): -3 dB at ~0.35 Hz, not the ~3 Hz the IIR-alone
// comment might suggest — the EMA stage (α=0.2) has a lower corner than
// the IIR and dominates the cascade almost entirely. Net ~0.45 s
// effective time constant. Still comfortably fast against 1-3 s phasic
// GSR rise times — see docs/gsr_filtering_analysis.md, Finding 3.
void pipeline_update_display(Pipeline* p, float raw) {
    float filtered = pipeline_smooth_iir(&p->display, raw);

    if(!p->display.primed) {
        p->display.smoothed = filtered;
        p->graph.last_smoothed = filtered;
        p->display.last_displayed = filtered;
        p->display.primed = true;
    }
    float ns = DISPLAY_EMA_A * filtered + DISPLAY_EMA_B * p->display.smoothed;
    p->display.smoothed = ns;

    p->display.refresh_counter++;
    if(p->display.refresh_counter >= REFRESH_EVERY) {
        p->display.last_displayed = filtered;
        p->display.refresh_counter = 0;
    }
}

// ── Graph pipeline ─────────────────────────────────────────────────────
// Build the graph ring buffer from smoothed GSR derivative rate.
// Handles auto-zoom peak tracking and zoom-level lerp.
// Manual zoom (Up/Down) sets a timeout; auto-zoom re-engages when it
// expires, with a seamless transition (peak set so target = current level).
void pipeline_update_graph(Pipeline* p) {
    // Decrement manual zoom timeout; on expiry set peak so the lerp
    // target matches the current manual level — no visual jump.
    if(p->zoom.manual_timeout > 0) {
        p->zoom.manual_timeout--;
        if(p->zoom.manual_timeout == 0) {
            p->zoom.peak = ZOOM_TARGET_DIV / p->zoom.level;
            if(p->zoom.peak < ZOOM_PEAK_FLOOR) p->zoom.peak = ZOOM_PEAK_FLOOR;
        }
    }

    bool auto_active = p->zoom.enabled && p->zoom.manual_timeout == 0;

    if(auto_active) {
        p->zoom.peak *= ZOOM_PEAK_DECAY;
    }

    p->graph.tick_counter++;
    if(p->graph.tick_counter >= p->graph.scroll_divider) {
        float rate = p->display.smoothed - p->graph.last_smoothed;
        p->graph.buf[p->graph.head] = -(rate / (float)p->graph.scroll_divider) * GRAPH_RATE_SCALE;
        if(++p->graph.head >= GRAPH_N) p->graph.head = 0;
        p->graph.last_smoothed = p->display.smoothed;
        p->graph.tick_counter = 0;

        if(auto_active) {
            int just_written = p->graph.head - 1;
            if(just_written < 0) just_written = GRAPH_N - 1;
            float newest = fabsf(p->graph.buf[just_written]);
            if(newest > p->zoom.peak) p->zoom.peak = newest;
            if(p->zoom.peak < ZOOM_PEAK_FLOOR) p->zoom.peak = ZOOM_PEAK_FLOOR;
        }
    }

    if(auto_active && p->zoom.peak >= ZOOM_PEAK_FLOOR) {
        float target = ZOOM_TARGET_DIV / p->zoom.peak;
        target = fmaxf(ZOOM_MIN, fminf(ZOOM_MAX, target));
        p->zoom.level += (target - p->zoom.level) * ZOOM_LERP_RATE;
    }
}

// ==========================================================================
// Graph rescaling (time-axis zoom)
// ==========================================================================

void pipeline_rescale_graph(Pipeline* p, bool zoom_out) {
    float temp[GRAPH_N];

    // Linearise ring buffer: temp[0] = oldest sample, temp[N-1] = newest.
    for(int i = 0; i < GRAPH_N; i++) {
        temp[i] = p->graph.buf[(p->graph.head + i) % GRAPH_N];
    }
    memset(p->graph.buf, 0, sizeof(p->graph.buf));
    p->graph.head = 0;

    if(zoom_out) {
        // Average adjacent pairs (both are rate-per-tick; average preserves that).
        // 126 old samples → 63 averaged samples at positions [63..125].
        // Positions [0..62] remain zero (no data at this resolution yet).
        for(int i = 0; i < GRAPH_HALF; i++) {
            p->graph.buf[GRAPH_HALF + i] = (temp[i * 2] + temp[i * 2 + 1]) * 0.5f;
        }
    } else {
        // Zoom in (÷2): split newest 63 old samples using linear interpolation.
        // Samples are already rate-per-tick — no amplitude scaling needed.
        // Even positions: keep the original rate value.
        // Odd positions: interpolate midpoint toward the next sample, avoiding
        // the staircase a simple duplicate would produce.
        for(int i = 0; i < GRAPH_HALF; i++) {
            float curr = temp[GRAPH_HALF + i];
            // For the last sample there is no following neighbour — hold value.
            float next = (i + 1 < GRAPH_HALF) ? temp[GRAPH_HALF + i + 1] : curr;
            p->graph.buf[i * 2]     = curr;
            p->graph.buf[i * 2 + 1] = (curr + next) * 0.5f;
        }
    }
}
