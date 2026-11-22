// gsr_hum_sim.c — investigative tool, not a pass/fail test. Runs the REAL
// core/gsr_sensor.c (worker pass + 10 Hz tick) against a pretend ADS1115
// and a pretend clock, paced like each device, and measures how much mains
// hum and random noise get through the 100 ms average.
//
// How each device is paced (checked in Flipper firmware 1.4.3 and the
// Cardputer build):
//   Flipper:   I2C at 100 kHz (~0.52 ms a read); furi_delay_ms(1) adds one
//              and really waits 2 kernel ticks, so a read every 2 ms.
//   Cardputer: I2C at 400 kHz (~0.15 ms a read); vTaskDelay(1) waits 1 tick,
//              so a read every 1 ms. Its main loop wakes on the same tick
//              as the GSR task, just after it.
//
// The pretend ADC converts 860 times a second (times a speed factor: the
// datasheet allows the chip's clock ±10 %), each conversion being the
// average of the input over its own ~1.16 ms. Reading returns the last
// finished conversion, so reading faster than it converts gives repeats,
// as on the real chip. The input is the 600k test resistor's voltage plus
// mains hum and/or random noise.
//
// It prints four things:
//   1. Hum left in the 100 ms average, at mains 50.00 and 50.05 Hz, with the
//      tick landing at two different moments for each device.
//   2. The same against the ADC chip's own speed (774–946 conversions a
//      second).
//   3. Random noise left in the average, with the datasheet's ~1 count of
//      noise per conversion, and how many independent readings that is
//      worth ("independent N": repeats of one conversion don't count).
//   4. How much hum a single reading carries (what the on-screen graph
//      used before it was fed the average).
// With an output folder as its argument it also writes a 10 Hz trace
// (trace_cardputer_5005.csv: error of the average and of a single reading,
// in counts) for the Cardputer at 50.05 Hz mains.
//
// Build and run from firmware/:
//   gcc -O2 -Wall -Wextra -Werror -I core -o build/gsr_hum_sim \
//       tests/benchmarks/gsr_hum_sim.c core/gsr_sensor.c -lm
//   ./build/gsr_hum_sim [trace folder]
//
// To compare with an older version of the averaging, build against that
// version's file instead of core/gsr_sensor.c, e.g.
//   git show 28670a3:firmware/core/gsr_sensor.c > build/gsr_sensor_old.c
//   gcc -O2 -I core -o build/gsr_hum_sim_old tests/benchmarks/gsr_hum_sim.c \
//       build/gsr_sensor_old.c -lm
// (28670a3 is the last version that counted the window back from "now":
// 101/51 readings instead of 100/50, ~1–2 % of the hum left in.)
//
// Findings are written up in research/gsr_filtering_analysis.md
// (Recommendation 1b and Finding 2).

#include "gsr_sensor.h"
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define PI 3.14159265358979323846

void core_fatal(const char* m) {
    fprintf(stderr, "FATAL %s\n", m);
    exit(1);
}

// ── The pretend world ───────────────────────────────────────────────────
static double g_us;                  // time, µs
static double adc_period_us, adc_t0_us;
static uint8_t cfg_msb = 0x85;       // the ADS1115's power-up config
static double dc_v, hum_v, hum_hz, noise_v;
static double i2c_read_us, i2c_write_us;
static uint64_t seed;

// Gaussian noise, the same for the same conversion (so a repeat read of
// one conversion gives the same value, as on the chip).
static double gauss_for(int64_t k) {
    uint64_t z = (uint64_t)k * 0x9E3779B97F4A7C15ull + seed;
    z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ull;
    z = (z ^ (z >> 27)) * 0x94D049BB133111EBull;
    z ^= z >> 31;
    double u1 = ((z >> 11) + 0.5) / 9007199254740992.0;
    uint64_t y = z * 0x2545F4914F6CDD1Dull + 0x1234567ull;
    y ^= y >> 29;
    double u2 = ((y >> 11) + 0.5) / 9007199254740992.0;
    return sqrt(-2.0 * log(u1)) * cos(2.0 * PI * u2);
}

// Conversion k: the input averaged over its own conversion time.
static double conversion_volts(int64_t k) {
    int mux = (cfg_msb >> 4) & 7;
    if(mux == 5) return 0.5;  // bias check: AIN1 against ground
    double ta = (adc_t0_us + k * adc_period_us) * 1e-6;
    double tb = ta + adc_period_us * 1e-6;
    double w = 2.0 * PI * hum_hz;
    double hum_avg = hum_v * (cos(w * ta) - cos(w * tb)) / (w * (tb - ta));
    return dc_v + hum_avg + noise_v * gauss_for(k);
}

// Volts per count for each gain setting.
static const double LSB[6] = {187.5e-6, 125e-6, 62.5e-6, 31.25e-6, 15.625e-6, 7.8125e-6};

