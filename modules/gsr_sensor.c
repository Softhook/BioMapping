// GSR Sensor — ADS1115 I2C differential reader with PGA autoranging.
// Signal processing (EMA, derivative) is deferred to the main app.

#include "gsr_sensor.h"
#include "em_scan_rf.h"
#include <furi.h>
#include <furi_hal.h>
#include <stdlib.h>
#include <math.h>
#include <string.h>
#include <stdatomic.h>

// ─────────────────────────────────────────────────────────────────────────────
// TIA conversion: normalized ADC counts → nanosiemens
//
// Transimpedance amplifier circuit equation.  Clamped at 319000 counts
// (≈rail saturation).  Constants: 5×10⁶ numerator, 1.504×10⁷ − 47×counts
// denominator.  Used by both tick() and get_raw_sample_ns() — defined
// here as file-local static inline so the two call sites share one copy.
// ─────────────────────────────────────────────────────────────────────────────
static inline float tia_counts_to_ns(float counts) {
    if(counts <= 0.0f) return 0.0f;
    if(counts > 319000.0f) counts = 319000.0f;
    return (counts * 5000000.0f) / (15040000.0f - counts * 47.0f);
}

// ─────────────────────────────────────────────────────────────────────────────
// ADS1115 register addresses
// ─────────────────────────────────────────────────────────────────────────────
#define ADS1115_CONFIG_REG   0x01

// ─────────────────────────────────────────────────────────────────────────────
// PGA autoranging
//
// pga_index  FSR        µV/LSB    Config MSB
// ─────────  ─────────  ────────  ──────────
//    0       ±6.144 V   187.500   0x80
//    1       ±4.096 V   125.000   0x82
//    2       ±2.048 V    62.500   0x84  ← default / normalisation reference
//    3       ±1.024 V    31.250   0x86
//    4       ±0.512 V    15.625   0x88
//    5       ±0.256 V     7.813   0x8A
//
// DELAY AFTER PGA CHANGE
//   The ADS1115 is a delta-sigma ADC in continuous mode at 860 SPS.  After
//   writing a new config, the current conversion in the register was started
//   under the OLD setting (~1.16 ms old).  The worker skips that stale read
//   and waits 2 ms (> 1.16 ms) so the next iteration reads the first
//   fully-settled conversion under the new PGA — preventing single-sample
//   glitches where the signal suddenly halved or doubled.
//
// SATURATION DETECTION
//   The ADC clips at exactly ±32 767 (0x7FFF / 0x8000).  We use
//   ADS_SATURATE_THRESH = 30 000 (~91.5 % of FS) to catch the approaching
//   rail one tick before hard saturation; the FSR is widened immediately.
//
// RANGING-UP HYSTERESIS
//   Gain is only increased after ADS_LOW_COUNT_TICKS = 5 consecutive ticks
//   with |raw| < ADS_LOW_THRESH = 4 096 (12.5 % FS).  After ranging up, the
//   same physical signal reads ~2× as many counts (~25 % FS), safely above
//   the threshold — preventing oscillation around the boundary.
//
// OUTPUT NORMALISATION
//   gsr_sensor_get_raw() returns counts normalised to the pga_index=5 (±0.256 V)
//   reference where 1 unit = 7.8125 µV.  This preserves 100 % of the hardware's
//   resolution at all gain settings:
//
//     normalised = hw × NORM_FACTOR[pga]
//
//   PGA ratios relative to ±0.256 V are exact integers (no float or division):
//     pga 0 (±6.144V, LSB=187.5 µV):    ×24
//     pga 1 (±4.096V, LSB=125.0 µV):    ×16
//     pga 2 (±2.048V, LSB=62.50 µV):    ×8  (familiar ±2.048V range scale × 8)
//     pga 3 (±1.024V, LSB=31.25 µV):    ×4
//     pga 4 (±0.512V, LSB=15.625 µV):   ×2
//     pga 5 (±0.256V, LSB=7.8125 µV):   ×1
// ─────────────────────────────────────────────────────────────────────────────

#define ADS_PGA_DEFAULT       2
#define ADS_PGA_MIN           0
#define ADS_PGA_MAX           5
#define ADS_SATURATE_THRESH   30000  // 91.5 % of FS → range down immediately
#define ADS_LOW_THRESH         4096  // 12.5 % of FS → range up candidate
#define ADS_LOW_COUNT_TICKS       5  // consecutive low ticks before range up

// Target duration of gsr_sensor_tick()'s averaging window. Time-based
// (see docs/gsr_filtering_analysis.md, Recommendation 1b) rather than a
// fixed sample count — a fixed N=100 was only actually ~100 ms when the
// worker's true rate was ~1000 Hz, which measurement showed it wasn't
// (~500 Hz measured on real hardware, giving a ~200 ms window instead).
// Later measurement showed the rate itself isn't a stable ~500 Hz either
// — it varies roughly 400-500 Hz run to run — which is exactly why this
// stays time-based rather than being re-tuned to whatever the rate
// happens to be on a given day: window duration (and therefore the
// 50/60 Hz null) no longer depends on hitting any particular rate at
// all, see the pacing comment in gsr_sensor_worker() below.
#define BOXCAR_WINDOW_MS  100

// Target frequency for the on-device mains-hum content estimator (see
// gsr_sensor_get_mains_hum_mag()). Fixed at 50 Hz — the diagnostics
// screen has room for one, and the boxcar's exact-null property already
// covers both 50 and 60 Hz identically by construction (Recommendation
// 1b), so this is purely about giving a visible, measured answer to "is
// there real mains-hum content in the raw signal", not about validating
// one mains frequency over the other.
#define MAINS_HUM_TARGET_HZ  50.0f
#define GSR_PI  3.14159265358979323846f

// Target dwell time per band for the SubGHz RF scan below. Checked against
// real elapsed ticks (furi_get_tick()), not a nominal loop-iteration count —
// em_scan_rf.c's em_scan_rf_park_band() found on real hardware (tracks
// 75-80) that counting iterations instead inflated a configured 300ms park
// to ~630-670ms real time, because furi_delay_ms() rounds up to the nearest
// OS tick and that rounding cost compounds once per iteration.
//
// 3000ms (up from an original 300ms): RF sampling is paced to
// RF_SAMPLE_INTERVAL_MS below regardless of dwell length, so a longer dwell
// only helps here — ~30 peak-hold samples per band instead of ~3, AND 10x
// fewer band retunes (the expensive 4-SPI-call em_scan_rf_set_band(), see
// below) per minute of RF exposure. Chosen deliberately coarse: GSR and GPS
// data quality are the priority, RF is secondary (2026-07-30 GPS-quality
// investigation — see git history around the "only 2 threads" merge).
#define RF_DWELL_MS 3000

// Paces RF sampling within the worker loop to ~10 Hz instead of every ADC
// iteration (~1-2 ms) — this worker has spare capacity relative to what the
// ADC needs, but RF doesn't need anywhere near that resolution, and every
// furi_hal_subghz_* call is exposure to the unbounded SPI busy-wait bug
// documented in em_scan_rf_crash_investigation.md (furi_hal_spi_bus_end_txrx()
// has no timeout). Cutting call frequency ~50-100x is the only mitigation
// available from app code for that bug — reducing exposure, not fixing it.
#define RF_SAMPLE_INTERVAL_MS 100

// Normalisation multiplier factors to pga_index=5 (±0.256 V) reference.
static const int32_t NORM_FACTOR[6] = { 24, 16, 8, 4, 2, 1 };

// Human-readable FSR label for each pga_index (log messages only).
static const char* const PGA_LABEL[6] __attribute__((unused)) = {
    "6.144V", "4.096V", "2.048V", "1.024V", "0.512V", "0.256V",
};

// Config register MSB for each pga_index.
// Bit layout: OS=1 | MUX=000 (AIN0–AIN1 differential) | PGA[2:0] | MODE=0 (continuous)
// = 0x80 | (pga_index << 1).  LSB stays 0xE3: DR=860 SPS, comparator disabled.
static inline uint8_t pga_msb(uint8_t idx) {
    return (uint8_t)(0x80u | ((uint32_t)idx << 1u));
}

// ─────────────────────────────────────────────────────────────────────────────
// Struct & Constants
// ─────────────────────────────────────────────────────────────────────────────

// Compile-time guard: the ring buffer uses & (SENSOR_BUFFER_SIZE - 1) which
// only works for powers of two.
_Static_assert((SENSOR_BUFFER_SIZE & (SENSOR_BUFFER_SIZE - 1)) == 0,
               "SENSOR_BUFFER_SIZE must be a power of two");

struct GsrSensor {
    float   raw;        // skin conductance in nanosiemens (nS)
    bool    available;
    bool    connected;  // false after 20+ ticks of zero readings (cuffs disconnected)
    bool    i2c_working; // false when consecutive I2C reads fail
    uint8_t pga_index;  // active PGA setting (0 … ADS_PGA_MAX)
    uint8_t low_count;  // consecutive ticks below ADS_LOW_THRESH
    uint8_t zero_count; // consecutive ticks with raw == 0.0f
    int8_t  pga_locked; // -1 = autoranging; 0–5 = fixed PGA (diagnostic lock)
    bool    cal_active; // true when custom calibration is active
    float   cal_gain;   // linear calibration gain factor (default 1.0)
    float   cal_offset; // linear calibration offset in counts (default 0.0)
    // Gates the mains-hum correlator in tick()'s Step 1 (2 trig calls per
    // sample, ~80-100/tick at the ~40-50-sample window this typically
    // runs with — the worker's real rate varies ~400-500 Hz, not a fixed
    // ~500 Hz, so sample count varies tick to tick) — set by
    // gsr_sensor_set_mains_hum_enabled(). Off by default:
    // the app only needs this on the Diagnostics screen, and there's no
    // reason to spend the cycles the rest of the time. Mutex-protected
    // like cal_active above, even though today's only caller
    // (biomap_session.c, right after gsr_sensor_alloc()) happens to run
    // on the same thread as tick() — same reasoning as calibration:
    // don't assume that stays true just because it is right now.
    bool mains_hum_enabled;
    int32_t tick_last_norm; // raw normalized count at tick's last-summed index
                             // (snapshotted during tick, used by get_raw_sample_ns)
    int32_t tick_mean_norm; // ~100 ms window mean normalized count (pre-TIA)
    int32_t tick_window_samples; // how many buffer entries landed in that window
    int32_t  tick_window_ptp;      // max-min of the window's raw counts (peak-to-peak)
    uint32_t tick_window_min_gap;  // smallest inter-sample tick gap seen in the window
    float    tick_mains_hum_mag;   // per-sample-timestamp correlation amplitude at
                                    // MAINS_HUM_TARGET_HZ — see gsr_sensor_get_mains_hum_mag()
    uint32_t pga_change_count;         // tick()-only — total PGA changes applied, lifetime
    uint32_t hz_window_start_pga_changes; // pga_change_count snapshot — tick() only
    uint32_t pga_change_rate_cached;      // tick() only — PGA changes in the last ~1 s window

