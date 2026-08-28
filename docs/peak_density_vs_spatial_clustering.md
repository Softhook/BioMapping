# Literature-Backed Psychophysiological Metrics: Scientific Guide & Research Goals

This document details the scientific rationale, mathematical definitions, core challenges solved, AI/ML enhancement models, Flipper Zero hardware integrations, urban EMF precedents, and visualization blueprints for advanced physiological analysis in the BioMapping system.

> **Status (2026-08-28) — part reference, part roadmap.** This is a research
> rationale document, not a build spec, and it predates several decisions it
> describes speculatively. What has since **shipped**: temporal peak density
> (PPM), Integrated SCR / Phasic AUC, the Combined Arousal Index, and their
> use as continuous map-contour sources and lower-graph metrics (§2–§4, §8);
> and an **RF sweep — but 3 bands (815 / 868 / 915 MHz), not the 4-band
> 315 / 433 / 868 / 915 set in §2 and §6E/§6F**. The composite index is
> called the **EM Fog Index** in the visualiser (`analyzer.js`
> `calcEmFog()`, `rf_fluid_renderer.js`); the CSV columns are
> `rssi_815 / rssi_868 / rssi_915` (see [`csv_schema.md`](csv_schema.md)),
> not the `rssi_315…` names below. Still **speculative / not built**: the
> AI/ML models (§5), and the NFC-checkpoint / IR-sniff / PM2.5 / decibel
> GPIO expansions (§6B–§6D) — the acoustic one has its own proposal at
> [`acoustic_aircraft_detection_proposal.md`](acoustic_aircraft_detection_proposal.md).
> The firmware's `modules/em_scan_rf.h` cites §6E/§6F as the "original full
> design"; treat the band count and timings there as aspirational.

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

## 6. Flipper Zero Hardware Enhancements & Sensor Integration

Because the BioMapping logging firmware runs natively as a Flipper Zero Application Package (FAP), we can leverage the Flipper's unique hardware transceiver capabilities to expand environmental data collection beyond basic GPS and skin conductance.

```
                  ┌──────────────────────────────────────┐
                  │          Flipper Zero Core           │
                  └──────┬────────────┬───────────┬──────┘
                         │            │           │
                 Sub-GHz │        NFC │      GPIO │
              CC1101 RX  │     Reader │      Pins │
     ┌───────────────────▼─┐  ┌───────▼───┐  ┌────▼──────────────┐
     │  Smart City Meters  │  │ Checkpoint│  │ Decibel / PM2.5   │
     │  & Ambient RF Pings │  │ NFC Tags  │  │ Air Quality Board │
     └─────────────────────┘  └───────────┘  └───────────────────┘
```

### A. Ambient Electromagnetic Pollution Mapping (Sub-GHz CC1101)
* **Hardware Integration:** Configure the Flipper's Sub-1 GHz transceiver (CC1101) to run in a low-power packet sniffer mode.
* **Data Logged:** Count the density of sub-GHz transmissions (e.g., 433 MHz car keyfobs, 868/915 MHz smart utility meters, weather station pings, wireless doorbells) per second. Log this as a `subghz_rssi_density` column.
* **Research Value:** Correlate ambient RF congestion and invisible electromagnetic activity with tonic arousal to study if high RF congestion acts as a subconscious stressor or indicates high-density human activity.
* **Telemetry Option:** Use the CC1101 transceiver to transmit the participant's real-time GSR levels to a base station, enabling live tracking during outdoor training or wilderness search-and-rescue.

### B. Physical Landmark Checkpoints (NFC / RFID Reader)
* **Hardware Integration:** Keep the Flipper's NFC (13.56 MHz) or RFID (125 kHz) reader module listening in the background during a session.
* **Data Logged:** Place NFC tags at major landmarks (e.g., entrance to a park, a specific street crossing). When the user taps the Flipper against the tag, log a `checkpoint_id` and timestamp in the CSV.
* **Research Value:** Provides high-fidelity, user-initiated checkpoint annotations directly in the tracking log. This establishes clean ground-truth boundaries for pre/post-intervention stress analysis (e.g., comparing stress strictly *inside* the park boundaries vs. *outside*).

