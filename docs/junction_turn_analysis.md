# Junction turn/straight analysis, and what it means for road snapping

Status as of 2026-09-21. Landed and refactored.

## 1. Why this exists

Two goals that share one piece of machinery:

1. **Snapping.** After the "snap to track adjacent" commit (`eacd5b6`), the map matcher's
   side-road excursion filter asked only "did the walker's overall direction run away from
   this side road?". It never asked what road the walker *ended up on*, so a genuine turn
   onto a short link road could be stripped as a glitch.
2. **Research question.** Does GSR differ at junctions where people *turn off* a road versus
   *carry straight on*? Junction = a choice point (3+ road-ends meet) **or** a change of road
   character (highway class / surface / lit).

Both need the same thing: for each junction the walker passed, *did they turn or carry on?*

## 2. What was built

| File | Role |
|---|---|
| `src/gps/junctions.mjs` | Pure. Builds a node graph from Overpass ways (nodes keyed by coordinate, so mid-way T-junctions are found), then `classifyPassages()` labels each passage `turn` / `straight` / `reverse` / `ambiguous` with kind `choice` / `change` / `choice+change`. |
| `src/gps/map_match.mjs` | Excursion filter now keeps a side-road run when it is the *only* link between the roads before and after it **and** the fixes actually sit on it. |
| `src/gps/junction_response.mjs` | Pure. GSR summaries in a window before and after each passage; turn-vs-straight tests. |
| `tests/test_junctions.js` (11), `tests/test_junction_response.js` (7), `tests/test_map_match.js` (+1) | Unit tests, incl. a planted-effect / null check for the stats. |

UI: the Environmental dashboard's **Junction Turns** tab (`src/ui/ui_junctions_table.mjs`,
fed from `ui_environmental_dashboard.mjs`).

### Review fixes (2026-09-20)

A critical review of the tab found it reported more than the statistics support. Changed:

- **Verdicts use the BH-corrected q across all 7 tests**, one p/q per row (paired if ≥ 5 paired
  junctions, else pooled). The headline banner no longer picks one row or asserts an effect:
  it says "no detectable difference" / "weak hint" / "differ in N of 7", with sample sizes and
  a small-sample warning. A raw p < 0.05 with q ≥ 0.05 is shown as a weak hint only.
- **Causal copy removed** ("caused by turning", "surge"); labels are Before / After / Change.
- **Pooled test adjusts for the walk**: each level is centred on its own track's mean, and only
  tracks with both turns and straights contribute. Passages in a walk are still correlated, so
  it is indicative. (The existing effective-N machinery was not reused: passages are not a
  regular series.)
- **Classifier constants are metres, not fix counts** (`VISIT_GAP_M` 6, `MERGE_M` 3). With
  snapping on, the matcher runs on ~1 Hz points thinned to ≥ 3 m, then `snappedGps` is
  interpolated to every 10 Hz sample, so "3 fixes" / "1 fix" meant 0.3 s in the app and ~2–3 s
  in other feeds. (An earlier version of this note said the dashboard was fed thinned points;
  it is fed the interpolated 10 Hz array.) **The counts in section 3 were made with the old
  constants and have not been regenerated — see "Verification" for current numbers.**
- Dropped-window and reverse/ambiguous counts are shown; user-excluded peaks are ignored;
  the higher/lower colour uses a per-metric band and only applies when the verdict isn't null.

Second pass, after seeing a real single walk (62 passages, only 6 of 22 turns kept a window
vs 13 of 25 straights): the pooled test became a within-walk label permutation (heavy-tailed
phasic means made Welch fragile at n=6); dropped counts are shown per class with an
"uneven loss" warning; percentages are hidden on null rows and near-zero baselines.

Not done: nothing here has been checked in a real browser, and the confounds (road type,
speed, gait artefact) remain uncontrolled; the tab now says so.

### Classifier decisions, and why (each came from real-track testing)

- Bearings from **25 m arms** either side of the node (15 m was too noisy).
- **`turn`** ≥ 40°, **`straight`** ≤ 25°, **`reverse`** ≥ 135°, otherwise `ambiguous`.
- **Same OSM way in and out is *not* automatically "straight"**: real data had 140–180°
  doubling-back on one way. That shortcut was removed.
- **Snapped and unsnapped angles must agree**, otherwise the passage is `ambiguous`
  (snapping can add or hide a corner; neither is ground truth).
- Fixes **> 20 m from their matched way** are ignored (off the network).
- Duplicate passages from parallel pavements are merged only at the same/adjacent fix;
  distinct junctions a few metres apart are kept and handled by window clipping.

### Analysis design

