'use strict';

const assert = require('assert');
const test   = require('node:test');

global.GSR_CONST = require('./mock_constants.js');
global.width = 1000;
global.height = 500;

// Mock p5.js drawing functions
const rectCalls = [];
global.rect = (x, y, w, h) => rectCalls.push({ x, y, w, h });
global.line = () => {};
global.noStroke = () => {};
global.stroke = () => {};
global.strokeWeight = () => {};
const fillCalls = [];
global.fill = (c) => fillCalls.push(c);
global.textAlign = () => {};
global.textSize = () => {};
global.textStyle = () => {};
global.text = () => {};
global.BOLD = 'bold';
global.NORMAL = 'normal';
global.LEFT = 'left';
global.TOP = 'top';

// Real MapColors — the NDVI bands must reuse the exact same LUT the map's
// 'ndvi_50m' path colouring uses (map_manager_path.js), not a second ramp.
const { MapColors } = require('../src/map/map_colors.js');
global.MapColors = MapColors;

const { GSRRenderer } = require('../src/render/renderer.js');

function makeAnalyzer(raw) {
  return {
    raw,
    findClosestIndex(t) {
      return Math.max(0, Math.min(raw.length - 1, Math.round(t * 10)));
    }
  };
}

test('_getNdviContextSegments: no NDVI data on the track -> empty, no crash', () => {
  const raw = [];
  for (let i = 0; i <= 20; i++) raw.push({ time: i * 0.1, val: 1.0 });
  const analyzer = makeAnalyzer(raw);
  const segments = GSRRenderer._getNdviContextSegments(analyzer);
  assert.deepStrictEqual(segments, []);
});

test('_getNdviContextSegments: constant NDVI collapses to a single segment (RLE)', () => {
  const raw = [];
  for (let i = 0; i <= 50; i++) raw.push({ time: i * 0.1, val: 1.0, ndvi_50m: 0.55 });
  const analyzer = makeAnalyzer(raw);
  const segments = GSRRenderer._getNdviContextSegments(analyzer);
  assert.strictEqual(segments.length, 1);
  assert.strictEqual(segments[0].tStart, 0);
  assert.strictEqual(segments[0].tEnd, 5.0);
});

test('_getNdviContextSegments: low vs high NDVI bucket into different, ordered colours', () => {
  const raw = [];
  // First half: bare/built (low NDVI). Second half: dense vegetation (high NDVI).
  for (let i = 0; i <= 50; i++) {
    const t = i * 0.1;
    raw.push({ time: t, val: 1.0, ndvi_50m: t < 2.5 ? 0.05 : 0.85 });
  }
  const analyzer = makeAnalyzer(raw);
  const segments = GSRRenderer._getNdviContextSegments(analyzer);
  assert.strictEqual(segments.length, 2, 'a clean step in NDVI should RLE into exactly two segments');
  assert.notStrictEqual(segments[0].cls.hsl, segments[1].cls.hsl);

  // Matches MapColors' own low->high NDVI ramp (barren tan -> lush green).
  const lut = MapColors.getColorLut('ndvi_50m', 0.05, 0.85);
  assert.strictEqual(segments[0].cls.hsl, lut[0]);
  assert.strictEqual(segments[1].cls.hsl, lut[lut.length - 1]);
});

test('_getNdviContextSegments: NaN gaps (unsampled / step-hold-before-first-fix) are skipped, not drawn', () => {
  const raw = [];
  for (let i = 0; i <= 10; i++) raw.push({ time: i * 0.1, val: 1.0, ndvi_50m: NaN });
  for (let i = 11; i <= 30; i++) raw.push({ time: i * 0.1, val: 1.0, ndvi_50m: 0.4 });
  const analyzer = makeAnalyzer(raw);
  const segments = GSRRenderer._getNdviContextSegments(analyzer);
  assert.strictEqual(segments.length, 1);
  assert.strictEqual(segments[0].tStart, 1.1);
});

test('drawNdviContextBands: renders one rect per segment in view, none when toggle data is absent', () => {
  rectCalls.length = 0;
  const raw = [];
  for (let i = 0; i <= 50; i++) {
    const t = i * 0.1;
    raw.push({ time: t, val: 1.0, ndvi_50m: t < 2.5 ? 0.05 : 0.85 });
  }
  global.AppState = { analyzer: makeAnalyzer(raw) };

  GSRRenderer.drawNdviContextBands(0, 5, 50, 400);
  assert.strictEqual(rectCalls.length, 2);
  rectCalls.forEach(r => {
    assert.strictEqual(r.y, 50);
    assert.strictEqual(r.h, 350);
    assert.ok(r.w > 0);
  });

  rectCalls.length = 0;
  global.AppState = { analyzer: null };
  GSRRenderer.drawNdviContextBands(0, 5, 50, 400);
  assert.strictEqual(rectCalls.length, 0);
});

test('_ndviColorAt: matches the bucket a band segment would use, null when no data', () => {
  const raw = [];
  for (let i = 0; i <= 50; i++) {
    const t = i * 0.1;
    raw.push({ time: t, val: 1.0, ndvi_50m: t < 2.5 ? 0.05 : 0.85 });
  }
  const analyzer = makeAnalyzer(raw);
  GSRRenderer._getNdviContextSegments(analyzer); // populate the range cache

  const low = GSRRenderer._ndviColorAt(analyzer, raw[0]);
  assert.ok(low);
  assert.strictEqual(low.value, 0.05);

  const high = GSRRenderer._ndviColorAt(analyzer, raw[40]);
  assert.ok(high);
  assert.strictEqual(high.value, 0.85);
  assert.notStrictEqual(low.color, high.color);

  assert.strictEqual(GSRRenderer._ndviColorAt(analyzer, { ndvi_50m: NaN }), null);
  assert.strictEqual(GSRRenderer._ndviColorAt(analyzer, null), null);
});
