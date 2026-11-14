/**
 * A park, wood or lake that OSM draws as several ways meeting end to end
 * (a multipolygon relation) must be read as the one area those ways enclose
 * together — not as a separate shape per piece.
 *
 * Run: node --test tests/test_osm_multipolygon_rings.js
 */

const assert = require('node:assert');
const test = require('node:test');

global.window = global;
const { OSMEnricher } = require('../src/osm/osm_enrichment.mjs');

// A square park about 220 m across, corners as nodes 1..4, plus an inner
// pond (nodes 11..14) about 44 m across in its middle.
const LAT = 51.5;
const LON = -0.1;
const D = 0.002;
const node = (id, lat, lon) => ({ type: 'node', id, lat, lon });
const NODES = [
  node(1, LAT, LON),
  node(2, LAT, LON + D),
  node(3, LAT + D, LON + D),
  node(4, LAT + D, LON),
  node(11, LAT + 0.0008, LON + 0.0008),
  node(12, LAT + 0.0008, LON + 0.0012),
  node(13, LAT + 0.0012, LON + 0.0012),
  node(14, LAT + 0.0012, LON + 0.0008),
];
const way = (id, nodes, tags) => ({ type: 'way', id, nodes, tags });
const park = (members) => ({
  type: 'relation',
  id: 900,
  tags: { type: 'multipolygon', leisure: 'park' },
  members,
});
const member = (ref, role = 'outer') => ({ type: 'way', ref, role });

function evaluate(elements, lat, lon) {
  const geoms = OSMEnricher.reconstructGeometries({ elements });
  const index = OSMEnricher.buildSpatialIndex(geoms);
  return {
    geoms,
    metrics: OSMEnricher._evaluatePosition(
      lat,
      lon,
      index.getNearby(lat, lon),
      50,
    ),
  };
}

// A point well inside the park but off its diagonals and outside the pond.
const INSIDE = [LAT + 0.0005, LON + 0.0014];
const OUTSIDE = [LAT - 0.001, LON + 0.001];

test('outer ring split into four one-sided ways: the point inside is in the park', () => {
  const { geoms, metrics } = evaluate(
    [
      ...NODES,
      way(101, [1, 2]),
      way(102, [2, 3]),
      way(103, [3, 4]),
      way(104, [4, 1]),
      park([member(101), member(102), member(103), member(104)]),
    ],
    ...INSIDE,
  );
  assert.strictEqual(geoms.relations[0].outerWays.length, 1, 'one ring');
  const ring = geoms.relations[0].outerWays[0];
  assert.strictEqual(ring.coordinates.length, 5, 'four corners, closed');
  assert.deepStrictEqual(ring.coordinates[0], ring.coordinates[4]);
  assert.strictEqual(metrics.inPark, 1);
  assert.strictEqual(metrics.distGreen, 0);
  // The 50 m buffer pokes a little way out over the park's east edge.
  assert.ok(metrics.greenSpacePct > 85, `green ${metrics.greenSpacePct}`);
});

test('pieces listed out of order and drawn in opposite directions still join', () => {
  const { geoms, metrics } = evaluate(
    [
      ...NODES,
      way(101, [1, 2]),
      way(102, [3, 2]), // reversed
      way(103, [3, 4]),
      way(104, [1, 4]), // reversed
      park([member(103), member(101), member(104), member(102)]),
    ],
    ...INSIDE,
  );
  assert.strictEqual(geoms.relations[0].outerWays.length, 1);
  assert.strictEqual(metrics.inPark, 1);
});

test('two L-shaped halves: a point outside the park is not in it', () => {
  const { metrics } = evaluate(
    [
      ...NODES,
      way(101, [1, 2, 3]),
      way(102, [3, 4, 1]),
      park([member(101), member(102)]),
    ],
    ...OUTSIDE,
  );
  assert.strictEqual(metrics.inPark, 0);
  assert.ok(metrics.distGreen > 100 && metrics.distGreen < 120);
});

test('a hole made of two pieces is still a hole', () => {
  const elements = [
    ...NODES,
    way(101, [1, 2, 3]),
    way(102, [3, 4, 1]),
    way(201, [11, 12, 13]),
    way(202, [13, 14, 11]),
    park([
      member(101),
      member(102),
      member(201, 'inner'),
      member(202, 'inner'),
    ]),
  ];
  const inPond = evaluate(elements, LAT + 0.0009, LON + 0.0011);
  assert.strictEqual(inPond.geoms.relations[0].innerWays.length, 1);
  assert.strictEqual(inPond.metrics.inPark, 0, 'in the hole');
  assert.strictEqual(evaluate(elements, ...INSIDE).metrics.inPark, 1);
});

test('ways that are already closed pass through as the same objects', () => {
  const closed = way(101, [1, 2, 3, 4, 1]);
  const { geoms } = evaluate(
    [...NODES, closed, park([member(101)])],
    ...INSIDE,
  );
  assert.strictEqual(geoms.relations[0].outerWays[0], closed);
});

test('two separate rings in one relation stay two rings', () => {
  const { geoms } = evaluate(
    [
      ...NODES,
      way(101, [1, 2, 3]),
      way(102, [3, 4, 1]),
      way(201, [11, 12, 13]),
      way(202, [13, 14, 11]),
      park([member(101), member(201), member(102), member(202)]),
    ],
    ...INSIDE,
  );
  assert.strictEqual(geoms.relations[0].outerWays.length, 2);
});

test('an incomplete chain is not treated as an enclosed park', () => {
  const { geoms, metrics } = evaluate(
    [
      ...NODES,
      way(101, [1, 2]),
      way(102, [2, 3]),
      park([member(101), member(102)]),
    ],
    LAT + 0.0005,
    LON + 0.0015,
  );
  assert.deepStrictEqual(geoms.relations[0].outerWays[0].nodes, [1, 2, 3]);
  assert.strictEqual(metrics.inPark, 0);
});

test('a tagged open member way does not create its own filled park', () => {
  const { metrics } = evaluate(
    [...NODES, way(101, [1, 2, 3], { leisure: 'park' }), park([member(101)])],
    LAT + 0.0005,
    LON + 0.0015,
  );
  assert.strictEqual(metrics.inPark, 0);
});

test('road distance uses the kerb even when the centre line is beyond the cap', () => {
  const east = 155 / (111320 * Math.cos((LAT * Math.PI) / 180));
  const road = way(10, [21, 22], { highway: 'primary', width: '20' });
  const { metrics } = evaluate(
    [
      node(21, LAT - 0.0001, LON + east),
      node(22, LAT + 0.0001, LON + east),
      road,
    ],
    LAT,
    LON,
  );
  assert.ok(Math.abs(metrics.distMajorRoad - 145) < 0.1);
});
