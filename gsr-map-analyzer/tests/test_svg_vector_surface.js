/**
 * Test for Vector Surface SVG Export (Mesh & Isobands)
 * Run: node gsr-map-analyzer/tests/test_svg_vector_surface.js
 */

const assert = require('assert');
const path   = require('path');

// Bootstrap dependencies
function loadModule(filePath, exportName) {
  const fs = require('fs');
  const code = fs.readFileSync(filePath, 'utf8');
  const fn = new Function('module', 'exports', 'require', '__dirname', 'window', 'global', code);
  const dummyModule = { exports: {} };
  global.window = global.window || global;
  fn(dummyModule, dummyModule.exports, require, path.dirname(filePath), global.window, global);
  if (exportName && global.window[exportName]) {
    global[exportName] = global.window[exportName];
  }
}

loadModule(path.join(__dirname, 'mock_constants.js'));
loadModule(path.join(__dirname, '../stats_math.js'),      'StatsMath');
loadModule(path.join(__dirname, '../map_colors.js'),      'MapColors');
loadModule(path.join(__dirname, '../geo_utils.js'),       'GeoUtils');
loadModule(path.join(__dirname, '../marching_squares.js'),'MarchingSquares');
loadModule(path.join(__dirname, '../spatial_clustering.js'), 'GSRSpatialClustering');
loadModule(path.join(__dirname, '../map_exporter.js'),   'GSRMapExporter');

const GSRMapExporter = global.GSRMapExporter;

console.log('── Running Vector Surface SVG Export Tests ──');

// 1. Mock Map and Context
const mockMap = {
  latLngToContainerPoint: (pt) => {
    const lat = pt.lat !== undefined ? pt.lat : (Array.isArray(pt) ? pt[0] : 0);
    const lon = pt.lon !== undefined ? pt.lon : (pt.lng !== undefined ? pt.lng : (Array.isArray(pt) ? pt[1] : 0));
    return { x: (lon - 0.0) * 1000, y: (50.0 - lat) * 1000 };
  }
};

const mockEl = {
  clientWidth: 800,
  clientHeight: 600,
  querySelectorAll: () => [],
  querySelector: () => null
};

// Construct synthetic surfaceData
const grid = [
  [1.0, 1.5, 2.0],
  [1.2, 2.5, 3.0],
  [0.8, 1.1, 1.8]
];

const bounds = { minLat: 49.9, maxLat: 50.0, minLon: 0.0, maxLon: 0.1 };
const sortedVals = [0.8, 1.0, 1.1, 1.2, 1.5, 1.8, 2.0, 2.5, 3.0];
const contours = [
  {
    level: 1.5,
    ratio: 0.5,
    segments: [
      [{ lat: 49.95, lon: 0.02 }, { lat: 49.95, lon: 0.05 }],
      [{ lat: 49.95, lon: 0.05 }, { lat: 49.95, lon: 0.08 }]
    ]
  }
];

const ctxWithSurface = {
  map: mockMap,
  el: mockEl,
  r: { left: 0, top: 0 },
  w: 800,
  h: 600,
  mgr: {
    surfaceData: { grid, minVal: 0.8, maxVal: 3.0, bounds, sortedVals, contours }
  }
};

// 2. Test _surface output
const surfaceLayers = GSRMapExporter._surface(ctxWithSurface);
assert(surfaceLayers && typeof surfaceLayers === 'object', '_surface returns layer object');
assert(Array.isArray(surfaceLayers.mesh), 'surfaceLayers.mesh is an array');
assert(surfaceLayers.mesh.length === 9, `mesh contains 9 cell polygons (got ${surfaceLayers.mesh.length})`);
assert(surfaceLayers.mesh[0].includes('fill="#'), 'mesh elements use standard Hex #RRGGBB colors for Illustrator compatibility');
assert(surfaceLayers.isobands[0].includes('fill="#') || surfaceLayers.isobands[0].includes('stroke="#'), 'isoband elements use standard Hex #RRGGBB colors for Illustrator compatibility');

console.log('✓ _surface correctly generates vector mesh polygons and vector isobands with standard Hex colors');

