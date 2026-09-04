'use strict';

/**
 * Integration test for GSRUI.updateEnvironmentalDashboard()'s cache
 * self-validation (docs/archive/visualizer_architecture_refactor_plan.md Phase 2).
 *
 * The unit-level coverage in test_analyzer_refactoring.js and
 * test_osm_enrichment.js only proves the WRITE side: that analyze() /
 * setPeakLabel() / setPeakExcluded() / enrichTrack() bump an analyzer's
 * _dataVersion. It says nothing about the READ side — whether ui.js's
 * updateEnvironmentalDashboard() actually notices that bump and recomputes,
 * rather than serving a stale cached object forever.
 *
 * This file drives the REAL updateEnvironmentalDashboard() (not a
 * reimplementation of its caching logic) against a REAL GSRAnalyzer built
 * from an actual track CSV, run through the real analyze() pipeline. DOM is
 * stubbed to bare getElementById/querySelector that return null for every
 * render target (correlationTable, roadArousal table, regressionCanvas) —
 * each of those render methods early-returns on a missing element (see
 * ui.js), so the DOM paint step is skipped while the cache-computation logic
 * above it still runs unmodified.
 *
 * The collective-mode test is the one most worth having: it exercises the
 * versionSig join across multiple active tracks' analyzers, which is new
 * logic (the single-analyzer version-bump mechanics were already unit
 * tested elsewhere) and is exactly the kind of cross-track case the old
 * 9-call-site invalidation scheme was easiest to get wrong in.
 *
 * Run: node tests/test_env_dashboard_cache.js  (or `npm test` for the whole suite)
 */

const assert = require('assert');
const test   = require('node:test');
const fs     = require('fs');
const path   = require('path');
const vm     = require('vm');

global.window = global;
global.GSR_CONST = require('./mock_constants.js');

// ── Bootstrap: same pattern as test_analyzer_refactoring.js — analyzer.js's
//    analyze() references these as bare globals (window.X in the browser). ──
function loadModule(filePath, varName) {
  const src = fs.readFileSync(filePath, 'utf8');
  const wrapped = src.replace(
    new RegExp(`class ${varName}\\s*{`),
    `global.${varName} = class ${varName} {`
  ).replace(
    new RegExp(`const ${varName}\\s*=`),
    `global.${varName} =`
  );
  vm.runInThisContext(wrapped, { filename: filePath });
}

loadModule(path.join(__dirname, '../src/gps/geo_utils.js'),     'GeoUtils');
loadModule(path.join(__dirname, '../src/signal/stats_math.js'),    'StatsMath');   // also read directly by ui.js
loadModule(path.join(__dirname, '../src/map/map_colors.js'),    'MapColors');
loadModule(path.join(__dirname, '../src/gps/gps_filter.js'),    'GpsFilter');
loadModule(path.join(__dirname, '../src/gps/gps_pipeline.js'),  'GpsPipeline');
loadModule(path.join(__dirname, '../src/signal/dwt_filter.js'),    'DWT');
loadModule(path.join(__dirname, '../src/signal/gsr_filter.js'),    'GsrFilter');
loadModule(path.join(__dirname, '../src/signal/deconvolution.js'), 'SCRDeconvolution');

const { GSRAnalyzer } = require('../src/signal/analyzer.js');
const { GSRUI }       = require('../src/ui/ui.js');

// ── Fixture: a real recorded track (same file test_all_pipelines.js uses). ──
const csvText = fs.readFileSync(path.join(__dirname, '../../tracks/biomap_048.csv'), 'utf8');

/**
 * Builds a fully analyzed, "enriched" GSRAnalyzer from the real fixture CSV.
 * OSM enrichment itself is unit tested in test_osm_enrichment.js — here the
 * osm_* fields are stamped directly (with enough variation to exercise the
 * dashboard's grouping/correlation math) since only the cache-invalidation
 * wiring is under test, not enrichment correctness.
 */
