# Time offsets: where views disagree

Reviewed 2026-09-30, on `main` at 3131167.

## Progress and handover (read this first)

**Status on 2026-09-30:**

- **Steps 1 and 3 are built** on branch `response-delay`. It is not merged
  into `main` and not pushed.
- **Step 2 (screenshots) is still to do.**
- The findings below describe the code **before** the build.

**Commits on `response-delay`:**

| Commit | What |
|---|---|
| c5e14a7 | This document, and the tests written before the build |
| 5dddfc7 | Step 1a: the join; map, group map, dashboard, Places, junctions, export, slider, Live |
| 0cb6dc5 | Step 1b: the graph on the place-time clock, hover sync |
| 5ef9535 | Step 1c: the 3D wall, spires and CZML/KML export by place |
| 88c230f | Doc status line |
| (step 3) | Timestamp fixes: clock-text rows, device hold-ups, the dashboard's one second |

**Where things live:**

- **`visualiser/src/signal/response_delay.mjs`:** the only code that shifts
  time.
  - `normalise` keeps the value between 0 and 8 s, default 2.
  - `placeOf`, `placeRowOf` and `readingAt` pair a reading with a place.
  - `byPlace` rearranges per-reading values by place.
  - `placedAtEveryDelay` is used for the hotspot rule.
- **On the analyzer:**
  - `setResponseDelay(s)` sets the delay.
  - `placeOf(i)`, `placeRowOf(i)` and `readingAt(j)` are the lookups.
  - `responseDelay` holds the delay itself.
  - `maxResponseDelay` is 8, or 0 for Live.
  - `memorableEvents` is a getter. Hotspots are re-chosen whenever the peaks
    or the smoothed path change, never when the delay changes.
  - `analyze(params)` takes no latency argument any more.
- **In the app state (`AppState`):**
  - `responseDelay` is the one value for the project; `setResponseDelay(s)`
    applies it to every walk.
  - The graph axis uses `timeAxisStart` (= −delay), `timeAxisSpan` and
    `clampViewStart(t)`.
- **The slider** is `#responseDelay` in `index.html`, wired in
  `ui/events_gps.mjs`.
- **Saved with the project** in `manifest.settings.responseDelay`.
- **CSV exports** write `# ResponseDelay:<s>` in the header. The parser skips
  that line on reload.
- **Removed:**
  - `PhysioLatency`, `stimulusIndexAt`, `resolveLatencyIndex`;
  - `GPS_DEFAULT.peakLatency` and the per-walk latency;
  - the dashboard's separate tonic pairing (`tonicEnv`; tonic now uses the
    same pairing, with its own `tonicSpeed`);
  - the old `#gpsPeakLatency` slider.

**Checks, all run from `visualiser/`:**

| Command | What it proves | Last result |
|---|---|---|
| `npm test` | Unit tests, including the design tests in `tests/test_response_delay.js` and the 0 s record in `tests/test_response_delay_zero_baseline.js` | 1755 pass, 0 fail, 0 "to do" |
| `node tests/manual/response_delay/baseline.js --check` | Every walk in `tracks/` at 0 s is unchanged, except hotspots and the walks step 3 fixes | 13 hotspot changes, all explained (below); other changes only in the walks listed under "What step 3 changed" |
| `node tests/manual/response_delay/sync_check.js [--delay=2] [--break]` | In real Chrome, hovering a peak puts the map dot on its own marker, the path colour there is its reading, the road band matches the dashboard, and the label shows place time | Passes at 2 s and 5 s; `--break` fails all 12 peaks |
| `npm run smoke -- --compare=main` | Whole app in Chrome | 22/22 |

The saved all-walks record is in
`tests/manual/response_delay/out/baseline.json`. It is git-ignored and was
made before the build with `--save`. **Do not re-save it** until all the
steps are done.

**Why 13 walks' hotspots changed at 0 s** (expected):

- **In most of them,** a hotspot in the first few seconds after GPS started
  was dropped, because a hotspot needs a place at every delay up to 8 s.
  The next-biggest peak took its place.
- **Newhaven and biomap_025:** the 2 % hotspot target rounded down from 5 to 4.
- **biomap_021:** a 6-second walk, so it has no hotspot.

**What step 3 changed** (checked on all 73 walks):

- **Clock-text walks** (030, 031, 032, 038, 039, and also 040, 042 and 043,
  which the first pass missed): rows are now spread within their own
  labelled second (`GSRCSVParser._spreadSharedTimes`). Before, 20–75 % of
  rows sat outside their second, by up to 0.9 s. Their peaks, paths and
  group maps change a little, as expected.
