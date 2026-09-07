# Todo

Loose ideas and unscheduled work. Promote anything real to its own doc under `docs/`.

## Priority


remove slider 
GPS Precision (#gpsKalmanR, 0.5–150 m²)





- sound annotations -
Allow people to record little audio snippets attached to peaks and hotspots. Investigate how they could be saved on the server and then played back. Maybe these could be from an audio file recorded at the same time and then timestamped to correlate, or they could be simply looking at the map, pressing a record button over the hotspot 

- **Airport / acoustic context** — would a microphone make sense there? See
  [acoustic_aircraft_detection_proposal.md](acoustic_aircraft_detection_proposal.md).

## Analysis ideas

- Correlate GSR against the 868 and 915 MHz RF bands.
- **Fourth RF band — which frequency?** The sweep is fixed at 815 / 868 /
  915 MHz (`EM_SCAN_NUM_FREQS == 3`).
  [rf_319_investigation.md](rf_319_investigation.md) works through the
  mechanical cost of a 4th slot but assumes the band is 319 MHz — a
  North-American security-sensor frequency that would mostly read the noise
  floor on UK/EU walks. That choice was never tested against alternatives.
  How to pick it properly:
  - **Fix the regulatory domain first — this decides most of it.** EU walks →
    433.92 MHz ISM (key fobs, TPMS, weather stations, garage remotes, cheap
    telemetry) is the obvious prime candidate; 868 is already covered. Other
    EU options: 446 MHz PMR446, 380–400 MHz TETRA (emergency services, strong
    in cities), ~466 MHz POCSAG paging. US walks → 315 / 319 MHz.
  - **Wideband recon, no firmware change.** RTL-SDR + `rtl_power` sweep across
    ~300–928 MHz for an hour at 3–4 representative spots on a normal route
    (home, busy road, park, station). The spectrogram shows which bands
    actually light up locally and vary between locations.
  - **Shortlist 2–3 fixed frequencies** from where the recon shows real,
    location-varying activity — not a band pinned at the noise floor
    everywhere.
  - **Survey build (optional).** Temporarily swap the 3 fixed bands for the
    shortlist (or add a 4th slot) and log 3–5 real walks.
  - **Score each candidate offline:** dynamic range (p95−p5 of RSSI); spatial
    clustering (real hotspots vs white noise); correlation with the existing
    3 bands (want something *orthogonal*, not a copy of 868); and
    correlation / mutual information with GSR — the actual research question.
    Weigh against the sub-400 MHz hardware penalty: antenna mismatch raises
    the noise floor (~-76 vs -91 dBm) and forces the relaxed calibration
    ceiling noted in the 319 doc.
  - **Then** bump `EM_SCAN_NUM_FREQS` and follow the change-list in
    rf_319_investigation.md — it is frequency-agnostic apart from that ceiling.

## GPS pipeline architecture

High-level review of the GPS filter chain (`src/gps/gps_pipeline.js`,
`gps_filter.js`, `map_match.js`, orchestrated in
`src/map/map_manager_process.js`; overview in
`gps_filtering_pipeline.md`). The perf engineering is sound — these are
correctness / structure concerns. Promote to its own doc if picked up.

### Core issue — no single owner of the state estimate

Four independent passes each blend a prediction against the raw fix, each
with its own hand-tuned trust heuristic (`α_base/DOP`, `snappedGps.alpha`,
`R_base·DOP²`, clamp `3·√R_base`), tuned in isolation, interactions
uncharacterised:

- Velocity-aided smoothing pre-pulls each fix toward a dead-reckoned path,
  then the Kalman treats that pre-smoothed point as an *independent*
  measurement with variance `R` — the same correction is counted twice
  (the "covariance deflation" the fix-only Kalman input is meant to
  avoid). Fold velocity smoothing into the Kalman as a proper
  constant-velocity motion model + process noise instead of a separate
  EMA stage.
- **Snap fires before the χ² innovation gate.** A wrong parallel-street
  snap gets baked into the "measurement", and the 3σ gate then rejects
  the *good* raw points that disagree with it. Snap should be a soft
  constraint inside/after the filter, or the gate should see raw and
  snapped separately.

### Remove

- One smoothing pass (velocity smoothing → into Kalman, per above).
- Fixed-stride `downsampleForDisplay` on the live path — time-uniform and
  geometry-blind (drops corners, keeps redundant straightaway points).
  RDP + a max-vertex cap does the job better; the method's own comment
  says the live path already uses `buildDrawPoints` and this form only
  survives for globe3d/tests.
- Duplicate hAcc/DOP noise model — `getEffectiveRm2()` and
  `applyVelocitySmoothing` each reimplement "prefer `hacc_m` unless 99.9,
  else DOP², prefer `pdop`, clamp [0.5, 10]" plus the hand-maintained
  `hAcc ≈ HDOP×2.5` inverse. Two places, drift hazard.
- §4 (CSV version history) of `gps_filtering_pipeline.md` — already says
  "superseded, see `csv_schema.md`".

### Add

- **One `measurementVarianceM2(row)`** noise-model function, consumed by
  every stage.
- **Velocity-based 10 Hz reconstruction.** `reconstructFilteredGps`
  currently draws straight chords between filtered fixes; the smoothed
  Kalman state already has velocity — reconstruct with constant-velocity /
  cubic Hermite for a faithful path at ~zero extra cost. Cornering at
  speed currently renders as a polyline chord.
- **Per-track GPS quality report** — the chain silently drops points at
  four stages (HDOP gate, fix-type gate, speed-filter recovery latch, χ²
  rejections, RTS clamp saturation). Surface `{n_raw, n_gated,
  n_innovation_rejected, median_hacc, pct_interpolated, longest_gap_m}` to
  the user and to the environmental-analysis layer, so coordinate
  uncertainty propagates into the significance tests.
- **Distance/speed-aware gap rule** to replace the flat
  `GPS_INTERP_MAX_GAP_S = 30`. 30 s stationary is fine; 30 s at walking
  pace is ~42 m of invented path. Break interpolation when implied speed >
  `maxSpeed` or gap distance > threshold.
- **O(n) cache checksum.** `_snapFingerprint` and
  `reconstructFilteredGpsCached` hash first/mid/last samples as a proxy
  for "array changed" — a mid-track change that doesn't move the mid
  element is a silent stale render. A running `Σ(lat·31 + lon)` is O(n)
  once and removes the bug class.
- **Characterisation harness** — run the pipeline over the fixture tracks
  and assert aggregate metrics (total length, vertex count, %
  interpolated, max deviation from raw) stay within bounds, so a
  filter-tuning change can't silently distort every track.

### Smaller notes

- Q and R sliders (m², with χ² gates) aren't tunable by a field
  researcher — they invite cargo-cult fiddling that shifts conclusions.
  Consider one "trust GPS ↔ trust smoothing" slider mapped to joint (Q,R)
  presets, the rest behind an "advanced" disclosure.
- `_collectGpsPoints` hand-copies 10 fields (deliberate, per the
  profiling comment) — a test asserting the filter stages only read those
  keys would stop the list rotting silently.

## Not priority

- **Server upload** — push live data on to a server (e.g. for a flight-radar
  link). The Flipper → browser half already exists as Live Stream / `live.html`;
  this is only the onward upload.
- **Physical form factor** — 3D-printed case.
- **Typographic long annotations (visualiser)** — peak labels can now hold long,
  sentence-length notes, but the display paths still assume a short tag: the
  graph renderer hard-truncates to 22 chars + "…"
  (`src/render/renderer.js` ~L523), the map label caps text width at 160 px on a
  single unwrapped line (`GSRLabelManager.textWidth` in
  `src/render/label_placement.js`), and the 3D globe label
  (`src/map/globe3d.js` ~L1727) and map-popup editor
  (`src/map/map_popups.js`) are single-line too. Render long notes as
  properly set, wrapped blocks of text — sensible measure, hyphenation/wrap,
  max width and line count — instead of one very long line or an arbitrary
  character cut.

## Loose ends from closed investigations

Carried over from archived investigations (`archive/gps_rf_mutex_status.md`,
`archive/bluetooth_serial_investigation.md`,
`archive/visualizer_architecture_refactor_plan.md`) — primary objectives are
done; these are the optional follow-ups still worth doing.

### Firmware

- **Live Stream (BLE) on-hardware field validation** (from
  `archive/bluetooth_serial_investigation.md` §10 Phase 3) — the only Live
  Stream phase left. On a real walk: battery endurance during active BLE
  broadcasting, Android Chrome reconnection when the phone display sleeps or
  goes in a pocket mid-walk, and packet-drop rates (`bt_telemetry` debug line
  already logs `bt_tx_peak_ms` / `bt_drop`).
- **`gsr->available` dead code** — set `true` unconditionally at alloc, never
  set `false`; every `if(!gsr->available) return;` guard in
  `modules/gsr_sensor.c` is unreachable. Removing it touches ~20 accessor
  call sites plus `gsr_sensor_available()` for zero behaviour change. Purely a
  tidy-up, doable any time.
- **RF/GSR concurrency — test-coverage gaps** (from
  `archive/gps_rf_mutex_status.md`). Both low priority, no suspected defect:
  - The RF-vs-GSR TOCTOU is covered by a stress test that raises confidence
    but isn't a deterministic proof. A proof needs a test-only sync hook
    inside `gsr_sensor_worker()` to pause it exactly between reading
    `rf_enabled` and setting `rf_spi_busy` — production instrumentation purely
    for testability, so it needs a deliberate decision before adding.
  - No test for the reverse direction (a slow I2C read blocking RF's snapshot
    read). Writable without new hooks; I2C was never part of the reported bug
    and isn't under any RF mutex anyway, so it's a coverage gap only.

### Visualiser

- **Dense-track label collision profiling** (from
  `archive/visualizer_rendering_perf_routes.md` §2.3) — `computeLabelPositions`
  in `src/render/label_placement.js` runs an O(N²) simulated-annealing pass
  (`ITERS = max(300, N*30)`, each iteration scanning all N boxes twice).
  Profile it on tracks with >100 peaks to decide whether the overlap checks
  need spatial partitioning.