### C. Public Infrastructure IR Sniffing (Infrared Receiver)
* **Hardware Integration:** Bind the Flipper's front-facing Infrared (IR) photodiode receiver to monitor ambient IR traffic.
* **Data Logged:** Log flashes or carrier frequencies from public pedestrian crossing lights, speed cameras, transit gates, or digital billboards as an `ir_signal_count` field.
* **Research Value:** Maps active automated city infrastructure. Correlates human stress directly with regions of dense infrastructure monitoring and automated surveillance signals.

### D. Multi-Sensor Environmental Expansion (GPIO Interface)
* **Hardware Integration:** The Flipper's 18 GPIO pin headers interface via SPI, I2C, UART, or ADC.
* **Data Logged:** Wire an external **PM2.5/PM10 particulate air sensor** (via UART) and an **analog decibel microphone module** (via ADC) to the Flipper GPIO ports alongside the GSR ADC pin and GPS UART pin.
* **Research Value:** Logs a fully synchronized multi-parameter environmental file (Skin Conductance + GPS Coordinates + Decibel Noise levels + Air Quality). This allows the visualizer to plot decibels vs. GSR directly, isolating acoustic-induced arousal spikes from other stressors.

### E. The Electromagnetic Fog Index (EMF-I)
* **Hardware Sweep Mechanism:** Configure the CC1101 in the Flipper firmware to perform a fast, sequential sweep across the four primary sub-GHz ISM bands every 100 milliseconds (matching our 10 Hz recording rate):
  1. **315 MHz** (garage doors, keyfobs, home security)
  2. **433.92 MHz** (wireless weather sensors, doorbells)
  3. **868.3 MHz** (European smart city meters, mesh lights)
  4. **915 MHz** (US smart utility meters, RFID trackers)
  
  The sweep takes approximately 30 milliseconds (7.5 ms per band to allow PLL frequency lock and RSSI stabilization), leaving the remaining 70 ms of the cycle for writing the log to SD and updating the local LCD.
* **Mathematical Calculation:** Convert the logarithmic RSSI readings (ranging from $-100\text{ dBm}$ [silence] to $-30\text{ dBm}$ [heavy saturation]) to a normalized scale from 0.0 to 1.0:
  $$P_{\text{band}} = \text{clamp}\left( \frac{RSSI_{\text{band}} - (-100)}{-30 - (-100)}, \, 0.0, \, 1.0 \right)$$
  Combine these normalized powers using a Root-Mean-Square (RMS) formula to emphasize localized saturation peaks in any single band, and scale to 100:
  $$\text{EM-Fog}(t) = \sqrt{\frac{P_{315}^2 + P_{433}^2 + P_{868}^2 + P_{915}^2}{4}} \times 100$$
* **Logged Fields (CSV Schema):**
  * `subghz_em_fog`: Calculated composite EMF-I (0–100).
  * `rssi_315`, `rssi_433`, `rssi_868`, `rssi_915`: Raw RSSI readings preserved in dBm for downstream analysis.
* **Predictive Urban Signatures:**
  * *Suburban/Residential:* Frequent ASK/OOK packet bursts with mid-range RSSI ($-70\text{ to } -80\text{ dBm}$) due to smart doorbells and weather sensors.
  * *Commercial High Streets:* Sustained high RSSI ($-50\text{ to } -65\text{ dBm}$) on 915/868 MHz from mesh smart streetlights and RFID inventory systems.
  * *Parks & Nature Trails (Radio Silence):* Drop to thermal noise floor ($-95\text{ to } -105\text{ dBm}$) with zero packet bursts, matching parasympathetic restoration.
* **Visualization Integration:**
  * *Map Overlay (Volumetric Glow):* Render the `em_fog` metric on the Leaflet map as a translucent, glowing purple/violet heatmap overlay, showing the physical boundaries of the "electromagnetic fog" shifting across the urban grid.
  * *Waveform Scrubber:* Add the EM-Fog curve to the visualizer timeline, showing in real-time how the participant's tonic skin conductance reacted as they stepped into a saturated RF field.
* **Research Goal:** Standardize ambient RF background noise into a single continuous metric (`em_fog`) logged directly in the CSV. Plot this curve in the visualizer and correlate it against physiological stress to analyze if "electromagnetic fog" acts as a subconscious stress trigger in urban areas.
* **EM-Fog as a High-Fidelity Proxy for Built Density:** In urban planning studies, the EM-Fog Index serves as a reliable **surrogate marker for built density, commercial activity, and pedestrian/vehicle volumes.** Areas with high EM-Fog inherently overlap with regions of high acoustic decibels, low sky-view factors, and intense visual complexity. Thus, even when controlling for direct biophysical RF interactions, the index acts as a powerful composite indicator of environmental sensory overload.

