/**
 * Regression test: isobands that touch the edge of the grid/map extent must still
 * be filled (previously they came back as an open, unfilled stroke because the
 * marching-squares isoline never closes itself against the grid boundary).
 * Run: node visualiser/tests/test_edge_isoband_fix.js
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
loadModule(path.join(__dirname, '../hillshade.js'),       'Hillshade');
loadModule(path.join(__dirname, '../bezier_spline.js'),   'BezierSpline');
loadModule(path.join(__dirname, '../contour_ring_geometry.js'), 'ContourRingGeometry');
loadModule(path.join(__dirname, '../map_exporter.js'),   'GSRMapExporter');

const { MarchingSquares, GSRSpatialClustering, GeoUtils } = global;
const GSRMapExporter = global.GSRMapExporter;

console.log('── Running Edge-of-Map-Extent Isoband Regression Test ──');

const mockMap = {
  latLngToContainerPoint: (pt) => {
    const lat = pt.lat !== undefined ? pt.lat : (Array.isArray(pt) ? pt[0] : 0);
    const lon = pt.lon !== undefined ? pt.lon : (pt.lng !== undefined ? pt.lng : (Array.isArray(pt) ? pt[1] : 0));
    return { x: (lon - 0.0) * 1000, y: (50.0 - lat) * 1000 };
  }
};
const mockEl = { clientWidth: 800, clientHeight: 600, querySelectorAll: () => [], querySelector: () => null };
const project = (ll) => mockMap.latLngToContainerPoint(ll);

// A 5x5 grid where the "hot" region (>= level) is pinned entirely against the
// north-east corner/edge of the grid — i.e. exactly the case that used to produce
// an open (unfillable) isoline because the region is cut off by the grid boundary
// rather than fully enclosed within it.
const rows = 5, cols = 5;
const grid = [
  [0.1, 0.1, 0.2, 3.0, 3.0],
  [0.1, 0.1, 0.2, 3.0, 3.0],
  [0.1, 0.1, 0.2, 0.3, 0.3],
  [0.1, 0.1, 0.1, 0.2, 0.2],
  [0.1, 0.1, 0.1, 0.1, 0.1]
];
const bounds = { minLat: 49.9, maxLat: 50.0, minLon: 0.0, maxLon: 0.1 };
const level = 1.5;

const sortedVals = grid.flat().slice().sort((a, b) => a - b);
const segments = MarchingSquares.getContourLines(grid, rows, cols, bounds, level);
assert(segments.length > 0, 'Marching squares finds a crossing for the edge-pinned hot region');

const stitched = GSRSpatialClustering.stitchSegments(segments);
assert(stitched.length > 0, 'Segments stitch into at least one path');
const anyOpen = stitched.some(p => {
  const a = p[0], b = p[p.length - 1];
  return Math.hypot(a.lat - b.lat, a.lon - b.lon) > 1e-9;
});
assert(anyOpen, 'Sanity check: this edge-pinned region really does stitch into an OPEN path (the pre-fix failure mode)');
console.log('✓ Confirmed the underlying isoline for an edge-pinned region is open (not self-closing)');

const contours = [{ level, ratio: 0.8, segments }];
const ctx = {
  map: mockMap, el: mockEl, r: { left: 0, top: 0 }, w: 800, h: 600, project,
  mgr: { surfaceData: { grid, minVal: 0.1, maxVal: 3.0, bounds, sortedVals, contours } }
};

const layers = GSRMapExporter._surface(ctx);
const fillPaths = layers.isobands.filter(p => /fill="#[0-9a-f]{6}"/i.test(p) && !/fill="none"/i.test(p));
assert(fillPaths.length > 0, 'Vector_Surface_Isobands contains at least one FILLED polygon for the edge-pinned region');

fillPaths.forEach(p => {
  const dMatch = p.match(/d="([^"]+)"/);
  assert(dMatch, 'Filled isoband path has a d attribute');
  assert(dMatch[1].trim().endsWith('Z'), `Filled isoband path is a closed loop (d ends with Z): ${dMatch[1]}`);
});
console.log(`✓ ${fillPaths.length} filled, closed isoband polygon(s) generated for the region touching the grid edge`);

// The old, reverted-fix bug produced straight chord lines cutting across the shape
// when it tried to close paths itself. The new approach never draws a fill via a
// stitched isoline at all, so no such closing chord can appear in a *filled* path.
console.log('\n============================================================');
console.log('Edge-of-Map-Extent Isoband Regression Test: ALL PASSED');
console.log('============================================================');
