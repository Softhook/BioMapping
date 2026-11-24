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
    // Guard against uninitialised RTC, impossible calendar dates (e.g. Feb 29
    // on a non-leap year or Apr 31), and 32-bit uint32_t overflow (2106-02-07).
    // Year < 2020 catches a completely unset RTC (typically 2000-01-01).
    // Returns 0 as sentinel — cannot collide with a valid 1970 epoch
    // because year < 2020 is rejected below.
    if(year < 2020 || year > 2105 ||
       !utc_datetime_valid(year, month, day, hour, minute, second)) {
        return 0;  // sentinel: RTC not set or invalid date/time
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
    return (double)total_ticks / TICK_HZ;
}

// ==========================================================================
// GSR signal processing
// ==========================================================================

// ── Post-decimation smoothing IIR ──────────────────────────────────────
// First-order IIR, nominal fc ≈ 3 Hz via α = 1 - e^{-2π·3/10} ≈ 0.848 —
// that continuous-RC approximation assumes fc << Fs, which is optimistic
// at Fs=10 Hz: measured attenuation at 3 Hz is only ~-1.9 dB, not -3 dB
// (see research/gsr_filtering_analysis.md, Finding 3).
//
// Fed by core/biomap_session.c with the ~100 ms window mean
// (gsr_sensor_get_raw()), the same value the CSV rows carry, so mains hum
// is already nulled before it gets here. This is the display/graph path
// only: the CSV gets the mean itself, never this filter's output (see
// recording_tick_locked() in core/biomap_session.c).
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
// GSR rise times — see research/gsr_filtering_analysis.md, Finding 3.
void pipeline_update_display(Pipeline* p, float raw) {
    float filtered = pipeline_smooth_iir(&p->display, raw);

    if(!p->display.primed) {
        p->display.smoothed = filtered;
        pipeline_graph_restart_line(p);
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

    p->graph.ticks++;
    for(int k = 0; k < GRAPH_LEVELS; k++) {
        int div = 1 << k;
        if(p->graph.ticks % (uint32_t)div != 0) continue;
        GraphRing* r = &p->graph.ring[k];
        float rate = p->display.smoothed - r->last_smoothed;
        float sample = (rate / (float)div) * GRAPH_RATE_SCALE;
        r->buf[r->head] = sample;
        if(++r->head >= GRAPH_N) r->head = 0;
        r->last_smoothed = p->display.smoothed;

        // Auto-zoom follows the ring on screen.
        if(auto_active && k == p->graph.level) {
            float newest = fabsf(sample);
            if(newest > p->zoom.peak) p->zoom.peak = newest;
            if(p->zoom.peak < ZOOM_PEAK_FLOOR) p->zoom.peak = ZOOM_PEAK_FLOOR;
        }
    }

    if(auto_active && p->zoom.peak >= ZOOM_PEAK_FLOOR) {
        float target = ZOOM_TARGET_DIV / p->zoom.peak;
        target = clampf(target, ZOOM_MIN, ZOOM_MAX);
        p->zoom.level += (target - p->zoom.level) * ZOOM_LERP_RATE;
    }
}

// ==========================================================================
// Graph line restart
// ==========================================================================

void pipeline_graph_restart_line(Pipeline* p) {
    for(int k = 0; k < GRAPH_LEVELS; k++) {
        p->graph.ring[k].last_smoothed = p->display.smoothed;
    }
}
