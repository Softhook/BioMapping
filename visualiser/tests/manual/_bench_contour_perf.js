'use strict';
/**
 * A/B timing benchmark for Marching Squares: getContourLines (K passes, O(K×R×C))
 * vs getContourLinesMulti (1 pass, O(R×C) + precomputed coords + pruning).
 * Timing-proves §C optimization in isolation.
 *
 * Run:
 *   node tests/manual/_bench_contour_perf.js
 */

const fs = require('fs');
const path = require('path');
const { MarchingSquares } = require('../../src/render/marching_squares.js');

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function bench(fn, iters = 50) {
  // Warmup
  for (let i = 0; i < 5; i++) fn();
  const samples = [];
  for (let i = 0; i < iters; i++) {
    const t0 = process.hrtime.bigint();
    fn();
    samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  return median(samples);
}

function makeSyntheticGrid(rows, cols, hasMask = false) {
  const grid = [];
  for (let r = 0; r < rows; r++) {
    grid[r] = [];
    for (let c = 0; c < cols; c++) {
      if (hasMask && (r + c) % 7 === 0) {
        grid[r][c] = null; // mask 14% of the grid
      } else {
        grid[r][c] = Math.sin(r * 0.15) * Math.cos(c * 0.15) * 5 + 5;
      }
    }
  }
  return grid;
}

const BOUNDS = { minLat: 51.0, maxLat: 52.0, minLon: -1.0, maxLon: 0.0 };

const RUNS = [
  { rows: 50,  cols: 50,  levels: 10, mask: false },
  { rows: 50,  cols: 50,  levels: 10, mask: true },
  { rows: 100, cols: 100, levels: 10, mask: false },
  { rows: 100, cols: 100, levels: 30, mask: false },
  { rows: 100, cols: 100, levels: 30, mask: true }
];

console.log('── Benchmarking Marching Squares: getContourLines vs getContourLinesMulti ──\n');
console.log('  Size       Levels  Masked  Multi-Pass (K×O(R×C))   Single-Pass (O(R×C))   Speedup');
console.log('  ---------------------------------------------------------------------------------');

for (const run of RUNS) {
  const grid = makeSyntheticGrid(run.rows, run.cols, run.mask);
  
  // Generate level array
  const levels = [];
  for (let k = 1; k <= run.levels; k++) {
    levels.push(0.5 + (k / (run.levels + 1)) * 9.0);
  }

  // A: Multi-Pass
  const runA = () => {
    const contours = [];
    for (const lv of levels) {
      const segs = MarchingSquares.getContourLines(grid, run.rows, run.cols, BOUNDS, lv);
      if (segs.length > 0) contours.push(segs);
    }
    return contours;
  };

  // B: Single-Pass
  const runB = () => {
    return MarchingSquares.getContourLinesMulti(grid, run.rows, run.cols, BOUNDS, levels);
  };

  const msA = bench(runA, 100);
  const msB = bench(runB, 100);
  const speedup = msA / msB;

  const sizeStr = `${run.rows}x${run.cols}`.padEnd(10);
  const lvStr = String(run.levels).padStart(6);
  const maskStr = (run.mask ? 'Yes' : 'No').padStart(8);
  const msAStr = `${msA.toFixed(3)}ms`.padStart(22);
  const msBStr = `${msB.toFixed(3)}ms`.padStart(22);
  const speedupStr = `${speedup.toFixed(1)}x`.padStart(9);

  console.log(`  ${sizeStr} ${lvStr} ${maskStr} ${msAStr} ${msBStr} ${speedupStr}`);
}
console.log('');
