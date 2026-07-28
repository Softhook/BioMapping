# EM Scan Faraday Calibration: Investigation Findings (2026-07-28)

This document records what was found while debugging the Faraday calibration
wizard passing/failing in ways that didn't match whether the Flipper was
actually inside a shielding bag. It's a findings log, not a spec — see
[em_scan_calibration_plan.md](em_scan_calibration_plan.md) for the original
design.

## Timeline

| # | Condition | Reported result | Outcome |
|---|-----------|------------------|---------|
| 1 | **Not** in bag | floors -91.5 to -79.5 dBm, max std dev 3.19, baseline fog 0.0 | **Passed** (bug) |
| 2 | Real sealed box | worst 815 MHz: -91.5 dBm | Failed (ceiling too tight) |
| 3 | Real sealed box | worst 300 MHz: -76.5 dBm | Failed (ceiling too tight) |
| 4 | **Not** in bag (after ceiling tuning) | floors -91.5 to -77 dBm, max dev 1.99, baseline fog 5.4 | **Passed** (bug, again) |

## Root cause #1 (structural bug, fixed): the ceiling check was dead code

`em_scan_cal_compute_stats()` computed the 10th-percentile floor per band and
then **clamped it to the ceiling before any caller ever compared it to that
ceiling**:

```c
if(floor > EM_SCAN_CAL_MAX_FLOOR_DBM) floor = EM_SCAN_CAL_MAX_FLOOR_DBM;
noise_floor_dbm[b] = floor;
```

Every downstream check (`em_scan_cal_validate()`, the live pass/fail decision
in `em_scan.c`) compared the *already-clamped* value against the same
ceiling. A value can never be measured as exceeding a bound it was already
forced down to, so the "unshielded" floor-ceiling failure path was
unreachable regardless of what the ceiling number was set to. This alone
explains run #1.

**Fix:** removed the upper clamp from `compute_stats` (kept the lower
sanity clamp against `EM_SCAN_CAL_MIN_FLOOR_DBM`). The ceiling comparison
now sees the real measured value.

## Root cause #2: one flat ceiling doesn't fit all 6 bands

The original ceiling (`EM_SCAN_CAL_MAX_FLOOR_DBM = -75.0f`) was a single
value applied identically across 300/434/446/815/868/915 MHz. Wavelength
differs by ~3x across that range (300 MHz: λ≈1m, 915 MHz: λ≈33cm), so the
same seam/zipper gap in a shielding bag leaks proportionally more at the
lower frequencies. A flat ceiling either lets the low bands pass unshielded
or is unreachable for them even when genuinely sealed.

**Fix:** replaced the single constant with a per-band array,
`em_scan_cal_max_floor_dbm[EM_SCAN_NUM_FREQS]` (`em_scan_cal.c`), tuned
against real sealed-box readings:

| Band | Ceiling | Basis |
|------|---------|-------|
| 300 MHz | -75 dBm | real sealed reading -76.5 dBm + ~1.5dB margin |
| 434 MHz | -75 dBm | **not independently confirmed** — sharing 300 MHz's value as a starting estimate |
| 446 MHz | -75 dBm | **not independently confirmed** — same |
| 815 MHz | -90 dBm | real sealed reading -91.5 dBm + ~1.5dB margin |
| 868 MHz | -90 dBm | **not independently confirmed** — sharing 815 MHz's value |
| 915 MHz | -90 dBm | **not independently confirmed** — same |

## Root cause #3 (unresolved): 300 MHz sealed and unsealed readings overlap

After tuning both ceilings against real sealed-box data, run #4 still passed
unshielded, with a 300 MHz floor of -77 dBm — **quieter than the genuinely
sealed reading of -76.5 dBm from run #3**. There is no ceiling value that
accepts -76.5 and rejects -77; they're on the wrong side of each other.
Tightening further would just start rejecting genuine sealed calibrations,
as already happened twice.

This is not a threshold-tuning problem — the per-band ceiling gate is
structurally unable to discriminate "sealed" from "unsealed-but-quiet" on
this band at this location.

### Leading hypothesis: 300 MHz is likely hardware/antenna-limited, not ambient-limited

The Flipper Zero's sub-GHz antenna and matching network are designed around
433/868/915 MHz (its three primary bands). 300 MHz sits outside that design
center. Sealed and unsealed readings being nearly identical (-76.5 vs -77
dBm) is exactly what you'd expect if the number being measured is the
radio's own self-noise/sensitivity floor at a poorly-matched frequency,
rather than ambient RF that a Faraday enclosure could actually block — no
amount of external shielding improves a limit that originates inside the
receiver.

By contrast, 815/868/915 MHz sealed measured a real -91.5 dBm, ~15 dB lower
than the 300 MHz cluster under the same sealed condition. That's within the
Flipper's designed sweet spot, where the antenna is efficient and shielding
vs. not-shielding is a real, measurable difference — likely the only band
cluster where this gate carries genuine information.

**Not yet confirmed.** A cheap way to test this: take a sealed reading at
300 MHz in a few different rooms/times.
- Consistently ~-76 to -77 dBm regardless of location → supports the
  hardware/antenna-limit hypothesis.
- Meaningful variation between locations → ambient RF is getting through
  and the *bag* (not the hardware) is the limiting factor.

## A signal that exists but isn't used yet: the fog index

`em_scan_calc_fog_index()` compares a fresh reading against the
**previously saved calibration** (`app->cal_data.noise_floor_dbm`), not
against absolute ceilings. Between run #1 (baseline fog 0.0 — first-ever
calibration, nothing real to compare against) and run #4 (baseline fog 5.4
— compared against the real sealed calibration saved after run #3), the fog
index did register a meaningful jump when conditions changed. The current
pass/fail gate doesn't use this comparison at all — it only checks the new
reading against fixed per-band ceilings and internal variance.

This is a real signal, but has a blind spot: it only works once a
trustworthy prior calibration already exists. It can catch "this
recalibration is worse than last time" but not "is this device's very
first calibration trustworthy" (run #1's scenario).

## Open questions (not yet decided)

1. **Should 434/446 and 868/915 get their own confirmed sealed readings**,
   rather than inheriting their band-mate's ceiling by assumption?
2. **Should the gate compare against the last saved calibration** (via the
   fog index) in addition to, or instead of, absolute per-band ceilings?
   Would need its own "how much drift is too much" threshold.
3. **Does lengthening the 20s sampling dwell help?** It increases the
   chance of a real burst landing inside the window and tripping the
   std-dev gate (the mechanism actually meant to catch "unshielded"). It
   does *not* reliably lower the 10th-percentile floor value — that
   statistic converges toward the true ambient 10th-percentile as sample
   count grows, it doesn't hunt for an anomalously quiet instant. In both
   false-pass runs, std dev was already well under the 3.5 dB threshold
   (3.19 and 1.99), so a longer window may not have changed either
   outcome.
4. **Should 300/434/446 be excluded from strict pass/fail gating** given
   the likely hardware-floor limitation, with only 815/868/915 treated as
   a meaningful shielding indicator?
5. **Is a hard pass/fail gate the right shape at all**, versus always
   saving the measurement and showing the raw numbers (floor, std dev, fog
   vs. last save) for the user to judge, given the gate has now produced
   false passes twice and false fails twice while chasing the same handful
   of numbers.

No decision has been made on 2, 4, or 5 yet.
