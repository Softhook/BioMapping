// em_scan_rf.c — CC1101 sub-GHz RSSI sweep. See em_scan_rf.h.
//
// Verified against the real SDK headers (~/.ufbt/current/sdk_headers) after
// the first build attempt: furi_hal_subghz_reset/idle/rx/sleep/
// set_frequency/get_rssi and the FuriHalSubGhzPreset enum names all matched
// as originally written. The one miss was preset *loading* — there is no
// furi_hal_subghz_load_preset(enum) wrapper; presets are raw CC1101
// register byte arrays loaded via furi_hal_subghz_load_custom_preset(),
// with the arrays themselves declared in cc1101_configs.h.

#include "em_scan_rf.h"

#include <furi.h>
#include <furi_hal.h>
#include <furi_hal_subghz.h>
#include <lib/subghz/devices/cc1101_configs.h>

const uint32_t em_scan_freq_hz[EM_SCAN_NUM_FREQS] = {
    300000000, 315000000, 433920000, 446000000, 815000000, 868350000, 915000000,
};
const char* const em_scan_freq_label[EM_SCAN_NUM_FREQS] = {
    "300", "315", "434", "446", "815", "868", "915",
};

// Warm-up after idle->tune->rx, discarded before peak-hold sampling
// begins. CC1101's own AGC/PLL settle in well under this on typical
// channel bandwidths; the point isn't to wait "long enough for a valid
// reading" (5ms already covered that) but to exclude the AGC's initial
// gain-acquisition transient, which tends to swing high before settling —
// left in, that transient would masquerade as a false burst and
// contaminate the peak below.
#define EM_SCAN_WARMUP_MS 3

// Active peak-hold dwell AFTER the warm-up: RSSI is polled repeatedly
// during this window and the MAXIMUM is kept, not a single snapshot — see
// em_scan_rf_dwell_band's doc comment in em_scan_rf.h for why.
#define EM_SCAN_DWELL_MS  22

// Poll interval within the dwell window.
#define EM_SCAN_POLL_US   500

void em_scan_rf_init(void) {
    furi_hal_subghz_reset();
    furi_hal_subghz_idle();
    // Loaded with wideband 650 kHz OOK preset to capture maximum ambient
    // RF energy across each tuned frequency band for full-spectrum auditing.
    furi_hal_subghz_load_custom_preset(subghz_device_cc1101_preset_ook_650khz_async_regs);

    // One-time sanity check: set_frequency_and_path() returns the REAL
    // frequency the PLL actually locked to (it quantizes to discrete
    // steps, and can silently clamp/reject a request outside its valid
    // range) — log requested vs. actual for every configured band so a
    // stuck/rejected frequency (e.g. the flat -92.5 seen on 315 MHz in the
    // first walk test) shows up here instead of just looking like "no
    // signal" in the data.
    // Tolerance, not exact equality: the CC1101 PLL quantizes to discrete
    // synthesizer steps, so "actual" is essentially never bit-identical to
    // "requested" even when the tune succeeded perfectly — real deviations
    // seen in practice are ~100-350 Hz out of several hundred MHz (PLL
    // quantization noise). Anything within 2 kHz is a successful tune;
    // anything further off (e.g. silently clamped/rejected to a completely
    // different frequency) is the real failure mode this check is for.
    #define EM_SCAN_FREQ_TOLERANCE_HZ 2000
    for(int i = 0; i < EM_SCAN_NUM_FREQS; i++) {
        furi_hal_subghz_idle();
        uint32_t actual = furi_hal_subghz_set_frequency_and_path(em_scan_freq_hz[i]);
        uint32_t diff = (actual > em_scan_freq_hz[i]) ? (actual - em_scan_freq_hz[i])
                                                        : (em_scan_freq_hz[i] - actual);
        FURI_LOG_I("EmScan", "freq[%d] %s: requested=%lu actual=%lu%s", i, em_scan_freq_label[i],
                   (unsigned long)em_scan_freq_hz[i], (unsigned long)actual,
                   diff <= EM_SCAN_FREQ_TOLERANCE_HZ ? "" : "  <-- MISMATCH");
    }
    #undef EM_SCAN_FREQ_TOLERANCE_HZ
    furi_hal_subghz_idle();
}

