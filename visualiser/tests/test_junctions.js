/**
 * Unit tests for junctions.mjs — junction graph + turn/straight classification.
 * Run: node --test tests/test_junctions.js
 */
const assert = require('node:assert');
const test = require('node:test');

const { Junctions } = require('../src/gps/junctions.mjs');

const m = (x) => x / 111320; // metres → degrees at the equator
const J = m(100);

function way(id, coordinates, tags = {}) {
  return {
    type: 'way',
    id,
    tags: { highway: 'residential', ...tags },
    coordinates,
  };
}

// Through road split at J (so J is a way end) + a side road going north.
const MAIN_W = way('MAIN_W', [
  { lat: 0, lon: 0 },
  { lat: 0, lon: J },
]);
const MAIN_E = way('MAIN_E', [
  { lat: 0, lon: J },
  { lat: 0, lon: m(200) },
]);
const SIDE = way('SIDE', [
  { lat: 0, lon: J },
  { lat: m(100), lon: J },
]);

function pts(list) {
  return list.map(([lat, lon, wayId], idx) => ({
    idx,
    time: idx,
    lat,
    lon,
    wayId,
  }));
}

test('classifyPassages: continuing east through a 3-way junction is "straight"', () => {
  const track = [];
  for (let x = 60; x <= 140; x += 4)
    track.push([0, m(x), x < 100 ? 'MAIN_W' : 'MAIN_E']);
  const out = Junctions.classifyPassages(pts(track), [MAIN_W, MAIN_E, SIDE]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].kind, 'choice');
  assert.strictEqual(out[0].degree, 3);
  assert.strictEqual(out[0].decision, 'straight');
});

test('classifyPassages: turning north onto the side road is "turn"', () => {
  const track = [];
  for (let x = 60; x < 100; x += 4) track.push([0, m(x), 'MAIN_W']);
  for (let y = 0; y <= 40; y += 4) track.push([m(y), J, 'SIDE']);
  const out = Junctions.classifyPassages(pts(track), [MAIN_W, MAIN_E, SIDE]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].decision, 'turn');
  assert.ok(
    Math.abs(out[0].turnAngleDeg + 90) < 15,
    `angle ${out[0].turnAngleDeg}`,
  );
  assert.strictEqual(out[0].outWay, 'SIDE');
});

test('classifyPassages: mid-way T-junction (side road ends on a vertex of the through way) is found', () => {
  const through = way('THRU', [
    { lat: 0, lon: 0 },
    { lat: 0, lon: J },
    { lat: 0, lon: m(200) },
  ]);
  const side = way('SIDE', [
    { lat: 0, lon: J },
    { lat: m(100), lon: J },
  ]);
  const track = [];
  for (let x = 60; x <= 140; x += 4) track.push([0, m(x), 'THRU']);
  const out = Junctions.classifyPassages(pts(track), [through, side]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].degree, 3);
  assert.strictEqual(out[0].decision, 'straight');
});

test('classifyPassages: a change of road character with no choice is kind "change"', () => {
  const road = way('ROAD', [
    { lat: 0, lon: 0 },
    { lat: 0, lon: J },
  ]);
  const path = way(
    'PATH',
    [
      { lat: 0, lon: J },
      { lat: 0, lon: m(200) },
    ],
    { highway: 'footway' },
  );
  const track = [];
  for (let x = 60; x <= 140; x += 4)
    track.push([0, m(x), x < 100 ? 'ROAD' : 'PATH']);
  const out = Junctions.classifyPassages(pts(track), [road, path]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].kind, 'change');
  assert.strictEqual(out[0].decision, 'straight');
});

test('classifyPassages: a plain way-split with identical character is not a junction', () => {
  const a = way('A', [
    { lat: 0, lon: 0 },
    { lat: 0, lon: J },
  ]);
  const b = way('B', [
    { lat: 0, lon: J },
    { lat: 0, lon: m(200) },
  ]);
  const track = [];
  for (let x = 60; x <= 140; x += 4) track.push([0, m(x), x < 100 ? 'A' : 'B']);
  assert.deepStrictEqual(Junctions.classifyPassages(pts(track), [a, b]), []);
});

