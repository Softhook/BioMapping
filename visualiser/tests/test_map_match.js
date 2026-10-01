/**
 * Unit tests for map_match.js (MapMatcher) — pure HMM-Viterbi global
 * sequence map matching, no DOM/Leaflet dependency.
 *
 * Run: node --test tests/test_map_match.js  (or `npm test` for the whole suite)
 */

const assert = require('node:assert');
const test = require('node:test');

// map_match.js references the global `GeoUtils` (bare identifier, not
// window.GeoUtils) for haversine distance — load the real implementation
// onto Node's `global` before requiring, same pattern as tests/test_osm_enrichment.js.
global.GeoUtils = require('../src/gps/geo_utils.mjs').GeoUtils;

const { MapMatcher } = require('../src/gps/map_match.mjs');

const METERS_PER_DEG_LAT = 111320.0;

function metersToLatDeg(m) {
  return m / METERS_PER_DEG_LAT;
}

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
  const w = way('W1', [
    { lat: 0, lon: 0 },
    { lat: 0, lon: 0.001 },
  ]);
  const raw = [{ time: 0 }];
  const evalPoints = [{ idx: 0, lat: 0, lon: 0.0005, nearby: [w] }];
  const result = MapMatcher.match(evalPoints, raw, 50);
  const r = result.get(0);
  assert.strictEqual(r.wayId, 'W1');
  assert.ok(
    r.alpha > 0.99,
    `expected alpha ~1 for a fix exactly on the road, got ${r.alpha}`,
  );
  assert.ok(r.dist < 1e-6);
});

test('match: result Map keys are raw-array indices (pt.idx), not sequence position', () => {
  const w = way('W1', [
    { lat: 0, lon: 0 },
    { lat: 0, lon: 0.001 },
  ]);
  const raw = [{ time: 0 }, {}, {}, { time: 3 }, { time: 4 }]; // idx 1,2 skipped from evalPoints
  const evalPoints = [
    { idx: 0, lat: 0, lon: 0.0, nearby: [w] },
    { idx: 3, lat: 0, lon: 0.0005, nearby: [w] },
    { idx: 4, lat: 0, lon: 0.001, nearby: [w] },
  ];
  const result = MapMatcher.match(evalPoints, raw, 50);
  assert.deepStrictEqual(
    [...result.keys()].sort((a, b) => a - b),
    [0, 3, 4],
  );
});

test('match: matchRadius override excludes roads outside the custom radius', () => {
  const w = way('W1', [
    { lat: 0, lon: 0 },
    { lat: 0, lon: 0.001 },
  ]);
  const raw = [{ time: 0 }];
  // ~11 m off the road.
  const evalPoints = [
    { idx: 0, lat: metersToLatDeg(11), lon: 0.0005, nearby: [w] },
  ];
  const withDefault = MapMatcher.match(evalPoints, raw, 50).get(0);
  assert.strictEqual(withDefault.wayId, 'W1');

  const withTightRadius = MapMatcher.match(evalPoints, raw, 5).get(0);
  assert.strictEqual(
    withTightRadius.wayId,
    null,
    'a 5 m radius should exclude a road 11 m away',
  );
});

// ─── match(): connected multi-way path with a turn (synthetic road network) ─

