'use strict';

/**
 * GSRUI.enrichTrack() orchestration (ui.js) — the collective "Retrieve
 * Spatial Data" flow. The pure per-position spatial maths lives in
 * OSMEnricher.enrichTrack and is covered by test_osm_enrichment.js; here we
 * only check the loop that drives it across every active track:
 *
 *   1. one track failing (bad geometry / Overpass error / oversized bbox)
 *      must NOT abort enrichment of the others, and
 *   2. a geographically spread-out collection (union bbox over the area cap)
 *      still enriches every track, fetching OSM data per track.
 *
 * OsmCache, OSMEnricher and the DOM are stubbed — no IndexedDB, no network.
 *
 * Run: node --test tests/test_osm_enrich_orchestration.js
 */

const assert = require('assert');
const test = require('node:test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

global.window = global;
global.GSR_CONST = require('./mock_constants.js');
global.alert = () => {};

function loadModule(filePath, varName) {
  const src = fs.readFileSync(filePath, 'utf8');
  const wrapped = src
    .replace(new RegExp(`class ${varName}\\s*{`), `global.${varName} = class ${varName} {`)
    .replace(new RegExp(`const ${varName}\\s*=`), `global.${varName} =`);
  vm.runInThisContext(wrapped, { filename: filePath });
}
loadModule(path.join(__dirname, '../src/gps/geo_utils.js'), 'GeoUtils');
loadModule(path.join(__dirname, '../src/signal/stats_math.js'), 'StatsMath');
loadModule(path.join(__dirname, '../src/map/map_colors.js'), 'MapColors');

const { GSRUI } = require('../src/ui/ui.js');

// ── Mutable DOM stub (enrichTrack reads/writes several elements). ──
function makeEl(props = {}) {
  return Object.assign({
    style: {}, innerText: '', innerHTML: '',
    setAttribute() {}, removeAttribute() {},
  }, props);
}
function installDom(overrides = {}) {
  const els = {
    btnEnrichTrack: makeEl(),
    osmStatusContainer: makeEl(),
    osmStatusMessage: makeEl(),
    osmProgressBar: makeEl(),
    osmRadius: makeEl({ value: '50' }),
    gpsSnapRadius: makeEl({ value: '25' }),
    gpsSnapToRoads: makeEl({ checked: false }),
    ...overrides,
  };
  global.document = { getElementById: (id) => els[id] || null, querySelector: () => null };
  return els;
}

// ── Stub OsmCache + OSMEnricher. calls[] records which analyzers were
//    handed to OSMEnricher.enrichTrack. `failFor` names analyzers that
//    should throw (simulating bad geometry / an Overpass error). ──
function installOsmStubs({ failFor = new Set(), bboxAreaKm2 = 1.0 } = {}) {
  const calls = [];
  global.OsmCache = {
    async getForBBox() { return { elements: [] }; },      // always a cache hit
    async planFetch(bbox) { return { fetchBBox: bbox, mergeIds: [] }; },
    async store() {},
  };
  global.OSMEnricher = {
    _isValidCoord: (lat, lon) => lat != null && lon != null && !isNaN(lat) && !isNaN(lon),
    calculateBBox: () => ({ minLat: 0, minLon: 0, maxLat: 0.01, maxLon: 0.01 }),
    calculateBBoxAreaKm2: () => bboxAreaKm2,
    async fetchOSMData() { return { elements: [] }; },
    enrichTrack(analyzer) {
      calls.push(analyzer.__name);
      if (failFor.has(analyzer.__name)) throw new Error('simulated enrichment failure');
      analyzer.isEnriched = true;
      analyzer.enrichmentRadius = 50;
      analyzer._dataVersion = (analyzer._dataVersion || 0) + 1;
    },
  };
  return calls;
}

function fakeTrack(name) {
  return {
    id: name,
    name,
    analyzer: { __name: name, isEnriched: false, raw: [{ lat: 51.5 + Math.random() * 0.01, lon: -0.1 }] },
  };
}

test('enrichTrack (collective): one failing track does not stop the others', async () => {
  installDom();
  const calls = installOsmStubs({ failFor: new Set(['B']) });
  const tracks = ['A', 'B', 'C', 'D'].map(fakeTrack);
  global.AppState = {
    viewMode: 'collective',
    collectiveManager: { getActiveTracks: () => tracks },
  };
  GSRUI.refreshOsmControls = () => {};
  GSRUI.rerenderMap = () => {};

  await GSRUI.enrichTrack(true);

  assert.deepStrictEqual(calls, ['A', 'B', 'C', 'D'], 'every track was attempted, in order');
  assert.deepStrictEqual(
    tracks.map(t => t.analyzer.isEnriched),
    [true, false, true, true],
    'A, C, D enriched; only the failing B did not',
  );
});

test('enrichTrack (collective): a shared fetch that times out falls back to per-track fetches instead of aborting everything', async () => {
  installDom();
  // Union area is 8 km² (under the 12 cap) -> singleFetch is attempted, but
  // the shared OSMEnricher.fetchOSMData call throws (simulating the 504 a
  // dense combined-area query can hit even under the area cap). Every
  // track's own bbox is small and should still be fetched individually.
  let fetchCalls = 0;
  const calls = [];
  global.OsmCache = {
    async getForBBox() { return null; },     // cache miss on both the shared and per-track paths
    async planFetch(bbox) { return { fetchBBox: bbox, mergeIds: [] }; },
    async store() {},
  };
  global.OSMEnricher = {
    _isValidCoord: (lat, lon) => lat != null && !isNaN(lat),
    calculateBBox: () => ({ minLat: 0, minLon: 0, maxLat: 0.01, maxLon: 0.01 }),
    calculateBBoxAreaKm2: () => 8.0,
    async fetchOSMData() {
      fetchCalls++;
      if (fetchCalls === 1) throw new Error('Overpass API timed out after 4 attempts.');
      return { elements: [] };
    },
    enrichTrack(analyzer) { calls.push(analyzer.__name); analyzer.isEnriched = true; },
  };
  const tracks = ['X', 'Y', 'Z'].map(fakeTrack);
  global.AppState = {
    viewMode: 'collective',
    collectiveManager: { getActiveTracks: () => tracks },
  };
  GSRUI.refreshOsmControls = () => {};
  GSRUI.rerenderMap = () => {};

  await GSRUI.enrichTrack(true);

  assert.strictEqual(fetchCalls, 4, '1 failed shared fetch + 3 successful per-track fetches');
  assert.deepStrictEqual(calls, ['X', 'Y', 'Z'], 'every track still enriched via the per-track fallback');
  assert.ok(tracks.every(t => t.analyzer.isEnriched), 'the shared-fetch failure did not abort the whole batch');
});

test('enrichTrack (collective): a spread-out collection (union over the area cap) still enriches every track', async () => {
  installDom();
  // Union bbox reports 40 km² (> 12 cap) so the single-fetch path is skipped;
  // each individual track still reports 1 km², under the cap.
  let call = 0;
  const calls = [];
  global.OsmCache = {
    async getForBBox() { return null; },                  // force the per-track fetch path
    async planFetch(bbox) { return { fetchBBox: bbox, mergeIds: [] }; },
    async store() {},
  };
  global.OSMEnricher = {
    _isValidCoord: (lat, lon) => lat != null && !isNaN(lat),
    calculateBBox: () => ({ minLat: 0, minLon: 0, maxLat: 0.01, maxLon: 0.01 }),
    // first call = the union bbox (huge); the rest = per-track (small)
    calculateBBoxAreaKm2: () => (call++ === 0 ? 40.0 : 1.0),
    async fetchOSMData() { return { elements: [] }; },
    enrichTrack(analyzer) { calls.push(analyzer.__name); analyzer.isEnriched = true; },
  };
  const tracks = ['P', 'Q', 'R'].map(fakeTrack);
  global.AppState = {
    viewMode: 'collective',
    collectiveManager: { getActiveTracks: () => tracks },
  };
  GSRUI.refreshOsmControls = () => {};
  GSRUI.rerenderMap = () => {};

  await GSRUI.enrichTrack(true);

  assert.deepStrictEqual(calls, ['P', 'Q', 'R'], 'all three enriched despite the oversized union bbox');
  assert.ok(tracks.every(t => t.analyzer.isEnriched));
});
