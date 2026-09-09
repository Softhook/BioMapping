/**
 * GSRMapManager._concaveBlobFor() — the per-cluster memo over getConcaveBlob().
 *
 * The 70x70 KDE splat inside getConcaveBlob is the dominant cost of an Arousal
 * Places rebuild and was recomputed on every GSR-slider frame (the outer
 * fingerprint folds the full phasic array). The blob geometry depends only on
 * member positions + the clamped amplitude-vs-mean weight, so a tonic/LPF/
 * median-window drag — positions fixed, all amplitudes + the mean scaling
 * together — must reuse the cached ring.
 *
 * Run: node --test tests/test_arousal_places_blob_cache.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { bootApp } = require('./support/boot_app.js');

function setup() {
  const { window: w } = bootApp();
  w.setup();
  const mm = w.AppState.mapManager;
  const SC = w.GSRSpatialClustering;
  let calls = 0;
  const real = SC.getConcaveBlob;
  SC.getConcaveBlob = (...a) => { calls++; return real.apply(SC, a); };
  return { mm, restore: () => { SC.getConcaveBlob = real; }, calls: () => calls };
}

const members = [
  { lat: 51.5000, lon: -0.1200, amplitude: 0.030 },
  { lat: 51.5003, lon: -0.1201, amplitude: 0.050 },
  { lat: 51.5001, lon: -0.1198, amplitude: 0.040 },
];

test('_concaveBlobFor: identical inputs hit the memo (one KDE)', () => {
  const { mm, restore, calls } = setup();
  try {
    const a = mm._concaveBlobFor(members, 12, 18, 0.04);
    const b = mm._concaveBlobFor(members, 12, 18, 0.04);
    assert.strictEqual(calls(), 1, 'second call served from cache');
    assert.strictEqual(a, b, 'same ring reference');
  } finally { restore(); }
});

test('_concaveBlobFor: a tonic-drag-scale amplitude nudge stays in the same bucket → memo hit', () => {
  const { mm, restore, calls } = setup();
  try {
    mm._concaveBlobFor(members, 12, 18, 0.04);
    // every amplitude and the mean scaled by ~0.5 % — the amplitude/mean ratio
    // barely moves, so the 5 % bucket (and the key) holds.
    const nudged = members.map(m => ({ ...m, amplitude: m.amplitude * 1.005 }));
    mm._concaveBlobFor(nudged, 12, 18, 0.04 * 1.005);
    assert.strictEqual(calls(), 1, 'no recompute for a within-bucket ratio change');
  } finally { restore(); }
});

test('_concaveBlobFor: a real geometry change misses the memo', () => {
  const { mm, restore, calls } = setup();
  try {
    mm._concaveBlobFor(members, 12, 18, 0.04);
    const moved = members.map((m, i) => i === 0 ? { ...m, lat: m.lat + 0.002 } : m);
    mm._concaveBlobFor(moved, 12, 18, 0.04);          // a member moved
    assert.strictEqual(calls(), 2);
    mm._concaveBlobFor(members, 24, 18, 0.04);        // sigma changed
    assert.strictEqual(calls(), 3);
    const skewed = members.map(m => ({ ...m, amplitude: m.amplitude * 3 }));
    mm._concaveBlobFor(skewed, 12, 18, 0.04);         // ratio jumped several buckets
    assert.strictEqual(calls(), 4);
  } finally { restore(); }
});

test('_concaveBlobFor: cache is bounded at 256 entries', () => {
  const { mm, restore } = setup();
  try {
    for (let i = 0; i < 300; i++) {
      mm._concaveBlobFor([{ lat: 51.5 + i * 1e-4, lon: -0.12, amplitude: 0.03 }], 12, 18, 0.03);
    }
    assert.ok(mm._blobRingCache.size <= 256, `size ${mm._blobRingCache.size} <= 256`);
  } finally { restore(); }
});
