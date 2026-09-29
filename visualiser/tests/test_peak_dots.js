/**
 * Tests for the canvas peak dots in src/map/map_markers.mjs — the plain
 * peaks drawn on the map's canvas (not as DOM markers, which the browser
 * restyles every zoom frame):
 *   createMapRenderer — a canvas that keeps dots above every other shape, for
 *                       drawing and for taps, whatever the add order
 *   buildPeakDot      — generous tap area, dimming, SVG export
 *
 * Runs the real vendored Leaflet inside jsdom. jsdom has no canvas drawing,
 * so the 2D context is a stub that accepts every call.
 *
 * Run: node --test tests/test_peak_dots.js
 */

const assert = require('node:assert');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html>', { runScripts: 'outside-only' });
const { window } = dom;
window.HTMLCanvasElement.prototype.getContext = () =>
  new Proxy({}, { get: (_t, k) => (k === 'canvas' ? null : () => {}) });
window.eval(
  fs.readFileSync(
    path.join(__dirname, '..', 'vendor', 'leaflet', 'leaflet.js'),
    'utf8',
  ),
);
global.L = window.L;
global.document = window.document;
global.getComputedStyle = window.getComputedStyle;
L.Browser.any3d = true;

const { GSRMapMarkers } = require('../src/map/map_markers.mjs');

function makeMap() {
  const el = window.document.createElement('div');
  Object.defineProperty(el, 'clientWidth', { value: 800 });
  Object.defineProperty(el, 'clientHeight', { value: 600 });
  window.document.body.appendChild(el);
  return L.map(el, {
    preferCanvas: true,
    renderer: GSRMapMarkers.createMapRenderer(L),
  }).setView([51.5, -0.12], 16);
}

// The renderer's draw (and hit-test) order, first to last.
function drawOrder(map) {
  const out = [];
  for (let o = map.options.renderer._drawFirst; o; o = o.next) {
    out.push(o.layer);
    assert.ok(out.length < 1000, 'draw list loops');
  }
  return out;
}

const at = (map, x, y) => map.containerPointToLatLng([x, y]);

test('peak dots stay above every other shape, whatever order they are added and removed in', () => {
  const map = makeMap();
  const line = (x) => L.polyline([at(map, x, 100), at(map, x, 500)]).addTo(map);
  const dot = (x) => GSRMapMarkers.buildPeakDot(L, at(map, x, 300)).addTo(map);

  const a = line(100);
  const d1 = dot(200);
  const b = line(300); // added after a dot: must still go under it
  const d2 = dot(400);
  const c = line(500);
  assert.deepStrictEqual(drawOrder(map), [a, b, c, d1, d2]);

  // Remove the first dot (the renderer's marker for where dots start).
  map.removeLayer(d1);
  const e = line(600);
  assert.deepStrictEqual(drawOrder(map), [a, b, c, e, d2]);

  map.removeLayer(d2); // no dots left
  const f = line(700);
  const d3 = dot(250);
  assert.deepStrictEqual(drawOrder(map), [a, b, c, e, f, d3]);

  // The list stays consistent both ways.
  const order = drawOrder(map);
  let o = map.options.renderer._drawLast;
  for (let i = order.length - 1; i >= 0; i--, o = o.prev) {
    assert.strictEqual(o.layer, order[i]);
  }
  assert.ok(!o, 'nothing before the first');
});

test('a tap on a dot lying on the path goes to the dot, with a finger-sized margin', () => {
  const map = makeMap();
  const renderer = map.options.renderer;
  // The walk passes straight through the dot, and is re-added after it (as
  // a recolour does).
  const dot = GSRMapMarkers.buildPeakDot(L, at(map, 400, 300)).addTo(map);
  const pathLine = L.polyline([at(map, 100, 300), at(map, 700, 300)], {
    weight: 5,
  }).addTo(map);
  assert.ok(drawOrder(map).indexOf(dot) > drawOrder(map).indexOf(pathLine));

  const hits = [];
  dot.on('click', () => hits.push('dot'));
  pathLine.on('click', () => hits.push('path'));
  const tap = (x, y) =>
    renderer._onClick({
      type: 'click',
      clientX: x,
      clientY: y,
      target: renderer._container,
    });

  tap(400, 300);
  tap(400 + 11, 300); // 11 px off-centre: the old 24 px icon box still counts
  assert.deepStrictEqual(hits, ['dot', 'dot']);
  tap(400 + 40, 300); // along the path, clear of the dot
  assert.deepStrictEqual(hits, ['dot', 'dot', 'path']);
});

test('dimming and export: an excluded dot fades, and exports as the same circle the DOM dot did', () => {
  const map = makeMap();
  const dot = GSRMapMarkers.buildPeakDot(L, at(map, 400, 300)).addTo(map);
  assert.ok(GSRMapMarkers.isPeakDot(dot));
  assert.ok(!GSRMapMarkers.isPeakDot(L.marker(at(map, 1, 1))));

  const svg = GSRMapMarkers.peakDotSvg(dot, 10, 20);
  assert.match(svg, /cx="10" cy="20" r="3"/, 'outer edge: 6 px across');
  assert.match(svg, /stroke="#ffffff" stroke-width="0.5" opacity="1"/);

  GSRMapMarkers.dimPeakMarker(dot);
  assert.match(GSRMapMarkers.peakDotSvg(dot, 10, 20), /opacity="0.35"/);
  assert.ok(dot.options.fillOpacity < 0.75 / 2, 'drawn faded too');
});