test('match: sequence turning through two connected ways (L-shaped junction) snaps each leg correctly', () => {
  // Eastbound leg then a 90-degree turn north, sharing an exact junction
  // coordinate so the two ways are topologically connected.
  const wayA = way('A', [
    { lat: 0, lon: 0 },
    { lat: 0, lon: 0.0006 },
    { lat: 0, lon: 0.0012 },
  ]);
  const wayB = way('B', [
    { lat: 0, lon: 0.0012 },
    { lat: 0.0006, lon: 0.0012 },
    { lat: 0.0012, lon: 0.0012 },
  ]);
  const nearby = [wayA, wayB];

  const offset = metersToLatDeg(3); // ~3 m noisy lateral offset, well inside SIGMA_M-scale confidence

  const evalPoints = [
    { idx: 0, lat: offset, lon: 0.0, nearby }, // on A, offset north
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
    assert.strictEqual(
      r.wayId,
      'A',
      `point ${idx} should snap to way A (before the turn)`,
    );
    assert.ok(
      r.alpha > 0.8,
      `point ${idx} should have high snap confidence, got alpha=${r.alpha}`,
    );
  }
  for (const idx of [4, 5, 6, 7]) {
    const r = result.get(idx);
    assert.strictEqual(
      r.wayId,
      'B',
      `point ${idx} should snap to way B (after the turn)`,
    );
    assert.ok(
      r.alpha > 0.8,
      `point ${idx} should have high snap confidence, got alpha=${r.alpha}`,
    );
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
  const wayMain = way('MAIN', [
    { lat: 0, lon: 0 },
    { lat: 0, lon: 0.0015 },
  ]);
  const decoyLat = -metersToLatDeg(20); // 20 m south, parallel, disconnected
  const wayDecoy = way('DECOY', [
    { lat: decoyLat, lon: 0 },
    { lat: decoyLat, lon: 0.0015 },
  ]);
  const nearby = [wayMain, wayDecoy];

  const mainOffset = metersToLatDeg(3); // trace normally hugs the main road, 3 m off
  const noisyLat = decoyLat + metersToLatDeg(3); // but fix #2 drifts to within 3 m of the decoy

  const evalPoints = [
    { idx: 0, lat: mainOffset, lon: 0.0, nearby },
    { idx: 1, lat: mainOffset, lon: 0.0003, nearby },
    { idx: 2, lat: noisyLat, lon: 0.0006, nearby }, // noisy fix, much closer to the decoy
    { idx: 3, lat: mainOffset, lon: 0.0009, nearby },
    { idx: 4, lat: mainOffset, lon: 0.0012, nearby },
  ];
  const raw = evalPoints.map((_, i) => ({ time: i }));

  const result = MapMatcher.match(evalPoints, raw, 50);

  for (const idx of [0, 1, 2, 3, 4]) {
    assert.strictEqual(
      result.get(idx).wayId,
      'MAIN',
      `point ${idx} should stay on MAIN despite fix 2's proximity to the disconnected decoy`,
    );
  }
});

test('match: a large time gap (> MAX_GAP_S) breaks the Markov chain instead of forcing a transition', () => {
  // Two clusters of points on two *unrelated*, far-apart, disconnected roads,
  // separated by a 100 s gap (> MAX_GAP_S=30). Each point should still snap
  // to its own nearby road (emission-only) rather than being dragged toward
  // consistency with the other cluster's road.
  const wayA = way('A', [
    { lat: 0, lon: 0 },
    { lat: 0, lon: 0.001 },
  ]);
  const wayB = way('B', [
    { lat: 1, lon: 1 },
    { lat: 1, lon: 1.001 },
  ]);

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
  const w = way('A', [
    { lat: 0, lon: 0 },
    { lat: 0, lon: 0.001 },
  ]);
  const evalPoints = [
    { idx: 0, lat: 0, lon: 0.0002, nearby: [w] },
    { idx: 1, lat: 9, lon: 9, nearby: [] }, // stranded far from any road
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
  const residential = way(
    'RES',
    [
      { lat: metersToLatDeg(9), lon: 0 },
      { lat: metersToLatDeg(9), lon: 0.001 },
    ],
    'residential',
  );
  const footway = way(
    'FOOT',
    [
      { lat: -metersToLatDeg(9), lon: 0 },
      { lat: -metersToLatDeg(9), lon: 0.001 },
    ],
    'footway',
  );
  const raw = [{ time: 0 }];
  const evalPoints = [
    { idx: 0, lat: 0, lon: 0.0005, nearby: [residential, footway] },
  ];

  const result = MapMatcher.match(evalPoints, raw, 50);
  assert.strictEqual(result.get(0).wayId, 'FOOT');
});

test('match: road-class penalty does NOT override a real distance difference in the final match', () => {
  // Companion to the tie-break test above: once the raw perpendicular
  // distances actually differ, _logEmit's pure-distance Gaussian dominates
  // and the closer road wins regardless of class, even though the farther
  // footway still sorts first in the effDist-ranked candidate list.
  const residential = way(
    'RES',
    [
      { lat: metersToLatDeg(2), lon: 0 },
      { lat: metersToLatDeg(2), lon: 0.001 },
    ],
    'residential',
  );
  const footway = way(
    'FOOT',
    [
      { lat: -metersToLatDeg(8), lon: 0 },
      { lat: -metersToLatDeg(8), lon: 0.001 },
    ],
    'footway',
  );
  const raw = [{ time: 0 }];
  const evalPoints = [
    { idx: 0, lat: 0, lon: 0.0005, nearby: [residential, footway] },
  ];

  const cands = MapMatcher._getCandidates(
    0,
    0.0005,
    [residential, footway],
    50,
    NaN,
    NaN,
  );
  assert.strictEqual(
    cands[0].wayId,
    'FOOT',
    'sanity check: the farther footway should still rank first by effDist',
  );

  const result = MapMatcher.match(evalPoints, raw, 50);
  assert.strictEqual(
    result.get(0).wayId,
    'RES',
    'the genuinely closer road should win the actual match despite ranking second',
  );
});

test('match: non-highway / malformed geometries in `nearby` are ignored, not crashed on', () => {
  const notAWay = { type: 'node', tags: {}, coordinates: [] };
  const noHighwayTag = {
    type: 'way',
    tags: {},
    coordinates: [
      { lat: 0, lon: 0 },
      { lat: 0, lon: 0.001 },
    ],
  };
  const tooFewCoords = way('SHORT', [{ lat: 0, lon: 0 }]);
  const w = way('OK', [
    { lat: 0, lon: 0 },
    { lat: 0, lon: 0.001 },
  ]);

  const raw = [{ time: 0 }];
  const evalPoints = [
    {
      idx: 0,
      lat: 0,
      lon: 0.0005,
      nearby: [notAWay, noHighwayTag, tooFewCoords, w],
    },
  ];

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
  const eastWest = way('EW', [
    { lat: 0, lon: -0.001 },
    { lat: 0, lon: 0.001 },
  ]);
  const northSouth = way('NS', [
    { lat: -0.001, lon: 0 },
    { lat: 0.001, lon: 0 },
  ]);
  const raw = [{ time: 0, speedKts: 5, course: 90 }]; // moving due east (~2.57 m/s, above SPEED_GATE)
  const evalPoints = [
    { idx: 0, lat: 0, lon: 0, nearby: [eastWest, northSouth] },
  ];

  const result = MapMatcher.match(evalPoints, raw, 50);
  assert.strictEqual(
    result.get(0).wayId,
    'EW',
    'heading-aware ranking should prefer the way aligned with travel direction',
  );
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

// ─── Path network (route distance between candidates) ─────────────────────

// A candidate on segment `segIdx` of `w`, snapped at (lat, lon).
function cand(w, segIdx, lat, lon) {
  return {
    wayId: w.id,
    coords: w.coordinates,
    segIdx,
    snapLat: lat,
    snapLon: lon,
    dist: 0,
  };
}
function routeDist(ways, c1, c2) {
  const graph = MapMatcher._buildGraph([ways.map((w) => cand(w, 0, 0, 0))]);
  return MapMatcher._routeDist(c1, c2, MapMatcher._routesFrom(graph, c1, 500));
}
const M = metersToLatDeg;

test('route: same way, forward and reverse distances agree', () => {
  const w = way('W', [
    { lat: 0, lon: 0 },
    { lat: M(10), lon: 0 },
    { lat: M(20), lon: 0 },
  ]);
  const c1 = cand(w, 0, M(5), 0);
  const c2 = cand(w, 1, M(15), 0);
  const fwd = routeDist([w], c1, c2);
  assert.ok(Math.abs(fwd - 10) < 0.05, `expected 10 m, got ${fwd}`);
  assert.ok(Math.abs(routeDist([w], c2, c1) - fwd) < 1e-6);
});

test('route: a path joining part-way along another way is connected there', () => {
  // SIDE starts at MAIN's middle node — a T-junction, not an end-to-end join.
  const main = way('MAIN', [
    { lat: 0, lon: 0 },
    { lat: M(20), lon: 0 },
    { lat: M(40), lon: 0 },
  ]);
  const side = way('SIDE', [
    { lat: M(20), lon: 0 },
    { lat: M(20), lon: M(30) },
  ]);
  const d = routeDist(
    [main, side],
    cand(main, 0, M(15), 0),
    cand(side, 0, M(20), M(5)),
  );
  assert.ok(
    Math.abs(d - 10) < 0.05,
    `expected 5 m to the junction + 5 m along, got ${d}`,
  );
});

test('route: on a closed way, crossing the shared end node is a short step, not a lap', () => {
  // A square loop about 111 m a side; first and last points are the same node.
  const loop = way('L', [
    { lat: 0, lon: 0 },
    { lat: 0, lon: 0.001 },
    { lat: 0.001, lon: 0.001 },
    { lat: 0.001, lon: 0 },
    { lat: 0, lon: 0 },
  ]);
  // 1 m before the end node on the last side, 1 m after it on the first.
  const d = routeDist([loop], cand(loop, 3, M(1), 0), cand(loop, 0, 0, M(1)));
  assert.ok(d < 3, `expected ~2 m across the end node, got ${d.toFixed(1)} m`);
});

test('route: unconnected ways have no route; a dangling end within JOIN_GAP_M is joined', () => {
  const a = way('A', [
    { lat: 0, lon: 0 },
    { lat: M(20), lon: 0 },
  ]);
  const far = way('FAR', [
    { lat: M(10), lon: M(30) },
    { lat: M(30), lon: M(30) },
  ]);
  assert.strictEqual(
    routeDist([a, far], cand(a, 0, M(10), 0), cand(far, 0, M(20), M(30))),
    Infinity,
  );
  const near = way('NEAR', [
    { lat: M(20), lon: M(3) }, // ends 3 m from A's end node, not on it
    { lat: M(20), lon: M(20) },
  ]);
  const d = routeDist(
    [a, near],
    cand(a, 0, M(10), 0),
    cand(near, 0, M(20), M(10)),
  );
  assert.ok(Math.abs(d - 20) < 0.1, `expected 10 + 3 + 7 m, got ${d}`);
});

test('step mismatch: zero when the snap moves with the walker, the GPS step when it stands still', () => {
  const w = way('W', [
    { lat: 0, lon: 0 },
    { lat: M(100), lon: 0 },
  ]);
  // Walker 5 m east of the road, walking north 4 m.
  const g1 = [M(10), M(5)];
  const g2 = [M(14), M(5)];
  const along = MapMatcher._stepMismatchM(
    cand(w, 0, M(10), 0),
    cand(w, 0, M(14), 0),
    ...g1,
    ...g2,
  );
  assert.ok(along < 0.01, `parallel step should cost nothing, got ${along}`);
  const stuck = MapMatcher._stepMismatchM(
    cand(w, 0, M(10), 0),
    cand(w, 0, M(10), 0),
    ...g1,
    ...g2,
  );
  assert.ok(
    Math.abs(stuck - 4) < 0.01,
    `a snap left behind should cost the 4 m step, got ${stuck}`,
  );
  const back = MapMatcher._stepMismatchM(
    cand(w, 0, M(10), 0),
    cand(w, 0, M(6), 0),
    ...g1,
    ...g2,
  );
  assert.ok(
    Math.abs(back - 8) < 0.01,
    `a snap stepping back should cost 8 m, got ${back}`,
  );
});

test('match: a walker crossing a street on a crossing that joins the pavements part-way along follows the crossing', () => {
  // Two pavements running north, 12 m apart; a crossing joins them at a
  // middle node of each.  The walker comes north up the west pavement,
  // crosses on the crossing, and carries on up the east pavement.
  const west = way(
    'WEST',
    [
      { lat: 0, lon: 0 },
      { lat: M(30), lon: 0 },
      { lat: M(60), lon: 0 },
    ],
    'footway',
  );
  const east = way(
    'EAST',
    [
      { lat: 0, lon: M(12) },
      { lat: M(30), lon: M(12) },
      { lat: M(60), lon: M(12) },
    ],
    'footway',
  );
  const crossing = way(
    'X',
    [
      { lat: M(30), lon: 0 },
      { lat: M(30), lon: M(12) },
    ],
    'footway',
  );
  const nearby = [west, east, crossing];
  const track = [
    [10, 0.5],
    [16, 0.5],
    [22, 0.5],
    [28, 0.5],
    [30.5, 3],
    [30.5, 6],
    [30.5, 9],
    [32, 11.5],
    [38, 11.5],
    [44, 11.5],
    [50, 11.5],
  ];
  const evalPoints = track.map(([n, e], idx) => ({
    idx,
    lat: M(n),
    lon: M(e),
    nearby,
  }));
  const raw = evalPoints.map((_, i) => ({ time: i * 3 }));
  const result = MapMatcher.match(evalPoints, raw, 25);
  assert.deepStrictEqual(
    [4, 5, 6].map((i) => result.get(i).wayId),
    ['X', 'X', 'X'],
    'the fixes on the crossing should snap to the crossing',
  );
  assert.strictEqual(result.get(0).wayId, 'WEST');
  assert.strictEqual(result.get(10).wayId, 'EAST');
});

test('viterbi: a long gap breaks the chain only when the walker also moved far across it', () => {
  const w = way('W', [
    { lat: 0, lon: 0 },
    { lat: metersToLatDeg(200), lon: 0 },
  ]);
  const run = (northAfterGap) => {
    const pts = [10, 13, 16, northAfterGap];
    const evalPoints = pts.map((n, idx) => ({
      idx,
      lat: metersToLatDeg(n),
      lon: metersToLatDeg(1),
      nearby: [w],
    }));
    const raw = [0, 2, 4, 64].map((time) => ({ time })); // 60 s gap before the last
    const cands = MapMatcher._collectAllCandidates(evalPoints, raw, 25);
    const { B } = MapMatcher._viterbiForward(
      evalPoints,
      raw,
      cands,
      MapMatcher._buildGraph(cands),
    );
    return Array.from(B[3]).some((b) => b >= 0);
  };
  assert.ok(run(17), 'standing still for 60 s should keep the chain');
  assert.ok(!run(70), 'moving 54 m across a 60 s gap should break it');
});

test('match: passing a connected side-road junction on a steady heading does not detour onto the side road', () => {
  // Main road runs east, split at the junction (lon 0.0006); a side road
  // leaves the junction due north.  The walker keeps course 90° but one fix
  // (GPS drift) lands nearer the side road than the main road.  Without a
  // heading term the connected side road is a cheap detour.
  const mainA = way('MAIN_A', [
    { lat: 0, lon: 0 },
    { lat: 0, lon: 0.0006 },
  ]);
  const mainB = way('MAIN_B', [
    { lat: 0, lon: 0.0006 },
    { lat: 0, lon: 0.0012 },
  ]);
  const side = way('SIDE', [
    { lat: 0, lon: 0.0006 },
    { lat: metersToLatDeg(60), lon: 0.0006 },
  ]);
  const nearby = [mainA, mainB, side];
  const lat = metersToLatDeg(14); // walking a verge 14 m north of the main road
  const evalPoints = [
    0.0003, 0.0004, 0.0005, 0.000595, 0.0006, 0.000605, 0.0007, 0.0008, 0.0009,
  ].map((lon, idx) => ({ idx, lat, lon, nearby }));
  const raw = evalPoints.map((_, i) => ({
    time: i,
    speedKts: 2.5,
    course: 90,
  }));

  const result = MapMatcher.match(evalPoints, raw, 50);

  for (let idx = 0; idx < evalPoints.length; idx++) {
    assert.notStrictEqual(
      result.get(idx).wayId,
      'SIDE',
      `point ${idx} must not snap onto the side road`,
    );
  }
});

test('match: an acute (30°) Y-junction side road is not detoured onto either, at a steady heading', () => {
  // Side road leaves the junction at 30° to the walker's direction of travel
  // (roads are rarely 90°).  Fixes drift beside the side road for a few samples.
  const J = 0.0006;
  const mainA = way('MAIN_A', [
    { lat: 0, lon: 0 },
    { lat: 0, lon: J },
  ]);
  const mainB = way('MAIN_B', [
    { lat: 0, lon: J },
    { lat: 0, lon: 0.0012 },
  ]);
  const cosLat = 1; // test area is at the equator
  const len = 0.0005; // ≈ 55 m
  const ang = (30 * Math.PI) / 180;
  const side = way('SIDE', [
    { lat: 0, lon: J },
    { lat: len * Math.sin(ang), lon: J + (len * Math.cos(ang)) / cosLat },
  ]);
  const nearby = [mainA, mainB, side];
  // Walk east on a line 3 m north of the main road; near the junction that
  // line sits nearer the side road than the main road.
  const lat = metersToLatDeg(6);
  const evalPoints = [
    0.0003, 0.0004, 0.0005, 0.00062, 0.00065, 0.00068, 0.0007, 0.0008, 0.0009,
  ].map((lon, idx) => ({ idx, lat, lon, nearby }));
  const raw = evalPoints.map((_, i) => ({
    time: i,
    speedKts: 2.5,
    course: 90,
  }));
  const result = MapMatcher.match(evalPoints, raw, 50);
  for (let idx = 0; idx < evalPoints.length; idx++) {
    assert.notStrictEqual(result.get(idx).wayId, 'SIDE', `point ${idx}`);
  }
});

test('match: a reported near-zero speed suppresses the heading term even when fixes wander', () => {
  const main = way('MAIN', [
    { lat: 0, lon: 0 },
    { lat: 0, lon: 0.001 },
  ]);
  const nearby = [main];
  // ~8 m of stationary wander east–west; the road runs east–west so any
  // fake chord would align anyway — use a north–south wander instead.
  const evalPoints = [0, 1, 2, 3].map((i) => ({
    idx: i,
    lat: metersToLatDeg(i % 2 ? 4 : -4),
    lon: 0.0005,
    nearby,
  }));
  const raw = evalPoints.map((_, i) => ({ time: i, speedKts: 0, course: 0 }));
  const cands = MapMatcher._collectAllCandidates(evalPoints, raw, 50);
  for (const c of cands) {
    for (const cand of c) assert.ok(Number.isNaN(cand.bearingDiffRad));
  }
});

test('match: a real turn onto a short link road (only route to the next road) is kept, not stripped as a glitch', () => {
  // A runs east to the junction J; LINK leaves J due north for ~12 m; T then
  // continues east from the top of LINK.  A and T share no node: LINK is the
  // only way between them, so the walker genuinely turned onto it.
  const J = 0.0006;
  const topLat = metersToLatDeg(12);
  const A = way('A', [
    { lat: 0, lon: 0 },
    { lat: 0, lon: J },
  ]);
  const LINK = way('LINK', [
    { lat: 0, lon: J },
    { lat: topLat, lon: J },
  ]);
  const T = way('T', [
    { lat: topLat, lon: J },
    { lat: topLat, lon: 0.0012 },
  ]);
  const nearby = [A, LINK, T];
  const m = (x) => x / 111320; // metres → degrees (equator)
  const track = [];
  for (let x = 0; x < 67; x += 4) track.push({ lat: 0, lon: m(x) }); // east on A
  for (let y = 4; y < 12; y += 4) track.push({ lat: m(y), lon: J }); // north on LINK
  for (let x = 4; x <= 40; x += 4) track.push({ lat: topLat, lon: J + m(x) }); // east on T
  const evalPoints = track.map((p, idx) => ({ idx, ...p, nearby }));
  const raw = evalPoints.map((_, i) => ({
    time: i,
    speedKts: 2.5,
    course: NaN,
  }));

  const result = MapMatcher.match(evalPoints, raw, 50);
  const ways = evalPoints.map((p) => result.get(p.idx).wayId);
  assert.ok(ways.includes('LINK'), `LINK was stripped: ${ways.join(',')}`);
});
