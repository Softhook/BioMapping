/**
 * Unit tests for gps_filter.mjs (GpsFilter):
 *  - measurementVarianceM2 (hacc_m first, else DOP²-scaled base variance)
 *  - applyRDP (geometric simplification + forceIndexSet vertex preservation)
 *
 * Run: node --test tests/test_gps_filter.js
 */

const assert = require('node:assert');
const test = require('node:test');

// Ensure GeoUtils is available globally and required
const { GeoUtils } = require('../src/gps/geo_utils.mjs');
global.GeoUtils = GeoUtils;

const { GpsFilter } = require('../src/gps/gps_filter.mjs');

// ── measurementVarianceM2 ───────────────────────────────────────────────────

test('measurementVarianceM2: uses hacc_m² when present, else base R × DOP² (pdop before hdop, clamped)', () => {
  const R = 10;
  assert.strictEqual(
    GpsFilter.measurementVarianceM2({ hacc: 4, hdop: 3 }, R),
    16,
  );
  // 99.9 is the "no $PUBX,00 yet" sentinel — not a real accuracy.
  assert.strictEqual(
    GpsFilter.measurementVarianceM2({ hacc: 99.9, hdop: 2 }, R),
    R * 4,
  );
  assert.strictEqual(
    GpsFilter.measurementVarianceM2({ hacc: NaN, pdop: 1.5, hdop: 3 }, R),
    R * 2.25,
  );
  assert.strictEqual(
    GpsFilter.measurementVarianceM2({ hdop: 0.2 }, R),
    R * 0.25,
  );
  assert.strictEqual(GpsFilter.measurementVarianceM2({ hdop: 30 }, R), R * 100);
  assert.strictEqual(GpsFilter.measurementVarianceM2({}, R), R);
});

// ── applyRDP ────────────────────────────────────────────────────────────────

test('applyRDP: simplifies collinear intermediate points while keeping endpoints and sharp corners', () => {
  const points = [
    { lat: 51.5, lon: -0.1, origIdx: 0 },
    { lat: 51.5001, lon: -0.1, origIdx: 1 }, // On line 0->3
    { lat: 51.5002, lon: -0.1, origIdx: 2 }, // On line 0->3
    { lat: 51.5003, lon: -0.1, origIdx: 3 }, // 90° corner
    { lat: 51.5003, lon: -0.105, origIdx: 4 }, // Endpoint (~350m West)
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
    { lat: 51.5, lon: -0.1, origIdx: 0 },
    { lat: 51.5001, lon: -0.1, origIdx: 1 }, // On straight line, BUT forced!
    { lat: 51.5002, lon: -0.1, origIdx: 2 }, // On straight line, not forced
    { lat: 51.5005, lon: -0.1, origIdx: 3 }, // Endpoint
  ];

  const forceSet = new Set([1]); // Force origIdx=1
  const simplified = GpsFilter.applyRDP(points, 50.0, forceSet); // high tolerance (50m)

  assert.strictEqual(simplified.length, 3);
  assert.strictEqual(simplified[0].origIdx, 0);
  assert.strictEqual(
    simplified[1].origIdx,
    1,
    'Forced vertex 1 must be preserved',
  );
  assert.strictEqual(simplified[2].origIdx, 3);
});
