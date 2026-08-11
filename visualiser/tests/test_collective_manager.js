/**
 * Unit tests for collective_manager.js (GSRCollectiveManager) — multi-track
 * spatial aggregation (track bookkeeping, bounding box, contour surface
 * generation).
 *
 * NOTE: generateContourSurface()'s topographySource selection ('phasic',
 * 'tonic', 'peaks', 'auc', 'arousal_index', with/without normalizeZScore) is
 * already exercised end-to-end against a real GSRAnalyzer in
 * tests/test_all_pipelines.js — this file focuses on what that coverage
 * doesn't touch: the constructor and plain track bookkeeping (addTrack,
 * removeTrack, getTrack, getActiveTracks), getBounds() in isolation (never
 * called directly in the existing suites), and generateContourSurface() edge
 * cases (no tracks / no active tracks / no coordinates, default
 * contourParams, isolationRadius masking producing null grid cells, and
 * peak exclusion).
 *
 * Run: node --test tests/test_collective_manager.js  (or `npm test` for the whole suite)
 */

const assert = require('assert');
const test = require('node:test');

global.GSR_CONST = require('./mock_constants.js');
global.MarchingSquares = require('../marching_squares.js').MarchingSquares;

const { GSRCollectiveManager } = require('../collective_manager.js');

/**
 * Builds a minimal mock "analyzer" exposing exactly the surface
 * GSRCollectiveManager reads: .raw (length only matters), .getCoordinates(i),
 * .sampleRate, phasic/tonic (+Z variants), .phasicAUC, .arousalIndex,
 * .phasicStd, and .peaks.
 */
function makeAnalyzer(points, opts = {}) {
  return {
    raw: new Array(points.length).fill(0),
    getCoordinates: (i) => points[i] || null,
    sampleRate: opts.sampleRate !== undefined ? opts.sampleRate : 1,
    phasic: opts.phasic || [],
    phasicZ: opts.phasicZ || [],
    tonic: opts.tonic || [],
    tonicZ: opts.tonicZ || [],
    phasicAUC: opts.phasicAUC || [],
    arousalIndex: opts.arousalIndex || [],
    phasicStd: opts.phasicStd !== undefined ? opts.phasicStd : 1,
    peaks: opts.peaks || [],
  };
}

function makeTrack(id, points, opts = {}) {
  return {
    id,
    name: opts.name || `${id}.csv`,
    color: opts.color || '#000',
    enabled: opts.enabled !== undefined ? opts.enabled : true,
    analyzer: makeAnalyzer(points, opts),
  };
}

// ── constructor ──────────────────────────────────────────────────────────

test('constructor: starts with an empty tracks array', () => {
  const mgr = new GSRCollectiveManager();
  assert.deepStrictEqual(mgr.tracks, []);
});

// ── addTrack / getTrack / removeTrack / getActiveTracks ─────────────────

test('addTrack: appends tracks and preserves insertion order', () => {
  const mgr = new GSRCollectiveManager();
  const t1 = makeTrack('a', []);
  const t2 = makeTrack('b', []);
  mgr.addTrack(t1);
  mgr.addTrack(t2);
  assert.deepStrictEqual(mgr.tracks, [t1, t2]);
});

test('getTrack: finds a track by id, returns undefined when absent', () => {
  const mgr = new GSRCollectiveManager();
  const t1 = makeTrack('a', []);
  mgr.addTrack(t1);
  assert.strictEqual(mgr.getTrack('a'), t1);
  assert.strictEqual(mgr.getTrack('missing'), undefined);
});

test('removeTrack: removes only the matching id and leaves the rest intact', () => {
  const mgr = new GSRCollectiveManager();
  const t1 = makeTrack('a', []);
  const t2 = makeTrack('b', []);
  const t3 = makeTrack('c', []);
  mgr.addTrack(t1); mgr.addTrack(t2); mgr.addTrack(t3);
  mgr.removeTrack('b');
  assert.deepStrictEqual(mgr.tracks, [t1, t3]);
});