- **Device hold-ups** (`GSRCSVParser._offTimeRows`, `analyzer.offTime`): in
  files with `tick_dt_ms`, a row labelled more than 0.5 s from its real
  time gets no place, from either side of the pairing.
  - biomap_121: 147 rows (the 6.4 s hold-up at about 8 min).
  - biomap_114, 115, 116, 118, 123: 1–8 rows each, mostly the first row
    (a slow first tick followed by a burst).
  - A row missing from the file (the label jumps a tick) counts as one
    normal tick. Without that, biomap_011, 012 and 015, which drop a row
    about every 10 s, would have looked up to 5 s off.
- **Dashboard** "last second" windows (arousal and walking speed) are one
  second by time (`secondStart` in `environmental_stats.mjs`). At 10 Hz
  this is the same 10 rows as before, except across a missing row. The
  live-stream exports (3.3 Hz) now average 1 s, not 3 s.
- **Re-exported files** keep no `tick_dt_ms`, so the hold-up flags don't
  survive an export and re-import.

**Gotchas for whoever continues:**

- **Test stand-ins.** Hand-built stand-in analyzers in tests need the
  lookups. Wrap them with `withJoin()` from
  `tests/support/join_for_stand_in.js`.
- **Short sample walks.** Test sample walks shorter than about 9 s have no
  hotspots. (The map-layer test's sample walk was padded to 9 s for this.)
- **Smoothed path in tests.** `analyze()` now builds the smoothed path when
  the walk has GPS. So a test that blanks raw positions must blank
  `filteredGps` too.
- **0 s shortcut.** At a delay of 0 the join returns each reading's own row
  directly, with no time search. That keeps "0 s = before the build" exact.

**Next:**

1. **Step 2:** screenshots at 0, 2 and 3 s of single view, 3D and the group
   map, to show the user everything moving together.
2. **After that:** the user decides whether to merge `response-delay` into
   `main`. Check with `npm run smoke -- --compare=main` first.

---

The findings (sections 1–13) describe the code **as it was before the
build**. The fix for
all of them is the **Solution design** at the end. Where a finding's own
"Suggested fix" differs from it, the Solution design wins. Those findings are
marked **Replaced**.

- **Sections 1–7** cover places where the app applies the latency shift
  unevenly.
- **Sections 8–13** come from a second, wider pass. It covers everything that
  can move a reading in time: what the latency is measured from, which views
  skip the shift, the timestamps themselves, and the device.

## Background: the latency shift

A skin response comes a second or two **after** the thing that caused it. By
then the walker has moved on. So when the app ties a GSR reading to a place,
it looks up where the walker was a little **earlier**:

- **Peaks and phasic:** the Latency Offset slider value (default 2 s).
- **Tonic:** 4 × the slider value, capped at 30 s (default 8 s). Tonic follows
  its cause more slowly.

The rule lives in `signal/physio_latency.mjs`. The lookup is
`analyzer.stimulusIndexAt(time, lag)`, which finds the row nearest to
`time − lag`.

Example: a peak at 12:00:10 with a 2 s latency is drawn where the walker was
at 12:00:08.

Each view takes its latency from:

- **Single view and 3D:** the slider.
- **Collective view and its dashboard:** each walk's own saved value.

That was on purpose, and every view follows it. The Solution design replaces
it with one value for the whole project.

## What was measured

All numbers come from the 74 CSV files in `tracks/`. Of these, 59 walks have a
GPS position, covering 14.8 hours, 9,087 peaks and 50,975 dashboard samples.
The default settings were used. The scripts (`lag_audit.js`,
`lag_audit2.js`, and a few small CSV readers) are in the session scratchpad;
they are not in the repo.

---

## 1. Hotspots are not re-picked when the latency slider moves (real, visible)

**Replaced:** hotspots will no longer depend on the slider at all. See "Three kinds of result".

**What happens:** hotspots are chosen inside `analyzer.analyze()`. The choice
uses the latency in two ways:

- which peaks have a position at all;
- the 30 m minimum spacing, which is measured at the shifted positions.

Moving the latency slider only redraws the map (`GSRUI.rerenderMap`). It does
not call `analyze()`. So the map draws the **old** hotspot set at the **new**
positions.

**Example:** open biomap_016 at 2 s, then drag the slider to 0 s. One of its
13 hotspots is not the one a fresh load at 0 s would pick. Also, two of the
drawn hotspots now sit less than 30 m apart, which the spacing rule is meant
to prevent.

**How often, if you open a walk at 2 s and then drag the slider:**

- **Drag to 0 s:** 7 walks show a different hotspot, 3 pairs end up under 30 m
  apart, and 2 hotspots disappear.
- **Drag to 5 s:** 4 walks show a different hotspot.

Changing latency again later, or switching walks, re-picks the hotspots. So
the same slider value can show different hotspots depending on what you did
before.

**The same happens with the other GPS sliders** (Max HDOP, Max Speed, road
snap). They also change the positions hotspots are chosen by, and they also
only redraw.

**Suggested fix:** re-pick hotspots whenever latency or the GPS path changes.
The cheapest way is to call `a._selectMemorableEvents(params, latency)` from
`rerenderMap()`, without re-running the whole analysis.

## 2. The first hotspot pick happens before the smoothed path exists (real, visible)

**Still stands** as written, and is part of step 1.

This is not a time offset, but it causes the same kind of "depends on what you
did before" problem, so it belongs here.

**What happens:** when you first switch to a walk, `runAnalysis()` calls
`analyze()` **before** `renderData()` builds the smoothed path
(`GpsPipeline.ensureFilteredGps`). So the first hotspot pick uses the parser's
straight-line positions. The map, however, draws the smoothed path. Switching
away and back re-runs `analyze()` with the smoothed path in place, and the
pick can change.

**How often:** 6 of 59 walks swap one hotspot: 016, 019, 032b, 039, 091
and 115.

**Suggested fix:** build the smoothed path at the start of `runAnalysis()`,
before `analyze()`, using the walk's own GPS settings. Fixes 1 and 2 together
mean hotspots always match the line and markers you see.

## 3. The 3D replay shows peaks later than it should (likely a bug)

**Replaced:** the replay clock becomes place time, like the rest of the screen. See "One clock on screen".

**What happens:** in `map/globe3d/replay_tour.mjs`, a peak marker appears when
the replay clock reaches **peak time + latency**. But the marker is already
placed where the walker was at **peak time − latency**. So the delay is
counted twice.

- **Peaks:** at 2 s, a peak pops up 4 s after the walker passed its marker's
  spot, and 2 s after the wall shows the rise.
- **Hotspot jumps** (Left/Right keys): these aim to land 4 s before the rise.
  They actually land 2 s before it.

**Suggested fix:** reveal at `pk.time` (the moment the rise is drawn), and
jump to `pk.time − HOTSPOT_LEAD_S`. **Needs your call:** you may have wanted
the markers to lag on purpose.

## 4. The dashboard's "last 1 second" is 3 seconds on live exports (real, small)

**Still stands** as written (step 3).

**What happens:** `EnvironmentalStats.buildSamples` averages arousal over the
"trailing 1 s". It does this by taking the last 10 rows
(`Math.max(0, i - 9)`), which assumes 10 rows per second. The six live-stream
exports in `tracks/` are recorded at 3.3 rows per second, so for them the
window is 3 s.

This only affects the dashboard, and only for live-stream walks. All the
other time windows are worked out in seconds from the sample rate.

**Suggested fix:** take the window start by time (`pt.time − 1.0`), not by
row count.

## 5. Two different rules for "does this reading have a place?" (real, tiny)

**Replaced:** one edge rule everywhere. See "Edges".

Views disagree on **which** row must have a GPS position.

| View | Row that must have a position |
|---|---|
| Map peaks, hotspots, 3D, group-map peaks, Arousal Places | the earlier row (where the walker was) |
| Group-map colours (continuous) | the earlier row |
| Dashboard peak counts (road rates, Peaks channel) | the peak's own row |
| Dashboard samples (correlations, road means) | the reading's own row; the place is then read from the earlier row, which may have no position |

At the edges of the GPS part of a walk, the two rules give different answers.

**Example:** a peak 1 s after the first GPS fix has a position at its own row,
but not 2 s earlier. So the dashboard counts it, while the map doesn't draw
it. The reverse happens just after the last fix.

**How often:**

- **Peaks:** 8 of 9,087 disagree. 5 are counted on the dashboard but not
  drawn; 3 are drawn but not counted.
- **Dashboard samples:** 24 of 50,975 read an empty place for phasic, and 94
  for tonic (its longer 8 s lag). These count as "no road" or are skipped.
- **Dropped samples:** 8 samples are left out even though their place is
  known.

**Suggested fix:** one rule everywhere: *a reading counts only if the place
it is filed under has a position.* That means the dashboard checks
`getCoordinates(stimulusIndexAt(t, lag))` instead of `getCoordinates(i)`, for
both samples and peaks.

## 6. The first seconds of a recording: piled up in one view, dropped in another (real, tiny)

**Replaced:** one edge rule everywhere. See "Edges".

**What happens:** readings in the first 2 s (or 8 s for tonic) have a place
from before the recording started.

- `stimulusIndexAt` clamps these to row 0, so they are all filed at the start
  point. This affects map markers, hotspots, the group map and the dashboard.
- Arousal Places **drops** them instead (`arousal_places.mjs`,
  `t < raw[0].time`).

This matters more than expected: in 47 of 59 walks, GPS already has a
position on row 0.

**How often:** 4 peaks, across all walks, are drawn at the very start point
when their real cause came before the recording. For the group map, the first
~20 phasic rows and ~80 tonic rows of each walk are coloured at the start
point.

**Suggested fix:** follow Arousal Places everywhere, and drop readings whose
place would be before the recording. For example, `stimulusIndexAt` could
return −1 there, and callers already skip −1.

## 7. Group-map "normal level" window is shifted by the latency (real, negligible)

**Replaced:** the normal level becomes a body fact, taken at 0 s. See "Three kinds of result".

**What happens:** since 0e08c74, each walk's normal level (mean/std) is taken
from the rows that have a position. But the colours drawn come from rows
whose **earlier** row has a position. The two windows are offset by 2 s
(8 s for tonic) at each end: 20 to 80 rows out of tens of thousands.

**Suggested fix:** once fix 5 is in, use the same rule here: take the range
of rows whose filed-under place has a position. It is a one-line change in
`gpsRange` (`collective_manager.mjs`), using `locIdx(i)`.

---

# Second pass: wider offset sites

## 8. The latency is counted from the top of a peak, but described as a start delay

**Replaced:** no longer a question. The slider moves the whole signal, peaks included, so each peak moves with the signal it belongs to. The options below are kept for the record only.

**What happens:** every peak detector reports a peak at its **top**
(`peak.time`, `peak.index`). The start of the rise is stored separately
(`peak.onsetTime`). The latency is always subtracted from the top.

But the slider and its notes describe something else. The comment in
`constants.mjs` calls 2 s a "physiologically-recommended SCR-onset-delay",
and the help text says "stimulus delay". That is the time from the cause to
the **start** of the response. The rise from start to top comes on top of
that, and the app never counts it.

**How big:** across 9,087 peaks, the rise from start to top takes a median of
1.5 s (most between 1.0 and 2.7 s).

**Example:** a response starts 2 s after the cause and reaches its top 1.5 s
later. So the cause was about 3.5 s before the top. The app looks back only
2 s from the top, which is 0.5 s before the response began. At walking pace
the marker sits about 2 m past where the cause most likely was.

This one number feeds every view: markers, hotspots, Arousal Places, the
group map, the dashboard and junction turns.

**Options:**

- **A. Keep one number, but say what it really means.** Call it "time from
  cause to peak top" and raise the default to about 3.5 s. This is simple,
  and continuous series (phasic, AUC) keep working the same way, since they
  have no start point.
- **B. Count from each peak's own start** (`onsetTime − lag`) for peaks
  only. This is more precise per peak, but then peaks and continuous series
  use different rules, which would be a new inconsistency.


## 9. The coloured path and the 3D wall are not shifted, but markers and the group map are

**Replaced:** the path and wall will move with everything else. See the Solution design.

**What happens:**

- **Not shifted:** the single-view path colour (`map/manager/path.mjs`) and
  the 3D wall's height and colour (`globe3d_base.mjs`) take each row's value
  and draw it at that same row's position.
- **Shifted:** peak markers, hotspots, Arousal Places and the group map use
  the earlier position.

So on the same walk the two disagree:

- **Phasic:** the red stretch of path sits a median of 2.3 m (90% of peaks
  under 3 m) past its peak marker.
- **Tonic:** the path's tonic colouring sits a median of 9 m (90% under
  12 m) further along than where the group map puts the same values.