function buildEnrichedAnalyzer() {
  const a = new GSRAnalyzer();
  a.parseCSV(csvText);
  a.analyze(GSR_CONST.GSR_DEFAULT, 0);
  a.raw.forEach((pt, i) => {
    pt.osm_road_class = ['residential', 'path', 'primary'][i % 3];
    pt.osm_dist_major_road = 20 + (i % 50);
    pt.osm_in_park = (i % 5 === 0);
    pt.osm_green_pct_50m = (i % 100) / 100;
    pt.osm_dist_green = (i % 7 === 0) ? 999 : (i % 60);   // some "no green in range", rest a real distance
    pt.osm_canopy_pct_50m = (i % 50) * 2;                 // 0..98 %
    pt.osm_building_density_50m = ((i * 7) % 100) / 100;
    pt.osm_dist_water = 100 + (i % 200);
    pt.osm_tree_density_50m = ((i * 3) % 100) / 100;
    pt.osm_amenity_count_50m = i % 5;
    pt.em_fog = 20 + (i % 40); // varying EM Fog Index so the correlation row is meaningful
  });
  a.isEnriched = true;
  a.enrichmentRadius = 50;
  return a;
}

// ── DOM stub: every render target is "missing", so renderCorrelationTable /
//    renderRoadProfile / drawRegressionScatterPlot each hit their early
//    `if (!el) return;` and never touch canvas/table internals — only the
//    cache-computation logic above them (the thing under test) executes.
global.document = {
  getElementById(id) {
    if (id === 'gpsPeakLatency') return { value: '2.0' };
    return null;
  },
  querySelector() { return null; },
};

test('GSRUI.correlationBand: |r| bands are negligible <.10, small <.20, moderate <.30, strong otherwise (sign-independent)', () => {
  const band = (r) => GSRUI.correlationBand(r).key;
  assert.strictEqual(band(0), 'negligible');
  assert.strictEqual(band(0.099), 'negligible');
  assert.strictEqual(band(-0.099), 'negligible');
  assert.strictEqual(band(0.10), 'small');
  assert.strictEqual(band(-0.19), 'small');
  assert.strictEqual(band(0.20), 'moderate');
  assert.strictEqual(band(-0.29), 'moderate');
  assert.strictEqual(band(0.30), 'strong');
  assert.strictEqual(band(-0.85), 'strong');
  assert.strictEqual(band(NaN), 'negligible'); // guarded: NaN -> negligible, never throws
});

test('updateEnvironmentalDashboard (single mode): cache reused across repeated calls when nothing changed', () => {
  const a = buildEnrichedAnalyzer();
  global.AppState = { viewMode: 'single', analyzer: a, activeTrackId: 'trkA' };

  GSRUI.updateEnvironmentalDashboard();
  const first = a._cachedEnvStats;
  assert.ok(first, 'cache populated after first call');
  assert.ok(first.allData.length > 0, 'sanity: dashboard aggregated real data points from the fixture');

  GSRUI.updateEnvironmentalDashboard();
  assert.strictEqual(a._cachedEnvStats, first, 'no mutation occurred -> cache object reused, not recomputed');
});

test('updateEnvironmentalDashboard (single mode): EM Fog is included as a correlation feature when the track carries readings', () => {
  const a = buildEnrichedAnalyzer();
  global.AppState = { viewMode: 'single', analyzer: a, activeTrackId: 'trkA' };

  GSRUI.updateEnvironmentalDashboard();
  const rows = a._cachedEnvStats.correlationMatrix;
  const emRow = rows.find(r => r.key === 'em_fog');
  assert.ok(emRow, 'EM Fog Index row present in the correlation matrix');
  assert.ok(emRow.n > 0, 'EM Fog row has valid paired samples');
  assert.ok(Number.isFinite(emRow.rPhasic) && Number.isFinite(emRow.pPhasic),
    'EM Fog phasic r and p are finite numbers');

  // And absent when no sample carries a reading.
  const b = buildEnrichedAnalyzer();
  b.raw.forEach(pt => { pt.em_fog = NaN; });
  global.AppState = { viewMode: 'single', analyzer: b, activeTrackId: 'trkB' };
  GSRUI.updateEnvironmentalDashboard();
  assert.ok(!b._cachedEnvStats.correlationMatrix.some(r => r.key === 'em_fog'),
    'EM Fog row omitted when every reading is NaN');
});

