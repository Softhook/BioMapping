/**
 * Tests for src/map/smooth_wheel_zoom.mjs — continuous wheel/trackpad zoom.
 *
 * Runs the real vendored Leaflet inside jsdom (no layout engine, so the map
 * container is given a fixed size) and drives animation frames by hand, so
 * each test can step through a zoom frame by frame.
 *
 * Run: node --test tests/test_smooth_wheel_zoom.js
 */

const assert = require('node:assert');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><div id="map"></div>', {
  runScripts: 'outside-only',
});
const { window } = dom;
window.eval(
  fs.readFileSync(
    path.join(__dirname, '..', 'vendor', 'leaflet', 'leaflet.js'),
    'utf8',
  ),
);
global.L = window.L;
// jsdom has no CSS 3D transforms, and without them Leaflet forces whole zoom
// levels (_limitZoom ignores zoomSnap). Every browser the app runs in has them.
L.Browser.any3d = true;

// Hand-cranked animation frames: flushFrames() runs them at 60 Hz timestamps.
let frameQueue = [];
let frameId = 0;
let clock = 0;
global.requestAnimationFrame = (fn) => {
  frameQueue.push({ id: ++frameId, fn });
  return frameId;
};
global.cancelAnimationFrame = (id) => {
  frameQueue = frameQueue.filter((f) => f.id !== id);
};
global.performance = { now: () => clock };
function flushFrames(max = 1000) {
  let n = 0;
  while (frameQueue.length && n < max) {
    const due = frameQueue;
    frameQueue = [];
    clock += 1000 / 60;
    for (const f of due) f.fn(clock);
    n++;
  }
  return n;
}

const {
  enableSmoothWheelZoom,
  exactLayerPoint,
  isWheelZooming,
  ZOOMING_CLASS,
} = require('../src/map/smooth_wheel_zoom.mjs');

function makeMap() {
  frameQueue = []; // drop frames a failed earlier test left running
  const el = window.document.createElement('div');
  Object.defineProperty(el, 'clientWidth', { value: 1000, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: 600 });
  window.document.body.appendChild(el);
  const map = L.map(el, {
    scrollWheelZoom: false,
    zoomSnap: 0,
    fadeAnimation: false,
    zoomAnimation: false,
  }).setView([51.5, -0.12], 15);
  enableSmoothWheelZoom(map);
  const events = { zoomstart: 0, zoomend: 0 };
  map.on('zoomstart', () => events.zoomstart++);
  map.on('zoomend', () => events.zoomend++);
  return { map, el, events };
}

// jsdom has no layout, so getBoundingClientRect is all zeros and clientX/Y
// are container coordinates directly.
function wheel(el, deltaY, x = 700, y = 180) {
  el.dispatchEvent(
    new window.WheelEvent('wheel', {
      deltaY,
      clientX: x,
      clientY: y,
      bubbles: true,
      cancelable: true,
    }),
  );
}

const isWhole = (p) => Number.isInteger(p.x) && Number.isInteger(p.y);

test('scrolling glides the zoom over many frames and settles on the scrolled amount', () => {
  const { map, el, events } = makeMap();
  const zooms = [];
  map.on('zoom', () => zooms.push(map.getZoom()));

  // Three mouse-wheel notches up = 300 px = one zoom level in.
  wheel(el, -100);
  wheel(el, -100);
  wheel(el, -100);
  flushFrames();

  assert.ok(Math.abs(map.getZoom() - 16) < 0.002, `zoom ${map.getZoom()}`);
  assert.ok(zooms.length > 10, `glided over ${zooms.length} frames`);
  for (let i = 1; i < zooms.length; i++) {
    assert.ok(zooms[i] >= zooms[i - 1], 'zoom only moves one way');
  }
  assert.strictEqual(events.zoomstart, 1, 'one zoomstart for the gesture');
  assert.strictEqual(events.zoomend, 1, 'one zoomend, once it settles');
});

test('the map position under the cursor stays under the cursor', () => {
  const { map, el } = makeMap();
  const cursor = L.point(700, 180);
  const pinned = map.containerPointToLatLng(cursor);
  for (let i = 0; i < 10; i++) wheel(el, -40);
  flushFrames();
  const drift = map
    .project(pinned)
    .subtract(map.getPixelOrigin())
    .add(L.DomUtil.getPosition(map._mapPane))
    .distanceTo(cursor);
  assert.ok(drift <= 0.75, `drifted ${drift}px`);
});

