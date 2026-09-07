const { performance } = require('perf_hooks');

// ─────────────────────────────────────────────────────────────────────────────
// 1. stitchSegments Benchmark (O(n²) linear scan vs O(n) Map)
// ─────────────────────────────────────────────────────────────────────────────
function stitchSegmentsOld(segments) {
  if (!segments || segments.length === 0) return [];
  const remaining = [...segments];
  const paths = [];
  const EPS = 1e-6;
  const distance = (p1, p2) => Math.hypot(p1.lat - p2.lat, p1.lon - p2.lon);

  while (remaining.length > 0) {
    let current = remaining.shift();
    let path = [current[0], current[1]];
    let added = true;

    while (added) {
      added = false;
      const endPoint = path[path.length - 1];

      for (let i = 0; i < remaining.length; i++) {
        const seg = remaining[i];
        if (distance(endPoint, seg[0]) < EPS) {
          path.push(seg[1]);
          remaining.splice(i, 1);
          added = true;
          break;
        } else if (distance(endPoint, seg[1]) < EPS) {
          path.push(seg[0]);
          remaining.splice(i, 1);
          added = true;
          break;
        }
      }

      if (!added) {
        const startPoint = path[0];
        for (let i = 0; i < remaining.length; i++) {
          const seg = remaining[i];
          if (distance(startPoint, seg[0]) < EPS) {
            path.unshift(seg[1]);
            remaining.splice(i, 1);
            added = true;
            break;
          } else if (distance(startPoint, seg[1]) < EPS) {
            path.unshift(seg[0]);
            remaining.splice(i, 1);
            added = true;
            break;
          }
        }
      }
    }
    if (path.length >= 3) paths.push(path);
  }
  return paths;
}

const { GSRSpatialClustering } = require('../../src/spatial/spatial_clustering.js');
const stitchSegmentsNew = GSRSpatialClustering.stitchSegments;