test('updateEnvironmentalDashboard (single mode): correlation matrix carries FDR q-values, "in park" is a feature, and road profile drops "unclassified"', () => {
  const a = buildEnrichedAnalyzer();
  // Re-stamp road class so one bucket is the OSM catch-all "unclassified".
  a.raw.forEach((pt, i) => { pt.osm_road_class = ['residential', 'unclassified', 'primary'][i % 3]; });
  global.AppState = { viewMode: 'single', analyzer: a, activeTrackId: 'trkA' };

  GSRUI.updateEnvironmentalDashboard();
  const stats = a._cachedEnvStats;

  // FDR q-values attached to every row.
  stats.correlationMatrix.forEach(row => {
    assert.ok('qPhasic' in row && 'qTonic' in row && 'qPeaks' in row,
      `row ${row.key} should carry q-values`);
  });

  // Binary "in park" is now correlated (point-biserial), not dropped as categorical.
  assert.ok(stats.correlationMatrix.some(r => r.key === 'osm_in_park'),
    'osm_in_park present as a correlation feature');
  // Distance-to-green-space (the visual-perception channel) and tree-canopy %
  // are continuous features, picked up from OSM_METRICS automatically.
  assert.ok(stats.correlationMatrix.some(r => r.key === 'osm_dist_green'),
    'osm_dist_green present as a correlation feature');
  assert.ok(stats.correlationMatrix.some(r => r.key === 'osm_canopy_pct_50m'),
    'osm_canopy_pct_50m present as a correlation feature');
  // Road Class stays out (genuinely multi-level categorical).
  assert.ok(!stats.correlationMatrix.some(r => r.key === 'osm_road_class'),
    'osm_road_class still excluded');

  // "unclassified" road bucket is omitted from the profile.
  assert.ok(!stats.roadProfile.some(p => p.name === 'unclassified'),
    'unclassified road type dropped from the road profile');
  assert.ok(stats.roadProfile.length >= 2, 'other road types still profiled');

  // Highest-vs-lowest comparison is a Welch test result, not a CI-overlap flag.
  assert.ok(stats.roadComparison && Number.isFinite(stats.roadComparison.p),
    'roadComparison holds a finite Welch p-value');
  assert.ok(!('_phasicVals' in stats.roadProfile[0]),
    'per-group raw sample arrays are stripped before caching');
});

test('updateEnvironmentalDashboard (single mode): the highest-vs-lowest road gap is Bonferroni-corrected for being the widest of N classes', () => {
  const a = buildEnrichedAnalyzer(); // default fixture stamps 3 road classes
  global.AppState = { viewMode: 'single', analyzer: a, activeTrackId: 'trkA' };

  GSRUI.updateEnvironmentalDashboard();
  const rc = a._cachedEnvStats.roadComparison;

  assert.ok(rc, 'roadComparison present with 3+ road classes');
  assert.ok(rc.nGroups >= 3, `nGroups records the class count (${rc.nGroups})`);
  assert.ok(Number.isFinite(rc.pAdj), 'pAdj is finite');
  assert.ok(rc.pAdj >= rc.p - 1e-12, `selection-corrected pAdj (${rc.pAdj}) is not smaller than the raw p (${rc.p})`);
  assert.ok(rc.pAdj <= 1, 'pAdj is capped at 1');
});

test('updateEnvironmentalDashboard (single mode): a factor that never changes along the route is flagged as no-variance and left unstarred', () => {
  const a = buildEnrichedAnalyzer();
  a.raw.forEach(pt => { pt.osm_green_pct_50m = 42; }); // constant everywhere
  global.AppState = { viewMode: 'single', analyzer: a, activeTrackId: 'trkA' };

  GSRUI.updateEnvironmentalDashboard();
  const row = a._cachedEnvStats.correlationMatrix.find(r => r.key === 'osm_green_pct_50m');
  assert.ok(row && row.hasVariance === false,
    'a constant environmental factor has hasVariance === false');
});

test('updateEnvironmentalDashboard (single mode): recomputes after setPeakLabel edits the active track', () => {
  const a = buildEnrichedAnalyzer();
  assert.ok(a.peaks.length > 0, 'sanity: fixture produces at least one peak under default params');
  global.AppState = { viewMode: 'single', analyzer: a, activeTrackId: 'trkA' };

  GSRUI.updateEnvironmentalDashboard();
  const before = a._cachedEnvStats;

  a.setPeakLabel(a.peaks[0].time, 'Interesting spot');

  GSRUI.updateEnvironmentalDashboard();
  const after = a._cachedEnvStats;
  assert.notStrictEqual(after, before, 'setPeakLabel bumped _dataVersion -> dashboard cache recomputed, not served stale');
});