The graph cursor (scrub dot) also has no shift. That is right for a cursor,
but it means hovering over a peak on the graph puts the dot about 2 m from
that peak's marker.

**Suggested fix:** colour the path and the wall at row *i* using the value
from `lag` seconds **later**. That is the same rule in the other direction,
as junction turns already do. After that, colour, markers and the group map
all line up. **Needs your call**, because it changes how the path looks.
Perhaps you prefer the path to show "what the skin did here" rather than
"what this place caused".

## 10. The Live map places peaks with no latency at all (real)

**Replaced:** Live deliberately stays on skin time (see "Exceptions and trade-offs"), so placing peaks with no shift is correct. Only the misleading code comment needs fixing.

**What happens:** the live view runs `analyze(LIVE_ANALYZE_PARAMS, 0)` and
draws markers at `A.getCoordinates(peak.index)` (`live/live_map.mjs`). That
is the peak's own row, with no shift. The comment above that code says it
uses "the SAME … latency-aware placement the main visualiser's map uses",
which isn't true.

**Effect:** a walk streamed live, then exported and opened in the main app,
shows every peak about 2 m further back along the path than it did on the
live map. The live hotspots are also picked without the shift.

**Suggested fix:** the live page has no latency slider, so use the default
(2 s, or whatever fix 8 decides). Place markers and pick hotspots through
`resolveLatencyIndex`, as the main map does.