test('removeTrack: removing a non-existent id is a harmless no-op', () => {
  const mgr = new GSRCollectiveManager();
  const t1 = makeTrack('a', []);
  mgr.addTrack(t1);
  mgr.removeTrack('does-not-exist');
  assert.deepStrictEqual(mgr.tracks, [t1]);
});

test('getActiveTracks: filters to only enabled tracks', () => {
  const mgr = new GSRCollectiveManager();
  const on1 = makeTrack('a', [], { enabled: true });
  const off = makeTrack('b', [], { enabled: false });
  const on2 = makeTrack('c', [], { enabled: true });
  mgr.addTrack(on1); mgr.addTrack(off); mgr.addTrack(on2);
  assert.deepStrictEqual(mgr.getActiveTracks(), [on1, on2]);
});

test('getActiveTracks: a track with no `enabled` property at all is excluded', () => {
  const mgr = new GSRCollectiveManager();
  // Bypass makeTrack's enabled-defaults-to-true convenience so `enabled` is
  // truly absent (undefined), matching a freshly-constructed track object
  // before the UI has set the flag.
  mgr.addTrack({ id: 'a', analyzer: makeAnalyzer([]) });
  assert.deepStrictEqual(mgr.getActiveTracks(), []);
});

// ── getBounds() ───────────────────────────────────────────────────────────

test('getBounds: returns null when there are no tracks at all', () => {
  const mgr = new GSRCollectiveManager();
  assert.strictEqual(mgr.getBounds(), null);
});

test('getBounds: returns null when no tracks are enabled', () => {
  const mgr = new GSRCollectiveManager();
  mgr.addTrack(makeTrack('a', [{ lat: 51.5, lon: -0.1 }], { enabled: false }));
  assert.strictEqual(mgr.getBounds(), null);
});

test('getBounds: returns null when active tracks have no resolvable coordinates', () => {
  const mgr = new GSRCollectiveManager();
  mgr.addTrack(makeTrack('a', [null, null, null]));
  assert.strictEqual(mgr.getBounds(), null);
});

test('getBounds: a single point falls back to a fixed 0.001 deg pad (zero span)', () => {
  const mgr = new GSRCollectiveManager();
  mgr.addTrack(makeTrack('a', [{ lat: 51.5, lon: -0.1 }]));
  const bounds = mgr.getBounds();
  assert.ok(Math.abs(bounds.minLat - (51.5 - 0.001)) < 1e-9);
  assert.ok(Math.abs(bounds.maxLat - (51.5 + 0.001)) < 1e-9);
  assert.ok(Math.abs(bounds.minLon - (-0.1 - 0.001)) < 1e-9);
  assert.ok(Math.abs(bounds.maxLon - (-0.1 + 0.001)) < 1e-9);
});

test('getBounds: computes a tight bbox with 10% padding across multiple points and tracks', () => {
  const mgr = new GSRCollectiveManager();
  mgr.addTrack(makeTrack('a', [{ lat: 51.0, lon: 0.0 }, { lat: 51.1, lon: 0.05 }]));
  mgr.addTrack(makeTrack('b', [{ lat: 50.9, lon: -0.05 }]));
  const bounds = mgr.getBounds();

  const minLat = 50.9, maxLat = 51.1, minLon = -0.05, maxLon = 0.05;
  const latPad = (maxLat - minLat) * 0.10;
  const lonPad = (maxLon - minLon) * 0.10;
  assert.ok(Math.abs(bounds.minLat - (minLat - latPad)) < 1e-9);
  assert.ok(Math.abs(bounds.maxLat - (maxLat + latPad)) < 1e-9);
  assert.ok(Math.abs(bounds.minLon - (minLon - lonPad)) < 1e-9);
  assert.ok(Math.abs(bounds.maxLon - (maxLon + lonPad)) < 1e-9);
});

test('getBounds: disabled tracks do not influence the bbox of enabled ones', () => {
  const mgr = new GSRCollectiveManager();
  mgr.addTrack(makeTrack('a', [{ lat: 51.0, lon: 0.0 }]));
  mgr.addTrack(makeTrack('b', [{ lat: 60.0, lon: 10.0 }], { enabled: false }));
  const bounds = mgr.getBounds();
  assert.ok(bounds.maxLat < 55, 'the disabled far-away track must not widen the bbox');
});