test('updateEnvironmentalDashboard (single mode): recomputes after setPeakExcluded toggles a peak', () => {
  const a = buildEnrichedAnalyzer();
  assert.ok(a.peaks.length > 0, 'sanity: fixture produces at least one peak under default params');
  global.AppState = { viewMode: 'single', analyzer: a, activeTrackId: 'trkA' };

  GSRUI.updateEnvironmentalDashboard();
  const before = a._cachedEnvStats;

  a.setPeakExcluded(0, true);

  GSRUI.updateEnvironmentalDashboard();
  const after = a._cachedEnvStats;
  assert.notStrictEqual(after, before, 'setPeakExcluded bumped _dataVersion -> dashboard cache recomputed');
});

test('updateEnvironmentalDashboard (single mode): recomputes after the active track is re-analyzed', () => {
  const a = buildEnrichedAnalyzer();
  global.AppState = { viewMode: 'single', analyzer: a, activeTrackId: 'trkA' };

  GSRUI.updateEnvironmentalDashboard();
  const before = a._cachedEnvStats;

  a.analyze({ ...GSR_CONST.GSR_DEFAULT, peakThreshold: 0.05 }, 0);

  GSRUI.updateEnvironmentalDashboard();
  const after = a._cachedEnvStats;
  assert.notStrictEqual(after, before, 're-running analyze() bumped _dataVersion -> dashboard cache recomputed');
});

test('updateEnvironmentalDashboard (collective mode): method scales with walk count (single / fewWalks / metaProvisional / meta)', () => {
  const mkTracks = (n) => Array.from({ length: n }, (_, k) => {
    const a = buildEnrichedAnalyzer();
    // Each walk a slightly different environment so per-walk correlations differ.
    a.raw.forEach((pt, i) => { pt.osm_building_density_50m = ((i * 7 + k * 13) % 100) / 100; });
    return { id: 'trk' + k, analyzer: a };
  });
  const run = (n) => {
    const cm = { getActiveTracks: () => mkTracks(n) };
    global.AppState = { viewMode: 'collective', collectiveManager: cm };
    GSRUI.updateEnvironmentalDashboard();
    return cm._cachedEnvStats.correlationMatrix.filter(r => r.hasVariance);
  };

  // 2 walks: too few to test -> fewWalks, no q.
  run(2).forEach(r => {
    assert.strictEqual(r.mPhasic, 'fewWalks', `${r.key}: 2 walks -> fewWalks`);
    assert.ok(Number.isNaN(r.pPhasic), `${r.key}: fewWalks carries no p`);
  });

  // 4 walks: enough to meta-analyse but under the solid threshold -> provisional.
  run(4).forEach(r => {
    assert.strictEqual(r.mPhasic, 'metaProvisional', `${r.key}: 4 walks -> metaProvisional`);
    assert.ok(r.kPhasic >= 3, `${r.key}: 4-walk meta used >= 3 walks`);
  });

  // 6 walks: a real meta verdict, with a finite p and a q assigned.
  const six = run(6);
  assert.ok(six.length >= 3, 'sanity: several varying features at 6 walks');
  six.forEach(r => {
    assert.strictEqual(r.mPhasic, 'meta', `${r.key}: 6 walks -> meta`);
    assert.ok(Number.isFinite(r.pPhasic) && r.pPhasic >= 0 && r.pPhasic <= 1, `${r.key}: valid meta p`);
    assert.ok(Number.isFinite(r.qPhasic), `${r.key}: meta cell gets an FDR q`);
  });
});

