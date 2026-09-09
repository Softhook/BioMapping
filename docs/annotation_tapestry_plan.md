# Plan: Annotation Tapestry — a typographic layout engine feeding the SVG export

**Status:** proposal / design — nothing built. 2026-09-09.

## 0. What this is for

We already have an SVG map export (`GSRMapExporter`, `map_exporter.js`) — a
self‑contained, layered, Illustrator‑compatible vector file with its own
geographic projection and a raster basemap. The goal here is to replace the
flat, single‑line, ellipsis‑clipped peak labels it currently emits with a
**typographic tapestry**: every user annotation set as a full block of text,
sized by *importance*, woven over the map without collision and without ever
being hidden.

The hard case is the **collective export** — several walks at once. Each
track's labels are laid out independently today, so the export serialises N
overlapping label sets. The tapestry has to be **one global layout pass across
every active track**, computed in the *export's* projection, not scraped from
whatever the screen happened to render.

Two principles the design must guarantee:

- **P1 — Nothing is dropped.** The only way an annotation leaves the map is the
  user deleting it. If a block can't sit by its point it is displaced with a
  leader; if it still can't fit it goes to a map‑edge slot; last resort, a
  numbered pin + a keyed line in an annotations panel. Never silently removed,
  never `…`‑truncated.
- **P2 — Importance sets visual size.** A more important annotation is set in
  larger, heavier, higher‑contrast type. Text *length* only shapes a block's
  footprint (lines × width), never its type size.

The on‑screen map overlay becomes a **preview of the same engine** — the same
pure layout function, painted to the DOM/canvas instead of serialised to SVG.
The SVG output is what correctness is judged against.

