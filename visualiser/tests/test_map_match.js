/**
 * Unit tests for map_match.js (MapMatcher) — pure HMM-Viterbi global
 * sequence map matching, no DOM/Leaflet dependency.
 *
 * Run: node --test tests/test_map_match.js  (or `npm test` for the whole suite)
 */

const assert = require('assert');
const test = require('node:test');

// map_match.js references the global `GeoUtils` (bare identifier, not
// window.GeoUtils) for haversine distance — load the real implementation
// onto Node's `global` before requiring, same pattern as tests/test_osm_enrichment.js.
global.GeoUtils = require('../geo_utils.js').GeoUtils;

const { MapMatcher } = require('../map_match.js');

const METERS_PER_DEG_LAT = 111320.0;

function metersToLatDeg(m) { return m / METERS_PER_DEG_LAT; }

function way(id, coordinates, highway = 'residential') {
  return { type: 'way', id, tags: { highway }, coordinates };
}

// ─── match(): basic input handling ───────────────────────────────────────

test('match: empty evalPoints returns an empty Map', () => {
  const result = MapMatcher.match([], [], 50);
  assert.ok(result instanceof Map);
  assert.strictEqual(result.size, 0);
});

test('match: single point with no nearby roads passes through unchanged with alpha=0', () => {
  const raw = [{ time: 0 }];
  const evalPoints = [{ idx: 0, lat: 5, lon: 5, nearby: [] }];
  const result = MapMatcher.match(evalPoints, raw, 50);
  const r = result.get(0);
  assert.strictEqual(r.wayId, null);
  assert.strictEqual(r.alpha, 0);
  assert.strictEqual(r.lat, 5);
  assert.strictEqual(r.lon, 5);
  assert.strictEqual(r.dist, Infinity);
});

test('match: single point right on a road snaps with alpha near 1 and wayId set', () => {
  const w = way('W1', [{ lat: 0, lon: 0 }, { lat: 0, lon: 0.001 }]);
  const raw = [{ time: 0 }];
  const evalPoints = [{ idx: 0, lat: 0, lon: 0.0005, nearby: [w] }];
  const result = MapMatcher.match(evalPoints, raw, 50);
  const r = result.get(0);
  assert.strictEqual(r.wayId, 'W1');
  assert.ok(r.alpha > 0.99, `expected alpha ~1 for a fix exactly on the road, got ${r.alpha}`);
  assert.ok(r.dist < 1e-6);
});

test('match: result Map keys are raw-array indices (pt.idx), not sequence position', () => {
  const w = way('W1', [{ lat: 0, lon: 0 }, { lat: 0, lon: 0.001 }]);
  const raw = [{ time: 0 }, {}, {}, { time: 3 }, { time: 4 }]; // idx 1,2 skipped from evalPoints
  const evalPoints = [
    { idx: 0, lat: 0, lon: 0.0000, nearby: [w] },
    { idx: 3, lat: 0, lon: 0.0005, nearby: [w] },
    { idx: 4, lat: 0, lon: 0.0010, nearby: [w] },
  ];
  const result = MapMatcher.match(evalPoints, raw, 50);
  assert.deepStrictEqual([...result.keys()].sort((a, b) => a - b), [0, 3, 4]);
});

test('match: matchRadius override excludes roads outside the custom radius', () => {
  const w = way('W1', [{ lat: 0, lon: 0 }, { lat: 0, lon: 0.001 }]);
  const raw = [{ time: 0 }];
  // ~11 m off the road.
  const evalPoints = [{ idx: 0, lat: metersToLatDeg(11), lon: 0.0005, nearby: [w] }];
  const withDefault = MapMatcher.match(evalPoints, raw, 50).get(0);
  assert.strictEqual(withDefault.wayId, 'W1');

  const withTightRadius = MapMatcher.match(evalPoints, raw, 5).get(0);
  assert.strictEqual(withTightRadius.wayId, null, 'a 5 m radius should exclude a road 11 m away');
});

// ─── match(): connected multi-way path with a turn (synthetic road network) ─

