/**
 * Regression test: the exported isoband path data must actually rasterize to
 * visible content in a real SVG engine, not just look correct as a string.
 *
 * Note on scope: this deliberately rasterizes the isoband paths WITHOUT the
 * clip-path wrapper the real export applies. The `convert` available in some
 * environments (including where this test was developed) uses ImageMagick's
 * built-in MSVG coder rather than a full librsvg, and that coder was found to
 * silently render an entire `<g clip-path="...">` as blank regardless of its
 * content — a limitation of that specific tool, not of the SVG being produced
 * (browsers and Illustrator handle clip-path correctly). Clip-path correctness
 * itself — that the invisible closing geometry never shows up inside the
 * visible frame — is instead verified geometrically in
 * test_isoband_boundary_closure.js, which doesn't depend on any particular
 * renderer's feature support.
 *
 * What this test *does* catch: NaN/garbage coordinates, empty path data, or a
 * self-canceling winding number (e.g. from the extrapolated/invisible loop
 * fighting the visible fill under the nonzero fill rule) — any of which would
 * make the shape rasterize as blank even without clipping involved.
 *
 * Skips (rather than failing) if ImageMagick's `convert` isn't available on this
 * machine — it's a real-render sanity check, not something the whole suite
 * should depend on.
 *
 * Run: node visualiser/tests/test_isoband_svg_renders.js
 */
const assert = require('assert');
const { test } = require('node:test');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const vm     = require('vm');
const { spawnSync } = require('child_process');

global.window = global;
global.GSR_CONST = require('./mock_constants.js');

function loadModule(filePath, varName) {
  const src = fs.readFileSync(filePath, 'utf8');
  const wrapped = src.replace(
    new RegExp(`class ${varName}\\s*{`),
    `global.${varName} = class ${varName} {`
  ).replace(
    new RegExp(`const ${varName}\\s*=`),
    `global.${varName} =`
  );
  vm.runInThisContext(wrapped, { filename: filePath });
}

loadModule(path.join(__dirname, '../src/signal/stats_math.js'),      'StatsMath');
loadModule(path.join(__dirname, '../src/map/map_colors.js'),      'MapColors');
loadModule(path.join(__dirname, '../src/gps/geo_utils.js'),       'GeoUtils');
loadModule(path.join(__dirname, '../src/render/marching_squares.js'),'MarchingSquares');
loadModule(path.join(__dirname, '../src/spatial/spatial_clustering.js'), 'GSRSpatialClustering');
loadModule(path.join(__dirname, '../src/map/hillshade.js'),       'Hillshade');
loadModule(path.join(__dirname, '../src/map/map_exporter.js'),   'GSRMapExporter');

const { MarchingSquares } = global;
const GSRMapExporter = global.GSRMapExporter;

console.log('── Running Isoband SVG Real-Render Regression Test ──');

const hasConvert = spawnSync('which', ['convert']).status === 0;
test(
  'Isoband SVG real-render: exported isobands rasterize to visible content',
  { skip: hasConvert ? false : 'ImageMagick `convert` not available — skipping real-render check.' },
  () => {

// A peak pinned right at a corner (the original bug report scenario), at a
// realistic worst-case gridResolution/contourCount.
const rows = 80, cols = 80;
const grid = Array.from({ length: rows }, (_, r) =>
  Array.from({ length: cols }, (_, c) => {
    const dr = r - 78, dc = c - 78;
    return 3.0 * Math.exp(-(dr * dr + dc * dc) / 250);
  })
);
const bounds = { minLat: 49.9, maxLat: 50.0, minLon: 0.0, maxLon: 0.1 };
const sortedVals = grid.flat().slice().sort((a, b) => a - b);
const contourCount = 9;
const contours = [];
for (let k = 1; k <= contourCount; k++) {
  const pct = k / (contourCount + 1);
  const idx = Math.min(sortedVals.length - 1, Math.round(pct * (sortedVals.length - 1)));
  const level = sortedVals[idx];
  const segments = MarchingSquares.getContourLines(grid, rows, cols, bounds, level);
  if (segments.length) contours.push({ level, ratio: pct, segments });
}

const project = (ll) => {
  const lat = ll.lat !== undefined ? ll.lat : ll[0];
  const lon = ll.lon !== undefined ? ll.lon : (ll.lng !== undefined ? ll.lng : ll[1]);
  return { x: lon * 20000, y: (50 - lat) * 20000 };
};
const mockEl = { clientWidth: 800, clientHeight: 600, querySelectorAll: () => [], querySelector: () => null };
const ctx = {
  map: { latLngToContainerPoint: project }, el: mockEl, r: { left: 0, top: 0 }, w: 2000, h: 2000, project,
  mgr: { surfaceData: { grid, minVal: 0, maxVal: 3, bounds, sortedVals, contours } }
};

const surface = GSRMapExporter._surface(ctx);
assert(surface.isobands.length > 0, 'Sanity: at least one isoband element is produced');

const svg = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2000 2000" width="2000" height="2000">',
  '  <rect x="0" y="0" width="2000" height="2000" fill="#0b0d16" />',
  ...surface.isobands.map(p => '  ' + p),
  '</svg>'
].join('\n');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'isoband-render-'));
const svgPath = path.join(tmpDir, 'test.svg');
const pngPath = path.join(tmpDir, 'test.png');
fs.writeFileSync(svgPath, svg);

const result = spawnSync('convert', ['-background', '#0b0d16', svgPath, pngPath], { encoding: 'utf8' });
assert.strictEqual(result.status, 0, `convert should succeed rasterizing the exported SVG (stderr: ${result.stderr})`);

// Ask ImageMagick how many pixels differ from a solid background fill — "AE" is
// a raw differing-pixel COUNT, not a fraction, so normalize by total pixel count.
const compare = spawnSync('convert', [
  pngPath, '(', '-clone', '0', '-fill', '#0b0d16', '-colorize', '100', ')',
  '-metric', 'AE', '-compare', '-format', '%[distortion]', 'info:'
], { encoding: 'utf8' });
const diffPixelCount = parseFloat(compare.stdout);
const totalPixels = 2000 * 2000;
const diffFraction = diffPixelCount / totalPixels;

fs.rmSync(tmpDir, { recursive: true, force: true });

assert(!isNaN(diffPixelCount), `ImageMagick comparison against solid background produced a numeric result (got: "${compare.stdout}", stderr: "${compare.stderr}")`);
assert(
  diffFraction > 0.05,
  `Rendered PNG has a substantial fraction of non-background pixels (i.e. the isobands actually rendered, not blank): ${(diffFraction * 100).toFixed(1)}%`
);
console.log(`✓ Exported isobands render as actual visible content in a real SVG engine (${(diffFraction * 100).toFixed(1)}% non-background pixels)`);
});
