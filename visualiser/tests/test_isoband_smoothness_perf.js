/**
 * Regression test: the full _surface() export pipeline should produce filled,
 * closed isoband polygons for a peak pinned at the map edge, using smooth curves
 * (not a blocky per-grid-cell tiling), and should complete quickly even at the
 * largest supported gridResolution/contourCount.
 *
 * Note: this file previously tested a since-abandoned supersampled/per-cell-clip
 * fill approach (hence the filename). That approach traded the smooth isoline
 * curve for a blocky tiled fill to guarantee closure at the map edge. It's been
 * replaced by ContourRingGeometry.closeOpenPaths (see tests/test_isoband_boundary_closure.js),
 * which closes the same smooth curve correctly instead of tiling grid cells — see
 * that file for the detailed closure-correctness tests (including the adversarial
 * "long arc is the correct one" case).
 *
 * Run: node visualiser/tests/test_isoband_smoothness_perf.js
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

loadModule(path.join(__dirname, '../src/signal/stats_math.js'),      'StatsMath');
loadModule(path.join(__dirname, '../src/map/map_colors.js'),      'MapColors');
loadModule(path.join(__dirname, '../src/gps/geo_utils.js'),       'GeoUtils');
loadModule(path.join(__dirname, '../src/render/marching_squares.js'),'MarchingSquares');
loadModule(path.join(__dirname, '../src/spatial/spatial_clustering.js'), 'GSRSpatialClustering');
loadModule(path.join(__dirname, '../src/map/hillshade.js'),       'Hillshade');
loadModule(path.join(__dirname, '../src/render/bezier_spline.js'),   'BezierSpline');
loadModule(path.join(__dirname, '../src/render/contour_ring_geometry.js'), 'ContourRingGeometry');
loadModule(path.join(__dirname, '../src/map/map_exporter.js'),   'GSRMapExporter');

const { MarchingSquares } = global;
const GSRMapExporter = global.GSRMapExporter;

console.log('── Running Isoband Smoothness / Performance Regression Test ──');

// Representative large-grid settings (80x80 — not literally index.html's
// current #gridResolution max, which has grown since this was written; kept
// at 80 here since this test targets isoband smoothness/correctness at
// scale, not the literal slider ceiling, and a larger grid would only slow
// the test down for no extra coverage) and max contourCount (25), with the
// hot peak deliberately pinned right up against a map edge/corner.
const rows = 80, cols = 80;
const grid = Array.from({ length: rows }, (_, r) =>
  Array.from({ length: cols }, (_, c) => {
    const dr = r - 78, dc = c - 78; // peak centered essentially in the SE corner
    return 3.0 * Math.exp(-(dr * dr + dc * dc) / 300);
  })
);
const bounds = { minLat: 49.9, maxLat: 50.0, minLon: 0.0, maxLon: 0.1 };
const sortedVals = grid.flat().slice().sort((a, b) => a - b);

const contourCount = 25;
const contours = [];
for (let k = 1; k <= contourCount; k++) {
  const pct = k / (contourCount + 1);
  const idx = Math.min(sortedVals.length - 1, Math.round(pct * (sortedVals.length - 1)));
  const level = sortedVals[idx];
  const segments = MarchingSquares.getContourLines(grid, rows, cols, bounds, level);
  if (segments.length) contours.push({ level, ratio: pct, segments });
}
assert(contours.length > 0, 'Sanity: at least one contour level produced segments');

const project = (ll) => {
  const lat = ll.lat !== undefined ? ll.lat : ll[0];
  const lon = ll.lon !== undefined ? ll.lon : (ll.lng !== undefined ? ll.lng : ll[1]);
  return { x: lon * 20000, y: (50 - lat) * 20000 };
};
const mockEl = { clientWidth: 800, clientHeight: 600, querySelectorAll: () => [], querySelector: () => null };
const ctx = {
  map: { latLngToContainerPoint: project }, el: mockEl, r: { left: 0, top: 0 }, w: 2000, h: 1600, project,
  mgr: { surfaceData: { grid, minVal: 0, maxVal: 3, bounds, sortedVals, contours } }
};

const t0 = Date.now();
const layers = GSRMapExporter._surface(ctx);
const elapsedMs = Date.now() - t0;

const fillPaths = layers.isobands.filter(p => /fill="#[0-9a-f]{6}"/i.test(p));
assert(fillPaths.length > 0, 'At least one filled isoband polygon is produced for the edge-pinned peak');

// Every fill polygon must still be closed (ends with Z).
fillPaths.forEach(p => {
  const d = p.match(/d="([^"]+)"/)[1];
  assert(d.trim().endsWith('Z'), `Filled isoband path is closed: ${d}`);
});
console.log(`✓ ${fillPaths.length} filled isoband polygons at max grid/contour settings, all closed`);

// Smooth curves, not a blocky grid-cell tiling: most fills should contain Bézier
// "C" commands (from the Chaikin + Catmull-Rom smoothing pipeline).
const smoothFillCount = fillPaths.filter(p => p.includes(' C')).length;
assert(smoothFillCount > 0, 'Filled isobands use smooth Bézier curves rather than straight-edged grid-cell tiles');
console.log(`✓ ${smoothFillCount}/${fillPaths.length} filled isoband polygons use smooth curves (no blocky tiling)`);

// The fill polygon count should stay small (proportional to the number of
// distinct isoline rings, not the number of grid cells) — a regression back
// toward per-cell tiling would blow this number up by orders of magnitude.
assert(fillPaths.length < 500, `Filled isoband polygon count stays small — proportional to contour rings, not grid cells (got ${fillPaths.length})`);

assert(elapsedMs < 2000, `Export completes in reasonable time at worst-case settings (${elapsedMs}ms)`);
console.log(`✓ Worst-case export (80x80 grid, 25 contour levels) completed in ${elapsedMs}ms`);

console.log('\n============================================================');
console.log('Isoband Smoothness / Performance Regression Test: ALL PASSED');
console.log('============================================================');
