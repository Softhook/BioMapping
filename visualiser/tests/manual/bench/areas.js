'use strict';
/**
 * Benchmark areas for bench/run.js. Each area:
 *
 *   { name, title, perTrack, columns: [{key,label}], run(ctx) }
 *
 * perTrack:true  — run() is called once per resolved track with ctx.track set;
 *                  it returns one row object keyed by column.
 * perTrack:false — run() is called once with ctx.tracks (all loaded); it
 *                  returns an array of row objects (each with a `track` field).
 *
 * ctx = { h, window, context, mapManager, L, map, GSR_CONST, track, tracks, opts }
 * h   = the harness module (bench, timeMs, …).
 *
 * Areas are pure measurement — no assertions. They time REAL production
 * functions (analyzer.analyze, mapManager.renderData, GSRLabelManager
 * .computeLabelPositions, …), never reimplementations.
 */

const B = (opts, over = {}) => ({ warmup: 2, iters: 10, ...over, ...(opts.iters ? { iters: opts.iters } : {}), ...(opts.warmup ? { warmup: opts.warmup } : {}) });

// Project a peak to a pixel position the same way the real render path does
// (map.latLngToLayerPoint on the peak's GPS fix).
function peakPixels(map, analyzer) {
  const out = [];
  analyzer.peaks.forEach((pk, idx) => {
    if (pk.excluded) return;
    const c = analyzer.getCoordinates(pk.index);
    if (!c) return;
    const p = map.latLngToLayerPoint([c.lat, c.lon]);
    out.push({ idx, px: p.x, py: p.y, coords: c, amplitude: pk.amplitude, time: pk.time });
  });
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
const analyze = {
  name: 'analyze',
  title: 'analyze() — recompute per settled GSR-slider frame (HIT = peak/shape slider · MISS = filter slider)',
  perTrack: true,
  columns: [
    { key: 'rows', label: 'rows' }, { key: 'peaks', label: 'peaks' },
    { key: 'hitMs', label: 'HIT ms' }, { key: 'missMs', label: 'MISS ms' },
  ],
  run({ h, window, track, GSR_CONST, opts }) {
    const { analyzer } = track;
    const params = JSON.parse(JSON.stringify(GSR_CONST.GSR_DEFAULT));
    const hit = h.bench(() => analyzer.analyze(params, 0), B(opts, { iters: 8 }));
    let k = 0;
    const miss = h.bench(
      () => analyzer.analyze({ ...params, lpfWindow: params.lpfWindow + (k++ % 5) * 1e-3 }, 0),
      B(opts, { iters: 8 }));
    return { rows: track.rows, peaks: track.peaks, hitMs: hit.median, missMs: miss.median };
  },
};

// ───────────────────────────────────────────────────────────────────────────
const signalMetrics = {
  name: 'signal-metrics',
  title: 'continuous metrics — peakDensity + phasicAUC + arousalIndex + triIndex (graphView change / slider)',
  perTrack: true,
  columns: [{ key: 'rows', label: 'rows' }, { key: 'totalMs', label: 'all 4 ms' }],
  run({ h, track, opts }) {
    const a = track.analyzer;
    // Same call shape as analyze()'s metric block (analyzer.js): density and
    // AUC computed once, then fed into arousalIndex and triIndex as precomputed.
    const r = h.bench(() => {
      a.peakDensity = a.computeTemporalPeakDensity();
      const auc = a.computePhasicAUC(30);
      a.computeCombinedArousalIndex(0.3, 0.7, auc);
      a.computeTriIndex(0.1, 0.45, 0.45, auc, a.peakDensity);
    }, B(opts, { iters: 12 }));
    return { rows: track.rows, totalMs: r.median };
  },
};

// ───────────────────────────────────────────────────────────────────────────
const arousalPlaces = {
  name: 'arousal-places',
  title: 'Arousal Places recompute — compactClusters + buildPlaces + every getConcaveBlob (peak/merge slider, exclusion)',
  perTrack: true,
  columns: [
    { key: 'peaks', label: 'peaks' }, { key: 'clusters', label: 'clstr' }, { key: 'places', label: 'places' },
    { key: 'clusterMs', label: 'cluster' }, { key: 'buildMs', label: 'build' },
    { key: 'blobMs', label: 'blobs' }, { key: 'totalMs', label: 'TOTAL ms' },
  ],
  run({ h, window, map, mapManager, track, GSR_CONST, opts }) {
    const SC = window.GSRSpatialClustering;
    const AP = window.GSRArousalPlaces;
    const a = track.analyzer;
    h.primeGps(mapManager, track, GSR_CONST);   // production clusters on FILTERED peak coords
    const pts = peakPixels(map, a).map(p => ({
      lat: p.coords.lat, lon: p.coords.lon, amplitude: p.amplitude, time: p.time, trackId: track.id,
    }));
    const scoreTracks = [{ id: track.id, sampleRate: a.sampleRate, raw: a.raw, phasic: a.phasic }];
    const meanAmp = pts.reduce((s, p) => s + (p.amplitude || 0), 0) / Math.max(1, pts.length);

    let clusters;
    const bc = h.bench(() => { clusters = SC.compactClusters(pts, 35, 1.8); }, B(opts, { iters: 12 }));
    const bb = h.bench(() => AP.buildPlaces(clusters, scoreTracks, GSR_CONST.AROUSAL_PLACES), B(opts, { iters: 8 }));
    const places = AP.buildPlaces(clusters, scoreTracks, GSR_CONST.AROUSAL_PLACES);
    const bl = h.bench(() => {
      for (const pl of places) SC.getConcaveBlob(pl.cluster, 12.25, 17.5, meanAmp);
    }, B(opts, { iters: 6 }));

    return {
      peaks: pts.length, clusters: clusters.length, places: places.length,
      clusterMs: bc.median, buildMs: bb.median, blobMs: bl.median,
      totalMs: bc.median + bb.median + bl.median,
    };
  },
};

// ───────────────────────────────────────────────────────────────────────────
const labelPlacement = {
  name: 'label-placement',
  title: 'GSRLabelManager.computeLabelPositions — 360° label collision (runs every peak render, scales with labelled count)',
  perTrack: true,
  columns: [
    { key: 'peaks', label: 'peaks' },
    { key: 'n25Ms', label: '25 lbl ms' }, { key: 'n100Ms', label: '100 lbl ms' }, { key: 'allMs', label: 'all lbl ms' },
  ],
  run({ h, window, map, mapManager, track, GSR_CONST, opts }) {
    const LM = window.GSRLabelManager;
    h.primeGps(mapManager, track, GSR_CONST);   // filtered peak pixel positions, as production
    const px = peakPixels(map, track.analyzer);
    // Candidate arrays built ONCE (computeLabelPositions recomputes text width
    // from `.text` every call and only writes a harmless `.tw` back — safe to
    // reuse). This isolates the collision solver; production adds its own
    // candidate-array build on top, in _renderPeakMarkers' first pass.
    const cand = (n) => px.slice(0, n).map((p, i) => ({ idx: p.idx, px: p.px, py: p.py, text: `Peak ${i} note` }));
    const c25 = cand(25), c100 = cand(100), cAll = cand(px.length);
    const time = (arr) => h.bench(() => LM.computeLabelPositions(arr), B(opts, { iters: 10 })).median;
    return { peaks: px.length, n25Ms: time(c25), n100Ms: time(c100), allMs: time(cAll) };
  },
};

// ───────────────────────────────────────────────────────────────────────────
const gpsPipeline = {
  name: 'gps-pipeline',
  title: '_getOrBuildDrawPoints — a GPS-slider frame: collect + HDOP/speed gates + Kalman RTS + reconstruct + downsample + RDP',
  perTrack: true,
  columns: [{ key: 'rows', label: 'rows' }, { key: 'drawPts', label: 'drawPts' }, { key: 'frameMs', label: 'frame ms' }],
  run({ h, window, mapManager, track, GSR_CONST, opts }) {
    const p = JSON.parse(JSON.stringify(GSR_CONST.GPS_DEFAULT));
    const baseR = p.kalmanR || 10;
    let drawPts = 0, k = 0;
    // Nudge kalmanR each iteration — exactly what a slider drag does. This
    // busts BOTH _gpsCache (params hash) AND analyzer._filteredGpsCacheKey
    // (Kalman output moves), so the reconstruct pass runs every iteration
    // instead of short-circuiting after the first (the trap _bench_render_perf
    // Bench 4 hit). Δ is tiny — the physics is unchanged, the cache keys aren't.
    const r = h.bench(() => {
      p.kalmanR = baseR + (k++ % 4) * 0.1;
      const res = mapManager._getOrBuildDrawPoints(track.id, track.analyzer, p);
      drawPts = res.drawPoints.length;
    }, B(opts, { iters: 8 }));
    return { rows: track.rows, drawPts, frameMs: r.median };
  },
};

// ───────────────────────────────────────────────────────────────────────────
const renderSingle = {
  name: 'render-single',
  title: 'single-track map — renderData() full · refreshPeakMarkers() warm cache · refreshPeakMarkers() forced miss',
  perTrack: true,
  columns: [
    { key: 'peaks', label: 'peaks' },
    { key: 'renderMs', label: 'renderData' }, { key: 'warmMs', label: 'refresh warm' }, { key: 'missMs', label: 'refresh miss' },
  ],
  run({ h, window, mapManager, track, GSR_CONST, opts }) {
    const p = JSON.parse(JSON.stringify(GSR_CONST.GPS_DEFAULT));
    window.AppState.viewMode = 'single';
    window.AppState.activeTrackId = track.id;
    window.AppState.currentTrack = track.track;
    window.AppState.analyzer = track.analyzer;
    mapManager.renderData(track.analyzer, p);                // mount once (also primes the GPS cache)

    // renderData with an UNCHANGED gps param set — the common case after a GSR
    // slider drag: the GPS pipeline is a _gpsCache hit, so this isolates the
    // path + peak-marker + arousal rebuild. A GPS-slider frame (cold pipeline)
    // is the `gps-pipeline` area.
    const render = h.bench(() => mapManager.renderData(track.analyzer, p), B(opts, { iters: 8 }));
    const warm = h.bench(() => mapManager.refreshPeakMarkers(track.analyzer, p, { skipClustering: false }), B(opts, { iters: 8 }));
    let flip = 0;
    const firstPeak = track.analyzer.peaks.find(pk => !pk.excluded);
    const miss = h.bench(() => {
      if (firstPeak) firstPeak.amplitude += (flip++ % 2 ? -1e-4 : 1e-4);
      mapManager.refreshPeakMarkers(track.analyzer, p, { skipClustering: false });
    }, B(opts, { iters: 8 }));
    return { peaks: track.peaks, renderMs: render.median, warmMs: warm.median, missMs: miss.median };
  },
};

// ───────────────────────────────────────────────────────────────────────────
const graphDraw = {
  name: 'graph-draw',
  title: 'p5 draw() — the full graph frame that runs on every hover / scrub / redraw (~60fps budget = 16.6ms)',
  perTrack: true,
  columns: [
    { key: 'rows', label: 'rows' },
    { key: 'fullMs', label: 'full-zoom ms' }, { key: 'winMs', label: '60s-window ms' }, { key: 'pctBudget', label: '% of 16.6ms' },
  ],
  run({ h, window, track, opts }) {
    const A = window.AppState;
    A.analyzer = track.analyzer;
    A.currentTrack = track.track;
    A.viewMode = 'single';
    A.graphView = 'signal';
    A.showRaw = A.showFiltered = A.showTonic = A.showPeaks = A.showHotspots = true;
    A.totalDuration = track.analyzer.raw.length / (track.analyzer.sampleRate || 10);

    A.viewStartTime = 0; A.viewDuration = A.totalDuration;
    const full = h.bench(() => window.draw(), B(opts, { iters: 20 }));
    A.viewStartTime = Math.max(0, A.totalDuration / 2 - 30); A.viewDuration = 60;
    const win = h.bench(() => window.draw(), B(opts, { iters: 20 }));
    return {
      rows: track.rows, fullMs: full.median, winMs: win.median,
      pctBudget: (full.median / 16.6 * 100),
    };
  },
};

// ───────────────────────────────────────────────────────────────────────────
const contourSurface = {
  name: 'contour-surface',
  title: 'generateContourSurface() — collective topography grid (contour slider); IDW splat vs "peaks" KDE',
  perTrack: false,
  columns: [
    { key: 'tracks', label: 'tracks' }, { key: 'totalPeaks', label: 'peaks' },
    { key: 'idwMs', label: 'IDW ms' }, { key: 'peaksMs', label: 'peaks-mode ms' },
  ],
  run({ h, window, mapManager, tracks, GSR_CONST, opts }) {
    const cm = window.AppState.collectiveManager;
    tracks.forEach(t => h.primeGps(mapManager, t, GSR_CONST));  // filtered coords, as the real collective flow
    const base = { gridResolution: 40, upsampledResolution: 120, isolationRadius: 60, blurIterations: 1 };
    const idw = h.bench(() => cm.generateContourSurface({ ...base, topographySource: 'phasic' }), B(opts, { iters: 6 }));
    const pk = h.bench(() => cm.generateContourSurface({ ...base, topographySource: 'peaks' }), B(opts, { iters: 6 }));
    const totalPeaks = tracks.reduce((s, t) => s + t.peaks, 0);
    return [{ track: `${tracks.length}-track set`, tracks: tracks.length, totalPeaks, idwMs: idw.median, peaksMs: pk.median }];
  },
};

// ───────────────────────────────────────────────────────────────────────────
const renderCollective = {
  name: 'render-collective',
  title: 'renderCollectiveData() COLD — every "enter collective / add track / exclusion / merge slider" pays this',
  perTrack: false,
  columns: [
    { key: 'tracks', label: 'tracks' }, { key: 'totalPeaks', label: 'peaks' },
    { key: 'coldMs', label: 'cold render' }, { key: 'buildMs', label: '  of which buildPlaces' },
  ],
  run({ h, window, context, mapManager, tracks, opts }) {
    const vm = require('vm');
    window.AppState.viewMode = 'collective';
    const contourParams = { gridResolution: 40, contourCount: 10, isolationRadius: 50, idwExponent: 2, topographySource: 'phasic', showShadedSurface: false, normalizeZScore: true, surfaceOpacity: 0.4 };
    mapManager.renderCollectiveData(window.AppState.collectiveManager, contourParams, 0);

    // Time buildPlaces() inside the cold render without leaving the wrapper installed.
    const AP = vm.runInContext('GSRArousalPlaces', context);
    const orig = AP.buildPlaces.bind(AP);
    const bCfg = B(opts, { iters: 6 });
    const buildSamples = [];
    AP.buildPlaces = (...a) => {
      const t0 = process.hrtime.bigint();
      const r = orig(...a);
      buildSamples.push(Number(process.hrtime.bigint() - t0) / 1e6);
      return r;
    };
    let cold;
    try {
      cold = h.bench(() => {
        mapManager._arousalPlacesCache = null;              // keep it a COLD measurement
        mapManager.renderCollectiveData(window.AppState.collectiveManager, contourParams, 0);
      }, bCfg);
    } finally { AP.buildPlaces = orig; }

    const timedBuilds = buildSamples.slice(bCfg.warmup);
    const buildMedian = timedBuilds.length ? h.median(timedBuilds) : 0;

    return [{
      track: `${tracks.length}-track set`, tracks: tracks.length,
      totalPeaks: tracks.reduce((s, t) => s + t.peaks, 0),
      coldMs: cold.median, buildMs: buildMedian,
    }];
  },
};

module.exports = [
  analyze,
  signalMetrics,
  arousalPlaces,
  labelPlacement,
  gpsPipeline,
  renderSingle,
  graphDraw,
  contourSurface,
  renderCollective,
];