    // SubGHz RF state — touched ONLY by the worker thread, at ~10 Hz (see
    // RF_SAMPLE_INTERVAL_MS), except rf_enabled which the main thread also
    // writes (once at enable, once at disable/free — see
    // gsr_sensor_set_rf_enabled()). No mutex on these two: same reasoning
    // as `running` below (a single flag, eventually-consistent by at most
    // one loop iteration) — NOT `pga_changed`, which despite also being
    // declared volatile is actually protected by gsr->mutex on both the
    // write (tick()'s Step 5) and the read (this worker's loop top); it
    // was wrongly cited here as a second lock-free precedent during the
    // 2026-07-30 mutex work and corrected on review. rf_enabled is a
    // narrower exception than the "no exceptions" policy from that same
    // review states, kept anyway because protecting it would mean the
    // ADC-dominated worker loop takes rf_mutex on every iteration just to
    // check a flag, not only the ones actually doing RF work — reintroducing
    // the kind of frequent cross-thread lock traffic that work was trying
    // to remove. Safe by the same ordering argument as `running`: the only
    // consequence of the worker observing this flag one iteration late is
    // a one-iteration-late start/stop of RF sampling, not corrupted state.
    //
    // _Atomic, not plain volatile: a ThreadSanitizer run during the
    // 2026-07-30 mutex work flagged this (and running, and rf_spi_busy
    // below) as genuine data races per the C11 memory model — "single-core
    // Cortex-M4, a plain load/store is probably fine" was an assumption,
    // not a guarantee. _Atomic bool costs nothing extra (compiles to the
    // same plain load/store on a naturally-aligned byte on both the host
    // test build and the real ARM target) and makes the guarantee real
    // instead of informal. Plain C syntax (=, ==) still works on an
    // _Atomic-qualified variable — no call sites needed to change.
    _Atomic bool rf_enabled;
    // True for exactly the span of the worker's RSSI read + possible band
    // retune (both furi_hal_subghz_* calls) — nothing else touches SPI, so
    // this doubles as "is the worker inside an RF hardware call right
    // now". gsr_sensor_set_rf_enabled()'s disable path polls this before
    // calling em_scan_rf_deinit(), closing the window where that call
    // could otherwise race an in-flight worker SPI transaction on the
    // same CC1101. Same reasoning as rf_enabled/running — see that
    // field's comment for why _Atomic rather than plain volatile.
    _Atomic bool rf_spi_busy;
    int      rf_band;
    uint32_t rf_dwell_start_tick;  // furi_get_tick() when the current band's dwell began
    uint32_t rf_last_sample_tick;  // furi_get_tick() of the last RSSI read — paces to ~10 Hz
    float    rf_dwell_peak[EM_SCAN_NUM_FREQS];

    // Published RF snapshot — the ONLY RF state read cross-thread (main
    // thread's Tick handler + GUI thread's render callback, both via
    // gsr_sensor_get_rf_snapshot()). Guarded by rf_mutex, deliberately NOT
    // gsr->mutex: keeping the ADC ring-buffer lock and the RF snapshot lock
    // separate means an RF SPI stall can never block ADC sampling (or vice
    // versa) — the actual bug behind the 2026-07-30 GPS-quality
    // investigation was RF's SPI retune running inside gsr->mutex, which
    // the main thread also needed every tick. rf_mutex is NEVER held during
    // a furi_hal_subghz_* call — only ever to copy these 3 floats.
    float    rf_rssi_dbm[EM_SCAN_NUM_FREQS];

    FuriThread* thread;
    FuriMutex*  mutex;     // ADC ring buffer, PGA/calibration state, diagnostics counters
    FuriMutex*  rf_mutex;  // rf_rssi_dbm[] snapshot only — see doc comment above
    // _Atomic — see rf_enabled's comment above; worker reads this every
    // loop iteration (while(gsr->running)), gsr_sensor_free() writes it
    // once to stop the thread.
    _Atomic bool running;
    volatile bool pga_changed; // mutex-protected in practice — see rf_enabled's comment

    int32_t  buffer[SENSOR_BUFFER_SIZE];
    uint32_t sample_tick[SENSOR_BUFFER_SIZE]; // tick timestamp of buffer[i], for
                                               // time-based (not count-based) averaging
                                               // in gsr_sensor_tick() — see Recommendation
                                               // 1b in docs/gsr_filtering_analysis.md
    volatile uint32_t write_idx;

    // Worker throughput diagnostics (see docs/gsr_filtering_analysis.md,
    // Recommendation 1) — iter_count counts successful buffer writes only
    // (not PGA-change passes, which don't write), so iter_count / elapsed
    // time is the true sample rate the CSV boxcar average in
    // gsr_sensor_tick() actually runs at.
    //
    // worker_hz_cached is a ROLLING ~1 s measurement, recomputed by
    // gsr_sensor_tick() (main thread only) whenever a window elapses —
    // deliberately NOT a lifetime average since alloc().  A lifetime
    // average converges slowly and stays permanently diluted by the
    // one-time probe/warm-up delay in gsr_sensor_alloc(), so a reading
    // taken shortly after entering the Diagnostics screen would
    // understate the true steady-state rate.  Same no-mutex-needed
    // pattern as tick_mean_norm below: written only by tick() on the main
    // thread, read by the accessor on the same thread.
    uint32_t iter_count;            // mutex-protected — worker increments (success only), tick() reads
    uint32_t attempt_count;         // mutex-protected — worker increments (every read, success or fail)
    // duplicate_count — mutex-protected, worker increments whenever a
    // successful read's raw ADC code exactly matches the immediately
    // preceding successful read's code (same PGA setting). This is the
    // direct, measured version of the skip-vs-duplicate question in
    // docs/gsr_filtering_analysis.md.
    //
    // Measured on real hardware (2026-07-23): ~7-11% with a live skin
    // conductance signal connected, ~12-16% with the sensor disconnected
    // (open circuit). NOT near 0% as the "worker rate is below 860 SPS,
    // so every read should be fresh" reasoning originally predicted here
    // — that reasoning was wrong (or at least incomplete): this counter
    // can't distinguish a genuinely stale re-read from two fresh
    // conversions of a signal that simply hasn't changed between them,
    // which is why the disconnected (near-DC, no real noise source)
    // reading is higher than the connected one. The remaining ~7-11%
    // under a real signal is still unexplained — per-iteration timing
    // jitter in furi_delay_ms(1)'s tick-aliasing (see the pacing comment
    // in gsr_sensor_worker()) occasionally producing a loop period under
    // the ADC's ~1.16 ms conversion time is the leading candidate, not
    // yet isolated. Reset to 0 (via have_last_hw = false in the worker)
    // on every PGA change, since a gain change makes the previous
    // reading's raw code incomparable to the new one — that's a scale
    // change, not evidence of a stale read.
    uint32_t duplicate_count;
    uint32_t stale_count;               // mutex-protected — worker increments on duplicates with gap_ticks < 2 (stale hardware re-read)
    // duplicate_gap_running_min — mutex-protected. Worker tracks the
    // smallest inter-read tick gap seen specifically AT a duplicate
    // event (not the general per-window minimum gsr_sensor_tick()
    // computes over the whole window in Step 1) since the last ~1 s
    // window reset. UINT32_MAX means no duplicates have occurred yet in
    // the current window. This is the direct correlation that
    // duplicate_count alone doesn't give: whether the reads that
    // actually turned out to be duplicates were specifically the
    // tightly-spaced ones — real evidence for or against the "occasional
    // sub-ADC-conversion-time loop period" theory, rather than comparing
    // two independent aggregate numbers (general window Gap vs. Dup%)
    // and eyeballing whether they seem consistent.
    uint32_t duplicate_gap_running_min;
    uint32_t duplicate_gap_min_cached; // tick() only — last window's value, same UINT32_MAX sentinel
    uint32_t hz_window_start_tick;  // tick() only
    uint32_t hz_window_start_count;    // iter_count snapshot — tick() only
    uint32_t hz_window_start_attempts; // attempt_count snapshot — tick() only
    uint32_t hz_window_start_duplicates; // duplicate_count snapshot — tick() only
    uint32_t hz_window_start_stale;    // stale_count snapshot — tick() only
    float    worker_hz_cached;      // tick() only — successful-sample rate
    float    success_rate_cached;   // tick() only — iter_count/attempt_count over the same window, 0-100
    float    duplicate_rate_cached; // tick() only — duplicate_count/iter_count over the same window, 0-100
    float    stale_rate_cached;     // tick() only — stale_count/iter_count over the same window, 0-100

    // Live (not rolling-window) count of consecutive failed I2C reads —
    // mutex-protected, mirrors the worker's local consecutive_failures.
    // Published so the accessor can show "how close to the 50-failure
    // disconnect threshold right now", which a ~1 s rolling success_rate
    // average can't: success_rate can still read e.g. 80% while a fresh
    // failure streak is actively building toward disconnect. Only
    // written on failure, and once on recovery (not every successful
    // iteration) — see gsr_sensor_worker() — to avoid taking the mutex
    // on every single normal-operation read just to publish a 0.
    uint32_t consecutive_failures;

