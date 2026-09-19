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

### Open items

- **Fixed-stride `downsampleForDisplay` on the live path** — time-uniform and
  geometry-blind (drops corners, keeps redundant straightaway points).
  RDP + a max-vertex cap does the job better; the method's own comment
  says the live path already uses `buildDrawPoints` and this form only
  survives for globe3d/tests.
- **Visual track quality report popup (Track Library hover card)** — when
  hovering the cursor over a track item in the track library (`#trackList`),
  display a rich visual popup card summarizing recording metadata, sensor
  health, and data quality at a glance:
  - **Header & Walk Metadata:** Filename, start date/time, duration, distance
    (e.g., `38 mins • 2.6 km`), and user annotation count (`🏷️ 4 Notes` vs
    `Unannotated`).
  - **Integrity Status:** Green tick (`verified` FNV-1a footer), warning
    triangle (`incomplete` ungraceful cutoff), or error mark (`corrupt`).
  - **Sensor Health Grid:**
    - **GSR:** Skin contact status (`Good Contact` vs `Flatline / Disconnected`),
      dynamic range ($\mu\text{S}$ min/max/std), and detected SCR peak count.
    - **GPS:** Fix retention percentage, median accuracy ($\pm hAcc$ in metres, or
      HDOP), and continuity status (e.g. `Solid (0 dropouts)` vs `X dropouts >30s`).
    - **RF (if present):** Active frequency bands (815, 868, 915 MHz), packet
      activity, and detected RF hotspots (hidden or marked `Not recorded` if no RF data).
  - **Warning Banner:** Prominently surfaces any parser validation alerts
    (e.g. flatline electrode, no satellite lock, sensor disconnected).



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