test('mid-zoom positions are exact; at rest everything is back on whole pixels', () => {
  const { map, el } = makeMap();
  const marker = L.marker(map.containerPointToLatLng([420, 260]), {
    icon: L.divIcon({ iconSize: [10, 10] }),
  }).addTo(map);

  for (let i = 0; i < 5; i++) wheel(el, -40);
  flushFrames(6);
  assert.ok(isWheelZooming(map), 'still gliding');
  assert.ok(
    el.classList.contains(ZOOMING_CLASS),
    'container flagged so markers get their own layer',
  );
  const exact = map.project(marker.getLatLng()).subtract(map.getPixelOrigin());
  assert.deepStrictEqual(
    L.DomUtil.getPosition(marker._icon),
    exact,
    'marker sits at its exact (unrounded) spot mid-zoom',
  );

  flushFrames();
  assert.ok(!isWheelZooming(map));
  assert.ok(!el.classList.contains(ZOOMING_CLASS), 'flag cleared at rest');
  assert.ok(isWhole(L.DomUtil.getPosition(map._mapPane)), 'pane snapped');
  assert.ok(isWhole(L.DomUtil.getPosition(marker._icon)), 'marker snapped');
  assert.ok(
    isWhole(map.latLngToLayerPoint(marker.getLatLng())),
    "Leaflet's rounded latLngToLayerPoint is back",
  );
});

test('a pan arriving mid-zoom ends the zoom cleanly and wins', () => {
  const { map, el, events } = makeMap();
  for (let i = 0; i < 5; i++) wheel(el, -40);
  flushFrames(5);
  assert.ok(isWheelZooming(map));

  const zoomBefore = map.getZoom();
  const target = L.latLng(51.505, -0.1);
  map.panTo(target, { animate: false });

  assert.ok(!isWheelZooming(map), 'zoom ended');
  // (A non-animated pan resets the view and fires a zoomend of its own too.)
  assert.ok(events.zoomend >= 1, 'zoomend fired for the ended zoom');
  assert.strictEqual(frameQueue.length, 0, 'no zoom frames left running');
  assert.strictEqual(map.getZoom(), zoomBefore, 'free zoom level kept');
  assert.ok(map.getCenter().distanceTo(target) < 3, 'pan reached target');
});

// Container point of `latlng` as drawn on screen (pane offset included).
function screenPoint(map, latlng) {
  return map
    .project(latlng)
    .subtract(map.getPixelOrigin())
    .add(L.DomUtil.getPosition(map._mapPane));
}

test('a panBy mid-zoom (keyboard, popup auto-pan) ends the zoom and is kept', () => {
  const { map, el } = makeMap();
  for (let i = 0; i < 5; i++) wheel(el, -40);
  flushFrames(5);
  const middle = map.containerPointToLatLng([500, 300]);

  map.panBy([100, 0], { animate: false });

  assert.ok(!isWheelZooming(map), 'zoom ended');
  assert.strictEqual(frameQueue.length, 0, 'no zoom frames left running');
  const drift = screenPoint(map, middle).distanceTo(L.point(400, 300));
  assert.ok(drift <= 0.75, `pan kept, off by ${drift}px`);
});

test('a resize mid-zoom ends the zoom and keeps the map centred', () => {
  const { map, el } = makeMap();
  for (let i = 0; i < 5; i++) wheel(el, -40);
  flushFrames(5);
  const middle = map.containerPointToLatLng([500, 300]);

  Object.defineProperty(el, 'clientWidth', { value: 800 });
  map.invalidateSize(); // moves the pane via _rawPanBy

  assert.ok(!isWheelZooming(map), 'zoom ended');
  assert.strictEqual(frameQueue.length, 0, 'no zoom frames left running');
  const drift = screenPoint(map, middle).distanceTo(L.point(400, 300));
  assert.ok(drift <= 0.75, `centre kept, off by ${drift}px`);
});

