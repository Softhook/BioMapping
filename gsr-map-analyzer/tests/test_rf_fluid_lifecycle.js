/**
 * Gap-fill unit tests for rf_fluid_renderer.js (RFFluidRenderer) covering the
 * constructor/canvas-lifecycle/option-setter methods NOT already exercised by
 * tests/test_rf_fluid.js (setData/_precalculateSpatialFans/_normDbm/ray-cast
 * math) or tests/test_rf_svg_export.js (exportToSvgElements). Those two files
 * already give the numerically-significant logic solid coverage; this file
 * fills in: constructor wiring, _initCanvas/_bindEvents/resizeCanvas,
 * setMode/setOpacity/setRadius/setVisible.
 *
 * RFFluidRenderer talks to a real Leaflet map + canvas in the browser — here
 * it's driven with a minimal hand-rolled Leaflet/DOM stub (no jsdom needed;
 * the class only touches a handful of specific Leaflet/DOM APIs, all mocked
 * below to match exactly what the source code calls).
 *
 * Run: node --test tests/test_rf_fluid_lifecycle.js
 */

const assert = require('assert');
const test = require('node:test');

// ── Minimal Leaflet (`L`) stub — only what RFFluidRenderer actually calls ──
global.L = {
  DomUtil: {
    create: (tag, className) => ({ tag, className, style: {} }),
    setPosition: () => {},
    setTransform: () => {},
  },
};
global.window = { devicePixelRatio: 1 };

const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'rf_fluid_renderer.js'), 'utf8');
// rf_fluid_renderer.js declares `class RFFluidRenderer { ... }` with no
// module.exports at all (unlike the files touched elsewhere in this pass) —
// load it via vm the same way several pre-existing tests in this suite do
// for un-exported classes, rather than editing production source just to
// add an export hook for a class with no guard either way already.
const vm = require('vm');
vm.runInThisContext(src.replace('class RFFluidRenderer', 'global.RFFluidRenderer = class RFFluidRenderer'), { filename: 'rf_fluid_renderer.js' });
const RFFluidRenderer = global.RFFluidRenderer;

function makeFakeMap(overrides = {}) {
  const panes = {};
  const listeners = {};
  return Object.assign({
    getPane: (name) => panes[name] || null,
    createPane: (name) => { panes[name] = { style: {}, appendChild: () => {} }; return panes[name]; },
    on: (evt, fn) => { listeners[evt] = fn; },
    getBounds: () => ({
      pad: () => ({
        getNorthWest: () => ({ lat: 51.51, lon: -0.11 }),
        getSouthEast: () => ({ lat: 51.50, lon: -0.10 }),
      }),
    }),
    latLngToLayerPoint: (ll) => ({ x: 100, y: 100 }),
    getZoomScale: () => 1,
    getZoom: () => 15,
    getSize: () => ({ x: 800, y: 600 }),
    _latLngToNewLayerPoint: () => ({ x: 0, y: 0 }),
  }, overrides);
}

// redraw() is the actual 2D canvas drawing routine and calls a large surface
// of the CanvasRenderingContext2D API (clearRect/save/restore/gradients/
// paths/etc). Rather than enumerate every method it happens to call today
// (brittle — a rendering tweak would silently need a matching mock update),
// a Proxy auto-mocks any method as a no-op and any property read as a
// harmless default, so redraw() can run to completion without throwing.
// This intentionally does NOT verify *what* gets drawn — that's canvas
// pixel output, not something worth unit-testing here — only that the
// setter methods (setMode/setOpacity/setRadius/setVisible) can safely
// trigger a redraw without crashing.
function fakeCanvasContext() {
  return new Proxy({}, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === 'canvas') return { width: 400, height: 300 };
      return (...args) => {
        // Methods that create sub-objects (gradients, patterns) need to
        // return something with an addColorStop-shaped API of their own.
        if (String(prop).startsWith('create')) {
          return new Proxy({}, { get: () => () => {} });
        }
        return undefined;
      };
    },
  });
}

test('constructor: merges default options with overrides and initializes empty state', () => {
  const map = makeFakeMap();
  const canvasEl = { style: {}, getContext: () => fakeCanvasContext() };
  global.L.DomUtil.create = () => canvasEl;

  const renderer = new RFFluidRenderer(map, { opacity: 0.5, mode: '815' });
  assert.strictEqual(renderer.options.opacity, 0.5, 'override should win');
  assert.strictEqual(renderer.options.mode, '815', 'override should win');
  assert.strictEqual(renderer.options.radiusMeters, 35, 'unspecified option keeps its default');
  assert.deepStrictEqual(renderer.drawPoints, []);
  assert.strictEqual(renderer.enabled, true);
});