test('classifyPassages: a track that starts/ends at the node has too little arm to classify', () => {
  const track = [
    [0, m(96), 'MAIN_W'],
    [0, J, 'MAIN_W'],
  ];
  assert.deepStrictEqual(
    Junctions.classifyPassages(pts(track), [MAIN_W, MAIN_E, SIDE]),
    [],
  );
});

test('classifyPassages: two visits to the same junction give two passages', () => {
  const track = [];
  for (let x = 60; x <= 140; x += 4)
    track.push([0, m(x), x < 100 ? 'MAIN_W' : 'MAIN_E']);
  for (let x = 140; x >= 60; x -= 4)
    track.push([0, m(x), x > 100 ? 'MAIN_E' : 'MAIN_W']);
  const out = Junctions.classifyPassages(pts(track), [MAIN_W, MAIN_E, SIDE]);
  assert.strictEqual(out.length, 2);
});

test('waysShareNode: true when a vertex coincides, false otherwise', () => {
  assert.ok(Junctions.waysShareNode(MAIN_W.coordinates, SIDE.coordinates));
  assert.ok(!Junctions.waysShareNode(MAIN_W.coordinates, [{ lat: 1, lon: 1 }]));
});

test('classifyPassages: snapped says turn but raw fixes ran straight → "ambiguous"', () => {
  const track = [];
  for (let x = 60; x < 100; x += 4) track.push([0, m(x), 'MAIN_W']);
  for (let y = 0; y <= 40; y += 4) track.push([m(y), J, 'SIDE']);
  const withRaw = pts(track).map((p) => ({
    ...p,
    rawLat: 0,
    rawLon: m(60 + p.idx * 4),
  })); // raw walks due east
  const out = Junctions.classifyPassages(withRaw, [MAIN_W, MAIN_E, SIDE]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].decision, 'ambiguous');
  assert.ok(Math.abs(out[0].rawTurnAngleDeg) < 15);
});

test('classifyPassages: walking back the way they came at a junction is "reverse", not "straight"', () => {
  const track = [];
  for (let x = 60; x <= 100; x += 4) track.push([0, m(x), 'MAIN_W']);
  for (let x = 96; x >= 60; x -= 4) track.push([0, m(x), 'MAIN_W']);
  const out = Junctions.classifyPassages(pts(track), [MAIN_W, MAIN_E, SIDE]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].decision, 'reverse');
});

test('classifyPassages: fixes far from their matched way (off the network) do not define a passage', () => {
  const track = [];
  for (let x = 60; x <= 140; x += 4)
    track.push([0, m(x), x < 100 ? 'MAIN_W' : 'MAIN_E']);
  const far = pts(track).map((p) => ({ ...p, dist: 35 }));
  assert.deepStrictEqual(
    Junctions.classifyPassages(far, [MAIN_W, MAIN_E, SIDE]),
    [],
  );
  const near = pts(track).map((p) => ({ ...p, dist: 3 }));
  assert.strictEqual(
    Junctions.classifyPassages(near, [MAIN_W, MAIN_E, SIDE]).length,
    1,
  );
});

test('classifyPassages: result does not depend on fix spacing (1.5 m raw vs 3 m thinned)', () => {
  const walk = (step) => {
    const track = [];
    for (let x = 60; x <= 140; x += step)
      track.push([0, m(x), x < 100 ? 'MAIN_W' : 'MAIN_E']);
    return Junctions.classifyPassages(pts(track), [MAIN_W, MAIN_E, SIDE]);
  };
  for (const step of [1.5, 3, 4.5]) {
    const out = walk(step);
    assert.strictEqual(out.length, 1, `step ${step}: ${out.length} passages`);
    assert.strictEqual(out[0].decision, 'straight');
  }
});