    // Per-op-type worst-case blocking-call duration ever observed, in ms —
    // real furi_get_tick() deltas measured immediately around each
    // hardware call below, never reset (same "only grows" spirit as
    // gps_uart's gps_rx_drops/nmea_fail — see RowDiag's doc comment,
    // biomap_types.h). Added 2026-08-03 to answer "which of the candidate
    // calls actually caused a given main-loop stall" directly, in place of
    // inferring it from how often each call type runs. i2c_peak_ms covers
    // BOTH I2C call sites in the worker below (the PGA-change config write
    // and the routine conversion read) — the two are mutually exclusive
    // within a single loop iteration, so one column covers both.
    // i2c_peak_ms is guarded by `mutex` (the ADC-path lock, like the other
    // diagnostics counters above); rf_rssi_peak_ms/rf_retune_peak_ms are
    // guarded by `rf_mutex` instead, matching rf_rssi_dbm[]'s separation
    // above — keeps RF diagnostic bookkeeping from ever contending with
    // the ADC path, same reason the two mutexes exist at all. None of the
    // three is ever updated while its mutex is held across the hardware
    // call itself, only in the brief window afterward.
    uint32_t i2c_peak_ms;
    uint32_t rf_rssi_peak_ms;
    uint32_t rf_retune_peak_ms;
};

