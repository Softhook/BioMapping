# Todo

Loose ideas and unscheduled work. Promote anything real to its own doc under `docs/`.

## Priority


- **Sound annotations** — allow people to record little audio snippets attached
  to peaks and hotspots. Investigate how they could be saved on the server and
  then played back. Maybe these could be from an audio file recorded at the same
  time and then timestamped to correlate, or they could be simply looking at the
  map, pressing a record button over the hotspot. 

- **Airport / acoustic context** — would a microphone make sense there? The
  old proposal doc (`acoustic_aircraft_detection_proposal.md`) was removed in
  commit `1a7806a`; get it back from git history if this is picked up.

## Firmware architecture (structural refactor)

From a full read of `firmware/` (2026-09-13). Re-checked 2026-09-26: the two
worthwhile items were done, the rest judged not worth doing (reasons below,
so they don't get re-proposed).

**Done**

- **P2 — Shared save code (small version, 2026-09-26).** The GSR calibration
  and settings saves in `biomap.c` now share one `write_file_atomic()`
  helper (write `.tmp`, then rename). Earlier, `5aa9a21` (2026-09-25) had
  already given them one shared FNV-1a checksum in `biomap_format.c`.
- **P4 — Slim `biomap.h` (`5aa9a21`, 2026-09-25).** The saved-file structs
  moved to `biomap_format.h`.
- **P5 — One "RF active" rule (2026-09-26).** The screen check in
  `biomap_render.c` is now `has_rf(mode) && !is_diag` instead of listing
  the RF modes by name, so a new RF mode can't be scanned but not drawn.
- **P6 — Hygiene, 2 of 3 (2026-09-17).** `PluginEvent` → `BioMapEvent`
  rename and `gps_uart.h` include reorder.

**Decided against**

- **P2, rest — make RF calibration use the same checksum / save helper.**
  RF cal lives in its own host-tested module (`em_scan_cal.c`). Switching
  its CRC32 to FNV-1a would make every existing RF calibration file invalid
  and force a new Faraday-box calibration, for no gain.
- **P3 — Split `biomap_session.c` (1092 lines).** Already divided into
  clear sections; moving them into separate files would change nothing about
  behaviour, and the file isn't host-tested, so only a compile would check
  the move.
- **P4, rest — move `WizardState` / `RfCalWizardState` to their own header.**
  ~50 lines, no payoff.
- **P6, rest — move `sound.h` melodies into `sound.c`.** Header-only
  `static inline` is harmless.

## Analysis ideas

- **Named Map Feature Associations & Corridor Profiles:** Extract `tags.name`,
  `tags.amenity`, `tags.shop`, and `tags.leisure` from the existing Overpass query
  (no new network requests). Correlate GSR peaks and baseline arousal directly with
  named streets (*"Kingsland High St"* vs *"Quiet Mews"*), prominent POIs/venues
  (*"Rio Cinema"*, *"Dalston Junction Station"*), and urban functional typologies.
  Automatically assign human-readable names to Arousal Places (`src/spatial/arousal_places.mjs`)
  via spatial consensus. The full proposal
  (`spatial_semantics_and_annotation_analysis_plan.md`) was removed in commit
  `1a7806a` — it's in git history.
- **Textual & Sentiment Analysis on User Annotations:** Run client-side NLP
  lexicon scoring (AFINN/VADER) on user peak labels (`analyzer.setPeakLabel`) to
  extract emotional **Valence** (pleasant vs unpleasant). Project onto the Russell
  Affect Circumplex ($\text{Arousal (GSR)} \times \text{Valence (Text)}$) to separate
  stress/fear from joy/excitement. Classify trigger keywords into 6 urban domains
  (traffic, acoustic, social, nature, architectural, physical) and calculate
  word-to-SCR-amplitude rankings. Details were in the same removed plan doc.
- Correlate GSR against the 868 and 915 MHz RF bands.
- **Fourth RF band — which frequency?** The sweep is fixed at 815 / 868 /
  915 MHz (`EM_SCAN_NUM_FREQS == 3`).
  `rf_319_investigation.md` (removed in commit `1a7806a`, still in git
  history) works through the
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
    rf_319_investigation.md (from git history) — it is frequency-agnostic apart from that ceiling.

## GPS pipeline architecture

High-level review of the GPS filter chain (`src/gps/gps_pipeline.mjs`,
`gps_cv_kalman.mjs`, `map_match.mjs`, orchestrated in
`src/map/manager/process.mjs`; overview in
`gps_filtering_pipeline.md`). The perf engineering is sound — these are
correctness / structure concerns. Promote to its own doc if picked up.

### Done (2026-09-25)

- The GPS filter is now a single textbook constant-velocity Kalman filter +
  backwards smoother (`gps_cv_kalman.mjs`); the old filter code is gone.
- [`gps_filter_review.md`](gps_filter_review.md) has been worked through. The
  top problem (restarting after only 0.5 s of skipped fixes, so bad stretches
  were drawn as spikes) is fixed: it now waits 10 s (`RESET_AFTER_S`) and
  rewinds to where the bad stretch began. The review doc records what was
  fixed, tested and rejected, or left alone.
- The Flipper now sends hAcc over Live Stream too, and the L76K GPS chip has
  been dropped (M10Q only).

### Open items

- **hAcc is too optimistic.** On real walks the chip's own accuracy estimate
  (`hacc_m`) is about 3–4× smaller than the real error, and there is a slow
  multipath drift that no filter can remove. The levers left are hardware /
  chip settings: the Super-S setting (now a firmware option, on by default —
  not yet measured on walks), a better antenna, or a dual-band receiver.
- **Fixed-stride `downsampleForDisplay`** — time-uniform and geometry-blind
  (drops corners, keeps redundant straightaway points). RDP + a max-vertex
  cap does the job better. The live path already uses `buildDrawPoints`;
  this form only survives for globe3d and tests.



### Smaller notes

- **Potential:** the Kalman filter's Doppler velocity noise is still a
  pair of fixed guesses (`SPEED_SIGMA_MS` 0.3 m/s, `COURSE_SIGMA_RAD` 15°
  in `gps_cv_kalman.mjs`), not derived from data — today we only have a
  live accuracy metric ($hAcc$) for the position side. The M10Q's
  `UBX-NAV-PVT` message (class 0x01, id 0x07, 92-byte payload) carries
  `sAcc` (speed accuracy, mm/s, offset 68) and `headAcc` (heading
  accuracy, 1e-5 deg, offset 72) — no NMEA or `$PUBX` sentence carries
  either field, confirmed against the u-blox M10 SPG 5.10 Interface
  Description. With those, the velocity measurement could use the chip's
  own per-fix noise instead of the constants. Two real costs: (1) enabling it
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
  trades NMEA's self-recovering line framing for sync-byte/length/checksum binary
  framing that can misalign on a single dropped byte (existing UBX code in
  `gps_uart.c` only does this for one-shot config ACKs today, never as a
  continuous per-IRQ parser); and needs its own watchdog rewrite (current
  one is NMEA-line-validity based). Only real payoff is unlocking
  `sAcc`/`headAcc` for the fusion idea above — better captured by the
  mixed NMEA+UBX approach already noted there (add one narrow binary
  parser alongside the working NMEA path) than by a full protocol cutover.
- `GpsPipeline.collectFixes` hand-copies 10 fields (deliberate, per the
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
  (`src/render/renderer_markers.mjs` ~L347), the map label caps text width at
  160 px on a single unwrapped line (`GSRLabelManager.textWidth` in
  `src/render/label_placement.mjs`), and the 3D globe label
  (`src/map/globe3d/`) and map-popup editor (`src/map/map_popups.mjs`) are
  single-line too. Render long notes as
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
  `src/signal/analyzer.mjs:analyze()` behind a flag the live view sets (default unchanged)
  to skip the redundant full computation. Accept: live EDASymp won't match the
  offline EDASymp for the same walk (it's time-shifted ~32 s) — fine for a
  live heat overlay, not for analysis. Rationale: EDASymp is per-sample,
  continuous, threshold-free and gait-immune (0.045–0.25 Hz band ≪ walking
  cadence) — the best-fit live arousal metric, better than phasic (which is
  mostly flat).

## Loose ends from closed investigations

Carried over from closed investigations (`gps_rf_mutex_status.md`,
`bluetooth_serial_investigation.md`, `visualizer_architecture_refactor_plan.md`,
`visualizer_rendering_perf_routes.md` — the `docs/archive/` folder was removed
in commit `1a7806a`, so they're only in git history now). Primary objectives
are done; these are the optional follow-ups still worth doing.

### Firmware

- **Live Stream (BLE) on-hardware field validation** (from
  `bluetooth_serial_investigation.md` §10 Phase 3) — the only Live
  Stream phase left. On a real walk: battery endurance during active BLE
  broadcasting, Android Chrome reconnection when the phone display sleeps or
  goes in a pocket mid-walk, and packet-drop rates (`bt_telemetry` debug line
  already logs `bt_tx_peak_ms` / `bt_drop`).
- **RF/GSR concurrency — test-coverage gaps** (from
  `gps_rf_mutex_status.md`). Both low priority, no suspected defect:
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
  `visualizer_rendering_perf_routes.md` §2.3) — `computeLabelPositions`
  in `src/render/label_placement.mjs` runs an O(N²) simulated-annealing pass
  (`ITERS = max(300, N*30)`, each iteration scanning all N boxes twice).
  Profile it on tracks with >100 peaks to decide whether the overlap checks
  need spatial partitioning.
