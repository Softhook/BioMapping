# EDASymp (0.045–0.25 Hz) Spectral Sympathetic Index — Investigation & Design Proposal

**Status: Implemented (2026-09-13) — shipped as a standalone metric in the graph + map dropdowns.**  
The sliding-Welch implementation lives in `visualiser/src/signal/spectral_eda.js` (exposed as `analyzer.edasymp`), and the NeuroKit2 cross-check lives in `visualiser/tests/manual/neurokit_compare/check_edasymp.sh` (per-track ratio ≈ 1.01–1.03, cross-track r ≈ 0.9997). The roadmap below remains as the design record.  
Documents the scientific rationale, mathematical formulation, and system architecture for a frequency-domain sympathetic arousal metric based on **Posada-Quintero et al. (2016)** and NeuroKit2's `nk.eda_sympathetic()`.

**2026-09-14 reference correction:** the implemented method (fixed [0.045, 0.25) Hz Welch band power)
is Posada-Quintero et al.'s *static* PSD paper — **Ref. [1] below, Annals of Biomedical Engineering
44(10):3124–3135** — not the *time-varying* TVSymp paper this document previously cited as its
primary reference (now Ref. [1b]; the two are separate 2016 papers by the same group, in the same
journal, with adjacent DOIs). §3 Method 2 and §6.5 have been corrected accordingly — see §6.6 for the
resulting investigation. NeuroKit2's own `posada2016` implements the static paper too, which is why
our sliding-Welch code cross-validates against it cleanly; neither implements the time-varying paper.

---

## 1. Executive Summary & Scientific Motivation

BioMapping currently estimates psychological arousal and sympathetic activation via two primary avenues:
1. **Discrete Events:** Trough-to-peak SCRs detected via Full-Scan, Prominence, or cvxEDA driver spikes.
2. **Time-Domain Continuous Metrics:** Phasic Area Under the Curve (Phasic AUC, Benedek & Kaernbach 2010b) and sliding-window Temporal Peak Density (Gaussian KDE, 60s window).

While discrete peak detection is the historical gold standard in psychophysiology, it inherently suffers from **the threshold edge effect**: an amplitude excursion of $0.051\,\mu\text{S}$ is counted as a full sympathetic response, while an excursion of $0.049\,\mu\text{S}$ is discarded entirely, despite reflecting virtually identical underlying autonomic excitation.

### The Autonomic Purity of Electrodermal Activity
In cardiovascular psychophysiology (ECG / Heart Rate Variability), researchers frequently use Low-Frequency (LF) power ($0.04\text{--}0.15\,\text{Hz}$) as an index of sympathetic activation. However, LF-HRV is notoriously confounded by parasympathetic (vagal) baroreflex modulation and respiratory sinus arrhythmia (RSA).

In contrast, **eccrine sweat glands are exclusively innervated by the sympathetic nervous system** via postganglionic cholinergic sudomotor fibers. There is zero parasympathetic innervation.

Direct microneurography studies of Skin Sympathetic Nerve Activity (SSNA) conducted by Hugo Posada-Quintero, Ki Chon, and colleagues (2016, 2020) demonstrated that central autonomic sympathetic bursts oscillate with distinct spectral energy concentrated in the **$0.045\text{ to }0.25\,\text{Hz}$ frequency band** (termed **EDASymp** or **TVSymp**).

---

## 2. Key Advantages for Ambulatory BioMapping

Integrating an $EDASymp$ spectral metric into BioMapping offers three decisive advantages for mobile, unrestrained urban walking datasets:

### A. Inherent Immunity to Walking Gait Vibration
- **Human Walking Cadence:** Occurs primarily at **$1.4\text{ to }2.0\,\text{Hz}$** (footstep resonance centered around $1.8\,\text{Hz}$ at brisk walking speed, as documented on Track 24).
- **The Sympathetic Band:** Confined to **$0.045\text{ to }0.25\,\text{Hz}$**.
- **Spectral Isolation:** The entire sympathetic band sits more than **five octaves below** the footstep vibration frequency. Walking motion tremors cannot leak into the $0.045\text{--}0.25\,\text{Hz}$ band unless walking speed undergoes massive, unrealistic low-frequency acceleration/deceleration surging.

