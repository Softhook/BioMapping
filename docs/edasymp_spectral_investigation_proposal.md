# EDASymp (0.045–0.25 Hz) Spectral Sympathetic Index — Investigation & Design Proposal

**Status: Proposal & Research Roadmap — Not yet implemented in production.**  
Documents the scientific rationale, mathematical formulation, and system architecture for a frequency-domain sympathetic arousal metric based on **Posada-Quintero & Chon (2016, 2020)** and NeuroKit2's `nk.eda_sympathetic()`.

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

## 6. Key References

1. **Posada-Quintero, H. F., Florian, J. P., Orjuela-Cañón, A. D., Aljama-Corrales, T., Charleston-Villalobos, S., & Chon, K. H. (2016)**. *Time-varying spectral analysis of electrodermal activity for sympathetic nervous system activity evaluation*. Annals of Biomedical Engineering, 44(12), 3616–3627. [DOI: 10.1007/s10439-016-1607-8](https://doi.org/10.1007/s10439-016-1607-8)
2. **Posada-Quintero, H. F., & Chon, K. H. (2020)**. *Frequency-domain methods for electrodermal activity: A review*. Frontiers in Physiology, 11, 1012. [DOI: 10.3389/fphys.2020.01012](https://doi.org/10.3389/fphys.2020.01012)
3. **Macefield, V. G., & Wallin, B. G. (1996)**. *The discharge behaviour of single sympathetic neurones supplying human sweat glands*. The Journal of the Autonomic Nervous System, 61(3), 277–286.
4. **Makowski, D., Pham, T., Lau, Z. J., et al. (2021)**. *NeuroKit2: An open-source Python toolbox for neurophysiological signal processing*. Behavior Research Methods, 53(4), 1689–1696.
5. **Benedek, M., & Kaernbach, C. (2010b)**. *A continuous measure of phasic electrodermal activity*. Journal of Neuroscience Methods, 190(1), 80–91.
