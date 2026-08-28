// analyze_gsr_filtering.c — investigative tool, not a pass/fail regression
// test. Characterizes the real frequency response of the GSR signal chain:
//
//  1. The display-path IIR+EMA cascade, by running the actual production
//     function (pipeline_update_display() from biomap_pipeline.c) through
//     a sine sweep and measuring steady-state gain at each frequency.
//  2. The CSV-path 100-sample boxcar's sensitivity to the worker thread's
//     true polling rate, analytically (Dirichlet kernel) — this can't be
//     measured through the host test harness because tests/shims/furi.h's
//     furi_delay_ms() is a no-op, so the simulated worker never reproduces
//     real hardware timing. Measuring the actual on-device rate needs a
//     debug build (see docs/gsr_filtering_analysis.md, Recommendation 1).
//
// Findings and recommendations are written up in
// docs/gsr_filtering_analysis.md. Rerun this after any change to
// gsr_sensor.c's averaging or biomap_pipeline.c's smoothing to see the
// effect on the numbers there.
//
// Build: gcc -Wall -Wextra -I . -o /tmp/analyze_gsr_filtering \
//            biomap_pipeline.c tests/benchmarks/analyze_gsr_filtering.c -lm

#include <stdio.h>
#include <math.h>
#include "biomap_pipeline.h"

#define PI 3.14159265358979323846

// ---- Part 1: IIR+EMA cascade frequency response (display path only) ----
static double measure_gain(double freq_hz, double fs_hz) {
    Pipeline p = {0};
    int settle = (int)(fs_hz * 30);   // 30s settle time
    int measure = (int)(fs_hz * 10);  // 10s measurement window
    double max_out = -1e9, min_out = 1e9;
    double max_in = -1e9, min_in = 1e9;
    for(int i = 0; i < settle + measure; i++) {
        double t = i / fs_hz;
        float x = (float)(1000.0 + 100.0 * sin(2.0 * PI * freq_hz * t));
        pipeline_update_display(&p, x);
        if(i >= settle) {
            if(x > max_in) max_in = x;
            if(x < min_in) min_in = x;
            if(p.display.smoothed > max_out) max_out = p.display.smoothed;
            if(p.display.smoothed < min_out) min_out = p.display.smoothed;
        }
    }
    return (max_out - min_out) / (max_in - min_in);
}

static void find_3db(const char* label, double fs_hz) {
    double lo = 0.001, hi = fs_hz / 2.0;
    for(int i = 0; i < 40; i++) {
        double mid = (lo + hi) / 2.0;
        double g = measure_gain(mid, fs_hz);
        if(g > 0.7071) lo = mid; else hi = mid;
    }
    printf("%s: -3dB point ~= %.4f Hz\n", label, (lo + hi) / 2.0);
}

int main(void) {
    printf("=== Display-path IIR+EMA cascade (pipeline_update_display, Fs=10Hz) ===\n");
    double fs = 10.0;
    double freqs[] = {0.1, 0.2, 0.35, 0.5, 1.0, 2.0, 3.0, 4.0, 4.9};
    for(size_t i = 0; i < sizeof(freqs) / sizeof(freqs[0]); i++) {
        double g = measure_gain(freqs[i], fs);
        printf("  f=%5.2f Hz  gain=%.4f  (%.2f dB)\n", freqs[i], g, 20 * log10(g));
    }
    find_3db("  Combined cascade", fs);

    // IIR alone, for comparison against the "fc ~ 3Hz" doc comment.
    printf("\n=== IIR alone (pipeline_smooth_iir, no EMA stage) ===\n");
    printf("  (analytical: A=0.848 B=0.152 at Fs=10Hz)\n");
    {
        // z-domain: y = A*x + B*y_prev, A+B=1 -> pole at z=B
        // |H(f)| = A / sqrt(1 - 2B cos(w) + B^2), w = 2 pi f / Fs
        double A = 0.848, B = 0.152;
        for(double f = 0.5; f <= 5.0; f += 0.5) {
            double w = 2 * PI * f / fs;
            double mag = A / sqrt(1 - 2 * B * cos(w) + B * B);
            printf("  f=%4.1f Hz  |H|=%.4f (%.2f dB)\n", f, mag, 20 * log10(mag));
        }
    }

    // ---- Part 2: boxcar mains-notch sensitivity to true worker rate ----
    printf("\n=== 100-sample boxcar: residual gain at 50/60 Hz vs assumed worker rate ===\n");
    double rates[] = {1000.0, 950.0, 900.0, 860.0, 800.0, 769.0};
    for(size_t r = 0; r < sizeof(rates) / sizeof(rates[0]); r++) {
        double Fs = rates[r];
        int N = 100;
        for(int hz = 50; hz <= 60; hz += 10) {
            // Dirichlet kernel: |sin(pi f N / Fs) / (N sin(pi f / Fs))|
            double x1 = PI * hz * N / Fs;
            double x2 = PI * hz / Fs;
            double gain = fabs(sin(x1) / (N * sin(x2)));
            printf("  worker_rate=%6.1fHz  notch_spacing=%.2fHz  gain@%dHz=%.4f (%.1fdB)%s\n",
                   Fs, Fs / N, hz, gain, 20 * log10(gain + 1e-12),
                   (fabs(Fs / N * round(hz / (Fs / N)) - hz) < 0.01) ? "  <-- exact null" : "");
        }
    }
    return 0;
}
