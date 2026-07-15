# Literature-Backed Psychophysiological Metrics: Scientific Guide & Research Goals

This document details the scientific rationale, mathematical definitions, core challenges solved, AI/ML enhancement models, and visualization integrations for advanced physiological analysis in the BioMapping system.

---

## 1. Core Research Challenges in Mobile Environmental Biosensing

Mobile psychophysiology—mapping human stress responses in real-world urban environments—introduces significant methodological challenges that are absent in controlled laboratory settings:

* **Subject Variation (Individual Baselines):** Base skin conductance values vary by orders of magnitude between individuals due to age, skin thickness, hydration, and sensor contact. One participant's "intense stress" value may be lower than another's "resting baseline."
* **Overlapping Stimuli (Superposition):** Real-world urban stressors (e.g., traffic noise, visual clutter, crossing a street) do not occur in isolation. Multiple triggers occur in rapid succession, causing physiological responses to pile up before the body can recover.
* **Physical Noise & Exertion:** Walking speed, changes in grade, weather, and physical movement contaminate the biometric signals, meaning raw amplitude thresholds alone are unreliable indicators of psychological stress.

The goal of introducing these advanced metrics and model frameworks is to directly solve these challenges, translating raw skin conductance waveforms into standardized, peer-reviewed indices of urban stress and restoration.

---

## 2. Temporal Peak Density (PPM) vs. Spatial Peak Clustering

| Dimension | Spatial Peak Clustering (Blobs & KDE) | Temporal Peak Density (PPM) |
| :--- | :--- | :--- |
| **Domain** | **Spatial Domain** (Geographic) | **Time Domain** (Chronological) |
| **Input Data** | Coordinate points of discrete stress peaks. | Continuous time sequence of active stress peaks. |
| **Computation** | Geodesic grouping (DBSCAN/BFS Proximity) & Gaussian Kernel Density Estimation (KDE) over a 2D map grid. | Temporal sliding window count scaled to peaks per minute: $$PPM(t) = \frac{\text{peaks inside } [t - \frac{W}{2}, t + \frac{W}{2}]}{\text{window width in minutes}}$$ |
| **Core Question** | *"Where in the urban landscape do stress responses concentrate?"* | *"How frequently was the participant's sympathetic nervous system firing at this moment?"* |
| **Output Format** | Concave boundary polygons (blobs) or continuous density isolines (contours) on the map. | A continuous 1D time-series waveform plotted on the timeline graph. |

### Core Goals & Advantages of Temporal Peak Density (PPM):
* **Moving from "Binary Sparks" to "Sustained Stress":** Traditional peak-counting treats stress as a series of isolated, binary events (e.g. *"a peak happened here"*). It ignores the user's overall state of vigilance. Temporal density (PPM) quantifies *state vigilance*—differentiating between a participant who had one isolated spike in a park and one who is in a high-vigilance flurry of spikes (e.g., $>15\text{ PPM}$) in a crowded junction.
* **Resilience to Travel Speed and Modality:** If a pedestrian walks slowly ($1\text{ m/s}$) and experiences 5 stress spikes over 100 meters, and a cyclist rides quickly ($5\text{ m/s}$) and experiences 5 spikes over the same 100 meters, their spatial density looks totally different. Normalizing to temporal density (peaks per minute) ensures they are compared fairly.
* **Continuous Signal Alignment:** Because it is a continuous array of $\{time, val\}$, it can be mapped, correlated, and aligned with other 1 Hz time-series datasets (such as GPS velocity, heart rate, or air quality).

---

## 3. Integrated Skin Conductance Response (ISCR / Phasic AUC)

Traditional mobile biosensing relies on a trough-to-peak amplitude threshold (typically $0.01\ \mu\text{S}\text{ or } 0.02\ \mu\text{S}$) to identify stress events. However, this discrete counting approach is highly prone to noise and misses cumulative stress.

```
       Superposition (Overlap)              Hard Thresholding Dilemma
        
        ▲                                     ▲  Peak A (0.021 μS) ──► [PASS]
       μS     /\  /\                          │  ───────────────────────────────
        │    /  \/  \  ◄── Stacked peaks      │  Peak B (0.019 μS) ──► [IGNORED]
        │   /        \     (undercounted      │
        └───┴────────┴──►  by peak-finders)   └──┴───────────────────►
```

