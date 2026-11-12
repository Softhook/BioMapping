/**
 * GSR graph wheel and press input (sketch.mjs mouseWheel / mousePressed) and
 * the 3D tours' hold on the graph cursor (globe3d_view.mjs _emitTourCursor,
 * renderer_interaction.mjs handleScrubber).
 *
 *  - A trackpad's stream of small wheel events zooms about as far as one
 *    mouse-wheel notch of the same travel, not once per event.
 *  - A sideways scroll moves the view along the walk; it never zooms.
 *  - Wheels and presses aimed at something covering the canvas (the map's
 *    full-screen overlay) leave the graph alone.
 *  - A tour's cursor survives the graph's own redraw while the pointer is
 *    off the graph, and is cleared when the tour stops.
 */
const test = require('node:test');
const assert = require('node:assert');
const { bootApp } = require('./support/boot_app.js');

const PLOT_LEFT = 60;

async function bootGraph() {
  const { window } = await bootApp();
  window.constrain = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  window.setup();
  const AppState = window.AppState;
  window.width = 1000;
  window.height = 300;
  AppState.yGraphBottom = 250;
  AppState.analyzer.raw = Array.from({ length: 4001 }, (_, i) => ({
    time: i,
    val: 1,
  }));
  AppState.totalDuration = 4000;
  AppState.viewDuration = 600;
  AppState.viewStartTime = 300;
  // Pointer in the middle of the plot.
  window.mouseX = 500;
  window.mouseY = 120;
  return { window, AppState, canvas: AppState.myCanvas.elt };
}

const wheel = (window, target, init) =>
  window.mouseWheel({ target, deltaX: 0, deltaY: 0, deltaMode: 0, ...init });

test('a trackpad scroll zooms about as far as one mouse notch of the same travel', async () => {
  const { window, AppState, canvas } = await bootGraph();

  wheel(window, canvas, { deltaY: -120 });
  const notch = AppState.viewDuration;

  AppState.viewDuration = 600;
  AppState.viewStartTime = 300;
  for (let i = 0; i < 30; i++) wheel(window, canvas, { deltaY: -4 });
  const trackpad = AppState.viewDuration;

  assert.ok(notch < 600 && notch > 450, `one notch zooms a little (${notch})`);
  assert.ok(
    Math.abs(trackpad - notch) < 1,
    `same travel, same zoom (${trackpad} vs ${notch})`,
  );
});

test('zooming in and back out by the same travel returns to the same view length', async () => {
  const { window, AppState, canvas } = await bootGraph();
  wheel(window, canvas, { deltaY: -100 });
  wheel(window, canvas, { deltaY: 100 });
  assert.ok(Math.abs(AppState.viewDuration - 600) < 1e-6);
});

test('one huge wheel event zooms at most one doubling', async () => {
  const { window, AppState, canvas } = await bootGraph();
  wheel(window, canvas, { deltaY: 100000 });
  assert.ok(Math.abs(AppState.viewDuration - 1200) < 1e-6);
});

test('a sideways scroll moves the view along the walk without zooming', async () => {
  const { window, AppState, canvas } = await bootGraph();
  const plotWidth = window.width - PLOT_LEFT - 40;
  wheel(window, canvas, { deltaX: 100 });
  assert.strictEqual(AppState.viewDuration, 600, 'no zoom');
  const moved = AppState.viewStartTime - 300;
  assert.ok(moved > 0, 'swiping right-to-left shows later in the walk');
  // Close to 100 px worth of the view (the plot margins aren't pinned here).
  assert.ok(Math.abs(moved - (100 * 600) / plotWidth) < 10, `moved ${moved}`);
});

test('a wheel with no movement does nothing', async () => {
  const { window, AppState, canvas } = await bootGraph();
  wheel(window, canvas, {});
  assert.strictEqual(AppState.viewDuration, 600);
  assert.strictEqual(AppState.viewStartTime, 300);
});

test('wheels and presses aimed at something covering the canvas leave the graph alone', async () => {
  const { window, AppState } = await bootGraph();
  const mapEl = window.document.getElementById('map');

  const result = wheel(window, mapEl, { deltaY: -300 });
  assert.strictEqual(AppState.viewDuration, 600);
  assert.notStrictEqual(result, false, "the map's own scroll isn't blocked");

  window.mousePressed({ target: mapEl });
  assert.strictEqual(AppState.isDragging, false, 'no hidden graph drag');

  window.mousePressed({ target: AppState.myCanvas.elt });
  assert.strictEqual(AppState.isDragging, true, 'a press on the graph drags');
});

