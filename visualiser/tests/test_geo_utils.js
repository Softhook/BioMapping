/**
 * Unit tests for geo_utils.js (GeoUtils) — pure geographic geometry helpers
 * used by the Bio Mapping GSR analyser map.
 *
 * Run: node --test tests/test_geo_utils.js  (or `npm test` for the whole suite)
 */

const assert = require('assert');
const test = require('node:test');

const { GeoUtils } = require('../src/gps/geo_utils.js');

const closeTo = (actual, expected, tolerance, msg) => {
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `${msg || ''} expected ${actual} to be within ${tolerance} of ${expected}`);
};

// ---------------------------------------------------------------------------
// haversineMeters
// ---------------------------------------------------------------------------

test('haversineMeters: identical points are 0m apart', () => {
  assert.strictEqual(GeoUtils.haversineMeters(51.5, -0.1, 51.5, -0.1), 0);
});

test('haversineMeters: one degree of longitude along the equator matches R * radians(1) exactly (great-circle arc)', () => {
  // On the equator, the shortest path between two points at lat=0 IS the
  // equator itself (a great circle), so the haversine formula reduces
  // exactly to R * deltaAngleInRadians.
  const expected = GeoUtils.EARTH_RADIUS_M * (Math.PI / 180);
  const actual = GeoUtils.haversineMeters(0, 0, 0, 1);
  closeTo(actual, expected, 1e-6);
});

test('haversineMeters: one degree of latitude is close to the nominal 111.32km/deg constant', () => {
  const d = GeoUtils.haversineMeters(0, 0, 1, 0);
  closeTo(d, GeoUtils.METERS_PER_DEG_LAT, 200, 'one degree of latitude should be ~111.32km');
});

test('haversineMeters: distance is symmetric (A->B === B->A)', () => {
  const ab = GeoUtils.haversineMeters(51.5074, -0.1278, 48.8566, 2.3522);
  const ba = GeoUtils.haversineMeters(48.8566, 2.3522, 51.5074, -0.1278);
  assert.strictEqual(ab, ba);
});

test('haversineMeters: London to Paris is approximately the well-known ~343km great-circle distance', () => {
  const d = GeoUtils.haversineMeters(51.5074, -0.1278, 48.8566, 2.3522);
  closeTo(d, 343500, 5000, 'London-Paris great circle distance');
});

// ---------------------------------------------------------------------------
// distanceToSegmentMeters
// ---------------------------------------------------------------------------

test('distanceToSegmentMeters: point exactly on the segment (interior) is ~0m away', () => {
  const d = GeoUtils.distanceToSegmentMeters(0, 5, 0, 0, 0, 10);
  closeTo(d, 0, 1e-6);
});

test('distanceToSegmentMeters: point at an endpoint is ~0m away', () => {
  const d = GeoUtils.distanceToSegmentMeters(0, 0, 0, 0, 0, 10);
  closeTo(d, 0, 1e-6);
});

test('distanceToSegmentMeters: perpendicular offset from an interior point projects cleanly to the METERS_PER_DEG_LAT scale', () => {
  // Segment runs along lat=0 from lon 0 to lon 10; probing at lon=5 keeps
  // the projection strictly interior (t=0.5), so the whole offset is a
  // pure latitude delta of 0.001 degrees.
  const d = GeoUtils.distanceToSegmentMeters(0.001, 5, 0, 0, 0, 10);
  closeTo(d, 0.001 * GeoUtils.METERS_PER_DEG_LAT, 0.5);
});

test('distanceToSegmentMeters: point beyond the segment end clamps to the nearest endpoint (t clamped to 1)', () => {
  // Same lon-only segment; point at lon=15 is 5 degrees past lon2=10.
  const d = GeoUtils.distanceToSegmentMeters(0, 15, 0, 0, 0, 10);
  closeTo(d, 5 * GeoUtils.METERS_PER_DEG_LAT, 1);
});

test('distanceToSegmentMeters: point before the segment start clamps to the nearest endpoint (t clamped to 0)', () => {
  const d = GeoUtils.distanceToSegmentMeters(0, -5, 0, 0, 0, 10);
  closeTo(d, 5 * GeoUtils.METERS_PER_DEG_LAT, 1);
});

test('distanceToSegmentMeters: zero-length segment (both endpoints identical) degrades to plain point distance', () => {
  // Pure latitude offset (lon=0 everywhere) so the cosLat longitude scaling
  // factor cancels out entirely, giving an exact expected value.
  const d = GeoUtils.distanceToSegmentMeters(2, 0, 0, 0, 0, 0);
  closeTo(d, 2 * GeoUtils.METERS_PER_DEG_LAT, 1e-6);
});

// ---------------------------------------------------------------------------
// chaikinSmooth
// ---------------------------------------------------------------------------

test('chaikinSmooth: null/undefined input returns an empty array', () => {
  assert.deepStrictEqual(GeoUtils.chaikinSmooth(null), []);
  assert.deepStrictEqual(GeoUtils.chaikinSmooth(undefined), []);
});

