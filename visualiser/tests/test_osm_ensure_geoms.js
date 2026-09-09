'use strict';

/**
 * GSRUI.ensureOsmGeoms() (ui.js) — the on-demand OSM-geometry resolver behind
 * the Map Display card's "OSM Shapes" checkbox. It gives a track
 * `analyzer.osmGeoms` (geometry only, no `isEnriched`) without a full spatial
 * retrieval, sharing every layer of enrichTrack's cache:
 *
 *   analyzer.osmJson (memory) → OsmCache.getForBBox → planFetch + fetch + store
 *
 * OsmCache, OSMEnricher and the DOM are stubbed — no IndexedDB, no network.
 *
 * Run: node --test tests/test_osm_ensure_geoms.js
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

function installDom(overrides = {}) {
  const mk = (props = {}) => Object.assign({ style: {}, value: '' }, props);
  const els = {
    osmRadius: mk({ value: '50' }),
    gpsSnapRadius: mk({ value: '25' }),
    ...overrides,
  };
  global.document = { getElementById: (id) => els[id] || null, querySelector: () => null };
  return els;
}

// OSMEnricher stub. `reconstructGeometries` tags its output so tests can
// assert which json each analyzer's geoms came from.
function installOsmStubs({
  cacheHitJson = null,
  fetchJson = { elements: ['fetched'] },
  bboxAreaKm2 = 1.0,
  fetchThrows = false,
} = {}) {
  const log = { getForBBox: 0, planFetch: 0, fetch: 0, store: 0, reconstruct: 0 };

  global.OsmCache = {
    async getForBBox() { log.getForBBox++; return cacheHitJson; },
    async planFetch(bbox) { log.planFetch++; return { fetchBBox: bbox, mergeIds: [] }; },
    async store() { log.store++; },
  };
  global.OSMEnricher = {
    _isValidCoord: (lat, lon) =>
      lat != null && lon != null && !isNaN(lat) && !isNaN(lon) &&
      Math.abs(lat) > 0.001 && Math.abs(lon) > 0.001,
    calculateBBox: () => ({ minLat: 0, minLon: 0, maxLat: 0.01, maxLon: 0.01 }),
    calculateBBoxAreaKm2: () => bboxAreaKm2,
    async fetchOSMData() {
      log.fetch++;
      if (fetchThrows) throw new Error('Overpass API timed out');
      return fetchJson;
    },
    reconstructGeometries(json) {
      log.reconstruct++;
      return { __from: json, ways: [], relations: [] };
    },
  };
  return log;
}

function fakeAnalyzer() {
  return { raw: [{ lat: 51.5, lon: -0.1 }, { lat: 51.51, lon: -0.11 }] };
}

function installSingleTrack(analyzer) {
  global.AppState = { viewMode: 'single', analyzer, collectiveManager: null, activeTrackId: null };
}

test('ensureOsmGeoms: cache hit reconstructs geoms, no network fetch', async () => {
  installDom();
  const cached = { elements: ['cached'] };
  const log = installOsmStubs({ cacheHitJson: cached });
  const analyzer = fakeAnalyzer();
  installSingleTrack(analyzer);

  const res = await GSRUI.ensureOsmGeoms();

  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(
    { fetched: res.fetched, cached: res.cached, failed: res.failed, tooBig: res.tooBig },
    { fetched: 0, cached: 0, failed: 0, tooBig: 0 },
  );
  assert.strictEqual(log.fetch, 0, 'no Overpass fetch on a cache hit');
  assert.strictEqual(log.store, 0, 'nothing stored on a cache hit');
  assert.strictEqual(analyzer.osmJson, cached, 'cache json stashed for enrichTrack reuse');
  assert.strictEqual(analyzer.osmGeoms.__from, cached, 'geoms reconstructed from the cached json');
});

test('ensureOsmGeoms: cache miss fetches via planFetch and stores the result', async () => {
  installDom();
  const fetched = { elements: ['net'] };
  const log = installOsmStubs({ cacheHitJson: null, fetchJson: fetched });
  const analyzer = fakeAnalyzer();
  installSingleTrack(analyzer);

  const res = await GSRUI.ensureOsmGeoms();

  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.fetched, 1);
  assert.strictEqual(log.planFetch, 1);
  assert.strictEqual(log.fetch, 1);
  assert.strictEqual(log.store, 1, 'a fresh fetch is written back to the cache');
  assert.strictEqual(analyzer.osmGeoms.__from, fetched);
});

test('ensureOsmGeoms: an analyzer that already has osmGeoms is left untouched', async () => {
  installDom();
  const log = installOsmStubs({ cacheHitJson: { elements: [] } });
  const analyzer = fakeAnalyzer();
  const existing = { ways: [], relations: [], __from: 'preexisting' };
  analyzer.osmGeoms = existing;
  installSingleTrack(analyzer);

  const res = await GSRUI.ensureOsmGeoms();

  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.cached, 1);
  assert.strictEqual(log.getForBBox, 0, 'the cache is not even consulted');
  assert.strictEqual(log.reconstruct, 0);
  assert.strictEqual(analyzer.osmGeoms, existing, 'existing geoms reference is preserved');
});

test('ensureOsmGeoms: reuses analyzer.osmJson already in memory (no cache, no fetch)', async () => {
  installDom();
  const log = installOsmStubs({ cacheHitJson: null });
  const analyzer = fakeAnalyzer();
  const inMem = { elements: ['in-mem'] };
  analyzer.osmJson = inMem;
  installSingleTrack(analyzer);

  const res = await GSRUI.ensureOsmGeoms();

  assert.strictEqual(res.ok, true);
  assert.strictEqual(log.getForBBox, 0);
  assert.strictEqual(log.fetch, 0);
  assert.strictEqual(analyzer.osmGeoms.__from, inMem);
});

test('ensureOsmGeoms: no GPS fixes → { ok:false, reason:"no-gps" }', async () => {
  installDom();
  installOsmStubs();
  const analyzer = { raw: [{ lat: 0, lon: 0 }] }; // _isValidCoord rejects (0,0)
  installSingleTrack(analyzer);

  const res = await GSRUI.ensureOsmGeoms();

  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'no-gps');
});

test('ensureOsmGeoms: bbox over the 12 km² cap is skipped as tooBig', async () => {
  installDom();
  const log = installOsmStubs({ bboxAreaKm2: 40.0 });
  const analyzer = fakeAnalyzer();
  installSingleTrack(analyzer);

  const res = await GSRUI.ensureOsmGeoms();

  assert.strictEqual(res.ok, false, 'no geoms produced');
  assert.strictEqual(res.tooBig, 1);
  assert.strictEqual(log.fetch, 0, 'an oversized area is never fetched');
});

test('ensureOsmGeoms (collective): one failing fetch does not stop the others', async () => {
  installDom();
  let call = 0;
  const log = { fetch: 0 };
  global.OsmCache = {
    async getForBBox() { return null; },
    async planFetch(bbox) { return { fetchBBox: bbox, mergeIds: [] }; },
    async store() {},
  };
  global.OSMEnricher = {
    _isValidCoord: (lat, lon) => lat != null && !isNaN(lat),
    calculateBBox: () => ({ minLat: 0, minLon: 0, maxLat: 0.01, maxLon: 0.01 }),
    calculateBBoxAreaKm2: () => 1.0,
    async fetchOSMData() {
      log.fetch++;
      call++;
      if (call === 2) throw new Error('simulated Overpass failure');
      return { elements: [call] };
    },
    reconstructGeometries: (json) => ({ __from: json, ways: [], relations: [] }),
  };
  const tracks = ['A', 'B', 'C'].map(name => ({ id: name, name, analyzer: fakeAnalyzer() }));
  global.AppState = {
    viewMode: 'collective',
    collectiveManager: { getActiveTracks: () => tracks },
  };

  const res = await GSRUI.ensureOsmGeoms();

  assert.strictEqual(log.fetch, 3, 'every track was attempted');
  assert.strictEqual(res.fetched, 2);
  assert.strictEqual(res.failed, 1);
  assert.strictEqual(res.ok, true, 'A and C still produced geoms');
  assert.deepStrictEqual(tracks.map(t => !!t.analyzer.osmGeoms), [true, false, true]);
});