## 11. Old files with clock-text timestamps: row times up to 0.9 s off (real, 5 walks)

**Still stands** as written (step 3).

**What happens:** walks 030, 031, 032, 038 and 039 use an older format. The
timestamp is clock text such as `2026-07-06T19:12:38Z`, which only has
1-second resolution, so about 10 rows share each timestamp. The parser
(`csv_parser.mjs`, "Reconstruct sub-second timestamps") spreads **all** rows
evenly from the first second to the last. But the number of rows per second
varies (from 1 to 12). So rows drift away from their own labelled second.

**How big:**

| Walk | Rows placed outside their own second | Largest error |
|---|---|---|
| 030 | 30% | 0.4 s |
| 031 | 62% | 0.8 s |
| 032 | 36% | 0.5 s |
| 038 | 60% | 0.9 s |
| 039 | 32% | 0.5 s |

The GPS positions in these files are on the same rows, so GSR and GPS still
match each other. What's off is the timing against the latency lookup and
the time windows.

**Suggested fix:** spread the rows evenly **within each labelled second**
instead of across the whole walk. Then no row can leave its own second.

## 12. The device can stamp rows late during a hold-up (real, 1 walk)

**Still stands** (step 3): rows in the late-stamped stretch are left out.

**What happens:** the device's `timestamp` column counts ticks (0.1 s each).
It is not a clock reading (`pipeline_rel_seconds` in the firmware). If the
device's main loop is held up, the waiting ticks are processed in a quick
burst afterwards. Those rows are then sampled close together, but labelled
0.1 s apart. The firmware's own comments say this counter "stays perfectly
uniform even if the main loop stalls".