test('updateEnvironmentalDashboard: tonic gets its own longer-lag environment, Peaks is aggregated to 15 s bins, FDR is per channel', () => {
  const mkTracks = (n) => Array.from({ length: n }, (_, k) => {
    const a = buildEnrichedAnalyzer();
    a.raw.forEach((pt, i) => { pt.osm_building_density_50m = ((i * 7 + k * 13) % 100) / 100; });
    return { id: 'trk' + k, analyzer: a };
  });
  const cm = { getActiveTracks: () => mkTracks(6) };
  global.AppState = { viewMode: 'collective', collectiveManager: cm };
  GSRUI.updateEnvironmentalDashboard();
  const stats = cm._cachedEnvStats;

  // Every sampled row carries a separate environment snapshot for the tonic
  // channel (read at a longer lag than the phasic/peaks one).
  assert.ok(stats.allData.length > 0);
  stats.allData.forEach(d => {
    assert.ok(d.tonicEnv && typeof d.tonicEnv === 'object', 'row has tonicEnv');
    assert.ok('osm_green_pct_50m' in d.tonicEnv && 'osm_dist_green' in d.tonicEnv && 'osm_canopy_pct_50m' in d.tonicEnv && 'osm_road_class' in d.tonicEnv && 'em_fog' in d.tonicEnv,
      'tonicEnv carries the OSM fields (incl. dist_green + canopy_pct) + em_fog');
  });

  // Peaks are correlated at 15 s resolution, so a walk needs ~150 s of usable
  // coverage to count for that channel vs ~10 s for phasic — the count of
  // contributing walks can only be lower, never higher.
  stats.correlationMatrix.filter(r => r.hasVariance).forEach(r => {
    assert.ok(r.kPeaks <= r.kPhasic, `${r.key}: kPeaks (${r.kPeaks}) <= kPhasic (${r.kPhasic})`);
  });

  // FDR is now one family per channel: each row's qPhasic must equal
  // benjaminiHochberg() run over ONLY the testable phasic p-values.
  const isTested = (m) => m === 'meta' || m === 'single';
  const phasicFam = stats.correlationMatrix.map(r =>
    (r.hasVariance && isTested(r.mPhasic)) ? r.pPhasic : NaN);
  const expectedQ = StatsMath.benjaminiHochberg(phasicFam);
  stats.correlationMatrix.forEach((r, i) => {
    if (Number.isFinite(expectedQ[i])) {
      assert.ok(Math.abs(r.qPhasic - expectedQ[i]) < 1e-12,
        `${r.key}: qPhasic from a phasic-only BH family (${r.qPhasic} vs ${expectedQ[i]})`);
    }
  });
});

test('updateEnvironmentalDashboard: the road profile groups tonic arousal by the tonic-lagged road class, not the phasic-lagged one', () => {
  const a = buildEnrichedAnalyzer();

  // Latency 2 s (phasic) vs 8 s (tonic, ×4). Flip the road class every 6 s so
  // that for a given sample the class 2 s back and the class 8 s back are one
  // block apart — i.e. always the *opposite* class.
  a.raw.forEach((pt) => {
    pt.osm_road_class = (Math.floor(pt.time / 6) % 2 === 0) ? 'service' : 'primary';
  });
  // Make the tonic signal a step function keyed to the class 8 s earlier: high
  // (100) when the tonic-lag class is 'service', low (1) when it is 'primary'.
  a.raw.forEach((pt, i) => {
    if (!a.tonic || !a.tonic[i]) return;
    const tonicClassIsService = (Math.floor((pt.time - 8) / 6) % 2 === 0);
    a.tonic[i].val = tonicClassIsService ? 100 : 1;
  });

  global.AppState = { viewMode: 'single', analyzer: a, activeTrackId: 'trkA' };
  GSRUI.updateEnvironmentalDashboard();
  const prof = a._cachedEnvStats.roadProfile;
  const service = prof.find(p => p.name === 'service');
  const primary = prof.find(p => p.name === 'primary');
  assert.ok(service && primary, 'both road classes profiled');
  assert.ok(service.timeSpent >= 10 && primary.timeSpent >= 10,
    `sanity: the fixture gave each class enough samples to profile (service ${service.timeSpent}s, primary ${primary.timeSpent}s)`);

  // Correct (tonic-lag) routing: 'service' collects the high-tonic samples,
  // 'primary' the low ones. Phasic-lag routing (the old bug) would swap them,
  // because a sample whose phasic class is 'service' has tonic class 'primary'.
  assert.ok(service.meanTonic > 60,
    `'service' meanTonic (${service.meanTonic.toFixed(1)}) reflects tonic-lag routing (≈100), not phasic-lag (≈1)`);
  assert.ok(primary.meanTonic < 40,
    `'primary' meanTonic (${primary.meanTonic.toFixed(1)}) reflects tonic-lag routing (≈1), not phasic-lag (≈100)`);
});

