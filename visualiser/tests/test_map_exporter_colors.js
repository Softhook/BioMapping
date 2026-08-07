/**
 * Tests for the SVG exporter's color handling — hsl() colors from the map
 * layers (track paths, contour isolines, cluster outlines) must be exported
 * as #rrggbb hex so the SVG doesn't depend on a viewer's hsl() support.
 * Regression for: "GPS tracks / ISO contours export as black and white."
 *
 * Run: node --test tests/test_map_exporter_colors.js
 */
'use strict';

const assert = require('assert');
const test = require('node:test');
const path = require('path');

// Load a source file that only assigns to window.X (no CommonJS export) via a
// function wrapper, mirroring test_svg_vector_surface.js.
function loadModule(filePath, exportName) {
  const fs = require('fs');
  const code = fs.readFileSync(filePath, 'utf8');
  const fn = new Function('module', 'exports', 'require', '__dirname', 'window', 'global', code);
  const dummyModule = { exports: {} };
  global.window = global.window || global;
  fn(dummyModule, dummyModule.exports, require, path.dirname(filePath), global.window, global);
  if (exportName && global.window[exportName]) {
    global[exportName] = global.window[exportName];
  }
}

loadModule(path.join(__dirname, '../map_exporter.js'), 'GSRMapExporter');
const GSRMapExporter = global.GSRMapExporter;

const project = (ll) => ({
  x: ((ll.lon !== undefined ? ll.lon : ll.lng) + 0.1) * 1000,
  y: (51.6 - ll.lat) * 1000
});

test('GSRMapExporter._toHex converts hsl() to a valid #rrggbb hex string', () => {
  const hex = GSRMapExporter._toHex('hsl(109.0909090909091, 100%, 55%)');
  assert.match(hex, /^#[0-9a-f]{6}$/i, `expected a 6-digit hex, got "${hex}"`);
  assert.ok(!hex.includes('NaN'), 'no NaN in the converted color');
  // hsl(120,100,50) is pure green.
  assert.strictEqual(GSRMapExporter._toHex('hsl(120, 100%, 50%)'), '#00ff00');
});

test('GSRMapExporter._toHex passes hex and non-hsl colors through unchanged', () => {
  assert.strictEqual(GSRMapExporter._toHex('#ff7b00'), '#ff7b00');
  assert.strictEqual(GSRMapExporter._toHex('rgb(255, 23, 68)'), 'rgb(255, 23, 68)');
  assert.strictEqual(GSRMapExporter._toHex(null), null);
});

test('GSRMapExporter._pathEl emits hsl() layer colors as hex (contour/isoline case)', () => {
  // A contour isoline layer: color carried as an hsl() string (as
  // renderContours() produces via MapColors.getHslColor).
  const contourLayer = {
    getLatLngs: () => [[{ lat: 51.5, lon: -0.1 }, { lat: 51.51, lon: -0.09 }]],
    options: { color: 'hsl(109.0909090909091, 100%, 55%)', weight: 1.5, opacity: 0.85, lineCap: 'round', lineJoin: 'round' }
  };
  const svg = GSRMapExporter._pathEl({ project }, contourLayer);
  assert.ok(svg.includes('stroke="#'), 'stroke should be emitted as hex');
  assert.ok(!svg.includes('hsl('), 'no raw hsl() string should leak into the SVG');
  assert.match(svg, /stroke="#[0-9a-f]{6}"/i, 'stroke should be a 6-digit hex');
  assert.ok(!svg.includes('NaN'), 'no NaN color in the emitted path');
});

test('GSRMapExporter._pathEl emits filled polyline (cluster) colors as hex', () => {
  // A cluster outline: fillColor + color as hsl() strings, fillOpacity > 0.
  const clusterLayer = {
    getLatLngs: () => [[{ lat: 51.5, lon: -0.1 }, { lat: 51.51, lon: -0.09 }, { lat: 51.52, lon: -0.08 }]],
    options: { color: 'hsl(30, 85%, 50%)', fillColor: 'hsl(30, 85%, 50%)', fillOpacity: 0.3, weight: 2 }
  };
  const svg = GSRMapExporter._pathEl({ project }, clusterLayer);
  assert.ok(svg.includes('fill="#'), 'fill should be emitted as hex');
  assert.ok(!svg.includes('hsl('), 'no raw hsl() string should leak into the SVG');
  assert.ok(!svg.includes('NaN'), 'no NaN color in the emitted path');
});

// ── Regression: track polylines must NOT export as filled/closed shapes ────
// Reported bug: "tracks are exported as filled shapes." Traced to _pathEl's
// isPoly heuristic reading `layer.options.fillOpacity > 0` — but real
// Leaflet's Util.setOptions builds `layer.options` via
// `Object.create(defaultOptions)`, so fillOpacity (Path's class default is
// 0.2, inherited regardless of whether `fill` is enabled) resolves through
// the prototype chain on a plain property read, even though it's never an
// OWN property of the instance. A hand-built `{ options: { color, weight } }`
// fixture (fillOpacity simply absent) would NOT reproduce this — it has to
// actually inherit the default the way real Leaflet layers do.
function makeRealisticPathOptions(explicitOptions) {
  // Mirrors Leaflet's L.Path.mergeOptions defaults relevant to fill detection.
  const pathDefaults = { fill: false, fillColor: null, fillOpacity: 0.2 };
  return Object.assign(Object.create(pathDefaults), explicitOptions);
}

test('GSRMapExporter._pathEl: a plain track polyline (fill never explicitly set) is NOT treated as a polygon', () => {
  const trackLayer = {
    getLatLngs: () => [[{ lat: 51.5, lon: -0.1 }, { lat: 51.51, lon: -0.09 }, { lat: 51.52, lon: -0.08 }]],
    options: makeRealisticPathOptions({ color: '#ff7b00', weight: 5, opacity: 0.95 })
  };
  // Sanity: the fixture genuinely reproduces Leaflet's inheritance quirk —
  // fillOpacity reads back nonzero via the prototype despite not being own.
  assert.strictEqual(trackLayer.options.fillOpacity, 0.2, 'sanity: fillOpacity inherited from the Path default');
  assert.ok(!Object.prototype.hasOwnProperty.call(trackLayer.options, 'fillOpacity'), 'sanity: fillOpacity is NOT an own property, same as real Leaflet');

  const svg = GSRMapExporter._pathEl({ project }, trackLayer);
  assert.ok(!svg.includes(' Z"'), 'track path must not be closed into a loop');
  assert.match(svg, /fill="none"/, 'track path must not be filled');
  assert.match(svg, /fill-opacity="0"/, 'track path fill-opacity must be 0, not the inherited 0.2');
});

test('GSRMapExporter._pathEl: a real cluster/OSM polygon (fillColor explicitly set) still fills correctly', () => {
  const polygonLayer = {
    getLatLngs: () => [[{ lat: 51.5, lon: -0.1 }, { lat: 51.51, lon: -0.09 }, { lat: 51.52, lon: -0.08 }]],
    options: makeRealisticPathOptions({ color: '#ff7b00', fillColor: '#ff7b00', fillOpacity: 0.3, weight: 1 })
  };
  const svg = GSRMapExporter._pathEl({ project }, polygonLayer);
  assert.ok(svg.includes(' Z"'), 'a genuinely filled shape must still close into a loop');
  assert.match(svg, /fill="#ff7b00"/, 'a genuinely filled shape must still emit its fill color');
  assert.match(svg, /fill-opacity="0\.3"/, 'a genuinely filled shape keeps its own explicit fillOpacity, not the 0.2 default');
});