void em_scan_rf_deinit(void) {
    furi_hal_subghz_idle();
    furi_hal_subghz_sleep();
}

void em_scan_rf_dwell_band(int band_index, float* out_peak_dbm) {
    furi_hal_subghz_idle();
    // _and_path (not plain set_frequency) — this also switches the RF
    // matching network for the target band. Using plain set_frequency left
    // the antenna path wherever the previous hop left it, which silently
    // attenuated most readings toward the noise floor. This was the actual
    // bug behind "the bars didn't move" on the first walk test.
    furi_hal_subghz_set_frequency_and_path(em_scan_freq_hz[band_index]);
    furi_hal_subghz_rx();

    furi_delay_ms(EM_SCAN_WARMUP_MS);

    // Yield execution context to FreeRTOS (furi_delay_ms(1)) instead of
    // busy-waiting with microseconds, significantly saving CPU power.
    float peak = -127.0f;
    for(uint32_t elapsed_ms = 0; elapsed_ms < EM_SCAN_DWELL_MS; elapsed_ms++) {
        float r = furi_hal_subghz_get_rssi();
        if(r > peak) peak = r;
        furi_delay_ms(1);
    }

    furi_hal_subghz_idle();
    *out_peak_dbm = peak;
}

// Poll interval within em_scan_rf_park_band's dwell window. Was 2ms;
// measured on real hardware (tracks 75-80) to inflate a configured 300ms
// park to ~470-670ms real time, because furi_delay_ms() rounds up to the
// nearest OS tick and that rounding cost is paid once per call — 150 calls
// at 2ms each compounds it far more than fewer, longer calls would. 10ms
// cuts the call count 5x (150 -> 30 per 300ms park), which should shrink
// the overshoot by roughly the same factor. Still 100-1000x finer than any
// real signal duration seen in the data so far (shortest confirmed event
// was several seconds), so this isn't expected to cost any catch
// probability — see track 78-80 analysis for the reasoning.
#define EM_SCAN_PARK_POLL_MS 10

void em_scan_rf_park_band(
    int       band_index,
    uint32_t  park_ms,
    float*    out_peak_dbm,
    float*    out_mean_dbm,
    uint32_t* out_sample_count) {
    furi_hal_subghz_idle();
    furi_hal_subghz_set_frequency_and_path(em_scan_freq_hz[band_index]);
    furi_hal_subghz_rx();

    furi_delay_ms(EM_SCAN_WARMUP_MS);

    float    peak = -127.0f;
    double   sum = 0.0;
    uint32_t count = 0;
    // Terminate on measured elapsed time, not a nominal iteration count: the
    // old `for(elapsed_ms = 0; elapsed_ms < park_ms; elapsed_ms +=
    // POLL_MS)` counted a fixed number of iterations (park_ms/POLL_MS)
    // regardless of how long each furi_delay_ms(10) actually took — and on
    // real hardware each call ran well past 10ms (tick rounding + SPI/
    // scheduling overhead), so a configured 300ms park always ran all 30
    // iterations and measured ~630-670ms. Checking real elapsed ticks
    // against park_ms means the loop exits as soon as actual time reaches
    // the target, so it converges on the configured park_ms instead of
    // inflating past it.
    uint32_t start_tick = furi_get_tick();
    uint32_t park_ticks = (park_ms * furi_kernel_get_tick_frequency()) / 1000;
    while(furi_get_tick() - start_tick < park_ticks) {
        float r = furi_hal_subghz_get_rssi();
        if(r > peak) peak = r;
        sum += (double)r;
        count++;
        furi_delay_ms(EM_SCAN_PARK_POLL_MS);
    }

    furi_hal_subghz_idle();
    *out_peak_dbm = peak;
    *out_mean_dbm = (count > 0) ? (float)(sum / (double)count) : peak;
    *out_sample_count = count;
}
