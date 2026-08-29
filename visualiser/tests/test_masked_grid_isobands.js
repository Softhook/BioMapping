/**
 * Regression test: isoband fills at levels whose "inside" region touches a
 * masked (null-valued) area of the grid — e.g. a real GSR export, where
 * collective_manager.js's generateContourSurface leaves every cell outside a
 * GPS track's isolationRadius corridor as `null`, and MarchingSquares skips
 * any cell touching a null corner (see marching_squares.js). An open isoline
 * that gets cut off there isn't cut off by the literal map/grid boundary at
 * all — closing it against that boundary (as the rest of this isoband
 * closure logic originally assumed every open endpoint would be) reads
 * "which side is inside" off mostly-null rectangle-edge values, which comes
 * back essentially arbitrary — some levels' fills would either enclose the
 * wrong (tiny) area or fail to close into any ring at all, i.e. the reported
 * bug: low-value ("green") isoband bands missing from a real export while
 * small interior hotspot rings kept working fine.
 *
 * Run: node visualiser/tests/test_masked_grid_isobands.js
 */
const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const vm     = require('vm');

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
loadModule(path.join(__dirname, '../src/render/bezier_spline.js'),   'BezierSpline');
loadModule(path.join(__dirname, '../src/render/contour_ring_geometry.js'), 'ContourRingGeometry');
loadModule(path.join(__dirname, '../src/map/map_exporter.js'),   'GSRMapExporter');

const { MarchingSquares, GSRSpatialClustering, GeoUtils } = global;
const GSRMapExporter = global.GSRMapExporter;

console.log('── Running Masked-Grid (Null-Cell Corridor) Isoband Regression Test ──');

const bounds = { minLat: 49.9, maxLat: 50.0, minLon: 0.0, maxLon: 0.1 };

function buildCorridorGrid(rows, cols) {
  // A gently-curving walked-path corridor entirely clear of the literal grid
  // edges (the isolationRadius/10% padding in collective_manager.js's
  // getBounds is specifically designed to guarantee this in real exports),
  // with a single stress hotspot partway along it — everything outside the
  // corridor is null, same as generateContourSurface's boundary mask.
  return Array.from({ length: rows }, (_, r) =>
    Array.from({ length: cols }, (_, c) => {
      const t = Math.max(0, Math.min(1, ((r - 8) + (c - 8)) / ((41 - 8) * 2)));
      const pathR = 8 + t * (41 - 8) + 3 * Math.sin(t * Math.PI);
      const pathC = 8 + t * (41 - 8);
      const distFromPath = Math.hypot(r - pathR, c - pathC);
      if (distFromPath > 4.5) return null;
      const alongPath = t * 50;
      const hotspot = 3.0 * Math.exp(-((alongPath - 30) ** 2) / 25);
      return 0.3 + hotspot;
    })
  );
}

function openClosedSplit(stitched) {
  const closed = [], open = [];
  stitched.forEach(p => {
    const a = p[0], b = p[p.length - 1];
    (Math.hypot(a.lat - b.lat, a.lon - b.lon) <= 1e-9 ? closed : open).push(p);
  });
  return { closed, open };
}

// ── Test 1: every percentile contour level produces an actual fillable ring —
// no level whose open path touches the mask silently comes back empty ──────
{
  const rows = 50, cols = 50;
  const grid = buildCorridorGrid(rows, cols);
  const sortedVals = grid.flat().filter(v => v !== null).sort((a, b) => a - b);
  assert(sortedVals.length > 0 && sortedVals.length < rows * cols, 'Sanity: grid has both valid and masked (null) cells');

  const contourCount = 8;
  let levelsChecked = 0;
  for (let k = 1; k <= contourCount; k++) {
    const pct = k / (contourCount + 1);
    const idx = Math.min(sortedVals.length - 1, Math.round(pct * (sortedVals.length - 1)));
    const level = sortedVals[idx];
    const segments = MarchingSquares.getContourLines(grid, rows, cols, bounds, level);
    if (!segments.length) continue; // this level has no crossing anywhere — nothing to close, not a bug
    levelsChecked++;

    const stitched = GSRSpatialClustering.stitchSegments(segments);
    const { closed, open } = openClosedSplit(stitched);
    const rings = ContourRingGeometry.closeOpenPaths(open, ContourRingGeometry.buildBoundaryLoops(grid, rows, cols, bounds), level);

    const totalFillableShapes = closed.length + rings.length;
    assert(
      totalFillableShapes > 0,
      `Level ${k} (value ${level.toFixed(3)}) has ${open.length} open path(s) touching the mask boundary ` +
      `but produced zero fillable shapes — this is the reported "green band missing" bug`
    );
  }
  assert(levelsChecked >= 6, `Sanity: most of the ${contourCount} percentile levels actually had crossings to test (got ${levelsChecked})`);
  console.log(`✓ All ${levelsChecked} contour levels with real crossings produce at least one fillable ring/closed path (no silently-missing bands)`);
}

