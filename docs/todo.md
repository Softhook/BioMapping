# Todo

Loose ideas and unscheduled work. Promote anything real to its own doc under `docs/`.

## Priority

- **Airport / acoustic context** — would a microphone make sense there? See
  [acoustic_aircraft_detection_proposal.md](acoustic_aircraft_detection_proposal.md).

## Analysis ideas

- Correlate GSR against the 868 and 915 MHz RF bands.
- 391 MHz looks like a useful VHF frequency to add to the sweep.

## Not priority

- **Server upload** — push live data on to a server (e.g. for a flight-radar
  link). The Flipper → browser half already exists as Live Stream / `live.html`;
  this is only the onward upload.
- **Physical form factor** — 3D-printed case.
- **Calibration age** — store a date with the GSR/RF calibration and prompt the
  user to recalibrate once it is more than a month old.

## Loose ends from closed investigations

Carried over from `archive/gps_rf_mutex_status.md` when it was archived — the
mutex bug itself is fixed, these are the leftovers.

- **2 Hz `tick_dt_ms` oscillation** — a ~150–190 ms tick delay on a regular
  5-row (0.5 s) cycle with a compensating dip, self-correcting, no data loss,
  ~1.3% of recording time on a long track. Present only in recordings whose CSV
  carries the `flush_peak_ms` debug column; independent of `BIOMAP_SD_PREALLOC`.
  Not root-caused — candidates are `view_port_update()`'s 2 Hz redraw pacing or
  heavier per-tick debug-column formatting. Would need a same-card,
  debug-fields-on-vs-off A/B walk to tell them apart.
- **`WizardState` mutex fix has no test coverage** — the GSR-calibration-wizard
  cross-thread fix in `biomap_gui.c`/`biomap_render.c` was verified by review
  only; the host harness can't mock `Canvas`/`ViewPort`.
- **RF/GSR race not formally proven absent** — the TOCTOU stress test raises
  confidence but doesn't prove it. A deterministic proof needs a test-only
  sync hook inside `gsr_sensor_worker()` (to pause it exactly between reading
  `rf_enabled` and setting `rf_spi_busy`) — production instrumentation purely
  for testability, so it needs a deliberate decision before adding.
- **No test for the reverse direction (slow I2C blocking RF's snapshot read)** —
  only the RF-blocks-I2C direction is covered. Low priority: I2C was never part
  of the reported bug and isn't protected by any RF mutex anyway, so this is a
  coverage gap, not a suspected defect.
- **`gsr->available` dead code** — set `true` unconditionally at alloc, never set
  `false`; every `if(!gsr->available) return;` guard is unreachable. Removing it
  touches ~20 call sites plus `gsr_sensor_available()` for zero behaviour change.
