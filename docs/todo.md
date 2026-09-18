# Todo

Loose ideas and unscheduled work. Promote anything real to its own doc under `docs/`.

## Priority


- shoould we embedd the calibration age into the csv header? helps with tracebility

- **Sound annotations** — allow people to record little audio snippets attached
  to peaks and hotspots. Investigate how they could be saved on the server and
  then played back. Maybe these could be from an audio file recorded at the same
  time and then timestamped to correlate, or they could be simply looking at the
  map, pressing a record button over the hotspot. 

- **Airport / acoustic context** — would a microphone make sense there? See
  [acoustic_aircraft_detection_proposal.md](acoustic_aircraft_detection_proposal.md).

## Firmware architecture (structural refactor)

From a full read of `firmware/` (2026-09). Ordered by payoff:

- **P1 — Split RF scanning out of `gsr_sensor`.** The CC1101 RF path is
  bolted onto the ADS1115 GSR worker (`modules/gsr_sensor.c/h`), so GPS+RF
  mode (`BioMapModeGpsOnly`, no GSR) allocates a "GSR sensor" only to run
  RF. Extract an `rf_sensor` module with its own lifecycle; the dual-mutex
  (`mutex` vs `rf_mutex`) complexity then disappears.
- **P2 — Unify persistence.** Three hand-rolled versioned-blob load/save
  paths (GSR cal FNV-1a in `biomap.c`, settings FNV-1a, RF cal CRC32 in
  `em_scan_cal.c`) each repeat open→validate→atomic-rename. One shared
  `persist_blob()` helper + one checksum.
- **P3 — Split `biomap_session.c` (1083 lines).** Lifecycle + keys + tick +
  SD-flush state machine + Live Stream + telemetry all in one file. Extract
  `biomap_keys.c` / `biomap_tick.c` / `biomap_diag.c` along existing
  `static` boundaries.
- **P4 — Slim `biomap.h`.** Move persistence structs → `biomap_persist.h`,
  wizard states → `biomap_wizard.h`.
- **P5 — One "RF active" rule.** `has_rf()` (includes Diagnostics) vs the
  literal `rf_viz` gate in `biomap_render.c` are two drifting definitions.
- **P6 — Hygiene.** Move `sound.h` melodies to a `sound.c` — header-only
  `static inline` is currently harmless, but a bigger header→TU migration
  than the other hygiene items already done (`PluginEvent`→`BioMapEvent`
  rename, `gps_uart.h` include reorder).

## Analysis ideas

- **Named Map Feature Associations & Corridor Profiles:** Extract `tags.name`,
  `tags.amenity`, `tags.shop`, and `tags.leisure` from the existing Overpass query
  (no new network requests). Correlate GSR peaks and baseline arousal directly with
  named streets (*"Kingsland High St"* vs *"Quiet Mews"*), prominent POIs/venues
  (*"Rio Cinema"*, *"Dalston Junction Station"*), and urban functional typologies.
  Automatically assign human-readable names to Arousal Places (`arousal_places.js`)
  via spatial consensus. Full proposal in
  [`spatial_semantics_and_annotation_analysis_plan.md`](spatial_semantics_and_annotation_analysis_plan.md).