test('classifyPassages: two visits far apart stay two passages at any spacing', () => {
  const visit = (_x0, step) => {
    const t = [];
    for (let x = 60; x <= 140; x += step)
      t.push([0, m(x), x < 100 ? 'MAIN_W' : 'MAIN_E']);
    return t;
  };
  for (const step of [1.5, 3]) {
    const track = [...visit(0, step), ...visit(0, step).reverse()];
    const out = Junctions.classifyPassages(pts(track), [MAIN_W, MAIN_E, SIDE]);
    assert.strictEqual(out.length, 2, `step ${step}`);
  }
});

test('findControlPassages / includeControl: extracts mid-block control on long straight road away from junctions', () => {
  // Long east-west road from 0 to 300 m with vertices at J1 (100 m) and J2 (250 m).
  // Between 100 m and 250 m is a 150 m straight stretch.
  const SIDE1 = way('SIDE1', [
    { lat: 0, lon: m(100) },
    { lat: m(50), lon: m(100) },
  ]);
  const SIDE2 = way('SIDE2', [
    { lat: 0, lon: m(250) },
    { lat: m(50), lon: m(250) },
  ]);
  const LONG_RD = way('LONG_RD', [
    { lat: 0, lon: 0 },
    { lat: 0, lon: m(100) },
    { lat: 0, lon: m(250) },
    { lat: 0, lon: m(300) },
  ]);
  const track = [];
  for (let x = 0; x <= 300; x += 3) {
    track.push([0, m(x), 'LONG_RD']);
  }
  const juncOnly = Junctions.classifyPassages(pts(track), [
    LONG_RD,
    SIDE1,
    SIDE2,
  ]);
  assert.strictEqual(juncOnly.length, 2);
  assert.ok(juncOnly.every((p) => p.decision === 'straight'));

  const withControl = Junctions.classifyPassages(
    pts(track),
    [LONG_RD, SIDE1, SIDE2],
    {
      includeControl: true,
    },
  );
  const controls = withControl.filter((p) => p.decision === 'control');
  assert.ok(controls.length >= 1, `expected controls, got ${controls.length}`);
  assert.strictEqual(controls[0].kind, 'control');
  assert.strictEqual(controls[0].inWay, 'LONG_RD');
  assert.strictEqual(controls[0].outWay, 'LONG_RD');
  // Control must be at least 30 m away from both J1 (100 m) and J2 (250 m)
  for (const ctrl of controls) {
    const lonM = ctrl.lon * 111320;
    assert.ok(
      Math.abs(lonM - 100) >= 28 && Math.abs(lonM - 250) >= 28,
      `ctrl too close to node: ${lonM}`,
    );
  }
});

test('findControlPassages: road with close junctions (< 30 m) yields no control passages', () => {
  // Junctions at 50 m and 90 m (gap = 40 m < 2 * 30 m)
  const SIDE1 = way('SIDE1', [
    { lat: 0, lon: m(50) },
    { lat: m(50), lon: m(50) },
  ]);
  const SIDE2 = way('SIDE2', [
    { lat: 0, lon: m(90) },
    { lat: m(50), lon: m(90) },
  ]);
  const SHORT_RD = way('SHORT_RD', [
    { lat: 0, lon: 0 },
    { lat: 0, lon: m(50) },
    { lat: 0, lon: m(90) },
    { lat: 0, lon: m(140) },
  ]);
  const track = [];
  for (let x = 30; x <= 110; x += 3) track.push([0, m(x), 'SHORT_RD']);
  const controls = Junctions.findControlPassages(pts(track), [
    SHORT_RD,
    SIDE1,
    SIDE2,
  ]);
  assert.strictEqual(controls.length, 0);
});