### F. Practical Firmware Implementation Details & SDK API Integration
Integrating the Electromagnetic Fog Index into the current Flipper Zero C application is highly straightforward due to the clean abstraction of the Flipper's Hardware Abstraction Layer (`furi_hal_subghz` APIs).

#### 1. Hardware Abstraction Layer Access
The Flipper SDK provides direct, hardware-supported functions for manipulating the TI CC1101 transceiver:
* `furi_hal_subghz_init()`: Configures the SPI interface and powers on the transceiver.
* `furi_hal_subghz_sleep()`: Powers down the transceiver (putting CC1101 into low-power SPWD mode, drawing $<1\ \mu\text{A}$).
* `furi_hal_subghz_tune(frequency)`: Sweeps the local frequency synthesizer.
* `furi_hal_subghz_rx_enable()`: Enables the LNA and receiver.
* `furi_hal_subghz_get_rssi()`: Direct read of the CC1101's internal RSSI status register (converts register value directly to signed dBm).

#### 2. Loop Execution & Thread Scheduling
The BioMapping session thread (`biomap_session.c`) runs a periodic loop triggered by a hardware-backed timer at 10 Hz (`TICK_HZ=10`). 
* **Non-Blocking Sweep:** The 30 ms sweep does not freeze the Flipper. We execute `furi_delay_ms(5)` during frequency locks. Because the Flipper runs on **FreeRTOS**, calling `furi_delay_ms` yields execution, allowing the CPU to schedule other critical background tasks (such as GPS NMEA UART buffer flushing and GUI thread drawing) while the logging thread waits.
* **Power Conservation Scheme:** Continuous radio listening draws $\approx 18\text{ mA}$. To prevent draining the Flipper's battery, we implement a duty-cycled power scheme:
  * **0ms - 30ms:** Wake the radio, tune and sweep RSSI across the 4 bands.
  * **30ms - 100ms:** Call `furi_hal_subghz_rx_disable()` and `furi_hal_subghz_sleep()`.
  This duty cycle restricts active power consumption to only $30\%$ of the cycle, reducing the battery footprint of the Sub-GHz sniffer by **$70\%$** and preserving single-charge operation for full-day field walks.

---

## 7. Precedents in Urban EMF Mapping

Mapping ambient electromagnetic fields in cities has emerged as an active area of research in environmental epidemiology and smart city cartography:

* **Mobile Urban EMF Auditing (Basel, Ghent, Brussels):**
  * *Urbinello et al. (2014) & Senn et al. (2015):* Researchers equipped participants with portable RF exposure meters (exposimeters) and GPS trackers to map radiofrequency radiation across different microenvironments. They walked and cycled standardized city routes, producing spatial exposure maps showing that **public transport vehicles and commercial pedestrian corridors** had the highest exposure levels, while municipal parks and suburban buffer zones had the lowest.
* **Mobile Scanner Integration (Aerts et al., 2016):**
  * Developed vehicular and bicycle-mounted RF logging systems, proving that high-frequency spatial variation in cities is extremely local (fluctuating sharply within 10–20 meters based on line-of-sight to local emitters). This reinforces the value of Flipper-scale localized micro-antenna logging over macro-scale regional simulation maps.
* **WiFi and RF Art Collaborations (Digital Ethereal, 2014):**
  * Creative cartography projects mapped the visual "ghosts" of public and private wireless networks in urban spaces using long-exposure photography and custom RF-intensity light sticks, demonstrating that mapping invisible wireless signals dramatically changes how citizens perceive and interact with public spaces.
* **Autonomic Responses to Perceived Exposure:**
  * *Rubin et al. (2005) & Andrianome et al. (2016):* Double-blind provocation tests on self-reported Electromagnetic Hypersensitivity (EHS) subjects showed that while individuals could not physically detect active RF fields, their **GSR and heart rate spiked significantly when they believed exposure was present** (the nocebo effect). This indicates that the cognitive perception of high-technology zones serves as a strong psychological driver of ANS arousal, making spatialized EMF maps a valuable tool for behavioral geography.

---

## 8. Integration Blueprint for Visualizer Features

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