test('match: sequence turning through two connected ways (L-shaped junction) snaps each leg correctly', () => {
  // Eastbound leg then a 90-degree turn north, sharing an exact junction
  // coordinate so the two ways are topologically connected.
  const wayA = way('A', [{ lat: 0, lon: 0 }, { lat: 0, lon: 0.0006 }, { lat: 0, lon: 0.0012 }]);
  const wayB = way('B', [{ lat: 0, lon: 0.0012 }, { lat: 0.0006, lon: 0.0012 }, { lat: 0.0012, lon: 0.0012 }]);
  const nearby = [wayA, wayB];

  const offset = metersToLatDeg(3); // ~3 m noisy lateral offset, well inside SIGMA_M-scale confidence

  const evalPoints = [
    { idx: 0, lat: offset, lon: 0.0000, nearby }, // on A, offset north
    { idx: 1, lat: offset, lon: 0.0003, nearby },
    { idx: 2, lat: offset, lon: 0.0006, nearby },
    { idx: 3, lat: offset, lon: 0.0009, nearby },
    { idx: 4, lat: 0.0003, lon: 0.0012 + offset, nearby }, // on B, offset east
    { idx: 5, lat: 0.0006, lon: 0.0012 + offset, nearby },
    { idx: 6, lat: 0.0009, lon: 0.0012 + offset, nearby },
    { idx: 7, lat: 0.0012, lon: 0.0012 + offset, nearby },
  ];
  const raw = evalPoints.map((_, i) => ({ time: i }));

  const result = MapMatcher.match(evalPoints, raw, 50);
  assert.strictEqual(result.size, 8);

  for (const idx of [0, 1, 2, 3]) {
    const r = result.get(idx);
    assert.strictEqual(r.wayId, 'A', `point ${idx} should snap to way A (before the turn)`);
    assert.ok(r.alpha > 0.8, `point ${idx} should have high snap confidence, got alpha=${r.alpha}`);
  }
  for (const idx of [4, 5, 6, 7]) {
    const r = result.get(idx);
    assert.strictEqual(r.wayId, 'B', `point ${idx} should snap to way B (after the turn)`);
    assert.ok(r.alpha > 0.8, `point ${idx} should have high snap confidence, got alpha=${r.alpha}`);
  }
});

test('match: one noisy GPS fix near a disconnected side street does not pull the path off the main road', () => {
  // This exercises the exact invariant documented at the top of map_match.js:
  // "One noisy GPS fix near a side street won't pull the path off the main
  // road if all other fixes are clearly on the main road." The decoy way is
  // geometrically closer to the noisy fix than the main road is, but it is
  // NOT topologically connected to the main way (endpoints >5 m apart), so
  // detouring onto it and back costs two DISCONNECTED_PENALTY_M transitions
  // — vastly outweighing the small emission-probability gain.
  const wayMain = way('MAIN', [{ lat: 0, lon: 0 }, { lat: 0, lon: 0.0015 }]);
  const decoyLat = -metersToLatDeg(20); // 20 m south, parallel, disconnected
  const wayDecoy = way('DECOY', [{ lat: decoyLat, lon: 0 }, { lat: decoyLat, lon: 0.0015 }]);
  const nearby = [wayMain, wayDecoy];

  const mainOffset = metersToLatDeg(3); // trace normally hugs the main road, 3 m off
  const noisyLat = decoyLat + metersToLatDeg(3); // but fix #2 drifts to within 3 m of the decoy

  const evalPoints = [
    { idx: 0, lat: mainOffset, lon: 0.0000, nearby },
    { idx: 1, lat: mainOffset, lon: 0.0003, nearby },
    { idx: 2, lat: noisyLat,   lon: 0.0006, nearby }, // noisy fix, much closer to the decoy
    { idx: 3, lat: mainOffset, lon: 0.0009, nearby },
    { idx: 4, lat: mainOffset, lon: 0.0012, nearby },
  ];
  const raw = evalPoints.map((_, i) => ({ time: i }));

  const result = MapMatcher.match(evalPoints, raw, 50);

  for (const idx of [0, 1, 2, 3, 4]) {
    assert.strictEqual(result.get(idx).wayId, 'MAIN',
      `point ${idx} should stay on MAIN despite fix 2's proximity to the disconnected decoy`);
  }
});