GSR and GPS in one row are still read at the same moment, so they stay
paired. What goes wrong is **time**: anything that looks back 2 s or
averages over a window uses the wrong rows during the burst.

**How big:**

- **Walks with the debug column** (`tick_dt_ms`, which records the real time
  between ticks): all of them start with one 0.4–0.7 s start-up delay. That
  shifts the whole walk equally, which is harmless.
- **One real case: biomap_121.** At about 8 min 15 s there is a 6.4 s
  hold-up. For about 15 s, row times are up to 7 s off, then they catch up.
- **Everything else:** within about 1 s (biomap_011, 012) or better.
- **Over whole walks the counter does not drift.** Every file that stores
  its real start and end clock times agrees with the counter to within 1 s,
  which is as precise as those stored times are.

**Suggested fix:** nothing urgent. If it's worth it, the parser could use
`tick_dt_ms`, when the file has it, to rebuild real times. Or it could flag
stretches where the burst error goes over 1 s, so analyses can skip them.

## 13. The dashboard uses speed from two different moments (small)

**Replaced:** speed is place data, so it is taken at the same shifted moment as the other place data. See the Solution design.

**What happens:** in `EnvironmentalStats.buildSamples`:

- **Tonic:** the walking-speed adjustment uses the speed at the **earlier**
  place (`tonicEnv.speed`, read `tonicLatency` back).
- **Phasic:** it uses the speed over the **last second**, at the moment of
  the reading.

**Why it might be fine:** speed affects the skin through effort, which
arguably acts now rather than with a delay. If that's the reasoning, the
code should say so. Otherwise both should use the same moment.

---

## Checked and consistent

These describe the code as it is now. Items marked **(changes)** work
differently under the Solution design.

- **Latency source (changes):** single view uses the slider, collective uses each
  walk's own value, and 3D is single-walk only. Peak-table "show on map",
  hotspot tour, map markers and 3D markers all use `resolveLatencyIndex` with
  the same value.
- **Junction turns (changes: tonic uses the same shift):** these lay out windows in place time and read GSR
  `lag` seconds later, with the tonic lag for tonic. The rule is the same, in
  the other direction. They check coverage, so edge windows are dropped, not
  padded.
- **Arousal Places:** a place's energy is filed under the earlier position,
  the same place the member peaks are drawn at.
- **Scrub dot (changes):** today it shows where you were at the moment of the
  reading, with no shift. Under the Solution design, graph and map share one
  clock (place time), so the dot and the shifted trace always agree.
- **Recording gaps:** none of the 59 walks has a gap over 1 s, so "nearest
  row in time" never jumps across a gap.
- **Time origin:** every walk starts at time 0.
- **No filter adds a delay.** The low-pass filter, gait filter, Hampel spike
  filter, all tonic methods and the spectral filters run forwards and
  backwards (zero-phase), or use centred windows. So none of them moves the
  signal in time.
- **Centred windows:** the 30 s phasic AUC, peak density and group-map
  smoothing are all centred on the reading. They blur the signal but don't
  shift it.
- **Deconvolution modes:** these still report each peak at its top, like the
  other detectors. The driver's impulses (at the start of the rise) are used
  only to find the top.
- **GPS in newer device files:** a fresh position on every row, at 10 per
  second. There are no stale repeats of an older fix.
- **RF / EM fog:** measured at the place itself. The dashboard pairs it with
  the reading from `lag` seconds later, the same as the OSM fields.
- **Map popup heading:** looks 1 s ahead, using the walk's own sample rate.

