/**
 * Unit tests for arousal_places.js (GSRArousalPlaces.buildPlaces) — pure
 * dwell-normalised scoring of arousal-peak clusters, no DOM/Leaflet.
 *
 * Run: node --test tests/test_arousal_places.js  (or `npm test` for the whole suite)
 */

const assert = require('node:assert');
const test = require('node:test');

global.GeoUtils = require('../src/gps/geo_utils.mjs').GeoUtils;
const { GSRArousalPlaces } = require('../src/spatial/arousal_places.mjs');

const M_PER_DEG = 111320.0;
// Most tests care about scoring, not the noise filter — keep minMembers low and
// the cap high so a 1-member synthetic cluster still produces a place. The
// filter and cap have their own dedicated tests below with explicit opts.
const OPTS = {
  mergeM: 35,
  footprintPadM: 10,
  dwellFloorS: 5,
  provisionalMaxTracks: 1,
  minMembers: 1,
  maxPlaces: 50,
};
const NEAR = 8 / M_PER_DEG; // ~8 m from origin — inside the footprint
const FAR = 200 / M_PER_DEG; // ~200 m — well outside

// A 1 Hz track: raw[i] and phasic[i] are sample-aligned, dt = 1 s.
function track(id, samples) {
  return {
    id,
    sampleRate: 1,
    raw: samples.map((s) => ({
      time: s.t,
      lat: s.lat,
      lon: s.lon,
      hasGps: s.hasGps !== false,
      osm_road_class: s.road,
      osm_dist_green: s.green,
      osm_canopy_pct_50m: s.canopy,
    })),
    phasic: samples.map((s) => ({ time: s.t, val: s.ph || 0 })),
  };
}
function peak(trackId, dLat, dLon, amplitude, time) {
  return { lat: dLat, lon: dLon, amplitude, trackId, time };
}

// ─────────────────────────────────────────────────────────────────────────

test('buildPlaces: empty / non-array clusters return []', () => {
  assert.deepStrictEqual(GSRArousalPlaces.buildPlaces([], [], OPTS), []);
  assert.deepStrictEqual(GSRArousalPlaces.buildPlaces(null, [], OPTS), []);
});

test('buildPlaces: single-track place — dwell, energy and rate from in-footprint samples', () => {
  const t = track('A', [
    { t: 0, lat: FAR, lon: 0, ph: 5 },
    { t: 1, lat: NEAR, lon: 0, ph: 1 },
    { t: 2, lat: 0, lon: NEAR, ph: 1 },
    { t: 3, lat: NEAR, lon: NEAR, ph: 1 },
    { t: 4, lat: FAR, lon: FAR, ph: 5 },
  ]);
  const clusters = [
    [
      peak('A', NEAR, 0, 0.4, 1),
      peak('A', 0, NEAR, 0.2, 2),
      peak('A', NEAR, NEAR, 0.6, 3),
    ],
  ];

  const [p] = GSRArousalPlaces.buildPlaces(clusters, [t], OPTS);
  assert.strictEqual(p.label, 'P1');
  assert.strictEqual(p.memberCount, 3);
  assert.strictEqual(p.trackCount, 1);
  assert.deepStrictEqual(p.trackIds, ['A']);
  assert.ok(Math.abs(p.dwellSeconds - 3) < 1e-9, `dwell ${p.dwellSeconds}`);
  assert.ok(Math.abs(p.energy - 3) < 1e-9, `energy ${p.energy}`);
  assert.ok(Math.abs(p.rate - (3 / 5) * 60) < 1e-9, `rate ${p.rate}`); // dwell 3 < floor 5
  assert.ok(Math.abs(p.meanAmp - 0.4) < 1e-9);
  assert.ok(Math.abs(p.maxAmp - 0.6) < 1e-9);
  assert.strictEqual(p.firstTime, 1);
  assert.strictEqual(p.provisional, true);
});

test('buildPlaces: an elongated cluster still gets non-zero dwell (regression: the P48 monster)', () => {
  // Members strung over ~160 m along a line; the walk follows that same line.
  // A footprint circle around the cluster CENTROID would sit off the middle of
  // the line and catch few/no samples — the union-of-member-footprints does not.
  const members = [];
  const samples = [];
  for (let i = 0; i < 9; i++) {
    const dLat = (i * 20) / M_PER_DEG; // 0..160 m
    members.push(peak('A', dLat, 0, 0.3, i));
    samples.push({ t: i, lat: dLat, lon: 0, ph: 1 });
  }
  const [p] = GSRArousalPlaces.buildPlaces(
    [members],
    [track('A', samples)],
    OPTS,
  );
  assert.ok(
    p.dwellSeconds >= 8,
    `expected ~9 s dwell along the line, got ${p.dwellSeconds}`,
  );
  assert.ok(p.energy >= 8, `expected ~9 µS·s energy, got ${p.energy}`);
  assert.ok(p.rate > 0);
});