### The Solution: Phasic Area Under the Curve (AUC)
Phasic AUC integrates the continuous, rectified phasic driver signal over a sliding window (e.g., $30\text{ s}$):
$$ISCR(t) = \int_{t - W/2}^{t + W/2} \max(0, Phasic(\tau)) \, d\tau$$

### Core Goals & Advantages of Phasic AUC:
* **Quantifying Cumulative Stress Load:** Instead of counting peaks, AUC measures the *volume* of the sweat response over a window. The goal is to capture the **cumulative physiological cost** of a segment of a walk, rather than counting individual spikes.
* **Resolving the Superposition Problem:** When a participant encounters multiple stressors in rapid succession, a new sympathetic response triggers before the sweat gland has finished reabsorbing sweat from the prior response. The signals pile up (superposition), causing traditional peak detectors to undercount them. Phasic AUC integrates the entire driver signal, naturally capturing the cumulative physiological load.
* **Eliminating the Thresholding Dilemma:** Hard thresholding discards a $0.019\ \mu\text{S}$ response while keeping a $0.021\ \mu\text{S}$ response, despite them representing almost identical autonomic activations. AUC is continuous and threshold-independent.
* **Reflecting Duration:** AUC measures both how high the stress spike was (amplitude) and how long its impact lingered (decay time), providing a more realistic index of physiological recovery.

---

## 4. Combined Arousal Index

Tonic baseline shifts (Skin Conductance Level, SCL) and Phasic responses (SCRs) represent distinct physiological processes:
* **Tonic SCL:** Reflects general background arousal, environmental temperature, fatigue, and pedal/exertion speed.
* **Phasic AUC:** Reflects short-term, acute event-driven reactions to immediate spatial stimuli.

### Mathematical Definition:
To merge these distinct signals with differing scales, they are normalized using individual participant Z-scores and combined using standard literature weights (typically $30\%$ Tonic, $70\%$ Phasic):
$$\text{Arousal Index}(t) = 0.30 \cdot \text{Tonic}_Z(t) + 0.70 \cdot \text{PhasicAUC}_Z(t)$$
Where:
$$X_Z(t) = \frac{X(t) - \mu_X}{\sigma_X}$$

### Core Goals & Advantages of the Combined Arousal Index:
* **Vigilance + Response Fusion:** The index captures both the immediate shock of a localized stressor (e.g., a near-miss traffic conflict) and the background vigilance or physical exhaustion of the walk, merging slow-moving and fast-acting stress elements.
* **Inter-Subject Compatibility (Comparing Cohorts):** Standardizing both components using individual Z-scores normalizes individual biological differences (e.g., skin thickness, dry/wet skin, sensor contact impedance) and allows files from a large cohort to be compared fairly. 
* **Identifying Global Urban Stressors:** The goal is to allow researchers to overlay data from dozens of participants to find global environmental stressors. If a street has a mean Arousal Index of $+1.5$ (1.5 standard deviations above average), researchers know it is a universally stressful location, regardless of individual skin conductance baselines.

---

## 5. AI & Machine Learning Integration Opportunities

To scale BioMapping from an exploratory visualization dashboard to a rigorous predictive science tool, researchers can leverage four distinct AI/ML model integrations:

### A. Context-Aware Stress Event Labeler (LLM / VLM Co-pilot)
* **Concept:** When a stress peak is detected, the system extracts the $(lat, lon)$ coordinates, queries OpenStreetMap for local environmental features (e.g. *highway category, proximity to bus stop, density of commercial cafes*), and compiles the peak's shape metrics (amplitude, rise time, temporal density). This context is fed into a Large Language Model (LLM).
* **Research Goal:** Automate the labeling of stress triggers along a track. The AI co-pilot proposes likely explanations for individual events (e.g., *"Stress event highly correlated with heavy vehicle traffic and crossing at motorway junction"* or *"Tonic baseline decay indicating physiological recovery matching green-space immersion"*).
* **Multimodal Extension:** Query Mapillary or Google Street View API at the coordinate to fetch a 360° eye-level panoramic photo. Pass the image to a Vision-Language Model (VLM) to identify visual stress triggers (e.g. sidewalk obstacles, construction, lack of vegetative canopy, narrow pedestrian lanes).