function generateLoopSegments(count) {
  const pts = [];
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2;
    pts.push({ lat: Math.sin(angle) * 0.01, lon: Math.cos(angle) * 0.01 });
  }
  const segs = [];
  for (let i = 0; i < count; i++) {
    segs.push([pts[i], pts[(i + 1) % count]]);
  }
  // Shuffle segments
  return segs.sort(() => Math.random() - 0.5);
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. drawHotspotMarkers lookup: indexOf vs Memoized Map across frames
// ─────────────────────────────────────────────────────────────────────────────
function benchHotspotLookup(peakCount, hotspotCount, iterations) {
  const peaks = [];
  for (let i = 0; i < peakCount; i++) {
    peaks.push({ id: i, time: i * 0.1, amplitude: Math.random() });
  }
  // Select hotspot subset
  const hotspots = [];
  for (let i = 0; i < hotspotCount; i++) {
    const idx = Math.floor((i / hotspotCount) * peakCount);
    hotspots.push(peaks[idx]);
  }

  // Old: indexOf inside loop on every redraw frame
  const t0 = performance.now();
  let dummy1 = 0;
  for (let it = 0; it < iterations; it++) {
    for (const h of hotspots) {
      const idx = peaks.indexOf(h);
      dummy1 += idx;
    }
  }
  const timeOld = performance.now() - t0;

  // New: memoized Map (built once when peaks array changes, reused across frames)
  const t1 = performance.now();
  let dummy2 = 0;
  let memoizedMap = null;
  let lastPeaksRef = null;
  for (let it = 0; it < iterations; it++) {
    if (!memoizedMap || lastPeaksRef !== peaks) {
      memoizedMap = new Map();
      for (let i = 0; i < peaks.length; i++) memoizedMap.set(peaks[i], i);
      lastPeaksRef = peaks;
    }
    for (const h of hotspots) {
      const idx = memoizedMap.has(h) ? memoizedMap.get(h) : -1;
      dummy2 += idx;
    }
  }
  const timeNew = performance.now() - t1;

  return { timeOld, timeNew, speedup: timeOld / timeNew };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Label placement simulated annealing
// ─────────────────────────────────────────────────────────────────────────────
const { GSRLabelManager } = require('../../src/render/label_placement.js');

function generateLabelCandidates(labelCount) {
  const items = [];
  for (let i = 0; i < labelCount; i++) {
    items.push({
      idx: i,
      px: 100 + (i % 10) * 30 + (Math.random() * 10),
      py: 100 + Math.floor(i / 10) * 30 + (Math.random() * 10),
      text: 'Peak #' + (i + 1)
    });
  }
  return items;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. KDE Density Grid: flat Float64Array vs nested 2D Array
// Models getConcaveBlob()'s real access pattern — loop peaks, splat each one's
// Gaussian onto a small cell window with a squared-distance cutoff — rather than
// a bare cell sweep, and warms the JIT before timing.
// ─────────────────────────────────────────────────────────────────────────────
function benchKdeGrid(peaksCount) {
  const rows = 70, cols = 70;
  const REPEATS = 200, WARMUP = 40, HALF_WIN = 8; // ~6-sigma window in cells
  const twoSigmaSq = 2 * 30 * 30;
  const cutoffDSq = (6 * 30) * (6 * 30);
  const peaks = [];
  for (let i = 0; i < peaksCount; i++) {
    peaks.push({ r: 5 + Math.floor(Math.random() * (rows - 10)), c: 5 + Math.floor(Math.random() * (cols - 10)), w: 1 + Math.random() });
  }

  const runNested = () => {
    const grid = Array.from({ length: rows }, () => new Array(cols).fill(0));
    for (let p = 0; p < peaks.length; p++) {
      const pk = peaks[p];
      const rMin = Math.max(0, pk.r - HALF_WIN), rMax = Math.min(rows - 1, pk.r + HALF_WIN);
      const cMin = Math.max(0, pk.c - HALF_WIN), cMax = Math.min(cols - 1, pk.c + HALF_WIN);
      for (let r = rMin; r <= rMax; r++) {
        const row = grid[r];
        for (let c = cMin; c <= cMax; c++) {
          const dSq = ((r - pk.r) * (r - pk.r) + (c - pk.c) * (c - pk.c)) * 100;
          if (dSq > cutoffDSq) continue;
          row[c] += pk.w * Math.exp(-dSq / twoSigmaSq);
        }
      }
    }
    return grid[rows - 1][cols - 1];
  };

  const runFlat = () => {
    const grid = new Float64Array(rows * cols);
    for (let p = 0; p < peaks.length; p++) {
      const pk = peaks[p];
      const rMin = Math.max(0, pk.r - HALF_WIN), rMax = Math.min(rows - 1, pk.r + HALF_WIN);
      const cMin = Math.max(0, pk.c - HALF_WIN), cMax = Math.min(cols - 1, pk.c + HALF_WIN);
      for (let r = rMin; r <= rMax; r++) {
        const rowOffset = r * cols;
        for (let c = cMin; c <= cMax; c++) {
          const dSq = ((r - pk.r) * (r - pk.r) + (c - pk.c) * (c - pk.c)) * 100;
          if (dSq > cutoffDSq) continue;
          grid[rowOffset + c] += pk.w * Math.exp(-dSq / twoSigmaSq);
        }
      }
    }
    return grid[rows * cols - 1];
  };

  let sink = 0;
  for (let i = 0; i < WARMUP; i++) { sink += runNested(); sink += runFlat(); }

  const t0 = performance.now();
  for (let i = 0; i < REPEATS; i++) sink += runNested();
  const timeOld = performance.now() - t0;

  const t1 = performance.now();
  for (let i = 0; i < REPEATS; i++) sink += runFlat();
  const timeNew = performance.now() - t1;

  if (sink === Infinity) console.log(''); // keep sink live
  return { timeOld: timeOld / REPEATS, timeNew: timeNew / REPEATS, speedup: timeOld / timeNew };
}

// ─────────────────────────────────────────────────────────────────────────────
// EXECUTE AND PRINT
// ─────────────────────────────────────────────────────────────────────────────
console.log('='.repeat(70));
console.log('BENCHMARK: BioMapping Visualiser Performance Refactor');
console.log('='.repeat(70));

console.log('\n--- 1. Segment Stitching (stitchSegments) ---');
for (const count of [50, 200, 500, 1000]) {
  const segs = generateLoopSegments(count);
  
  const t0 = performance.now();
  stitchSegmentsOld(segs);
  const oldMs = performance.now() - t0;

  const t1 = performance.now();
  stitchSegmentsNew(segs);
  const newMs = performance.now() - t1;

  const speedup = (oldMs / newMs).toFixed(1);
  console.log(`  Segments: ${count.toString().padEnd(5)} | Old: ${oldMs.toFixed(3)} ms | New: ${newMs.toFixed(3)} ms | Speedup: ${speedup}x`);
}

console.log('\n--- 2. Hotspot Peak Index Lookup in Render Loop ---');
for (const [peaks, hotspots] of [[500, 20], [2000, 50], [5000, 100]]) {
  const res = benchHotspotLookup(peaks, hotspots, 500);
  console.log(`  Peaks: ${peaks.toString().padEnd(4)}, Hotspots: ${hotspots.toString().padEnd(3)} (500 redraw frames) | Old: ${res.timeOld.toFixed(2)} ms | New: ${res.timeNew.toFixed(2)} ms | Speedup: ${res.speedup.toFixed(1)}x`);
}

console.log('\n--- 3. Label Placement Simulated Annealing ---');
for (const labelCount of [25, 50, 100]) {
  const items = generateLabelCandidates(labelCount);
  const t0 = performance.now();
  for (let it = 0; it < 10; it++) {
    GSRLabelManager.computeLabelPositions(items);
  }
  const ms = (performance.now() - t0) / 10;
  console.log(`  Labels: ${labelCount.toString().padEnd(3)} | Average placement time: ${ms.toFixed(2)} ms`);
}

console.log('\n--- 4. KDE Density Grid, windowed splat (70x70, per full-grid build) ---');
for (const peakCount of [10, 50, 100]) {
  const res = benchKdeGrid(peakCount);
  const us = (v) => (v * 1000).toFixed(1) + ' us';
  console.log(`  Peaks: ${peakCount.toString().padEnd(3)} | Nested 2D: ${us(res.timeOld).padEnd(10)} | Float64Array: ${us(res.timeNew).padEnd(10)} | Speedup: ${res.speedup.toFixed(2)}x`);
}

console.log('\n' + '='.repeat(70));