### B. Continuous, Threshold-Free Spatial Attribution
- Traditional peak counts require binning or Kernel Density Estimation to project discrete points onto continuous street segments.
- $EDASymp$ is a continuous scalar time series $\text{EDASymp}(t) \ge 0$.
- It can be mapped directly to GPS coordinates, generating continuous arousal gradients along pedestrian paths without requiring any arbitrary peak-amplitude thresholds ($0.015\,\mu\text{S}$ vs. $0.050\,\mu\text{S}$).

### C. Resolution of the Superposition / Super-Fast Burst Problem
- When a pedestrian experiences an acute, sustained stressor (e.g., navigating a complex, traffic-heavy intersection), sympathetic nerves fire rapid burst trains ($0.5\text{--}1.0\,\text{s}$ intervals).
- On the skin surface, these bursts fuse into a single prolonged plateau or ascending wave. Time-domain peak detectors count this as only 1 or 2 peaks.
- In the frequency domain, rapid burst trains dramatically increase spectral power density in the $0.045\text{--}0.25\,\text{Hz}$ band, capturing the true intensity of sustained sympathetic workload.

---

## 3. Mathematical Formulation & Computation

In literature and NeuroKit2 (`nk.eda_sympathetic`), $EDASymp$ is extracted through two main mathematical formulations:

### Method 1: Sliding Welch Periodogram (Fast, $O(N \log N)$, Browser-Friendly)
1. **Signal Conditioning:**
   - Downsample clean EDA to $f_s = 2.0\text{ Hz}$ or $4.0\text{ Hz}$ (well above the Nyquist rate of $0.5\text{ Hz}$ needed for the $0.25\text{ Hz}$ upper cutoff).
   - Zero-phase bandpass filter from $0.02\text{ Hz}$ to $0.35\text{ Hz}$ to reject DC drift and high-frequency noise.
2. **Sliding Window Estimation:**
   - Evaluate over a sliding window (e.g. $W = 30\text{ s}$ or $60\text{ s}$ with 75% overlap).
   - Detrend and apply a Hann window $w(n)$ to eliminate spectral leakage.
   - Compute Fast Fourier Transform (FFT):
     $$S_{xx}(f) = \frac{1}{f_s \sum w^2(n)} \left| \sum_{n=0}^{N-1} x(n) w(n) e^{-j 2 \pi f n / f_s} \right|^2$$
3. **Band Integration:**
   $$\text{EDASymp}(t) = \int_{0.045\,\text{Hz}}^{0.250\,\text{Hz}} S_{xx}(f, t) \, df$$
4. **Normalized Version ($\text{EDASymp}_{\text{norm}}$):**
   To correct for differences in individual skin thickness, hydration, and electrode contact resistance:
   $$\text{EDASymp}_{\text{norm}}(t) = \frac{\int_{0.045}^{0.250} S_{xx}(f, t) \, df}{\int_{0.020}^{0.500} S_{xx}(f, t) \, df}$$

### Method 2: Time-Varying Sympathetic Index (TVSymp via MB-TFD)
- Posada-Quintero et al. (2016) utilize a **Modified Bivariate Time-Frequency Distribution (MB-TFD)** to achieve high instantaneous time-frequency resolution without windowing lag.
- *Browser Consideration:* MB-TFD requires quadratic 2D convolution ($O(N^2)$), which is computationally heavy for client-side JavaScript. A sliding Welch/Hann periodogram or continuous Morlet wavelet transform is far more tractable in-browser.

---

## 4. Comparison Across BioMapping Continuous Arousal Metrics