static void p_lock(void* c) { (void)c; }
static void p_unlock(void* c) { (void)c; }
static uint32_t p_now(void* c) { (void)c; return (uint32_t)(g_us / 1000.0); }
static void p_delay(void* c, uint32_t ms) { (void)c; g_us += ms * 1000.0; }

static bool p_read(void* c, uint8_t a, uint8_t r, uint8_t* d, size_t len, uint32_t t) {
    (void)c; (void)a; (void)r; (void)t;
    g_us += i2c_read_us;
    int64_t k = (int64_t)floor((g_us - adc_t0_us) / adc_period_us) - 1;  // last finished
    int pga = (cfg_msb >> 1) & 7;
    if(pga > 5) pga = 5;
    double code = round(conversion_volts(k) / LSB[pga]);
    if(code > 32767) code = 32767;
    if(code < -32768) code = -32768;
    int16_t v = (int16_t)code;
    d[0] = (uint8_t)((uint16_t)v >> 8);
    if(len > 1) d[1] = (uint8_t)(v & 0xFF);
    return true;
}

static bool p_write(void* c, uint8_t a, uint8_t r, const uint8_t* d, size_t len, uint32_t t) {
    (void)c; (void)a; (void)r; (void)len; (void)t;
    g_us += i2c_write_us;
    cfg_msb = d[0];
    return true;
}

// ── One run ──────────────────────────────────────────────────────────────
typedef struct {
    const char* name;
    double read_us;      // I2C read time
    int pause_ticks;     // kernel ticks the "1 ms" pause really waits
    double rtos_off_us;  // kernel tick phase against the ms clock (Cardputer)
    double tick_lat_us;  // the 10 Hz tick runs this long after its due ms
} Device;

typedef struct {
    double mean_rms_counts;    // RMS of (100 ms average - true value), counts
    double single_rms_counts;  // RMS of (single reading - true value), counts
    double avg_samples;        // readings in the window, on average
    int min_samples, max_samples;
    int pga;                   // gain the autoranger settled on
} Result;

static Result run(const Device* dev, double rate_factor, double hz, double hum_volts,
                  double noise_volts, double seconds, uint64_t s, FILE* trace) {
    g_us = 0;
    cfg_msb = 0x85;
    seed = s;
    adc_period_us = 1e6 / (860.0 * rate_factor);
    adc_t0_us = 137.0;
    dc_v = 0.5 * 47000.0 / (600000.0 + 9400.0);  // 600k test resistor
    hum_v = hum_volts;
    hum_hz = hz;
    noise_v = noise_volts;
    i2c_read_us = dev->read_us;
    i2c_write_us = dev->read_us;

    GsrPlatform p;
    memset(&p, 0, sizeof(p));
    p.lock = p_lock;
    p.unlock = p_unlock;
    p.now_ms = p_now;
    p.delay_ms = p_delay;
    p.i2c_read = p_read;
    p.i2c_write = p_write;
    GsrSensor* gsr = gsr_sensor_create(&p);

    double next_tick_us = ceil(g_us / 100000.0) * 100000.0 + 100000.0 + dev->tick_lat_us;
    double next_worker_us = g_us;
    double end_us = g_us + seconds * 1e6;
    double warm_us = g_us + 5e6;  // let the autoranger climb to ±0.256 V
    double true_counts = dc_v / LSB[5];

    double sum_m2 = 0, sum_s2 = 0, sum_n = 0;
    int count = 0, min_n = 1 << 30, max_n = 0;
    while(g_us < end_us) {
        if(next_worker_us <= next_tick_us) {
            if(g_us < next_worker_us) g_us = next_worker_us;
            gsr_sensor_worker_pass(gsr);
            // The pause: wake on the pause_ticks-th kernel tick from now.
            double t = g_us - dev->rtos_off_us;
            next_worker_us = (floor(t / 1000.0) + dev->pause_ticks) * 1000.0 + dev->rtos_off_us + 5.0;
        } else {
            if(g_us < next_tick_us) g_us = next_tick_us;
            gsr_sensor_tick(gsr);
            next_tick_us += 100000.0;
            if(g_us >= warm_us) {
                // The average, back from nS to counts without rounding (the
                // pretend bias reads exactly 0.5 V, so no bias correction).
                double ns = gsr_sensor_get_raw(gsr);
                double m = ns * 15040000.0 / (5000000.0 + 47.0 * ns) - true_counts;
                double sgl = gsr_sensor_get_raw_sample_count(gsr) - true_counts;
                int n = gsr_sensor_get_window_samples(gsr);
                sum_m2 += m * m;
                sum_s2 += sgl * sgl;
                sum_n += n;
                if(n < min_n) min_n = n;
                if(n > max_n) max_n = n;
                count++;
                if(trace) fprintf(trace, "%.1f,%.3f,%.3f\n", g_us / 1e6, m, sgl);
            }
        }
    }
    Result r;
    r.mean_rms_counts = sqrt(sum_m2 / count);
    r.single_rms_counts = sqrt(sum_s2 / count);
    r.avg_samples = sum_n / count;
    r.min_samples = min_n;
    r.max_samples = max_n;
    r.pga = gsr_sensor_get_pga_index(gsr);
    gsr_sensor_destroy(gsr);
    return r;
}

