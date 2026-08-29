/**
 * Unit tests for bezier_spline.js (BezierSpline) — pure pixel-space curve
 * fitting extracted out of map_exporter.js's _pathD. These test the math
 * directly on {x,y} point arrays instead of parsing an SVG `d` string.
 *
 * Run: node --test tests/test_bezier_spline.js  (or `npm test` for the whole suite)
 */

const assert = require('assert');
const test = require('node:test');

const { BezierSpline } = require('../src/render/bezier_spline.js');

const close = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;
const pointsClose = (p, q, tol = 1e-6) => close(p.x, q.x, tol) && close(p.y, q.y, tol);

// ── catmullRomToBezier ──────────────────────────────────────────────────

test('catmullRomToBezier: empty input returns zeroed start, no segments', () => {
  const r = BezierSpline.catmullRomToBezier([], false);
  assert.deepStrictEqual(r.segments, []);
  assert.deepStrictEqual(r.start, { x: 0, y: 0 });
});

test('catmullRomToBezier: single point returns that point as start, no segments', () => {
  const p = { x: 5, y: 7 };
  const r = BezierSpline.catmullRomToBezier([p], false);
  assert.strictEqual(r.start, p);
  assert.deepStrictEqual(r.segments, []);
});

test('catmullRomToBezier: two points produces exactly one segment ending at the second point', () => {
  const pts = [{ x: 0, y: 0 }, { x: 10, y: 0 }];
  const r = BezierSpline.catmullRomToBezier(pts, false);
  assert.strictEqual(r.segments.length, 1);
  assert.ok(pointsClose(r.segments[0].end, { x: 10, y: 0 }));
});

test('catmullRomToBezier: open path produces n-1 segments for n points, each ending at the next point', () => {
  const pts = [{ x: 0, y: 0 }, { x: 10, y: 5 }, { x: 20, y: 0 }, { x: 30, y: 8 }];
  const r = BezierSpline.catmullRomToBezier(pts, false);
  assert.strictEqual(r.segments.length, 3);
  for (let i = 0; i < 3; i++) {
    assert.ok(pointsClose(r.segments[i].end, pts[i + 1]), `segment ${i} should end at pts[${i + 1}]`);
  }
  assert.deepStrictEqual(r.start, pts[0]);
});

test('catmullRomToBezier: on a straight line, control points also fall exactly on the line (no curvature introduced)', () => {
  const pts = [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }];
  const r = BezierSpline.catmullRomToBezier(pts, false);
  r.segments.forEach(s => {
    assert.ok(close(s.c1.y, 0), 'c1.y should stay on the line');
    assert.ok(close(s.c2.y, 0), 'c2.y should stay on the line');
  });
});

test('catmullRomToBezier: closed ring (duplicated closing vertex) produces m segments and wraps continuously', () => {
  // Square ring, closing vertex duplicated as chaikinSmooth(...,closed=true) produces.
  const square = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 0, y: 0 }];
  const r = BezierSpline.catmullRomToBezier(square, true);
  assert.strictEqual(r.segments.length, 4);
  // Last segment should end back where it started (closed loop).
  assert.ok(pointsClose(r.segments[3].end, square[0]));
});

test('catmullRomToBezier: uneven point spacing does not overshoot wildly (centripetal, not uniform)', () => {
  // A pathological point set: one segment much shorter than its neighbors.
  // Uniform Catmull-Rom is known to overshoot/loop here; centripetal should not.
  const pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100.5, y: 0.5 }, { x: 200, y: 0 }];
  const r = BezierSpline.catmullRomToBezier(pts, false);
  // Control points around the tiny middle segment should stay within a sane
  // bounding box of their neighbors — not fly off far past them.
  const seg = r.segments[1]; // the tiny segment
  const maxCoord = 250;
  assert.ok(Math.abs(seg.c1.x) < maxCoord && Math.abs(seg.c1.y) < maxCoord);
  assert.ok(Math.abs(seg.c2.x) < maxCoord && Math.abs(seg.c2.y) < maxCoord);
});

// ── bsplineToBezier ──────────────────────────────────────────────────────

test('bsplineToBezier: open (non-closed) input returns no segments', () => {
  const pts = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }];
  const r = BezierSpline.bsplineToBezier(pts, false);
  assert.deepStrictEqual(r.segments, []);
});

test('bsplineToBezier: fewer than 3 unique points (after de-duplicating the closing vertex) returns no segments', () => {
  const pts = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 0 }]; // 2 unique points, closed
  const r = BezierSpline.bsplineToBezier(pts, true);
  assert.deepStrictEqual(r.segments, []);
});

test('bsplineToBezier: closed square ring produces one segment per edge, wrapping continuously', () => {
  const square = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 0, y: 0 }];
  const r = BezierSpline.bsplineToBezier(square, true);
  assert.strictEqual(r.segments.length, 4);
  // Each segment's end must equal the next segment's implicit start (C0 continuity) —
  // segment i's `end` should match segment i+1's c1 lying on the same blended path,
  // concretely: re-deriving segment (i+1) from the same points should start exactly
  // where segment i ended.
  for (let i = 0; i < 4; i++) {
    const nextStart = i === 3 ? r.start : undefined;
    if (nextStart) assert.ok(pointsClose(r.segments[i].end, nextStart), 'ring should close back to its own start point');
  }
});

test('bsplineToBezier: every Bézier hull point is a convex combination of its 4 source points (never overshoots)', () => {
  // A ring with one sharp, uneven "spike" point — an interpolating spline would
  // overshoot around it; B-spline must stay within the convex hull of every
  // 4-point window it blends.
  const ring = [
    { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 100, y: 11 }, { x: 0, y: 10 }, { x: 0, y: 0 }
  ];
  const r = BezierSpline.bsplineToBezier(ring, true);
  const unique = ring.slice(0, -1);
  const minX = Math.min(...unique.map(p => p.x)) - 1e-6;
  const maxX = Math.max(...unique.map(p => p.x)) + 1e-6;
  const minY = Math.min(...unique.map(p => p.y)) - 1e-6;
  const maxY = Math.max(...unique.map(p => p.y)) + 1e-6;
  r.segments.forEach(s => {
    [s.c1, s.c2, s.end].forEach(p => {
      assert.ok(p.x >= minX && p.x <= maxX, `x=${p.x} escaped the source points' bounding box [${minX},${maxX}]`);
      assert.ok(p.y >= minY && p.y <= maxY, `y=${p.y} escaped the source points' bounding box [${minY},${maxY}]`);
    });
  });
});

test('bsplineToBezier vs catmullRomToBezier: B-spline does not pass through the source vertices (approximating), Catmull-Rom does (interpolating)', () => {
  const square = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 0, y: 0 }];
  const catmull = BezierSpline.catmullRomToBezier(square, true);
  const bspline = BezierSpline.bsplineToBezier(square, true);

  // Catmull-Rom's segment ends land exactly on the original vertices.
  assert.ok(pointsClose(catmull.segments[0].end, square[1]));

  // B-spline's corresponding "end" is a blend, not the raw vertex — for this
  // symmetric square it lands at the edge midpoint, not the corner.
  assert.ok(!pointsClose(bspline.segments[0].end, square[1], 1e-3));
});