test('pressing on the map mid-zoom ends the zoom before a drag can start', () => {
  const { map, el } = makeMap();
  for (let i = 0; i < 5; i++) wheel(el, -40);
  flushFrames(5);

  el.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));

  assert.ok(!isWheelZooming(map), 'zoom ended');
  assert.strictEqual(frameQueue.length, 0, 'no zoom frames left running');
  assert.ok(isWhole(L.DomUtil.getPosition(map._mapPane)), 'pane snapped');
});

test("wheel is ignored while Leaflet's own zoom animation runs", () => {
  const { map, el } = makeMap();
  map._animatingZoom = true;
  wheel(el, -100);
  map._animatingZoom = false;
  assert.ok(!isWheelZooming(map));
  assert.strictEqual(frameQueue.length, 0);
});

test('removing the map mid-zoom stops it and unhooks everything', () => {
  const { map, el } = makeMap();
  for (let i = 0; i < 5; i++) wheel(el, -40);
  flushFrames(5);

  map.remove();

  assert.ok(!isWheelZooming(map), 'zoom ended');
  assert.strictEqual(frameQueue.length, 0, 'no zoom frames left running');
  for (const name of ['_stop', 'panBy', '_rawPanBy']) {
    assert.ok(!Object.hasOwn(map, name), `Leaflet's own ${name} is back`);
  }
  assert.doesNotThrow(() => wheel(el, -100), 'wheel on the old container');
  assert.strictEqual(frameQueue.length, 0, 'and it starts nothing');
});

test('zoom is clamped to the map limits', () => {
  const { map, el } = makeMap();
  map.setMaxZoom(15.5);
  for (let i = 0; i < 20; i++) wheel(el, -100);
  flushFrames();
  assert.ok(Math.abs(map.getZoom() - 15.5) < 0.002, `zoom ${map.getZoom()}`);
});

test('vector layers are stretched from where they were drawn, so the zoomend redraw does not jump', () => {
  const { map, el } = makeMap();
  const renderer = L.svg().addTo(map); // jsdom has no canvas; same transform maths
  // A fractional pixel position, where Leaflet's rounding would show.
  const latlng = map.containerPointToLatLng([430.37, 318.71]);
  const dot = L.circleMarker(latlng, { renderer, radius: 4 }).addTo(map);

  // Where the renderer is showing the dot as drawn: its drawn layer point,
  // through the container's translate + stretch, plus the pane offset.
  const drawnAt = () => {
    const [x, y, scale] =
      /translate3d\(([-\d.e]+)px, ?([-\d.e]+)px, ?0\) scale\(([-\d.e]+)\)/
        .exec(renderer._container.style.transform)
        .slice(1)
        .map(Number);
    return dot._point
      .subtract(renderer._bounds.min)
      .multiplyBy(scale)
      .add(L.point(x, y))
      .add(L.DomUtil.getPosition(map._mapPane));
  };

  for (let i = 0; i < 9; i++) wheel(el, -100, 400, 300); // three levels in
  let worst = 0;
  for (let n = 0; n < 200 && isWheelZooming(map); n++) {
    flushFrames(1);
    if (isWheelZooming(map)) {
      worst = Math.max(worst, drawnAt().distanceTo(screenPoint(map, latlng)));
    }
  }
  assert.ok(worst < 0.01, `stretched drawing off by up to ${worst}px`);
});

test("exactLayerPoint is unrounded on a smooth-zoom map and Leaflet's own elsewhere", () => {
  const { map } = makeMap();
  const latlng = map.containerPointToLatLng([430.37, 318.71]);
  const exact = exactLayerPoint(map, latlng);
  assert.ok(!isWhole(exact), 'fractional');
  assert.ok(exact.distanceTo(map.latLngToLayerPoint(latlng)) <= 0.71);

  const plain = window.document.createElement('div');
  Object.defineProperty(plain, 'clientWidth', { value: 1000 });
  Object.defineProperty(plain, 'clientHeight', { value: 600 });
  window.document.body.appendChild(plain);
  const other = L.map(plain, { zoomSnap: 0 }).setView([51.5, -0.12], 15);
  assert.ok(isWhole(exactLayerPoint(other, latlng)), 'rounded as Leaflet does');
});