test('buildPlaces: negative phasic does not subtract from energy (rectified)', () => {
  const t = track('A', [
    { t: 0, lat: NEAR, lon: 0, ph: 2 },
    { t: 1, lat: NEAR, lon: 0, ph: -9 },
    { t: 2, lat: NEAR, lon: 0, ph: 1 },
  ]);
  const [p] = GSRArousalPlaces.buildPlaces(
    [[peak('A', NEAR, 0, 0.3, 0)]],
    [t],
    OPTS,
  );
  assert.ok(Math.abs(p.energy - 3) < 1e-9, `energy ${p.energy}`);
  assert.ok(Math.abs(p.dwellSeconds - 3) < 1e-9);
});

test('buildPlaces: places are ranked by rate and relabelled P1..Pn', () => {
  const OTHER = 1000 / M_PER_DEG; // mild place well away from the hot one
  const dwellSamples = (n, lat) =>
    Array.from({ length: n }, (_, i) => ({ t: i, lat, lon: 0, ph: 1 }));
  const tHot = track('H', dwellSamples(6, NEAR)); // energy 6, dwell 6 -> rate 60
  const tMild = track('M', dwellSamples(20, OTHER));
  tMild.phasic = tMild.phasic.map((d, i) => ({
    time: d.time,
    val: i < 2 ? 1 : 0,
  })); // energy 2, dwell 20 -> rate 6

  const clusters = [
    [peak('M', OTHER, 0, 0.1, 0)],
    [peak('H', NEAR, 0, 0.1, 0)],
  ];
  const places = GSRArousalPlaces.buildPlaces(clusters, [tHot, tMild], OPTS);
  assert.strictEqual(places[0].label, 'P1');
  assert.strictEqual(places[0].trackIds[0], 'H');
  assert.strictEqual(places[1].label, 'P2');
  assert.ok(places[0].rate > places[1].rate);
});

test('buildPlaces: a place more walks agree on outranks a slightly stronger one-walk place', () => {
  const dwell = (id, lat, n, ph) =>
    track(
      id,
      Array.from({ length: n }, (_, i) => ({ t: i, lat, lon: 0, ph })),
    );
  const SOLO = 1000 / M_PER_DEG; // far from the shared place
  const tSolo = dwell('S', SOLO, 10, 1); // rate 60
  const tA = dwell('A', NEAR, 10, 0.8); // shared place: rate 48
  const tB = dwell('B', NEAR, 10, 0.8);
  const clusters = [
    [peak('S', SOLO, 0, 0.1, 0)],
    [peak('A', NEAR, 0, 0.1, 0), peak('B', NEAR, 0, 0.1, 0)],
  ];
  const tracks = [tSolo, tA, tB];

  const boosted = GSRArousalPlaces.buildPlaces(clusters, tracks, OPTS);
  assert.strictEqual(boosted[0].trackCount, 2); // 48 * sqrt(2) ≈ 68 > 60
  assert.ok(boosted[0].rate < boosted[1].rate); // rate itself is untouched
  assert.ok(Math.abs(boosted[0].rankScore - 48 * Math.SQRT2) < 1e-9);

  const plain = GSRArousalPlaces.buildPlaces(clusters, tracks, {
    ...OPTS,
    walkRankExponent: 0,
  });
  assert.strictEqual(plain[0].trackCount, 1); // exponent 0 = rank by rate alone
});

test('buildPlaces: a calm walk through a place counts as a visit and dilutes its rate', () => {
  const dwell = (id, n, ph) =>
    track(
      id,
      Array.from({ length: n }, (_, i) => ({ t: i, lat: NEAR, lon: 0, ph })),
    );
  const tA = dwell('A', 10, 1); // reacted: energy 10, dwell 10
  const tCalm = dwell('C', 10, 0); // passed calmly: energy 0, dwell 10
  const [p] = GSRArousalPlaces.buildPlaces(
    [[peak('A', NEAR, 0, 0.1, 0)]],
    [tA, tCalm],
    OPTS,
  );
  assert.strictEqual(p.trackCount, 1);
  assert.strictEqual(p.visitCount, 2);
  assert.ok(Math.abs(p.dwellSeconds - 20) < 1e-9);
  assert.ok(Math.abs(p.rate - (10 / 20) * 60) < 1e-9, `rate ${p.rate}`);
});

