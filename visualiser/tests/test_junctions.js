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
