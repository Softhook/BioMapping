'use strict';

/**
 * Integration test for GSRUI.updateEnvironmentalDashboard()'s cache
 * self-validation (docs/visualizer_architecture_refactor_plan.md Phase 2).
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

loadModule(path.join(__dirname, '../geo_utils.js'),     'GeoUtils');
loadModule(path.join(__dirname, '../stats_math.js'),    'StatsMath');   // also read directly by ui.js
loadModule(path.join(__dirname, '../map_colors.js'),    'MapColors');
loadModule(path.join(__dirname, '../gps_filter.js'),    'GpsFilter');
loadModule(path.join(__dirname, '../gps_pipeline.js'),  'GpsPipeline');
loadModule(path.join(__dirname, '../dwt_filter.js'),    'DWT');
loadModule(path.join(__dirname, '../gsr_filter.js'),    'GsrFilter');
loadModule(path.join(__dirname, '../deconvolution.js'), 'SCRDeconvolution');

const { GSRAnalyzer } = require('../analyzer.js');
const { GSRUI }       = require('../ui.js');

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