test('match: a large time gap (> MAX_GAP_S) breaks the Markov chain instead of forcing a transition', () => {
  // Two clusters of points on two *unrelated*, far-apart, disconnected roads,
  // separated by a 100 s gap (> MAX_GAP_S=30). Each point should still snap
  // to its own nearby road (emission-only) rather than being dragged toward
  // consistency with the other cluster's road.
  const wayA = way('A', [{ lat: 0, lon: 0 }, { lat: 0, lon: 0.001 }]);
  const wayB = way('B', [{ lat: 1, lon: 1 }, { lat: 1, lon: 1.001 }]);

  const evalPoints = [
    { idx: 0, lat: 0, lon: 0.0002, nearby: [wayA] },
    { idx: 1, lat: 0, lon: 0.0005, nearby: [wayA] },
    { idx: 2, lat: 1, lon: 1.0002, nearby: [wayB] },
    { idx: 3, lat: 1, lon: 1.0005, nearby: [wayB] },
  ];
  const raw = [{ time: 0 }, { time: 1 }, { time: 101 }, { time: 102 }];

  const result = MapMatcher.match(evalPoints, raw, 50);
  assert.strictEqual(result.get(0).wayId, 'A');
  assert.strictEqual(result.get(1).wayId, 'A');
  assert.strictEqual(result.get(2).wayId, 'B');
  assert.strictEqual(result.get(3).wayId, 'B');
});

test('match: a gap point with zero candidates does not corrupt the rest of the sequence (backtrace safeguard)', () => {
  const w = way('A', [{ lat: 0, lon: 0 }, { lat: 0, lon: 0.001 }]);
  const evalPoints = [
    { idx: 0, lat: 0, lon: 0.0002, nearby: [w] },
    { idx: 1, lat: 9, lon: 9, nearby: [] },       // stranded far from any road
    { idx: 2, lat: 0, lon: 0.0008, nearby: [w] },
  ];
  const raw = evalPoints.map((_, i) => ({ time: i }));

  assert.doesNotThrow(() => {
    const result = MapMatcher.match(evalPoints, raw, 50);
    assert.strictEqual(result.size, 3);
    assert.strictEqual(result.get(0).wayId, 'A');
    assert.strictEqual(result.get(1).wayId, null);
    assert.strictEqual(result.get(2).wayId, 'A');
  });
});

test('match: road-class penalty breaks an EXACT distance tie in favour of a footway over a residential road', () => {
  // _logEmit deliberately ignores road class (see its docstring — "excluded
  // ... to avoid double-counting"), so class only affects effDist-based
  // candidate ORDERING, not the Viterbi score itself. With a single eval
  // point, a genuine dist tie leaves both candidates with an identical
  // emission log-prob, so the backtrace's strict `>` comparison picks
  // whichever candidate sorted first — and effDist sorts the footway first
  // thanks to its -8 m class bonus. This test documents that tie-break
  // mechanism; it is NOT evidence that class preference survives a real
  // distance difference (see the "does not override" test below for that).
  const residential = way('RES', [{ lat: metersToLatDeg(9), lon: 0 }, { lat: metersToLatDeg(9), lon: 0.001 }], 'residential');
  const footway = way('FOOT', [{ lat: -metersToLatDeg(9), lon: 0 }, { lat: -metersToLatDeg(9), lon: 0.001 }], 'footway');
  const raw = [{ time: 0 }];
  const evalPoints = [{ idx: 0, lat: 0, lon: 0.0005, nearby: [residential, footway] }];

  const result = MapMatcher.match(evalPoints, raw, 50);
  assert.strictEqual(result.get(0).wayId, 'FOOT');
});

test('match: road-class penalty does NOT override a real distance difference in the final match', () => {
  // Companion to the tie-break test above: once the raw perpendicular
  // distances actually differ, _logEmit's pure-distance Gaussian dominates
  // and the closer road wins regardless of class, even though the farther
  // footway still sorts first in the effDist-ranked candidate list.
  const residential = way('RES', [{ lat: metersToLatDeg(2), lon: 0 }, { lat: metersToLatDeg(2), lon: 0.001 }], 'residential');
  const footway = way('FOOT', [{ lat: -metersToLatDeg(8), lon: 0 }, { lat: -metersToLatDeg(8), lon: 0.001 }], 'footway');
  const raw = [{ time: 0 }];
  const evalPoints = [{ idx: 0, lat: 0, lon: 0.0005, nearby: [residential, footway] }];

  const cands = MapMatcher._getCandidates(0, 0.0005, [residential, footway], 50, NaN, NaN);
  assert.strictEqual(cands[0].wayId, 'FOOT', 'sanity check: the farther footway should still rank first by effDist');

  const result = MapMatcher.match(evalPoints, raw, 50);
  assert.strictEqual(result.get(0).wayId, 'RES', 'the genuinely closer road should win the actual match despite ranking second');
});