// Background worker thread for 860 SPS ADC reading.  Writes normalized
// samples to the ring buffer; the main thread's gsr_sensor_tick() handles
// decimation, autoranging, and TIA computation at exact 10 Hz boundaries.
static int32_t gsr_sensor_worker(void* context) {
    GsrSensor* gsr = context;
    uint8_t current_adc_pga = ADS_PGA_DEFAULT;
    uint32_t consecutive_failures = 0;
    int16_t  last_hw = 0;
    bool     have_last_hw = false; // no prior read to compare the first one against
    uint32_t last_read_tick = 0;   // paired with have_last_hw — valid whenever it's true

    while(gsr->running) {
        furi_mutex_acquire(gsr->mutex, FuriWaitForever);
        uint8_t active_pga = gsr->pga_index;
        bool pga_changed = gsr->pga_changed;
        furi_mutex_release(gsr->mutex);

        // ── PGA change path: acquire I2C, write config, release, always ──
        // continue back to the top — never fall through to the read path
        // or the I2C handle will be released twice.
        if(pga_changed) {
            furi_hal_i2c_acquire(&furi_hal_i2c_handle_external);
            uint8_t cfg[2] = { pga_msb(active_pga), 0xE3 };
            uint32_t i2c_write_start = furi_get_tick();
            bool cfg_ok = furi_hal_i2c_write_mem(
                &furi_hal_i2c_handle_external,
                ADS1115_I2C_ADDR, ADS1115_CONFIG_REG,
                cfg, 2, 50);
            uint32_t i2c_write_dur = furi_get_tick() - i2c_write_start;
            furi_hal_i2c_release(&furi_hal_i2c_handle_external);

            // Timed regardless of cfg_ok — a stall is worth recording
            // whether or not the write it stalled on happened to succeed.
            furi_mutex_acquire(gsr->mutex, FuriWaitForever);
            if(i2c_write_dur > gsr->i2c_peak_ms) gsr->i2c_peak_ms = i2c_write_dur;
            furi_mutex_release(gsr->mutex);

            if(cfg_ok) {
                furi_mutex_acquire(gsr->mutex, FuriWaitForever);
                gsr->pga_changed = false;
                furi_mutex_release(gsr->mutex);

                // Wait for the first fully-settled conversion under the new
                // PGA.  At 860 SPS conversion takes 1.16 ms; 2 ms guarantees
                // the next read returns a new-PGA result.
                furi_delay_ms(2);
                current_adc_pga = active_pga;
                have_last_hw = false; // new gain scale — not comparable to the pre-change code
            } else {
                // Config write failed — retry next iteration.
                furi_delay_ms(1);
            }
            continue;
        }

        // ── Normal read path: acquire I2C, read conversion, release. ────
        furi_hal_i2c_acquire(&furi_hal_i2c_handle_external);
        uint8_t data[2];
        uint32_t i2c_read_start = furi_get_tick();
        bool ok = furi_hal_i2c_read_mem(
            &furi_hal_i2c_handle_external,
            ADS1115_I2C_ADDR, ADS1115_CONV_REG,
            data, 2, 50);
        uint32_t i2c_read_dur = furi_get_tick() - i2c_read_start;
        furi_hal_i2c_release(&furi_hal_i2c_handle_external);

        // Counts every attempt, success or failure — distinguishes "the
        // loop genuinely only runs this fast" from "the loop runs fast
        // but half the reads silently fail" (iter_count alone can't tell
        // these apart; see docs/gsr_filtering_analysis.md).
        furi_mutex_acquire(gsr->mutex, FuriWaitForever);
        gsr->attempt_count++;
        if(i2c_read_dur > gsr->i2c_peak_ms) gsr->i2c_peak_ms = i2c_read_dur;
        furi_mutex_release(gsr->mutex);

        if(ok) {
            if(consecutive_failures != 0) {
                consecutive_failures = 0;
                furi_mutex_acquire(gsr->mutex, FuriWaitForever);
                gsr->consecutive_failures = 0;
                furi_mutex_release(gsr->mutex);
            }
            if(!gsr->i2c_working) {
                furi_mutex_acquire(gsr->mutex, FuriWaitForever);
                gsr->i2c_working = true;
                furi_mutex_release(gsr->mutex);
            }
            int16_t hw = (int16_t)((data[0] << 8) | data[1]);

            // Normalize using current_adc_pga (the gain that was active
            // when the conversion currently in the register was started).
            int32_t norm = (int32_t)hw * NORM_FACTOR[current_adc_pga];

            // Same raw code as the immediately preceding (same-PGA) read
            // means the ADS1115 hadn't completed a new conversion between
            // the two I2C transactions — a stale re-read, not a fresh
            // sample. See duplicate_count's doc comment above.
            uint32_t this_tick = furi_get_tick();
            bool is_duplicate = have_last_hw && (hw == last_hw);
            // Only meaningful (and only ever read) when is_duplicate is
            // true, which requires have_last_hw — so last_read_tick is
            // always valid by the time it's actually used below.
            uint32_t gap_ticks = this_tick - last_read_tick;
            last_hw = hw;
            last_read_tick = this_tick;
            have_last_hw = true;

            furi_mutex_acquire(gsr->mutex, FuriWaitForever);
            gsr->buffer[gsr->write_idx] = norm;
            gsr->sample_tick[gsr->write_idx] = this_tick;
            gsr->write_idx = (gsr->write_idx + 1) & (SENSOR_BUFFER_SIZE - 1);
            gsr->iter_count++;
            if(is_duplicate) {
                gsr->duplicate_count++;
                if(gap_ticks < 2) {
                    gsr->stale_count++;
                }
                if(gap_ticks < gsr->duplicate_gap_running_min) {
                    gsr->duplicate_gap_running_min = gap_ticks;
                }
            }
            furi_mutex_release(gsr->mutex);
        } else {
            consecutive_failures++;
            furi_mutex_acquire(gsr->mutex, FuriWaitForever);
            gsr->consecutive_failures = consecutive_failures;
            // After ~50 ms of continuous I2C failures, treat the sensor
            // as disconnected so the UI doesn't show a stale frozen value.
            if(consecutive_failures >= 50) {
                gsr->connected = false;
                gsr->i2c_working = false;
                gsr->raw = 0.0f;
            }
            furi_mutex_release(gsr->mutex);
        }

        if(!pga_changed) {
            current_adc_pga = active_pga;
        }

        // ── RF band scan — paced to ~10 Hz, one frequency per pass ─────────
        // Deliberately NOT under gsr->mutex (unlike the old interleaved
        // block this replaces): neither the RSSI read nor the periodic
        // retune touches anything the ADC path or any other thread reads,
        // so no lock is needed around the SPI calls themselves — only
        // around the tiny snapshot publish below, via rf_mutex, held for a
        // handful of float writes and never across a furi_hal_subghz_* call.
        // See RF_SAMPLE_INTERVAL_MS's doc comment for why this is paced
        // down from the loop's native ADC cadence instead of running every
        // iteration like before.
        //
        // rf_spi_busy brackets the ENTIRE SPI-touching region below (both
        // the RSSI read and the possible retune) — see
        // gsr_sensor_set_rf_enabled()'s disable path, which rendezvouses
        // on rf_mutex and then polls this flag before calling
        // em_scan_rf_deinit(), so it never races an in-flight SPI
        // transaction on the CC1101.
        //
        // The decide-and-mark step (rf_enabled/pacing-gate check, up to
        // and including setting rf_spi_busy = true) happens under
        // rf_mutex — not just as two separate atomic flag operations —
        // specifically so that gsr_sensor_set_rf_enabled(false)'s own
        // rf_mutex acquire/release is guaranteed to run either fully
        // before or fully after this block. Without that, there's a
        // TOCTOU gap: the worker could read rf_enabled as true, get
        // preempted before it sets rf_spi_busy, and the disable thread
        // could observe busy==false and proceed in exactly that window.
        // Each flag being individually atomic (see rf_enabled's struct
        // comment) doesn't close this — the gap is BETWEEN the two
        // operations, not within either one. Sharing rf_mutex across both
        // is what closes it: it makes "check rf_enabled" and "set
        // rf_spi_busy" one indivisible step from the disable thread's
        // point of view. The actual SPI calls stay OUTSIDE the mutex
        // either way (see the file's mutex-vs-hardware-call rule), so
        // this adds one more brief, uncontended acquire/release per loop
        // iteration — not a hold across anything slow.
        if(gsr->rf_enabled) {
            uint32_t now_tick = furi_get_tick();
            uint32_t sample_ticks = (RF_SAMPLE_INTERVAL_MS * furi_kernel_get_tick_frequency()) / 1000;

            furi_mutex_acquire(gsr->rf_mutex, FuriWaitForever);
            bool should_sample = gsr->rf_enabled &&
                (now_tick - gsr->rf_last_sample_tick >= sample_ticks);
            if(should_sample) {
                gsr->rf_last_sample_tick = now_tick;
                gsr->rf_spi_busy = true;
            }
            furi_mutex_release(gsr->rf_mutex);

            if(should_sample) {
                float snapshot[EM_SCAN_NUM_FREQS];
                uint32_t sweep_start = furi_get_tick();
                em_scan_rf_fast_sweep_snapshot(snapshot);
                uint32_t sweep_dur = furi_get_tick() - sweep_start;

                furi_mutex_acquire(gsr->rf_mutex, FuriWaitForever);
                for(int b = 0; b < EM_SCAN_NUM_FREQS; b++) {
                    gsr->rf_rssi_dbm[b] = snapshot[b];
                }
                if(sweep_dur > gsr->rf_rssi_peak_ms) gsr->rf_rssi_peak_ms = sweep_dur;
                furi_mutex_release(gsr->rf_mutex);

                gsr->rf_spi_busy = false; // SPI region ends here — see doc comment above
            }
        }

        furi_delay_ms(1);
    }
    return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle
// ─────────────────────────────────────────────────────────────────────────────
GsrSensor* gsr_sensor_alloc(void) {
    GsrSensor* gsr = malloc(sizeof(GsrSensor));
    // furi_check, not furi_assert: this app's build defines FURI_NDEBUG
    // (confirmed via .vscode/compile_commands.json), so furi_assert() is a
    // no-op here — it would never actually check anything on a real
    // device. Promoted throughout the functions this file's normal
    // (non-Diagnostics) walk path actually calls (2026-07-29), as part of
    // the ongoing crash investigation — see
    // em_scan_rf_crash_investigation.md. Diagnostics-only accessors
    // (worker_hz, success_rate, etc.) are left as plain asserts since a
    // normal walk never exercises them.
    furi_check(gsr, "GsrSensor: alloc failed");
    gsr->raw       = 0.0f;
    gsr->pga_index = ADS_PGA_DEFAULT;
    gsr->low_count = 0;
    gsr->connected = true;
    gsr->i2c_working = true;
    gsr->zero_count = 0;
    gsr->pga_locked = -1;  // autoranging enabled by default
    gsr->cal_active = false;
    gsr->cal_gain = 1.0f;
    gsr->cal_offset = 0.0f;
    gsr->mains_hum_enabled = false; // opt-in — see the struct field's doc comment

    furi_hal_i2c_acquire(&furi_hal_i2c_handle_external);
    uint8_t probe = 0;
    bool probed = furi_hal_i2c_read_mem(
        &furi_hal_i2c_handle_external,
        ADS1115_I2C_ADDR, ADS1115_CONV_REG,
        &probe, 1, 20);

    if(probed) {
        uint8_t cfg[2] = { pga_msb(ADS_PGA_DEFAULT), 0xE3 }; // Config: default PGA, continuous 860 SPS
        bool cfg_ok = furi_hal_i2c_write_mem(
            &furi_hal_i2c_handle_external,
            ADS1115_I2C_ADDR, ADS1115_CONFIG_REG,
            cfg, 2, 50);
        if(!cfg_ok) FURI_LOG_W("GsrSensor", "Config write failed — using defaults");
    }
    furi_hal_i2c_release(&furi_hal_i2c_handle_external);

    gsr->available = true;
    gsr->i2c_working = probed;
    FURI_LOG_I("GsrSensor", "I2C Probe %s", probed ? "OK" : "not found");

    int32_t initial_norm = 0;
    if(probed) {
        // Warm up buffer with initial value
        furi_delay_ms(5);
        furi_hal_i2c_acquire(&furi_hal_i2c_handle_external);
        uint8_t data[2];
        bool ok = furi_hal_i2c_read_mem(
            &furi_hal_i2c_handle_external,
            ADS1115_I2C_ADDR, ADS1115_CONV_REG,
            data, 2, 50);
        furi_hal_i2c_release(&furi_hal_i2c_handle_external);

        int16_t initial_hw = ok ? (int16_t)((data[0] << 8) | data[1]) : 0;
        initial_norm = (int32_t)initial_hw * NORM_FACTOR[ADS_PGA_DEFAULT];
    }
    uint32_t alloc_tick = furi_get_tick();
    for(int i = 0; i < SENSOR_BUFFER_SIZE; i++) {
        gsr->buffer[i] = initial_norm;
        gsr->sample_tick[i] = alloc_tick;
    }
    gsr->write_idx = 0;

    gsr->mutex = furi_mutex_alloc(FuriMutexTypeNormal);
    furi_check(gsr->mutex, "GsrSensor: mutex alloc failed");

    gsr->iter_count = 0;
    gsr->attempt_count = 0;
    gsr->duplicate_count = 0;
    gsr->stale_count = 0;
    gsr->duplicate_gap_running_min = UINT32_MAX;
    gsr->duplicate_gap_min_cached = UINT32_MAX;
    gsr->consecutive_failures = 0;
    gsr->hz_window_start_tick = furi_get_tick(); // set before the worker starts — no lock needed
    gsr->hz_window_start_count = 0;
    gsr->hz_window_start_attempts = 0;
    gsr->hz_window_start_duplicates = 0;
    gsr->hz_window_start_stale = 0;
    gsr->worker_hz_cached = 0.0f;
    gsr->success_rate_cached = 100.0f; // optimistic default until the first window rolls
    gsr->duplicate_rate_cached = 0.0f; // optimistic default until the first window rolls
    gsr->stale_rate_cached = 0.0f;     // optimistic default until the first window rolls
    gsr->pga_change_count = 0;
    gsr->hz_window_start_pga_changes = 0;
    gsr->pga_change_rate_cached = 0;
    gsr->tick_window_ptp = 0;
    gsr->tick_window_min_gap = 0;
    gsr->tick_mains_hum_mag = 0.0f;
    gsr->i2c_peak_ms = 0;

    gsr->rf_enabled = false;
    gsr->rf_spi_busy = false;
    gsr->rf_band = 0;
    gsr->rf_dwell_start_tick = furi_get_tick();
    gsr->rf_last_sample_tick = 0;
    for(int i = 0; i < EM_SCAN_NUM_FREQS; i++) {
        gsr->rf_dwell_peak[i] = -127.0f;
        gsr->rf_rssi_dbm[i] = -100.0f;
    }
    gsr->rf_rssi_peak_ms = 0;
    gsr->rf_retune_peak_ms = 0;
    gsr->rf_mutex = furi_mutex_alloc(FuriMutexTypeNormal);
    furi_check(gsr->rf_mutex, "GsrSensor: rf_mutex alloc failed");

    gsr->running = true;
    gsr->pga_changed = false;
    gsr->thread = furi_thread_alloc();
    furi_thread_set_name(gsr->thread, "GsrSensorWorker");
    furi_thread_set_stack_size(gsr->thread, 2048);
    furi_thread_set_context(gsr->thread, gsr);
    furi_thread_set_callback(gsr->thread, gsr_sensor_worker);
    furi_thread_start(gsr->thread);

    return gsr;
}

void gsr_sensor_free(GsrSensor* gsr) {
    furi_check(gsr, "GsrSensor: NULL in free()");
    if(gsr->available) {
        // Reuses gsr_sensor_set_rf_enabled()'s disable ordering (flip the
        // flag, wait for the worker to leave the SPI region, then the
        // hardware deinit) rather than duplicating it — this used to be
        // inlined here as `em_scan_rf_deinit(); gsr->rf_enabled = false;`,
        // which called into SPI hardware BEFORE telling the worker RF was
        // off, racing a concurrent in-flight get_rssi()/set_band() call.
        // See that function's doc comment for why the ordering matters.
        if(gsr->rf_enabled) {
            gsr_sensor_set_rf_enabled(gsr, false);
        }
        gsr->running = false;
        furi_thread_join(gsr->thread);
        furi_thread_free(gsr->thread);

        // Put ADS1115 into low-power single-shot/power-down mode (MODE bit = 1)
        furi_hal_i2c_acquire(&furi_hal_i2c_handle_external);
        uint8_t cfg[2] = {(uint8_t)(pga_msb(gsr->pga_index) | 0x01), 0xE3};
        furi_hal_i2c_write_mem(
            &furi_hal_i2c_handle_external,
            ADS1115_I2C_ADDR, ADS1115_CONFIG_REG,
            cfg, 2, 50);
        furi_hal_i2c_release(&furi_hal_i2c_handle_external);

        furi_mutex_free(gsr->mutex);
        furi_mutex_free(gsr->rf_mutex);
    }
    free(gsr);
}

// ─────────────────────────────────────────────────────────────────────────────
// Accessors
// ─────────────────────────────────────────────────────────────────────────────
bool gsr_sensor_available(const GsrSensor* gsr) {
    return gsr && gsr->i2c_working;
}

bool gsr_sensor_is_connected(const GsrSensor* gsr) {
    furi_check(gsr, "GsrSensor: NULL in is_connected()");
    if(!gsr->available) return false;
    furi_mutex_acquire(gsr->mutex, FuriWaitForever);
    bool connected = gsr->connected;
    furi_mutex_release(gsr->mutex);
    return connected;
}

float gsr_sensor_get_raw(const GsrSensor* gsr) {
    // Called every tick (10Hz) during recording — the highest-frequency
    // call site among the promoted checks in this file.
    furi_check(gsr, "GsrSensor: NULL in get_raw()");
    if(!gsr->available) return 0.0f;
    furi_mutex_acquire(gsr->mutex, FuriWaitForever);
    float val = gsr->raw;
    furi_mutex_release(gsr->mutex);
    return val;
}

// ── Single-sample raw → nS (no decimation, no autoranging, no calibration) ──
// Uses the normalized count snapshotted by tick() from the same buffer
// position as the ~100 ms window's most recent entry.  This guarantees
// the raw sample and the filtered mean use the exact same underlying data.
float gsr_sensor_get_raw_sample_ns(const GsrSensor* gsr) {
    furi_check(gsr, "GsrSensor: NULL in get_raw_sample_ns()");
    if(!gsr->available) return 0.0f;

    furi_mutex_acquire(gsr->mutex, FuriWaitForever);
    int32_t norm = gsr->tick_last_norm;
    furi_mutex_release(gsr->mutex);

    if(norm <= 0) return 0.0f;
    return tia_counts_to_ns((float)norm);
}

int32_t gsr_sensor_get_raw_sample_count(const GsrSensor* gsr) {
    furi_check(gsr, "GsrSensor: NULL in get_raw_sample_count()");
    if(!gsr->available) return 0;
    furi_mutex_acquire(gsr->mutex, FuriWaitForever);
    int32_t val = gsr->tick_last_norm;
    furi_mutex_release(gsr->mutex);
    return val;
}

int32_t gsr_sensor_get_mean_count(const GsrSensor* gsr) {
    furi_check(gsr, "GsrSensor: NULL in get_mean_count()");
    if(!gsr->available) return 0;
    // tick_mean_norm is written by tick() on the main thread but read here
    // from whatever thread calls this accessor (the GUI render thread, in
    // production) — genuinely cross-thread, so it needs gsr->mutex like
    // every other field below (2026-07-30 mutex audit fix).
    furi_mutex_acquire(gsr->mutex, FuriWaitForever);
    int32_t val = gsr->tick_mean_norm;
    furi_mutex_release(gsr->mutex);
    return val;
}

// How many ring-buffer entries landed inside the most recent tick()'s
// ~100 ms time window and were actually averaged into gsr_sensor_get_
// mean_count()'s result — the real-time counterpart to the rolling ~1 s
// gsr_sensor_get_worker_hz(): that one shows a trend, this shows exactly
// how many independent samples back the Mean value on screen right now.
// Always ≥ 1 (see the i==0-unconditional note in gsr_sensor_tick()).
int32_t gsr_sensor_get_window_samples(const GsrSensor* gsr) {
    furi_check(gsr, "GsrSensor: NULL in get_window_samples()");
    if(!gsr->available) return 0;
    // Cross-thread (GUI render thread reads what tick() writes on the main
    // thread) — see gsr_sensor_get_mean_count()'s comment.
    furi_mutex_acquire(gsr->mutex, FuriWaitForever);
    int32_t val = gsr->tick_window_samples;
    furi_mutex_release(gsr->mutex);
    return val;
}

uint8_t gsr_sensor_get_pga_index(const GsrSensor* gsr) {
    furi_check(gsr, "GsrSensor: NULL in get_pga_index()");
    if(!gsr->available) return ADS_PGA_DEFAULT;
    furi_mutex_acquire(gsr->mutex, FuriWaitForever);
    uint8_t val = gsr->pga_index;
    furi_mutex_release(gsr->mutex);
    return val;
}

// Measured worker throughput in Hz, over a rolling ~1 s window — the true
// rate at which gsr_sensor_tick()'s ~100 ms boxcar average is actually
// filling with samples. Updated by gsr_sensor_tick() (main thread only);
// reads 0.0f until the first ~1 s window has elapsed. See
// docs/gsr_filtering_analysis.md, Recommendation 1.
float gsr_sensor_get_worker_hz(const GsrSensor* gsr) {
    furi_check(gsr, "GsrSensor: NULL in get_worker_hz()");
    if(!gsr->available) return 0.0f;
    // Cross-thread — see gsr_sensor_get_mean_count()'s comment.
    furi_mutex_acquire(gsr->mutex, FuriWaitForever);
    float val = gsr->worker_hz_cached;
    furi_mutex_release(gsr->mutex);
    return val;
}

// Percentage of I2C read attempts that succeeded, over the same rolling
// ~1 s window as gsr_sensor_get_worker_hz(). Distinguishes "the worker
// loop genuinely only runs this fast" (success_rate near 100%) from "the
// loop runs faster but many reads silently fail" (success_rate well below
// 100% — a real transport/wiring problem, not a rate limit). Reads 100.0f
// until the first window has elapsed (optimistic default, not a claim).
float gsr_sensor_get_success_rate(const GsrSensor* gsr) {
    furi_check(gsr, "GsrSensor: NULL in get_success_rate()");
    if(!gsr->available) return 100.0f;
    // Cross-thread — see gsr_sensor_get_mean_count()'s comment.
    furi_mutex_acquire(gsr->mutex, FuriWaitForever);
    float val = gsr->success_rate_cached;
    furi_mutex_release(gsr->mutex);
    return val;
}

// Percentage of successful reads, over the same rolling ~1 s window as
// gsr_sensor_get_worker_hz(), whose raw ADC code exactly matched the
// immediately preceding successful read. NOTE: this can mean either a
// stale re-read of a conversion the ADS1115 hadn't yet updated, OR two
// genuinely fresh conversions of a signal that just hasn't moved between
// them — the counter can't tell those apart, and real hardware
// measurement (2026-07-23) shows the difference matters: ~12-16% with
// the sensor disconnected (near-DC, no real signal to vary) vs. ~7-11%
// with a live skin conductance signal connected. Both are well above the
// "should be near 0% below 860 SPS" figure this comment originally
// predicted — see docs/gsr_filtering_analysis.md and duplicate_count's
// doc comment for what's still unexplained. Resets across PGA changes (a
// gain change isn't a stale read). Reads 0.0f until the first window has
// elapsed (optimistic default, not a claim).
float gsr_sensor_get_duplicate_rate(const GsrSensor* gsr) {
    furi_check(gsr, "GsrSensor: NULL in get_duplicate_rate()");
    if(!gsr->available) return 0.0f;
    // Cross-thread — see gsr_sensor_get_mean_count()'s comment.
    furi_mutex_acquire(gsr->mutex, FuriWaitForever);
    float val = gsr->duplicate_rate_cached;
    furi_mutex_release(gsr->mutex);
    return val;
}

// Percentage of successful reads over the rolling ~1 s window whose
// inter-read gap was under 2 ticks (< 1.16 ms conversion period) and resulted
// in a stale re-read of the ADS1115 register.
float gsr_sensor_get_stale_rate(const GsrSensor* gsr) {
    furi_check(gsr, "GsrSensor: NULL in get_stale_rate()");
    if(!gsr->available) return 0.0f;
    // Cross-thread — see gsr_sensor_get_mean_count()'s comment.
    furi_mutex_acquire(gsr->mutex, FuriWaitForever);
    float val = gsr->stale_rate_cached;
    furi_mutex_release(gsr->mutex);
    return val;
}

uint32_t gsr_sensor_get_stack_space(const GsrSensor* gsr) {
    furi_check(gsr, "GsrSensor: NULL in get_stack_space()");
    if(!gsr->available) return 0;
    // furi_thread_get_stack_space() takes a FuriThreadId (the RTOS handle
    // from furi_thread_get_id()), not the FuriThread* wrapper itself — see
    // em_scan_rf_worker_get_stack_space()'s comment for the same fix.
    FuriThreadId id = furi_thread_get_id(gsr->thread);
    if(!id) return 0;
    return furi_thread_get_stack_space(id);
}

// Live count of consecutive failed I2C reads happening right now — not a
// rolling average like gsr_sensor_get_success_rate(), so it can show a
// fresh failure streak building in real time, before either the 1 s
// success-rate average visibly drops or the 50-failure disconnect
// threshold (gsr_sensor_worker()) actually fires. For diagnostics.
uint32_t gsr_sensor_get_consecutive_failures(const GsrSensor* gsr) {
    furi_check(gsr, "GsrSensor: NULL in get_consecutive_failures()");
    if(!gsr->available) return 0;
    furi_mutex_acquire(gsr->mutex, FuriWaitForever);
    uint32_t val = gsr->consecutive_failures;
    furi_mutex_release(gsr->mutex);
    return val;
}

// Peak-to-peak (max - min) of the raw normalized counts in the most
// recent tick()'s averaging window — a cheap, frequency-agnostic sense
// of instantaneous signal/noise range, independent of the mains-hum
// estimate below. For diagnostics.
int32_t gsr_sensor_get_window_ptp(const GsrSensor* gsr) {
    furi_check(gsr, "GsrSensor: NULL in get_window_ptp()");
    if(!gsr->available) return 0;
    // Cross-thread — see gsr_sensor_get_mean_count()'s comment.
    furi_mutex_acquire(gsr->mutex, FuriWaitForever);
    int32_t val = gsr->tick_window_ptp;
    furi_mutex_release(gsr->mutex);
    return val;
}

// Smallest gap (in RTOS ticks, ~1 ms each) between two consecutive
// samples' timestamps anywhere in the most recent tick()'s window —
// general loop-pacing regularity, not tied to any specific sample.
// CAUTION on interpreting the value: each timestamp is a floor() of the
// real time it was taken, so a recorded gap of N ticks corresponds to a
// true elapsed time anywhere from just over (N-1) ms to just under
// (N+1) ms — e.g. a reading of 2 is consistent with a true minimum
// anywhere from ~1.0 ms to ~3.0 ms, which straddles the ADS1115's
// ~1.16 ms conversion time and so doesn't cleanly confirm or rule out
// the "loop occasionally runs fast enough to re-read a stale conversion"
// theory on its own. Real hardware (2026-07-23) measured this at 2 ticks
// in the same window Dup showed 18% — see
// gsr_sensor_get_duplicate_gap_min_ticks() for the more direct version
// of this question, which correlates the gap specifically with samples
// that turned out to be duplicates rather than comparing two independent
// aggregate numbers. For diagnostics.
uint32_t gsr_sensor_get_window_min_gap_ticks(const GsrSensor* gsr) {
    furi_check(gsr, "GsrSensor: NULL in get_window_min_gap_ticks()");
    if(!gsr->available) return 0;
    // Cross-thread — see gsr_sensor_get_mean_count()'s comment.
    furi_mutex_acquire(gsr->mutex, FuriWaitForever);
    uint32_t val = gsr->tick_window_min_gap;
    furi_mutex_release(gsr->mutex);
    return val;
}

// Smallest inter-read tick gap seen SPECIFICALLY at a sample that turned
// out to be a duplicate (see gsr_sensor_get_duplicate_rate()), over the
// same rolling ~1 s window as gsr_sensor_get_worker_hz(). Unlike
// gsr_sensor_get_window_min_gap_ticks() (the general per-window minimum,
// which may not even be adjacent to a duplicate), this directly
// correlates timing with the specific reads that were actually stale —
// the real test of the "occasional sub-ADC-conversion-time loop period"
// theory, rather than eyeballing whether two independent aggregate
// numbers seem consistent. Same tick-flooring caveat applies (see that
// function's doc comment). Returns UINT32_MAX if no duplicates occurred
// in the most recent window (not 0 — a real value of 0 is itself
// meaningful and must stay distinguishable from "no data"), or if
// unavailable.  For diagnostics.
uint32_t gsr_sensor_get_duplicate_gap_min_ticks(const GsrSensor* gsr) {
    furi_check(gsr, "GsrSensor: NULL in get_duplicate_gap_min_ticks()");
    if(!gsr->available) return UINT32_MAX;
    // Cross-thread — see gsr_sensor_get_mean_count()'s comment.
    furi_mutex_acquire(gsr->mutex, FuriWaitForever);
    uint32_t val = gsr->duplicate_gap_min_cached;
    furi_mutex_release(gsr->mutex);
    return val;
}

// Recovered amplitude, at MAINS_HUM_TARGET_HZ (50 Hz), of the raw
// (pre-averaging) samples in the most recent tick()'s window —
// normalized-count units, comparable to gsr_sensor_get_mean_count() and
// gsr_sensor_get_window_ptp(). Answers "how much real 50 Hz content is
// actually present in the raw signal", which is what the boxcar's
// mains-notch defends against; the notch's rejection itself isn't
// independently measurable here (it's a guaranteed property of the
// window's duration, not something to check post-averaging — 50 Hz
// aliases to exactly 0 Hz once decimated to the 10 Hz tick rate, so
// there's nothing meaningful to measure on the output side).
//
// Deliberately NOT a Goertzel filter — an earlier version was, using
// each sample's real timestamp only to pick a fixed coefficient assuming
// uniform spacing at the ~1 s rolling worker_hz. Real hardware
// (2026-07-23) measured that version reporting 103 counts of "50 Hz
// content" against a window whose total peak-to-peak was only 40 counts
// — physically impossible, since no single frequency component can
// exceed roughly half the signal's total peak-to-peak. Goertzel's
// recurrence has two poles exactly on the unit circle (marginally
// stable) and assumes uniform sample spacing; real sample timing is
// measurably uneven (get_window_min_gap_ticks()), and that combination
// inflates the reported energy. This version instead correlates directly
// against each sample's actual recorded timestamp — no resonant poles,
// no uniform-spacing assumption, correct for however unevenly the real
// samples are spaced. Meaningful from the very first tick (no longer
// needs worker_hz_cached to exist first). Reads 0.0f if unavailable OR if
// gsr_sensor_set_mains_hum_enabled() hasn't turned this on (off by
// default — see that function's doc comment for why: this is the one
// per-tick diagnostic expensive enough to be worth gating).
// For diagnostics.
float gsr_sensor_get_mains_hum_mag(const GsrSensor* gsr) {
    furi_check(gsr, "GsrSensor: NULL in get_mains_hum_mag()");
    if(!gsr->available) return 0.0f;
    // Cross-thread — see gsr_sensor_get_mean_count()'s comment.
    furi_mutex_acquire(gsr->mutex, FuriWaitForever);
    float val = gsr->tick_mains_hum_mag;
    furi_mutex_release(gsr->mutex);
    return val;
}

// Number of PGA (autorange) changes applied in the most recent rolling
// ~1 s window — same cadence as gsr_sensor_get_worker_hz(). Only counts
// changes tick()'s own autoranging logic applies (Step 5 in
// gsr_sensor_tick()), not manual gsr_sensor_lock_pga() calls, so this is
// specifically a signal for "the input is sitting near an autorange
// threshold and flapping between ranges" rather than counting deliberate
// diagnostic overrides. For diagnostics.
uint32_t gsr_sensor_get_pga_change_count(const GsrSensor* gsr) {
    furi_check(gsr, "GsrSensor: NULL in get_pga_change_count()");
    if(!gsr->available) return 0;
    // Cross-thread — see gsr_sensor_get_mean_count()'s comment.
    furi_mutex_acquire(gsr->mutex, FuriWaitForever);
    uint32_t val = gsr->pga_change_rate_cached;
    furi_mutex_release(gsr->mutex);
    return val;
}

// Worst single I2C call duration (config write OR conversion read, real
// furi_get_tick() delta) ever observed on the worker thread — lifetime
// max, never reset. See i2c_peak_ms's struct comment for why one column
// covers both call sites. For diagnostics.
uint32_t gsr_sensor_get_i2c_peak_ms(const GsrSensor* gsr) {
    furi_check(gsr, "GsrSensor: NULL in get_i2c_peak_ms()");
    if(!gsr->available) return 0;
    furi_mutex_acquire(gsr->mutex, FuriWaitForever);
    uint32_t val = gsr->i2c_peak_ms;
    furi_mutex_release(gsr->mutex);
    return val;
}

// Worst single furi_hal_subghz_get_rssi() call duration ever observed —
// lifetime max, never reset. Guarded by rf_mutex, NOT gsr->mutex — same
// separation reasoning as rf_rssi_dbm[] (see the struct's doc comment):
// keeping this under the RF-dedicated lock means updating it can never
// contend with the ADC path. For diagnostics.
uint32_t gsr_sensor_get_rf_rssi_peak_ms(const GsrSensor* gsr) {
    furi_check(gsr, "GsrSensor: NULL in get_rf_rssi_peak_ms()");
    if(!gsr->available) return 0;
    furi_mutex_acquire(gsr->rf_mutex, FuriWaitForever);
    uint32_t val = gsr->rf_rssi_peak_ms;
    furi_mutex_release(gsr->rf_mutex);
    return val;
}

// Worst single em_scan_rf_set_band() (band retune) call duration ever
// observed — lifetime max, never reset. Guarded by rf_mutex — see
// gsr_sensor_get_rf_rssi_peak_ms()'s comment. For diagnostics.
uint32_t gsr_sensor_get_rf_retune_peak_ms(const GsrSensor* gsr) {
    furi_check(gsr, "GsrSensor: NULL in get_rf_retune_peak_ms()");
    if(!gsr->available) return 0;
    furi_mutex_acquire(gsr->rf_mutex, FuriWaitForever);
    uint32_t val = gsr->rf_retune_peak_ms;
    furi_mutex_release(gsr->rf_mutex);
    return val;
}

// ─────────────────────────────────────────────────────────────────────────────
// Oversampling & Filtering
//
// Each ~10 Hz tick walks the ring buffer backward from the most recent
// entry, accumulating samples whose timestamp falls within the last
// BOXCAR_WINDOW_MS (100 ms) of real elapsed time, and averages exactly
// those. Time-based, not a fixed sample count — see
// docs/gsr_filtering_analysis.md, Recommendation 1b. A fixed N=100 was
// only actually a 100 ms window when the worker's true rate happened to
// be ~1000 Hz; measurement on real hardware found it was actually
// ~500 Hz, silently doubling the window to ~200 ms and (worse) making
// consecutive ticks' windows overlap by half instead of being
// independent samples. This version gets the right window duration
// regardless of whatever the worker's true rate turns out to be, on any
// device, without needing to measure or hand-tune against it.
//
// The background worker's nominal pacing is furi_delay_ms(1), measured on
// real hardware at ~500 Hz true rate (see the pacing comment in
// gsr_sensor_worker() for why it's not exactly 1 kHz, and why that's left
// as-is) — below the ADS1115's 860 SPS conversion rate, so buffer entries
// are each (almost always) a distinct conversion rather than a duplicate
// of the previous one; the loop just never reads roughly 42% of the
// conversions the ADC produces in between. That's fine here: every
// sample that does land in the window is real, independent data, so the
// √samples noise-reduction estimate below isn't inflated by re-counted
// duplicates the way it would be if the worker ran faster than 860 Hz.
//
// A correctly-sized 100 ms window nominally nulls 50/60 Hz mains hum
// (5 × 20 ms, 6 × 16.67 ms) regardless of how many samples happen to fill
// it — that property depends on window duration, not sample count.
// ─────────────────────────────────────────────────────────────────────────────

void gsr_sensor_tick(GsrSensor* gsr) {
    // Called every tick (10Hz) from the main thread during recording — the
    // single highest-frequency call site in this file.
    furi_check(gsr, "GsrSensor: NULL in tick()");
    if(!gsr->available) return;

    // ── Roll the worker-Hz measurement window (~1 s) ────────────────────
    // Deliberately independent of the i2c_ok early-return below — if the
    // sensor is disconnected, the rate should visibly drop toward zero on
    // the Diagnostics screen rather than freezing at its last good value.
    uint32_t now = furi_get_tick();
    uint32_t one_second_ticks = furi_kernel_get_tick_frequency();
    if(now - gsr->hz_window_start_tick >= one_second_ticks) {
        furi_mutex_acquire(gsr->mutex, FuriWaitForever);
        uint32_t count = gsr->iter_count;
        uint32_t attempts = gsr->attempt_count;
        uint32_t duplicates = gsr->duplicate_count;
        uint32_t stale = gsr->stale_count;
        // Read-and-reset must happen in the same critical section — a
        // separate read then a separate reset would race against the
        // worker updating it in between, potentially discarding a
        // just-recorded minimum that belonged to THIS window.
        uint32_t dup_gap_min = gsr->duplicate_gap_running_min;
        gsr->duplicate_gap_running_min = UINT32_MAX;
        furi_mutex_release(gsr->mutex);

        uint32_t window_ticks = now - gsr->hz_window_start_tick;
        uint32_t delta = count - gsr->hz_window_start_count;
        uint32_t delta_attempts = attempts - gsr->hz_window_start_attempts;
        uint32_t delta_duplicates = duplicates - gsr->hz_window_start_duplicates;
        uint32_t delta_stale = stale - gsr->hz_window_start_stale;
        float worker_hz = (float)delta * (float)one_second_ticks / (float)window_ticks;
        float success_rate =
            (delta_attempts > 0) ? (100.0f * (float)delta / (float)delta_attempts) : 100.0f;
        float duplicate_rate =
            (delta > 0) ? (100.0f * (float)delta_duplicates / (float)delta) : 0.0f;
        float stale_rate =
            (delta > 0) ? (100.0f * (float)delta_stale / (float)delta) : 0.0f;

        // Published under gsr->mutex — these *_cached fields are read
        // cross-thread by the Diagnostics screen's accessors
        // (gsr_sensor_get_worker_hz() etc.), from the GUI render thread,
        // not "the same thread as tick()" as earlier comments here
        // claimed. That assumption was never actually true in this app
        // (biomap_render.c is their only caller) — found during the
        // 2026-07-30 mutex audit. hz_window_start_* stay outside the lock:
        // tick()-only, never read by any accessor.
        furi_mutex_acquire(gsr->mutex, FuriWaitForever);
        gsr->worker_hz_cached = worker_hz;
        gsr->success_rate_cached = success_rate;
        gsr->duplicate_rate_cached = duplicate_rate;
        gsr->stale_rate_cached = stale_rate;
        gsr->duplicate_gap_min_cached = dup_gap_min; // UINT32_MAX = no duplicates this window
        gsr->pga_change_rate_cached = gsr->pga_change_count - gsr->hz_window_start_pga_changes;
        furi_mutex_release(gsr->mutex);

        gsr->hz_window_start_tick = now;
        gsr->hz_window_start_count = count;
        gsr->hz_window_start_attempts = attempts;
        gsr->hz_window_start_duplicates = duplicates;
        gsr->hz_window_start_stale = stale;
        gsr->hz_window_start_pga_changes = gsr->pga_change_count;
    }

    furi_mutex_acquire(gsr->mutex, FuriWaitForever);
    bool i2c_ok = gsr->i2c_working;
    furi_mutex_release(gsr->mutex);

    if(!i2c_ok) return;

    // ── Step 1: sum every buffer entry timestamped within the last
    // BOXCAR_WINDOW_MS of real time, walking backward from the most
    // recent write. No intermediate array — the simple mean doesn't need
    // sorting, so one pass is enough. Also snapshot the single
    // most-recent count for get_raw_sample_ns().
    //
    // The i==0 iteration is unconditional (always included, regardless of
    // its age) so `samples` can never be 0 — guarantees no divide-by-zero
    // below even in the degenerate case where somehow nothing in the
    // buffer falls inside the window (shouldn't happen once alloc()'s
    // warm-up fill has aged out, since the worker writes far faster than
    // once per BOXCAR_WINDOW_MS, but the loop shouldn't crash if it does).
    // Capped at SENSOR_BUFFER_SIZE iterations so a pathological timestamp
    // can't spin forever — at the ADS1115's 860 SPS ceiling, a 100 ms
    // window holds at most ~86 samples, well under the buffer's 128.
    // Same pass also tracks (a) peak-to-peak of the window's raw counts —
    // a cheap, frequency-agnostic noise/signal-range indicator — (b) the
    // smallest gap between consecutive samples' timestamps, which is
    // direct evidence for or against the "furi_delay_ms(1) occasionally
    // produces a sub-ADC-conversion-time loop period" theory for the
    // measured (2026-07-23) 7-11% duplicate rate: a gap that reaches 0
    // ticks means two samples landed in the same millisecond, something
    // a cleanly-paced ~2 ms loop shouldn't produce — and (c) a direct,
    // per-sample-timestamp correlation against MAINS_HUM_TARGET_HZ (see
    // gsr_sensor_get_mains_hum_mag()). This is NOT a Goertzel filter — an
    // earlier version was, using each sample's ACTUAL timestamp only to
    // pick a fixed coefficient assuming uniform spacing at the ~1 s
    // rolling worker_hz. On real hardware (2026-07-23) that produced a
    // measured 50 Hz "magnitude" of 103 counts against a window whose
    // total peak-to-peak was only 40 counts — physically impossible (no
    // single frequency component can exceed roughly half the signal's
    // total peak-to-peak). Root cause: Goertzel's recurrence has two
    // poles exactly on the unit circle — a marginally-stable resonant
    // filter — and assumes uniform sample spacing; real sample timing is
    // measurably uneven (see get_window_min_gap_ticks()), and feeding
    // that into a uniform-spacing-assuming resonant recurrence produces
    // inflated, unreliable energy at the target bin. Using each sample's
    // real timestamp (already available in sample_tick[]) directly in
    // the correlation instead of an assumed fixed rate has no such
    // resonance to misbehave, and is naturally correct for however
    // unevenly the real samples are actually spaced.
    furi_mutex_acquire(gsr->mutex, FuriWaitForever);
    bool mains_hum_on = gsr->mains_hum_enabled;
    uint32_t r_idx = gsr->write_idx;
    uint32_t now_tick = furi_get_tick();
    uint32_t window_ticks = (BOXCAR_WINDOW_MS * furi_kernel_get_tick_frequency()) / 1000;
    int64_t sum = 0;
    int samples = 0;
    int32_t win_min = 0, win_max = 0;
    uint32_t min_gap_ticks = UINT32_MAX;
    uint32_t prev_sample_tick = 0;
    float tick_freq = (float)furi_kernel_get_tick_frequency();
    float sum_cos = 0.0f, sum_sin = 0.0f;
    float sum_c = 0.0f, sum_s = 0.0f;
    for(int i = 0; i < SENSOR_BUFFER_SIZE; i++) {
        r_idx = (r_idx - 1) & (SENSOR_BUFFER_SIZE - 1);
        if(i > 0 && (now_tick - gsr->sample_tick[r_idx] > window_ticks)) break;
        int32_t v = gsr->buffer[r_idx];
        sum += v;
        if(i == 0) {
            gsr->tick_last_norm = v;  // snapshot for raw-sample compare
            win_min = v;
            win_max = v;
        } else {
            if(v < win_min) win_min = v;
            if(v > win_max) win_max = v;
            uint32_t gap = prev_sample_tick - gsr->sample_tick[r_idx];
            if(gap < min_gap_ticks) min_gap_ticks = gap;
        }
        prev_sample_tick = gsr->sample_tick[r_idx];

        // Correlate against this sample's REAL elapsed time (not an
        // assumed uniform rate) — sign convention doesn't matter, only
        // magnitude is used below. Skipped (2 trig calls/sample —
        // see gsr_sensor_set_mains_hum_enabled()) unless something has
        // actually asked for this diagnostic.
        if(mains_hum_on) {
            float t_sec = (float)(now_tick - gsr->sample_tick[r_idx]) / tick_freq;
            float angle = 2.0f * GSR_PI * MAINS_HUM_TARGET_HZ * t_sec;
            float c_val = cosf(angle);
            float s_val = sinf(angle);
            sum_cos += (float)v * c_val;
            sum_sin += (float)v * s_val;
            sum_c += c_val;
            sum_s += s_val;
        }

        samples++;
    }
    uint8_t old_pga = gsr->pga_index;
    int8_t  locked   = gsr->pga_locked;
    bool active = gsr->cal_active;
    float gain = gsr->cal_gain;
    float offset = gsr->cal_offset;
    furi_mutex_release(gsr->mutex);

    // ── Step 2: simple mean over however many samples landed in the
    // window (typically ~40-50, since the worker's measured real-world
    // rate varies ~400-500 Hz rather than sitting at one fixed value;
    // was silently ~100 at the ~1000 Hz design assumption). Noise
    // reduction scales with √samples, so this is a real, if modest,
    // trade against the original documented ~8.7× — and it now varies
    // tick to tick along with however many samples actually land in the
    // window — see docs/gsr_filtering_analysis.md for the actual
    // numbers.
    float avg_norm = (float)sum / (float)samples;

    float mains_hum_mag;
    if(mains_hum_on && samples > 0) {
        // Standard real-sinusoid amplitude recovery from a cosine/sine
        // correlation: subtract DC mean leakage (avg_norm * sum_c / sum_s)
        // so we operate purely on the AC signal centered around the mean.
        float sum_cos_c = sum_cos - avg_norm * sum_c;
        float sum_sin_c = sum_sin - avg_norm * sum_s;
        mains_hum_mag =
            2.0f * sqrtf(sum_cos_c * sum_cos_c + sum_sin_c * sum_sin_c) / (float)samples;
    } else {
        mains_hum_mag = 0.0f; // not computed this tick — see the setter's doc comment
    }

    // Published under gsr->mutex — these tick_* fields are read
    // cross-thread by the Diagnostics screen's accessors, from the GUI
    // render thread, not "the same thread as tick()" as earlier comments
    // here claimed (found during the 2026-07-30 mutex audit; see the
    // hz-window block above for the same fix and the same reasoning).
    furi_mutex_acquire(gsr->mutex, FuriWaitForever);
    gsr->tick_window_ptp = win_max - win_min;
    gsr->tick_window_min_gap = (samples > 1) ? min_gap_ticks : 0;
    gsr->tick_mean_norm = (int32_t)avg_norm;  // snapshot for diagnostics
    gsr->tick_window_samples = samples;       // snapshot for diagnostics
    gsr->tick_mains_hum_mag = mains_hum_mag;
    furi_mutex_release(gsr->mutex);

    // ── Step 3: autoranging decision on the RAW (uncalibrated) value.
    // Calibration is applied in the nS domain after TIA conversion —
    // applying it here would skew the PGA switching thresholds.
    // When pga_locked >= 0, autoranging is suppressed — PGA stays fixed.
    uint8_t new_pga = old_pga;
    if(locked < 0) {
        int32_t hw_equiv = (int32_t)(avg_norm / (float)NORM_FACTOR[old_pga]);
        int32_t abs_hw_equiv = (hw_equiv < 0) ? -hw_equiv : hw_equiv;

        if(abs_hw_equiv >= ADS_SATURATE_THRESH && new_pga > ADS_PGA_MIN) {
            new_pga--;
            gsr->low_count = 0;
        } else if(abs_hw_equiv < ADS_LOW_THRESH && new_pga < ADS_PGA_MAX) {
            if(++gsr->low_count >= ADS_LOW_COUNT_TICKS) {
                new_pga++;
                gsr->low_count = 0;
            }
        } else {
            gsr->low_count = 0;
        }
    } else if((uint8_t)locked != old_pga) {
        new_pga = (uint8_t)locked;
    }

    bool pga_update = false;
    if(new_pga != old_pga) {
        pga_update = true;
    }

    // ── Step 4: TIA conversion — raw normalized counts → nanosiemens.
    // Calibration (if active) is applied AFTER the TIA, in the nS domain
    // where gain and offset were computed.
    float raw_ns;
    raw_ns = tia_counts_to_ns(avg_norm);
    if(active) {
        raw_ns = gain * raw_ns + offset;
    }

    // ── Step 5: publish pga_index, pga_changed, and calibrated raw under
    // a single mutex acquisition to minimise contention with the worker.
    furi_mutex_acquire(gsr->mutex, FuriWaitForever);
    if(pga_update) {
        FURI_LOG_I("GsrSensor", "PGA %u→%u (±%s)",
            (unsigned)old_pga, (unsigned)new_pga, PGA_LABEL[new_pga]);
        gsr->pga_index = new_pga;
        gsr->pga_changed = true;
        gsr->pga_change_count++; // tick()-only field, safe to touch under this mutex acquisition
    }
    gsr->raw = raw_ns;

    // ── Finger-cuff disconnect detection (20-tick debounce).
    if(gsr->raw < GSR_VALID_MIN_NS || gsr->raw > GSR_VALID_MAX_NS) {
        if(++gsr->zero_count >= 20) {
            gsr->connected = false;
        }
    } else {
        gsr->zero_count = 0;
        gsr->connected = true;
    }
    furi_mutex_release(gsr->mutex);
}

void gsr_sensor_set_calibration(GsrSensor* gsr, bool active, float gain, float offset) {
    furi_check(gsr, "GsrSensor: NULL in set_calibration()");
    if(!gsr->available) return;
    furi_mutex_acquire(gsr->mutex, FuriWaitForever);
    gsr->cal_active = active;
    gsr->cal_gain = gain;
    gsr->cal_offset = offset;
    furi_mutex_release(gsr->mutex);
}

// Enables/disables the mains-hum correlator computed in gsr_sensor_tick()
// (see gsr_sensor_get_mains_hum_mag()) — off by default. It's the only
// per-tick diagnostic that costs meaningfully more than a comparison or
// two (2 trig calls per sample in the window, ~100/tick), so callers
// that don't display it (i.e. every mode except Diagnostics) shouldn't
// pay for it. When disabled, gsr_sensor_get_mains_hum_mag() reads 0.0f
// rather than a stale last-computed value.
void gsr_sensor_set_mains_hum_enabled(GsrSensor* gsr, bool enabled) {
    furi_check(gsr, "GsrSensor: NULL in set_mains_hum_enabled()");
    if(!gsr->available) return;
    furi_mutex_acquire(gsr->mutex, FuriWaitForever);
    gsr->mains_hum_enabled = enabled;
    furi_mutex_release(gsr->mutex);
}

void gsr_sensor_lock_pga(GsrSensor* gsr, int8_t index) {
    furi_check(gsr, "GsrSensor: NULL in lock_pga()");
    if(!gsr->available) return;
    furi_mutex_acquire(gsr->mutex, FuriWaitForever);
    if(index < 0) {
        gsr->pga_locked = -1;
        FURI_LOG_I("GsrSensor", "PGA lock released — autoranging resumed");
    } else {
        if(index > ADS_PGA_MAX) index = ADS_PGA_MAX;
        gsr->pga_locked = (int8_t)index;
        gsr->pga_index = (uint8_t)index;
        gsr->pga_changed = true;  // force worker to apply new PGA
        FURI_LOG_I("GsrSensor", "PGA locked at %d (±%s)", (int)index, PGA_LABEL[index]);
    }
    furi_mutex_release(gsr->mutex);
}

// Enable/disable ordering matters — the worker thread and this function
// both touch the same CC1101 over SPI, and SPI transactions can't overlap
// between threads.
//
// Enable: all hardware init + state reset happens BEFORE rf_enabled flips
// true, so the worker never observes "RF is on" until setup is actually
// done — no window where it could race this function's own SPI calls.
//
// Disable: rf_enabled flips false FIRST (the worker stops entering its RF
// section on its very next loop check, ~1-2 ms away at the ADC's pace),
// THEN this polls rf_spi_busy — true for exactly the span of the worker's
// SPI calls (RSSI read + possible retune) — before calling the hardware
// deinit. That closes the race outright for every normal disable: deinit
// only proceeds once the worker has demonstrably left the SPI region,
// rather than after a fixed delay chosen to probably be long enough
// (replaces a plain furi_delay_ms(5) used here until 2026-07-30 review).
// The bounded timeout below is a fallback for the one case no timeout
// can fix — the worker wedged forever in the documented unbounded SPI
// busy-wait bug (em_scan_rf_crash_investigation.md) — where we proceed
// anyway rather than hang the caller forever waiting for an ack that will
// never come; that residual case was already unguarded before this
// function existed at all, so this is strictly a narrowing, not a
// regression. RF's ~10 Hz duty cycle (RF_SAMPLE_INTERVAL_MS) already
// makes the race rare; this makes the ordinary case provably closed
// instead of just probably closed.
#define RF_DISABLE_SPI_WAIT_TIMEOUT_MS 20
#define RF_DISABLE_SPI_WAIT_POLL_MS     1

// Reset the published RF snapshot to the disabled-default floor — shared by
// both the enable path (fresh start, no stale reading from a prior session)
// and the disable path (don't leave the last live reading visible once RF
// is off) below.
static void rf_reset_snapshot(GsrSensor* gsr) {
    furi_mutex_acquire(gsr->rf_mutex, FuriWaitForever);
    for(int i = 0; i < EM_SCAN_NUM_FREQS; i++) {
        gsr->rf_rssi_dbm[i] = -100.0f;
    }
    furi_mutex_release(gsr->rf_mutex);
}

void gsr_sensor_set_rf_enabled(GsrSensor* gsr, bool enabled) {
    furi_check(gsr, "GsrSensor: NULL in set_rf_enabled()");
    if(!gsr->available) return;
    if(gsr->rf_enabled == enabled) return;

    if(enabled) {
        em_scan_rf_init();
        gsr->rf_band = 0;
        gsr->rf_dwell_start_tick = furi_get_tick();
        gsr->rf_last_sample_tick = 0; // force an immediate first sample
        for(int i = 0; i < EM_SCAN_NUM_FREQS; i++) {
            gsr->rf_dwell_peak[i] = -127.0f;
        }
        rf_reset_snapshot(gsr);
        gsr->rf_enabled = true; // last — see doc comment above
    } else {
        gsr->rf_enabled = false; // first — see doc comment above

        // Rendezvous on rf_mutex before polling rf_spi_busy: forces this
        // thread's view of rf_spi_busy to reflect whichever of the
        // worker's decide-and-mark critical sections (see the worker
        // loop's doc comment) most recently ran, closing the TOCTOU gap
        // a plain flag read here would otherwise have. Cheap — this
        // critical section is never held across a hardware call, so
        // there's nothing to wait long for.
        furi_mutex_acquire(gsr->rf_mutex, FuriWaitForever);
        furi_mutex_release(gsr->rf_mutex);

        // Wait for the worker to demonstrably leave the SPI region before
        // touching the radio from this thread — see doc comment above.
        // Measured against real elapsed ticks (furi_get_tick()), not a
        // count of nominal furi_delay_ms() calls — this file has already
        // learned that lesson twice, the hard way, on real hardware (see
        // RF_DWELL_MS's and em_scan_rf.c's EM_SCAN_PARK_POLL_MS's doc
        // comments): furi_delay_ms(N) is not guaranteed to take exactly
        // N ms, so counting calls silently drifts from the real bound.
        // furi_delay_ms() here is purely to yield the CPU between checks,
        // not to pace the timeout.
        uint32_t start_tick = furi_get_tick();
        uint32_t timeout_ticks =
            (RF_DISABLE_SPI_WAIT_TIMEOUT_MS * furi_kernel_get_tick_frequency()) / 1000;
        while(gsr->rf_spi_busy && (furi_get_tick() - start_tick) < timeout_ticks) {
            furi_delay_ms(RF_DISABLE_SPI_WAIT_POLL_MS);
        }
        em_scan_rf_deinit();

        // Matches what enable resets it to above; previously left at
        // whatever RF last measured, which get_rf_snapshot() would then
        // report as if it were live. Nothing reads it after a real
        // session's teardown today, but "clean" shouldn't depend on that
        // staying true.
        rf_reset_snapshot(gsr);
    }
}

void gsr_sensor_get_rf_snapshot(const GsrSensor* gsr, float* out_rssi_dbm) {
    furi_check(gsr, "GsrSensor: NULL in get_rf_snapshot()");
    if(!gsr->available) return;
    furi_check(out_rssi_dbm, "GsrSensor: NULL out_rssi_dbm");
    furi_mutex_acquire(gsr->rf_mutex, FuriWaitForever);
    memcpy(out_rssi_dbm, gsr->rf_rssi_dbm, sizeof(gsr->rf_rssi_dbm));
    furi_mutex_release(gsr->rf_mutex);
}