test('nodeKey and waysShareNode: safely handle null, undefined and non-finite coordinates', () => {
  assert.strictEqual(Junctions.nodeKey(null, 10), '');
  assert.strictEqual(Junctions.nodeKey(NaN, 10), '');
  assert.strictEqual(Junctions.nodeKey(10, undefined), '');
  assert.strictEqual(Junctions.waysShareNode(null, []), false);
  assert.strictEqual(
    Junctions.waysShareNode([{}], [{ lat: 0, lon: 0 }]),
    false,
  );
  assert.strictEqual(
    Junctions.waysShareNode(
      [{ lat: 10.123456, lon: 20.123456 }],
      [{ lat: 10.123456, lon: 20.123456 }],
    ),
    true,
  );
});

test('classifyPassages: partial raw GPS without arm endpoint raw fixes retains confident classification', () => {
  const track = [];
  for (let x = 60; x <= 140; x += 4) {
    track.push([0, m(x), x < 100 ? 'MAIN_W' : 'MAIN_E']);
  }
  const testPts = pts(track);
  // Give only the junction fix a rawLat/rawLon, leaving arm endpoints undefined
  const juncIdx = testPts.findIndex((p) => Math.abs(p.lon - J) < 1e-6);
  assert.ok(juncIdx >= 0);
  testPts[juncIdx].rawLat = 0;
  testPts[juncIdx].rawLon = J;

  const out = Junctions.classifyPassages(testPts, [MAIN_W, MAIN_E, SIDE]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].decision, 'straight');
  assert.strictEqual(out[0].rawTurnAngleDeg, null);
});

test('classifyPassages: wide crossroads with multiple nodes within 15-20 m merge into a single junction', () => {
  // Multi-node crossroads: Node A at 100 m and Node B at 114 m (14 m apart)
  const W_IN = way('W_IN', [
    { lat: 0, lon: 0 },
    { lat: 0, lon: m(100) },
  ]);
  const W_MID = way('W_MID', [
    { lat: 0, lon: m(100) },
    { lat: 0, lon: m(114) },
  ]);
  const W_OUT = way('W_OUT', [
    { lat: 0, lon: m(114) },
    { lat: 0, lon: m(200) },
  ]);
  const SIDE_A = way('SIDE_A', [
    { lat: 0, lon: m(100) },
    { lat: m(50), lon: m(100) },
  ]);
  const SIDE_B = way('SIDE_B', [
    { lat: 0, lon: m(114) },
    { lat: m(50), lon: m(114) },
  ]);

  // Case 1: Walking straight through the entire crossroads
  const straightTrack = [];
  for (let x = 60; x <= 160; x += 3) {
    const wId = x < 100 ? 'W_IN' : x < 114 ? 'W_MID' : 'W_OUT';
    straightTrack.push([0, m(x), wId]);
  }
  const straightPassages = Junctions.classifyPassages(pts(straightTrack), [
    W_IN,
    W_MID,
    W_OUT,
    SIDE_A,
    SIDE_B,
  ]);
  // Must be consolidated into ONE junction, not 2 colliding passages
  assert.strictEqual(straightPassages.length, 1);
  assert.strictEqual(straightPassages[0].decision, 'straight');
  assert.strictEqual(straightPassages[0].mergedCount, 2);

  // Case 2: Turning onto the second arm (SIDE_B) after entering straight past SIDE_A
  const turnTrack = [];
  for (let x = 60; x < 100; x += 3) turnTrack.push([0, m(x), 'W_IN']);
  for (let x = 100; x <= 114; x += 3) turnTrack.push([0, m(x), 'W_MID']);
  for (let y = 3; y <= 50; y += 3) turnTrack.push([m(y), m(114), 'SIDE_B']);

  const turnPassages = Junctions.classifyPassages(pts(turnTrack), [
    W_IN,
    W_MID,
    W_OUT,
    SIDE_A,
    SIDE_B,
  ]);
  // The wide crossroads turn must be consolidated into a single 'turn'
  assert.strictEqual(turnPassages.length, 1);
  assert.strictEqual(turnPassages[0].decision, 'turn');
  assert.strictEqual(turnPassages[0].mergedCount, 2);
  assert.ok(
    Math.abs(turnPassages[0].turnAngleDeg + 90) < 15,
    `turnAngleDeg: ${turnPassages[0].turnAngleDeg}`,
  );

  // CRITICAL: Both straight and turn traversals must share the EXACT SAME cluster key!
  assert.strictEqual(
    straightPassages[0].key,
    turnPassages[0].key,
    'straight and turn walks through the same crossroads must share identical cluster keys for paired testing',
  );

  // CRITICAL: Time must anchor to the entrance of the crossroads cluster
  const enterIdx = straightTrack.reduce(
    (best, p, idx) =>
      Math.abs(p[1] - m(100)) < Math.abs(straightTrack[best][1] - m(100))
        ? idx
        : best,
    0,
  );
  assert.strictEqual(
    straightPassages[0].time,
    enterIdx,
    'passage time must anchor to the entrance of the crossroads',
  );
});