Related: `docs/voice_annotations_proposal.md` (voice transcripts feed the same
`peak.label` field and run long — P1 is why they can't be clipped);
`docs/archive/visualizer_rendering_perf_routes.md`.

---

## 1. What exists today

### 1.1 On the map
| Concern | Now | Reference |
|---|---|---|
| Label source | `peak.label` string, timestamp‑matched to re‑detected peaks; edited via `GSRUI.updatePeakLabel`. | `analyzer._userPeakLabels`; `map_manager_peaks.js:44` |
| Layout | `GSRLabelManager.computeLabelPositions()` — annealing over 8 dirs × 3 gap tiers of **fixed 18 px‑tall** boxes; width `textWidth()` **capped 160 px**. Unplaceable labels are **dropped** (`results.set` only for survivors). | `visualiser/src/render/label_placement.js:96` |
| Overlap index | `YBandIndex` — 1‑D hash, correct *only* for equal‑height boxes. | `label_placement.js:20` |
| Type | Fixed `10px / 600`, `white-space:nowrap; text-overflow:ellipsis`. | `styles.css:1591` |
| Render | One Leaflet `divIcon` per labelled peak (`buildLabelledIcon`). | `label_placement.js:243` |
| Collective | Each track laid out **independently** (`collectiveLabelCandidates` is per‑call) — tracks' notes overlap. | `map_manager_peaks.js:261` |

### 1.2 In the SVG export
| Concern | Now | Reference |
|---|---|---|
| Entry | `exportToSvg()` → `_expandCanvasForIsobands` → `_ensureTileCoverage` → `_gather` → `_render`. | `map_exporter.js:18` |
| Projection | **Its own** Mercator over `mgr.getBounds()` + 5 % pad. `ctx.w/ctx.h` and `ctx.project` come from the geography, **not** the screen viewport. | `map_exporter.js:72` |
| Layers | Named `<g i:layer="yes">` groups: `Base_Map_Tiles` (raster `<image>`), …, `Stress_Peak_Dots`, `Hotspot_Dots`, `Stress_Peak_Labels`. | `map_exporter.js:441` |
| Marker source | `getRenderLayers()` flattens **all tracks'** `peak`/`collectivePeak` markers into one `peakMarkers` array. | `map_manager_layers.js:68` |
| Label emit | `_markers()` iterates those markers, reads each one's **live DOM element** — `querySelector('.peak-map-label')`, `getComputedStyle`, `getBoundingClientRect` — and emits **one `<text>`** per label, single line, `fill="#000"`, `font-family` by name. | `map_exporter.js:821`, `:874` |

### 1.3 The two problems this creates for the export

1. **The export is a DOM scrape.** It copies whatever the live map produced —
   including, in collective mode, N independently‑placed label sets sitting on
   top of each other — and it reads *screen* pixel offsets
   (`getBoundingClientRect`) into a canvas that uses a *different* projection.
   Layout and output are already subtly decoupled.
2. **Flat + lossy.** Single line, ellipsis, uniform 10 px, no importance, no
   leaders, no overflow handling. Fails P1 and P2.

---

## 2. Integration model — layout as data, called twice

Make `annotation_layout.js` a **pure function**:

```
layoutTapestry(annotations, points, frame, opts) → { blocks[], leaders[], marginNotes[], keyed[] }
   annotations : [{ id, text, importance, trackId?, trackColor? }]
   points      : [{ id, x, y }]        // already projected into `frame` space
   frame       : { w, h, safe: {t,r,b,l} }   // the target canvas + its safe inset
   opts        : GSR_CONST.ANNOTATION_TAPESTRY (+ seed)
   → geometry only: rects, lines, text runs. No Leaflet, no DOM, no <text>.
```

- **The SVG exporter calls it** inside `_gather`/`_render` with
  `frame = { w: ctx.w, h: ctx.h }` and `points` projected via `ctx.project`.
  A new `_tapestry(ctx)` returns SVG strings; `_render` drops them into
  importance‑tiered layers (replacing `Stress_Peak_Labels`).
- **The screen overlay calls it** with `frame` = the current Leaflet pixel
  viewport and `points` projected via `map.latLngToContainerPoint`, then
  paints the same geometry to a canvas pane.

Same engine, two frames. The export stops scraping the DOM for labels
entirely — it scrapes only dots/hotspots (unchanged) and asks the layout
module for the tapestry fresh, in its own projection.

**Collective mode is then automatic:** the caller passes **every active
track's** annotations in the one `annotations` array (with `trackId` /
`trackColor`), so the global pass, cross‑track collision avoidance and
de‑duplication all happen in one place — for both the screen and the export,
identically.

---

## 3. Prior art (condensed)

The problem sits across five studied areas; each contributes one pipeline
layer (§4). Full notes + links in the Sources list.

