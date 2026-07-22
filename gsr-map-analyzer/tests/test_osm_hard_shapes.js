/**
 * Regression test: OSM shapes (buildings/parks/water) must export as hard, exact
 * vector geometry — every original vertex preserved, straight edges, sharp
 * (miter) corners — not run through the GPS-track smoothing/culling pipeline.
 * Run: node gsr-map-analyzer/tests/test_osm_hard_shapes.js
 */
const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const vm     = require('vm');

global.window = global;
global.GSR_CONST = require('./mock_constants.js');

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

loadModule(path.join(__dirname, '../stats_math.js'),      'StatsMath');
loadModule(path.join(__dirname, '../map_colors.js'),      'MapColors');
loadModule(path.join(__dirname, '../geo_utils.js'),       'GeoUtils');
loadModule(path.join(__dirname, '../marching_squares.js'),'MarchingSquares');
loadModule(path.join(__dirname, '../spatial_clustering.js'), 'GSRSpatialClustering');
loadModule(path.join(__dirname, '../map_exporter.js'),   'GSRMapExporter');

const GSRMapExporter = global.GSRMapExporter;

console.log('── Running OSM Hard-Shape Export Regression Test ──');

// Minimal fake Leaflet: just enough for _pathEl's `instanceof window.L.Polygon` check
// and getLatLngs()/options, mirroring what map.js's drawOsmShapes() actually creates.
class FakePolygon {
  constructor(latlngs, options) { this._latlngs = latlngs; this.options = options; }
  getLatLngs() { return this._latlngs; }
}
global.L = { Polygon: FakePolygon };

const project = (ll) => {
  const lat = ll.lat !== undefined ? ll.lat : ll[0];
  const lon = ll.lon !== undefined ? ll.lon : (ll.lng !== undefined ? ll.lng : ll[1]);
  return { x: lon * 100000, y: lat * 100000 };
};
const ctx = { project };

// A rectangular building footprint. Two of its corners are deliberately very close
// together in *projected* screen space (< 1.5px apart) to reproduce the exact case
// the old micro-jitter culling would have silently deleted as "noise".
const building = new FakePolygon(
  [
    { lat: 51.50000, lon: -0.10000 },
    { lat: 51.50000, lon: -0.09980 },
    { lat: 51.50001, lon: -0.09980 }, // ~1.1px from the previous point at this projection scale
    { lat: 51.50001, lon: -0.10000 }
  ],
  { color: '#4a4e69', fillColor: '#9a8c98', fillOpacity: 0.1, weight: 1 }
);

const svgExact = GSRMapExporter._pathEl(ctx, building, { exact: true });
assert(svgExact, '_pathEl returns an SVG path for the OSM building polygon');
assert(!svgExact.includes(' C'), 'Exact OSM export uses straight line segments only — no Bézier "C" curve commands');
assert(svgExact.includes('stroke-linejoin="miter"'), 'Exact OSM export uses sharp miter joins, not rounded corners');
assert(svgExact.includes('stroke-linecap="square"'), 'Exact OSM export uses square line caps, not rounded caps');

// Count the number of "L" line-to commands — with exact:true, all 4 vertices should
// survive (M + 3 L + Z), even though one pair of consecutive points is sub-1.5px apart.
const lCount = (svgExact.match(/L/g) || []).length;
assert.strictEqual(lCount, 3, `All 4 building vertices are preserved in the exact path (expected 3 "L" commands, got ${lCount})`);
console.log('✓ Exact OSM export preserves every vertex with straight, sharp-cornered geometry');

// Sanity check against the OLD (non-exact) behavior applied to the same shape: this
// is what tracks/isolines still get, and it's expected to smooth + cull.
const svgSmoothed = GSRMapExporter._pathEl(ctx, building);
const lCountSmoothed = (svgSmoothed.match(/L/g) || []).length;
assert(
  svgSmoothed.includes(' C') || lCountSmoothed < lCount,
  'Sanity check: non-exact path either curves (Bézier) or culls the close-together vertex — confirms exact:true is the thing making the difference'
);
console.log('✓ Confirmed default (non-exact) rendering is the one that smooths/culls — exact:true is the fix');

console.log('\n============================================================');
console.log('OSM Hard-Shape Export Regression Test: ALL PASSED');
console.log('============================================================');