test('classifyPassages: MAX_CLUSTER_SPAN_M prevents runaway chaining along closely spaced nodes', () => {
  // 4 nodes spaced 16 m apart along a 48 m street: N1 at 100m, N2 at 116m, N3 at 132m, N4 at 148m
  const WAYS = [
    way('W0', [
      { lat: 0, lon: 0 },
      { lat: 0, lon: m(100) },
    ]),
    way('W1', [
      { lat: 0, lon: m(100) },
      { lat: 0, lon: m(116) },
    ]),
    way('W2', [
      { lat: 0, lon: m(116) },
      { lat: 0, lon: m(132) },
    ]),
    way('W3', [
      { lat: 0, lon: m(132) },
      { lat: 0, lon: m(148) },
    ]),
    way('W4', [
      { lat: 0, lon: m(148) },
      { lat: 0, lon: m(250) },
    ]),
    way('S1', [
      { lat: 0, lon: m(100) },
      { lat: m(40), lon: m(100) },
    ]),
    way('S2', [
      { lat: 0, lon: m(116) },
      { lat: m(40), lon: m(116) },
    ]),
    way('S3', [
      { lat: 0, lon: m(132) },
      { lat: m(40), lon: m(132) },
    ]),
    way('S4', [
      { lat: 0, lon: m(148) },
      { lat: m(40), lon: m(148) },
    ]),
  ];

  const track = [];
  for (let x = 60; x <= 180; x += 2) {
    const w =
      x < 100 ? 'W0' : x < 116 ? 'W1' : x < 132 ? 'W2' : x < 148 ? 'W3' : 'W4';
    track.push([0, m(x), w]);
  }

  const passages = Junctions.classifyPassages(pts(track), WAYS);
  // Without MAX_CLUSTER_SPAN_M, all 4 would chain into 1 single 48m mega-junction.
  // With MAX_CLUSTER_SPAN_M = 25m, it must split into multiple distinct clusters.
  assert.ok(
    passages.length >= 2,
    `expected at least 2 distinct clusters, got ${passages.length}`,
  );
  for (const p of passages) {
    assert.ok(
      (p.clusterSpanM ?? 0) <= Junctions.MAX_CLUSTER_SPAN_M,
      `cluster span ${p.clusterSpanM} exceeded MAX_CLUSTER_SPAN_M`,
    );
  }
});

test('buildIndex: NON_ROAD_HIGHWAY ways do not create fake junction nodes', () => {
  const road = way('ROAD', [
    { lat: 0, lon: 0 },
    { lat: 0, lon: m(100) },
  ]);
  const crossing = way(
    'CROSS',
    [
      { lat: 0, lon: m(50) },
      { lat: m(20), lon: m(50) },
    ],
    { highway: 'crossing' },
  );
  const busStop = way(
    'STOP',
    [
      { lat: 0, lon: m(70) },
      { lat: m(10), lon: m(70) },
    ],
    { highway: 'bus_stop' },
  );

  const { nodes } = Junctions.buildIndex([road, crossing, busStop]);
  // The road should have 0 junction nodes because crossing and bus_stop are ignored
  assert.strictEqual(nodes.size, 0);
});

