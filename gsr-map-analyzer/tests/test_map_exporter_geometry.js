/**
 * Gap-fill unit tests for map_exporter.js (GSRMapExporter) — the pure
 * geometry/SVG-string helper methods NOT already exercised by the existing
 * isoband/SVG-export test files (test_isoband_boundary_closure.js,
 * test_edge_isoband_fix.js, test_masked_grid_isobands.js,
 * test_svg_vector_surface.js, test_rf_svg_export.js, test_osm_hard_shapes.js,
 * test_isoband_svg_renders.js already cover: _surface, _pathD, _pathBBox,
 * _expandCanvasForIsobands, _closeOpenIsobandPaths, _buildBoundaryLoops,
 * _pathEl, _render, _rfFluid, _getProjection).
 *
 * This file covers the remaining pure helpers: _hslToHex, _ratioToHex, _esc,
 * _img, _clipCellIsoband, _tangentExtrapolate, _toLoop, _buildRectangleLoop,
 * _traceMaskBoundary, _smoothLoopPoints, _recomputeSmoothNormals.
 *
 * NOT covered here (left for a Tier-D-style DOM/async pass, if/when that's
 * done): exportToSvg, _validate, _gather, _tiles, _inlineImg, _download,
 * _vectors, _markers, _dotSvg, _labelSvg — these orchestrate a live Leaflet
 * map, DOM tile images, and file-save I/O rather than doing pure computation.
 *
 * Run: node --test tests/test_map_exporter_geometry.js
 */

const assert = require('assert');
const test = require('node:test');

// map_exporter.js has no export guard at all (class GSRMapExporter, only
// `window.GSRMapExporter = GSRMapExporter;` unconditionally at the tail) —
// load it via vm the same way pre-existing tests in this suite already do
// for it (see tests/test_isoband_boundary_closure.js), rather than editing
// production source just to add a hook.
const vm = require('vm');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'map_exporter.js'), 'utf8');
global.window = global;
vm.runInThisContext(src.replace('class GSRMapExporter', 'global.GSRMapExporter = class GSRMapExporter'), { filename: 'map_exporter.js' });
const GSRMapExporter = global.GSRMapExporter;

// ── _hslToHex / _ratioToHex ─────────────────────────────────────────────
test('_hslToHex: pure red/green/blue hues resolve to their expected hex primaries', () => {
  assert.strictEqual(GSRMapExporter._hslToHex(0, 100, 50), '#ff0000');
  assert.strictEqual(GSRMapExporter._hslToHex(120, 100, 50), '#00ff00');
  assert.strictEqual(GSRMapExporter._hslToHex(240, 100, 50), '#0000ff');
});

test('_hslToHex: 0% lightness is black, 100% lightness is white regardless of hue', () => {
  assert.strictEqual(GSRMapExporter._hslToHex(200, 100, 0), '#000000');
  assert.strictEqual(GSRMapExporter._hslToHex(200, 100, 100), '#ffffff');
});

test('_hslToHex: 0% saturation is a neutral grey', () => {
  assert.strictEqual(GSRMapExporter._hslToHex(90, 0, 50), '#808080');
});

test('_ratioToHex: 0 maps to green (hue 120), 1 maps to red (hue 0), matching _hslToHex directly', () => {
  assert.strictEqual(GSRMapExporter._ratioToHex(0), GSRMapExporter._hslToHex(120, 100, 50));
  assert.strictEqual(GSRMapExporter._ratioToHex(1), GSRMapExporter._hslToHex(0, 100, 50));
});

test('_ratioToHex: clamps out-of-range ratios into [0, 1] instead of extrapolating hue', () => {
  assert.strictEqual(GSRMapExporter._ratioToHex(-5), GSRMapExporter._ratioToHex(0));
  assert.strictEqual(GSRMapExporter._ratioToHex(99), GSRMapExporter._ratioToHex(1));
});

// ── _esc / _img ──────────────────────────────────────────────────────────
test('_esc: escapes the 4 XML-significant characters', () => {
  assert.strictEqual(GSRMapExporter._esc(`<a href="x">&'y'</a>`), '&lt;a href=&quot;x&quot;&gt;&amp;\'y\'&lt;/a&gt;');
});

test('_esc: null/undefined become an empty string, not the literal "null"/"undefined"', () => {
  assert.strictEqual(GSRMapExporter._esc(null), '');
  assert.strictEqual(GSRMapExporter._esc(undefined), '');
});

