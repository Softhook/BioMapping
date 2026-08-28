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