// Test smooth track stroke generation (_pathD Catmull-Rom spline)
const sampleTrackLatLngs = [
  { lat: 51.5, lng: -0.1 },
  { lat: 51.51, lng: -0.09 },
  { lat: 51.52, lng: -0.08 }
];
const GeoUtils = global.GeoUtils;
const smoothedPts = GeoUtils.chaikinSmooth(sampleTrackLatLngs, 2, false);
assert(!isNaN(smoothedPts[0].lon) && !isNaN(smoothedPts[0].lng), 'GeoUtils.chaikinSmooth supports Leaflet {lat, lng} objects without producing NaN');
const smoothPathD = GSRMapExporter._pathD(mockMap, sampleTrackLatLngs, false);
assert(smoothPathD.includes('C'), '_pathD generates smooth cubic Bézier C curve commands instead of jaggity L commands');
console.log('✓ _pathD generates smooth cubic Bézier spline strokes for track paths');

// Test boundary path closure (_closeBoundaryPath)
const openBoundaryPath = [
  { lat: 51.55, lon: -0.1 },
  { lat: 51.52, lon: -0.05 }
];
const testBounds = { minLat: 51.5, maxLat: 51.6, minLon: -0.2, maxLon: 0.0 };
const closedBoundaryPath = GSRMapExporter._closeBoundaryPath(openBoundaryPath, testBounds);
assert.strictEqual(closedBoundaryPath[0].lat, closedBoundaryPath[closedBoundaryPath.length - 1].lat, 'Boundary path is closed with matching start/end lat');
assert.strictEqual(closedBoundaryPath[0].lon, closedBoundaryPath[closedBoundaryPath.length - 1].lon, 'Boundary path is closed with matching start/end lon');
console.log('✓ _closeBoundaryPath successfully closes open edge paths into 100% complete filled loops');

// 3. Test _render layer output
const fullLayers = {
  tiles: [],
  surface: surfaceLayers,
  osm: [],
  tracks: [],
  contours: [],
  clusters: [],
  dotsAndLabels: { dots: [], labels: [] },
  hotspots: { dots: [] }
};

const svgOutput = GSRMapExporter._render(ctxWithSurface, fullLayers);

assert(svgOutput.includes('id="Vector_Surface_Mesh"'), 'SVG contains Vector_Surface_Mesh layer group');
assert(svgOutput.includes('data-name="Vector Surface Mesh"'), 'SVG contains Vector Surface Mesh layer name');
assert(svgOutput.includes('id="Vector_Surface_Isobands"'), 'SVG contains Vector_Surface_Isobands layer group');
assert(svgOutput.includes('data-name="Vector Surface Isobands"'), 'SVG contains Vector Surface Isobands layer name');
assert(svgOutput.includes('id="Raster_Surface_Fallback"'), 'SVG contains Raster_Surface_Fallback layer group');

// Verify that the vector layers do not contain raster images
const meshGroupIdx = svgOutput.indexOf('id="Vector_Surface_Mesh"');
const isobandsGroupIdx = svgOutput.indexOf('id="Vector_Surface_Isobands"');
const rasterGroupIdx = svgOutput.indexOf('id="Raster_Surface_Fallback"');

const meshSection = svgOutput.substring(meshGroupIdx, isobandsGroupIdx);
assert(!meshSection.includes('<image'), 'Vector_Surface_Mesh Section contains NO raster image elements');

console.log('✓ SVG output successfully includes separate Vector_Surface_Mesh and Vector_Surface_Isobands layers');

// 4. Test Fallback when surfaceData is absent
const ctxNoSurface = {
  map: mockMap,
  el: mockEl,
  r: { left: 0, top: 0 },
  w: 800,
  h: 600,
  mgr: {
    surfaceOverlay: {
      getBounds: () => ({
        getNorthWest: () => [50.0, 0.0],
        getSouthEast: () => [49.9, 0.1]
      }),
      _url: 'data:image/png;base64,mockpng'
    }
  }
};

const fallbackLayers = GSRMapExporter._surface(ctxNoSurface);
assert(fallbackLayers.mesh.length === 0, 'No vector mesh when surfaceData is missing');
assert(fallbackLayers.isobands.length === 0, 'No vector isobands when surfaceData is missing');
assert(fallbackLayers.raster.length === 1, 'Raster fallback contains image overlay when surfaceOverlay is present');
assert(fallbackLayers.raster[0].includes('data:image/png;base64,mockpng'), 'Raster fallback URL matches overlay');

console.log('✓ Fallback to raster image works cleanly when surfaceData is absent');

console.log('\n============================================================');
console.log('Vector Surface SVG Export Tests: ALL PASSED');
console.log('============================================================');