---

# Solution design

Agreed 2026-09-30. **Step 1 built** on branch `response-delay` (5dddfc7,
0cb6dc5, 5ef9535); steps 2 and 3 still to do. This section replaces the "Suggested fix"
notes in the findings above wherever they differ.

## What the slider is for

The slider is a tool for **looking**. The nervous system adds a delay of
about 2 seconds between a cause and the skin's response. Noticing something
(seeing a car, hearing a noise) can add a little more. The user sets the
slider to around 2–3 s and looks at whether spikes now line up with
something visible on the map, such as a road crossing.

Nothing is guessed or worked out automatically. The slider value is the
shift, and it is the same for everything.

## Two kinds of data

- **Body data** comes from the skin: the GSR signal, tonic, phasic, peaks,
  hotspots, phasic AUC, peak density, and the Arousal and Tri indices.
- **Place data** was measured at the place itself: GPS position, speed, OSM
  context (road type, park, green space…), NDVI, RF and EM fog.

## The rule

> **The slider moves all body data, by the same amount, against all place
> data. It changes *where* body data appears, never *what* it is.**
>
> (One stated exception: the Live view stays on skin time. See "Exceptions
> and trade-offs".)

With the slider at 2 s, the reading from 12:00:10 is paired with the place
where the walker was at 12:00:08, and with everything measured there.

Put in plain terms:

- **Everything from the skin moves together.** Tonic moves by the same amount
  as everything else. Today's separate tonic delay (4 × the slider, up to
  30 s) is removed.
- **Place data never moves.**
- **At 0 s**, everything is exactly where it is today.

## Three kinds of result

To apply the rule, every result on screen falls into one of three kinds.

**1. Facts about the body: never affected by the slider.**
These are worked out from body data alone:

- which peaks were detected, and their size;
- which peaks are hotspots;
- each walk's normal level (for the group map);
- the stats bar (duration, mean SCL, peak count);
- the shape of the graph trace.

Dragging the slider cannot change any of them.

- *Hotspots* are chosen once, with no shift. They are chosen only from peaks
  that have a position at **every** slider setting from 0 to 8 s. That leaves
  out peaks in the first and last few seconds of the GPS part of a walk.
  Without this rule, a hotspot near the start would vanish when the slider
  went up.
- *The normal level* is taken from the part of the walk that has a
  position, at 0 s.

**2. Where body data is drawn: moves with the slider.**
Each body item is drawn at the place from slider seconds earlier:

- peak dots and hotspot stars;
- the path colour and the 3D wall;
- the group map colours and its peak layer;
- the GSR trace on the graph (see "One clock" below).

The item is the same; only its position changes.

**3. Summaries that pair body with place: recomputed with the slider.**
These answer "what was happening here?" or "what kind of place was this?",
so they are meant to change when the pairing changes:

- Arousal Places;
- the group map's contour shapes;
- the dashboard (correlations, road types, speed adjustment);
- junction turns.

They are always worked out from the same shifted pairing as the map, so they
agree with what is drawn.

**In practice:** drag the slider and the same peaks and hotspots slide along
the route. The things built from pairing them with places (Arousal Places,
contours, dashboard numbers) update to match.

## One clock on screen: the time you were at each place

Everything on screen runs on **place time**: the moment the walker was at
each place.

- **The map** is already place time: the path is the walk through the
  places.
- **The graph moves as a whole.** The GSR trace, peaks and hotspots slide
  left by the slider amount. Place data drawn on the graph stays where it
  was measured: road type, park, NDVI and EM fog bands and traces. So at any
  point on the graph, the trace above it and the bands under it are paired,
  just as on the map.
- **Graph and map share one clock.** Hovering the graph at a moment puts the
  map dot at the position for that moment. Hovering the map highlights the
  same moment on the graph. The 3D replay clock is that same moment too, so
  a marker appears as the wall under it is drawn. None of these needs its
  own conversion.
- **Dragging the slider** slides the trace along under the place bands, so
  you can watch a spike move onto (or off) a road crossing.
- **Times shown on screen** are place times only. That covers graph axis
  labels, the peak table and peak popups. For example, a peak's time becomes
  "when you were at its cause", not "when your skin reacted". Exported files
  keep real reading times, so they differ from the screen by the slider
  amount (see "Exceptions and trade-offs").

## Edges: one rule everywhere

A reading is used on the map, the graph's timeline and in every summary only
if the place slider seconds earlier has a position. So:

- **The first slider seconds of a recording** have no place (it would be
  before the recording started). On the graph they are still shown, greyed
  out, just before the start of the timeline, so nothing that is counted goes
  out of view. They are left off the map and out of the summaries.
- **The last slider seconds of the route** have a place but no reading yet.
  The path stays uncoloured there, and the trace ends early on the graph.