// ── Test 2: the low-value ("outermost", most-permissive) band specifically —
// the exact case reported — actually renders as substantial visible fill ───
{
  const rows = 50, cols = 50;
  const grid = buildCorridorGrid(rows, cols);
  const sortedVals = grid.flat().filter(v => v !== null).sort((a, b) => a - b);
  const lowLevel = sortedVals[Math.round(0.15 * (sortedVals.length - 1))]; // near-lowest percentile

  const segments = MarchingSquares.getContourLines(grid, rows, cols, bounds, lowLevel);
  assert(segments.length > 0, 'Low-value level has real crossings against the mask edge');
  const stitched = GSRSpatialClustering.stitchSegments(segments);
  const { closed, open } = openClosedSplit(stitched);
  assert(closed.length > 0 || open.length > 0, 'Low-value level produces closed or open paths');
  const rings = open.length > 0 ? ContourRingGeometry.closeOpenPaths(open, ContourRingGeometry.buildBoundaryLoops(grid, rows, cols, bounds), lowLevel) : closed;
  assert(rings.length > 0, 'Low-value band produces at least one fillable ring instead of vanishing');

  const gridArea = (bounds.maxLat - bounds.minLat) * (bounds.maxLon - bounds.minLon);
  const totalRingArea = rings.reduce((sum, ring) => {
    let area = 0;
    for (let i = 0; i < ring.length; i++) {
      const p1 = ring[i], p2 = ring[(i + 1) % ring.length];
      area += p1.lon * p2.lat - p2.lon * p1.lat;
    }
    return sum + Math.abs(area) / 2;
  }, 0);
  // A low/permissive threshold should enclose a substantial portion of the
  // corridor, not a razor-thin sliver near just one endpoint.
  assert(
    totalRingArea > 0.02 * gridArea,
    `Low-value band's closed ring(s) cover a substantial area, not a tiny wrong sliver (ring area=${totalRingArea.toExponential(3)}, grid area=${gridArea.toExponential(3)})`
  );
  console.log(`✓ Low-value ("green") band closes into a substantial, correctly-enclosed fill (not missing, not a tiny wrong sliver)`);
}

// ── Test 3: rendered fills for a masked grid are smooth Bézier curves, no
// straight-line artifacts, and (critically) no needle-spike or sawtooth
// artifacts from noisy per-cell mask normals ────────────────────────────────
{
  const rows = 50, cols = 50;
  const grid = buildCorridorGrid(rows, cols);
  const sortedVals = grid.flat().filter(v => v !== null).sort((a, b) => a - b);
  const contourCount = 8;
  const contours = [];
  for (let k = 1; k <= contourCount; k++) {
    const pct = k / (contourCount + 1);
    const idx = Math.min(sortedVals.length - 1, Math.round(pct * (sortedVals.length - 1)));
    const level = sortedVals[idx];
    const segments = MarchingSquares.getContourLines(grid, rows, cols, bounds, level);
    if (segments.length) contours.push({ level, ratio: pct, segments });
  }
  assert(contours.length >= 6, 'Sanity: most levels have real crossings');

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

  const surf = GSRMapExporter._surface(ctx);
  const fills = surf.isobands.filter(p => !p.includes('fill="none"'));
  assert(fills.length >= contours.length, `At least one filled shape per contour level with crossings (${fills.length} fills for ${contours.length} levels)`);

  fills.forEach((p, i) => {
    const dMatch = p.match(/d="([^"]+)"/);
    assert(dMatch, `Fill ${i} has path data`);
    const d = dMatch[1];
    assert(d.includes(' C'), `Fill ${i} uses smooth Bézier curves, not straight/blocky segments`);
    assert(d.trim().endsWith('Z'), `Fill ${i} is a closed loop`);

    // Sawtooth/needle-spike detection: sample the rendered curve and check
    // that consecutive samples never reverse direction sharply (a spike or
    // sawtooth shows up as the path doubling back on itself locally, i.e. a
    // very sharp turn between consecutive short segments — a genuinely smooth
    // organic curve stays within a much gentler turning range throughout).
    const cmds = d.match(/M[^LCZ]*|L[^LCZ]*|C[^LCZ]*|Z/g) || [];
    let cur = null;
    const samples = [];
    cmds.forEach(cmd => {
      const type = cmd[0];
      const nums = (cmd.slice(1).match(/-?\d+\.?\d*/g) || []).map(Number);
      if (type === 'M' || type === 'L') {
        cur = { x: nums[0], y: nums[1] };
        samples.push(cur);
      } else if (type === 'C') {
        const c1 = { x: nums[0], y: nums[1] }, c2 = { x: nums[2], y: nums[3] }, pEnd = { x: nums[4], y: nums[5] };
        for (let t = 0.2; t <= 1.0001; t += 0.2) {
          const mt = 1 - t;
          samples.push({
            x: mt * mt * mt * cur.x + 3 * mt * mt * t * c1.x + 3 * mt * t * t * c2.x + t * t * t * pEnd.x,
            y: mt * mt * mt * cur.y + 3 * mt * mt * t * c1.y + 3 * mt * t * t * c2.y + t * t * t * pEnd.y
          });
        }
        cur = pEnd;
      }
    });

    let sharpReversals = 0;
    const n = samples.length;
    for (let k = 0; k < n; k++) {
      const a = samples[(k - 1 + n) % n], b = samples[k], c = samples[(k + 1) % n];
      const v1 = { x: b.x - a.x, y: b.y - a.y };
      const v2 = { x: c.x - b.x, y: c.y - b.y };
      const len1 = Math.hypot(v1.x, v1.y), len2 = Math.hypot(v2.x, v2.y);
      // Sub-pixel-scale segments (the curve is nearly stationary between these
      // particular samples) give an ill-defined, noisy direction that can
      // easily read as a sharp reversal without corresponding to any visible
      // feature — only segments with real, visible extent count here.
      if (len1 < 1.0 || len2 < 1.0) continue;
      const cosAngle = (v1.x * v2.x + v1.y * v2.y) / (len1 * len2);
      // A near-180° turn (cosAngle near -1) between two consecutive,
      // visibly-sized hops is exactly what a spike/sawtooth tooth looks like;
      // a smoothly rounded curve never does this.
      if (cosAngle < -0.85) sharpReversals++;
    }
    assert(
      sharpReversals === 0,
      `Fill ${i}: rendered curve has no sharp direction reversals (spikes/sawtooth) — found ${sharpReversals} across ${n} samples`
    );
  });
  console.log(`✓ All ${fills.length} masked-grid isoband fills render as smooth closed Bézier curves with no straight-line, spike, or sawtooth artifacts`);
}