test('buildIndex & classifyPassages: multi-node crossroads resolves inWay and outWay across cluster', () => {
  // Dual-node crossroads: Entry way W_IN meets LINK at N1 (lat: 0, lon: m(100)).
  // Exit way W_OUT meets LINK at N2 (lat: 0, lon: m(112)) — 12 m away (<= MERGE_M).
  const W_IN = way('W_IN', [
    { lat: 0, lon: 0 },
    { lat: 0, lon: m(100) },
  ]);
  const LINK = way('LINK', [
    { lat: 0, lon: m(100) },
    { lat: 0, lon: m(112) },
  ]);
  const W_OUT = way('W_OUT', [
    { lat: 0, lon: m(112) },
    { lat: 0, lon: m(200) },
  ]);
  // Side ways to make N1 and N2 degree >= 3
  const SIDE1 = way('SIDE1', [
    { lat: 0, lon: m(100) },
    { lat: m(40), lon: m(100) },
  ]);
  const SIDE2 = way('SIDE2', [
    { lat: 0, lon: m(112) },
    { lat: m(-40), lon: m(112) },
  ]);

  const { nodes } = Junctions.buildIndex([W_IN, LINK, W_OUT, SIDE1, SIDE2]);
  const n1 = nodes.get(Junctions.nodeKey(0, m(100)));
  const n2 = nodes.get(Junctions.nodeKey(0, m(112)));
  assert.ok(n1 && n2);
  // Both nodes belong to the same cluster
  assert.strictEqual(n1.clusterKey, n2.clusterKey);
  // Cluster ways include all ways across both nodes
  assert.ok(n1.clusterWays.has('W_IN') && n1.clusterWays.has('W_OUT'));

  // Walker walks from W_IN through LINK into W_OUT
  const track = [];
  for (let x = 60; x <= 160; x += 2) {
    const w = x < 100 ? 'W_IN' : x <= 112 ? 'LINK' : 'W_OUT';
    track.push([0, m(x), w]);
  }
  const passages = Junctions.classifyPassages(pts(track), [
    W_IN,
    LINK,
    W_OUT,
    SIDE1,
    SIDE2,
  ]);
  assert.strictEqual(passages.length, 1);
  const p = passages[0];
  assert.strictEqual(p.inWay, 'W_IN');
  assert.strictEqual(p.outWay, 'W_OUT');
  assert.strictEqual(p.mergedCount, 2);
  assert.strictEqual(p.decision, 'straight');
});

test('buildIndex: complete-linkage prevents runaway chaining along a single road', () => {
  // A single road with side-streets at 100m, 116m, 132m, 148m (16m apart).
  // Total span from first to last is 48m > MAX_CLUSTER_SPAN_M (25m).
  const ROAD = way('ROAD', [
    { lat: 0, lon: 0 },
    { lat: 0, lon: m(100) },
    { lat: 0, lon: m(116) },
    { lat: 0, lon: m(132) },
    { lat: 0, lon: m(148) },
    { lat: 0, lon: m(200) },
  ]);
  const S1 = way('S1', [
    { lat: 0, lon: m(100) },
    { lat: m(30), lon: m(100) },
  ]);
  const S2 = way('S2', [
    { lat: 0, lon: m(116) },
    { lat: m(30), lon: m(116) },
  ]);
  const S3 = way('S3', [
    { lat: 0, lon: m(132) },
    { lat: m(30), lon: m(132) },
  ]);
  const S4 = way('S4', [
    { lat: 0, lon: m(148) },
    { lat: m(30), lon: m(148) },
  ]);

  const { nodes } = Junctions.buildIndex([ROAD, S1, S2, S3, S4]);
  const k1 = Junctions.nodeKey(0, m(100));
  const k4 = Junctions.nodeKey(0, m(148));
  assert.notStrictEqual(
    nodes.get(k1).clusterKey,
    nodes.get(k4).clusterKey,
    'nodes separated by 48m must not share the same clusterKey',
  );
});

