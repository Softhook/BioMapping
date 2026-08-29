/**
 * Regression coverage for the RF fan-cast spatial grid index (architecture
 * refactor plan Phase 6 step 1 / perf-routes doc §2.1):
 * `_precalculateSpatialFans()` (rf_fluid_renderer.js) used to linearly
 * re-scan every building segment for every GPS node. It now buckets
 * `buildingSegmentsGeo` into a uniform lat/lon grid once per call
 * (`_buildSegmentGrid`) and looks up only the cells overlapping each node's
 * bounding box (`_queryNearbySegments`), then applies the exact same bbox
 * filter to that smaller candidate set. The fix sketch's own verification
 * note calls for proving identical output plus a work-reduction check —
 * both covered here.
 *
 * Run: node --test tests/test_rf_fluid_spatial_index.js
 */

const assert = require('assert');
const test = require('node:test');

global.L = {
  DomUtil: {
    create: () => ({ style: {}, getContext: () => fakeCanvasContext() }),
    setPosition: () => {},
    setTransform: () => {},
  },
};
global.window = { devicePixelRatio: 1 };

function fakeCanvasContext() {
  return new Proxy({}, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === 'canvas') return { width: 400, height: 300 };
      return (...args) => {
        if (String(prop).startsWith('create')) return new Proxy({}, { get: () => () => {} });
        return undefined;
      };
    },
  });
}

const vm = require('vm');
const spatialGridSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'map', 'spatial_grid.js'), 'utf8');
vm.runInThisContext(spatialGridSrc.replace('class SpatialGrid', 'global.SpatialGrid = class SpatialGrid'), { filename: 'spatial_grid.js' });

const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'render', 'rf_fluid_renderer.js'), 'utf8');
vm.runInThisContext(src.replace('class RFFluidRenderer', 'global.RFFluidRenderer = class RFFluidRenderer'), { filename: 'rf_fluid_renderer.js' });
const RFFluidRenderer = global.RFFluidRenderer;

function makeFakeMap() {
  const panes = {};
  return {
    getPane: (name) => panes[name] || null,
    createPane: (name) => { panes[name] = { style: {}, appendChild: () => {} }; return panes[name]; },
    on: () => {},
    getBounds: () => ({ pad: () => ({ contains: () => true, getNorthWest: () => ({ lat: 52, lon: -1 }), getSouthEast: () => ({ lat: 51, lon: 0 }) }) }),
    latLngToLayerPoint: () => ({ x: 100, y: 100 }),
    getZoomScale: () => 1,
    getZoom: () => 15,
    getSize: () => ({ x: 800, y: 600 }),
    _latLngToNewLayerPoint: () => ({ x: 0, y: 0 }),
  };
}

// A rectangular building "way" centered near (lat, lon), ~4m across.
function buildingNear(lat, lon) {
  const d = 0.00002;
  return {
    type: 'way',
    tags: { building: 'yes' },
    coordinates: [
      { lat: lat - d, lon: lon - d },
      { lat: lat + d, lon: lon - d },
      { lat: lat + d, lon: lon + d },
      { lat: lat - d, lon: lon + d },
    ],
  };
}

// Nodes spread far apart (well beyond radiusMeters of each other) so a
// spatial index has something real to exclude; buildings clustered near
// only two of the nodes so most nodes have zero nearby candidates.
const drawPoints = [
  { lat: 51.5000, lon: -0.1000, rssi_815: -70, rssi_868: -75, rssi_915: -60 },
  { lat: 51.5100, lon: -0.0900, rssi_815: -71, rssi_868: -76, rssi_915: -61 },
  { lat: 51.5200, lon: -0.0800, rssi_815: -72, rssi_868: -77, rssi_915: -62 },
  { lat: 51.5300, lon: -0.0700, rssi_815: -73, rssi_868: -78, rssi_915: -63 },
  { lat: 51.5400, lon: -0.0600, rssi_815: -74, rssi_868: -79, rssi_915: -64 },
  { lat: 51.5500, lon: -0.0500, rssi_815: -75, rssi_868: -80, rssi_915: -65 },
];

const ways = [];
// Cluster of buildings right around the first node.
for (let i = 0; i < 8; i++) {
  ways.push(buildingNear(51.5000 + i * 0.00003, -0.1000 + i * 0.00002));
}
// Cluster of buildings right around the last node.
for (let i = 0; i < 8; i++) {
  ways.push(buildingNear(51.5500 + i * 0.00003, -0.0500 + i * 0.00002));
}
const osmGeoms = { ways };