// ── Test 4: the outermost/lowest-ratio band — whose correct closure is to
// walk *nearly the entire* mask coastline, not just a short local notch —
// stays within the real corridor's own extent instead of ballooning into a
// giant, disconnected-looking blob. This is the exact reported bug: the
// boundary-walk's outward "nudge" (meant only to keep the literal, straight
// bounding RECTANGLE from reading as a drafted line) was also being applied
// to real mask-coastline points, and its envelope reaches full strength
// across nearly the whole walked arc whenever the correct side to close on
// is "most of the coastline" — exactly the outermost band's case — so it
// pushed the entire coastline outward by a rectangle-scaled distance instead
// of a small local one. A mask coastline is already the real, organic edge
// of the valid-data region and needs no such nudge. ─────────────────────────
{
  const rows = 50, cols = 50;
  const grid = buildCorridorGrid(rows, cols);
  const sortedVals = grid.flat().filter(v => v !== null).sort((a, b) => a - b);

  // Reproduces the reported case exactly: a percentile step landing on (or
  // extremely near) the corridor's flat baseline value, where the correct
  // closure legitimately covers almost the whole coastline except one tiny
  // notch — the scenario that exposed the bug.
  const contourCount = 8;
  const level = sortedVals[Math.round((1 / (contourCount + 1)) * (sortedVals.length - 1))];

  const segments = MarchingSquares.getContourLines(grid, rows, cols, bounds, level);
  const stitched = GSRSpatialClustering.stitchSegments(segments);
  const { closed, open } = openClosedSplit(stitched);
  assert(closed.length > 0 || open.length > 0, 'Sanity: this level touches the mask boundary (closed or open path present)');

  const rings = open.length > 0 ? ContourRingGeometry.closeOpenPaths(open, ContourRingGeometry.buildBoundaryLoops(grid, rows, cols, bounds), level) : closed;
  assert(rings.length > 0, 'Outermost band closes into at least one ring');

  const loops = ContourRingGeometry.buildBoundaryLoops(grid, rows, cols, bounds);
  const maskLoop = loops.find((l, i) => i !== 0); // index 0 is always the rectangle
  assert(maskLoop, 'Sanity: a mask coastline loop exists for this grid');

  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  maskLoop.points.forEach(p => {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  });
  // A little slack for the tangent-extrapolated tips at the actual closing
  // notch (those legitimately extend a short distance past the coastline) —
  // but nowhere near enough to hide a whole-loop rectangle-scale bulge.
  const slack = 0.15 * maskLoop.diag;

  rings.forEach((ring, i) => {
    ring.forEach(p => {
      assert(
        p.lat >= minLat - slack && p.lat <= maxLat + slack &&
        p.lon >= minLon - slack && p.lon <= maxLon + slack,
        `Ring ${i} point (${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}) lies far outside the real ` +
        `mask coastline's own extent (lat [${minLat.toFixed(4)}, ${maxLat.toFixed(4)}], ` +
        `lon [${minLon.toFixed(4)}, ${maxLon.toFixed(4)}]) — this is the reported ` +
        `"huge, disconnected green blob" bug`
      );
    });
  });
  console.log('✓ Outermost band\'s closed ring stays within the real mask coastline\'s own extent (no disconnected blob)');
}

console.log('\n============================================================');
console.log('Masked-Grid Isoband Regression Test: ALL PASSED');
console.log('============================================================');