test('classifyPassages: cumulative turn across multi-node crossroads detects overall turn even if sub-nodes are below threshold', () => {
  // Road enters from West at bearing 90°
  // Node 1 at 100m, bends 25° towards Southeast (bearing 115°)
  // Node 2 at 114m, bends another 25° towards South-Southeast (bearing 140°)
  // Total turn = 50° >= TURN_MIN_DEG (40°).
  // Neither node individually exceeds TURN_MIN_DEG (25° <= STRAIGHT_MAX_DEG),
  // but overall trajectory through the crossroads is 50° (a definite turn).
  const rad = (deg) => (deg * Math.PI) / 180;
  const W_IN = way('W_IN', [
    { lat: 0, lon: 0 },
    { lat: 0, lon: m(100) },
  ]);
  const pN1 = { lat: 0, lon: m(100) };
  const dX1 = 14 * Math.sin(rad(115));
  const dY1 = 14 * Math.cos(rad(115));
  const pN2 = { lat: m(dY1), lon: m(100) + m(dX1) };

  const W_MID = way('W_MID', [pN1, pN2]);

  const dX2 = 30 * Math.sin(rad(140));
  const dY2 = 30 * Math.cos(rad(140));
  const pEnd = { lat: pN2.lat + m(dY2), lon: pN2.lon + m(dX2) };
  const W_OUT = way('W_OUT', [pN2, pEnd]);

  // Side ways to make both nodes degree >= 3
  const S1 = way('S1', [pN1, { lat: m(40), lon: m(100) }]);
  const S2 = way('S2', [pN2, { lat: pN2.lat + m(40), lon: pN2.lon }]);

  const track = [];
  // Approach on W_IN (30m)
  for (let x = 70; x <= 100; x += 2) track.push([0, m(x), 'W_IN']);
  // Cross W_MID
  track.push([m(dY1 * 0.5), m(100) + m(dX1 * 0.5), 'W_MID']);
  track.push([pN2.lat, pN2.lon, 'W_MID']);
  // Exit on W_OUT (30m)
  for (let f = 0.2; f <= 1.0; f += 0.1) {
    track.push([pN2.lat + m(dY2 * f), pN2.lon + m(dX2 * f), 'W_OUT']);
  }

  const passages = Junctions.classifyPassages(pts(track), [
    W_IN,
    W_MID,
    W_OUT,
    S1,
    S2,
  ]);
  assert.strictEqual(passages.length, 1);
  const p = passages[0];
  assert.strictEqual(p.decision, 'turn');
  assert.ok(
    Math.abs(p.turnAngleDeg - 50) < 5,
    `expected turnAngleDeg ~ 50°, got ${p.turnAngleDeg}`,
  );
});

test('classifyPassages: carrying straight across a staggered crossroads is "straight", not a turn from the jog between nodes', () => {
  const MAIN = way('MAIN', [
    { lat: 0, lon: 0 },
    { lat: 0, lon: m(100) },
    { lat: 0, lon: m(112) },
    { lat: 0, lon: m(220) },
  ]);
  const N = way('N', [
    { lat: m(150), lon: m(100) },
    { lat: 0, lon: m(100) },
  ]);
  const S = way('S', [
    { lat: 0, lon: m(112) },
    { lat: m(-150), lon: m(112) },
  ]);
  const track = [];
  for (let y = -60; y < 0; y += 3) track.push([m(y), m(112), 'S']);
  for (let x = 112; x > 100; x -= 3) track.push([0, m(x), 'MAIN']);
  for (let y = 0; y <= 60; y += 3) track.push([m(y), m(100), 'N']);
  const out = Junctions.classifyPassages(
    track.map(([lat, lon, wayId], idx) => ({
      idx,
      time: idx * 2,
      lat,
      lon,
      wayId,
    })),
    [MAIN, N, S],
  );
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].mergedCount, 2);
  assert.strictEqual(out[0].decision, 'straight');
  assert.ok(Math.abs(out[0].turnAngleDeg) < 10);
});
