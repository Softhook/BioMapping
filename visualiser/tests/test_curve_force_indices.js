'use strict';

const assert = require('assert');
const test   = require('node:test');

global.GSR_CONST = require('./mock_constants.js');
global.width = 1000;
global.AppState = {
  analyzer: {
    findClosestIndex(t) {
      return Math.max(0, Math.round(t * 10));
    }
  }
};
const { GSRRenderer } = require('../src/render/renderer.js');

function legacySetSortMerge(startIdx, endIdx, step, forceIndices) {
  const forced = [];
  for (const idx of forceIndices) {
    if (idx >= startIdx && idx <= endIdx) forced.push(idx);
  }
  if (forced.length === 0) return null;
  const merged = new Set();
  for (let i = startIdx; i <= endIdx; i += step) merged.add(i);
  merged.add(endIdx);
  for (const idx of forced) merged.add(idx);
  return Array.from(merged).sort((a, b) => a - b);
}

test('two-pointer merge in _buildCurveContext matches legacy Set+sort across randomized viewports', () => {
  // Test 1000 randomized configurations with various steps, bounds, and forced indices
  for (let trial = 0; trial < 1000; trial++) {
    const startIdx = Math.floor(Math.random() * 500);
    const endIdx = startIdx + Math.floor(Math.random() * 3000) + 10;
    const step = Math.floor(Math.random() * 15) + 2; // step >= 2
    const numForced = Math.floor(Math.random() * 40);
    const forceIndices = [];
    for (let k = 0; k < numForced; k++) {
      // mix of visible, before, after, duplicates, and edge values
      forceIndices.push(Math.floor(Math.random() * (endIdx - startIdx + 100)) + startIdx - 50);
    }

    // Create synthetic series data
    const data = [];
    for (let i = 0; i <= endIdx + 10; i++) {
      data.push({ time: i * 0.1, val: 1.0 });
    }
    const tMin = data[startIdx].time;
    const tMax = data[endIdx].time;

    const ctx = GSRRenderer._buildCurveContext(data, tMin, tMax, 0, 10, 0, 100, forceIndices);
    const legacy = (ctx.step === 1) ? null : legacySetSortMerge(ctx.startIdx, ctx.endIdx, ctx.step, forceIndices);

    if (legacy === null) {
      assert.strictEqual(ctx.indices, null);
    } else {
      assert.ok(Array.isArray(ctx.indices), 'indices should be an array');
      assert.strictEqual(ctx.indices.length, legacy.length, `length mismatch at trial ${trial}`);
      for (let i = 0; i < legacy.length; i++) {
        assert.strictEqual(ctx.indices[i], legacy[i], `value mismatch at idx ${i}, trial ${trial}`);
      }
      // Strict monotonicity test
      for (let i = 1; i < ctx.indices.length; i++) {
        assert.ok(ctx.indices[i] > ctx.indices[i - 1], `not strictly monotonic at ${i}`);
      }
    }
  }
});

test('when step === 1 (fully zoomed in), indices is null to avoid redundant array generation', () => {
  const data = [];
  for (let i = 0; i < 50; i++) {
    data.push({ time: i * 0.1, val: 1.0 });
  }
  // With only 20 samples visible, count < DRAW_MAX_VERTICES so step is 1
  const ctx = GSRRenderer._buildCurveContext(data, 1.0, 2.0, 0, 5, 0, 100, [12, 15, 18]);
  assert.strictEqual(ctx.step, 1);
  assert.strictEqual(ctx.indices, null, 'step 1 does not need forced index merge since all samples are drawn');
});
