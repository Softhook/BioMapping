# Nerve Spike Metric — Investigation & Design Proposal

**Status: proposal only — nothing in this document is built.** It answers "what
would it take" for a cvxEDA-driver-derived event metric visible on both the
GSR graph and the map, and ends with the decisions needed before writing code.

> **Settled: additive, not a replacement for Peaks.** Nerve Spikes is a new,
> separate layer — `analyzer.peaks` keeps meaning exactly what it means today
> in every detector mode, cvxEDA included. Two reasons this isn't a rename or
> a swap-in:
>
> - **Peaks and nerve spikes answer different questions.** A peak carries real
>   shape data (rise time, half-recovery, skew, SNR, quality score) computed
>   from the measured curve — "how did the skin actually respond." A nerve
>   spike is "when did the underlying nerve most likely fire." Redefining
>   "peaks" as driver-events under cvxEDA would throw that shape information
>   away for no reason.
> - **Cross-detector comparability would break.** All four detector modes
>   (default, Prominence, Deconvolution, cvxEDA) populate the same
>   `analyzer.peaks` shape today, which is what makes peak counts/qualities
>   comparable across modes. Making "peaks" mean something structurally
>   different under cvxEDA breaks that for one mode only, and forces every
>   consumer of `analyzer.peaks` (table, quality gates, hotspot selection, CSV
>   export) to special-case it.
>
> They can also genuinely *disagree*, usefully: this session's synthetic
> tests showed one SCR peak on the curve corresponding to two real nerve
> spikes underneath it (a compound burst), and the reverse. Seeing both
> together — "one skin response, two nerve firings" — is more information
> than either alone.
>
> Naming follows from this: always **"Nerve Spikes,"** never "peaks" or
> "driver peaks." §1 proved the counts don't match, so calling it "peaks"
> would invite exactly that confusion. The distinct name is load-bearing, not
> decoration.

## 1. Why this needs more than "graph the driver"

Two things established earlier this session (see chat log / git history around
2026-09-11, cvxEDA driver investigation) matter directly here:

1. **The raw driver is not µS.** cvxEDA's `analyzer.phasicDriver` is a *rate*
   (µS/s — confirmed by resampling the same event at 5/10/20 Hz and watching
   the peak scale linearly with sample rate). Matching pursuit's driver is a
   genuine µS amplitude. Any new metric has to pick a unit deliberately, not
   inherit the raw driver's.
2. **A "spike count" isn't free — the raw driver over- and under-counts in
   opposite directions.** Measured on synthetic tracks:
   - The **reconstructed phasic curve** (what `analyzer.peaks` is built from
     today, via `_detectPeaksFromCurve`) *merges* two real SCRs into one
     local maximum once they're closer than roughly 1.5–2 s apart.
   - The **raw driver array**, scanned naively for local maxima
     (`analyzer.phasicDriverPeaks` — already computed by both detectors, but
     has **zero consumers anywhere in the app** today — grepped), *splits* a
     single physiological burst into 2+ "impulses" when the ADMM solve spreads
     one event's mass across adjacent samples of comparable size. Example: a
     2-real-event synthetic track reported 4 driver-array local maxima.

So "the nerve spike metric" is not just "put the driver on an axis" — it needs
a **consolidation step** that turns the raw per-sample driver into a clean
list of discrete events, each with one time and one magnitude. Everything
below is designed around building that once and then feeding it to both the
graph and the map, the same way `analyzer.peaks` already feeds the peak table,
the graph markers, `peakDensity`, and the map/globe today.

## 2. What a "nerve spike" event should be

Proposed shape, one entry per consolidated event:

```js
{
  time,           // s, event time (cluster's dominant/energy-weighted sample)
  index,          // sample index, for onset/gap bookkeeping
  energy,         // µS·s — the event's magnitude (see §3 for why this unit)
  peakRate,       // µS/s (cvxEDA) or µS (MP) — the raw driver value at the
                  // cluster's tallest sample, kept for reference/debugging
  driverAlgorithm // 'cvxeda' | 'matching_pursuit' — which run produced it
}
```