test('_esc: non-string values are stringified first', () => {
  assert.strictEqual(GSRMapExporter._esc(42), '42');
});

test('_img: builds an <image> tag with both href and xlink:href escaped identically', () => {
  const svg = GSRMapExporter._img(1, 2, 3, 4, 'http://x.test/a&b.png');
  assert.ok(svg.includes('href="http://x.test/a&amp;b.png"'));
  assert.ok(svg.includes('xlink:href="http://x.test/a&amp;b.png"'));
  assert.ok(svg.includes('x="1" y="2" width="3" height="4"'));
});

// ── _toLoop ──────────────────────────────────────────────────────────────
test('_toLoop: empty input returns a zeroed loop shape without throwing', () => {
  assert.deepStrictEqual(GSRMapExporter._toLoop([]), { points: [], length: 0, diag: 0 });
  assert.deepStrictEqual(GSRMapExporter._toLoop(null), { points: [], length: 0, diag: 0 });
});

test('_toLoop: assigns monotonically increasing arc-length `t` starting at 0', () => {
  const loop = GSRMapExporter._toLoop([{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }, { lat: 1, lon: 1 }]);
  assert.strictEqual(loop.points[0].t, 0);
  assert.ok(loop.points[1].t > loop.points[0].t);
  assert.ok(loop.points[2].t > loop.points[1].t);
});

test('_toLoop: computes a unit-square bounding diagonal of sqrt(2)', () => {
  const loop = GSRMapExporter._toLoop([{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }, { lat: 1, lon: 1 }, { lat: 1, lon: 0 }]);
  assert.ok(Math.abs(loop.diag - Math.sqrt(2)) < 1e-9);
});

test('_toLoop: total length includes the implicit closing segment back to the first point', () => {
  const loop = GSRMapExporter._toLoop([{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }]);
  // open segment (0,0)->(0,1) = 1, closing segment (0,1)->(0,0) = 1, total = 2
  assert.ok(Math.abs(loop.length - 2) < 1e-9);
});

// ── _buildRectangleLoop ──────────────────────────────────────────────────
test('_buildRectangleLoop: traces a closed loop of 2*(rows+cols)-4 perimeter cells for a uniform grid', () => {
  const rows = 4, cols = 5;
  const grid = Array.from({ length: rows }, () => Array(cols).fill(1));
  const bounds = { minLat: 0, maxLat: 1, minLon: 0, maxLon: 1 };
  const loop = GSRMapExporter._buildRectangleLoop(grid, rows, cols, bounds);
  const expectedPerimeterCells = 2 * (rows + cols) - 4;
  assert.strictEqual(loop.points.length, expectedPerimeterCells);
});

test('_buildRectangleLoop: every point carries the grid value from its perimeter cell and an outward-facing normal', () => {
  const rows = 3, cols = 3;
  const grid = [[1, 2, 3], [4, 5, 6], [7, 8, 9]];
  const bounds = { minLat: 0, maxLat: 1, minLon: 0, maxLon: 1 };
  const loop = GSRMapExporter._buildRectangleLoop(grid, rows, cols, bounds);
  for (const p of loop.points) {
    assert.ok([1, 2, 3, 4, 6, 7, 8, 9].includes(p.val), `perimeter point should carry a perimeter grid value, got ${p.val}`);
    const mag = Math.hypot(p.normal.lat, p.normal.lon);
    assert.ok(Math.abs(mag - 1) < 1e-9, 'normal should be a unit vector');
  }
});

// ── _clipCellIsoband ─────────────────────────────────────────────────────
test('_clipCellIsoband: a cell entirely inside [va, vb] returns all 4 corners unclipped', () => {
  const corners = [
    { lat: 0, lon: 0, val: 5 }, { lat: 0, lon: 1, val: 5 },
    { lat: 1, lon: 1, val: 5 }, { lat: 1, lon: 0, val: 5 },
  ];
  const result = GSRMapExporter._clipCellIsoband(corners, 0, 10);
  assert.strictEqual(result.length, 4);
});

test('_clipCellIsoband: a cell entirely below the lower threshold returns null', () => {
  const corners = [
    { lat: 0, lon: 0, val: -5 }, { lat: 0, lon: 1, val: -5 },
    { lat: 1, lon: 1, val: -5 }, { lat: 1, lon: 0, val: -5 },
  ];
  assert.strictEqual(GSRMapExporter._clipCellIsoband(corners, 0, 10), null);
});

