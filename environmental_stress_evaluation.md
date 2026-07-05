# Critical Evaluation: Regression Plot and Roads Profile Systems

This document provides a critical scientific and mathematical evaluation of the **Regression Plot** and **Roads Profile** components in the GSR Map Visualizer. It evaluates their alignment with academic mobile biosensing literature and audits the correctness of their implementation in the codebase.

---

## 1. Regression Plot (Ordinary Least Squares Linear Regression)

The regression dashboard models the relationship between an independent spatial variable ($x$) and a dependent physiological metric ($y$, representing either Phasic GSR or Tonic SCL).

### A. Literature Context & Scientific Relevance
*   **Purpose**: While correlation matrices show if a general relationship exists, **linear regression quantifies the relationship**. Planners use it to estimate effect sizes (e.g., how many microSiemens baseline arousal increases per meter closer to a major road) and evaluate the predictive strength ($R^2$) of urban features.
*   **The $R^2$ Phenomenon in Bio-Sensing**: In environmental biosensing studies, $R^2$ values are typically low (often under 0.05). Human stress is multi-sensory and influenced by thermoregulation, internal thoughts, and visual complexity. In neuro-urbanism literature, an $R^2 = 0.02$ is considered statistically significant and publishable provided the sample size is large and the p-value is low.

### B. Mathematical Implementation Audit
The Ordinary Least Squares (OLS) regression parameters are calculated in `ui.js`:

1.  **Slope ($m$) and Intercept ($c$)**:
    $$\text{Slope } (m) = \frac{n \sum xy - \sum x \sum y}{n \sum x^2 - (\sum x)^2}$$
    $$\text{Intercept } (c) = \bar{y} - m\bar{x}$$
    *Code Implementation*:
    ```javascript
    const numM = n * sumXY - sumX * sumY;
    const denM = n * sumX2 - sumX * sumX;
    const m = denM === 0 ? 0 : numM / denM;
    const c = meanY - m * meanX;
    ```
    *Evaluation*: **Mathematically Correct.** This matches standard OLS statistical formulas exactly.

2.  **Coefficient of Determination ($R^2$)**:
    $$R^2 = 1 - \frac{SS_{\text{res}}}{SS_{\text{tot}}} = 1 - \frac{\sum (y_i - \hat{y}_i)^2}{\sum (y_i - \bar{y})^2}$$
    *Code Implementation*:
    ```javascript
    let ssTot = 0;
    let ssRes = 0;
    for (let i = 0; i < n; i++) {
      const pred = m * x[i] + c;
      const dev = y[i] - meanY;
      const res = y[i] - pred;
      ssTot += dev * dev;
      ssRes += res * res;
    }
    const r2 = ssTot === 0 ? 1 : 1 - (ssRes / ssTot);
    ```
    *Evaluation*: **Mathematically Correct.** ssTot correctly calculates total sum of squares (variance from the mean) and ssRes calculates residual sum of squares (deviation from the regression trendline).

3.  **Canvas Projection Mapping**:
    *Code Implementation*:
    ```javascript
    const mapX = (x) => padL + ((x - minX) / rangeX) * (width - padL - padR);
    const mapY = (y) => height - padB - ((y - minY) / rangeY) * (height - padB - padT);
    ```
    *Evaluation*: **Correct.** Correctly projects the coordinates linearly onto the drawing canvas width and height, accounting for padding borders.

4.  **Critical Improvement (Outlier Filtering)**:
    *Audit Finding*: Previously, if a track had no water nearby, the distance to water registered as `999.0` meters for every point. Drawing a trendline to a cluster of points at `x = 999.0` flattened the regression line and made the chart illegible.
    *Fix Applied*: The data loader loop now filters out these `999.0` indicators, ensuring that the chart only plots active spatial ranges.

---

## 2. Roads Profile (Classification Aggregator)

The Roads Profile aggregates physiological metrics and stress peaks across OpenStreetMap highway classifications.

### A. Literature Context & Scientific Relevance
*   **Purpose**: In urban design, street typologies (e.g. primary, residential, path) represent complex baskets of stressors (combining vehicular traffic speed, noise, visual enclosure, and walking safety).
*   **Significance**: Isolating these profiles allows researchers to make targeted spatial planning recommendations, such as: "Converting secondary roads to pedestrian paths reduces mean Phasic stress by $X\%$."

### B. Mathematical Implementation Audit

1.  **Arousal Aggregation**:
    *Code Implementation*:
    Iterates over the 1 Hz downsampled data, grouping by `osm_road_class`.
    $$\text{Mean Phasic} = \frac{\sum \text{Phasic Levels}}{\text{Seconds Spent}}$$
    $$\text{Mean Tonic} = \frac{\sum \text{Tonic SCL}}{\text{Seconds Spent}}$$
    *Evaluation*: **Correct.** Because data is downsampled at 1 Hz intervals, each point represents exactly 1 second, meaning the sample count equates to the exact duration spent on that road class.

2.  **Peak Rate Normalization**:
    *Code Implementation*:
    $$\text{Peak Rate (peaks/minute)} = \frac{\text{Peaks Count}}{\left(\frac{\text{Duration (seconds)}}{60}\right)}$$
    ```javascript
    peakRate: (val.peaks / (val.count / 60))
    ```
    *Evaluation*: **Correct.** Correctly normalizes the raw peak counts to a standard rate of peaks per minute, which is the standard reporting index in electrodermal activity literature.

3.  **Physiological Latency Compensation**:
    *Code Implementation*:
    ```javascript
    const idx = a.findClosestIndex(Math.max(0, p.time - latency));
    const rc = (idx !== -1 && a.raw[idx].osm_road_class) ? a.raw[idx].osm_road_class : 'none';
    ```
    *Evaluation*: **Correct.** To identify which road class caused a stress peak, the algorithm queries the road class at time $t - \text{latency}$ (where latency is the unified slider setting, typically 1.5 - 3.0 seconds). This properly accounts for the physical sympathetic delay between encountering a spatial stressor and registering a sweat gland response.

---

## 3. Overall Evaluation Summary

Both modules are mathematically sound and align directly with methods used in mobile biosensing and GIS research:
*   The OLS regression slope and $R^2$ are correctly implemented computational forms.
*   The road profile aggregates correctly normalize time and peak counts.
*   By filtering out `999.0` default indicators, both modules are protected from statistical distortions.
