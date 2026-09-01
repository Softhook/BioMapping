'use strict';
/**
 * Comprehensive unit tests for gps_filter.js (GpsFilter).
 *
 * Tests the complete trajectory cleaning and filtering pipeline:
 *  - haversineDistance
 *  - applySpeedFilter (with 10-rejection coordinate latch recovery)
 *  - applyKalman (forward chi-squared innovation gate + RTS backward pass + displacement clamp)
 *  - applyVelocitySmoothing (vector EMA heading projection across 0°/360° boundary + HDOP scaling)
 *  - applyStopAveraging (stationary centroid clustering + timeline preservation)
 *  - applyRDP (geometric simplification + forceIndexSet vertex preservation)
 *
 * Run: node --test tests/test_gps_filter.js
 */

const assert = require('assert');
const test = require('node:test');

// Ensure GeoUtils is available globally and required
const { GeoUtils } = require('../src/gps/geo_utils.js');
global.GeoUtils = GeoUtils;

const GpsFilter = require('../src/gps/gps_filter.js');

const closeTo = (actual, expected, tolerance = 1e-5, msg = '') => {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${msg} expected ${actual} to be within ${tolerance} of ${expected}`
  );
};

// ── haversineDistance ───────────────────────────────────────────────────────

test('haversineDistance: delegates to GeoUtils.haversineMeters accurately', () => {
  const d1 = GpsFilter.haversineDistance(51.5074, -0.1278, 51.5074, -0.1278);
  assert.strictEqual(d1, 0);

  const d2 = GpsFilter.haversineDistance(51.5074, -0.1278, 48.8566, 2.3522);
  closeTo(d2, 343500, 5000, 'London-Paris distance');
});

// ── applySpeedFilter ────────────────────────────────────────────────────────

test('applySpeedFilter: returns points unchanged on invalid parameters or small arrays', () => {
  const pts = [{ lat: 51.5, lon: -0.1, time: 0 }];
  assert.strictEqual(GpsFilter.applySpeedFilter(pts, 5), pts);
  assert.strictEqual(GpsFilter.applySpeedFilter(pts, 0), pts);
  assert.strictEqual(GpsFilter.applySpeedFilter(pts, -1), pts);
});

test('applySpeedFilter: keeps points within plausible Doppler speed and drops excessive spikes', () => {
  const points = [
    { lat: 51.5000, lon: -0.1000, time: 0.0, speedKts: 2.0 },  // ~1.03 m/s (< 5 m/s) -> Keep
    { lat: 51.5001, lon: -0.1000, time: 1.0, speedKts: 3.0 },  // ~1.54 m/s (< 5 m/s) -> Keep
    { lat: 51.5100, lon: -0.1000, time: 2.0, speedKts: 30.0 }, // ~15.4 m/s (> 5 m/s) -> Reject
    { lat: 51.5002, lon: -0.1000, time: 3.0, speedKts: 2.5 },  // ~1.28 m/s (< 5 m/s) -> Keep
  ];

  const filtered = GpsFilter.applySpeedFilter(points, 5.0); // maxSpeed = 5 m/s
  assert.strictEqual(filtered.length, 3);
  assert.strictEqual(filtered[0].time, 0.0);
  assert.strictEqual(filtered[1].time, 1.0);
  assert.strictEqual(filtered[2].time, 3.0);
});

test('applySpeedFilter: falls back to position-derived speed when speedKts is absent or NaN', () => {
  const points = [
    { lat: 51.50000, lon: -0.10000, time: 0.0 },
    { lat: 51.50005, lon: -0.10000, time: 1.0 }, // ~5.5m in 1s = 5.5 m/s -> Keep with maxSpeed 10
    { lat: 51.51000, lon: -0.10000, time: 2.0 }, // ~1110m in 1s = 1110 m/s -> Reject
    { lat: 51.50010, lon: -0.10000, time: 3.0 }, // ~5.5m from last kept in 2s -> Keep
  ];

  const filtered = GpsFilter.applySpeedFilter(points, 10.0);
  assert.strictEqual(filtered.length, 3);
  assert.strictEqual(filtered[0].time, 0.0);
  assert.strictEqual(filtered[1].time, 1.0);
  assert.strictEqual(filtered[2].time, 3.0);
});

test('applySpeedFilter: activates recovery latch after 10 consecutive rejections', () => {
  // Sustained movement event where speed gate fails 12 times in a row
  const points = [{ lat: 51.5000, lon: -0.1000, time: 0.0, speedKts: 1.0 }];
  for (let i = 1; i <= 12; i++) {
    points.push({ lat: 51.5000 + i * 0.001, lon: -0.1000, time: i * 1.0, speedKts: 50.0 });
  }

  const filtered = GpsFilter.applySpeedFilter(points, 5.0);
  // Initial point + 10th rejected point latched to last good pos + subsequent points
  assert.ok(filtered.length >= 2, 'Recovery latch should emit a point when consecutive rejections reach 10');
  const latched = filtered[1];
  assert.strictEqual(latched.lat, 51.5000, 'Latched point holds last good latitude');
  assert.strictEqual(latched.lon, -0.1000, 'Latched point holds last good longitude');
  assert.strictEqual(latched.time, 10.0, 'Latched point advances timestamp to current time');
});

// ── applyKalman ─────────────────────────────────────────────────────────────

test('applyKalman: returns points unmodified for invalid noise parameters or single point', () => {
  const pts = [{ lat: 51.5, lon: -0.1, time: 0 }];
  assert.strictEqual(GpsFilter.applyKalman(pts, 1.0, 5.0), pts);
  assert.strictEqual(GpsFilter.applyKalman(pts, 0, 5.0), pts);
  assert.strictEqual(GpsFilter.applyKalman(pts, 1.0, 0), pts);
});

test('applyKalman: chi-squared innovation gate rejects sudden single-point multipath jump in forward pass', () => {
  // Linear straight-line track with one severe 500m outlier jump at index 5
  const points = [];
  for (let i = 0; i < 10; i++) {
    points.push({
      lat: 51.5000 + i * 0.00001,
      lon: -0.1000,
      time: i * 1.0,
      hdop: 1.0,
      pdop: 1.5,
      hacc: 2.0
    });
  }
  // Inject multipath jump (+0.005 deg ≈ +550m) at i=5
  points[5].lat += 0.005;

  const getR = () => (4.0 / (GeoUtils.METERS_PER_DEG_LAT ** 2));
  const fwd = GpsFilter._kalmanForwardPass(points, 1e-10, 1e-10, 1e-9, 1e-9, getR, getR);

  // In forward pass, point 5 should be rejected by the innovation gate, tracking expected lat ~51.50005
  closeTo(fwd.forwardLats[5], 51.50004, 0.0001, 'Forward pass ignores outlier');
  assert.strictEqual(fwd.isOutlier[5], 1, 'Point 5 marked as outlier');
});

test('applyKalman: RTS backward pass respects displacement clamp', () => {
  // Realistic pedestrian trajectory with small GPS noise
  const points = [
    { lat: 51.50000, lon: -0.10000, time: 0.0, hdop: 1.0 },
    { lat: 51.50001, lon: -0.10000, time: 1.0, hdop: 1.0 },
    { lat: 51.50002, lon: -0.10000, time: 2.0, hdop: 1.0 },
    { lat: 51.50003, lon: -0.10000, time: 3.0, hdop: 1.0 },
  ];

  const R_m2 = 9.0; // sqrt(9) = 3m -> 3*sigma = 9m max displacement
  const smoothed = GpsFilter.applyKalman(points, 0.1, R_m2);
  assert.strictEqual(smoothed.length, 4);

  // All points should remain within 3*sqrt(R) meters of raw points
  for (let i = 0; i < points.length; i++) {
    const dist = GeoUtils.haversineMeters(points[i].lat, points[i].lon, smoothed[i].lat, smoothed[i].lon);
    assert.ok(dist <= 9.0, `Displacement ${dist}m at index ${i} should be bounded by 9m`);
  }
});

// ── applyVelocitySmoothing ──────────────────────────────────────────────────

test('applyVelocitySmoothing: returns points unmodified when velocity data is missing', () => {
  const pts = [
    { lat: 51.5, lon: -0.1, time: 0 },
    { lat: 51.501, lon: -0.1, time: 1 }
  ];
  assert.strictEqual(GpsFilter.applyVelocitySmoothing(pts), pts);
});

test('applyVelocitySmoothing: dead-reckons heading across 0°/360° north boundary seamlessly', () => {
  // Track heading North, oscillating slightly across 359° and 1°
  const points = [
    { lat: 51.5000, lon: -0.1000, time: 0.0, speedKts: 4.0, course: 358, hdop: 1.0 },
    { lat: 51.5001, lon: -0.1000, time: 1.0, speedKts: 4.0, course: 2,   hdop: 1.0 },
    { lat: 51.5002, lon: -0.1000, time: 2.0, speedKts: 4.0, course: 359, hdop: 1.0 },
    { lat: 51.5003, lon: -0.1000, time: 3.0, speedKts: 4.0, course: 1,   hdop: 1.0 },
  ];

  const smoothed = GpsFilter.applyVelocitySmoothing(points, 0.6);
  assert.strictEqual(smoothed.length, 4);

  // Longitudes should remain steady around -0.1000 without huge eastward/westward swings
  for (const pt of smoothed) {
    closeTo(pt.lon, -0.1000, 0.0005, 'Longitude should not swing across 0°/360° wrap');
    assert.ok(pt.lat >= 51.5000, 'Latitude should advance northerly');
  }
});

test('applyVelocitySmoothing: suppresses dead-reckoning displacement when speed is stationary (< 1.2 kts)', () => {
  const points = [
    { lat: 51.5000, lon: -0.1000, time: 0.0, speedKts: 0.2, course: 90, hdop: 1.0 },
    { lat: 51.5000, lon: -0.1000, time: 1.0, speedKts: 0.1, course: 180, hdop: 1.0 },
    { lat: 51.5000, lon: -0.1000, time: 2.0, speedKts: 0.3, course: 270, hdop: 1.0 },
  ];

  const smoothed = GpsFilter.applyVelocitySmoothing(points, 0.6);
  assert.strictEqual(smoothed.length, 3);
  for (const pt of smoothed) {
    closeTo(pt.lat, 51.5000, 1e-6);
    closeTo(pt.lon, -0.1000, 1e-6);
  }
});

// ── applyStopAveraging ──────────────────────────────────────────────────────

test('applyStopAveraging: collapses stationary clusters >= 3 points into centroid and preserves timestamps', () => {
  const points = [
    { lat: 51.5000, lon: -0.1000, time: 0.0, speedKts: 5.0 }, // Moving
    // Stationary cluster of 3 points (jitter around lat=51.5010, lon=-0.1010)
    { lat: 51.5009, lon: -0.1009, time: 1.0, speedKts: 0.2 },
    { lat: 51.5010, lon: -0.1010, time: 2.0, speedKts: 0.1 },
    { lat: 51.5011, lon: -0.1011, time: 3.0, speedKts: 0.3 },
    { lat: 51.5020, lon: -0.1020, time: 4.0, speedKts: 6.0 }, // Moving
  ];

  const result = GpsFilter.applyStopAveraging(points, 0.5, 3);
  assert.strictEqual(result.length, 5, 'Total point count must be preserved');

  // Moving points unchanged
  assert.strictEqual(result[0].lat, 51.5000);
  assert.strictEqual(result[4].lat, 51.5020);

  // Cluster points collapsed to exact centroid (51.5010, -0.1010)
  closeTo(result[1].lat, 51.5010, 1e-6);
  closeTo(result[1].lon, -0.1010, 1e-6);
  assert.strictEqual(result[1].time, 1.0, 'Timeline preserved');

  closeTo(result[2].lat, 51.5010, 1e-6);
  closeTo(result[2].lon, -0.1010, 1e-6);
  assert.strictEqual(result[2].time, 2.0, 'Timeline preserved');

  closeTo(result[3].lat, 51.5010, 1e-6);
  closeTo(result[3].lon, -0.1010, 1e-6);
  assert.strictEqual(result[3].time, 3.0, 'Timeline preserved');
});

test('applyStopAveraging: does not collapse clusters smaller than minClusterPoints', () => {
  const points = [
    { lat: 51.5000, lon: -0.1000, time: 0.0, speedKts: 0.1 },
    { lat: 51.5002, lon: -0.1002, time: 1.0, speedKts: 0.2 },
    // Only 2 points, below minClusterPoints=3
  ];

  const result = GpsFilter.applyStopAveraging(points, 0.5, 3);
  assert.strictEqual(result.length, 2);
  assert.strictEqual(result[0].lat, 51.5000, 'Point 0 not collapsed');
  assert.strictEqual(result[1].lat, 51.5002, 'Point 1 not collapsed');
});

// ── applyRDP ────────────────────────────────────────────────────────────────

test('applyRDP: simplifies collinear intermediate points while keeping endpoints and sharp corners', () => {
  const points = [
    { lat: 51.5000, lon: -0.1000, origIdx: 0 },
    { lat: 51.5001, lon: -0.1000, origIdx: 1 }, // On line 0->3
    { lat: 51.5002, lon: -0.1000, origIdx: 2 }, // On line 0->3
    { lat: 51.5003, lon: -0.1000, origIdx: 3 }, // 90° corner
    { lat: 51.5003, lon: -0.1050, origIdx: 4 }, // Endpoint (~350m West)
  ];

  const simplified = GpsFilter.applyRDP(points, 5.0); // tolerance = 5m
  // Points 1 and 2 lie on straight line between 0 and 3 -> dropped
  // Points 0, 3, 4 -> kept
  assert.strictEqual(simplified.length, 3);
  assert.strictEqual(simplified[0].origIdx, 0);
  assert.strictEqual(simplified[1].origIdx, 3);
  assert.strictEqual(simplified[2].origIdx, 4);
});

test('applyRDP: respects forceIndexSet and never drops forced vertices regardless of tolerance', () => {
  const points = [
    { lat: 51.5000, lon: -0.1000, origIdx: 0 },
    { lat: 51.5001, lon: -0.1000, origIdx: 1 }, // On straight line, BUT forced!
    { lat: 51.5002, lon: -0.1000, origIdx: 2 }, // On straight line, not forced
    { lat: 51.5005, lon: -0.1000, origIdx: 3 }, // Endpoint
  ];

  const forceSet = new Set([1]); // Force origIdx=1
  const simplified = GpsFilter.applyRDP(points, 50.0, forceSet); // high tolerance (50m)

  assert.strictEqual(simplified.length, 3);
  assert.strictEqual(simplified[0].origIdx, 0);
  assert.strictEqual(simplified[1].origIdx, 1, 'Forced vertex 1 must be preserved');
  assert.strictEqual(simplified[2].origIdx, 3);
});