test('match: non-highway / malformed geometries in `nearby` are ignored, not crashed on', () => {
  const notAWay = { type: 'node', tags: {}, coordinates: [] };
  const noHighwayTag = { type: 'way', tags: {}, coordinates: [{ lat: 0, lon: 0 }, { lat: 0, lon: 0.001 }] };
  const tooFewCoords = way('SHORT', [{ lat: 0, lon: 0 }]);
  const w = way('OK', [{ lat: 0, lon: 0 }, { lat: 0, lon: 0.001 }]);

  const raw = [{ time: 0 }];
  const evalPoints = [{ idx: 0, lat: 0, lon: 0.0005, nearby: [notAWay, noHighwayTag, tooFewCoords, w] }];

  assert.doesNotThrow(() => {
    const result = MapMatcher.match(evalPoints, raw, 50);
    assert.strictEqual(result.get(0).wayId, 'OK');
  });
});

test('match: speed/course-aware candidate ranking breaks an EXACT distance tie in favour of the heading-aligned segment', () => {
  // Same tie-break mechanism as the road-class test above: _logEmit ignores
  // bearingDiffRad entirely (by design, see its docstring), so heading only
  // shifts effDist-based candidate ORDERING. With both ways passing exactly
  // through the fix (dist=0 for each), the emission scores are identical and
  // the backtrace's strict `>` falls through to whichever candidate sorted
  // first — which effDist puts as the heading-aligned one.
  const eastWest = way('EW', [{ lat: 0, lon: -0.001 }, { lat: 0, lon: 0.001 }]);
  const northSouth = way('NS', [{ lat: -0.001, lon: 0 }, { lat: 0.001, lon: 0 }]);
  const raw = [{ time: 0, speedKts: 5, course: 90 }]; // moving due east (~2.57 m/s, above SPEED_GATE)
  const evalPoints = [{ idx: 0, lat: 0, lon: 0, nearby: [eastWest, northSouth] }];

  const result = MapMatcher.match(evalPoints, raw, 50);
  assert.strictEqual(result.get(0).wayId, 'EW', 'heading-aware ranking should prefer the way aligned with travel direction');
});

// ─── Internal geometry/probability helpers (documented invariants) ────────

test('_snapAlpha: 1.0 at the road, 0.0 at/beyond the radius, cosine roll-off at the midpoint', () => {
  assert.strictEqual(MapMatcher._snapAlpha(0, 50), 1.0);
  assert.strictEqual(MapMatcher._snapAlpha(50, 50), 0.0);
  assert.strictEqual(MapMatcher._snapAlpha(75, 50), 0.0);
  assert.ok(Math.abs(MapMatcher._snapAlpha(25, 50) - 0.5) < 1e-9);
});

test('_logEmit: probability strictly decreases as distance from the road increases', () => {
  const close = MapMatcher._logEmit(1, NaN);
  const mid = MapMatcher._logEmit(10, NaN);
  const far = MapMatcher._logEmit(30, NaN);
  assert.ok(close > mid && mid > far);
});

test('_wayDistance: same way, forward and reverse traces agree (symmetry)', () => {
  const coords = [{ lat: 0, lon: 0 }, { lat: 0, lon: 0.001 }, { lat: 0, lon: 0.002 }];
  const c1 = { wayId: 'W', coords, segIdx: 0, snapLat: 0, snapLon: 0.0005 };
  const c2 = { wayId: 'W', coords, segIdx: 1, snapLat: 0, snapLon: 0.0015 };
  const fwd = MapMatcher._wayDistance(c1, c2);
  const rev = MapMatcher._wayDistance(c2, c1);
  assert.ok(Math.abs(fwd - rev) < 1e-6);
  assert.ok(fwd > 0);
});

test('_routeDistViaJunction: returns Infinity for ways with no shared endpoint within 5 m', () => {
  const wayA = [{ lat: 0, lon: 0 }, { lat: 0, lon: 0.001 }];
  const wayC = [{ lat: 5, lon: 5 }, { lat: 5, lon: 5.001 }];
  const c1 = { wayId: 'A', coords: wayA, segIdx: 0, snapLat: 0, snapLon: 0.0005, endpoints: [wayA[0], wayA[1]] };
  const c3 = { wayId: 'C', coords: wayC, segIdx: 0, snapLat: 5, snapLon: 5.0005, endpoints: [wayC[0], wayC[1]] };
  assert.strictEqual(MapMatcher._routeDistViaJunction(c1, c3), Infinity);
});