// ── generateContourSurface() edge cases ──────────────────────────────────

test('generateContourSurface: returns [] when there are no tracks', () => {
  const mgr = new GSRCollectiveManager();
  assert.deepStrictEqual(mgr.generateContourSurface({ gridResolution: 10, contourCount: 3 }), []);
});

test('generateContourSurface: returns [] when no tracks are enabled', () => {
  const mgr = new GSRCollectiveManager();
  mgr.addTrack(makeTrack('a', [{ lat: 51.5, lon: -0.1 }], { enabled: false }));
  assert.deepStrictEqual(mgr.generateContourSurface({}), []);
});

test('generateContourSurface: returns [] when contourParams is omitted entirely (falls back to GSR_CONST.COLLECTIVE)', () => {
  const mgr = new GSRCollectiveManager();
  // No tracks -> short-circuits before gridResolution/contourCount even matter,
  // but this exercises the `if (!contourParams) contourParams = {}` branch
  // and the GSR_CONST.COLLECTIVE default lookups without throwing.
  assert.doesNotThrow(() => {
    const result = mgr.generateContourSurface();
    assert.deepStrictEqual(result, []);
  });
});

test('generateContourSurface: a track with points that all resolve to null coordinates yields []', () => {
  const mgr = new GSRCollectiveManager();
  mgr.addTrack(makeTrack('a', [null, null]));
  assert.deepStrictEqual(mgr.generateContourSurface({ gridResolution: 10, contourCount: 3 }), []);
});

function gridTrack(rows = 6, cols = 6, spacingDeg = 0.001) {
  // A small regular lattice of GPS points with a phasic value gradient so
  // there's real variation for IDW/contouring to work with.
  const points = [];
  const phasic = [];
  let i = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      points.push({ lat: 51.5 + r * spacingDeg, lon: -0.1 + c * spacingDeg });
      phasic.push({ time: i, val: r + c });
      i++;
    }
  }
  return makeTrack('grid', points, { phasic, phasicZ: phasic, sampleRate: 1 });
}

test('generateContourSurface: default gridResolution/contourCount come from GSR_CONST.COLLECTIVE when contourParams omits them', () => {
  const mgr = new GSRCollectiveManager();
  mgr.addTrack(gridTrack());
  const result = mgr.generateContourSurface({ isolationRadius: 500, normalizeZScore: false });
  assert.ok(Array.isArray(result.grid), 'should return a real surface object, not []');
  assert.strictEqual(result.grid.length, global.GSR_CONST.COLLECTIVE.gridResolution);
  assert.strictEqual(result.grid[0].length, global.GSR_CONST.COLLECTIVE.gridResolution);

  // contourCount default: with this gradient fixture every one of the mock's
  // 10 default percentile levels lands on a distinct grid value, so the
  // count of generated contours should match GSR_CONST.COLLECTIVE.contourCount
  // exactly — distinguishing "used the real default" from an accidental
  // hardcoded count elsewhere in the level-generation loop.
  assert.strictEqual(result.contours.length, global.GSR_CONST.COLLECTIVE.contourCount);

  const overridden = mgr.generateContourSurface({ isolationRadius: 500, normalizeZScore: false, contourCount: 1 });
  assert.strictEqual(overridden.contours.length, 1, 'an explicit contourCount should override the default');
});

test('generateContourSurface: returns the expected shape { contours, grid, minVal, maxVal, bounds, sortedVals }', () => {
  const mgr = new GSRCollectiveManager();
  mgr.addTrack(gridTrack());
  const result = mgr.generateContourSurface({
    gridResolution: 12, contourCount: 4, isolationRadius: 500,
    idwExponent: 2, normalizeZScore: false,
  });
  assert.ok(Array.isArray(result.contours));
  assert.strictEqual(result.grid.length, 12);
  assert.strictEqual(typeof result.minVal, 'number');
  assert.strictEqual(typeof result.maxVal, 'number');
  assert.ok(result.maxVal >= result.minVal);
  assert.ok(result.bounds && typeof result.bounds.minLat === 'number');
  assert.ok(Array.isArray(result.sortedVals));
  for (const c of result.contours) {
    assert.strictEqual(typeof c.level, 'number');
    assert.strictEqual(typeof c.ratio, 'number');
    assert.ok(Array.isArray(c.segments));
  }
});

