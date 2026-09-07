'use strict';
/**
 * Regression coverage for rAF-coalesced mouseDragged() in sketch.js.
 *
 * Verifies that high-frequency mouseDragged() invocations (e.g. 10 consecutive ticks
 * within a single animation frame):
 * 1. Synchronously update AppState.viewStartTime to reflect the latest drag delta.
 * 2. Schedule exactly one coalesced redraw() via requestAnimationFrame rather than 10.
 *
 * Run: node --test tests/test_sketch_drag.js
 */

const assert = require('assert');
const test = require('node:test');
const { bootApp } = require('./support/boot_app.js');

function boot() {
  const { window, context } = bootApp();
  window.width = 800;
  window.height = 600;
  window.constrain = (val, low, high) => Math.min(Math.max(val, low), high);
  window.HTMLCanvasElement.prototype.getContext = () => ({ fillStyle: '', fillRect() {} });
  window.setup();
  return { window, context };
}

test('mouseDragged: coalesces multiple drag ticks into a single redraw per frame', (t, done) => {
  const { window } = boot();

  // Populate synthetic raw data
  const raw = [];
  for (let i = 0; i < 100; i++) raw.push({ time: i * 0.1, val: 5.0 });
  window.AppState.analyzer.raw = raw;
  window.AppState.totalDuration = 10.0;
  window.AppState.viewDuration = 4.0;
  window.AppState.viewStartTime = 0.0;

  // Track redraw() calls
  let redrawCount = 0;
  window.redraw = () => { redrawCount++; };

  // Simulate starting a drag on the graph
  window.AppState.isDragging = true;
  window.AppState.dragStartMouseX = 100;
  window.AppState.dragStartViewStart = 0.0;

  // Simulate 10 rapid drag ticks
  for (let step = 1; step <= 10; step++) {
    window.mouseX = 100 - step * 5;
    window.mouseDragged();
  }

  // viewStartTime should be updated synchronously on the latest tick
  assert.ok(window.AppState.viewStartTime > 0, 'viewStartTime updated synchronously');
  const expectedViewStart = window.AppState.viewStartTime;

  // redraw() should NOT have been called 10 times synchronously
  assert.strictEqual(redrawCount, 0, 'redraw was deferred to rAF, not called synchronously 10 times');

  // Once rAF fires, exactly one redraw should land
  window.requestAnimationFrame(() => {
    assert.strictEqual(redrawCount, 1, 'exactly 1 coalesced redraw executed');
    assert.strictEqual(window.AppState.viewStartTime, expectedViewStart, 'viewStartTime preserved');
    done();
  });
});

test('mouseDragged: handles timeline dragging coalescing', (t, done) => {
  const { window } = boot();

  const raw = [];
  for (let i = 0; i < 100; i++) raw.push({ time: i * 0.1, val: 5.0 });
  window.AppState.analyzer.raw = raw;
  window.AppState.totalDuration = 10.0;
  window.AppState.viewDuration = 2.0;
  window.AppState.viewStartTime = 0.0;

  let redrawCount = 0;
  window.redraw = () => { redrawCount++; };

  window.AppState.isDraggingTimeline = true;

  // Simulate 5 rapid timeline ticks
  for (let step = 1; step <= 5; step++) {
    window.mouseX = 150 + step * 10;
    window.mouseDragged();
  }

  assert.ok(window.AppState.viewStartTime > 0, 'viewStartTime updated synchronously');
  assert.strictEqual(redrawCount, 0, 'synchronous redraws skipped');

  window.requestAnimationFrame(() => {
    assert.strictEqual(redrawCount, 1, '1 coalesced timeline redraw executed');
    done();
  });
});