- 10 s window before and after; each window clipped at the midpoint to neighbouring passages
  so no GSR sample is counted twice; a window under 5 s or under 5 samples is dropped.
- Metrics: phasic peak rate, mean phasic, mean tonic. Reported **before** (anticipation),
  **after** (consequence) and **delta**.
- **Pooled** turn-vs-straight (Welch in the first pass; now a label-permutation test, shuffled within walk) (treats passages as independent, which they are not, so
  indicative only) and **paired within junction** with within-junction label permutation
  (5000 permutations, seeded). Benjamini–Hochberg across the 7 tests.

## 3. Results so far

### 3a. Snapping (real tracks, Stokey area, Overpass highway geometry)

Compared the committed matcher with the new one on the fixes whose road changed, using mean
distance from the raw fix to the chosen road as the yardstick.

| Dataset | Fixes changed | Fit old → new | Better / worse (>1 m) |
|---|---|---|---|
| Stokey.zip, 13 processed walks | 196 | 11.96 m → 6.79 m | 147 / 17 |
| 25 raw logs in the Stokey box | 357 | 18.1 m → 11.5 m | 264 / 47 |

The first version of the rule (topology only) was **worse** on one track (kept a footway
22.7 m from the fixes). Requiring the run to also fit the fixes fixed that. Biomap_019 and 040
still get slightly worse (~2 m); 040 walks ~17 m from any mapped road so is not informative.

### 3b. Classifier

25 raw tracks: 397 passages, **83 turn, 193 straight, 9 reverse, 112 ambiguous (28%)**;
285 confident passages at 102 distinct junctions; 53 junctions visited ≥ 2×, **14 with both a
turn and a straight visit**. Nearly all confident passages are choice points; only ~12 turns
and ~12 straights at pure character changes.

### 3c. GSR (Stokey.zip, 13 walks with processed GSR)

312 passages → 193 usable windows (119 dropped, mostly passages within 10 s of a neighbour)
→ **37 turn vs 104 straight**, only **8 junctions** with both.

| Phase | Metric | Turn | Straight | Pooled p | Paired p | Paired q |
|---|---|---|---|---|---|---|
| before | peak rate (/min) | 12.4 | 13.7 | 0.23 | 0.59 | 0.88 |
| before | mean phasic (µS) | 0.328 | 0.289 | 0.57 | 0.029 | 0.196 |
| after | peak rate | 13.5 | 13.1 | 0.73 | 0.88 | 0.88 |
| after | mean phasic | 0.303 | 0.252 | 0.44 | 0.056 | 0.196 |
| delta | tonic (µS) | +0.081 | +0.009 | 0.12 | 0.098 | 0.228 |

**Conclusion: no detectable difference.** The only uncorrected p < 0.05 (mean phasic *before*
the junction, paired) does not survive correction (q = 0.20), and with 8 paired junctions it
would be a hypothesis to test, not a finding. Turns have a hint of higher phasic level both
before and after, which if real would be a general arousal difference rather than a
reaction to the junction.

**This is an under-powered null, not evidence of no effect.**

## 4. Will this help our road snapping?

Be careful to separate the two halves:

- **The classifier + connectivity rule: yes, already.** It fixed a real bug (genuine turns onto
  short link roads stripped) and measurably improved fit on real tracks, and it gave us a
  real-data harness that found two flaws in my own first version.
- **The GSR analysis: no, not directly.** A GSR difference (or its absence) says nothing
  about whether a fix was snapped to the right road, so the null result neither validates nor
  refutes the snapping. Its indirect value is only that it forces the turn/straight labels to
  be trustworthy, which the snapping also benefits from.
- **Caveat on the evidence:** "fit to the raw fixes" measures agreement with GPS, not truth.
  There is no ground-truth route yet. A wrong-but-close footway would look fine.

Remaining snapping weaknesses seen in real data, in rough priority order:
1. Walks that run 12–17 m from any mapped road (biomap_040, 039, 032, 044): the matcher
   still snaps them (with low alpha). Consider an explicit "off-network" state.
2. Dense parallel-footway grids where road, pavement and crossing are all plausible.
3. Junctions are found by coordinate. The app's Overpass ways DO carry node ids (`el.nodes`)
   and `coordinates[i]` are the shared node objects, so identity-keying is possible; not needed
   so far.
4. Older firmware logs use ISO timestamps; confirm the app's CSV parser converts them so the
   matcher's `MAX_GAP_S` gap logic works (my probe script initially got NaN and silently
   disabled it).

## 5. Limitations

- No ground truth for turn/straight; validation is internal consistency only.
- Passages within one walk are correlated; the pooled test overstates precision.
- 38% of passages lose their window (neighbouring passage within 10 s) — dense city grids
  leave little clean GSR between decisions.
