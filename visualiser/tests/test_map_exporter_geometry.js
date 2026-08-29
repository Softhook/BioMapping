/**
 * Gap-fill unit tests for map_exporter.js (GSRMapExporter) — the pure
 * SVG-string/color helper methods NOT already exercised by the existing
 * isoband/SVG-export test files (test_isoband_boundary_closure.js,
 * test_edge_isoband_fix.js, test_masked_grid_isobands.js,
 * test_svg_vector_surface.js, test_rf_svg_export.js, test_osm_hard_shapes.js,
 * test_isoband_svg_renders.js already cover: _surface, _pathD, _pathBBox,
 * _expandCanvasForIsobands, _pathEl, _render, _rfFluid, _getProjection).
 *
 * The pure ring/boundary geometry that used to live here (_toLoop,
 * _buildRectangleLoop, _traceMaskBoundary, _smoothLoopPoints,
 * _recomputeSmoothNormals, _tangentExtrapolate) moved to
 * contour_ring_geometry.js (ContourRingGeometry) — see
 * test_contour_ring_geometry.js. _clipCellIsoband (and its tests) were
 * removed entirely: dead code from a superseded per-cell isoband-clipping
 * approach, with zero call sites anywhere once the ring+closure approach in
 * _buildVectorIsobands became the real implementation.
 *
 * This file covers what's left on GSRMapExporter: _hslToHex, _ratioToHex,
 * _esc, _img.
 *
 * NOT covered here (left for a Tier-D-style DOM/async pass, if/when that's
 * done): exportToSvg, _validate, _gather, _tiles, _inlineImg, _download,
 * _vectors, _markers, _dotSvg, _labelSvg — these orchestrate a live Leaflet
 * map, DOM tile images, and file-save I/O rather than doing pure computation.
 *
 * Run: node --test tests/test_map_exporter_geometry.js
 */

const assert = require('assert');
const test = require('node:test');

// map_exporter.js has no export guard at all (class GSRMapExporter, only
// `window.GSRMapExporter = GSRMapExporter;` unconditionally at the tail) —
// load it via vm the same way pre-existing tests in this suite already do
// for it (see tests/test_isoband_boundary_closure.js), rather than editing
// production source just to add a hook.
const vm = require('vm');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'map', 'map_exporter.js'), 'utf8');
global.window = global;
vm.runInThisContext(src.replace('class GSRMapExporter', 'global.GSRMapExporter = class GSRMapExporter'), { filename: 'map_exporter.js' });
const GSRMapExporter = global.GSRMapExporter;

// ── _hslToHex / _ratioToHex ─────────────────────────────────────────────
test('_hslToHex: pure red/green/blue hues resolve to their expected hex primaries', () => {
  assert.strictEqual(GSRMapExporter._hslToHex(0, 100, 50), '#ff0000');
  assert.strictEqual(GSRMapExporter._hslToHex(120, 100, 50), '#00ff00');
  assert.strictEqual(GSRMapExporter._hslToHex(240, 100, 50), '#0000ff');
});

test('_hslToHex: 0% lightness is black, 100% lightness is white regardless of hue', () => {
  assert.strictEqual(GSRMapExporter._hslToHex(200, 100, 0), '#000000');
  assert.strictEqual(GSRMapExporter._hslToHex(200, 100, 100), '#ffffff');
});

test('_hslToHex: 0% saturation is a neutral grey', () => {
  assert.strictEqual(GSRMapExporter._hslToHex(90, 0, 50), '#808080');
});

test('_ratioToHex: 0 maps to green (hue 120), 1 maps to red (hue 0), matching _hslToHex directly', () => {
  assert.strictEqual(GSRMapExporter._ratioToHex(0), GSRMapExporter._hslToHex(120, 100, 50));
  assert.strictEqual(GSRMapExporter._ratioToHex(1), GSRMapExporter._hslToHex(0, 100, 50));
});

test('_ratioToHex: clamps out-of-range ratios into [0, 1] instead of extrapolating hue', () => {
  assert.strictEqual(GSRMapExporter._ratioToHex(-5), GSRMapExporter._ratioToHex(0));
  assert.strictEqual(GSRMapExporter._ratioToHex(99), GSRMapExporter._ratioToHex(1));
});

// ── _esc / _img ──────────────────────────────────────────────────────────
test('_esc: escapes the 4 XML-significant characters', () => {
  assert.strictEqual(GSRMapExporter._esc(`<a href="x">&'y'</a>`), '&lt;a href=&quot;x&quot;&gt;&amp;\'y\'&lt;/a&gt;');
});

test('_esc: null/undefined become an empty string, not the literal "null"/"undefined"', () => {
  assert.strictEqual(GSRMapExporter._esc(null), '');
  assert.strictEqual(GSRMapExporter._esc(undefined), '');
});

test('_esc: non-string values are stringified first', () => {
  assert.strictEqual(GSRMapExporter._esc(42), '42');
});

test('_img: builds an <image> tag with both href and xlink:href escaped identically', () => {
  const svg = GSRMapExporter._img(1, 2, 3, 4, 'http://x.test/a&b.png');
  assert.ok(svg.includes('href="http://x.test/a&amp;b.png"'));
  assert.ok(svg.includes('xlink:href="http://x.test/a&amp;b.png"'));
  assert.ok(svg.includes('x="1" y="2" width="3" height="4"'));
});