`energy` (µS·s) rather than raw driver height is the deliberate choice: it's
what stays comparable across sample rates and, more importantly, across the
two detectors' different raw-driver conventions — it's the exact quantity
`computePhasicAUC()` already integrates to (µS·s), so a spike's `energy` and
its contribution to Phasic AUC (ISCR) are the same number. That also sidesteps
needing separate axis scales for cvxEDA vs matching-pursuit spikes the way the
raw driver graph does (`GSR_CONST.DRIVER_UNIT_BY_ALGORITHM`).

## 3. The consolidation algorithm

Two candidate approaches, both operating on `analyzer.phasicDriver`
(`[{time, val}]`, already populated by both detectors):

### Option A — reuse the prominence detector's non-max suppression (recommended)

`_prominenceNMS(vals, prom, threshold, minGap, baselineWin)`
([analyzer.js:1728](../visualiser/src/signal/analyzer.js#L1728)) is already a
generic, tested, non-greedy clustering primitive: given a series and its
per-sample topographic prominence, it returns one apex per "hill" under a
minimum-gap refractory suppression. It was built for the raw phasic signal,
but nothing in its signature is phasic-specific — feed it `phasicDriver`
values instead. Needs two adjustments before reuse:
- `_topographicProminence()`'s own scan would need to run on the driver
  series (cheap, O(n log n), same cost as today's prominence detector).
- The artefact ceiling (`MICROSIEMENS_MAX_SCR`, a phasic-µS constant) doesn't
  apply to a µS/s driver — either skip it here or add a driver-appropriate
  ceiling.

Once a cluster's apex samples are chosen, `energy` for each event is the sum
of `phasicDriver[i].val` over the cluster's samples (its local prominence
"hill", or a fixed window around the apex — needs picking, see §7), divided by
`sampleRate` — mirroring `computePhasicAUC`'s own normalisation exactly.

### Option B — simple gap-merge + sum

Cheaper, no prominence machinery: scan the driver for any sample above a
floor, merge consecutive above-floor runs (plus anything within a fixed gap,
e.g. `SCRF.minImpulseGapSec`) into one cluster, event time = the cluster's
peak sample, `energy` = sum of the cluster's driver values / sampleRate. This
is close to what `phasicDriverPeaks` already half-does for matching pursuit
(gating by `imp.amplitude >= threshold`) — it would need the same
unit-appropriate threshold cvxEDA is currently missing (§1, `impulseThreshold`
is calibrated for MP's µS scale, not cvxEDA's µS/s one — it's ~427× too small
in one measured example, which is *why* the naive scan over-counted).

**Recommendation: Option A.** It reuses tested code, its "prominence
≥ threshold" gate is the same mental model already shipped for the raw-signal
Prominence detector, and — unlike Option B's fixed gap-merge — it naturally
absorbs the "one burst spread over 2 adjacent samples" case without a magic
gap constant, the same way it already absorbs shoulder peaks in the phasic
prominence detector.

## 4. Where it plugs into the analyzer

New method, e.g. `GSRAnalyzer.prototype.computeNerveSpikes()`, called from
`_runDeconvolutionPipeline()` right after `this.phasicDriver` is populated
(both the cvxEDA branch, [analyzer.js:750](../visualiser/src/signal/analyzer.js#L750),
and — if generalised, see §8 — the matching-pursuit branch). Sets
`this.nerveSpikes = [...]` (empty when no driver, cleared in
`_clearDeconvState()` alongside `phasicDriver`/`phasicDriverPeaks`/
`_driverAlgorithm`).

This is the same shape of change as everything already gated behind
`_driverAlgorithm` this session — small, localised, and it doesn't touch
`this.peaks` at all (deliberately keeping this a *new*, additional metric
rather than reworking peak identification, which is the separate,
larger-blast-radius change discussed and not yet decided on).

## 5. Graph display — discrete points (chosen direction)

The user's framing: treat nerve spikes **like peaks** — individual,
inspectable, discrete events — not a smoothed rate. That's a better fit than
the continuous-KDE option originally proposed here as primary, for reasons
worth spelling out.

**Why discrete-first is the right call, not just a style preference:**

- It matches what a "nerve spike" conceptually *is* — a specific moment, not a
  windowed average. Smoothing it into a rate throws away exactly the thing §1
  established the driver is good for (precise event timing), in exchange for
  a statistic that's arguably redundant with `peakDensity` (which already
  measures "how bursty is this stretch," just from SCR peaks instead of
  driver spikes).
- It's a **strict precursor** to the continuous view, not an alternative to
  it: once `this.nerveSpikes` exists as a discrete list, `computeTemporalPeakDensity()`'s
  KDE machinery ([analyzer.js:1962](../visualiser/src/signal/analyzer.js#L1962))
  can be handed its times just as easily as `analyzer.peaks`' — a "Nerve Spike
  Rate" graph view stays a small, cheap follow-up whenever it's wanted, not
  foreclosed by building discrete markers first.
- It's also the shape §6 needs anyway if the map layer is going to be
  point-based (see below) — one list serves both.

**What it would look like:** a dot at each `nerveSpikes[i].time`, drawn on the
Driver graph view specifically (not overlaid on Phasic — the two curves are
different things, per this session's earlier discussion of why the phasic
apex is a poor proxy for event time). The existing peak-marker drawing code
(`GSRRenderer.drawPeakMarkers`, [renderer.js:458](../visualiser/src/render/renderer.js#L458))
is a useful reference but is **hardwired to `AppState.analyzer.peaks`**, not
parametrised over an arbitrary array — so this needs a small, purpose-built
sibling function rather than literal reuse. That's the right call anyway:
peaks carry labelling, exclusion, and hotspot-eligibility state that nerve
spikes don't need, so forcing them through the same code path would mean
bolting on unused fields or risking the peak-marker path everything else
depends on.

Whether spikes also get their own row in the peaks table / CSV export, or
stay a visual-only overlay, is open — see §7.

## 6. Map display — discrete points (chosen direction)

Same reasoning as §5: a point per spike, not a colour gradient. The 2D map
already has exactly this paradigm built for peaks —
`_renderPeakMarkers()` ([map_manager_peaks.js:24](../visualiser/src/map/map_manager_peaks.js#L24))
places one `L.marker` per `analyzer.peaks[i]`, resolving each to a GPS
position (with peak-latency correction), building labels, popups, and
z-ordering. Like `drawPeakMarkers` on the graph side, it's **hardwired to
`analyzer.peaks`** (`analyzer.peaks.forEach(...)`, reads `peak.index`/
`peak.label`/`peak.excluded`) — reusing it for a second, independent point set
means a smaller, purpose-built sibling (same paradigm: GPS-resolve each
spike's time via `getCoordinates()`, drop a marker, keep it lighter — no
label-editing/exclusion UI unless that turns out to be wanted), not a
generalisation of the peak-marker code itself.

This reframes the earlier options from a "which paradigm" choice into a
"which layer of polish" question:

- **MVP: individual spike markers**, styled distinctly from peak markers
  (smaller/different colour, per §7), each resolved to a GPS point the same
  way peak markers already are. Given nerve spikes can run 2–4× denser than
  SCR peaks (§1's synthetic examples), likely wants its own sparser
  threshold/min-gap rather than inheriting `peakThreshold`, and probably a
  show/hide toggle so it doesn't clutter the default view.
- **Natural follow-on: feed the same list into Arousal Places.**
  `GSRArousalPlaces.buildPlaces()`
  ([arousal_places.js](../visualiser/src/spatial/arousal_places.js)) already
  expects exactly this shape — an array of `{lat, lon, amplitude, trackId,
  time}` point objects — to cluster into ranked, dwell-normalised "places."
  Choosing discrete points now means that path is a straight data swap later
  (nerve-spike points in place of phasic-driver peaks), not new spatial
  logic — more so than the continuous-colouring path would have set up.
- **Deferred: continuous path/wall colouring** (the `DERIVED_METRIC_SERIES` /
  `SERIES_FIELD` / `map_colors.js` / legend / `#mapColoringMetric` touchpoint
  list from the original proposal) is still available any time a density-style
  view is wanted, off the same KDE-over-spike-times computation as §5 — kept
  here as a reference, not the near-term plan:

  - `DERIVED_METRIC_SERIES` in
    [map_manager_path.js:24](../visualiser/src/map/map_manager_path.js#L24)
  - `SERIES_FIELD` + `HEIGHT_CAPABLE_METRICS` in
    [globe3d.js:66](../visualiser/src/map/globe3d.js#L66) /
    [:83](../visualiser/src/map/globe3d.js#L83)
  - the metric family grouping in
    [map_colors.js:107](../visualiser/src/map/map_colors.js#L107)
  - the label in
    [map_manager_legend.js:92](../visualiser/src/map/map_manager_legend.js#L92)
  - the metric-key map in
    [globe3d/exporters.js:18](../visualiser/src/map/globe3d/exporters.js#L18)
  - the `<option>` in `#mapColoringMetric`
    ([index.html:824](../visualiser/index.html#L824)) / `#topoSource`
    ([index.html:850](../visualiser/index.html#L850))

## 7. Open questions before implementation

1. **Consolidation algorithm** — Option A (prominence reuse) or B (gap-merge)?
   §3 recommends A.
2. **Event energy window** — for Option A, what exactly gets summed into
   `energy`: samples within the prominence "hill" (data-dependent width) or a
   fixed window around each apex (e.g. `minImpulseGapSec`)? Affects how
   compound/overlapping spikes split their combined energy.
3. **cvxEDA only, or also matching pursuit?** The request was specifically
   about the cvxEDA driver, but the consolidation logic and the
   graph/map wiring are detector-agnostic (same as `phasicDriver` itself).
   Restricting to cvxEDA is less work initially and matches the ask; the two
   MP quirks noted in §1 (its driver is already ≈µS, and
   `phasicDriverPeaks` already gates by `peakThreshold`) mean adding MP later
   is a smaller increment than doing both now.
4. **Spike marker density** — nerve spikes can run 2–4× denser than SCR peaks
   (§1). Does the consolidation threshold (§3) alone keep the marker count
   sane, or does the marker layer also need its own zoom-dependent thinning
   the way hotspots/peaks already get at low zoom? Probably answerable only
   by looking at real tracks once `this.nerveSpikes` exists.
5. **How much of the peak-marker feature set do spikes need?** Peaks carry
   user labels, manual exclusion, and CSV export rows. A nerve spike is a
   computed, read-only event — does it need any of that, or is a plain
   hover-tooltip marker (time + energy) enough for a first version? Leaning
   toward the latter (simpler, avoids the label/exclusion machinery §5/§6
   flagged as unnecessary weight), but worth confirming.
6. **Threshold/gating** — a new slider (mirroring `peakThreshold`), or reuse
   an existing one? Needs its own default in whatever unit `energy` ends up
   in (µS·s), not a µS/s driver-height threshold.
7. **Naming** — "Nerve Spike" throughout this doc; also considered "SMNA
   event" (the paper's own term, sympathetic skin nerve activity) — less
   immediately readable to a non-specialist user of this app.

## 8. Effort shape (once the above are answered)

- Consolidation method + `this.nerveSpikes` (analyzer-only, testable in
  isolation the way `test_cvxeda.js`/`test_prominence_detector.js` already do): small.
- Graph markers (§5): small — a purpose-built sibling of `drawPeakMarkers`,
  simpler than the original (no label/exclusion state to carry, per Q5).
- Map markers (§6 MVP): small — a purpose-built sibling of
  `_renderPeakMarkers`, same simplification.
- Arousal-Places follow-on (§6): small once the point list exists — a data
  swap into already-built clustering, not new spatial logic.
- Continuous rate/colouring (deferred, §5/§6): available later off the same
  spike-times list, at the effort already scoped in the original proposal
  (KDE reuse + the six mechanical map touchpoints).

No architecture in this codebase needs to change to support any of this —
every piece above is an extension of an existing, already-proven pattern
(discrete GPS-resolved markers, KDE rate computation, spatial clustering).
The only genuinely new logic is the consolidation step in §3.