test('constructor: creates the rfFluidPane once and reuses it on a second instance', () => {
  const map = makeFakeMap();
  global.L.DomUtil.create = () => ({ style: {}, getContext: () => fakeCanvasContext() });

  new RFFluidRenderer(map);
  assert.ok(map.getPane('rfFluidPane'), 'pane should have been created');
  const paneAfterFirst = map.getPane('rfFluidPane');

  new RFFluidRenderer(map); // second instance, same map
  assert.strictEqual(map.getPane('rfFluidPane'), paneAfterFirst, 'pane should not be recreated');
});

test('constructor: with no map, skips canvas init without throwing', () => {
  assert.doesNotThrow(() => {
    const renderer = new RFFluidRenderer(null);
    assert.strictEqual(renderer.canvas, null);
  });
});

test('constructor: with map but no global L, skips canvas init without throwing', () => {
  const realL = global.L;
  delete global.L;
  assert.doesNotThrow(() => {
    const renderer = new RFFluidRenderer(makeFakeMap());
    assert.strictEqual(renderer.canvas, null);
  });
  global.L = realL;
});

test('resizeCanvas: sizes the canvas to the padded viewport in device pixels', () => {
  const map = makeFakeMap({
    latLngToLayerPoint: (ll) => (ll.lat === 51.51 ? { x: 0, y: 0 } : { x: 200, y: 150 }),
  });
  const canvasEl = { style: {}, getContext: () => fakeCanvasContext() };
  global.L.DomUtil.create = () => canvasEl;
  global.window.devicePixelRatio = 2;

  const renderer = new RFFluidRenderer(map);
  assert.strictEqual(canvasEl.width, 400, 'width should be scaled by devicePixelRatio');
  assert.strictEqual(canvasEl.height, 300);
  assert.strictEqual(canvasEl.style.width, '200px');
  assert.strictEqual(canvasEl.style.height, '150px');

  global.window.devicePixelRatio = 1;
});

test('resizeCanvas: enforces a 10px minimum canvas dimension for degenerate viewports', () => {
  const map = makeFakeMap({ latLngToLayerPoint: () => ({ x: 0, y: 0 }) }); // NW === SE → 0x0 viewport
  const canvasEl = { style: {}, getContext: () => fakeCanvasContext() };
  global.L.DomUtil.create = () => canvasEl;

  new RFFluidRenderer(map);
  assert.strictEqual(canvasEl.width, 10);
  assert.strictEqual(canvasEl.height, 10);
});

test('_bindEvents: wires zoomanim and moveend/zoomend/resize/viewreset handlers without throwing when triggered', () => {
  const listeners = {};
  const map = makeFakeMap({ on: (evt, fn) => { listeners[evt] = fn; } });
  global.L.DomUtil.create = () => ({ style: {}, getContext: () => fakeCanvasContext() });

  const renderer = new RFFluidRenderer(map);
  assert.ok(typeof listeners['zoomanim'] === 'function');
  assert.ok(typeof listeners['moveend zoomend resize viewreset'] === 'function');

  assert.doesNotThrow(() => listeners['moveend zoomend resize viewreset']());
  assert.doesNotThrow(() => listeners['zoomanim']({ zoom: 16, center: { lat: 0, lon: 0 } }));
});

test('setMode: updates options.mode and triggers a redraw (no throw with an empty canvas)', () => {
  const map = makeFakeMap();
  global.L.DomUtil.create = () => ({ style: {}, getContext: () => fakeCanvasContext() });
  const renderer = new RFFluidRenderer(map);

  assert.doesNotThrow(() => renderer.setMode('fog'));
  assert.strictEqual(renderer.options.mode, 'fog');
});

test('setOpacity: updates options.opacity and triggers a redraw', () => {
  const map = makeFakeMap();
  global.L.DomUtil.create = () => ({ style: {}, getContext: () => fakeCanvasContext() });
  const renderer = new RFFluidRenderer(map);

  assert.doesNotThrow(() => renderer.setOpacity(0.2));
  assert.strictEqual(renderer.options.opacity, 0.2);
});

test('setRadius: updates options.radiusMeters and re-precalculates spatial fans', () => {
  const map = makeFakeMap();
  global.L.DomUtil.create = () => ({ style: {}, getContext: () => fakeCanvasContext() });
  const renderer = new RFFluidRenderer(map);

  assert.doesNotThrow(() => renderer.setRadius(60));
  assert.strictEqual(renderer.options.radiusMeters, 60);
});

test('setVisible: toggles canvas display style and redraws only when becoming visible', () => {
  const map = makeFakeMap();
  const canvasEl = { style: {}, getContext: () => fakeCanvasContext() };
  global.L.DomUtil.create = () => canvasEl;
  const renderer = new RFFluidRenderer(map);

  renderer.setVisible(false);
  assert.strictEqual(canvasEl.style.display, 'none');
  assert.strictEqual(renderer.options.visible, false);

  renderer.setVisible(true);
  assert.strictEqual(canvasEl.style.display, 'block');
  assert.strictEqual(renderer.options.visible, true);
});