test('generateContourSurface: a narrow isolationRadius masks (nulls) grid cells far from the walked corridor', () => {
  const mgr = new GSRCollectiveManager();
  // A diagonal ~1.1km "walked path" of 30 points across the grid's bounding
  // box. With only a 15m isolation radius, cells away from the diagonal
  // corridor should be masked out (null) while cells right along it stay live.
  const N = 30;
  const points = [];
  const phasic = [];
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    points.push({ lat: 51.50 + t * 0.01, lon: -0.10 + t * 0.01 });
    phasic.push({ time: i, val: 1 });
  }
  mgr.addTrack(makeTrack('a', points, { phasic, phasicZ: phasic }));

  const result = mgr.generateContourSurface({
    gridResolution: 25, contourCount: 2, isolationRadius: 15, normalizeZScore: false,
  });
  assert.ok(Array.isArray(result.grid), 'should still produce a surface object');
  let nullCount = 0, total = 0;
  for (const row of result.grid) {
    for (const v of row) { total++; if (v === null) nullCount++; }
  }
  assert.ok(nullCount > 0, 'cells far from the narrow corridor should be masked out');
  assert.ok(nullCount < total, 'cells right along the corridor should remain unmasked');
});

test('generateContourSurface: peaks marked excluded are omitted from the "peaks" topography source', () => {
  const mgr = new GSRCollectiveManager();
  const sharedPoints = [{ lat: 51.5, lon: -0.1 }, { lat: 51.5005, lon: -0.1005 }];

  const withPeak = makeTrack('a', sharedPoints, {
    peaks: [{ index: 0, amplitude: 5, excluded: false }],
  });
  const excludedPeak = makeTrack('b', sharedPoints, {
    peaks: [{ index: 0, amplitude: 5, excluded: true }],
  });

  const mgrWith = new GSRCollectiveManager();
  mgrWith.addTrack(withPeak);
  const mgrExcluded = new GSRCollectiveManager();
  mgrExcluded.addTrack(excludedPeak);

  const params = { gridResolution: 8, contourCount: 2, isolationRadius: 50, topographySource: 'peaks', normalizeZScore: false };
  const surfaceWith = mgrWith.generateContourSurface(params);
  const surfaceExcluded = mgrExcluded.generateContourSurface(params);

  // Note: minVal===maxVal grids get nudged apart by +0.1 (see the dedicated
  // "flat surface" test below), so a fully-zero (all peaks excluded) surface
  // would misleadingly report maxVal===0.1 too — assert on the raw grid
  // values collected in sortedVals instead, which are untouched by that nudge.
  assert.ok(surfaceWith.sortedVals.some(v => v > 0), 'a non-excluded peak should contribute positive KDE density somewhere in the grid');
  assert.ok(surfaceExcluded.sortedVals.every(v => v === 0), 'an excluded peak must not contribute any density to any grid cell');
});

test('generateContourSurface: minVal===maxVal (perfectly flat surface) is nudged apart to avoid a degenerate range', () => {
  const mgr = new GSRCollectiveManager();
  // Every point has the same phasic value -> IDW interpolates to a constant.
  const points = [{ lat: 51.5, lon: -0.1 }, { lat: 51.5001, lon: -0.1001 }, { lat: 51.4999, lon: -0.0999 }];
  const phasic = points.map((_, i) => ({ time: i, val: 3 }));
  mgr.addTrack(makeTrack('flat', points, { phasic, phasicZ: phasic }));

  const result = mgr.generateContourSurface({
    gridResolution: 6, contourCount: 2, isolationRadius: 500, normalizeZScore: false,
  });
  assert.ok(Array.isArray(result.grid));
  assert.ok(result.maxVal > result.minVal, 'degenerate flat range should be nudged apart by +0.1');
  assert.ok(Math.abs((result.maxVal - result.minVal) - 0.1) < 1e-9);
});