test('updateEnvironmentalDashboard (collective mode): only enriched tracks are analysed; un-enriched ones are ignored', () => {
  const enriched = [0, 1, 2].map(k => {
    const a = buildEnrichedAnalyzer();
    a.raw.forEach((pt, i) => { pt.osm_building_density_50m = ((i * 7 + k * 13) % 100) / 100; });
    return { id: 'trk' + k, analyzer: a };
  });
  const bare = new GSRAnalyzer();
  bare.parseCSV(csvText);
  bare.analyze(GSR_CONST.GSR_DEFAULT, 0);            // parsed + analysed but NOT enriched
  const all = [...enriched, { id: 'trkBare', analyzer: bare }];

  const cm = { getActiveTracks: () => all };
  global.AppState = { viewMode: 'collective', collectiveManager: cm };
  GSRUI.updateEnvironmentalDashboard();

  const stats = cm._cachedEnvStats;
  assert.strictEqual(stats.trackCount, 3, 'only the 3 enriched tracks feed the analysis');
  // The bare track's samples must not appear in allData.
  assert.ok(stats.allData.every(d => d.trackId !== 'trkBare'), 'un-enriched track contributes no samples');
});

test('updateEnvironmentalDashboard (single mode): correlation cells use the single-recording method', () => {
  const a = buildEnrichedAnalyzer();
  global.AppState = { viewMode: 'single', analyzer: a, activeTrackId: 'trkA' };
  GSRUI.updateEnvironmentalDashboard();
  a._cachedEnvStats.correlationMatrix.filter(r => r.hasVariance).forEach(r => {
    assert.strictEqual(r.mPhasic, 'single', `${r.key}: single walk -> 'single' method`);
    assert.strictEqual(r.featureWalks, 1);
  });
});

test('updateEnvironmentalDashboard (collective mode): mutating ONE of several active tracks still invalidates the shared collective cache', () => {
  const trackA = buildEnrichedAnalyzer();
  const trackB = buildEnrichedAnalyzer();
  assert.ok(trackB.peaks.length > 0, 'sanity: fixture produces at least one peak under default params');

  const collectiveManager = {
    getActiveTracks: () => [
      { id: 'trkA', analyzer: trackA },
      { id: 'trkB', analyzer: trackB },
    ],
  };
  global.AppState = { viewMode: 'collective', collectiveManager };

  GSRUI.updateEnvironmentalDashboard();
  const first = collectiveManager._cachedEnvStats;
  assert.ok(first, 'cache populated on the collective manager');

  GSRUI.updateEnvironmentalDashboard();
  assert.strictEqual(collectiveManager._cachedEnvStats, first, 'no mutation -> cache reused');

  // Mutate only the SECOND track. Nothing about track B's mutation routes
  // through "the" dashboard's old invalidation call site by name — this is
  // exactly the shape of miss the 9-call-site scheme was most exposed to.
  trackB.setPeakExcluded(0, true);

  GSRUI.updateEnvironmentalDashboard();
  const after = collectiveManager._cachedEnvStats;
  assert.notStrictEqual(after, first, 'mutating track B alone still invalidates the joined collective cache');
});

