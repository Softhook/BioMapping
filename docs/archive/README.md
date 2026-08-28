# docs/archive

Closed investigations, superseded proposals, and completed multi-phase plans —
kept as a record of what was tried, what shipped, and why. Nothing here is a
guide to current behaviour; several are still cited by source-code comments as
the rationale-of-record for shipped code, which is why they are archived rather
than deleted.

Active design notes and living reference docs stay in `docs/`.

| Document | Outcome |
|---|---|
| `rf_no_teardown_architecture_proposal.md` | No-teardown RF fast-tuning — abandoned after it froze the device on the first hardware sweep. What shipped instead is the conservative per-band retune described in its §6. |
| `sd_writer_thread_investigation_2026-08-03.md` | Dedicated SD-writer thread — built, tested on-device, reverted. The turn-by-turn history lives in `gps_rf_mutex_status.md`. |
| `gps_rf_mutex_status.md` | GPS-quality regression from RF SPI sharing a per-tick mutex — root cause fixed and verified (two-mutex split + paced RF sampling). Includes the SD-flush-stall sub-investigation (`BIOMAP_SD_PREALLOC` shipped). Remaining minor items moved to `docs/todo.md`. |
| `bluetooth_serial_investigation.md` | Live Stream (BLE) implementation plan — shipped (`firmware/modules/bt_stream.c`, `visualiser/live.html`). Only §10 Phase 3 (real-hardware validation) is outstanding. README's "Live View" section is the current description. |
| `visualizer_architecture_refactor_plan.md` | Visualiser stability + performance refactor — Phases 0–8 landed and code-verified. Phase 9 (optional simplification audit) and Phase 6 step 3 (investigate-only) never started. |
| `visualizer_rendering_perf_routes.md` | Companion route survey to the above — every sized route landed 2026-08-07; only §2.3's unsized investigate-only candidates remain. |
| `visualizer_test_coverage_plan.md` | Test-harness + coverage plan — Phase A (real `node --test` harness + jsdom) landed; `visualiser/tests/` now has ~55 files. Remainder folded into the architecture refactor plan. |