// ─── generateContourSurface perf fix (2026-08-07): boundary-mask + IDW splat ──
// docs/visualizer_architecture_refactor_plan.md Phase 7. Both the boundary
// mask (isNearTrack) and the IDW accumulation used to scan every point for
// every grid cell, computing then mostly discarding a distance; both are now
// point-major splats that only touch the small window of cells within range
// of each point. Verified byte-identical against the pre-fix implementation
// on real 4-track/700+-peak collective data (see the plan doc's Phase 7
// status note). This test pins the same guarantee with an independent
// brute-force reference (the literal pre-fix algorithm, reimplemented here
// rather than imported) against real result.bounds, so a future change to
// either implementation that silently diverges gets caught.
function bruteForceIdwGrid(points, bounds, rows, cols, isolationRadius, idwExponent) {
  const DEG_TO_M_LAT = 111320.0;
  const latMid = (bounds.minLat + bounds.maxLat) / 2;
  const DEG_TO_M_LON = 111320.0 * Math.cos(latMid * Math.PI / 180);
  const dist = (lat1, lon1, lat2, lon2) => {
    const dy = (lat1 - lat2) * DEG_TO_M_LAT;
    const dx = (lon1 - lon2) * DEG_TO_M_LON;
    return Math.sqrt(dx * dx + dy * dy);
  };
  const grid = Array.from({ length: rows }, () => new Array(cols).fill(null));
  for (let r = 0; r < rows; r++) {
    const gridLat = bounds.minLat + (r / (rows - 1)) * (bounds.maxLat - bounds.minLat);
    for (let c = 0; c < cols; c++) {
      const gridLon = bounds.minLon + (c / (cols - 1)) * (bounds.maxLon - bounds.minLon);
      let isNearTrack = false;
      for (const p of points) {
        if (dist(gridLat, gridLon, p.lat, p.lon) <= isolationRadius) { isNearTrack = true; break; }
      }
      if (!isNearTrack) { grid[r][c] = null; continue; }

      let sumWeightedVal = 0, sumWeight = 0, localMax = -Infinity, exactMatch = false;
      for (const p of points) {
        const d = dist(gridLat, gridLon, p.lat, p.lon);
        if (d < 1e-3) { grid[r][c] = p.phasic; exactMatch = true; break; }
        if (d <= isolationRadius * 1.5) {
          const w = 1.0 / Math.pow(d, idwExponent);
          sumWeightedVal += w * p.phasic;
          sumWeight += w;
          if (p.phasic > localMax) localMax = p.phasic;
        }
      }
      if (!exactMatch) {
        grid[r][c] = sumWeight > 0 ? 0.5 * (sumWeightedVal / sumWeight) + 0.5 * localMax : null;
      }
    }
  }
  return grid;
}

// generateContourSurface now applies a masked 3x3 tent blur to the raw IDW grid before
// returning it (contour-smoothing fix — see collective_manager.js), so the brute-force
// reference above must have the identical blur applied to stay a valid comparison; this
// re-derivation, not the raw IDW output, is what test cases below compare `result.grid`
// against.
function applyMaskedBlur(grid, rows, cols) {
  const blurred = Array.from({ length: rows }, () => new Array(cols).fill(null));
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (grid[r][c] === null || isNaN(grid[r][c])) { blurred[r][c] = grid[r][c]; continue; }
      let sum = 0, weight = 0;
      for (let dr = -1; dr <= 1; dr++) {
        const rr = r + dr;
        if (rr < 0 || rr >= rows) continue;
        for (let dc = -1; dc <= 1; dc++) {
          const cc = c + dc;
          if (cc < 0 || cc >= cols) continue;
          const v = grid[rr][cc];
          if (v === null || isNaN(v)) continue;
          const w = (dr === 0 && dc === 0) ? 4 : ((dr === 0 || dc === 0) ? 2 : 1);
          sum += v * w;
          weight += w;
        }
      }
      blurred[r][c] = weight > 0 ? sum / weight : grid[r][c];
    }
  }
  return blurred;
}