- **Rows with no position** (GPS warm-up, after the last fix) behave the
  same: no place, so not drawn or counted.

Body facts (kind 1) are not affected by edges: the peak count and stats
still include the greyed first seconds.

## The slider itself

- **One value for the whole project.** It is saved with the project and
  shown in both single and collective view. (Live doesn't use it; see
  "Exceptions and trade-offs".) It replaces today's per-walk values, which were
  hidden in collective view and could mix different delays on one group map.
  All walks are the same person, so one delay applies to all of them.
- **Range 0–8 s**, in 0.1 s steps (today 0–5 s). That allows for the time it
  takes to notice something, on top of the delay in the nervous system.
- **A plainer name:** "Response delay", with help text along the lines of
  "Moves the skin data back along the route by this many seconds, to help
  find what caused a response." Default 2 s.

## The shift is never saved into the data

- **Stored data, CSV exports and peak labels** keep the real reading times
  and the real, unshifted positions. The slider value is recorded alongside,
  as it is in the project. Otherwise re-opening a file would shift it twice.
- **Map and image exports** show what is on screen, and say which delay was
  used.

## Exceptions and trade-offs

These are known and accepted, so that nobody mistakes them for bugs later.

- **Live stays on skin time.** On the one clock, Live could only show a
  place once its response had arrived, so the display would always trail
  "now" by the slider amount. On a live walk that feels broken. So Live
  behaves as if the slider were at 0, and the shift applies once the walk is
  opened in the main app. This is the one exception to the rule.
- **Screen times and file times differ.** The screen shows place times only.
  Exported files keep real reading times, so a peak shown at 12:00:08 at 2 s
  is at 12:00:10 in the file.
- **Slow summaries catch up when you let go of the slider.** These update
  live while you drag:
  - the dots and hotspot stars;
  - the path colour and the 3D wall;
  - the graph.

  The group map contours, Arousal Places and the dashboard are heavier: they
  are rebuilt from all the readings at once. Whether they can follow the drag
  too is purely a question of calculation speed, which will be measured on a
  large project (Stokey) during the build:
  - **Fast enough:** they follow the drag live, and this trade-off
    disappears.
  - **Too slow:** they update when the slider is released, and for that
    moment they don't match the dots.

  The dashboard already works the second way today.
- **Hotspot spacing can tighten slightly.** Hotspots are spaced 30 m apart at
  0 s. Each then shifts by however far the walker went in the slider time,
  which varies with speed. So at 2 s two hotspots can sit a little under
  30 m apart. They are still the same hotspots.
- **Dashboard tonic numbers change.** Tonic used an 8 s delay (at the 2 s
  default) and now uses the slider value. Tonic results noted from earlier
  runs won't match.
- **Old saved projects open at the default 2 s.** Their per-walk values are
  not carried over (no old-format support while testing).
- **The slider absorbs fixed delays, not changing ones.** Small fixed delays
  in the chain are all absorbed when the slider is tuned by eye:
  - the device's smoothing of the GSR signal (tens of milliseconds);
  - the GPS receiver reporting each position a moment late.

  A delay that changes during a walk can't be absorbed. The one known case
  is the device hold-up in finding 12.

## How it is built: move the join, not the data

The body data itself is never copied or changed. What changes is the single
point where body data meets place data. Every view that pairs the two asks
it, so they all move together and can't drift apart again.

The join is one module with two directions:

1. **From a reading to its place:** body time *t* → place time *t − slider*.
   This gives the position (interpolated between GPS rows, so dragging moves
   things smoothly rather than in 0.1 s jumps) and the place data measured
   there. It is used to draw peaks and hotspots, and by the group map, the
   dashboard and Arousal Places.
2. **From a place to its reading:** place time *t* → body time
   *t + slider*. This is the same join read the other way. It is used by the
   path colour, the 3D wall, the graph trace, and junction turns.

