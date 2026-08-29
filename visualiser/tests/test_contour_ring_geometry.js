/**
 * Unit tests for contour_ring_geometry.js (ContourRingGeometry) — the pure
 * ring/boundary geometry extracted out of map_exporter.js: toLoop,
 * buildRectangleLoop, traceMaskBoundary, smoothLoopPoints,
 * recomputeSmoothNormals, tangentExtrapolate. (buildBoundaryLoops,
 * closeOpenPaths and findInteriorHoles/buildIsobandRings are exercised by
 * test_isoband_boundary_closure.js, test_masked_grid_isobands.js,
 * test_isoband_smoothness_perf.js, test_edge_isoband_fix.js, and
 * test_svg_vector_surface.js.)
 *
 * Run: node --test tests/test_contour_ring_geometry.js
 */

const assert = require('assert');
const test = require('node:test');

global.GeoUtils = require('../src/gps/geo_utils.js').GeoUtils;
const { ContourRingGeometry } = require('../src/render/contour_ring_geometry.js');

// ── toLoop ───────────────────────────────────────────────────────────────
test('toLoop: empty input returns a zeroed loop shape without throwing', () => {
  assert.deepStrictEqual(ContourRingGeometry.toLoop([]), { points: [], length: 0, diag: 0 });
  assert.deepStrictEqual(ContourRingGeometry.toLoop(null), { points: [], length: 0, diag: 0 });
});

test('toLoop: assigns monotonically increasing arc-length `t` starting at 0', () => {
  const loop = ContourRingGeometry.toLoop([{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }, { lat: 1, lon: 1 }]);
  assert.strictEqual(loop.points[0].t, 0);
  assert.ok(loop.points[1].t > loop.points[0].t);
  assert.ok(loop.points[2].t > loop.points[1].t);
});

test('toLoop: computes a unit-square bounding diagonal of sqrt(2)', () => {
  const loop = ContourRingGeometry.toLoop([{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }, { lat: 1, lon: 1 }, { lat: 1, lon: 0 }]);
  assert.ok(Math.abs(loop.diag - Math.sqrt(2)) < 1e-9);
});

test('toLoop: total length includes the implicit closing segment back to the first point', () => {
  const loop = ContourRingGeometry.toLoop([{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }]);
  // open segment (0,0)->(0,1) = 1, closing segment (0,1)->(0,0) = 1, total = 2
  assert.ok(Math.abs(loop.length - 2) < 1e-9);
});

// ── buildRectangleLoop ──────────────────────────────────────────────────
test('buildRectangleLoop: traces a closed loop of 2*(rows+cols)-4 perimeter cells for a uniform grid', () => {
  const rows = 4, cols = 5;
  const grid = Array.from({ length: rows }, () => Array(cols).fill(1));
  const bounds = { minLat: 0, maxLat: 1, minLon: 0, maxLon: 1 };
  const loop = ContourRingGeometry.buildRectangleLoop(grid, rows, cols, bounds);
  const expectedPerimeterCells = 2 * (rows + cols) - 4;
  assert.strictEqual(loop.points.length, expectedPerimeterCells);
});

test('buildRectangleLoop: every point carries the grid value from its perimeter cell and an outward-facing normal', () => {
  const rows = 3, cols = 3;
  const grid = [[1, 2, 3], [4, 5, 6], [7, 8, 9]];
  const bounds = { minLat: 0, maxLat: 1, minLon: 0, maxLon: 1 };
  const loop = ContourRingGeometry.buildRectangleLoop(grid, rows, cols, bounds);
  for (const p of loop.points) {
    assert.ok([1, 2, 3, 4, 6, 7, 8, 9].includes(p.val), `perimeter point should carry a perimeter grid value, got ${p.val}`);
    const mag = Math.hypot(p.normal.lat, p.normal.lon);
    assert.ok(Math.abs(mag - 1) < 1e-9, 'normal should be a unit vector');
  }
});

// ── tangentExtrapolate ───────────────────────────────────────────────────
test('tangentExtrapolate: with both ends enabled, prepends 2 points and appends 2 points', () => {
  const pts = [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }, { lat: 0, lon: 2 }];
  const result = ContourRingGeometry.tangentExtrapolate(pts, 1.0);
  assert.strictEqual(result.length, pts.length + 4);
});

test('tangentExtrapolate: extrapStart=false / extrapEnd=false independently skip that end', () => {
  const pts = [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }, { lat: 0, lon: 2 }];
  assert.strictEqual(ContourRingGeometry.tangentExtrapolate(pts, 1.0, false, true).length, pts.length + 2);
  assert.strictEqual(ContourRingGeometry.tangentExtrapolate(pts, 1.0, true, false).length, pts.length + 2);
  assert.strictEqual(ContourRingGeometry.tangentExtrapolate(pts, 1.0, false, false).length, pts.length);
});

test('tangentExtrapolate: fewer than 2 points returns the input unchanged (or [] for falsy input)', () => {
  assert.deepStrictEqual(ContourRingGeometry.tangentExtrapolate([{ lat: 0, lon: 0 }], 1.0), [{ lat: 0, lon: 0 }]);
  assert.deepStrictEqual(ContourRingGeometry.tangentExtrapolate(null, 1.0), []);
});