test('chaikinSmooth: empty array input returns the same empty array unchanged', () => {
  const empty = [];
  assert.strictEqual(GeoUtils.chaikinSmooth(empty), empty);
});

test('chaikinSmooth: fewer than 3 points is returned unchanged (same reference) — nothing to smooth', () => {
  const pts = [{ lat: 0, lon: 0 }, { lat: 1, lon: 1 }];
  assert.strictEqual(GeoUtils.chaikinSmooth(pts), pts);
});

test('chaikinSmooth: iterations=0 returns the deduplicated point list converted to {lat,lon,lng} form, unsmoothed', () => {
  // Accepts [lat, lon] array-pairs too; a consecutive exact duplicate is
  // collapsed before any smoothing pass runs.
  const result = GeoUtils.chaikinSmooth([[0, 0], [0, 0], [5, 5], [10, 0]], 0, false);
  assert.strictEqual(result.length, 3, 'the consecutive duplicate [0,0] should be collapsed');
  assert.deepStrictEqual(result[0], { lat: 0, lon: 0, lng: 0 });
  assert.deepStrictEqual(result[1], { lat: 5, lon: 5, lng: 5 });
  assert.deepStrictEqual(result[2], { lat: 10, lon: 0, lng: 0 });
});

test('chaikinSmooth: a null/falsy element in the points array is treated as {lat:0,lon:0}', () => {
  const result = GeoUtils.chaikinSmooth([null, { lat: 1, lon: 1 }, { lat: 2, lon: 2 }], 0, false);
  assert.strictEqual(result.length, 3);
  assert.deepStrictEqual(result[0], { lat: 0, lon: 0, lng: 0 });
});

test('chaikinSmooth: accepts Leaflet-style LatLng objects exposing lat()/lng() as methods', () => {
  const latlng = (lat, lng) => ({ lat: () => lat, lng: () => lng });
  const result = GeoUtils.chaikinSmooth([latlng(1, 2), latlng(3, 4), latlng(5, 6)], 0, false);
  assert.deepStrictEqual(result, [
    { lat: 1, lon: 2, lng: 2 },
    { lat: 3, lon: 4, lng: 4 },
    { lat: 5, lon: 6, lng: 6 },
  ]);
});

test('chaikinSmooth: one iteration on an open 3-point path anchors the endpoints and inserts 2 cut points per segment', () => {
  const pts = [{ lat: 0, lon: 0 }, { lat: 0, lon: 10 }, { lat: 10, lon: 10 }];
  const result = GeoUtils.chaikinSmooth(pts, 1, false);
  // 2 segments * 2 cut-points + 2 anchored endpoints = 6 points.
  assert.strictEqual(result.length, 6);
  const expected = [
    { lat: 0, lon: 0, lng: 0 },
    { lat: 0, lon: 2.5, lng: 2.5 },
    { lat: 0, lon: 7.5, lng: 7.5 },
    { lat: 2.5, lon: 10, lng: 10 },
    { lat: 7.5, lon: 10, lng: 10 },
    { lat: 10, lon: 10, lng: 10 },
  ];
  assert.deepStrictEqual(result, expected);
});

test('chaikinSmooth: closed square loop dedupes the repeated closing vertex and re-closes the smoothed ring', () => {
  const square = [
    { lat: 0, lon: 0 }, { lat: 0, lon: 10 },
    { lat: 10, lon: 10 }, { lat: 10, lon: 0 },
    { lat: 0, lon: 0 }, // explicit closing vertex, same as first
  ];
  const result = GeoUtils.chaikinSmooth(square, 1, true);
  // 4 segments (wraps around) * 2 cut points + 1 re-appended closing point = 9.
  assert.strictEqual(result.length, 9);
  assert.deepStrictEqual(result[0], { lat: 0, lon: 2.5, lng: 2.5 });
  assert.deepStrictEqual(result[result.length - 1], result[0], 'ring should be re-closed: last point === first point');
});

test('chaikinSmooth: more iterations shortens total path length (progressively rounder, converging corner-cut)', () => {
  // NOTE: "distance from the nearest sample point to the original corner"
  // is NOT a valid measure of rounding here — it's confounded by point
  // density (more iterations = more samples = a sample happens to land
  // closer purely by resolution, even with zero further smoothing).
  // Verified numerically: for this exact corner, that metric goes 2.5 ->
  // 1.98 -> 1.82 -> ... i.e. it looks like it's "proving" progressive
  // rounding, but a *distance-to-the-polyline-as-a-path* check shows the
  // curve's closest approach to the corner is already at its converged
  // limit after a single iteration for this symmetric right-angle corner —
  // the earlier metric's improvement was pure sampling-density artifact.
  //
  // Total path length IS a true, monotonically-decreasing invariant of
  // Chaikin corner-cutting: each cut replaces a corner with a chord,
  // strictly shortening the path, converging toward the limit spline's
  // (shorter) length. That's what "progressively rounder" actually means
  // here, and it holds regardless of how densely the result is sampled.
  const pts = [{ lat: 0, lon: 0 }, { lat: 0, lon: 10 }, { lat: 10, lon: 10 }];
  const pathLength = (poly) => {
    let len = 0;
    for (let i = 0; i < poly.length - 1; i++) {
      len += Math.hypot(poly[i + 1].lat - poly[i].lat, poly[i + 1].lon - poly[i].lon);
    }
    return len;
  };
  const original = pathLength(pts);
  const one = GeoUtils.chaikinSmooth(pts, 1, false);
  const three = GeoUtils.chaikinSmooth(pts, 3, false);
  const lenOne = pathLength(one);
  const lenThree = pathLength(three);

  assert.ok(lenOne < original, 'even one corner cut should shorten the path below the sharp-cornered original');
  assert.ok(lenThree < lenOne, 'more iterations should shorten the path further, converging toward the limit curve');
  assert.ok(three.length > one.length, 'more iterations should also produce more points');
});