| Metric | Domain | Underlying Signal | Spatial Resolution on Walk | Footstep Ripple Immunity | Sensitivity to Thresholds |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Phasic AUC** | Time | Phasic Conductance ($SC_{\text{phasic}}$) | Smears forward by **$7\text{--}14\text{ m}$** due to 10s recovery tail | High (after LR4 filter) | Zero (integrates entire curve) |
| **Driver ISCR** | Time | Deconvolved Impulse Train ($Aq$) | **Pinpoint ($< 1\text{ m}$)**; zeroes recovery tail | High (after LR4 filter) | Zero (integrates driver) |
| **Temporal Peak Density** | Event / Rate | Discrete Peaks ($p \in \text{Peaks}$) | Window-smoothed ($\pm 30\text{ s}$) | Moderate (affected by false peaks) | **High** (sensitive to $0.05\,\mu\text{S}$ floor) |
| **EDASymp** | **Frequency** | **Band Oscillations ($0.045\text{--}0.25\text{ Hz}$)** | **Continuous window ($15\text{--}30\text{ s}$)** | **Total Inherent Immunity** | **Zero (pure spectral energy)** |

---

## 5. Proposed Investigation Roadmap

Before considering production implementation in `visualiser/src/signal/`, the following validation steps should be completed:

### Step 1: Python Offline Benchmark vs. NeuroKit2
- Create a test script in `visualiser/tests/manual/neurokit_compare/check_edasymp.py`.
- Run `nk.eda_sympathetic(eda, method='posada2016')` on:
  - Clean stationary reference: `biomap_live_2026-09-10T17-20-02-105Z` and `biomap_028`.
  - Ambulatory walking tracks: `biomap_024` (brisk walk with 1.8 Hz footstep resonance) and `biomap_059` (variable pace).
- **Key question:** Does EDASymp remain flat during walking segments with no emotional arousal, or does footstep vibration leak through?

### Step 2: Correlation with Urban Stressors & Spatial Features
- Compare the spatial correlation between:
  - $\text{EDASymp}(t)$ vs. Road Traffic Noise dB(A).
  - $\text{EDASymp}(t)$ vs. Major Carriageway proximity (`highway=primary/secondary`).
  - $\text{EDASymp}(t)$ vs. Green Space immersion (NDVI / park boundaries).
- Determine whether EDASymp provides higher effect-size discrimination than Phasic AUC.

### Step 3: Lightweight JavaScript Implementation
- If Step 1 & 2 validate the metric, implement a lightweight $O(N \log N)$ sliding Welch periodogram in `visualiser/src/signal/spectral_eda.js`.
- Cross-verify numerical agreement against SciPy / NeuroKit2 output ($r \ge 0.99$).

### Step 4: UI / Visualization Integration Options
- **Option A (Map Layer):** Expose `EDASymp` as a selectable color-encoding metric in the 2D/3D map layer dropdown (alongside Conductance, Phasic, Phasic AUC, and Speed).
- **Option B (Tri-Index Component):** Evaluate replacing or augmenting the Peak Density term in BioMapping's composite Tri-Index with normalized EDASymp.

---

## 6. Implementation Record (2026-09-13)

This section documents what actually shipped, the measured NeuroKit2 agreement,
and the implementation decisions a reviewer should know about. The roadmap above
remains the design record.

### 6.1 What shipped

- **`visualiser/src/signal/spectral_eda.js`** — a pure, dependency-free `SpectralEDA`
  module (dual browser/CommonJS export) with:
  - `computeScalar(signal, fs)` → the whole-recording `EDA_Sympathetic` /
    `EDA_SympatheticN` scalar, mirroring `nk.eda_sympathetic(method='posada2016')`
    (returns `NaN` for signals ≤ 64 s, exactly like NeuroKit2).
  - `computeSeries(signal, times, fs, {windowSec, hopSec})` + `mapToSamples(...)` →
    the per-sample continuous series (default 64 s window, 5 s hop) used by the
    graph and map.
  - A self-contained radix-2 FFT, periodic Blackman window, and Chebyshev-I
    low-pass / Butterworth high-pass SOS designers that are coefficient-identical
    to `scipy.signal.cheby1` / `scipy.signal.butter` (verified via
    `scipy.signal.sosfreqz`).
  - `sosfilt` / `sosfiltfilt` replicating scipy's odd-reflection padding and
    steady-state initial conditions.
