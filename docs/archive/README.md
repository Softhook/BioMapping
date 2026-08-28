# docs/archive

Closed investigations and superseded proposals, kept as a record of what was
tried and why it was dropped. Nothing here describes current behaviour — read
it for history, not as a guide to the code as it stands.

Active design notes and living status documents stay in `docs/`.

| Document | Outcome |
|---|---|
| `rf_no_teardown_architecture_proposal.md` | No-teardown RF fast-tuning — abandoned after it froze the device on the first hardware sweep. What shipped instead is the conservative per-band retune described in its §6. |
| `sd_writer_thread_investigation_2026-08-03.md` | Dedicated SD-writer thread — built, tested on-device, reverted. The turn-by-turn history lives in `docs/gps_rf_mutex_status.md`. |