test('generateContourSurface: IDW grid matches an independent brute-force reference implementation', () => {
  // 5 points scattered at varied distances (some within isolationRadius*1.5
  // of each other, some not) with distinct phasic values, small enough that
  // checkStep (the boundary mask's own sampling stride) is 1 — every point
  // participates in both the reference and the real computation identically.
  const pts = [
    { lat: 51.5000, lon: -0.1000, phasic: 1.0 },
    { lat: 51.5003, lon: -0.1000, phasic: 2.0 },  // ~33m from pt0
    { lat: 51.5000, lon: -0.0990, phasic: 3.0 },  // ~69m from pt0 (east)
    { lat: 51.5020, lon: -0.1020, phasic: 4.0 },  // ~250m from pt0 (far)
    { lat: 51.4990, lon: -0.1010, phasic: 5.0 },  // ~140m from pt0 (south)
  ];
  const phasic = pts.map((p, i) => ({ time: i, val: p.phasic }));
  const mgr = new GSRCollectiveManager();
  mgr.addTrack(makeTrack('a', pts, { phasic, phasicZ: phasic }));

  // A fine grid (40x40, ~14m/cell over this fixture's bounds) so the splat
  // window genuinely spans several cells in each direction rather than
  // rounding up to the Math.max(1, ...) single-cell floor either way — a
  // coarser grid was tried first and turned out to mask a real window-sizing
  // bug entirely (both a correct and a 10x-too-small radius calculation
  // floored to the same 1-cell window at that resolution).
  const isolationRadius = 60, idwExponent = 2, gridResolution = 40;
  const result = mgr.generateContourSurface({
    gridResolution, contourCount: 3, isolationRadius, idwExponent,
    topographySource: 'phasic', normalizeZScore: false,
    blurIterations: 1, peakPreservation: 0.5, softening: 0.0
  });

  const rawExpected = bruteForceIdwGrid(pts, result.bounds, gridResolution, gridResolution, isolationRadius, idwExponent);
  const expected = applyMaskedBlur(rawExpected, gridResolution, gridResolution);

  let nonNullCells = 0;
  for (let r = 0; r < gridResolution; r++) {
    for (let c = 0; c < gridResolution; c++) {
      const actual = result.grid[r][c];
      const exp = expected[r][c];
      if (exp === null) {
        assert.strictEqual(actual, null, `cell [${r}][${c}]: expected null (far from every point), got ${actual}`);
      } else {
        assert.ok(actual !== null, `cell [${r}][${c}]: expected ${exp}, got null`);
        assert.ok(Math.abs(actual - exp) < 1e-6, `cell [${r}][${c}]: expected ${exp}, got ${actual}`);
        nonNullCells++;
      }
    }
  }
  assert.ok(nonNullCells > 0, 'precondition: at least some cells should be near enough to a point to have a value');
});

// ── §C perf fix: getContourLinesMulti correctness (2026-08-07) ───────────────
// Single-pass multi-isolevel output must be identical to K separate
// getContourLines() calls on the same grid and levels.

const { MarchingSquares: MS } = require('../marching_squares.js');

function segmentsToKey(segs) {
  // Canonical string for a segment array — order-invariant within each segment
  // (since {lat,lon} object identity differs), position-invariant across segments.
  return segs.map(s =>
    s.map(pt => `${pt.lat.toFixed(8)},${pt.lon.toFixed(8)}`).sort().join('|')
  ).sort().join(';');
}

function makeSyntheticGrid(rows, cols) {
  // Simple gradient grid: value = r + c (clear gradients for contour crossings)
  const grid = [];
  for (let r = 0; r < rows; r++) {
    grid[r] = [];
    for (let c = 0; c < cols; c++) grid[r][c] = r + c;
  }
  return grid;
}

const BOUNDS = { minLat: 51.0, maxLat: 52.0, minLon: -1.0, maxLon: 0.0 };