test('renderCorrelationTable: interpretation distinguishes "suggestive" (raw p<.05, q≥.05) from negligible and from significant', () => {
  const savedDoc = global.document;
  const savedRAF = global.requestAnimationFrame;
  const cells = [];
  const noteSink = {};
  global.document = {
    querySelector: (s) => s.includes('correlationTable')
      ? { set innerHTML(_) {}, appendChild(el) { cells.push(el.__html); } }
      : null,
    getElementById: (id) => id === 'correlationMethodNote'
      ? { set innerHTML(v) { noteSink.v = v; }, set textContent(v) { noteSink.v = v; } }
      : null,
    createElement: () => ({ set innerHTML(v) { this.__html = v; } }),
  };
  try {
    const meta = (name, rT, pT, qT) => ({
      name, featureWalks: 20, hasVariance: true,
      rPhasic: 0.02, rTonic: rT, rPeaks: 0.01,
      pPhasic: 0.9, pTonic: pT, pPeaks: 0.9,
      qPhasic: 0.9, qTonic: qT, qPeaks: 0.9,
      mPhasic: 'meta', mTonic: 'meta', mPeaks: 'meta',
      kPhasic: 20, kTonic: 20, kPeaks: 20,
    });
    GSRUI.renderCorrelationTable([
      meta('Green Space %', -0.16, 0.02, 0.24),   // suggestive: raw p<.05, q≥.05, small band
      meta('Building Density', 0.04, 0.6, 0.8),   // negligible: |r|<.10
      meta('Distance to Road', -0.28, 0.4, 0.9),  // moderate but raw p high -> inconsistent
    ], 20, 20);

    const interp = cells.map(h => {
      const parts = h.split('</td>');
      return parts[parts.length - 2].replace(/[\s\S]*<td>/, '').trim();
    });
    assert.match(interp[0], /^Suggestive small link to lower baseline arousal .*p = 0\.020 before correction/);
    assert.strictEqual(interp[1], 'No link to arousal — effect sizes are negligible');
    assert.match(interp[2], /inconsistent across the 20 walks it varied in$/);

    // Every row now renders 3 q columns (Phasic, Tonic, Peaks) + interpretation.
    const tdCount = (cells[0].match(/<td>/g) || []).length; // the plain <td> for q's + interp + name
    assert.ok(tdCount >= 4, `row should have the name + 3 q columns + interpretation, got ${tdCount} plain <td>`);
  } finally {
    global.document = savedDoc;
    global.requestAnimationFrame = savedRAF;
  }
});

test('updateEnvironmentalDashboard (single mode): computes speed-adjusted partial correlation on tonic channel', () => {
  const a = buildEnrichedAnalyzer();
  // Stamp speed values (knots) with variation on the raw track
  a.raw.forEach((pt, i) => {
    pt.speedKts = 1.0 + (i % 20) * 0.1; // varying speed
  });
  global.AppState = { viewMode: 'single', analyzer: a, activeTrackId: 'trkA' };

  GSRUI.updateEnvironmentalDashboard();
  const stats = a._cachedEnvStats;

  assert.ok(stats.allData.some(d => typeof d.speed === 'number' && d.speed > 0),
    'allData contains positive walking speed in m/s');

  const row = stats.correlationMatrix.find(r => r.key === 'osm_green_pct_50m');
  assert.ok(row, 'osm_green_pct_50m row present');
  assert.ok('rTonicSpeedAdj' in row, 'rTonicSpeedAdj is present on correlation row');
  assert.ok(Number.isFinite(row.rTonicSpeedAdj), `rTonicSpeedAdj is a finite number, got ${row.rTonicSpeedAdj}`);
  assert.ok('pTonicSpeedAdj' in row, 'pTonicSpeedAdj is present on correlation row');
});