test('_clipCellIsoband: a cell straddling the lower threshold produces an interpolated polygon with vertices clamped to >= va', () => {
  const corners = [
    { lat: 0, lon: 0, val: -10 }, { lat: 0, lon: 1, val: 10 },
    { lat: 1, lon: 1, val: 10 }, { lat: 1, lon: 0, val: -10 },
  ];
  const result = GSRMapExporter._clipCellIsoband(corners, 0, 20);
  assert.ok(result && result.length >= 3);
  for (const p of result) assert.ok(p.val >= -1e-9);
});

test('_clipCellIsoband: fewer than 3 input corners returns null', () => {
  assert.strictEqual(GSRMapExporter._clipCellIsoband([{ lat: 0, lon: 0, val: 1 }, { lat: 1, lon: 1, val: 1 }], 0, 10), null);
  assert.strictEqual(GSRMapExporter._clipCellIsoband(null, 0, 10), null);
});

// ── _tangentExtrapolate ──────────────────────────────────────────────────
test('_tangentExtrapolate: with both ends enabled, prepends 2 points and appends 2 points', () => {
  const pts = [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }, { lat: 0, lon: 2 }];
  const result = GSRMapExporter._tangentExtrapolate(pts, 1.0);
  assert.strictEqual(result.length, pts.length + 4);
});

test('_tangentExtrapolate: extrapStart=false / extrapEnd=false independently skip that end', () => {
  const pts = [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }, { lat: 0, lon: 2 }];
  assert.strictEqual(GSRMapExporter._tangentExtrapolate(pts, 1.0, false, true).length, pts.length + 2);
  assert.strictEqual(GSRMapExporter._tangentExtrapolate(pts, 1.0, true, false).length, pts.length + 2);
  assert.strictEqual(GSRMapExporter._tangentExtrapolate(pts, 1.0, false, false).length, pts.length);
});

test('_tangentExtrapolate: fewer than 2 points returns the input unchanged (or [] for falsy input)', () => {
  assert.deepStrictEqual(GSRMapExporter._tangentExtrapolate([{ lat: 0, lon: 0 }], 1.0), [{ lat: 0, lon: 0 }]);
  assert.deepStrictEqual(GSRMapExporter._tangentExtrapolate(null, 1.0), []);
});

test('_tangentExtrapolate: extrapolated tips extend further for a larger `diag` scale factor', () => {
  const pts = [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }];
  const small = GSRMapExporter._tangentExtrapolate(pts, 1.0);
  const large = GSRMapExporter._tangentExtrapolate(pts, 10.0);
  const distFromStart = (p) => Math.hypot(p.lat - pts[0].lat, p.lon - pts[0].lon);
  assert.ok(distFromStart(large[0]) > distFromStart(small[0]));
});

// ── _traceMaskBoundary ───────────────────────────────────────────────────
test('_traceMaskBoundary: an all-valid grid (no null cells) produces no boundary segments', () => {
  const rows = 3, cols = 3;
  const grid = [[1, 1, 1], [1, 1, 1], [1, 1, 1]];
  const bounds = { minLat: 0, maxLat: 1, minLon: 0, maxLon: 1 };
  assert.strictEqual(GSRMapExporter._traceMaskBoundary(grid, rows, cols, bounds).length, 0);
});

test('_traceMaskBoundary: an all-null grid produces no boundary segments', () => {
  const rows = 3, cols = 3;
  const grid = [[null, null, null], [null, null, null], [null, null, null]];
  const bounds = { minLat: 0, maxLat: 1, minLon: 0, maxLon: 1 };
  assert.strictEqual(GSRMapExporter._traceMaskBoundary(grid, rows, cols, bounds).length, 0);
});

test('_traceMaskBoundary: a single null cell surrounded by valid cells produces boundary segments with well-formed points', () => {
  const rows = 3, cols = 3;
  const grid = [[1, 1, 1], [1, null, 1], [1, 1, 1]];
  const bounds = { minLat: 0, maxLat: 1, minLon: 0, maxLon: 1 };
  const segs = GSRMapExporter._traceMaskBoundary(grid, rows, cols, bounds);
  assert.ok(segs.length > 0);
  for (const [p1, p2] of segs) {
    for (const p of [p1, p2]) {
      assert.ok(Number.isFinite(p.lat) && Number.isFinite(p.lon) && Number.isFinite(p.val));
      const mag = Math.hypot(p.normal.lat, p.normal.lon);
      assert.ok(Math.abs(mag - 1) < 1e-6);
    }
  }
});