test('§C getContourLinesMulti: identical segments to K getContourLines() calls on a 5×5 gradient grid', () => {
  const rows = 5, cols = 5;
  const grid = makeSyntheticGrid(rows, cols);
  const levels = [1, 2, 3, 4, 5, 6];

  // Reference: K separate calls
  for (const lv of levels) {
    const ref = MS.getContourLines(grid, rows, cols, BOUNDS, lv);
    const multi = MS.getContourLinesMulti(grid, rows, cols, BOUNDS, levels);
    const got = multi.get(lv) || [];
    assert.strictEqual(segmentsToKey(got), segmentsToKey(ref),
      `level ${lv}: segment mismatch`);
  }
});

test('§C getContourLinesMulti: handles masked (null) cells identically to getContourLines()', () => {
  const rows = 4, cols = 4;
  const grid = makeSyntheticGrid(rows, cols);
  // Mask top-left corner
  grid[0][0] = null;
  grid[0][1] = null;
  const levels = [1.5, 3.0, 4.5];
  const multi = MS.getContourLinesMulti(grid, rows, cols, BOUNDS, levels);
  for (const lv of levels) {
    const ref = MS.getContourLines(grid, rows, cols, BOUNDS, lv);
    const got = multi.get(lv) || [];
    assert.strictEqual(segmentsToKey(got), segmentsToKey(ref),
      `masked grid level ${lv}: segment mismatch`);
  }
});

test('§C getContourLinesMulti: empty levels array returns empty Map', () => {
  const grid = makeSyntheticGrid(3, 3);
  const result = MS.getContourLinesMulti(grid, 3, 3, BOUNDS, []);
  assert.strictEqual(result.size, 0);
});

test('§C getContourLinesMulti: level outside grid range produces empty segment array', () => {
  const grid = makeSyntheticGrid(4, 4); // values 0..6
  const multi = MS.getContourLinesMulti(grid, 4, 4, BOUNDS, [100]);
  const segs = multi.get(100) || [];
  assert.strictEqual(segs.length, 0);
});

test('§C generateContourSurface: contour count and segment structure unchanged after §C wiring', () => {
  // Build a realistic multi-track fixture (same as existing generateContourSurface tests)
  const pts = [
    { lat: 51.1, lon: -0.8 }, { lat: 51.2, lon: -0.7 },
    { lat: 51.3, lon: -0.6 }, { lat: 51.4, lon: -0.5 },
  ];
  const phasicVals = [0.1, 0.5, 0.9, 0.3];
  function makeA(points, vals) {
    const n = points.length;
    return {
      raw: new Array(n).fill(0),
      getCoordinates: (i) => points[i] || null,
      sampleRate: 1,
      phasic: vals.map((v, i) => ({ time: i, val: v })),
      phasicZ: vals.map((v, i) => ({ time: i, val: v })),
      tonic: vals.map((v, i) => ({ time: i, val: v * 0.5 })),
      tonicZ: vals.map((v, i) => ({ time: i, val: v * 0.5 })),
      phasicAUC: vals.map((v, i) => ({ time: i, val: v })),
      arousalIndex: vals.map((v, i) => ({ time: i, val: v })),
      phasicStd: 1,
      peaks: [],
    };
  }
  const mgr = new GSRCollectiveManager();
  const t = { id: 'c', name: 'C', color: '#00f', analyzer: makeA(pts, phasicVals), enabled: true, filterParams: {} };
  mgr.addTrack(t);

  const params = { gridResolution: 10, contourCount: 5, isolationRadius: 100000,
    idwExponent: 2, topographySource: 'phasic', normalizeZScore: false,
    showShadedSurface: false, surfaceOpacity: 0.4 };
  const result = mgr.generateContourSurface(params);

  assert.ok(Array.isArray(result.contours));
  // Each contour must have level, ratio, segments
  for (const c of result.contours) {
    assert.ok(typeof c.level === 'number', 'level must be number');
    assert.ok(typeof c.ratio === 'number', 'ratio must be number');
    assert.ok(Array.isArray(c.segments) && c.segments.length > 0, 'segments must be non-empty');
    // Each segment: 2 {lat,lon} points
    for (const seg of c.segments) {
      assert.strictEqual(seg.length, 2);
      assert.ok(typeof seg[0].lat === 'number' && typeof seg[0].lon === 'number');
    }
  }
});
