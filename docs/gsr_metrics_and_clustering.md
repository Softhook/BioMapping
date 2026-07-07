# GSR Analysis Methodology: Peak Density, Phasic AUC, and Spatial Stress Clustering

This document reviews how advanced Electrodermal Activity (GSR/EDA) metrics are used in psychophysiological and spatial mapping literature, explains why they resolve the "binary thresholding dilemma," and outlines a blueprint for implementing them in the BioMapping visualizer.

---

## 1. Academic Literature Context

Mobile biosensing studies (such as cyclist and pedestrian stress mapping in GIS) have moved away from simple trough-to-peak counting of raw signal excursions due to environmental noise and overlapping signals. The literature relies on three core metrics:

### A. Non-Specific SCR Frequency (NS-SCR / Peak Density)
In laboratory settings, a Skin Conductance Response (SCR) is measured in response to a specific, timed stimulus (e.g., a flash of light). In the wild, however, we track **Non-Specific SCRs (NS-SCRs)**, which are spontaneous responses to environmental stressors.
*   **Literature Standard (Boucsein, 2012; Dawson et al., 2007)**: In a relaxed state, a typical human exhibits **1 to 3 spontaneous peaks per minute**. Under high stress, cognitive load, or environmental arousal, this rate climbs to **20+ peaks per minute**.
*   **Methodology**: A temporal sliding window (typically $30\text{ s}$ to $120\text{ s}$) counts active peaks and normalizes them to a "peaks per minute" scale.
*   **Use Case**: Maps local "arousal density" along walking tracks, pointing out clusters of stressors.

### B. Integrated Skin Conductance Response (ISCR / Phasic AUC)
Traditional peak counting suffers from the **superposition problem**: if a participant encounters multiple stressors in rapid succession, a new sympathetic response will trigger before the sweat gland has finished reabsorbing/recovering from the previous one. This causes the signal to pile up, meaning traditional trough-to-peak algorithms undercount peaks.
*   **Literature Standard (Benedek & Kaernbach, 2010)**: To resolve superposition, researchers decompose the raw signal into Tonic and Phasic components, and then compute the **Integrated Skin Conductance Response (ISCR)**—which is the Area Under the Curve (AUC) of the Phasic driver signal.
*   **Unit of Measure**: $\mu\text{S}\cdot\text{s}$ (MicroSiemens $\times$ seconds).
*   **Advantage**: The AUC captures both the *amplitude* and the *duration* of arousal. It is completely continuous and does not rely on a binary threshold, making it highly robust against minor noise fluctuations.

### C. Combined Arousal Index
Tonic baseline (Skin Conductance Level, SCL) and Phasic responses (SCRs) reflect different autonomic mechanisms:
*   **Tonic SCL**: General physiological tone (governed by baseline vigilance, physical exertion/pedal-speed, and ambient temperature).
*   **Phasic Activity**: Short-term environmental stimulus responses.
*   **Spatial wearability studies (e.g., Shoval et al., 2018)**: Combine both signals. Because they have different scales, they are normalized using individual participant Z-scores:
    $$\text{Arousal Index}(t) = w_{\text{tonic}} \cdot \text{Tonic}_z(t) + w_{\text{phasic}} \cdot \text{PhasicAUC}_z(t)$$
    Typically, Phasic is weighted higher (e.g., $w_{\text{phasic}} = 0.70$) to prioritize immediate environmental triggers, while Tonic is weighted lower (e.g., $w_{\text{tonic}} = 0.30$) to incorporate the baseline state.

---

## 2. Addressing the Thresholding Dilemma (Why this matters for your data)

When you modify the peak detection threshold and get either 5 or 500 peaks, you are experiencing the limitation of **hard thresholding**. 

```
GSR Phasic Signal
   ▲
   │        Peak A (0.021 μS) ───►  [PASSES THRESHOLD]
───┼───────────────────────────────── Threshold (0.020 μS)
   │        Peak B (0.019 μS) ───►  [IGNORED / FAILS]
   │    ┌─┐
   │  ┌─┘ └─┐      ┌─┐
   │ ┌┘     └┐    ┌┘ └┐
───┴─┴───────┴────┴───┴───────► Time
```

If your threshold is $0.02\ \mu\text{S}$, an response of size $0.021\ \mu\text{S}$ is counted as a peak. A response of size $0.019\ \mu\text{S}$ is completely discarded, even though physiologically they represent almost identical sympathetic activations.

### The Solutions:
1.  **Peak Quality Score**: By evaluating shape criteria (rise time, decay shape, SNR), we can set a low amplitude threshold (e.g., $0.015\ \mu\text{S}$) but filter out noisy fluctuations by verifying that the peak has a realistic physiological shape.
2.  **Phasic AUC (Area Under Curve)**: Since AUC integrates the entire area under the Phasic signal, Peak A and Peak B are both captured and summed proportional to their actual sizes. The resulting metric is smooth, continuous, and threshold-independent.

