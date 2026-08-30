# GPS Pipeline & Filter Architecture

**Written:** 2026-07-15 · **Last checked against code:** 2026-08-30
**Scope:** Complete overview of the GPS processing pipeline, from firmware-level quality gating through to downstream spatial analysis filters.
**Files:** `firmware/modules/gps_uart.c`, `firmware/biomap_types.h`, `firmware/biomap_session.c`, `visualiser/src/gps/gps_filter.js`, `visualiser/src/gps/gps_pipeline.js`, `visualiser/src/gps/map_match.js`, `visualiser/src/map/map.js`

> The filter stages and their order still match the code as of the
> last-checked date. For the authoritative, versioned CSV column list see
> [`csv_schema.md`](csv_schema.md) — the abbreviated history in §4 below is
> kept only for the context it gives the pipeline discussion.

---

## 1. Overview & Pipeline Order

The BioMapping GPS pipeline ingests raw NMEA data from the GPS chip (typically Quectel L76K or u-blox M10Q) on the Flipper Zero hardware, performs light validity checking (NaN guards, fix-validity flags), logs every reported fix to an SD card, and then applies a multi-stage post-processing filter pipeline in the web-based analyzer.

The sequence of filters applied to the track data is ordered as follows:

```mermaid
graph TD
    A[Raw GPS CSV Row] --> B[HDOP Gate <br/> maxHdop = 3.0]
    B --> C[Fix-Type Gate <br/> minFixType = 2]
    C --> D[Stop-Averaging <br/> Stationary Centroid Clamping]
    D --> E[Speed Plausibility Filter <br/> Doppler & Fallback Speed Check]
    E --> F[Velocity-Aided Smoothing <br/> Dead-Reckoning & ZUPT]
    F --> G[HMM-Viterbi Map Matcher <br/> OSM Road snaps if enabled]
    G --> H[DOP-Adaptive Kalman Filter <br/> with Chi-Squared Innovation Gate]
    H --> I[RTS Backward Smoother <br/> Zero-Phase Smoothing & Clamp]
    I --> J[Downsampling for Display <br/> downsample rate]
    J --> K[RDP Simplification <br/> Ramer-Douglas-Peucker]
    K --> L[Leaflet Rendering]
```

---

## 2. Firmware-Level Gating & Parsing

### 2.1 NaN Guarding & Validity Checks (`modules/gps_uart.c`)
- **DOP Safety**: `minmea_tofloat` returns `NaN` for missing fields. During fix acquisition, GSA/GGA sentences may omit DOP. The firmware uses temporary floats and only overwrites coordinates/DOPs if the values are valid (non-NaN) real numbers.
- **GLL Validity Flag**: The firmware verifies `gll_frame.status == MINMEA_GLL_STATUS_DATA_VALID` before updating coordinates from GLL, preventing void coordinates from overwriting good ones.

### 2.2 Quality Gating (`biomap_session.c`)
- **No HDOP gate**: The firmware applies no record-time HDOP threshold. `get_gps_position()` marks a row's coordinates valid on `fix_valid || fix_quality > 0` plus non-NaN lat/lon, and every fix the receiver reports is logged — all quality filtering is left to the visualiser, so urban-canyon data is never permanently discarded.
- **Empty Rows**: Ticks with no fix write empty coordinates (`timestamp,,,,,,,,,gsr_raw,`) to maintain column counts and temporal continuity.

### 2.3 CSV Header Layout
The current CSV log format consists of 11 columns:
```csv
timestamp,lat,lon,hdop,pdop,sats,fix_type,speed_kts,course_deg,gsr_raw,hacc_m
```
`hacc_m` is the u-blox M10Q's own EKF-computed horizontal accuracy in meters, from `$PUBX,00` Field 9. It is `99.9` (unknown) on L76K hardware, which never emits `$PUBX,00`, and before the first such sentence arrives on M10Q.

---

## 3. Visualiser Processing Pipeline

### 3.1 Quality Gates (`gps_pipeline.js`)
1. **HDOP Gate (`applyHdopGate`)**: Rejects points with `hdop > maxHdop` (user-adjustable in UI, default `3.0`). Points lacking HDOP are kept.
2. **Fix-Type Gate (`applyFixTypeGate`)**: Filters out points with `fix_type == 1` (no fix). Retains 2D/3D fixes (`fix_type >= 2`).

### 3.2 Pre-Kalman Cleaning & Smoothing (`gps_filter.js`)
3. **Stop-Averaging (`applyStopAveraging`)**:
   - **Purpose**: Eliminates the positional jitter circle drawn by GPS chips when stationary.
   - **Mechanism**: Groups consecutive points where the Doppler speed is below `stationaryKts` (default `0.5` knots) into clusters of size $\ge$ `minClusterPoints` (default `3`).
   - **Centroid Locking**: Locks the coordinates of all points in the cluster to the centroid of the cluster. This preserves temporal index mapping and avoids interpolation drift during pauses.