- **Textual & Sentiment Analysis on User Annotations:** Run client-side NLP
  lexicon scoring (AFINN/VADER) on user peak labels (`analyzer.setPeakLabel`) to
  extract emotional **Valence** (pleasant vs unpleasant). Project onto the Russell
  Affect Circumplex ($\text{Arousal (GSR)} \times \text{Valence (Text)}$) to separate
  stress/fear from joy/excitement. Classify trigger keywords into 6 urban domains
  (traffic, acoustic, social, nature, architectural, physical) and calculate
  word-to-SCR-amplitude rankings. Details in
  [`spatial_semantics_and_annotation_analysis_plan.md`](spatial_semantics_and_annotation_analysis_plan.md).
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
- ~~Duplicate hAcc/DOP noise model~~ — done (2026-09-18): extracted
  `GpsFilter.measurementVarianceM2(pt, R_base_m2)` (the canonical hacc/DOP²
  model, used directly by `applyKalman`) and `GpsFilter._preferredDop(pt,
  fallbackDefault)` (the shared pdop-then-hdop preference chain, used by
  both `measurementVarianceM2` and `applyVelocitySmoothing`). The `hAcc ≈
  HDOP×2.5` conversion stays local to `applyVelocitySmoothing` — it's a
  genuinely different quantity (a unitless DOP-equivalent divisor for the
  alpha blend, not a variance scaled by the Kalman R slider), not
  accidental duplication. Byte-identical output confirmed via
  test_gps_characterization.js (no baseline change needed) + full suite.

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
- ~~**Distance/speed-aware gap rule**~~ — done (2026-09-18): replaced the
  flat `GPS_INTERP_MAX_GAP_S = 30` with a plausibility gate in
  `reconstructFilteredGps` — blanks a gap to NaN when its implied speed
  exceeds `maxSpeed` (threaded through from the same param used by the
  speed filter/Kalman Q) or its straight-line distance exceeds 100 m,
  otherwise draws the chord regardless of how long the gap lasted. A 143 s
  real-track gap that only moved ~37 m (0.26 m/s) now interpolates instead
  of blanking; a synthetic ~111 m/s gap that used to slip through at <30 s
  now correctly blanks (caught by test_refactor.js, which had that exact
  unrealistic fixture — fixed alongside this). Verified via
  test_gps_characterization.js (committed fixture unaffected — no gaps
  >30s in it either way; local tracks' sanity bounds still hold) + full
  suite green.
  - **Follow-up found by user testing (2026-09-18):** the map renderer had
    its *own*, separate, still-flat `> 30s` gap-break rule
    (`_renderPathSegments` in `manager/path.mjs`, used to decide whether to
    draw a connecting line vs. start a new polyline segment) — a third,
    independent copy of "is this gap trustworthy," blind to distance. At an
    aggressive Max Speed setting (e.g. 1 m/s, well under walking pace) the
    speed filter rejects nearly every real fix, occasionally leaving two
    surviving anchors 200+m apart but under a second apart in time — the
    render's time-only check drew a straight line across that regardless of
    `reconstructFilteredGps`'s (distance-aware) decision, since that
    decision only affects the *interpolated* points between two anchors,
    never whether the anchors themselves get connected. Reproduced on
    `tracks/biomap_029.csv` at maxSpeed=1 (a real ~209m/0.6s jump), fixed by
    extracting the shared decision into `GpsPipeline.isPlausibleGap(distM,
    dt, maxSpeed)` and using it in both places instead of two independent
    thresholds. New tests in test_refactor.js (5c2); verified visually
    (before/after screenshot diff on the exact repro) and via full suite.
- ~~**O(n) cache checksum.**~~ — done (2026-09-18): both
  `_snapFingerprint` (process.mjs) and `reconstructFilteredGpsCached`
  (gps_pipeline.mjs) now fold every point through an O(n) rolling hash
  (`Math.imul(hash, 31) + value`, order- and position-sensitive) instead of
  sampling first/mid/last, closing the silent-stale-cache class where a
  mid-track edit left those three positions unchanged.
- ~~**Characterisation harness**~~ — done (2026-09-18):
  `tests/test_gps_characterization.js` runs the production filter chain
  (gates → pre-Kalman filters → Kalman+RTS → 10Hz reconstruction) over
  `fixtures/default_processed.csv` and asserts total path length, vertex
  count, % interpolated, and max deviation from raw against a committed
  golden-master (`tests/fixtures/gps_characterization_baseline.json`,
  regenerated only deliberately via
  `tests/support/gen_gps_characterization_baseline.js`). It also
  opportunistically sweeps every local `tracks/*.csv` (gitignored, so
  sanity-bound checks only — no pinned values) for broader real-world
  coverage on dev machines. This is now the regression net for the filter
  reorder / fusion work still queued below (snap-vs-χ² ordering, folding
  velocity smoothing into the Kalman as a motion model).

### Smaller notes

- **Potential:** the pre-Kalman alpha above is still a fixed guess (0.5,
  `GSR_CONST.GPS_DEFAULT.smoothing`), not derived from data — it stands in
  for the trust ratio between the raw GPS fix and the Doppler-based
  dead-reckoning prediction, and today we only have a live accuracy metric
  ($hAcc$) for the GPS side. The M10Q's `UBX-NAV-PVT` message (class 0x01,
  id 0x07, 92-byte payload) carries `sAcc` (speed accuracy, mm/s, offset
  68) and `headAcc` (heading accuracy, 1e-5 deg, offset 72) — no NMEA or
  `$PUBX` sentence carries either field, confirmed against the u-blox M10
  SPG 5.10 Interface Description. With those, `applyVelocitySmoothing`
  could do real inverse-variance fusion ($R_{gps}=hAcc^2$ vs an $R_{dr}$
  derived from `sAcc`/`headAcc`) instead of the ad hoc `alpha/dop` ratio,
  removing the free constant entirely. Two real costs: (1) enabling it
  needs `CFG-MSGOUT-UBX_NAV_PVT_UART1` (key `0x20910007`) turned on *and*
  the UART1 output protocol mask flipped from NMEA-only (currently `0002`
  at [gps_uart.c](../firmware/modules/gps_uart.c) — see the "outProto"
  comment) to mixed NMEA+UBX; (2) the live RX path
  ([gps_uart.c](../firmware/modules/gps_uart.c)) is a single-byte-per-IRQ
  NMEA line accumulator with no binary-frame awareness outside the
  one-shot startup ACK/UNIQID reads — continuous NAV-PVT would need a real
  second state machine in that interrupt path to detect `0xB5 0x62` sync
  mid-stream without corrupting the interleaved NMEA lines. Then a CSV
  schema bump + visualiser parser/filter wiring on top. Worth doing if the
  fusion accuracy matters enough to justify touching the RX path; not
  attempted yet.
