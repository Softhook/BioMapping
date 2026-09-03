/**
 * Regression coverage for the "Invalid LatLng object: (NaN, NaN)" crash when a
 * track is loaded while the 3D globe surface is showing.
 *
 * The 2D Leaflet map container is display:none whenever the globe is up, so
 * map.getSize() reads (0,0). renderData() still runs (view MODE is unchanged;
 * only the SURFACE swapped), hits its new-track auto-fit, and Leaflet's
 * getBoundsZoom() turns the zero size into a NaN zoom and then a
 * LatLng(NaN, NaN) it throws on — surfaced to the user as
 * "Error running analysis: Invalid LatLng object: (NaN, NaN)".
 *
 * Fix: _flyOrFitBounds() stashes the request when the map has no size instead
 * of calling Leaflet; _applyPendingFit() (called on return to the 2D surface,
 * after invalidateSize) replays it so the track still frames itself.
 *
 * Run: node --test tests/test_map_viewport_deferred_fit.js
 */

const assert = require('assert');
const test = require('node:test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// map_manager_viewport.js only augments GSRMapManager.prototype and, for the
// two methods under test, touches nothing but `this.map` — so a bare stub
// constructor plus a fake map is all the harness needs.
function loadViewportProto() {
  const context = { module: { exports: {} } };
  context.GSRMapManager = function GSRMapManager() {};
  context.Object = Object;
  vm.createContext(context);
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'map', 'map_manager_viewport.js'), 'utf8');
  vm.runInContext(src, context, { filename: 'map_manager_viewport.js' });
  return context.GSRMapManager;
}

function makeFakeMap(size) {
  const calls = { flyToBounds: [], fitBounds: [] };
  return {
    calls,
    _size: size,
    getSize() { return this._size; },
    flyToBounds(b, o) { calls.flyToBounds.push({ b, o }); },
    fitBounds(b, o) { calls.fitBounds.push({ b, o }); }
  };
}

const GSRMapManager = loadViewportProto();

test('_flyOrFitBounds: normal (laid-out) map flies immediately, nothing pending', () => {
  const mm = new GSRMapManager();
  mm.map = makeFakeMap({ x: 800, y: 600 });
  mm._flyOrFitBounds([[51, -0.1], [51.1, 0]]);
  assert.strictEqual(mm.map.calls.flyToBounds.length, 1);
  assert.strictEqual(mm._pendingFit, null);
});

test('_flyOrFitBounds: hidden map (size 0) defers instead of throwing', () => {
  const mm = new GSRMapManager();
  mm.map = makeFakeMap({ x: 0, y: 0 });
  const bounds = [[51, -0.1], [51.1, 0]];
  assert.doesNotThrow(() => mm._flyOrFitBounds(bounds, { maxZoom: 15 }));
  assert.strictEqual(mm.map.calls.flyToBounds.length, 0, 'Leaflet is never called on a zero-size map');
  assert.ok(mm._pendingFit, 'the request is stashed');
  assert.strictEqual(mm._pendingFit.bounds, bounds);
  assert.strictEqual(mm._pendingFit.opts.maxZoom, 15);
});

test('_flyOrFitBounds: a zero HEIGHT alone (collapsed panel) also defers', () => {
  const mm = new GSRMapManager();
  mm.map = makeFakeMap({ x: 800, y: 0 });
  mm._flyOrFitBounds([[51, -0.1], [51.1, 0]]);
  assert.strictEqual(mm.map.calls.flyToBounds.length, 0);
  assert.ok(mm._pendingFit);
});

test('_applyPendingFit: replays the deferred fit once the map has a size', () => {
  const mm = new GSRMapManager();
  mm.map = makeFakeMap({ x: 0, y: 0 });
  const bounds = [[51, -0.1], [51.1, 0]];
  mm._flyOrFitBounds(bounds, { maxZoom: 15 });

  // 2D surface is back: invalidateSize() has restored a real size.
  mm.map._size = { x: 800, y: 600 };
  mm._applyPendingFit();

  assert.strictEqual(mm.map.calls.flyToBounds.length, 0, 'replayed as a static fit, not a fly');
  assert.strictEqual(mm.map.calls.fitBounds.length, 1);
  assert.strictEqual(mm.map.calls.fitBounds[0].b, bounds);
  assert.strictEqual(mm.map.calls.fitBounds[0].o.maxZoom, 15, 'the original opts are carried through');
  assert.strictEqual(mm._pendingFit, null, 'cleared after replay');
});

test('_applyPendingFit: still hidden → stays pending, no Leaflet call', () => {
  const mm = new GSRMapManager();
  mm.map = makeFakeMap({ x: 0, y: 0 });
  mm._flyOrFitBounds([[51, -0.1], [51.1, 0]]);
  mm._applyPendingFit();
  assert.ok(mm._pendingFit, 'a still-hidden map keeps the request queued');
  assert.strictEqual(mm.map.calls.fitBounds.length, 0);
});

test('_applyPendingFit: no-op when nothing is pending', () => {
  const mm = new GSRMapManager();
  mm.map = makeFakeMap({ x: 800, y: 600 });
  assert.doesNotThrow(() => mm._applyPendingFit());
  assert.strictEqual(mm.map.calls.fitBounds.length, 0);
});

test('_flyOrFitBounds: a later successful fit clears a stale pending request', () => {
  const mm = new GSRMapManager();
  mm.map = makeFakeMap({ x: 0, y: 0 });
  mm._flyOrFitBounds([[51, -0.1], [51.1, 0]]);
  assert.ok(mm._pendingFit);

  mm.map._size = { x: 800, y: 600 };
  mm._flyOrFitBounds([[52, 1], [52.1, 1.1]]);
  assert.strictEqual(mm._pendingFit, null);
  assert.strictEqual(mm.map.calls.flyToBounds.length, 1);
});