4. **Speed Plausibility Filter (`applySpeedFilter`)**:
   - **Mechanism**: Checks speed between points. It prefers Doppler-derived `speedKts` (knots converted to m/s, accurate to ~10× over position derivation) for true GPS epochs ($dt \ge 0.15$ s). For sub-epoch steps ($dt < 0.15$ s) caused by 10 Hz interpolation, it falls back to position-derived speed (haversine distance divided by $dt$).
   - **Recovery Latch**: If 10 consecutive points are rejected, the filter recovers by committing the last known coordinates but advancing the time, ensuring a spatial lock while preventing timeline gaps.

5. **Velocity-Aided Position Smoothing (`applyVelocitySmoothing`)**:
   - **Mechanism**: Dead-reckons a predicted position from the prior coordinate using Doppler speed and course:
     $$\text{pred\_pos} = \text{prev\_pos} + \text{speed\_ms} \times dt \times \begin{bmatrix} \cos(\theta) \\ \sin(\theta) \end{bmatrix}$$
   - **Unit Vector Heading Smoothing**: Converts the heading angle into a 2D unit vector, blends it with the previous direction using an Exponential Moving Average (EMA) to filter noise, and re-normalizes it. This avoids the $360^\circ$ boundary wrap-around bug.
   - **Zero-Velocity Update (ZUPT)**: If the speed $\le 1.2$ knots, heading vectors become erratic. The algorithm sets displacement to 0 (freezing the prediction) and overrides the GPS trust weight to a minimum ($0.05$).
   - **DOP-Adaptive Blending**: Blends the dead-reckoned prediction with the raw GPS coordinate using a trust weight $\alpha$ scaled by DOP:
     $$\alpha_{\text{effective}} = \text{clamp}\left(\frac{\alpha_{\text{base}}}{\text{DOP}}, 0.05, 0.98\right)$$
     $$\text{blended\_pos} = \alpha_{\text{effective}} \times \text{GPS\_fix} + (1 - \alpha_{\text{effective}}) \times \text{predicted\_pos}$$
     This de-weights the GPS fix during high-DOP intervals (e.g. multipath).

### 3.3 Map Snapping (`map_match.js` & `gps_pipeline.js`)
6. **HMM-Viterbi Map Matcher (`MapMatcher.match`)**:
   - **Purpose**: Global sequence map matching to snap trajectories to real road segments.
   - **Emission Probability**: Models a Gaussian distribution based on orthogonal distance $d$ to the candidate road segment:
     $$\log p(z \mid r) = -0.5 \cdot \left(\frac{d}{\sigma}\right)^2 - \log(\sigma \sqrt{2\pi})$$
   - **Transition Probability**: Models an exponential penalty on the difference between straight-line GPS distance and approximate routing distance between candidates:
     $$\log p(r_j \mid r_i) = -\frac{|d_{\text{GPS}} - d_{\text{route}}|}{\beta} - \log\beta$$
     Jumping parallel streets or traversing disconnected roads results in huge penalties.
   - **Viterbi Selection**: Computes the globally most likely candidate path.
7. **Snap Correction (`applySnapCorrection`)**:
   - Blends raw and snapped coordinates based on a confidence value $\alpha$ stored in `snappedGps`.

### 3.4 Kalman Filter & Zero-Phase Smoothing (`gps_filter.js`)
8. **DOP-Adaptive Kalman Filter (`applyKalman`)**:
   - **DOP Scaling**: Base measurement noise variance $R$ is scaled by $\text{DOP}^2$, preferring chip-computed `pdop` over `hdop`, clamped to $[0.5, 10.0]$:
     $$R_{\text{effective}} = R_{\text{base}} \times \text{DOP}^2$$
   - **Chi-Squared Innovation Gate**: Inside the forward Kalman pass, measurement innovation is checked:
     $$\chi^2_{\text{lat}} = \frac{(\text{lat}_{\text{meas}} - \text{lat}_{\text{pred}})^2}{P_{\text{pred}} + R_{\text{effective}}}$$
     Rejects coordinates whose innovation exceeds $\chi^2 = 9.0$ ($3\sigma$ threshold for 1 DOF, representing $99.7\%$ confidence). Upon rejection, the process covariance $P$ is multiplied by $5.0$ to expand the search radius and prevent filter lockout.

