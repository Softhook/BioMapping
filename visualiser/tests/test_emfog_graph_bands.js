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

// Real MapColors — EM Fog bands must reuse the exact same blue->magenta LUT
// the map's 'em_fog' path colouring uses, not a second ramp. This is the
// same _getContinuousBandSegments/_drawContinuousBand/_continuousColorAt
// machinery NDVI uses (see test_ndvi_graph_bands.js) — this file exists to
// prove a *second* metric plugged into it correctly, not to re-test the
// shared machinery itself.
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

test('_getEmFogContextSegments: no EM Fog data on the track -> empty, no crash', () => {
  const raw = [];
  for (let i = 0; i <= 20; i++) raw.push({ time: i * 0.1, val: 1.0 });
  const analyzer = makeAnalyzer(raw);
  assert.deepStrictEqual(GSRRenderer._getEmFogContextSegments(analyzer), []);
});

test('_getEmFogContextSegments: low vs high EM Fog bucket into different, ordered colours matching MapColors', () => {
  const raw = [];
  for (let i = 0; i <= 50; i++) {
    const t = i * 0.1;
    raw.push({ time: t, val: 1.0, em_fog: t < 2.5 ? 5 : 90 });
  }
  const analyzer = makeAnalyzer(raw);
  const segments = GSRRenderer._getEmFogContextSegments(analyzer);
  assert.strictEqual(segments.length, 2);
  assert.notStrictEqual(segments[0].cls.hsl, segments[1].cls.hsl);

  const lut = MapColors.getColorLut('em_fog', 5, 90);
  assert.strictEqual(segments[0].cls.hsl, lut[0]);
  assert.strictEqual(segments[1].cls.hsl, lut[lut.length - 1]);
});

test('_getEmFogContextSegments and _getNdviContextSegments keep independent caches', () => {
  const rawNdvi = [];
  for (let i = 0; i <= 20; i++) rawNdvi.push({ time: i * 0.1, val: 1.0, ndvi_50m: 0.5 });
  const analyzer = makeAnalyzer(rawNdvi);

  const ndviSegs = GSRRenderer._getNdviContextSegments(analyzer);
  const emFogSegs = GSRRenderer._getEmFogContextSegments(analyzer); // no em_fog field at all
  assert.strictEqual(ndviSegs.length, 1, 'NDVI segments unaffected by EM Fog having no data');
  assert.deepStrictEqual(emFogSegs, []);
});

test('drawEmFogContextBands: renders one rect per segment in view, none when analyzer is absent', () => {
  rectCalls.length = 0;
  const raw = [];
  for (let i = 0; i <= 50; i++) {
    const t = i * 0.1;
    raw.push({ time: t, val: 1.0, em_fog: t < 2.5 ? 5 : 90 });
  }
  global.AppState = { analyzer: makeAnalyzer(raw) };

  GSRRenderer.drawEmFogContextBands(0, 5, 50, 400);
  assert.strictEqual(rectCalls.length, 2);

  rectCalls.length = 0;
  global.AppState = { analyzer: null };
  GSRRenderer.drawEmFogContextBands(0, 5, 50, 400);
  assert.strictEqual(rectCalls.length, 0);
});

test('_emFogColorAt: matches the bucket a band segment would use, null when no data', () => {
  const raw = [];
  for (let i = 0; i <= 50; i++) {
    const t = i * 0.1;
    raw.push({ time: t, val: 1.0, em_fog: t < 2.5 ? 5 : 90 });
  }
  const analyzer = makeAnalyzer(raw);

  const low = GSRRenderer._emFogColorAt(analyzer, raw[0]);
  assert.ok(low);
  assert.strictEqual(low.value, 5);

  const high = GSRRenderer._emFogColorAt(analyzer, raw[40]);
  assert.ok(high);
  assert.strictEqual(high.value, 90);
  assert.notStrictEqual(low.color, high.color);

  assert.strictEqual(GSRRenderer._emFogColorAt(analyzer, { em_fog: NaN }), null);
  assert.strictEqual(GSRRenderer._emFogColorAt(analyzer, null), null);
});