// ── Tour cursor ─────────────────────────────────────────────────────────────

async function bootScrub() {
  const { window } = await bootApp();
  window.setup();
  const AppState = window.AppState;
  window.circle = window.circle || (() => {});
  window.width = 800;
  window.height = 400;
  const n = 20;
  const mk = () => Array.from({ length: n }, (_, i) => ({ time: i, val: 1 }));
  AppState.analyzer = {
    raw: Array.from({ length: n }, (_, i) => ({
      time: i,
      val: 1,
      hasGps: true,
      lat: 51 + i * 1e-4,
      lon: -0.1,
    })),
    filtered: mk(),
    tonic: mk(),
    phasic: mk(),
    peaks: [],
    sampleRate: 4,
    findClosestIndex: () => 3,
    placeOf: (i) => ({ lat: 51 + i * 1e-4, lon: -0.1 }),
    readingAt: (i) => i,
    formatClockTime: () => '',
  };
  const scrubs = [];
  AppState.on('scrub', (p) => scrubs.push(p));
  const scrubber = () =>
    window.GSRRenderer.handleScrubber(0, 19, 0, 1, 100, 0, 1, 110, 200);
  return { window, AppState, scrubs, scrubber };
}

test("a tour's graph cursor survives the graph redraw while the pointer is off the graph", async () => {
  const { window, AppState, scrubs, scrubber } = await bootScrub();
  window.document.elementFromPoint = () => window.document.body; // pointer elsewhere

  window.GSRGlobe3DView._emitTourCursor(51.0007, -0.1, 7);
  assert.strictEqual(AppState.hoveredIndex, 7);
  scrubs.length = 0;
  scrubber();

  assert.strictEqual(AppState.hoveredIndex, 7, 'cursor kept');
  assert.strictEqual(AppState.scrubSource, 'tour');
  assert.ok(!scrubs.some((p) => p?.clear), 'the maps are not told to clear');
});

test('pointing at the graph during a tour shows that moment instead', async () => {
  const { window, AppState, scrubber } = await bootScrub();
  window.GSRGlobe3DView._emitTourCursor(51.0007, -0.1, 7);
  window.document.elementFromPoint = () => AppState.myCanvas.elt;
  window.mouseX = 300;
  window.mouseY = 150;
  scrubber();
  assert.strictEqual(AppState.hoveredIndex, 3, 'the hovered reading');
  assert.strictEqual(AppState.scrubSource, 'graph');
});

test('without a tour, the graph still clears its cursor when the pointer leaves', async () => {
  const { window, AppState, scrubs, scrubber } = await bootScrub();
  window.document.elementFromPoint = () => window.document.body;
  AppState.hoveredIndex = 5;
  AppState.scrubSource = 'graph';
  scrubber();
  assert.strictEqual(AppState.hoveredIndex, -1);
  assert.ok(scrubs.some((p) => p?.clear));
});

test('stopping either tour takes its cursor off the graph and maps', async () => {
  const { window, AppState, scrubs } = await bootScrub();
  const V = window.GSRGlobe3DView;

  V._emitTourCursor(51.0007, -0.1, 7);
  scrubs.length = 0;
  V._onReplayTourProgress(null);
  assert.strictEqual(AppState.scrubSource, null);
  assert.strictEqual(AppState.hoveredIndex, -1);
  assert.ok(scrubs.some((p) => p?.clear));

  V._emitTourCursor(51.0007, -0.1, 7);
  scrubs.length = 0;
  V._onHotspotTourStep(null, 0, null);
  assert.strictEqual(AppState.scrubSource, null);
  assert.strictEqual(AppState.hoveredIndex, -1);
  assert.ok(scrubs.some((p) => p?.clear));
});

test("stopping a tour leaves the graph's own hover alone", async () => {
  const { window, AppState } = await bootScrub();
  AppState.scrubSource = 'graph';
  AppState.hoveredIndex = 4;
  window.GSRGlobe3DView._onReplayTourProgress(null);
  assert.strictEqual(AppState.scrubSource, 'graph');
  assert.strictEqual(AppState.hoveredIndex, 4);
});
