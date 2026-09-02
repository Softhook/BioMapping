/**
 * Unit tests for the overlap-aware path colour helpers on GSRMapManager:
 *   _buildOverlapCells   — pass 1: grid binning + straddle-safe revisit flag
 *   _overlapPooledAccessor — pass 2: 3×3-block mean where the walk retraces
 *   _pathRetraces        — cheap "could this ever overlap?" gate
 *
 * Pure (no DOM/Leaflet) apart from the GeoUtils global.
 * Run: node --test tests/test_path_overlap_pooling.js
 */

const assert = require('assert');
const test = require('node:test');

global.GeoUtils = require('../src/gps/geo_utils.js').GeoUtils;
const { GSRMapManager } = require('../src/map/map.js');

const LAT0 = 51.5;
const LON0 = -0.12;
const SC = global.GeoUtils.getGeodesicScale(LAT0);
const OPTS = { radiusM: 7, revisitGapS: 15 };

// A draw point `xM` metres east of the origin, at time `t`, carrying metric `v`.
const pt = (xM, t, v) => ({ lat: LAT0, lon: LON0 + xM / SC.degToMeterLon, time: t, v });
const getVal = (p) => p.v;

// Outbound 0..30 m (metric `outV`), a long detour far away, then a return pass
// back along 0..30 m (metric `retV`) ~120 s later. A genuine retrace.
function thereAndBack(outV, retV) {
  const dp = [];
  for (let i = 0; i <= 15; i++) dp.push(pt(i * 2, i, outV));
  for (let i = 1; i <= 10; i++) dp.push(pt(30 + i * 20, 15 + i * 5, outV));
  for (let i = 15; i >= 0; i--) dp.push(pt(i * 2, 120 + (15 - i), retV));
  return dp;
}

// ─── _overlapPooledAccessor ─────────────────────────────────────────────

test('straight walk with no retrace → null', () => {
  const dp = [];
  for (let i = 0; i < 40; i++) dp.push(pt(i * 2, i, 1 + i));
  assert.strictEqual(GSRMapManager._overlapPooledAccessor(dp, getVal, OPTS), null);
});

test('too-short / bad input → null', () => {
  assert.strictEqual(GSRMapManager._overlapPooledAccessor([pt(0, 0, 1)], getVal, OPTS), null);
  assert.strictEqual(GSRMapManager._overlapPooledAccessor(null, getVal, OPTS), null);
});

test('a genuine retrace pools the retraced stretch to the combined mean', () => {
  const valAt = GSRMapManager._overlapPooledAccessor(thereAndBack(10, 20), getVal, OPTS);
  assert.strictEqual(typeof valAt, 'function');
  // Equal points from each visit over the retraced span → mean 15.
  const mid = pt(14, 0, 999);
  assert.ok(Math.abs(valAt(mid) - 15) < 1e-6, `got ${valAt(mid)}`);
});

test('the non-retraced detour leg is left untouched', () => {
  const dp = thereAndBack(10, 20);
  const valAt = GSRMapManager._overlapPooledAccessor(dp, getVal, OPTS);
  const detour = dp[20]; // out in the far detour, visited once
  assert.strictEqual(valAt(detour), getVal(detour));
});

test('pooled colour is location-based, so two points in the same spot read alike', () => {
  const valAt = GSRMapManager._overlapPooledAccessor(thereAndBack(10, 20), getVal, OPTS);
  // Whatever object you ask with, a given location gets one combined value —
  // this is what keeps the re-walked street visually seamless.
  assert.strictEqual(valAt(pt(12, 5, 111)), valAt(pt(12, 130, 222)));
});

test('a point at a location the path never overlapped falls through to getVal', () => {
  const valAt = GSRMapManager._overlapPooledAccessor(thereAndBack(10, 20), getVal, OPTS);
  const faraway = pt(5000, 42, 7);
  assert.strictEqual(valAt(faraway), 7);
});

test('one slow dense pass over a spot is NOT pooled (no revisit gap)', () => {
  const dp = [];
  for (let i = 0; i < 30; i++) dp.push(pt(i % 3, i * 0.5, 5)); // 2 m jitter, 0.5 s apart
  for (let i = 0; i < 20; i++) dp.push(pt(20 + i * 3, 20 + i, 5));
  assert.strictEqual(GSRMapManager._overlapPooledAccessor(dp, getVal, OPTS), null);
});