int main(int argc, char** argv) {
    const char* trace_dir = argc > 1 ? argv[1] : NULL;
    // Flipper: worker and 10 Hz tick on the same kernel tick. The tick lands
    // either in a millisecond the worker reads in or in one it skips,
    // depending on start-up: try both.
    const Device flip_a = {"Flipper, phase A", 520.0, 2, 0.0, 600.0};
    const Device flip_b = {"Flipper, phase B", 520.0, 2, 0.0, 1600.0};
    // Cardputer: the tick runs right after a read, in the same millisecond
    // or, if a millisecond boundary falls between, in the next one.
    const Device card_a = {"Cardputer (tick same ms)", 150.0, 1, 300.0, 600.0};
    const Device card_b = {"Cardputer (tick next ms)", 150.0, 1, 700.0, 1100.0};
    const Device* devs[] = {&flip_a, &flip_b, &card_a, &card_b};
    const int ndev = (int)(sizeof(devs) / sizeof(devs[0]));

    const double LSB5 = 7.8125e-6;
    const double HUM = 1000 * LSB5;  // 1000 counts amplitude: big, to see the leak
    const double HUM_RMS = 1000.0 / sqrt(2.0);

    printf("Hum left in the 100 ms average (input hum amplitude 1000 counts, RMS 707)\n");
    printf("%-30s %6s %9s %12s %14s\n", "device", "mains", "samples", "mean RMS", "leak % of hum");
    for(int i = 0; i < ndev; i++) {
        for(int f = 0; f < 2; f++) {
            double hz = f == 0 ? 50.0 : 50.05;
            Result r = run(devs[i], 1.0, hz, HUM, 0.0, 65.0, 1, NULL);
            printf("%-30s %6.2f %4.1f(%d-%d) %9.2f %12.2f%%   pga=%d\n", devs[i]->name, hz,
                   r.avg_samples, r.min_samples, r.max_samples, r.mean_rms_counts,
                   100.0 * r.mean_rms_counts / HUM_RMS, r.pga);
        }
    }

    printf("\nLeak %% of hum vs the ADC chip's own speed (datasheet allows +-10%%), mains 50.05 Hz:\n");
    printf("%-30s", "device");
    const double rf[] = {0.90, 0.95, 0.98, 1.00, 1.02, 1.05, 1.10};
    const int nrf = (int)(sizeof(rf) / sizeof(rf[0]));
    for(int j = 0; j < nrf; j++) printf(" %6.0f", 860.0 * rf[j]);
    printf("  SPS\n");
    for(int i = 0; i < ndev; i++) {
        printf("%-30s", devs[i]->name);
        for(int j = 0; j < nrf; j++) {
            Result r = run(devs[i], rf[j], 50.05, HUM, 0.0, 65.0, 1, NULL);
            printf(" %5.2f%%", 100.0 * r.mean_rms_counts / HUM_RMS);
        }
        printf("\n");
    }

    printf("\nRandom noise only (1 count RMS per conversion, the datasheet figure):\n");
    printf("%-30s %9s %14s %16s\n", "device", "samples", "mean RMS", "independent N");
    for(int i = 0; i < ndev; i++) {
        Result r = run(devs[i], 1.0, 50.0, 0.0, 1.0 * LSB5, 300.0, 7, NULL);
        printf("%-30s %9.1f %14.3f %16.1f\n", devs[i]->name, r.avg_samples, r.mean_rms_counts,
               1.0 / (r.mean_rms_counts * r.mean_rms_counts));
    }

    printf("\nA single reading (the graph's old input), hum 1000 counts, 50.05 Hz:\n");
    for(int i = 0; i < ndev; i++) {
        Result r = run(devs[i], 1.0, 50.05, HUM, 0.0, 65.0, 1, NULL);
        printf("%-30s single-reading RMS %.0f counts (%.0f%% of hum RMS)\n", devs[i]->name,
               r.single_rms_counts, 100.0 * r.single_rms_counts / HUM_RMS);
    }

    if(trace_dir) {
        char path[512];
        snprintf(path, sizeof(path), "%s/trace_cardputer_5005.csv", trace_dir);
        FILE* t = fopen(path, "w");
        if(!t) {
            fprintf(stderr, "can't write %s\n", path);
            return 1;
        }
        fprintf(t, "t_s,mean_err_counts,single_err_counts\n");
        run(&card_a, 1.0, 50.05, HUM, 0.0, 65.0, 1, t);
        fclose(t);
        printf("\nTrace written to %s\n", path);
    }
    return 0;
}