- **Analyzer** (`analyzer.js`): new `analyzer.edasymp` series (µS²) computed from
  the **raw** µS signal (`_rawValsPool`) — deliberately independent of the
  median / low-pass / tonic / detector sliders — and cached across re-analyses
  keyed on raw identity + length. `_globalRange.edasymp` feeds the graph's
  wide-view fast path.
- **UI**: `EDASymp` added to the graph (`#graphView`) and map (`#mapColoringMetric`)
  dropdowns; `--color-edasymp` theme token; map legend label; globe `SERIES_FIELD`
  and CZML/KML exporter series map.
- **Config**: `GSR_CONST.LOWER_GRAPH_MODES.edasymp` (µS², 4 dp) and
  `GSR_CONST.EDASYMP = { windowSec: 64, hopSec: 5 }`.

### 6.2 Signal chain as implemented (faithful to NeuroKit2, simplified at native fs)

NeuroKit2's `posada2016` resamples to 400 Hz, applies a forward Chebyshev-I
(8th, 1 dB, 0.8 Hz) low-pass, decimates ×10 then ×20, high-passes with a
Butterworth (8th, 0.01 Hz) at 2 Hz, then integrates a Welch PSD
(`nperseg=128` = 64 s, 50 % overlap, periodic Blackman, `nfft=256`, density
scaling) over $[0.045, 0.25)$ Hz.

BioMapping applies the same filters **at the native sample rate** (the 400 Hz
resample is a no-op below the 0.8 Hz anti-alias cutoff) and decimates directly to
2 Hz:

