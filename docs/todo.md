# Todo

Loose ideas and unscheduled work. Promote anything real to its own doc under `docs/`.

## Priority

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