test('buildPlaces: a brief edge-clip shorter than minVisitS is not a visit', () => {
  const tA = track(
    'A',
    Array.from({ length: 10 }, (_, i) => ({ t: i, lat: NEAR, lon: 0, ph: 1 })),
  );
  const tClip = track('C', [
    { t: 0, lat: NEAR, lon: 0, ph: 0 },
    { t: 1, lat: NEAR, lon: 0, ph: 0 }, // 2 s inside, under the 3 s bar
    { t: 2, lat: FAR, lon: 0, ph: 0 },
  ]);
  const [p] = GSRArousalPlaces.buildPlaces(
    [[peak('A', NEAR, 0, 0.1, 0)]],
    [tA, tClip],
    { ...OPTS, minVisitS: 3 },
  );
  assert.strictEqual(p.visitCount, 1);
  assert.ok(Math.abs(p.dwellSeconds - 10) < 1e-9);
});

test('buildPlaces: 2 of 2 walks reacting outranks 2 of 6', () => {
  const OTHER = 1000 / M_PER_DEG;
  const dwell = (id, lat, ph) =>
    track(
      id,
      Array.from({ length: 10 }, (_, i) => ({ t: i, lat, lon: 0, ph })),
    );
  const tracks = [
    dwell('A', NEAR, 1), // place X: both walks that went there reacted
    dwell('B', NEAR, 1),
    dwell('C', OTHER, 1), // place Y: 2 of 6 walks reacted
    dwell('D', OTHER, 1),
    dwell('E', OTHER, 0),
    dwell('F', OTHER, 0),
    dwell('G', OTHER, 0),
    dwell('H', OTHER, 0),
  ];
  const clusters = [
    [peak('C', OTHER, 0, 0.1, 0), peak('D', OTHER, 0, 0.1, 0)],
    [peak('A', NEAR, 0, 0.1, 0), peak('B', NEAR, 0, 0.1, 0)],
  ];
  const places = GSRArousalPlaces.buildPlaces(clusters, tracks, OPTS);
  assert.deepStrictEqual(places[0].trackIds.slice().sort(), ['A', 'B']);
  assert.strictEqual(places[0].visitCount, 2);
  assert.strictEqual(places[1].visitCount, 6);
  assert.ok(places[0].rankScore > places[1].rankScore);
});

test('buildPlaces: minWalks drops places fewer walks peaked at', () => {
  const OTHER = 1000 / M_PER_DEG;
  const dwell = (id, lat) =>
    track(
      id,
      Array.from({ length: 10 }, (_, i) => ({ t: i, lat, lon: 0, ph: 1 })),
    );
  const tracks = [dwell('A', NEAR), dwell('B', NEAR), dwell('C', OTHER)];
  const clusters = [
    [peak('A', NEAR, 0, 0.1, 0), peak('B', NEAR, 0, 0.1, 0)],
    [peak('C', OTHER, 0, 0.1, 0)], // one walk only
  ];
  assert.strictEqual(
    GSRArousalPlaces.buildPlaces(clusters, tracks, OPTS).length,
    2,
  );
  const places = GSRArousalPlaces.buildPlaces(clusters, tracks, {
    ...OPTS,
    minWalks: 2,
  });
  assert.strictEqual(places.length, 1);
  assert.strictEqual(places[0].trackCount, 2);
  assert.strictEqual(
    GSRArousalPlaces.buildPlaces(clusters, tracks, { ...OPTS, minWalks: 3 })
      .length,
    0,
  );
});

test('buildPlaces: a cluster spanning two tracks sums dwell + energy and is not provisional', () => {
  const tA = track('A', [
    { t: 0, lat: NEAR, lon: 0, ph: 1 },
    { t: 1, lat: NEAR, lon: 0, ph: 1 },
  ]);
  const tB = track('B', [
    { t: 0, lat: 0, lon: NEAR, ph: 2 },
    { t: 1, lat: 0, lon: NEAR, ph: 2 },
    { t: 2, lat: 0, lon: NEAR, ph: 2 },
  ]);
  const clusters = [[peak('A', NEAR, 0, 0.3, 5), peak('B', 0, NEAR, 0.5, 2)]];
  const [p] = GSRArousalPlaces.buildPlaces(clusters, [tA, tB], OPTS);
  assert.strictEqual(p.trackCount, 2);
  assert.deepStrictEqual(p.trackIds.slice().sort(), ['A', 'B']);
  assert.strictEqual(p.provisional, false);
  assert.ok(Math.abs(p.dwellSeconds - 5) < 1e-9, `dwell ${p.dwellSeconds}`);
  assert.ok(Math.abs(p.energy - 8) < 1e-9, `energy ${p.energy}`);
  assert.strictEqual(p.firstTime, 2);
});