test('_traceMaskBoundary: NaN cells are treated the same as null (masked)', () => {
  const rows = 2, cols = 2;
  const gridNull = [[1, null], [1, 1]];
  const gridNaN  = [[1, NaN], [1, 1]];
  const bounds = { minLat: 0, maxLat: 1, minLon: 0, maxLon: 1 };
  assert.strictEqual(
    GSRMapExporter._traceMaskBoundary(gridNull, rows, cols, bounds).length,
    GSRMapExporter._traceMaskBoundary(gridNaN, rows, cols, bounds).length
  );
});

// ── _smoothLoopPoints ────────────────────────────────────────────────────
test('_smoothLoopPoints: doubles point count per iteration (Chaikin corner-cutting)', () => {
  const points = [
    { lat: 0, lon: 0, val: 1, normal: { lat: 0, lon: -1 } },
    { lat: 0, lon: 1, val: 2, normal: { lat: 1, lon: 0 } },
    { lat: 1, lon: 1, val: 3, normal: { lat: 0, lon: 1 } },
  ];
  const once = GSRMapExporter._smoothLoopPoints(points, 1);
  assert.strictEqual(once.length, points.length * 2);
  const twice = GSRMapExporter._smoothLoopPoints(points, 2);
  assert.strictEqual(twice.length, points.length * 4);
});

test('_smoothLoopPoints: fewer than 3 points is returned unchanged', () => {
  const points = [{ lat: 0, lon: 0, val: 1, normal: { lat: 0, lon: 1 } }];
  assert.deepStrictEqual(GSRMapExporter._smoothLoopPoints(points), points);
  assert.deepStrictEqual(GSRMapExporter._smoothLoopPoints(null), [], 'null input falls back to [] (points || []), not null');
});

test('_smoothLoopPoints: every output point keeps a unit-length normal', () => {
  const points = [
    { lat: 0, lon: 0, val: 1, normal: { lat: 0.6, lon: 0.8 } },
    { lat: 0, lon: 1, val: 5, normal: { lat: 1, lon: 0 } },
    { lat: 1, lon: 1, val: 9, normal: { lat: 0, lon: -1 } },
    { lat: 1, lon: 0, val: 2, normal: { lat: -1, lon: 0 } },
  ];
  const smoothed = GSRMapExporter._smoothLoopPoints(points, 1);
  for (const p of smoothed) {
    const mag = Math.hypot(p.normal.lat, p.normal.lon);
    assert.ok(Math.abs(mag - 1) < 1e-9);
  }
});

// ── _recomputeSmoothNormals ──────────────────────────────────────────────
test('_recomputeSmoothNormals: fewer than 3 points is returned unchanged', () => {
  const points = [{ lat: 0, lon: 0, normal: { lat: 1, lon: 0 } }, { lat: 1, lon: 1, normal: { lat: 0, lon: 1 } }];
  assert.deepStrictEqual(GSRMapExporter._recomputeSmoothNormals(points), points);
});

test('_recomputeSmoothNormals: every point gets a unit-length normal perpendicular to its local tangent', () => {
  const points = [
    { lat: 0, lon: 0, normal: { lat: 0, lon: -1 } },
    { lat: 0, lon: 1, normal: { lat: 0, lon: -1 } },
    { lat: 1, lon: 1, normal: { lat: 1, lon: 0 } },
    { lat: 1, lon: 0, normal: { lat: 0, lon: 1 } },
  ];
  const recomputed = GSRMapExporter._recomputeSmoothNormals(points);
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

test('_recomputeSmoothNormals: picks the perpendicular direction that best agrees with the original outward normal, not its opposite', () => {
  const points = [
    { lat: 0, lon: 0, normal: { lat: -1, lon: 0 } },
    { lat: 1, lon: 0, normal: { lat: -1, lon: 0 } },
    { lat: 1, lon: 1, normal: { lat: 0, lon: 1 } },
  ];
  const recomputed = GSRMapExporter._recomputeSmoothNormals(points);
  for (let i = 0; i < points.length; i++) {
    const dot = recomputed[i].normal.lat * points[i].normal.lat + recomputed[i].normal.lon * points[i].normal.lon;
    assert.ok(dot >= 0, `recomputed normal at index ${i} should point the same general way as the original`);
  }
});
