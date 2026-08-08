/**
 * Regression tests for _closeOpenIsobandPaths / _tangentExtrapolate — closing
 * isoband fills at the edge of the grid/map extent so they read as continuing
 * into an unbounded field (extrapolated past the edge along their own tangent,
 * or — when the correct side to close on isn't the immediately-adjacent one —
 * walking the real boundary-data stretch, nudged outward, instead of a literal
 * rectangle) rather than being squared off with straight lines.
 *
 * Which pair of open ends belong together, and which way to walk, is decided
 * from the real grid's own boundary values, not guessed from arc length (the
 * bug in an earlier version of this code) or given up on in favor of a blocky
 * per-cell tiling (a later, blockier workaround). There's no clip-path and no
 * invisible geometry any more: the export canvas is grown up front
 * (_expandCanvasForIsobands) to fit whatever the closure produces, so
 * everything drawn here is meant to be visible.
 *
 * Run: node visualiser/tests/test_isoband_boundary_closure.js
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

loadModule(path.join(__dirname, '../stats_math.js'),      'StatsMath');
loadModule(path.join(__dirname, '../map_colors.js'),      'MapColors');
loadModule(path.join(__dirname, '../geo_utils.js'),       'GeoUtils');
loadModule(path.join(__dirname, '../marching_squares.js'),'MarchingSquares');
loadModule(path.join(__dirname, '../spatial_clustering.js'), 'GSRSpatialClustering');
loadModule(path.join(__dirname, '../hillshade.js'),       'Hillshade');
loadModule(path.join(__dirname, '../map_exporter.js'),   'GSRMapExporter');

const { MarchingSquares, GSRSpatialClustering, GeoUtils } = global;
const GSRMapExporter = global.GSRMapExporter;

console.log('── Running Isoband Boundary Closure Regression Test ──');

function openPathsFor(grid, rows, cols, bounds, level) {
  const segments = MarchingSquares.getContourLines(grid, rows, cols, bounds, level);
  const stitched = GSRSpatialClustering.stitchSegments(segments);
  return stitched.filter(p => {
    const a = p[0], b = p[p.length - 1];
    return Math.hypot(a.lat - b.lat, a.lon - b.lon) > 1e-9;
  });
}

function shoelaceArea(ring) {
  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const p1 = ring[i], p2 = ring[(i + 1) % ring.length];
    area += p1.lon * p2.lat - p2.lon * p1.lat;
  }
  return Math.abs(area) / 2;
}

// Renders a flat point ring exactly the way _surface()'s fillRing does: Chaikin
// pre-smoothing, then _pathD with close=true, smooth=true.
function renderRing(ring, project) {
  const smoothed = GeoUtils.chaikinSmooth(ring, 2, true);
  return GSRMapExporter._pathD({ project }, smoothed, true, true);
}

function samplesFromPathD(d) {
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
      const c1 = { x: nums[0], y: nums[1] }, c2 = { x: nums[2], y: nums[3] }, p = { x: nums[4], y: nums[5] };
      for (let t = 0.05; t <= 1.0001; t += 0.05) {
        const mt = 1 - t;
        samples.push({
          x: mt * mt * mt * cur.x + 3 * mt * mt * t * c1.x + 3 * mt * t * t * c2.x + t * t * t * p.x,
          y: mt * mt * mt * cur.y + 3 * mt * mt * t * c1.y + 3 * mt * t * t * c2.y + t * t * t * p.y
        });
      }
      cur = p;
    }
  });
  return samples;
}

// ── Test 1: corner-pinned peak — the original bug report ──────────────────────
{
  const rows = 5, cols = 5;
  const grid = [
    [0.1, 0.1, 0.2, 3.0, 3.0],
    [0.1, 0.1, 0.2, 3.0, 3.0],
    [0.1, 0.1, 0.2, 0.3, 0.3],
    [0.1, 0.1, 0.1, 0.2, 0.2],
    [0.1, 0.1, 0.1, 0.1, 0.1]
  ];
  const bounds = { minLat: 49.9, maxLat: 50.0, minLon: 0.0, maxLon: 0.1 };
  const level = 1.5;

  const openPaths = openPathsFor(grid, rows, cols, bounds, level);
  assert.strictEqual(openPaths.length, 1, 'Corner-pinned peak produces exactly one open isoline');

  const rings = GSRMapExporter._closeOpenIsobandPaths(openPaths, grid, rows, cols, bounds, level);
  assert.strictEqual(rings.length, 1, 'Exactly one closed ring is produced');
  assert(rings[0].length >= 3, 'Closed ring has a real polygon shape');

  const project = (ll) => ({ x: ll.lon * 20000, y: (50 - ll.lat) * 20000 });
  const d = renderRing(rings[0], project);
  assert(d.includes(' C'), 'Closed edge-pinned isoband is rendered with smooth Bézier curves, not straight/blocky segments');
  assert(d.trim().endsWith('Z'), 'Closed edge-pinned isoband path is a closed loop');
  console.log('✓ Corner-pinned peak closes into one smooth, closed isoband (no blocky tiling)');
}

// ── Test 2: adversarial case — the correct closing side is the LONG way around ─
// Almost the entire boundary is "inside" the band except a small notch on the
// left edge. An earlier (reverted) version of this code picked whichever arc
// between the two open ends was numerically *shorter* — here that's the tiny
// notch-side arc, which is wrong (it's outside the band). A later version
// (tangent-extrapolate the open path and bridge its own two ends directly, with
// no boundary walk at all) also got this wrong in a different way: it silently
// dropped the entire rest of the "inside" area, filling only a small sliver near
// the notch instead of almost the whole grid. The fix must actually enclose the
// large "inside" area, which this test checks directly via the true rendered
// area rather than inspecting internal traversal details.
{
  const rows = 9, cols = 9;
  const grid = Array.from({ length: rows }, () => new Array(cols).fill(3.0));
  grid[3][0] = 0.1; grid[4][0] = 0.1; grid[5][0] = 0.1; // small low notch on the left edge
  const bounds = { minLat: 49.9, maxLat: 50.0, minLon: 0.0, maxLon: 0.1 };
  const level = 1.5;

  const openPaths = openPathsFor(grid, rows, cols, bounds, level);
  assert.strictEqual(openPaths.length, 1, 'Notch produces exactly one open isoline');

  const rings = GSRMapExporter._closeOpenIsobandPaths(openPaths, grid, rows, cols, bounds, level);
  assert.strictEqual(rings.length, 1, 'Exactly one closed ring is produced');

  const latSpan = bounds.maxLat - bounds.minLat, lonSpan = bounds.maxLon - bounds.minLon;
  const gridArea = latSpan * lonSpan;
  const ringArea = shoelaceArea(rings[0]);

  // The correct fill covers essentially the whole grid (minus a tiny notch) and
  // then extends further still past the edges (by design, since the boundary
  // walk nudges outward and the open ends extrapolate past the edge too) — so
  // its area should be comfortably *larger* than the grid's own area, not a
  // small fraction of it (the bug this test catches produced ~20%).
  assert(
    ringArea > 0.8 * gridArea,
    `Closed ring encloses (comfortably more than) the grid's own area — i.e. took the LONG (correct) ` +
    `way around instead of just bridging the notch's two ends directly (ring area=${ringArea.toExponential(3)}, grid area=${gridArea.toExponential(3)})`
  );
  console.log(`✓ Adversarial case correctly encloses the large "inside" region via the LONG boundary walk (ring area ${(ringArea / gridArea).toFixed(2)}x grid area), not the small wrong sliver`);
}

// ── Test 3: edge isolines extrapolate past the boundary (no square-off), stay
// smooth (no straight lines), and nothing needs to be hidden ──────────────────
// By design, the rendered curve now deliberately extends past the real domain
// bounds — that's the "infinite field" look: rather than being squared off
// against the boundary rectangle with straight lines, each open end continues
// along its own tangent past the edge, and — where a longer closure is needed —
// the walk is built from real, per-node boundary data (nudged outward) rather
// than literal rectangle edges. What this checks: (a) the rendered fill is a
// single smooth closed curve (Bézier throughout, no straight-line segments
// introduced by this code), and (b) it clears the boundary by a healthy margin
// rather than grazing it, consistent with the canvas being grown
// (_expandCanvasForIsobands) rather than anything being clipped away.
{
  const cases = [
    {
      name: 'corner-pinned',
      rows: 5, cols: 5,
      grid: [
        [0.1, 0.1, 0.2, 3.0, 3.0],
        [0.1, 0.1, 0.2, 3.0, 3.0],
        [0.1, 0.1, 0.2, 0.3, 0.3],
        [0.1, 0.1, 0.1, 0.2, 0.2],
        [0.1, 0.1, 0.1, 0.1, 0.1]
      ],
      bounds: { minLat: 49.9, maxLat: 50.0, minLon: 0.0, maxLon: 0.1 },
      level: 1.5
    },
    {
      name: 'long-arc-notch',
      rows: 9, cols: 9,
      grid: (() => {
        const g = Array.from({ length: 9 }, () => new Array(9).fill(3.0));
        g[3][0] = 0.1; g[4][0] = 0.1; g[5][0] = 0.1;
        return g;
      })(),
      bounds: { minLat: 49.9, maxLat: 50.0, minLon: 0.0, maxLon: 0.1 },
      level: 1.5
    },
    {
      name: 'two-humps-same-edge', // two separate open paths that must NOT be
      // confused with each other when the closure is built
      rows: 9, cols: 9,
      grid: (() => {
        const g = Array.from({ length: 9 }, () => new Array(9).fill(0.1));
        for (let c = 1; c <= 2; c++) { g[8][c] = 3.0; g[7][c] = 3.0; }
        for (let c = 6; c <= 7; c++) { g[8][c] = 3.0; g[7][c] = 3.0; }
        return g;
      })(),
      bounds: { minLat: 49.9, maxLat: 50.0, minLon: 0.0, maxLon: 0.1 },
      level: 1.5
    }
  ];

  const SCALE = 200000;
  const project = (ll) => ({ x: ll.lon * SCALE, y: ll.lat * SCALE });

  cases.forEach(({ name, rows, cols, grid, bounds, level }) => {
    const openPaths = openPathsFor(grid, rows, cols, bounds, level);
    const rings = GSRMapExporter._closeOpenIsobandPaths(openPaths, grid, rows, cols, bounds, level);
    assert(rings.length > 0, `${name}: at least one ring produced`);

    rings.forEach((ring, i) => {
      const d = renderRing(ring, project);

      // The visible curve must actually extend past the boundary now — that's
      // the point of this feature — and must do so smoothly (Bézier), not with
      // a straight-line square-off right at the edge.
      assert(d.includes(' C'), `${name} ring ${i}: still uses smooth Bézier curves`);
      assert(d.trim().endsWith('Z'), `${name} ring ${i}: is a closed loop`);

      const samples = samplesFromPathD(d).map(p => ({ lon: p.x / SCALE, lat: p.y / SCALE }));
      const latSpan = bounds.maxLat - bounds.minLat, lonSpan = bounds.maxLon - bounds.minLon;
      const minSpan = Math.min(latSpan, lonSpan);

      let maxOutsideDepth = 0;
      samples.forEach(p => {
        const outLon = Math.max(bounds.minLon - p.lon, p.lon - bounds.maxLon, 0);
        const outLat = Math.max(bounds.minLat - p.lat, p.lat - bounds.maxLat, 0);
        maxOutsideDepth = Math.max(maxOutsideDepth, Math.hypot(outLon, outLat));
      });

      // Deliberately modest margin (not many multiples of the map span) — the
      // curve clears the boundary by a healthy-but-sane amount rather than going
      // far out into effectively unbounded territory (the canvas is grown to
      // fit exactly this, not some arbitrarily large distance).
      assert(
        maxOutsideDepth > 0.05 * minSpan,
        `${name} ring ${i}: extrapolated/nudged curve clears the boundary by a healthy margin, not just barely (depth=${maxOutsideDepth.toFixed(5)}, span=${minSpan})`
      );
    });
  });
  console.log('✓ Isoband curves extrapolate smoothly past the edge as closed Bézier loops, with a healthy visible margin');
}

// ── Test 4: performance sanity — closure stays fast at worst-case grid/contour
// settings ──────────────────────────────────────────────────────────────────
{
  const rows = 80, cols = 80;
  const grid = Array.from({ length: rows }, (_, r) =>
    Array.from({ length: cols }, (_, c) => {
      const dr = r - 78, dc = c - 78;
      return 3.0 * Math.exp(-(dr * dr + dc * dc) / 300);
    })
  );
  const bounds = { minLat: 49.9, maxLat: 50.0, minLon: 0.0, maxLon: 0.1 };
  const sortedVals = grid.flat().slice().sort((a, b) => a - b);
  const contourCount = 25;

  const t0 = Date.now();
  let totalRings = 0;
  for (let k = 1; k <= contourCount; k++) {
    const pct = k / (contourCount + 1);
    const idx = Math.min(sortedVals.length - 1, Math.round(pct * (sortedVals.length - 1)));
    const level = sortedVals[idx];
    const openPaths = openPathsFor(grid, rows, cols, bounds, level);
    totalRings += GSRMapExporter._closeOpenIsobandPaths(openPaths, grid, rows, cols, bounds, level).length;
  }
  const elapsedMs = Date.now() - t0;
  assert(elapsedMs < 2000, `Closure across 25 contour levels on an 80x80 grid completes quickly (${elapsedMs}ms)`);
  console.log(`✓ Worst-case closure (80x80 grid, 25 levels, ${totalRings} rings) completed in ${elapsedMs}ms`);
}

// ── Test 5: _expandCanvasForIsobands actually grows the canvas to fit ────────
// Nothing should be hidden any more: the canvas must grow (and the projection
// shift) so the full extrapolated/nudged isoband geometry lands inside it.
{
  const rows = 20, cols = 20;
  const grid = Array.from({ length: rows }, (_, r) =>
    Array.from({ length: cols }, (_, c) => {
      const dr = r - 19, dc = c - 19;
      return 3.0 * Math.exp(-(dr * dr + dc * dc) / 60);
    })
  );
  const bounds = { minLat: 49.9, maxLat: 50.0, minLon: 0.0, maxLon: 0.1 };
  const sortedVals = grid.flat().slice().sort((a, b) => a - b);
  const contourCount = 5;
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
  const ctx = {
    map: { latLngToContainerPoint: project },
    el: { querySelectorAll: () => [], querySelector: () => null },
    r: { left: 0, top: 0 }, w: 2000, h: 2000, project,
    mgr: { surfaceData: { grid, minVal: 0, maxVal: 3, bounds, sortedVals, contours } }
  };

  const expanded = GSRMapExporter._expandCanvasForIsobands(ctx);
  assert(expanded.w >= ctx.w && expanded.h >= ctx.h, 'Expanded canvas is at least as large as the original');
  assert(expanded.w > ctx.w || expanded.h > ctx.h, 'Canvas actually grows for a corner-pinned peak whose contours extrapolate past the frame');

  // Re-render the isoband layer against the EXPANDED projection and confirm the
  // real, full geometry now lands entirely inside the new canvas — nothing
  // clipped, nothing left hanging outside.
  const surf = GSRMapExporter._surface(expanded);
  assert(surf.isobands.length > 0, 'Sanity: isobands are actually produced');
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  surf.isobands.forEach(p => {
    const m = p.match(/d="([^"]*)"/);
    if (!m) return;
    const bbox = GSRMapExporter._pathBBox(m[1]);
    if (!bbox) return;
    minX = Math.min(minX, bbox.minX); minY = Math.min(minY, bbox.minY);
    maxX = Math.max(maxX, bbox.maxX); maxY = Math.max(maxY, bbox.maxY);
  });
  const EPS = 0.5;
  assert(
    minX >= -EPS && minY >= -EPS && maxX <= expanded.w + EPS && maxY <= expanded.h + EPS,
    `All isoband geometry fits within the expanded canvas (bbox=[${minX.toFixed(1)},${minY.toFixed(1)},${maxX.toFixed(1)},${maxY.toFixed(1)}], canvas=${expanded.w}x${expanded.h})`
  );
  console.log(`✓ _expandCanvasForIsobands grows the canvas (${ctx.w}x${ctx.h} → ${expanded.w}x${expanded.h}) to fit the full isoband geometry with nothing clipped`);
}

// ── Test 6: _expandCanvasForIsobands shifts ctx.r by the same margin it
// shifts the vector projection by, so _tiles() (which positions tiles from
// raw getBoundingClientRect() values against ctx.r, not through project())
// stays aligned with the expanded canvas instead of being left anchored to
// the pre-expansion origin. Reported bug: exported maps were missing a
// chunk of background tiles (reported as "bottom right, about half") —
// traced to exactly this: ctx.r was never touched by this function, so any
// marginLeft/marginTop shift here silently misaligned the whole tile layer
// against the (correctly shifted) vector layers built on top of it.
{
  const rows = 20, cols = 20;
  const grid = Array.from({ length: rows }, (_, r) =>
    Array.from({ length: cols }, (_, c) => {
      // Peak pinned near the bottom-right corner (high row/col), same shape
      // Test 5 uses — extrapolates the isoband curve out past the right and
      // bottom edges, and (since the curve must sweep to clear the corner)
      // typically past the left/top too, giving all four margins a real,
      // independently-checkable, non-zero value on one fixture.
      const dr = r - 19, dc = c - 19;
      return 3.0 * Math.exp(-(dr * dr + dc * dc) / 60);
    })
  );
  const bounds = { minLat: 49.9, maxLat: 50.0, minLon: 0.0, maxLon: 0.1 };
  const sortedVals = grid.flat().slice().sort((a, b) => a - b);
  const contours = [];
  for (let k = 1; k <= 5; k++) {
    const pct = k / 6;
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
  // A non-zero starting r (mirrors a real map container that isn't flush
  // against the browser viewport's top-left corner) so this doesn't
  // coincidentally pass just because 0 - margin == -margin either way.
  const ctx = {
    map: { latLngToContainerPoint: project },
    el: { querySelectorAll: () => [], querySelector: () => null },
    r: { left: 317, top: 144 }, w: 2000, h: 2000, project,
    mgr: { surfaceData: { grid, minVal: 0, maxVal: 3, bounds, sortedVals, contours } }
  };
  const expanded = GSRMapExporter._expandCanvasForIsobands(ctx);
  const marginLeft = ctx.w === expanded.w && ctx.r.left === expanded.r.left ? 0 : (ctx.r.left - expanded.r.left);
  const marginTop = ctx.h === expanded.h && ctx.r.top === expanded.r.top ? 0 : (ctx.r.top - expanded.r.top);
  assert(expanded !== ctx, 'Sanity: this fixture actually triggers canvas expansion (same shape as Test 5)');
  assert(marginLeft > 0 && marginTop > 0, `Sanity: fixture produces non-zero left/top margins to actually exercise the r-shift (marginLeft=${marginLeft}, marginTop=${marginTop})`);

  // The shift applied to ctx.r must exactly match the shift baked into the
  // new project() function — i.e. a point that projected to the same pixel
  // as a tile's raw screen position before expansion must still coincide
  // with that tile's re-derived position after expansion.
  const oldProjected = project({ lat: 49.95, lon: 0.05 }); // arbitrary point inside the original frame
  const newProjected = expanded.project({ lat: 49.95, lon: 0.05 });
  const tileOldRelX = oldProjected.x; // a tile drawn at this raw offset from the OLD r
  const tileOldRelY = oldProjected.y;
  // _tiles() computes `b.left - r.left`; here b.left stands in for
  // `ctx.r.left + tileOldRelX` (a tile whose getBoundingClientRect() was
  // measured against the pre-expansion container position).
  const bLeft = ctx.r.left + tileOldRelX;
  const bTop = ctx.r.top + tileOldRelY;
  const tileNewRelX = bLeft - expanded.r.left;
  const tileNewRelY = bTop - expanded.r.top;
  assert.strictEqual(tileNewRelX, newProjected.x, 'Tile position (re-derived via the shifted r) lands exactly where the same real-world point now projects to after expansion');
  assert.strictEqual(tileNewRelY, newProjected.y, 'Tile position (re-derived via the shifted r) lands exactly where the same real-world point now projects to after expansion (Y)');
  console.log(`✓ _expandCanvasForIsobands shifts ctx.r (left -${marginLeft}, top -${marginTop}) to keep tile placement aligned with the expanded vector coordinate space`);
}

// ── Test 7: _ensureTileCoverage temporarily inflates what map.getSize()
// reports so Leaflet's GridLayer._update() — whose fetch range is built
// purely from map.getSize(), NOT from keepBuffer (verified against
// leaflet@1.9.4's actual source: keepBuffer only controls which ALREADY-
// loaded tiles survive a prune on pan, it plays no part in deciding what
// gets newly fetched) — requests tiles covering ctx.tileMargin before
// capture, instead of leaving it as genuinely-undownloaded geography (see
// _expandCanvasForIsobands's tileMargin doc comment — the deeper bug behind
// Test 6's misalignment fix: even with tiles correctly repositioned, a
// margin the live viewport never showed was never downloaded in the first
// place, reported as a solid blank/black region wherever the isobands
// pushed the canvas out furthest). An earlier version of this fix bumped
// keepBuffer instead, which — per the source check above — never actually
// requested any extra tiles at all. Fakes stand in for Leaflet's real Map/
// GridLayer, modeling only the getSize()/_update()/_noTilesToLoad()/on()/
// off() surface _ensureTileCoverage actually touches.
(async () => {
  function fakePoint(x, y) {
    return {
      x, y,
      add(other) { return fakePoint(this.x + (other.x || 0), this.y + (other.y || 0)); }
    };
  }

  function fakeMap(size) {
    return {
      _size: size,
      getSize() { return this._size; },
      getCenter: () => ({ lat: 1, lon: 2 })
    };
  }

  function fakeLayer(mapRef) {
    const handlers = {};
    return {
      _updateCalls: 0,
      _sizeSeenDuringUpdate: null,
      _loaded: true,
      getTileSize: () => ({ x: 256, y: 256 }),
      _update(center) {
        this._updateCalls++;
        this._updateCenter = center;
        // Real GridLayer._update() calls this._map.getSize() internally
        // (via _getTiledPixelBounds) to compute the tile fetch range —
        // mirror that here so the test can see what getSize() reported at
        // the moment _update() actually ran.
        this._sizeSeenDuringUpdate = mapRef.getSize();
      },
      _noTilesToLoad() { return this._loaded; },
      on(evt, fn) { handlers[evt] = fn; },
      off(evt, fn) { if (handlers[evt] === fn) delete handlers[evt]; },
      _fireLoad() { if (handlers.load) handlers.load(); }
    };
  }

  // 7a: _update() sees an INFLATED getSize() (original + 2x the largest
  // margin, in both axes) while it runs, and getSize() reports the real,
  // unchanged size again immediately afterward — the synchronous window
  // Leaflet's createTile() uses to kick off each new tile's network fetch.
  {
    const map = fakeMap(fakePoint(800, 600));
    const layer = fakeLayer(map);
    layer._loaded = false; // tiles not yet loaded when _update() is called
    const mgr = { baseTileLayer: layer, map };
    const ctx = { tileMargin: { left: 801, top: 73, right: 0, bottom: 0 } };
    const pending = GSRMapExporter._ensureTileCoverage(ctx, mgr);

    assert.strictEqual(layer._updateCalls, 1, '_update() is called once to request the wider area');
    assert.strictEqual(layer._sizeSeenDuringUpdate.x, 800 + 801 * 2, 'getSize() reports an inflated width (original + 2x the largest margin) while _update() runs');
    assert.strictEqual(layer._sizeSeenDuringUpdate.y, 600 + 801 * 2, 'getSize() inflates height too, so the extra reach applies in every direction, not just the axis the margin happened to be on');
    assert.strictEqual(map.getSize().x, 800, 'getSize() reports the real, original size again once _update() has returned');

    layer._fireLoad();
    await pending;
    console.log('✓ _ensureTileCoverage temporarily inflates map.getSize() during _update(), then restores it');
  }

  // 7b: no tileMargin (canvas was never expanded) and a missing layer both
  // resolve harmlessly — this step must never hang or throw and break the
  // rest of the export.
  {
    await GSRMapExporter._ensureTileCoverage({}, { baseTileLayer: null, map: {} });
    await GSRMapExporter._ensureTileCoverage({ tileMargin: { left: 500, top: 0, right: 0, bottom: 0 } }, { baseTileLayer: null, map: {} });
    console.log('✓ _ensureTileCoverage resolves harmlessly with no tileMargin or no tile layer');
  }

  console.log('\n============================================================');
  console.log('Isoband Boundary Closure Regression Test: ALL PASSED');
  console.log('============================================================');
})();
