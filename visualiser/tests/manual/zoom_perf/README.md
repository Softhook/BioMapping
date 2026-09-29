# Zoom performance

Measures how smoothly the map zooms, in real Google Chrome with real track
data, and checks the map still behaves after changes made for speed.

```
npm run zoomperf                       # measure every view on phone + desktop
npm run zoomperf -- --compare=HEAD     # the same, next to the last commit
npm run zoomperf:check                 # pass/fail behaviour check
```

Nothing here runs in `npm test`. Run it before and after any change to the
map, its markers or its CSS animations.

## Needs

- Google Chrome installed (or set `CHROME_PATH` to a Chrome/Chromium binary).
- `npm install` in `visualiser/` (brings in `puppeteer-core`, which drives it).
- The track CSVs in the repo's `tracks/` folder.

## What `run.js` measures

For each **view** (Single Track, Collective, Live) on each **device**:

| device | screen | zoom gesture |
|---|---|---|
| `phone` | 390×844, 3× pixel density, touch | two-finger pinch in and out, twice |
| `desktop` | 1440×900, 2× pixel density | trackpad-style scroll in and out, twice |

The CPU is slowed down 4× by default (`--cpu=N`), roughly a mid-range phone,
so problems show up that a fast laptop hides. Map tiles are replaced with a
blank image so network speed never enters a measurement.

| column | meaning | good |
|---|---|---|
| slow frames | frames that took over 20 ms, i.e. visible stutter, out of all frames during the zooms | close to 0 |
| worst 1% frame | how long the slowest 1% of frames took | ~17 ms (60 fps) |
| freezes | tasks that blocked the page for over 50 ms, and the longest | 0 |
| busy zooming | main-thread work per second while zooming (1000 = never idle) | well under 1000 |
| busy at rest | the same with the map sitting still — should be nearly 0 | < 20 |
| page markers | map markers that are page elements (each one is restyled every zoom frame) | tens, not hundreds |

Views and data:

- **single** — `tracks/biomap_019.csv` (a long walk, 327 peaks)
- **collective** — the first 8 `biomap_0xx.csv` walks
- **live** — `biomap_019.csv` replayed as live Bluetooth packets: ~8 minutes
  of walk up front, then a packet every 200 ms while zooming

### Options

| flag | meaning |
|---|---|
| `--views=single,collective,live` | which views (default all) |
| `--devices=phone,desktop` | which devices (default both) |
| `--compare=REF` | also measure a git ref (`HEAD`, `main`, a commit) as "before", from a temporary checkout that is removed afterwards |
| `--runs=N` | repeat and report the median (default 1; use 3 before drawing conclusions — single runs vary by ~10%) |
| `--cpu=N` | CPU slow-down factor (default 4; 1 = full speed) |
| `--track=FILE` | track for single/live |
| `--headful` | show the Chrome window |
| `--json` | results as JSON (progress goes to stderr) |

A full run (3 views × 2 devices) takes a few minutes; with `--compare`,
twice that.

## What `check.js` checks

On Single Track (`--device=desktop` by default, or `phone`), framed on the
densest group of peaks:

1. plain peaks are drawn on the map's canvas, not as page elements
2. the dots are drawn on top of the path and Arousal Place shapes
3. tapping a dot (slightly off-centre) opens its peak popup
4. clicking an Arousal Place opens its popup (the dots don't block it)
5. the Peaks toggle hides and restores the dots
6. SVG export includes the dots
7. the page is idle with the map at rest (no animation repainting it)
8. no page errors

`--root=<visualiser folder>` checks another copy, e.g. an older checkout. On
the commit before these speed-ups, checks 1, 2 and 7 fail and the rest pass.

## Background

The work these tools were built for found three causes of slow zooming, all
visible here:

- **Peak dots as page elements** — hundreds of them, each restyled and
  repainted every zoom frame. Now drawn on the map canvas
  (`src/map/map_markers.mjs`).
- **The hotspot pulse animated `box-shadow`** — which the browser can't hand
  to the graphics chip, so the page repainted 60 times a second even at rest.
  Now scale and fade only (`@keyframes pulse-glow` in `styles.css`).
- **The overlap-aware path recolour at the end of each zoom** — now done once
  after zooming stops (`_schedulePathRefreshOnZoom` in
  `src/map/manager/path.mjs`).

Still open: on Single Track the browser repaints the whole page on every zoom
frame (visible as `paint`/`prepaint` work in `--json` output under
`zoomWork`). It isn't the markers, the graph panel or the map canvases, and
no longer causes slow frames in these measurements.

## Caveats

- Chrome only. Safari (iPhone) renders differently; treat these numbers as a
  guide there and confirm by feel on the device.
- The slowed CPU doesn't slow the graphics chip, so GPU-heavy costs on a real
  phone (large layers at 3× density) are under-represented.
- Headless Chrome redraws the whole page for a screenshot, so it can't show
  frame-to-frame visual jitter; these tools measure timing, not looks.
