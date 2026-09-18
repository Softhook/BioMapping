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

- **Velocity-aided smoothing double-count — investigated 2026-09-18, NOT
  changed.** Pre-pulls each fix toward a dead-reckoned path, then the
  Kalman treats that pre-smoothed point as an *independent* measurement
  with variance `R` — the same correction is counted twice (the
  "covariance deflation" the fix-only Kalman input is meant to avoid). The
  theoretically-correct fix is folding velocity into the Kalman as a
  proper constant-velocity motion model (position+velocity state, not
  today's two independent position-only 1D filters) instead of a separate
  EMA stage.
  Before implementing, A/B-tested the *naive* version of this fix (just
  removing `applyVelocitySmoothing` from `applyPreKalmanFilters`, feeding
  raw fixes straight to the existing Kalman) across every local track.
  Most tracks moved < 1m; several moved 10–62m (`biomap_019` worst case).
  Root-caused the 62m case: a raw GPS multipath jump (~72m sideways) whose
  *self-reported* Doppler speed happened to read low, fooling the
  (unchanged) speed filter into accepting it. With velocity smoothing:
  the dead-reckoned prediction — informed by real recent speed/course —
  recognises the jump as implausible and mostly ignores it, so Kalman
  never sees a bad measurement. Without it: the raw jump reaches Kalman
  directly, drags its internal state off course, and several subsequent
  *genuine* fixes get rejected by the χ² gate for disagreeing with the
  now-corrupted state (classic outlier-poisons-state lockout).
  **Conclusion:** velocity smoothing is not just redundant — on real
  tracks it's currently doing real outlier-rejection work the Kalman
  filter's own gate doesn't do on its own (its gate only checks "did the
  position move too far from last time," not "does this agree with the
  recently observed heading/speed"). The naive removal is a real
  regression, not a safe cleanup. The full fix (proper multi-dimensional
  CV state, so Kalman's *own* prediction — not a separate EMA stage — uses
  recent velocity to judge implausible jumps) would likely preserve this
  protection, but is a substantially bigger rewrite (new matrix-based
  filter math, current lat/lon filters aren't even coupled) with no
  ground-truth GPS data available to verify the result is actually
  better, unlike the other fixes in this section. Decided not to attempt
  it without a clearer trigger (e.g. ground-truth data becoming
  available, or a concrete complaint about tracking quality this would
  address). Left as-is.
- ~~**Snap fires before the χ² innovation gate.**~~ — done (2026-09-18):
  moved `applySnapCorrection` in `manager/process.js` to run AFTER
  `applyKalman` instead of before, so a wrong parallel-street snap can no
  longer poison the filter's internal state or be measured against by the
  RTS displacement clamp — it's now a cosmetic pull applied to the
  already-gated, already-smoothed estimate. (The HMM matcher itself was
  already computed on raw coordinates only, decoupled from this ordering —
  see `docs/gps_filtering_pipeline.md` §3.3.) Proved with a synthetic
  sustained wrong-street snap (`tests/test_gps_snap_kalman_order.js`):
  under the old order, genuine fixes resuming right after a bad-snap
  stretch were measurably pulled toward the contamination (verified by
  temporarily reverting the order and confirming the new test fails);
  under the fixed order they land within ~4m of truth (vs. ~inches of
  ordinary RTS boundary smoothing). Full suite green (1402 tests).

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
- ~~**Velocity-based 10 Hz reconstruction.**~~ — done (2026-09-18), with a
  correction: the Kalman filter does NOT actually carry a velocity state
  (confirmed while investigating the item above — it's two independent
  position-only 1D filters), so "the smoothed Kalman state already has
  velocity" wasn't accurate. Used the anchors' own raw Doppler
  speed+course instead (still present on `data[idxA]`/`data[idxB]`,
  untouched by any filter stage) as cubic Hermite tangents between
  anchors, replacing the straight-chord lerp — falls back to the
  unchanged plain lerp when either anchor lacks speed/course (~2% of real
  segments). Added an overshoot guard
  (`HERMITE_TANGENT_CLAMP_K = 1.0`, clamps each tangent to at most the
  segment's own chord length) after empirically A/B-testing against every
  local track first: median deviation from the old straight chord is
  ~0 (most inter-fix motion is already straight), p99 ~12% of chord
  length, worst case across the whole corpus ~80% of chord length (never
  a wild loop), and total reconstructed path length moves only +0.06–0.13%
  corpus-wide. New tests: `_velocityDegPerSec`/`_clampHermiteTangent`/
  `_hermitePoint` unit tests plus an integration test proving a real
  corner (different heading at each anchor) visibly bends the fill-in
  points away from the straight lerp, and a fallback test proving
  no-speed-data tracks stay byte-identical to the old behaviour. Full
  suite green (1402 tests); golden-master characterisation baseline
  unaffected (committed fixture has no Doppler data, so it already used
  the fallback path).
  **Follow-up fix (same day):** user reported broken/disconnected path
  segments on `tracks/biomap_029.csv`, 2D map only (3D globe reuses the
  same `drawPoints`, but only the 2D renderer breaks the polyline on a
  locally-implausible sub-step — see `_renderPathSegments` in
  `map/manager/path.mjs`). Root cause: `_clampHermiteTangent` compared a
  deg/**sec** tangent straight against a bare-**degrees** chord length —
  a unit mismatch that only cancelled out for ~1s anchor gaps. Worse, even
  with that fixed (clamp against chord/dtTotal, i.e. the chord's own
  average velocity), a segment whose *measured* endpoint speed undershoots
  the chord's average velocity (typically because real fixes were dropped
  mid-segment by the HDOP/fix-type gate) still forces the curve to speed
  up mid-segment to land on cB — locally exceeding maxSpeed even though
  both anchors and the chord average are fine. Fixed by building the
  candidate curve into a temp array and checking every consecutive pair
  (anchors included) against the same `isPlausibleGap` the renderer uses;
  if any sub-step fails, fall back to the plain lerp for that whole
  segment — a straight lerp's fastest sub-step is always the chord
  average, so it can never fail a check the anchor pair already passed.
  Confirmed on `biomap_029.csv`: 5 local implausible-speed sub-steps before
  the fix (only 1 with the old pre-Hermite code, a genuine single-fix
  blip), 1 after (same index, same blip). New regression test covers the
  slow-tangent/fast-chord fallback case. Suite green (1402 tests).
  **Second follow-up (same day):** user then reported the *same symptom*
  on `tracks/biomap_026.csv` at a 45 m Snap Radius, unrelated to the
  Hermite fix above — traced to the already-committed `ccc3c82` "gps
  pipeline fix" (earlier the same day, on `main`), which replaced the old
  flat 30 s-only path-break rule with the speed-aware `isPlausibleGap` in
  both `reconstructFilteredGps` and `_renderPathSegments`. That rule is
  correct in spirit, but a large Snap Radius (`_snapAlpha`'s cosine
  falloff in `map_match.mjs` pulls points far more aggressively past
  ~25 m) makes the HMM matcher more likely to snap two adjacent,
  near-simultaneous fixes onto two different nearby ways at an ambiguous
  junction — a real jump the old lenient rule would have silently drawn
  through, the new strict one correctly refuses. Per user's direction
  ("trust snap-corrected jumps more"): added
  `GpsPipeline.gapSpeedMultiplier(snappedGps, idxA, idxB)` — returns
  `SNAP_GAP_SPEED_MULTIPLIER` (4×) when both endpoints have
  `snappedGps[idx].alpha > 0`, else 1. `isPlausibleGap` now takes an
  optional multiplier; wired into both the outer anchor-gap gate and the
  new Hermite-segment plausibility check in `reconstructFilteredGps`, and
  into `_renderPathSegments`'s break check via `analyzer.snappedGps`. The
  absolute distance cap (`GPS_GAP_MAX_DIST_M` = 100 m) is untouched either
  way. New tests cover the multiplier's four alpha combinations and the
  connect/blank behaviour end to end. Suite green (1402 tests).
  **Third follow-up (same day):** user still saw breaks and asked for none,
  ever — "make the 2D map look like the 3D globe" (which never applied
  `isPlausibleGap` to begin with, so it never broke). Removed the
  plausibility-based segment split from `_renderPathSegments` entirely —
  `drawPoints` is now always drawn as one continuous polyline. This doesn't
  reintroduce fabricated data: `reconstructFilteredGps` still blanks a
  genuinely implausible gap to NaN, and `buildDrawPoints` still drops NaN
  entries, so `drawPoints` simply skips straight from the last point before
  the gap to the first point after it — the renderer just no longer
  refuses to draw a line across that skip. `isPlausibleGap` /
  `gapSpeedMultiplier` stay in `gps_pipeline.mjs` (still gate the NaN
  interpolate-vs-blank decision and the Hermite-segment fallback from the
  first follow-up above) — only the 2D-only *second* use of them, the
  render-time break, is gone. Dropped the now-unused `maxSpeed` param from
  `_renderPathSegments` and its two `render.mjs` call sites, and the
  `GeoUtils`/`GpsPipeline` imports that only served the removed check.
  Suite green (1402 tests).
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