- **Point‑feature label placement** (Christensen–Marks–Shieber 1995): NP‑hard;
  **simulated annealing** is the benchmarked practical solver. → our
  *refinement* stage (it's already what `computeLabelPositions` does).
- **Force‑directed repulsion** (ggrepel, adjustText, `d3-labeler`): labels as
  bodies, spring‑to‑anchor + repulsion; `d3-labeler` is annealing over exactly
  our energy terms. → handles variable‑size blocks; the relaxation move set.
- **Production renderers** (Mapbox/MapLibre GL variable‑anchor + grid
  collision; QGIS PAL obstacle weights; **ArcGIS Maplex** "stack → shrink font
  → abbreviate → key‑number"). → the screen‑space grid collision index, the
  ordered candidate anchors, and Maplex's fitting ladder = our P1 ladder
  (§4.5), key‑numbering included. We reject only "hide on collision".
- **External / boundary labeling** (Bekos et al. survey 2019): map‑edge slots
  + leaders (straight / elbow), one‑sided **DP** for crossing‑free order;
  many‑to‑one **backbones** for shared labels. → P1 rung 4, and the collective
  duplicate merge.
- **Wordle / d3‑cloud**: greedy, weight‑ordered, **spiral out from the
  preferred spot until it fits**; quadtree + hierarchical bounding boxes. →
  the deterministic seed ("spiral from my point" ≡ "stay near my point").
- **Knuth–Plass** line breaking + *Knuth‑Plass Revisited* (multiple break
  solutions at different heights). → typeset emits a **menu of shapes** per
  annotation.
- Screen‑only: **consistent dynamic labeling / active ranges** (Been et al.
  SoCG'08) for zoom stability; **excentric labeling** (Fekete & Plaisant CHI'99)
  for dense‑cluster hover. Both irrelevant to the fixed‑scale SVG.

---

## 4. The layout pipeline (`annotation_layout.js` + `annotation_typeset.js`)

```
annotations + importance
   ▼
1 TYPESET   importance → size tier; Knuth–Plass → 2–4 candidate shapes;
            length → footprint; low importance → lighter weight + greyer ink
   ▼
2 SEED      Wordle spiral-from-point, importance order, grid/quadtree collision
   ▼
3 REFINE    annealed shape/position swaps + micro-translate; energy model §4.4
   ▼
4 LADDER    P1 escalation for anything still overlapping (§4.5)
   ▼
   → geometry: blocks[], leaders[], marginNotes[], keyed[]
```

Pure, DOM‑free, seeded‑deterministic — tests link it (`biomap_format` /
analyzer discipline). Runs once per frame (export frame, or viewport frame).

### 4.1 Importance → type scale (`annotation_importance.js`)

`importance ι ∈ [0,1]` — a tunable blend
(`GSR_CONST.ANNOTATION_TAPESTRY.importance`):

| Signal | Source |
|---|---|
| Hotspot / memorable event | `analyzer.memorableEvents` (strong) |
| Amplitude percentile | `peak.amplitude` within track |
| Prominence percentile | `peak.prominence` (when the Prominence detector is on) |
| Dwell | dwell at the point (`dwell_time_spec.md`) |
| Collective agreement | tracks flagging the same place (collective only) |
| Arousal‑Place rank | `P1..Pn` if the peak sits in one |
| **Manual override** | new `peak.labelSize ∈ {auto,S,M,L,XL}` in the popup — **wins outright** when not `auto` |

`ι` → tier on a modular scale (px, same unit as the export `viewBox` today):

| ι / override | Tier | px | Weight | Ink |
|---|---|---|---|---|
| ≥ .85 / XL | display | 22 | 700 | 100 % (near‑black / track colour) |
| .65–.85 / L | head | 16 | 650 | 100 % |
| .40–.65 / M | body | 12 | 600 | 85 % |
| .20–.40 / S | caption | 10 | 500 | 65 % |
| < .20 | fine | 8.5 | 400 | 50 % |

- Length never touches this table — it feeds Knuth–Plass for lines × measure
  at the tier size. Short + important → one big line, tiny box. Long +
  important → big type, many lines, a large slab. Long + unimportant → small
  grey paragraph that recedes into texture.
- **Legibility floor** `minPx` (≈ 8). The ladder shrinks *footprint*, not type,
  below it.
- Weight **and ink density** track `ι` — the tapestry gets tonal light/dark
  rhythm, not just big/small. Flush‑left ragged blocks throughout.

### 4.2 Seed — Wordle spiral
Blocks in importance order (display tier claims space first). Each starts on
its point's open side (away from the path heading / frame centre); on
collision, step along an Archimedean spiral, trying each shape from the menu,
until free. Collision via a frame‑space grid / quadtree of AABBs (packed‑int
cell keys — reuse the overlap‑cell index from the 2026‑09‑08 render‑perf work).
Deterministic.

### 4.3 Refine
Seed → improve under a time/iteration budget, seeded RNG. **Discrete** move:
re‑pick `(shape, spiral angle/tier)` (annealing, `exp(−Δ/T)`, cool + reheat —
the shape of today's `computeLabelPositions`). **Continuous** move:
`d3-labeler`‑style ±few‑px translate down the energy gradient, for tight
packing and neighbour baseline alignment.

### 4.4 Energy model (`GSR_CONST.ANNOTATION_TAPESTRY.energy`)

| Term | Type | Meaning |
|---|---|---|
| `blockOverlap` | hard | intersection area with another block |
| `markerOverlap` | hard | covering a peak dot / hotspot star |
| `anchorPull` | soft, ×ι | block↔own‑point distance (important notes hug tighter) |
| `leaderLength` | soft | leader length (prefer no leader) |
| `leaderCross` | soft | leader crossing another leader / block |
| `pathOcclusion` | soft, low | block over the GPS path (Maplex obstacle weight) |
| `edgePenalty` | hard at `frame.safe` | block past the safe inset |
| `flowBonus` | negative | baseline aligned with a near neighbour → woven texture |
| `importanceInversion` | soft | a lower‑ι block occluding the read‑path to a higher‑ι one |

### 4.5 P1 escalation ladder
Per block, first rung that seats it wins:

1. **Adjacent** — by the point, no leader.
2. **Displaced** — further out, + leader.
3. **Reshape** — a narrower/taller shape from the menu; if still stuck and ι is
   low, drop **one** tier (never below `minPx`) and retry 2. (Maplex.)
4. **Edge slot** — seat against the nearest frame edge, ordered by where the
   point falls along that edge, elbow leader; one‑sided DP → no leader
   crossings. Collective near‑duplicates share a backbone + "×N".
5. **Keyed** — edge full (`maxEdgePerSide`): a small numbered pin at the point
   + a numbered line in an **annotations panel** block placed in the largest
   empty frame region. Reading‑order numbering.

Only removal path anywhere: the user deletes the annotation. A test asserts
`blocks + marginNotes + keyed` count == input annotation count, always.

---

## 5. SVG export changes (`map_exporter.js`)

Keep everything about the current exporter — projection, canvas sizing, raster
basemap, `i:layer` groups, `_toHex`/`_ratioToHex`, download. Change only the
label path.

### 5.1 New `_tapestry(ctx)` replaces the label scrape
- Gather annotations from the analyzer(s): single mode → `AppState.analyzer`;
  collective → every active track via the collective manager, each annotation
  tagged `trackId` + `trackColor`.
- Project each annotated peak's position with `ctx.project` (the export's own
  Mercator) — **not** `getBoundingClientRect`.
- Compute `ι` (`annotation_importance.js`) and call
  `layoutTapestry(annotations, points, { w: ctx.w, h: ctx.h, safe: … }, opts)`.
- Walk the returned geometry → SVG:
  - each block → a `<g>` of N haloed `<text>` lines (halo via
    `paint-order="stroke fill"` + a white/dark stroke; fallback: a
    fatter‑stroked duplicate `<text>` underlay). Left rule / track‑colour ink
    for collective.
  - leaders → `<polyline>` (elbow) / `<line>`, hairline.
  - the annotations panel (if any keyed) → a bordered `<g>` with numbered rows.
- `_markers()` keeps emitting **dots and hotspot stars** exactly as now; it
  just stops emitting `labels`.

### 5.2 Layer structure
Replace `Stress_Peak_Labels` with importance‑tiered groups so a designer can
restyle a whole tier in Illustrator:

```
Annotations_Display      display + head tiers
Annotations_Body         body + caption + fine
Annotation_Leaders       interior + elbow leaders
Annotation_Edge_Notes    edge-seated notes + backbones
Annotation_Key_Panel     numbered pins + the panel block
```

All vector, DPI‑independent (only the basemap is raster, unchanged).

### 5.3 Collective specifics
- One `layoutTapestry` call for all tracks → cross‑track collisions handled,
  no per‑track piles.
- **Near‑duplicate merge:** annotations with similar text (case/punct‑
  insensitive, Levenshtein ratio > `dedupeRatio`) whose points are within
  `dedupeDistPx` in `ctx` space → one block, stacked multi‑colour left rule,
  "×N", `ι` = max of members. (Boundary‑labeling backbone when edge‑seated.)
- Track keying: a 2 px left rule in `trackColor` for body/caption/fine; the
  track colour *as the ink* for display/head. Consistent with the existing
  convention (collective dots stay neutral; the popup carries the track name —
  `map_manager_peaks.js:474`).
- Importance order in the seed is cross‑track (a hotspot in any track wins the
  best space).

### 5.4 Determinism
Seeded RNG + fixed `ι` blend ⇒ the same bounds + same annotation set produce a
**byte‑identical SVG** — needed for reprints and for iterating a design in
Illustrator without the layout shifting underneath. Snapshot test.

### 5.5 Out of scope (pre‑existing, not this plan)
SVG `<text>` referencing fonts by family name (no embedding / outlining) is how
the exporter works today and stays that way here — a separate concern if it
ever matters. No page‑size presets, no basemap filtering — the export keeps its
current geo‑bounds canvas.

---

## 6. Screen overlay (secondary)

`annotation_overlay.js` — a Leaflet canvas pane that calls the same
`layoutTapestry` with the viewport frame and paints the geometry. Behind
`GSR_CONST.ANNOTATION_TAPESTRY.enabled` / `?tapestry=1`; old divIcon path kept
for A/B until promotion. Zoom stability via precomputed **active ranges** (Been
et al.) rather than re‑annealing on `zoomend`; dense clusters collapse to a
badge that **excentric‑explodes** on hover; click a block → existing
`GSRUI.focusOnPeak` popup (now also carrying the size override). Full detail
deferred — the export is the priority.

---

## 7. Architecture

```
visualiser/src/render/
  annotation_importance.js  NEW  pure: peak + track context → ι
  annotation_typeset.js     NEW  pure: (text, ι) → {tier, shape menu}   [Knuth–Plass + measure]
  annotation_layout.js      NEW  pure: annotations + points + frame → {blocks,leaders,marginNotes,keyed}
  annotation_overlay.js     NEW  screen: canvas pane calling layoutTapestry (secondary)
  label_placement.js        TRIM to buildLabelledIcon if still needed; else retire
                                 (verify 3D globe / live.html first — "verify before migrating")
visualiser/src/map/
  map_exporter.js           EDIT _tapestry(ctx); tiered layers; drop label scrape from _markers
  map_manager_peaks.js      EDIT feed the overlay instead of labelled divIcons (screen)
  map_manager_collective.js EDIT gather all-track annotations for the overlay
  map_manager_render.js     EDIT refreshPeakMarkers → overlay.relayout()
  map.js                    EDIT register the pane (screen)
visualiser/src/core/constants.js   EDIT  GSR_CONST.ANNOTATION_TAPESTRY
visualiser/styles.css              EDIT  --tap-* custom props (light + dark)
visualiser/tests/
  test_annotation_importance.js  NEW
  test_annotation_typeset.js     NEW
  test_annotation_layout.js      NEW   (absorbs live assertions from test_label_placement.js)
  test_map_exporter_tapestry.js  NEW   (SVG snapshot + P1 count invariant, single + collective)
vendor/                           ADD  Knuth–Plass breaker, or a ~150-line in-repo DP — Phase 2
```

`annotation_{importance,typeset,layout}.js` are SDK/DOM‑free and
seeded‑deterministic. `map_exporter.js` stays the only SVG file;
`annotation_overlay.js` the only canvas/`L.*` file.

---

## 8. Config — `GSR_CONST.ANNOTATION_TAPESTRY`

```js
ANNOTATION_TAPESTRY: {
  enabled: false,                          // flag / ?tapestry=1

  importance: { hotspot:0.35, amplitudePct:0.20, prominencePct:0.15,
                dwell:0.15, collectiveAgreement:0.10, arousalPlaceRank:0.05 },
                // manual {S,M,L,XL} override bypasses the blend

  sizeStops: [ [0.85,22,700,100], [0.65,16,650,100], [0.40,12,600,85],
               [0.20,10,500,65],  [0.00,8.5,400,50] ],   // [minι, px, weight, inkPct]
  minPx: 8, shapeVariants: 3, measureAspect: 1.618, maxLines: 8,

  spiralStepPx: 6, spiralMaxTurns: 6, preferSide: 'awayFromPathHeading',

  energy: { blockOverlap:1000, markerOverlap:800, anchorPull:1.0,
            leaderLength:0.6, leaderCross:40, pathOcclusion:8,
            edgePenalty:120, flowBonus:-12, importanceInversion:25 },
  anneal: { itersBase:400, itersPerN:40, T0:50, cool:0.995, reheatAt:0.01, maxMs:40 },
  seed: 0x9e3779b9,

  leaderStyle: 'po', maxEdgePerSide: 12, leaderWeightPx: 0.75, leaderOpacity: 0.7,
  keyPanel: { enabled: true, position: 'largestGap' },
  safeInsetPx: 16,

  dedupeDistPx: 20, dedupeRatio: 0.9,      // collective near-duplicate merge

  // screen only
  bandRebuildPanMarginPx: 128,
  maxBlocksByZoom: { 12:5, 14:14, 16:40, 18:120, 20:9999 },
  lensRadiusPx: 90, clusterBadgeMin: 4,
}
```

CSS: `--tap-size-*`, `--tap-halo`, `--tap-leader`, `--tap-ink-*` in `:root` +
a `prefers-color-scheme` / `[data-theme]` block.

---

## 9. Phased plan

Each phase builds + passes `run_tests.sh` and is independently shippable.
**The SVG export path leads** (Phase 3); the screen overlay follows.

- **Phase 0 — Spike** (~1 day, throwaway). `tests/manual/annotation_tapestry_bench.html`:
  synthetic points on a fixed frame, a text corpus (word → paragraph) with
  assigned ι. Prove tier selection + Knuth–Plass shape menu + grid collision +
  spiral seed + one refine pass + the P1 ladder → a readable, non‑overlapping,
  nothing‑dropped tapestry, rendered as **SVG**. Tune the constants.
- **Phase 1 — `annotation_importance.js`** + tests. ι blend + manual override.
  Tests: blend monotonicity, override wins, band boundaries.
- **Phase 2 — `annotation_typeset.js`** + tests. Tier → size; Knuth–Plass wrap
  (vendor vs in‑repo — decide here); shape menu; char‑width fallback; long
  single word. Tests: wrap correctness, degenerate inputs.
- **Phase 3 — `annotation_layout.js` + `map_exporter.js` `_tapestry(ctx)`.**
  AABB grid; spiral seed; annealed refine; P1 rungs 1–3. Wire into the
  exporter behind the flag, tiered layers, haloed text, hairline leaders;
  `_markers` stops emitting labels. `test_annotation_layout.js` (sparse → zero
  overlap; dense → all placed; deterministic; refine reduces energy) +
  `test_map_exporter_tapestry.js` (SVG snapshot + count invariant, **single
  mode**). **First shippable tapestry in the real deliverable.**
- **Phase 4 — Collective export.** One global `layoutTapestry` call for all
  active tracks in `_tapestry`; track‑colour keying; near‑duplicate merge +
  backbones + "×N"; cross‑track ι order. Extend `test_map_exporter_tapestry.js`
  to collective fixtures. **This is the case the user is asking about.**
- **Phase 5 — P1 rungs 4–5.** Edge slots + one‑sided DP + elbow leaders;
  `Annotation_Edge_Notes` + `Annotation_Key_Panel` layers. Locks in P1.
- **Phase 6 — Screen overlay.** `annotation_overlay.js`: paint `layoutTapestry`
  output to a canvas pane, debounced `moveend`, gesture translate. Wire into
  `_renderPeakMarkers` / collective behind the flag; keep divIcons for A/B.
- **Phase 7 — Screen zoom bands + interaction.** Active ranges; fade/ease;
  LOD; hover raise/expand/dim; cluster badge + excentric explode; click →
  `focusOnPeak` + size override.
- **Phase 8 — Promote + remove old path.** Flip `enabled`; delete the divIcon
  label branch + dead `.peak-map-label` rules; retire/shrink
  `label_placement.js` (verify no other caller first); update tests; archive
  this doc with a "what shipped" header; `README.md` §.

---

## 10. Testing

- **Pure modules** (Phases 1–3) carry the logic. Seeded RNG ⇒ exact
  assertions. Fixtures under `tests/fixtures/`: annotation texts (word → 300
  chars), point sets, ι vectors, single + collective scenarios.
- **P1 invariant** (load‑bearing): random points × ι × frame →
  `blocks + marginNotes + keyed` count == input count; every form ∈ {adjacent,
  displaced, reshaped, edge, keyed}; no `…`.
- **No‑overlap**: no block↔block intersection > ε; no leader crossings after
  the DP.
- **Anchoring**: every interior leader endpoint == its point; every keyed
  number matches its pin.
- **Determinism**: same inputs ⇒ byte‑identical placement list **and**
  byte‑identical SVG (snapshot), single and collective.
- **Export projection**: blocks land inside `ctx.w × ctx.h` (minus safe
  inset) unless edge‑seated; positions derive from `ctx.project`, never
  `getBoundingClientRect`.
- **Perf**: `_bench_annotation_layout.js` at 50 / 200 / 1000 labels vs §11.

---

## 11. Performance budget

Reuse the packed‑int overlap‑cell index (memory: *Visualiser render perf
2026‑09‑08*) so the solver doesn't give back the 3× 2D‑render win.

| Labels | Layout (1–4) | SVG serialise | Screen paint |
|---|---|---|---|
| 50 | < 5 ms | < 10 ms | < 2 ms |
| 200 | < 18 ms | < 30 ms | < 5 ms |
| 1000 | < 70 ms | < 120 ms | < 12 ms (LOD‑capped) |

Export isn't on a frame budget — 1000 labels in ~200 ms total is fine. Screen
levers if over: cap `anneal.maxMs`; fewer `shapeVariants`; refine in a
`requestIdleCallback` slice; memoise typeset across re‑solves (text unchanged
on a pan → only points move).

---

## 12. Open questions

- **Q1 — Importance blend weights** (§4.1), and: for a curated export, is the
  **manual size override** the everyday tool (set every headline by hand, blend
  is just a starting suggestion) rather than the automatic path being primary?
- **Q2 — Leader style**: straight, elbow, or none in the interior (rely on
  proximity + a tint) with elbows only for edge notes?
- **Q3 — Collective duplicates**: merge by text similarity (which ratio?) with
  a backbone, or keep every track's note and colour‑stack them without merging?
- **Q4 — Key panel**: a rare last resort, or an intended feature — an indexed
  margin like an old atlas? Where does it sit (largest gap / reserved band)?
- **Q5 — Collective track keying**: left rule vs track‑colour ink vs a small
  track glyph — what reads as "tapestry" rather than "legend"?
- **Q6 — Typefaces**: one family (app `--font-sans`), or a display/text
  pairing for real editorial texture? Which?
- **Q7 — Knuth–Plass**: vendor a library, or a ~150‑line in‑repo DP to keep
  the "no build step" promise (`README.md`)?
- **Q8 — Screen parity depth**: does the screen overlay need the full P1 ladder
  (edge notes, key panel), or is "adjacent / displaced / cluster badge +
  excentric" enough on screen with the full ladder export‑only?

---

## 13. Appendix — refine‑stage energy sketch

```
function energy(p, state):                 # p = one block's placement, ι = p.importance
    E = 0 ; B = p.rect
    for other in grid.query(B):
        E += area_intersection(B, other.rect) * W.blockOverlap
    for m in grid.queryMarkers(B):
        if contains(B, m.x, m.y): E += W.markerOverlap
    E += dist(nearestEdgePoint(B, p.point), p.point) * W.anchorPull * (0.4 + ι)
    E += p.leaderLen * W.leaderLength
    for L2 in nearbyLeaders(p):
        if crosses(p.leader, L2): E += W.leaderCross
    E += pathOverlapLen(B, pathPolyline) * W.pathOcclusion
    E += clippedArea(B, frame.safe) * W.edgePenalty
    if baselineAligns(B, nearestNeighbourBlock(B)): E += W.flowBonus       # negative
    for hi in higherImportanceNeighbours(B, state):
        if occludesReadPath(B, hi): E += W.importanceInversion
    return E
```

Seed (Wordle spiral) supplies the initial state; refinement minimises
`Σ energy(p)` under `anneal.maxMs`; the ladder re‑seats anything that can't
reach `blockOverlap == 0`. The grid keeps each call `O(local)`.

---

## Sources

- Christensen, Marks, Shieber, *An Empirical Study of Algorithms for Point‑Feature Label Placement*, ACM ToG 14(3), 1995 — <https://www.eecs.harvard.edu/~shieber/Biblio/Papers/tog-final.pdf>
- Raidl, *A Genetic Algorithm for Labeling Point Features*, 1998 — <https://www.ac.tuwien.ac.at/files/pub/raidl-98e.pdf>
- *Progressive Reinforcement Learning for PFLP*, IJGI 2026 — <https://doi.org/10.3390/ijgi15040162>
- *A fast and practical grid based algorithm for PFLP* — <https://arxiv.org/pdf/1712.05936>
- ggrepel reference manual — <https://ggrepel.slowkow.com/reference/geom_text_repel.html>
- Mapbox, *Optimize map label placement* — <https://docs.mapbox.com/help/dive-deeper/optimize-map-label-placement/>; *Variable label placement* — <https://docs.mapbox.com/mapbox-gl-js/example/variable-label-placement/>; viewport collision PR — <https://github.com/mapbox/mapbox-gl-js/pull/5150>
- QGIS PAL library — <https://pal.heig-vd.ch/>; `pal::LabelPosition` — <https://api.qgis.org/api/classpal_1_1LabelPosition.html>
- ArcGIS Pro, *Label with the Maplex Label Engine* — <https://pro.arcgis.com/en/pro-app/latest/help/mapping/text/label-with-the-maplex-label-engine.htm>
- Bekos et al., *Boundary Labeling: Models and Efficient Algorithms for Rectangular Maps* — <https://www1.pub.informatik.uni-wuerzburg.de/pub/wolff/pub/bksw-blmea-06.pdf>
- *Many‑to‑One Boundary Labeling with Backbones* — <https://link.springer.com/chapter/10.1007/978-3-319-03841-4_22>
- Bekos, Niedermann, Nöllenburg, *External Labeling: A Taxonomy and Survey* — <https://www.researchgate.net/publication/330898829_External_Labeling_Techniques_A_Taxonomy_and_Survey>
- Fekete & Plaisant, *Excentric Labeling*, CHI 1999 — <http://www.cs.umd.edu/projects/hcil/excentric/>
- Fink et al., *Algorithms for Labeling Focus Regions*, InfoVis 2012 — <https://www1.pub.informatik.uni-wuerzburg.de/pub/wolff/pub/fhssw-alfr-InfoVis12.pdf>
- Been et al., *Optimizing Active Ranges for Consistent Dynamic Map Labeling*, SoCG 2008 / CGTA 2010 — <https://www.sciencedirect.com/science/article/pii/S0925772109000649>
- Viégas, Wattenberg, Feinberg, *Participatory Visualization with Wordle* — <http://hint.fm/papers/wordle_final2.pdf>; `jasondavies/d3-cloud` — <https://github.com/jasondavies/d3-cloud>
- *Knuth–Plass Revisited*, DocEng 2015 — <https://dl.acm.org/doi/10.1145/2682571.2797091>; `robertknight/tex-linebreak` — <https://github.com/robertknight/tex-linebreak>
