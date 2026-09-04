/**
 * GSRMapManager.drawOsmShapes() — the "OSM Layers" polygon overlay
 * (map_manager_osm.js). It groups fetched OSM ways/relations into three
 * multi-ring L.polygon layers: park (green), water (blue), building.
 *
 * The point of these tests: the overlay's park/water classification is
 * shared with the enrichment metrics (OSMEnricher.isGreenSpace /
 * isWaterSpace), so a polygon drawn green MUST also be the polygon that
 * counts toward green_pct / in_park, and one drawn blue toward dist_water —
 * they can't drift apart the way the old hand-inlined tag list did.
 *
 * Run: node --test tests/test_osm_overlay.js  (or `npm test` for the whole suite)
 */

const test = require('node:test');
const assert = require('node:assert');
const { bootApp } = require('./support/boot_app.js');

const STYLE_FILL = { park: '#52b788', water: '#90e0ef', building: '#9a8c98' };

function capturePolys(fn) {
  const { window } = bootApp();
  window.setup();
  const mgr = window.AppState.mapManager;
  mgr.map = mgr.map || {};
  const calls = [];
  window.L.polygon = (rings, style) => {
    calls.push({ rings, style });
    return { addTo() { return this; } };
  };
  fn(mgr, window);
  // { park: <ringCount>, water: <ringCount>, building: <ringCount> }
  const byCat = { park: 0, water: 0, building: 0 };
  for (const c of calls) {
    const cat = Object.keys(STYLE_FILL).find(k => STYLE_FILL[k] === (c.style && c.style.fillColor));
    if (cat) byCat[cat] += c.rings.length;
  }
  return byCat;
}

const way = (id, tags) => ({
  type: 'way', id, tags,
  coordinates: [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }, { lat: 1, lon: 1 }, { lat: 0, lon: 0 }],
});

test('drawOsmShapes: a wetland is drawn as park (green) — it is green space, matching in_park / green_pct', () => {
  const byCat = capturePolys((mgr) =>
    mgr.drawOsmShapes({ ways: [way('w', { natural: 'wetland' })], relations: [] }));
  assert.strictEqual(byCat.park, 1, 'wetland ring drawn in the green/park layer');
  assert.strictEqual(byCat.water, 0, 'wetland is not ALSO drawn blue (overlay paints one colour; green wins)');
});

test('drawOsmShapes: a playground is drawn as NOTHING — it is not green space', () => {
  const byCat = capturePolys((mgr) =>
    mgr.drawOsmShapes({ ways: [way('p', { leisure: 'playground' })], relations: [] }));
  assert.strictEqual(byCat.park + byCat.water + byCat.building, 0,
    'leisure=playground produces no overlay polygon at all');
});

test('drawOsmShapes: park / lake / building each land in their own layer', () => {
  const byCat = capturePolys((mgr) => mgr.drawOsmShapes({
    ways: [
      way('pk', { leisure: 'park' }),
      way('lk', { natural: 'water' }),
      way('bl', { building: 'yes' }),
      way('pg', { leisure: 'playground' }),   // excluded
    ],
    relations: [],
  }));
  assert.deepStrictEqual(byCat, { park: 1, water: 1, building: 1 });
});