The old one-off lookups (`stimulusIndexAt`, `resolveLatencyIndex`,
`PhysioLatency`'s tonic rule) are removed. A test fails if anything
outside the join shifts time itself.

## Applying the rule to any feature

For anything that shows or uses data, ask three questions:

1. **Is it body data, place data, or both?**
   - Place only → no shift, ever.
   - Body only → a body fact (kind 1), never shifted.
   - Both → it goes through the join.
2. **Is it a fact about the body, or about where?**
   - About the body (what was detected, how big, which are hotspots) → kind
     1, worked out with no shift.
   - About where → kind 2 or 3, through the join.
3. **Which clock is it shown on?** Always place time.

Every feature, sorted:

| Feature | Kind | What the slider does |
|---|---|---|
| Peak detection, sizes, peak count | Body fact | Nothing |
| Hotspot choice | Body fact | Nothing (chosen once, from peaks placed at every setting) |
| Stats bar, graph trace shape | Body fact | Nothing |
| Group map normal level per walk | Body fact | Nothing (taken at 0 s) |
| Graph: GSR trace, peaks, hotspots | Where | Slide left by the slider |
| Graph: road type, park, NDVI bands, EM fog trace | Place | Stay |
| Graph ↔ map hover, 3D replay clock | Clock | Same moment, place time |
| Map path line (its shape) | Place | Stays |
| Map path colour, 3D wall | Where | Shows the reading from slider seconds later |
| Peak dots, hotspot stars (2D, 3D) | Where | Drawn at the place slider seconds earlier |
| Live view (graph, path, markers) | Exception | Skin time: behaves as if the slider were at 0 |
| Road snap, OSM enrichment, NDVI sampling, junction detection, GPS quality | Place | Stay |
| RF / EM fog map layers | Place | Stay |
| Group map colours and peak layer | Where | Through the join |
| Group map contour shapes | Summary | Recomputed |
| Arousal Places | Summary | Recomputed |
| Dashboard (correlations, road types, speed adjustment) | Summary | Recomputed, pairing each reading with the place slider seconds earlier |
| Junction turns | Summary | Recomputed, reading body data slider seconds after each passage |
| Peak table and popup times | Clock | Shown in place time |
| CSV / project export | Data | Never shifted; slider value saved alongside |
| Map / image export | Picture | As on screen, with the delay noted |

## What this settles

| Finding | How |
|---|---|
| 1: hotspots stale after a slider move | Hotspots no longer depend on the slider: chosen once, then moved. |
| 2: hotspots picked before the smoothed path | The smoothed path is built before hotspots are chosen. They are re-chosen when the GPS settings change the path (not the slider). |
| 3: replay timing | The replay clock is place time. A marker appears when the wall under it is drawn. |
| 5, 6, 7: edge rules | One edge rule everywhere (see "Edges"). |
| 8: top or start of peak | No longer a question. A peak moves with the signal it belongs to. |
| 9: path colour not shifted | The path and wall read the join the other way, so they move with everything else. |
| 10: Live not shifted | Live deliberately stays on skin time. It is already consistent with itself; only the code comment is fixed. |
| 13: speed at two moments | Speed is place data, taken at the same shifted moment as all other place data. |

Findings 4, 11 and 12 are about the timestamps, not the slider. They are
fixed separately (step 3 below).

## Steps and how each is proven

**Tests written first (before any build):**

- **`visualiser/tests/test_response_delay.js`** has 27 tests, one per rule
  in this design. They are marked "to do" until the step that delivers them
  lands. They were checked against a throwaway correct version of the join:
  - the join tests pass against it;
  - the tests for views that aren't shifted yet fail for that reason, not
    because of a mistake in the test.
- **`visualiser/tests/test_response_delay_zero_baseline.js`** holds today's
  0 s output for the fixture walk: peaks, peak places, the group map for all
  8 map types, path colours, dashboard numbers and the export. It passes now
  and must keep passing. A deliberate 0.1 s break shows up in every part it
  touches.
- **`visualiser/tests/manual/response_delay/baseline.js`** is the same record
  for all 73 walks in `tracks/`, plus the Stokey dashboard. It was saved
  before the build with `--save`; after each step, `--check` must report
  nothing changed except hotspots.

1. **Build the join and move every feature in the table onto it.** This
   includes the graph (one clock) and the project-wide 0–8 s slider.
   - *Proof at 0 s:* results must match today's version at 0 s exactly, on
     all 59 walks. The only differences allowed are:
     - the hotspot fixes (1, 2);
     - the new hotspot rule (placed at every setting).

     Every other difference is a bug.
   - *Sync test at 2 s:* for every peak, three things must land on the same
     spot on the map:
     - the peak dot;
     - the point on the path coloured by that peak's value;
     - the map dot when hovering that peak on the graph.

     Also, the graph band under each peak must show the same road type as the
     dashboard pairs it with.
   - *"Where, never what" test:* dragging from 0 to 8 s must not change any
     body fact: the detected peaks, their sizes, the hotspots, the stats bar
     or the normal levels.
   - *Export test:* export at 2 s, re-open, and compare. It must match the
     original, with no double shift.
   - *Deliberate-break demo:* the tests are also run with one feature
     deliberately left unshifted, to show that they catch the mismatch.
   - *Live unchanged:* Live must behave exactly as it does today.
   - Plus the unit tests and `npm run smoke -- --compare=main`.
2. **Screenshots at 0, 2 and 3 s** on one walk, in single view, 3D and the
   group map, so you can see everything move together.
3. **Timestamp fixes:**
   - old walks spread rows within each labelled second (11);
   - `tick_dt_ms` used to leave out the late-stamped stretch in biomap_121
     (12);
   - the dashboard's "last second" worked out in seconds, not rows (4).

   Checked on the affected walks only; every other walk must stay identical.

Each step is its own commit.