// ---------------------------------------------------------------------------
// pointInPolygon
// ---------------------------------------------------------------------------

const SQUARE_OBJ = [{ lat: 0, lon: 0 }, { lat: 0, lon: 10 }, { lat: 10, lon: 10 }, { lat: 10, lon: 0 }];
const SQUARE_ARR = [[0, 0], [0, 10], [10, 10], [10, 0]];

test('pointInPolygon: point clearly inside a square ({lat,lon} form) returns true', () => {
  assert.strictEqual(GeoUtils.pointInPolygon(5, 5, SQUARE_OBJ), true);
});

test('pointInPolygon: point clearly outside a square ({lat,lon} form) returns false', () => {
  assert.strictEqual(GeoUtils.pointInPolygon(15, 15, SQUARE_OBJ), false);
});

test('pointInPolygon: accepts [lat,lon] array-pair polygon vertices identically to object form', () => {
  assert.strictEqual(GeoUtils.pointInPolygon(5, 5, SQUARE_ARR), true);
  assert.strictEqual(GeoUtils.pointInPolygon(15, 15, SQUARE_ARR), false);
});

test('pointInPolygon: point just outside one edge of the square returns false', () => {
  assert.strictEqual(GeoUtils.pointInPolygon(5, 10.5, SQUARE_OBJ), false);
});

test('pointInPolygon: empty polygon never contains any point', () => {
  assert.strictEqual(GeoUtils.pointInPolygon(0, 0, []), false);
});

test('pointInPolygon: works on a non-convex (L-shaped) polygon', () => {
  const lShape = [
    { lat: 0, lon: 0 }, { lat: 0, lon: 10 }, { lat: 5, lon: 10 },
    { lat: 5, lon: 5 }, { lat: 10, lon: 5 }, { lat: 10, lon: 0 },
  ];
  // Inside the "notch" cut out of the L (top-right of the L's bounding box) -> outside the shape.
  assert.strictEqual(GeoUtils.pointInPolygon(8, 8, lShape), false);
  // Inside the solid part of the L.
  assert.strictEqual(GeoUtils.pointInPolygon(2, 2, lShape), true);
  assert.strictEqual(GeoUtils.pointInPolygon(8, 2, lShape), true);
});

// ---------------------------------------------------------------------------
// shoelaceArea
// ---------------------------------------------------------------------------

test('shoelaceArea: unit square (object form) has area 1', () => {
  assert.strictEqual(GeoUtils.shoelaceArea(SQUARE_OBJ), 100); // 10x10 square from SQUARE_OBJ above
});

test('shoelaceArea: accepts [lat,lon] array-pair vertices identically to object form', () => {
  assert.strictEqual(GeoUtils.shoelaceArea(SQUARE_ARR), 100);
});

test('shoelaceArea: right triangle matches 0.5*base*height', () => {
  const tri = [{ lat: 0, lon: 0 }, { lat: 0, lon: 6 }, { lat: 4, lon: 0 }];
  assert.strictEqual(GeoUtils.shoelaceArea(tri), 12);
});

test('shoelaceArea: is winding-direction independent (reversed ring gives the same area)', () => {
  const reversed = [...SQUARE_OBJ].reverse();
  assert.strictEqual(GeoUtils.shoelaceArea(reversed), GeoUtils.shoelaceArea(SQUARE_OBJ));
});

test('shoelaceArea: fewer than 3 points is degenerate — area 0', () => {
  assert.strictEqual(GeoUtils.shoelaceArea([]), 0);
  assert.strictEqual(GeoUtils.shoelaceArea([{ lat: 0, lon: 0 }]), 0);
  assert.strictEqual(GeoUtils.shoelaceArea([{ lat: 0, lon: 0 }, { lat: 1, lon: 1 }]), 0);
});

test('shoelaceArea: collinear (degenerate, zero-width) points have zero area', () => {
  const line = [{ lat: 0, lon: 0 }, { lat: 0, lon: 5 }, { lat: 0, lon: 10 }];
  assert.strictEqual(GeoUtils.shoelaceArea(line), 0);
});
