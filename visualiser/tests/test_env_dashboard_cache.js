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