### B. Physiological Confounder Filtering (Supervised ML)
* **Concept:** Mobile skin conductance is heavily contaminated by physical exertion (climbing stairs/hills, changes in walking pace) and ambient temperature. Sweat glands activate for thermoregulation, creating false stress detections.
* **Research Goal:** Train a supervised ML regressor (e.g., **Random Forest** or **XGBoost**) on physical features: GPS velocity, 3D accelerometer motion, elevation slope (GIS Digital Elevation Models), and skin/ambient temperature.
* **Research Goal:** The model predicts the *expected metabolic/thermoregulatory response*. By subtracting this predicted metabolic SCL from the actual measured conductance, we isolate the **purely psychological/cognitive stress** signal.

### C. Predictive Urban Feature Modeling (Feature Importance)
* **Concept:** Once a track is enriched with OpenStreetMap attributes (building densities, water distances, tree Row counts, transit hubs), researchers can treat these as spatial predictor variables.
* **Research Goal:** Train a decision-tree based regressor (**Random Forest Regressor**) to predict continuous `Phasic AUC` or the `Combined Arousal Index` using surrounding spatial attributes.
* **Research Goal:** Extract **Feature Importances** to give planners empirical proof of what elements drive urban stress vs. calm (e.g., *"Tree density within 50m contributes 43% of predictive power towards lowering tonic SCL"*).

### D. Deep Learning Waveform Artifact Filtering (1D CNN / LSTM)
* **Concept:** Hand-crafted mathematical filters (e.g., wavelets, low-pass windows) are prone to edge corruption and require manual parameter tuning.
* **Research Goal:** Deploy a pre-trained **1D Convolutional Neural Network (1D CNN)** or a **Long Short-Term Memory (LSTM)** network directly on the raw timeseries.
* **Research Goal:** Automatically classify waveform segments as `Motion Artifact` (to exclude) vs. `Genuine Sympathetic Response` (to analyze).

---

## 6. Integration Blueprint for Visualizer Features

### Feature A: Lower Graph Selector (Timeline Panel)
* **Concept:** Expose a dropdown in the p5.js canvas header to switch the lower graph's rendering.
* **Metrics:** Toggle between `Phasic (SCR)`, `Peak Density (PPM)`, `Phasic AUC (ISCR)`, and `Combined Arousal Index`.
* **Visuals:** Style each metric with distinct, curated theme colors:
  * Phasic (SCR) $\rightarrow$ Green (`#008f3c`)
  * Peak Density (PPM) $\rightarrow$ Amber (`#e59e00`)
  * Phasic AUC (ISCR) $\rightarrow$ Teal (`#0099aa`)
  * Combined Arousal Index $\rightarrow$ Purple (`#7b00cc`)
* **Scrubber/Tooltip Integration:** The tooltip dynamically scales and displays the active metric's value with its corresponding scientific units (e.g., $\mu\text{S}\cdot\text{s}$, $\text{peaks/min}$, or unitless Z-score).
* **AI Integration:** When a user hovers or clicks on a peak marker in the visualizer, display a sidebar containing the **AI Stress Event Labeler's** inference regarding the surrounding spatial triggers.

### Feature B: Continuous Topography Map Contours
* **Concept:** Expose `auc`, `arousal_index`, and `peak_density` as source options in the map's Contour Surface settings.
* **Visuals:** When selected, the collective manager runs Inverse Distance Weighting (IDW) interpolation on the selected continuous timeline array across all active tracks.
* **Value:** Bypasses peak-counting threshold artifacts to draw smooth, continuous contour maps of cumulative stress (AUC) or relative stress (Arousal Index), complete with dynamic legend units.

### Feature C: Bivariate Correlation Dashboard (Regression & Profiles)
* **Concept:** Expose the new continuous metrics as biometric target variables in the correlation analytics.
* **Visuals:** Correlate continuous `Peak Density (PPM)` or `Phasic AUC` against environmental indicators (e.g., `Distance to Major Road` or `Green Space %`) in the regression scatter plot and road type bar profiles.
* **Value:** Because these metrics are standardized and integrated, they are significantly more robust against motion artifacts and skin drift, leading to more reliable, publishable $R^2$ coefficients and trendlines.