- Only Stokey Newington roads were fetched; Edinburgh / Fife tracks unexercised on the
  final classifier.
- The probe scripts (Overpass fetch, matcher A/B, classifier report) live in a session
  scratchpad, not the repo, and are not yet reproducible from a clean checkout.

## 6. Suggested next steps

1. Hand-check 5–10 passages on the map against junctions you remember walking (ground truth).
2. Collect more repeat-route walks: the paired test needs many junctions with both outcomes;
   8 is too few. ~30 would give useful power for a medium effect.
3. Move the probe scripts to `tests/manual/` with a cached Overpass extract.
4. Optional: dashboard card for the turn/straight comparison, reusing the existing stats
   presentation (effect-size chips, BH-FDR).
5. Decide on an explicit off-network state in the matcher.


## 7. Verification (2026-09-20, real data)

Harness (scratchpad, not in the repo): 29 real Stokey walks from `tracks/`, OSM highways for the
box fetched once from Overpass and converted to the app's node+way shape, run through the app's
**real** `OSMEnricher.enrichTrack` and the **real** `GSRUI.updateEnvironmentalDashboard()`.

**Does the snapping change endanger the main visualiser?** Old (HEAD) vs new matcher, whole
pipeline: 29 tracks, 338,683 samples, **0 errors**, no sample ever lost its position, enrichment
time unchanged, largest position move 10.7 m. 7,302 samples (2.2%) changed road; by fit to the
raw fixes 4,261 improved and 1,068 worsened (>1 m), the rest within ±1 m. Tracks 016, 038, 040
are roughly break-even. Fit-to-GPS is not ground truth, so this shows "safe and mostly closer
to the GPS", not "more correct".

**Is the classifier stable?** Labels from the full 10 Hz feed match labels from a 1 Hz
subsample in ~97–100% of confident passages (e.g. 51/51, 46/46, 34/35).

**Is the statistics calibrated?** Placebo: each walk's GSR rotated by a random offset against
its junction times (keeps autocorrelation, destroys any real link), 100 rotations. Per-row
P(p < 0.05) = 2–5% (target 5%); P(any BH q < 0.05) = 3%.

**Power?** Effects planted on real GSR after turns: +0.4 µS / +18 peaks/min detected
(q = 0.002); +0.2 µS borderline (q = 0.08); +0.1 µS missed on phasic level (peak-rate bump caught).
So this corpus only detects effects about as large as a walk's whole mean phasic level.

**Result on the real corpus:** 544 passages, 215 usable windows (46 turns / 115 straights),
10 paired junctions. Nothing survives correction. Best hint: after-window peak rate, turn 14.3
vs straight 7.9 /min (paired p = 0.037, q = 0.13) — driven by low straight-passage values, not
high turn values; a hypothesis only.

**Cost:** classify 3–13 ms/track, dashboard recompute 400 ms for all 29 (cold), 0.7 ms cached.

**Bugs found by this pass** (all fixed): displayed means came from the pooled sample while the
difference came from the paired test (numbers disagreed); percentages on change rows.

**Still open:** no ground truth for turn/straight; confounds uncontrolled. The unrelated `scrollWheelZoom: false` edit in `map_base.mjs` was reverted to `true`.

## 8. Review pass 2026-09-21 (concept + implementation audit)

Current constants: `MERGE_M` 20 / `MAX_CLUSTER_SPAN_M` 25 (multi-node crossroads collapse to one passage; the
"3 m" in section 2 is superseded). Control passages (mid-block, ≥30 m of track from any junction) are the
open-road baseline for the Junction-vs-Control columns.

Bugs found and fixed:

- **Merged-crossroads label.** A cluster was labelled `turn` if *any* node read as a turn, so walking
  straight across a staggered crossroads (jog between two nodes) was counted as a turn. The overall
  path in→out of the whole cluster now decides; per-node labels are only a fallback.
- **Window coverage.** Peak rate divided by the nominal window length even when the window ran off the
  start/end of the recording or across a dropout, biasing rate low. Rates now use covered time, and a
  window with < 80 % GSR coverage is dropped (`MIN_COVERAGE`).
- UI referenced non-existent `testJunction`/`pairedNJunction` fields (Junction-vs-Control is always pooled);
  tooltip text simplified.

Verified sound (no change): bearing sign/thresholds, snapped-vs-raw agreement rule, visit splitting,
window clipping at neighbour midpoints, per-walk centring + within-walk label permutation, paired
within-junction permutation, BH across the family. Known limits unchanged: no ground truth, correlated
passages, the three contrast families (T-vs-S, S-vs-C, T-vs-C) are each BH-corrected separately, not jointly.