test('a wider radius pools where a tighter one does not (visual-width scaling)', () => {
  // Two parallel passes ~10 m apart (offset north), ~100 s apart in time.
  const north = (m) => LAT0 + m / SC.degToMeterLat;
  const dp = [];
  for (let i = 0; i <= 15; i++) dp.push({ lat: LAT0, lon: LON0 + (i * 2) / SC.degToMeterLon, time: i, v: 10 });
  for (let i = 1; i <= 6; i++) dp.push({ lat: LAT0, lon: LON0 + (30 + i * 25) / SC.degToMeterLon, time: 20 + i * 8, v: 10 });
  for (let i = 15; i >= 0; i--) dp.push({ lat: north(10), lon: LON0 + (i * 2) / SC.degToMeterLon, time: 120 + (15 - i), v: 20 });

  assert.strictEqual(GSRMapManager._overlapPooledAccessor(dp, getVal, { radiusM: 4, revisitGapS: 15 }), null,
    'strokes 10 m apart do not merge at radius 4');
  assert.strictEqual(typeof GSRMapManager._overlapPooledAccessor(dp, getVal, { radiusM: 14, revisitGapS: 15 }),
    'function', 'at radius 14 the same two strokes merge');
});

test('accessor carries a stable .sig — same inputs match, changed outcome differs', () => {
  const a = GSRMapManager._overlapPooledAccessor(thereAndBack(10, 20), getVal, OPTS);
  const b = GSRMapManager._overlapPooledAccessor(thereAndBack(10, 20), getVal, OPTS);
  assert.strictEqual(typeof a.sig, 'number');
  assert.strictEqual(a.sig, b.sig, 'identical inputs → identical fingerprint (zoom hook skips the rebuild)');

  const c = GSRMapManager._overlapPooledAccessor(thereAndBack(10, 50), getVal, OPTS);
  assert.notStrictEqual(a.sig, c.sig, 'a different pooled mean → different fingerprint (rebuild fires)');
});

// ─── _pathRetraces (the zoom gate) ─────────────────────────────────────

test('_pathRetraces: true for a there-and-back, false for a straight walk', () => {
  assert.strictEqual(GSRMapManager._pathRetraces(thereAndBack(1, 2), { radiusM: 60, revisitGapS: 15 }), true);
  const straight = [];
  for (let i = 0; i < 40; i++) straight.push(pt(i * 5, i, 1));
  assert.strictEqual(GSRMapManager._pathRetraces(straight, { radiusM: 60, revisitGapS: 15 }), false);
});

// ─── _buildOverlapCells (straddle safety) ──────────────────────────────

test('_buildOverlapCells: boundary wiggle is not a revisit (time-based test)', () => {
  // Path oscillates across a cell edge every 0.1 s — many re-touches, but all
  // milliseconds apart, so nothing should be flagged as revisited.
  const rLon = 7 / SC.degToMeterLon;
  const edge = Math.round((LON0) / rLon) * rLon; // a cell boundary in lon
  const dp = [];
  for (let i = 0; i < 60; i++) {
    dp.push({ lat: LAT0, lon: edge + (i % 2 === 0 ? -0.2 : 0.2) / SC.degToMeterLon, time: i * 0.1, v: 3 });
  }
  const built = GSRMapManager._buildOverlapCells(dp, getVal, 7, 15);
  assert.strictEqual(built.anyRevisited, false);
});

test('_buildOverlapCells: same cell re-entered after a real gap IS a revisit', () => {
  const dp = [
    pt(1, 0, 1), pt(2, 1, 1), pt(1.5, 2, 1),   // visit A
    pt(400, 30, 1), pt(800, 60, 1),            // away
    pt(1.2, 200, 1), pt(2.1, 201, 1)           // visit B, same cell
  ];
  const built = GSRMapManager._buildOverlapCells(dp, getVal, 7, 15);
  assert.strictEqual(built.anyRevisited, true);
});
