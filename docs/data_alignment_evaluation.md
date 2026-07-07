# Critical Evaluation: 10 Hz GSR vs. 1 Hz GPS Alignment

This document outlines how the GSR Map Visualizer aligns high-frequency physiological data (10 Hz) with low-frequency spatial coordinates (1 Hz), ensuring statistical precision and rendering performance.

---

## 1. The Spatial-Physiological Gap

*   **Physiological Signal (GSR/EDA)**: Sampled at **10 Hz** (10 records/second) to capture rapid galvanic skin response fluctuations (such as sweat gland activity peaks that rise within 1–2 seconds).
*   **Geographic Coordinates (GPS)**: Sampled at **1 Hz** (1 record/second). Querying or mapping at 10 Hz directly would leave 9 out of 10 data points with empty/null coordinates.

```
Time (s):   0.0    0.1    0.2    0.3    0.4    0.5    0.6    0.7    0.8    0.9    1.0
GSR (10Hz): [x]    [x]    [x]    [x]    [x]    [x]    [x]    [x]    [x]    [x]    [x]
GPS (1Hz):  [Lat]  ---    ---    ---    ---    ---    ---    ---    ---    ---    [Lat]
Spatial:    [Raw]  ====== Linear/Step Spatial Interpolation ======> [Raw]
```

---

## 2. Code Implementation Audit

### A. Coordinate Reconstruction (10 Hz Path)
Missing coordinates in the 10 Hz timeline are reconstructed in `analyzer.js`:
*   *Code Implementation*:
    *   During track loading, `analyzer.js` linearly interpolates latitude and longitude values across the empty intervals between the 1 Hz GPS coordinates.
*   *Evaluation*: **Correct.** Reconstructs a smooth, continuous 10 Hz spatial path that matches the resolution of the biometric sensors, preventing "staircase" jumps on the leaflet map line coordinates.

### B. Overpass API & Spatial Grid Hashing (Performance Optimization)
*   *Audit Finding*: Calculating spatial containment and segment projections on 10 Hz coordinates would require 10x the CPU cycles and degrade browser performance.
*   *Solution in `osm_enrichment.js`*:
    *   **Evaluation Phase (1 Hz)**: Spatial distance and density metrics are evaluated strictly on the 1 Hz raw coordinates where updates actually occurred.
    *   **Interpolation Phase (10 Hz)**: Metrics are projected back to the 10 Hz timeline:
        *   **Continuous Metrics** (e.g., green space %, distances to roads/water, densities) are **linearly interpolated** between the evaluation nodes.
        *   **Categorical Metrics** (e.g., road class type, in-park binary flag) are **step interpolated** (nearest-neighbor, transition boundary at fraction $\ge 0.5$).
*   *Evaluation*: **Scientifically and computationally correct.** Continuous distances change smoothly between seconds, while category classifications (such as crossing from a primary to secondary road) represent abrupt boundaries, which step interpolation correctly preserves.

### C. Downsampling for Statistical Dashboard (1 Hz Windowed Aggregation)
*   *Code Implementation*:
    *   In `ui.js`, calculations for the Correlation Matrix and Linear Regression downsample the 10 Hz arrays to a 1 Hz timeline using a time-delta checker (`pt.time - lastTime >= 1.0`).
    *   Instead of simple decimation (which clips peak amplitudes), the code aggregates across the 10 samples of each 1-second window:
        *   **Tonic SCL and Raw GSR**: Calculated as the **mean (average)** over the 10-sample window to smooth out high-frequency sensor noise.
        *   **Phasic SCR**: Calculated as the **maximum** value over the 10-sample window to capture the exact amplitude peak of any fast sympathetic sweat response.
*   *Evaluation*: **Correct and scientifically robust.** Windowed aggregation prevents peak clipping of rapid electrodermal responses and eliminates spatial-physiological aliasing while downsampling to 1 Hz.

---

## 3. Overall Evaluation Summary

The codebase handles the multi-frequency data streams correctly:
1.  **Coordinates** are linearly interpolated in the gap intervals to ensure high-resolution mapping.
2.  **OSM queries** are evaluated at 1 Hz for performance, then continuous values are linearly interpolated and categories step-interpolated to align with the 10 Hz biometrics.
3.  **Statistical dashboard calculations** are downsampled back to 1 Hz to prevent high-frequency noise from skewing global correlations, maintaining perfect temporal synchronization.
