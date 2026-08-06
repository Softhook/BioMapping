/**
 * Unit tests for marching_squares.js (MarchingSquares.getContourLines) —
 * pure isoline-extraction algorithm, extracted from analyzer.js.
 *
 * Run: node --test tests/test_marching_squares.js
 */

const assert = require('assert');
const test = require('node:test');

const { MarchingSquares } = require('../marching_squares.js');

const BOUNDS_UNIT = { minLat: 0, maxLat: 1, minLon: 0, maxLon: 1 };

test('getContourLines: uniform grid entirely above isolevel returns no lines', () => {
  const grid = [[5, 5], [5, 5]];
  const lines = MarchingSquares.getContourLines(grid, 2, 2, BOUNDS_UNIT, 1);
  assert.strictEqual(lines.length, 0);
});

test('getContourLines: uniform grid entirely below isolevel returns no lines', () => {
  const grid = [[0, 0], [0, 0]];
  const lines = MarchingSquares.getContourLines(grid, 2, 2, BOUNDS_UNIT, 1);
  assert.strictEqual(lines.length, 0);
});

test('getContourLines: single corner above threshold produces exactly one segment (case 1)', () => {
  // SW corner (r=1,c=0) high, rest low → cellIndex bit 0 set → case 1.
  const grid = [
    [0, 0],
    [10, 0],
  ];
  const lines = MarchingSquares.getContourLines(grid, 2, 2, BOUNDS_UNIT, 5);
  assert.strictEqual(lines.length, 1);
  const [p1, p2] = lines[0];
  for (const p of [p1, p2]) {
    assert.ok(Number.isFinite(p.lat) && Number.isFinite(p.lon));
  }
});

test('getContourLines: diagonal saddle (case 5) produces two segments', () => {
  // NW and SE high, NE and SW low → cellIndex = 8|2 = 10... use values matching case 5 (NW+SE bits: 8+2=10 not 5).
  // case 5 = bits NW(8) + SE... recompute: bit3=NW(8), bit2=NE(4), bit1=SE(2), bit0=SW(1).
  // case 5 = 0b0101 = NE(4) + SW(1) high, NW/SE low.
  const grid = [
    [0, 10],
    [10, 0],
  ];
  const lines = MarchingSquares.getContourLines(grid, 2, 2, BOUNDS_UNIT, 5);
  assert.strictEqual(lines.length, 2, 'ambiguous saddle case should emit two disjoint segments');
});

test('getContourLines: all-null grid produces no lines and does not throw', () => {
  const grid = [
    [null, null],
    [null, null],
  ];
  const lines = MarchingSquares.getContourLines(grid, 2, 2, BOUNDS_UNIT, 1);
  assert.strictEqual(lines.length, 0);
});

test('getContourLines: mixed null/NaN cells are treated as masked but do not crash neighbouring cells', () => {
  const grid = [
    [0, 10, 0],
    [10, null, 10],
    [0, 10, 0],
  ];
  assert.doesNotThrow(() => {
    const lines = MarchingSquares.getContourLines(grid, 3, 3, BOUNDS_UNIT, 5);
    assert.ok(Array.isArray(lines));
    for (const [p1, p2] of lines) {
      assert.ok(Number.isFinite(p1.lat) && Number.isFinite(p1.lon));
      assert.ok(Number.isFinite(p2.lat) && Number.isFinite(p2.lon));
    }
  });
});

test('getContourLines: interpolated points fall within the supplied lat/lon bounds', () => {
  const grid = [
    [0, 20, 0],
    [20, 0, 20],
    [0, 20, 0],
  ];
  const bounds = { minLat: 51.0, maxLat: 51.1, minLon: -0.2, maxLon: -0.1 };
  const lines = MarchingSquares.getContourLines(grid, 3, 3, bounds, 10);
  assert.ok(lines.length > 0);
  for (const [p1, p2] of lines) {
    for (const p of [p1, p2]) {
      assert.ok(p.lat >= bounds.minLat - 1e-9 && p.lat <= bounds.maxLat + 1e-9);
      assert.ok(p.lon >= bounds.minLon - 1e-9 && p.lon <= bounds.maxLon + 1e-9);
    }
  }
});

test('getContourLines: exact isolevel match on both edge endpoints does not divide by zero', () => {
  // v1 === v2 === isolevel triggers the |v1-v2| < 1e-9 branch (return p1) rather than 0/0 division.
  const grid = [
    [5, 5],
    [10, 0],
  ];
  assert.doesNotThrow(() => {
    MarchingSquares.getContourLines(grid, 2, 2, BOUNDS_UNIT, 5);
  });
});

test('getContourLines: larger grid with a Gaussian-like bump produces a closed-ish ring of segments', () => {
  const rows = 10, cols = 10;
  const grid = [];
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < cols; c++) {
      const dx = c - 4.5, dy = r - 4.5;
      row.push(100 * Math.exp(-(dx * dx + dy * dy) / 10));
    }
    grid.push(row);
  }
  const lines = MarchingSquares.getContourLines(grid, rows, cols, BOUNDS_UNIT, 50);
  assert.ok(lines.length >= 4, 'a bump crossing the isolevel should yield multiple boundary segments');
});