test('tangentExtrapolate: extrapolated tips extend further for a larger `diag` scale factor', () => {
  const pts = [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }];
  const small = ContourRingGeometry.tangentExtrapolate(pts, 1.0);
  const large = ContourRingGeometry.tangentExtrapolate(pts, 10.0);
  const distFromStart = (p) => Math.hypot(p.lat - pts[0].lat, p.lon - pts[0].lon);
  assert.ok(distFromStart(large[0]) > distFromStart(small[0]));
});

// ── traceMaskBoundary ────────────────────────────────────────────────────
test('traceMaskBoundary: an all-valid grid (no null cells) produces no boundary segments', () => {
  const rows = 3, cols = 3;
  const grid = [[1, 1, 1], [1, 1, 1], [1, 1, 1]];
  const bounds = { minLat: 0, maxLat: 1, minLon: 0, maxLon: 1 };
  assert.strictEqual(ContourRingGeometry.traceMaskBoundary(grid, rows, cols, bounds).length, 0);
});

test('traceMaskBoundary: an all-null grid produces no boundary segments', () => {
  const rows = 3, cols = 3;
  const grid = [[null, null, null], [null, null, null], [null, null, null]];
  const bounds = { minLat: 0, maxLat: 1, minLon: 0, maxLon: 1 };
  assert.strictEqual(ContourRingGeometry.traceMaskBoundary(grid, rows, cols, bounds).length, 0);
});

test('traceMaskBoundary: a single null cell surrounded by valid cells produces boundary segments with well-formed points', () => {
  const rows = 3, cols = 3;
  const grid = [[1, 1, 1], [1, null, 1], [1, 1, 1]];
  const bounds = { minLat: 0, maxLat: 1, minLon: 0, maxLon: 1 };
  const segs = ContourRingGeometry.traceMaskBoundary(grid, rows, cols, bounds);
  assert.ok(segs.length > 0);
  for (const [p1, p2] of segs) {
    for (const p of [p1, p2]) {
      assert.ok(Number.isFinite(p.lat) && Number.isFinite(p.lon) && Number.isFinite(p.val));
      const mag = Math.hypot(p.normal.lat, p.normal.lon);
      assert.ok(Math.abs(mag - 1) < 1e-6);
    }
  }
});

test('traceMaskBoundary: NaN cells are treated the same as null (masked)', () => {
  const rows = 2, cols = 2;
  const gridNull = [[1, null], [1, 1]];
  const gridNaN  = [[1, NaN], [1, 1]];
  const bounds = { minLat: 0, maxLat: 1, minLon: 0, maxLon: 1 };
  assert.strictEqual(
    ContourRingGeometry.traceMaskBoundary(gridNull, rows, cols, bounds).length,
    ContourRingGeometry.traceMaskBoundary(gridNaN, rows, cols, bounds).length
  );
});

// ── smoothLoopPoints ─────────────────────────────────────────────────────
test('smoothLoopPoints: doubles point count per iteration (Chaikin corner-cutting)', () => {
  const points = [
    { lat: 0, lon: 0, val: 1, normal: { lat: 0, lon: -1 } },
    { lat: 0, lon: 1, val: 2, normal: { lat: 1, lon: 0 } },
    { lat: 1, lon: 1, val: 3, normal: { lat: 0, lon: 1 } },
  ];
  const once = ContourRingGeometry.smoothLoopPoints(points, 1);
  assert.strictEqual(once.length, points.length * 2);
  const twice = ContourRingGeometry.smoothLoopPoints(points, 2);
  assert.strictEqual(twice.length, points.length * 4);
});

test('smoothLoopPoints: fewer than 3 points is returned unchanged', () => {
  const points = [{ lat: 0, lon: 0, val: 1, normal: { lat: 0, lon: 1 } }];
  assert.deepStrictEqual(ContourRingGeometry.smoothLoopPoints(points), points);
  assert.deepStrictEqual(ContourRingGeometry.smoothLoopPoints(null), [], 'null input falls back to [] (points || []), not null');
});

test('smoothLoopPoints: every output point keeps a unit-length normal', () => {
  const points = [
    { lat: 0, lon: 0, val: 1, normal: { lat: 0.6, lon: 0.8 } },
    { lat: 0, lon: 1, val: 5, normal: { lat: 1, lon: 0 } },
    { lat: 1, lon: 1, val: 9, normal: { lat: 0, lon: -1 } },
    { lat: 1, lon: 0, val: 2, normal: { lat: -1, lon: 0 } },
  ];
  const smoothed = ContourRingGeometry.smoothLoopPoints(points, 1);
  for (const p of smoothed) {
    const mag = Math.hypot(p.normal.lat, p.normal.lon);
    assert.ok(Math.abs(mag - 1) < 1e-9);
  }
});