---

## 3. Concrete Implementation Blueprint in BioMapping

To add these features to your codebase, we can implement them directly within your data pipeline in the following components:

### Step 1: Update the Analysis Engine (`GSRAnalyzer` in `analyzer.js`)
We will add functions to `GSRAnalyzer` to compute sliding-window Peak Density and Phasic AUC.

```javascript
// Add to analyzer.js

/**
 * Calculates a sliding-window temporal peak density (Non-Specific SCR Frequency) in peaks/minute.
 * @param {number} windowSizeSec - Temporal window width in seconds (default: 60)
 */
computeTemporalPeakDensity(windowSizeSec = 60) {
  const n = this.phasic.length;
  if (n === 0) return [];
  
  const density = new Array(n);
  const halfWin = windowSizeSec / 2;
  
  // Filter active, non-excluded peaks
  const activePeakTimes = this.peaks
    .filter(p => !p.excluded)
    .map(p => p.time);
    
  for (let i = 0; i < n; i++) {
    const t = this.phasic[i].time;
    const tStart = t - halfWin;
    const tEnd = t + halfWin;
    
    let count = 0;
    for (let j = 0; j < activePeakTimes.length; j++) {
      const pt = activePeakTimes[j];
      if (pt >= tStart && pt <= tEnd) count++;
    }
    
    density[i] = {
      time: t,
      val: count * (60 / windowSizeSec) // Scale to peaks/minute
    };
  }
  return density;
}

/**
 * Calculates sliding-window Phasic Area Under the Curve (ISCR / AUC) in μS·s.
 * @param {number} windowSizeSec - Temporal window width in seconds (default: 30)
 */
computePhasicAUC(windowSizeSec = 30) {
  const n = this.phasic.length;
  if (n === 0) return [];
  
  const auc = new Array(n);
  const winSamples = Math.round(windowSizeSec * this.sampleRate);
  let runningSum = 0;
  
  for (let i = 0; i < n; i++) {
    const val = Math.max(0, this.phasic[i].val); // Rectify signal (only positive phasic activity)
    runningSum += val;
    
    if (i >= winSamples) {
      runningSum -= Math.max(0, this.phasic[i - winSamples].val);
    }
    
    auc[i] = {
      time: this.phasic[i].time,
      val: runningSum / this.sampleRate // Convert sum to integral (μS * seconds)
    };
  }
  return auc;
}
```

### Step 2: Add Z-Score Normalization for the Combined Index
To build the combined Arousal Index, we can add a method to normalize and sum the tonic and phasic AUC values.

```javascript
// Add to analyzer.js

/**
 * Computes a standardized Combined Arousal Index.
 * @param {number} wTonic - Weight for tonic SCL component (default: 0.3)
 * @param {number} wPhasic - Weight for phasic AUC component (default: 0.7)
 */
computeCombinedArousalIndex(wTonic = 0.3, wPhasic = 0.7) {
  const n = this.phasic.length;
  if (n === 0) return [];
  
  const auc = this.computePhasicAUC(30);
  const tonicVals = this.tonic.map(d => d.val);
  const aucVals = auc.map(d => d.val);
  
  // Calculate means and standard deviations
  const tonicStats = GsrFilter.calculateStats(tonicVals);
  const aucStats = GsrFilter.calculateStats(aucVals);
  
  const arousalIndex = new Array(n);
  for (let i = 0; i < n; i++) {
    // Z-score standardize both metrics
    const tZ = (this.tonic[i].val - tonicStats.mean) / tonicStats.std;
    const aZ = (aucVals[i] - aucStats.mean) / aucStats.std;
    
    arousalIndex[i] = {
      time: this.phasic[i].time,
      val: (wTonic * tZ) + (wPhasic * aZ)
    };
  }
  return arousalIndex;
}
```

### Step 3: Map and Visualizer Integration
Once the mathematical arrays are calculated in `GSRAnalyzer`, you can expose them in two ways:
1.  **Lower Graph Options**: In `renderer.js` and `ui.js`, add a dropdown to select what is shown in the lower graph panel. Toggle between raw **Phasic (SCR)**, **Sliding Window Peak Density (PPM)**, and **Phasic AUC ($\mu\text{S}\cdot\text{s}$)**.
2.  **Topography Sources on Map**: In `collective_manager.js` and `map.js`, expand the `topoSource` dropdown from `['phasic', 'tonic', 'peaks']` to include `['phasic', 'tonic', 'peaks', 'auc', 'arousal_index']`.
    *   For `auc` or `arousal_index` sources, `GSRCollectiveManager` will run Inverse Distance Weighting (IDW) interpolation on the respective calculated arrays, creating a continuous stress heatmap surface that bypasses peak-counting threshold artifacts.