9. **Rauch-Tung-Striebel (RTS) Smoother (`applyKalman` backward pass)**:
   - Performs a zero-phase backward smoothing pass using the forward covariance histories to resolve delay lags.
   - **Displacement Clamp**: Clamps the final smoothed position to be within $3\sqrt{R_{\text{base}}}$ meters of the raw coordinate, preventing the smoother from pulling corners or straightaways too far from actual coordinates. Scales degrees to meters using $\cos(\text{lat})$ for longitudinal displacements to prevent clamp bias.

### 3.5 Post-Processing & Display (`gps_pipeline.js` & `gps_filter.js`)
10. **Downsampling for Display (`downsampleForDisplay`)**: Retains every $N$-th point (sample rate, e.g. downsampling from 10 Hz recording down to 1 Hz) for Leaflet performance.
11. **Ramer-Douglas-Peucker (`applyRDP`)**: Reduces track vertices within a physical distance tolerance to keep page rendering lightweight.

---

## 4. CSV Version History

Superseded — the canonical, up-to-date version history and column list live
in [`csv_schema.md`](csv_schema.md) (currently at v1.9: RF columns, a runtime
debug-column toggle, metadata-header lines, and integrity CRC32 brackets). The
columns this pipeline actually consumes — `lat`, `lon`, `hdop`, `pdop`,
`fix_type`, `speed_kts`, `course_deg`, `hacc_m` — have been stable since
schema v1.2.

---

## 5. Parameter Guidelines & Tuning

The filters can be tuned in the visualiser interface:
- **Smoothing ($\alpha_{\text{base}}$)**: Controls velocity-aided smoothing. Default `0.5`. Lower values trust dead-reckoning more; higher values trust the raw GPS coordinate.
- **Process Noise ($Q$)**: Kalman process variance. Default `0.5` $m^2$.
- **Measurement Noise ($R$)**: Kalman measurement variance. Default `10.0` $m^2$.
- **RDP Tolerance**: Trajectory simplification distance. Default `0.5` meters.
- **Stationary Threshold**: Stop-averaging speed gate. Default `0.5` knots.

---

## 6. Direct Spatial Error (`hAcc`) Integration

Measurement noise variance $R$ in the Kalman filter ([`gps_filter.js`](../visualiser/src/gps/gps_filter.js)) now prefers the physical accuracy estimate over DOP-scaling when it's available:

$$R_{\text{effective}} = \begin{cases} (\text{hacc\_m})^2 & \text{if hacc\_m valid (M10Q, post-fix)} \\ R_{\text{base}} \times \text{DOP}^2 & \text{otherwise (L76K, or pre-fix)} \end{cases}$$

### The `hAcc` Spatial Error Advantage
The u-blox SAM-M10Q calculates **`hAcc`**—the actual physical horizontal position error in meters—via its internal extended Kalman filter covariance matrix, transmitted in the `$PUBX,00` NMEA sentence. The Flipper firmware (`modules/gps_uart.c`) extracts `hAcc` for live OLED display and, as of CSV schema v1.2, logs it as `hacc_m`.

1. **Direct Kalman Variance Assignment:** When `hacc_m` is valid (not the `99.9` sentinel), the visualiser's Kalman filter (`gps_filter.js`, `getEffectiveRm2()`) assigns physical measurement variance directly instead of scaling by DOP².
2. **Pre-Kalman Velocity Smoothing:** `applyVelocitySmoothing()` (`gps_filter.js`) runs immediately before the Kalman step and independently blends each fix with a dead-reckoned prediction, trusting the raw fix proportionally to DOP. It applies the same `hacc_m` preference (converted to a DOP-equivalent via the `hAcc ≈ HDOP × 2.5` relationship used for the OLED fallback), so a bad-hacc/good-HDOP point isn't over-trusted at this stage before Kalman gets to see it.
3. **Urban Canyon Multipath Rejection:** In urban canyons or under wet tree canopies, satellite geometry often remains acceptable ($\text{HDOP } 1.2$), causing DOP-based estimation to under-estimate measurement noise. However, physical multipath reflections cause true `hAcc` to spike from $1.5\text{ m} \longrightarrow 15.0\text{ m}$. With $R = 15^2 = 225$, the Kalman filter immediately de-weights the multipath outlier and dead-reckons smoothly past the anomaly.
4. **L76K fallback:** `hacc_m` is u-blox-only (`$PUBX,00` is a u-blox proprietary sentence). On L76K hardware, or before the first `$PUBX,00` sentence arrives on M10Q, `hacc_m` stays at its `99.9` sentinel and both consumers above fall back to the existing DOP-based scaling — HDOP/PDOP remain necessary as the universal fallback, not redundant.
5. **True Ground Error Heatmaps** (not yet implemented): visualizer tooltips/overlays showing exact ground uncertainty bounds ($\pm X.X\text{ m}$) per sample remain a future enhancement.