// ── recomputeSmoothNormals ───────────────────────────────────────────────
test('recomputeSmoothNormals: fewer than 3 points is returned unchanged', () => {
  const points = [{ lat: 0, lon: 0, normal: { lat: 1, lon: 0 } }, { lat: 1, lon: 1, normal: { lat: 0, lon: 1 } }];
  assert.deepStrictEqual(ContourRingGeometry.recomputeSmoothNormals(points), points);
});

test('recomputeSmoothNormals: every point gets a unit-length normal perpendicular to its local tangent', () => {
  const points = [
    { lat: 0, lon: 0, normal: { lat: 0, lon: -1 } },
    { lat: 0, lon: 1, normal: { lat: 0, lon: -1 } },
    { lat: 1, lon: 1, normal: { lat: 1, lon: 0 } },
    { lat: 1, lon: 0, normal: { lat: 0, lon: 1 } },
  ];
  const recomputed = ContourRingGeometry.recomputeSmoothNormals(points);
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const prev = points[(i - 1 + n) % n], next = points[(i + 1) % n];
    const tangent = { lat: next.lat - prev.lat, lon: next.lon - prev.lon };
    const dot = recomputed[i].normal.lat * tangent.lat + recomputed[i].normal.lon * tangent.lon;
    assert.ok(Math.abs(dot) < 1e-9, `normal at index ${i} should be perpendicular to the local tangent`);
    const mag = Math.hypot(recomputed[i].normal.lat, recomputed[i].normal.lon);
    assert.ok(Math.abs(mag - 1) < 1e-9);
  }
});

test('recomputeSmoothNormals: picks the perpendicular direction that best agrees with the original outward normal, not its opposite', () => {
  const points = [
    { lat: 0, lon: 0, normal: { lat: -1, lon: 0 } },
    { lat: 1, lon: 0, normal: { lat: -1, lon: 0 } },
    { lat: 1, lon: 1, normal: { lat: 0, lon: 1 } },
  ];
  const recomputed = ContourRingGeometry.recomputeSmoothNormals(points);
  for (let i = 0; i < points.length; i++) {
    const dot = recomputed[i].normal.lat * points[i].normal.lat + recomputed[i].normal.lon * points[i].normal.lon;
    assert.ok(dot >= 0, `recomputed normal at index ${i} should point the same general way as the original`);
  }
});

// ── findInteriorHoles ────────────────────────────────────────────────────
test('findInteriorHoles: a mask island fully inside a ring is detected as that ring\'s hole', () => {
  const ring = [{ lat: 0, lon: 0 }, { lat: 0, lon: 10 }, { lat: 10, lon: 10 }, { lat: 10, lon: 0 }, { lat: 0, lon: 0 }];
  const islandLoop = ContourRingGeometry.toLoop([{ lat: 4, lon: 4 }, { lat: 4, lon: 6 }, { lat: 6, lon: 6 }, { lat: 6, lon: 4 }]);
  const rectangleLoop = ContourRingGeometry.toLoop([{ lat: -100, lon: -100 }, { lat: -100, lon: 100 }, { lat: 100, lon: 100 }, { lat: 100, lon: -100 }]);
  const holes = ContourRingGeometry.findInteriorHoles([ring], [rectangleLoop, islandLoop]);
  assert.strictEqual(holes.length, 1);
  assert.strictEqual(holes[0].length, 1, 'should find exactly one hole for the one ring');
});

test('findInteriorHoles: a mask loop comparable in size to the ring itself (its own boundary) is not misidentified as a hole', () => {
  const ring = [{ lat: 0, lon: 0 }, { lat: 0, lon: 10 }, { lat: 10, lon: 10 }, { lat: 10, lon: 0 }, { lat: 0, lon: 0 }];
  // Same loop as the ring's own boundary, not a smaller interior island.
  const sameLoop = ContourRingGeometry.toLoop(ring.slice(0, -1));
  const rectangleLoop = ContourRingGeometry.toLoop([{ lat: -100, lon: -100 }, { lat: -100, lon: 100 }, { lat: 100, lon: 100 }, { lat: 100, lon: -100 }]);
  const holes = ContourRingGeometry.findInteriorHoles([ring], [rectangleLoop, sameLoop]);
  assert.strictEqual(holes[0].length, 0, 'a loop comparable in size to the ring should not be treated as its own hole');
});

test('findInteriorHoles: a mask island outside the ring is not attributed to it', () => {
  const ring = [{ lat: 0, lon: 0 }, { lat: 0, lon: 10 }, { lat: 10, lon: 10 }, { lat: 10, lon: 0 }, { lat: 0, lon: 0 }];
  const farAwayLoop = ContourRingGeometry.toLoop([{ lat: 50, lon: 50 }, { lat: 50, lon: 52 }, { lat: 52, lon: 52 }, { lat: 52, lon: 50 }]);
  const rectangleLoop = ContourRingGeometry.toLoop([{ lat: -100, lon: -100 }, { lat: -100, lon: 100 }, { lat: 100, lon: 100 }, { lat: 100, lon: -100 }]);
  const holes = ContourRingGeometry.findInteriorHoles([ring], [rectangleLoop, farAwayLoop]);
  assert.strictEqual(holes[0].length, 0);
});
