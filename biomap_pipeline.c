// Bio Mapping — data-processing pipeline: display, graph, batch CSV, rescaling.
#include "biomap.h"

// Rescale graph_buf when scroll_divider changes by a factor of 2.
//
// Each graph_buf sample = normalised EMA-derivative: total change over the
// window divided by scroll_divider, i.e. rate-per-tick.  This keeps
// amplitude consistent across all time scales.
//
// zoom_out=true  (Left key, divider ×2):
//   Average adjacent pairs — both samples represent rate-per-tick, so the
//   average is the best estimate of the rate over the merged window.
//   63 averaged samples land at the newest (right) end; the older half
//   stays zero (no data collected at this resolution yet).
//
// zoom_out=false (Right key, divider ÷2):
//   Interpolate — each old sample is already rate-per-tick and does NOT
//   need halving.  The even position keeps the original value; the odd
//   position interpolates toward the next sample for a smooth curve.
//
// This is a one-time O(N) pass on keypress; performance is not a concern.
void rescale_graph_buf(BioMapApp* app, bool zoom_out) {
    float temp[GRAPH_N];

    // Linearise ring buffer: temp[0] = oldest sample, temp[N-1] = newest.
    for(int i = 0; i < GRAPH_N; i++) {
        temp[i] = app->graph.buf[(app->graph.head + i) % GRAPH_N];
    }
    memset(app->graph.buf, 0, sizeof(app->graph.buf));
    app->graph.head = 0;

    if(zoom_out) {
        // Average adjacent pairs (both are rate-per-tick; average preserves that).
        // 126 old samples → 63 averaged samples at positions [63..125].
        // Positions [0..62] remain zero (no data at this resolution yet).
        int half = GRAPH_N / 2; // 63
        for(int i = 0; i < half; i++) {
            app->graph.buf[half + i] = (temp[i * 2] + temp[i * 2 + 1]) * 0.5f;
        }
    } else {
        // Zoom in (÷2): split newest 63 old samples using linear interpolation.
        // Samples are already rate-per-tick — no amplitude scaling needed.
        // Even positions: keep the original rate value.
        // Odd positions: interpolate midpoint toward the next sample, avoiding
        // the staircase a simple duplicate would produce.
        int half = GRAPH_N / 2; // 63
        for(int i = 0; i < half; i++) {
            float curr = temp[half + i];
            // For the last sample there is no following neighbour — hold value.
            float next = (i + 1 < half) ? temp[half + i + 1] : curr;
            app->graph.buf[i * 2]     = curr;
            app->graph.buf[i * 2 + 1] = (curr + next) * 0.5f;
        }
    }
}

void update_display_pipeline(BioMapApp* app, int32_t raw) {
    float rf = (float)raw;
    if(!app->display.primed) {
        app->display.smoothed = rf;
        app->graph.last_smoothed = rf;
        app->display.last_displayed = raw;
        app->display.primed = true;
    }
    float ns = DISPLAY_EMA_A * rf + DISPLAY_EMA_B * app->display.smoothed;
    app->display.smoothed = ns;

    app->display.refresh_counter++;
    if(app->display.refresh_counter >= 5) {
        app->display.last_displayed = raw;
        app->display.refresh_counter = 0;
    }
}

void update_graph_pipeline(BioMapApp* app) {
    if(app->zoom.enabled) {
        app->zoom.peak *= 0.997f;
    }

    app->graph.tick_counter++;
    if(app->graph.tick_counter >= app->graph.scroll_divider) {
        float rate = app->display.smoothed - app->graph.last_smoothed;
        app->graph.buf[app->graph.head] = -(rate / (float)app->graph.scroll_divider) * 0.2f;
        if(++app->graph.head >= GRAPH_N) app->graph.head = 0;
        app->graph.last_smoothed = app->display.smoothed;
        app->graph.tick_counter = 0;

        if(app->zoom.enabled) {
            int just_written = app->graph.head - 1;
            if(just_written < 0) just_written = GRAPH_N - 1;
            float newest = fabsf(app->graph.buf[just_written]);
            if(newest > app->zoom.peak) app->zoom.peak = newest;
            if(app->zoom.peak < 0.5f) app->zoom.peak = 0.5f;
        }
    }

    if(app->zoom.enabled && app->zoom.peak >= 0.5f) {
        float target = 80.0f / app->zoom.peak;
        target = fmaxf(ZOOM_MIN, fminf(ZOOM_MAX, target));
        app->zoom.level += (target - app->zoom.level) * 0.02f;
    }
}

void batch_csv_row(BioMapApp* app, BioMapMode mode, int32_t raw) {
    if(app->recording.active) {
        if(has_gsr(mode)) {
            char ts[32];
            format_timestamp(app, ts, sizeof(ts));
            char row[128];
            int n = 0;

            if(mode == BioMapModeGsrOnly) {
                n = snprintf(row, sizeof(row), "%s,%d,%ld\n",
                             ts, app->recording.tick_counter, (long)raw);
            } else {
                if(app->recording.tick_counter == 0) {
                    float lat = 0, lon = 0, alt = 0;
                    int   sats = 0, fix = 0;
                    get_gps_position(app, &lat, &lon, &alt, &sats, &fix);
                    n = snprintf(row, sizeof(row),
                                 "%s,%.6f,%.6f,%.1f,%d,%d,%ld\n",
                                 ts, (double)lat, (double)lon, (double)alt,
                                 sats, fix, (long)raw);
                } else {
                    n = snprintf(row, sizeof(row), "%s,,,,,,%ld\n",
                                 ts, (long)raw);
                }
            }

            if(n > 0 && n < (int)sizeof(row)) {
                sd_logger_batch_append(app->logger, row, (size_t)n);
            }
        }
    }
}

void handle_write_failure(BioMapApp* app) {
    if(app->logger) sd_logger_stop(app->logger);
    app->recording.active = false;
    app->recording.filename[0] = '\0';
    notification_message(app->notifications, &sequence_set_only_red_255);
}

void handle_second_boundary(BioMapApp* app, BioMapMode mode) {
    if(has_gsr(mode)) {
        if(app->recording.active) {
            int flushed = sd_logger_batch_flush(app->logger);
            if(flushed > 0) {
                notification_message(app->notifications, &sequence_blink_green_100);
            } else if(flushed < 0) {
                FURI_LOG_E("BioMap", "Batch flush failed");
                handle_write_failure(app);
            }
        }
    } else {
        float lat = 0, lon = 0, alt = 0;
        int   sats = 0, fix = 0;
        get_gps_position(app, &lat, &lon, &alt, &sats, &fix);

        char ts[32];
        format_timestamp(app, ts, sizeof(ts));

        if(app->recording.active) {
            if(sd_logger_write_row(app->logger, ts, lat, lon, alt, sats, fix, 0)) {
                notification_message(app->notifications, &sequence_blink_green_100);
            } else {
                handle_write_failure(app);
            }
        }
    }

    app->recording.tick_counter = 0;
}

void get_gps_position(BioMapApp* app, float* lat, float* lon,
                      float* alt, int* sats, int* fix) {
    if(!app->gps) return;
    GpsStatus gs = gps_uart_get_status(app->gps);
    if((gs.fix_valid || gs.fix_quality > 0)
        && !isnan(gs.latitude) && !isnan(gs.longitude)) {
        *lat = gs.latitude; *lon = gs.longitude; *alt = gs.altitude;
    }
    *sats = gs.satellites_tracked;
    *fix  = gs.fix_quality;
}