test('sortCorrelationTable: toggles sort direction and sorts matrix rows accordingly', () => {
  const savedDoc = global.document;
  const renderedNames = [];
  global.document = {
    querySelector: (s) => s.includes('correlationTable')
      ? { set innerHTML(_) {}, appendChild(el) { renderedNames.push(el.__html); } }
      : null,
    getElementById: (id) => id === 'correlationMethodNote'
      ? { set innerHTML(_) {}, set textContent(_) {} }
      : (id === 'correlationTable') ? { querySelectorAll: () => [] } : null,
    createElement: () => ({ set innerHTML(v) { this.__html = v; } }),
  };
  try {
    const matrix = [
      { name: 'Green Space %', rPhasic: 0.15, rTonic: 0.05, rPeaks: 0.02, hasVariance: true, mPhasic: 'single' },
      { name: 'Amenity Count', rPhasic: 0.35, rTonic: 0.20, rPeaks: 0.10, hasVariance: true, mPhasic: 'single' },
      { name: 'Building Density', rPhasic: -0.10, rTonic: -0.05, rPeaks: 0.00, hasVariance: true, mPhasic: 'single' },
    ];
    global.AppState.corrSortColumn = null;
    global.AppState.corrSortDirection = 'asc';

    // Default: preserves order
    GSRUI.renderCorrelationTable(matrix, 1, 1);
    assert.match(renderedNames[0], /Green Space %/);
    assert.match(renderedNames[1], /Amenity Count/);
    assert.match(renderedNames[2], /Building Density/);

    // Sort by name asc
    global.AppState.corrSortColumn = 'name';
    global.AppState.corrSortDirection = 'asc';
    renderedNames.length = 0;
    GSRUI.renderCorrelationTable(matrix, 1, 1);
    assert.match(renderedNames[0], /Amenity Count/);
    assert.match(renderedNames[1], /Building Density/);
    assert.match(renderedNames[2], /Green Space %/);

    // Sort by rPhasic desc (highest correlation first)
    global.AppState.corrSortColumn = 'rPhasic';
    global.AppState.corrSortDirection = 'desc';
    renderedNames.length = 0;
    GSRUI.renderCorrelationTable(matrix, 1, 1);
    assert.match(renderedNames[0], /Amenity Count/);   // 0.35
    assert.match(renderedNames[1], /Green Space %/);    // 0.15
    assert.match(renderedNames[2], /Building Density/); // -0.10

    // Clicking same column toggles direction
    GSRUI.sortCorrelationTable('rPhasic');
    assert.strictEqual(global.AppState.corrSortDirection, 'asc');
    GSRUI.sortCorrelationTable('rPhasic');
    assert.strictEqual(global.AppState.corrSortDirection, 'desc');
  } finally {
    global.document = savedDoc;
  }
});

test('sortRoadArousalTable: toggles sort direction and sorts road profile rows', () => {
  const savedDoc = global.document;
  const renderedRoads = [];
  const renderedBars = [];
  global.document = {
    querySelector: (s) => s.includes('roadArousalTable')
      ? { set innerHTML(_) {}, appendChild(el) { renderedRoads.push(el.__html); } }
      : null,
    getElementById: (id) => {
      if (id === 'roadBarChartContainer') return { set innerHTML(_) {}, appendChild(el) { renderedBars.push(el.__html); } };
      if (id === 'roadArousalTable') return { querySelectorAll: () => [] };
      return null;
    },
    createElement: () => ({ set innerHTML(v) { this.__html = v; } }),
  };
  try {
    const profile = [
      { name: 'residential', timeSpent: 120, effSamples: 30, meanPhasic: 0.12, stdPhasic: 0.05, ciPhasic: 0.02, meanTonic: 2.1, ciTonic: 0.1, peakRate: 1.5 },
      { name: 'footway', timeSpent: 300, effSamples: 80, meanPhasic: 0.35, stdPhasic: 0.10, ciPhasic: 0.03, meanTonic: 1.8, ciTonic: 0.2, peakRate: 3.2 },
      { name: 'primary', timeSpent: 50, effSamples: 15, meanPhasic: 0.08, stdPhasic: 0.04, ciPhasic: 0.02, meanTonic: 2.5, ciTonic: 0.1, peakRate: 0.8 },
    ];

    // Default sort by meanPhasic desc
    global.AppState.roadSortColumn = 'meanPhasic';
    global.AppState.roadSortDirection = 'desc';
    GSRUI.renderRoadProfile(profile, null);

    assert.match(renderedRoads[0], /footway/);     // 0.35
    assert.match(renderedRoads[1], /residential/); // 0.12
    assert.match(renderedRoads[2], /primary/);     // 0.08

    // Sort by name asc
    global.AppState.roadSortColumn = 'name';
    global.AppState.roadSortDirection = 'asc';
    renderedRoads.length = 0;
    GSRUI.renderRoadProfile(profile, null);

    assert.match(renderedRoads[0], /footway/);
    assert.match(renderedRoads[1], /primary/);
    assert.match(renderedRoads[2], /residential/);

    // Toggle direction
    GSRUI.sortRoadArousalTable('name');
    assert.strictEqual(global.AppState.roadSortDirection, 'desc');
    GSRUI.sortRoadArousalTable('name');
    assert.strictEqual(global.AppState.roadSortDirection, 'asc');
  } finally {
    global.document = savedDoc;
  }
});

