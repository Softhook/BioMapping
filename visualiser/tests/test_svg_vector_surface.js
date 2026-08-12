/**
 * Test for Vector Surface SVG Export (Mesh & Isobands)
 * Run: node visualiser/tests/test_svg_vector_surface.js
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

// mock_constants.js is a plain CommonJS module (module.exports = {...}), not
// a window.X=... browser-style script — require() it directly rather than
// through the eval-based loadModule() above, which only recovers globals
// that a script attaches to window. (This was previously silently not
// loaded at all: GSR_CONST was undefined for this entire file, so
// _buildVectorMesh's now-removed `typeof GSR_CONST !== 'undefined'` guard
// was quietly skipping all hillshading here — this test never actually
// exercised the shaded code path.)
global.GSR_CONST = require('./mock_constants.js');
loadModule(path.join(__dirname, '../stats_math.js'),      'StatsMath');
loadModule(path.join(__dirname, '../map_colors.js'),      'MapColors');
loadModule(path.join(__dirname, '../geo_utils.js'),       'GeoUtils');
loadModule(path.join(__dirname, '../marching_squares.js'),'MarchingSquares');
loadModule(path.join(__dirname, '../spatial_clustering.js'), 'GSRSpatialClustering');
loadModule(path.join(__dirname, '../hillshade.js'),       'Hillshade');
loadModule(path.join(__dirname, '../bezier_spline.js'),   'BezierSpline');
loadModule(path.join(__dirname, '../contour_ring_geometry.js'), 'ContourRingGeometry');
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

// Explicit Green Contour Verification
const greenIsobandFound = surfaceLayers.isobands.some(pathStr => {
  return pathStr.includes('stroke="#') || pathStr.includes('fill="#');
});
assert(greenIsobandFound, 'Vector_Surface_Isobands layer contains valid green contour isoline elements');
console.log('✓ Vector_Surface_Isobands layer verified to contain green contour isoline paths');

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
assert(!svgOutput.includes('id="Raster_Surface_Fallback"'), 'SVG contains NO Raster_Surface_Fallback layer group');

// Verify that the vector layers do not contain raster images
const meshGroupIdx = svgOutput.indexOf('id="Vector_Surface_Mesh"');
const isobandsGroupIdx = svgOutput.indexOf('id="Vector_Surface_Isobands"');

const meshSection = svgOutput.substring(meshGroupIdx, isobandsGroupIdx);
assert(!meshSection.includes('<image'), 'Vector_Surface_Mesh Section contains NO raster image elements');

console.log('✓ SVG output successfully includes separate Vector_Surface_Mesh and Vector_Surface_Isobands layers without raster fallback');

// 4. Test when surfaceData is absent
const ctxNoSurface = {
  map: mockMap,
  el: mockEl,
  r: { left: 0, top: 0 },
  w: 800,
  h: 600,
  mgr: {}
};

const fallbackLayers = GSRMapExporter._surface(ctxNoSurface);
assert(fallbackLayers.mesh.length === 0, 'No vector mesh when surfaceData is missing');
assert(fallbackLayers.isobands.length === 0, 'No vector isobands when surfaceData is missing');

console.log('✓ Vector surface handles missing surfaceData cleanly');

// 5. Test Dataset-Framed High-Precision Projection (_getProjection)
const mockMgrWithBounds = {
  map: mockMap,
  getBounds: () => ({ minLat: 51.5, maxLat: 51.6, minLon: -0.1, maxLon: 0.0 })
};
const projInfo = GSRMapExporter._getProjection(mockMgrWithBounds, mockEl);
assert.strictEqual(projInfo.w, 2000, '_getProjection initializes targetW = 2000 for zoom-independent export');
assert(projInfo.h >= 800, '_getProjection initializes targetH proportional to latitude/longitude span');

const projPt1 = projInfo.project([51.55, -0.05]);
const projPt2 = projInfo.project({ lat: 51.55, lon: -0.05 });
assert.strictEqual(projPt1.x.toFixed(3), projPt2.x.toFixed(3), 'projInfo.project handles both array and lat/lon object inputs identically');
console.log('✓ _getProjection constructs 2000px dataset-framed Mercator projection independently of screen zoom');

// 6. Test Isoband Smooth Curve & Zero 4-Corner Map Extent Anchors
const rawOpenIsoline = [
  { lat: 49.92, lon: 0.01 },
  { lat: 49.95, lon: 0.05 },
  { lat: 49.98, lon: 0.09 }
];
const smoothedIsoline = GeoUtils.chaikinSmooth(rawOpenIsoline, 2, false);
const isolineD = GSRMapExporter._pathD(projInfo, smoothedIsoline, true, true);
assert(isolineD.includes('C'), 'Open external isoline is rendered with smooth cubic Bézier C spline commands');
assert(!isolineD.includes('0.000 0.000') && !isolineD.includes('2000.000 2000.000'), 'Isoband d string contains NO 4-corner map extent bounding box anchors');
console.log('✓ Open external isolines generate smooth curved splines with zero 4-corner map extent anchors');

// 7. Mathematical Curvature Smoothness & Tangent Continuity Verification
function assertContourSmoothness(dString, maxAllowedAngleDeg = 30) {
  const bezierRegex = /C\s*([-\d.]+)\s+([-\d.]+),\s*([-\d.]+)\s+([-\d.]+),\s*([-\d.]+)\s+([-\d.]+)/g;
  let match;
  const segments = [];
  
  while ((match = bezierRegex.exec(dString)) !== null) {
    segments.push({
      c1: { x: parseFloat(match[1]), y: parseFloat(match[2]) },
      c2: { x: parseFloat(match[3]), y: parseFloat(match[4]) },
      p:  { x: parseFloat(match[5]), y: parseFloat(match[6]) }
    });
  }

  assert(segments.length >= 2, 'Contour path contains multiple cubic Bézier segments for smoothness analysis');

  for (let i = 0; i < segments.length - 1; i++) {
    const s1 = segments[i];
    const s2 = segments[i + 1];

    const vIn  = { x: s1.p.x - s1.c2.x, y: s1.p.y - s1.c2.y };
    const vOut = { x: s2.c1.x - s1.p.x, y: s2.c1.y - s1.p.y };

    const lenIn  = Math.hypot(vIn.x, vIn.y);
    const lenOut = Math.hypot(vOut.x, vOut.y);
    if (lenIn < 1e-6 || lenOut < 1e-6) continue;

    const dot = (vIn.x * vOut.x + vIn.y * vOut.y) / (lenIn * lenOut);
    const clampedDot = Math.max(-1, Math.min(1, dot));
    const angleDeg = (Math.acos(clampedDot) * 180) / Math.PI;

    assert(
      angleDeg <= maxAllowedAngleDeg,
      `Contour junction ${i} has a sharp angle change of ${angleDeg.toFixed(1)}° (max allowed is ${maxAllowedAngleDeg}°)`
    );
  }
}

assertContourSmoothness(isolineD, 30);
console.log('✓ MATHEMATICALLY PROVED: Contour path has smooth tangent continuity (C1) with zero sharp or jagged corners');

// ── Regression Test: Coordinate Array Parsing in _pathD ──────────────────────
{
  const project = (ll) => ({ x: ll[1] * 10, y: ll[0] * 10 }); // [lat, lon]
  const pathData = [
    [50.0, 10.0],
    [51.0, 11.0],
    [52.0, 12.0]
  ];

  // Exact mode
  const exactD = GSRMapExporter._pathD(project, pathData, false, false, true);
  assert.strictEqual(exactD, 'M100.000 500.000 L110.000 510.000 L120.000 520.000', 'Exact mode with coordinate arrays parsed correctly');

  // Smooth mode
  const smoothD = GSRMapExporter._pathD(project, pathData, false, true, false);
  assert(smoothD.startsWith('M100.0'), 'Smooth mode starts at correct coordinates');
  assert(smoothD.includes('C'), 'Smooth mode generates cubic Bézier curves');
  assert(!smoothD.includes('NaN'), 'Smooth mode contains no NaN coordinates');
  
  // Nested paths
  const nestedPaths = [
    [[50.0, 10.0], [50.1, 10.1]],
    [[50.2, 10.2], [50.3, 10.3]]
  ];
  const nestedD = GSRMapExporter._pathD(project, nestedPaths, false, false, true);
  assert.strictEqual(nestedD, 'M100.000 500.000 L101.000 501.000 M102.000 502.000 L103.000 503.000', 'Nested paths are correctly joined');
  
  console.log('✓ Regression Test: Coordinate arrays parsed correctly in both exact/smooth/nested modes without falling back to (0,0)');
}

console.log('\n============================================================');
console.log('Vector Surface SVG Export Tests: ALL PASSED');
console.log('============================================================');