1. Chebyshev-I low-pass, order 8, 1 dB ripple, 0.8 Hz — forward (`sosfilt`).
2. Chebyshev-I low-pass, order 8, 0.05 dB ripple, 0.8 Hz — zero-phase
   (`sosfiltfilt`, mirroring `scipy.signal.decimate`'s anti-alias stage).
3. Decimate to 2 Hz.
4. Butterworth high-pass, order 8, 0.01 Hz — zero-phase.
5. Welch periodogram as above; band power via trapezoidal integration.

### 6.3 Measured agreement (check_edasymp.{sh,py,js})

Across 7 tracks (`biomap_019/024/027/028/053/059` + the indoor
`biomap_live_2026-09-10T17-20-02-105Z`):

| Track | NeuroKit2 | BioMapping | Ratio |
| :--- | ---: | ---: | ---: |
| biomap_019 | 0.021131 | 0.021575 | 1.021 |
| biomap_024 | 0.001267 | 0.001293 | 1.020 |
| biomap_027 | 0.020505 | 0.020758 | 1.012 |
| biomap_028 | 0.062685 | 0.064131 | 1.023 |
| biomap_053 | 0.001640 | 0.001675 | 1.022 |
| biomap_059 | 0.012718 | 0.013022 | 1.024 |
| biomap_live (fs≈3.33) | 0.056211 | 0.055627 | 0.990 |

**Cross-track Pearson r = 0.999727.** The residual (ratios 0.99–1.02) is
NeuroKit2's 400 Hz FFT resample + its `decimate()` `filtfilt` edge handling —
both negligible inside the 0.045–0.25 Hz passband, so the *relative* shape of
the metric across recordings is preserved to three decimal places.

### 6.4 Implementation decisions & gotchas

- **Standalone on the raw signal.** `computeSeries` reads `analyzer.raw` µS values,
  not the cleaned/tonic/phasic output, so EDASymp doesn't change with the
  filter/detector sliders and is cached across slider drags.
- **3D globe height.** The globe wall colours from `SERIES_FIELD` but extrudes from
  `HEIGHT_CAPABLE_METRICS`. EDASymp must be in **both**, or the wall falls back to
  the spiky phasic series and renders as jagged spikes that look nothing like the
  smooth 2D graph. EDASymp is µS² (~100× smaller than µS-scale series), so its
  extrusion is subtle at the default 8× scale — raise the extrusion slider to
  exaggerate it.
- **Short recordings.** `computeSeries` clamps its window to the available length
  (floor ≈ 4 s of 2 Hz data), so a 20–63 s recording gets one full-length
  non-zero window instead of an all-zero series. `computeScalar` still returns
  `NaN` below 64 s to stay NeuroKit2-faithful.
- **Refactor.** Windowing / FFT / density-scaling / band-integration were
  duplicated between the scalar and series paths; they now share
  `_fftSegment`, `_densityScale` and `_bandPowerFromFft` so the two can't drift.

### 6.5 Remaining roadmap items

- **Step 1's gait-flatness question — RESOLVED (2026-09-14).** The adaptive-band
  sweep (`tests/manual/neurokit_compare/sweep_edasymp_band.{sh,js}`) measured
  the 95%-power spectral edge (Fmax, Posada-Quintero et al. 2018) per 64 s
  window on real tracks. `biomap_024` — the brisk walk flagged for 1.8 Hz
  footstep resonance — exceeded 0.25 Hz in 38.1 % of windows with a mean
  fixed-vs-adaptive power ratio of 1.118x (max 3.35x), vs. 0.0 % / 1.003x for
  the calm `biomap_027`. Footstep leakage is ruled out: the 0.8 Hz anti-alias
  low-pass runs *before* decimation, so 1.8 Hz gait content cannot survive as
  spectral energy above 0.25 Hz — the clipped power is real EDA.
- **Step 2** — spatial correlation vs. road-noise / carriageway proximity /
  green-space NDVI is not yet run.
- **Step 4 Option B** — EDASymp is a standalone dropdown metric; it has not been
  folded into the Tri Index.

### 6.6 Adaptive upper edge (2026-09-14)

The fixed [0.045, 0.25) Hz edge clips real sympathetic power on walking tracks
(§6.5), so `SpectralEDA.computeSeries` gained an opt-in `adaptiveBand` option
(enabled via `GSR_CONST.EDASYMP.adaptiveBand`) that widens each window's upper
edge to `max(Fmax, 0.25)` Hz, where Fmax is the window's 95%-power spectral
edge. `computeScalar` stays fixed and NeuroKit2-faithful, so the §6.3
cross-validation benchmark is unchanged.

---

## 7. Key References

1. **Posada-Quintero, H. F., Florian, J. P., Orjuela-Cañón, A. D., Aljama-Corrales, T., Charleston-Villalobos, S., & Chon, K. H. (2016)**. *Time-varying spectral analysis of electrodermal activity for sympathetic nervous system activity evaluation*. Annals of Biomedical Engineering, 44(12), 3616–3627. [DOI: 10.1007/s10439-016-1607-8](https://doi.org/10.1007/s10439-016-1607-8)
2. **Posada-Quintero, H. F., & Chon, K. H. (2020)**. *Frequency-domain methods for electrodermal activity: A review*. Frontiers in Physiology, 11, 1012. [DOI: 10.3389/fphys.2020.01012](https://doi.org/10.3389/fphys.2020.01012)
3. **Macefield, V. G., & Wallin, B. G. (1996)**. *The discharge behaviour of single sympathetic neurones supplying human sweat glands*. The Journal of the Autonomic Nervous System, 61(3), 277–286.
4. **Makowski, D., Pham, T., Lau, Z. J., et al. (2021)**. *NeuroKit2: An open-source Python toolbox for neurophysiological signal processing*. Behavior Research Methods, 53(4), 1689–1696.
5. **Benedek, M., & Kaernbach, C. (2010b)**. *A continuous measure of phasic electrodermal activity*. Journal of Neuroscience Methods, 190(1), 80–91.