- **Full binary-only (UBX) GPS protocol — considered 2026-09-17, not
  recommended as scoped.** Idea: drop NMEA entirely on M10Q and read only
  binary `UBX-NAV-PVT` (+ `UBX-NAV-SAT` for the per-satellite/SBAS detail
  GSA/GSV currently provide), on the theory that less serial data would
  free main-thread time — e.g. to sample GSR more often. Investigated and
  the premise doesn't hold: GSR already runs at the ADS1115's hardware
  ceiling (860 SPS, config byte in `gsr_sensor.c`) on its own dedicated
  `GsrSensorWorker` thread, independent of the GPS main thread; and the
  CSV row rate is a fixed 10 Hz `EventTypeTick` in `biomap_session.c`,
  already rationed against GPS-parsing overrun by
  `GPS_RX_MAX_DRAIN_BYTES_PER_CALL`/`GPS_RX_MAX_LINES_PER_CALL`
  (`gps_uart.c`). Neither is CPU-starved by NMEA parsing today, so binary
  framing wouldn't change either rate. Real costs of going binary-only:
  drops L76K support entirely (Quectel, no UBX) or forces a second,
  structurally different continuous RX path keyed on `GPS_MODULE`; trades
  NMEA's self-recovering line framing for sync-byte/length/checksum binary
  framing that can misalign on a single dropped byte (existing UBX code in
  `gps_uart.c` only does this for one-shot config ACKs today, never as a
  continuous per-IRQ parser); and needs its own watchdog rewrite (current
  one is NMEA-line-validity based). Only real payoff is unlocking
  `sAcc`/`headAcc` for the fusion idea above — better captured by the
  mixed NMEA+UBX approach already noted there (add one narrow binary
  parser alongside the working NMEA path) than by a full protocol cutover.
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

- **Live view EDASymp (idea, not scheduled)** — use a *causal* (right-aligned
  window) EDASymp variant for the live follow-map so the trail has near-zero
  lag instead of the full metric's ~32 s centred-window lag. Add it as a NEW
  function (e.g. `SpectralEDA.computeCausalSeries`) and have only the live
  view consume it (mirror its `edasymp` onto packets in `feedLiveAnalyzer`,
  like tonic/phasic) — do NOT modify `computeSeries`/`posadaSignal`/
  `welchDensity`, so the main app's shipped, NeuroKit2-cross-checked EDASymp
  stays byte-identical. Optionally gate `_computeEDASymp()` in
  `analyzer.js:analyze()` behind a flag the live view sets (default unchanged)
  to skip the redundant full computation. Accept: live EDASymp won't match the
  offline EDASymp for the same walk (it's time-shifted ~32 s) — fine for a
  live heat overlay, not for analysis. Rationale: EDASymp is per-sample,
  continuous, threshold-free and gait-immune (0.045–0.25 Hz band ≪ walking
  cadence) — the best-fit live arousal metric, better than phasic (which is
  mostly flat).

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