test('buildPlaces: OSM context comes from the nearest enriched in-footprint sample', () => {
  const t = track('A', [
    {
      t: 0,
      lat: NEAR,
      lon: NEAR,
      ph: 1,
      road: 'residential',
      green: 99,
      canopy: 40,
    },
    {
      t: 1,
      lat: 1e-7,
      lon: 1e-7,
      ph: 1,
      road: 'primary',
      green: 42,
      canopy: 12,
    },
    { t: 2, lat: FAR, lon: 0, ph: 1, road: 'motorway', green: 0, canopy: 0 },
  ]);
  const [p] = GSRArousalPlaces.buildPlaces(
    [[peak('A', 0, 0, 0.3, 0)]],
    [t],
    OPTS,
  );
  assert.ok(p.osm);
  assert.strictEqual(p.osm.roadClass, 'primary');
  assert.strictEqual(p.osm.distGreen, 42);
  assert.strictEqual(p.osm.canopyPct, 12);
});

test('buildPlaces: no enrichment fields -> osm is null', () => {
  const t = track('A', [{ t: 0, lat: NEAR, lon: 0, ph: 1 }]);
  const [p] = GSRArousalPlaces.buildPlaces(
    [[peak('A', NEAR, 0, 0.3, 0)]],
    [t],
    OPTS,
  );
  assert.strictEqual(p.osm, null);
});

test('buildPlaces: samples with hasGps === false are excluded from dwell', () => {
  const t = track('A', [
    { t: 0, lat: NEAR, lon: 0, ph: 1, hasGps: false },
    { t: 1, lat: NEAR, lon: 0, ph: 1 },
  ]);
  const [p] = GSRArousalPlaces.buildPlaces(
    [[peak('A', NEAR, 0, 0.3, 0)]],
    [t],
    OPTS,
  );
  assert.ok(Math.abs(p.dwellSeconds - 1) < 1e-9, `dwell ${p.dwellSeconds}`);
  assert.ok(Math.abs(p.energy - 1) < 1e-9);
});

test('buildPlaces: a cluster whose track has no samples still yields a record (zero dwell/energy)', () => {
  const [p] = GSRArousalPlaces.buildPlaces(
    [[peak('A', 0, 0, 0.3, 0)]],
    [],
    OPTS,
  );
  assert.strictEqual(p.label, 'P1');
  assert.strictEqual(p.dwellSeconds, 0);
  assert.strictEqual(p.energy, 0);
  assert.strictEqual(p.rate, 0);
});

// ─── noise filter + cap ──────────────────────────────────────────────────

test('buildPlaces: single-walk clusters below minMembers are dropped; multi-walk small ones are kept', () => {
  const t = track(
    'A',
    Array.from({ length: 5 }, (_, i) => ({ t: i, lat: NEAR, lon: 0, ph: 1 })),
  );
  const tB = track(
    'B',
    Array.from({ length: 5 }, (_, i) => ({ t: i, lat: 0, lon: NEAR, ph: 1 })),
  );
  const opts = { ...OPTS, minMembers: 3 };

  const speck = [peak('A', NEAR, 0, 0.3, 0), peak('A', NEAR, 0, 0.3, 1)]; // 2 members, 1 walk -> dropped
  const agreed = [peak('A', 0, NEAR, 0.3, 0), peak('B', 0, NEAR, 0.3, 1)]; // 2 members, 2 walks -> kept
  const big = [
    peak('A', NEAR, 0, 0.3, 0),
    peak('A', NEAR, 0, 0.3, 1),
    peak('A', NEAR, 0, 0.3, 2),
  ]; // 3 members -> kept

  const places = GSRArousalPlaces.buildPlaces(
    [speck, agreed, big],
    [t, tB],
    opts,
  );
  assert.strictEqual(places.length, 2);
  assert.ok(places.every((p) => p.memberCount >= 3 || p.trackCount >= 2));
});

test('buildPlaces: output is capped to maxPlaces, keeping the highest-rate ones', () => {
  const t = track(
    'A',
    Array.from({ length: 30 }, (_, i) => ({ t: i, lat: NEAR, lon: 0, ph: 1 })),
  );
  const opts = { ...OPTS, minMembers: 1, maxPlaces: 5 };
  // 12 identical 1-member clusters -> all same rate; cap still applies.
  const clusters = Array.from({ length: 12 }, () => [
    peak('A', NEAR, 0, 0.3, 0),
  ]);
  const places = GSRArousalPlaces.buildPlaces(clusters, [t], opts);
  assert.strictEqual(places.length, 5);
  assert.deepStrictEqual(
    places.map((p) => p.label),
    ['P1', 'P2', 'P3', 'P4', 'P5'],
  );
});