test('spatial grid index produces identical fanGeo output to a full linear scan', () => {
  const gridRenderer = new RFFluidRenderer(makeFakeMap(), { visible: true });
  gridRenderer.setData(drawPoints, osmGeoms);
  const gridNodes = JSON.parse(JSON.stringify(gridRenderer.cachedNodes));

  assert.ok(gridNodes.length > 0, 'precondition: nodes were actually produced');
  assert.ok(gridNodes.every(n => n.fanGeo.length === 24), 'precondition: every node has a full ray fan');

  const bruteRenderer = new RFFluidRenderer(makeFakeMap(), { visible: true });
  // Force the pre-index code path: _buildSegmentGrid returning null makes
  // the per-node lookup fall back to `buildingSegmentsGeo` directly (see
  // `_precalculateSpatialFans`'s `gridCandidates = segmentGrid ? ... :
  // buildingSegmentsGeo` fallback) — the same exact bbox filter runs either
  // way, so this isolates "did indexing change the result" to exactly the
  // one seam that differs.
  bruteRenderer._buildSegmentGrid = () => null;
  bruteRenderer.setData(drawPoints, osmGeoms);
  const bruteNodes = JSON.parse(JSON.stringify(bruteRenderer.cachedNodes));

  assert.deepStrictEqual(gridNodes, bruteNodes,
    'grid-indexed fan-casting must produce byte-identical output to the brute-force scan');
});

test('spatial grid index actually reduces candidate segments considered, not just a no-op passthrough', () => {
  const renderer = new RFFluidRenderer(makeFakeMap(), { visible: true });
  const totalSegments = ways.length * 4; // each rectangular way contributes 4 segments

  let totalCandidatesSeen = 0;
  let queries = 0;
  const originalQuery = renderer._queryNearbySegments.bind(renderer);
  renderer._queryNearbySegments = (...args) => {
    const result = originalQuery(...args);
    totalCandidatesSeen += result.length;
    queries++;
    return result;
  };

  renderer.setData(drawPoints, osmGeoms);

  assert.ok(queries > 0, 'precondition: the grid path ran at least once');
  const bruteForceUpperBound = queries * totalSegments;
  assert.ok(totalCandidatesSeen < bruteForceUpperBound,
    `grid should hand back fewer candidates (${totalCandidatesSeen}) than a full scan would ` +
    `(${bruteForceUpperBound}) given most nodes have no buildings anywhere near them`);
});

test('_buildSegmentGrid + _queryNearbySegments: candidate set (after the exact bbox filter) matches a brute-force scan for arbitrary query boxes', () => {
  const renderer = new RFFluidRenderer(makeFakeMap(), { visible: true });

  // Scatter segments across a wider area than any single query box, so some
  // segments are correctly excluded by cell range, not just all matching.
  const segments = [];
  for (let i = 0; i < 40; i++) {
    const lat = 51.0 + (i % 10) * 0.01;
    const lon = -1.0 + Math.floor(i / 10) * 0.01;
    segments.push({ p1: { lat, lon }, p2: { lat: lat + 0.002, lon: lon + 0.002 } });
  }

  const cellSizeLat = 0.01;
  const cellSizeLon = 0.01;
  const grid = renderer._buildSegmentGrid(segments, cellSizeLat, cellSizeLon);

  function bruteForceFilter(bbox) {
    return segments.filter(seg =>
      Math.min(seg.p1.lat, seg.p2.lat) <= bbox.maxLat &&
      Math.max(seg.p1.lat, seg.p2.lat) >= bbox.minLat &&
      Math.min(seg.p1.lon, seg.p2.lon) <= bbox.maxLon &&
      Math.max(seg.p1.lon, seg.p2.lon) >= bbox.minLon
    );
  }

  function gridFilter(bbox, queryId) {
    const candidates = renderer._queryNearbySegments(grid, bbox, queryId);
    return candidates.filter(seg =>
      Math.min(seg.p1.lat, seg.p2.lat) <= bbox.maxLat &&
      Math.max(seg.p1.lat, seg.p2.lat) >= bbox.minLat &&
      Math.min(seg.p1.lon, seg.p2.lon) <= bbox.maxLon &&
      Math.max(seg.p1.lon, seg.p2.lon) >= bbox.minLon
    );
  }

  const queryBoxes = [
    { minLat: 51.0, maxLat: 51.02, minLon: -1.0, maxLon: -0.98 },   // corner, small
    { minLat: 51.04, maxLat: 51.06, minLon: -0.97, maxLon: -0.95 }, // middle strip
    { minLat: 50.5, maxLat: 51.5, minLon: -1.5, maxLon: -0.5 },     // covers everything
    { minLat: 60.0, maxLat: 60.1, minLon: 10.0, maxLon: 10.1 },     // covers nothing
  ];

  queryBoxes.forEach((bbox, idx) => {
    const brute = bruteForceFilter(bbox).slice().sort();
    const indexed = gridFilter(bbox, idx + 1).slice().sort();
    assert.deepStrictEqual(
      new Set(indexed), new Set(brute),
      `query box ${idx}: grid-filtered segment set must match brute-force scan`
    );
  });
});
