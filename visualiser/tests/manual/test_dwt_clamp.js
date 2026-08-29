/**
 * DWT phasic clamping test — REAL data, full pipeline comparison.
 *
 * Compares:
 *   1. Bare DWT (just decompose + tonic reconstruction)
 *   2. Full analyzer pipeline (median → LPF → DWT → smooth → local-floor)
 *   3. Trough-connection baseline
 *
 * Run:  node visualiser/test_dwt_clamp.js
 */

const fs = require("fs");
const path = require("path");

// ── Load DWT filter ──────────────────────────────────────────────────────
const dwtSrc = fs.readFileSync(path.join(__dirname, "..", "..", "src", "signal", "dwt_filter.js"), "utf8");
let DWT;
eval("DWT = " + dwtSrc.slice(dwtSrc.indexOf("(() =>")));

// ── Load GsrFilter ───────────────────────────────────────────────────────
const gsfSrc = fs.readFileSync(path.join(__dirname, "..", "..", "src", "signal", "gsr_filter.js"), "utf8");
let GsrFilter;
eval("GsrFilter = " + gsfSrc.slice(gsfSrc.indexOf("{")));

// ── Load real CSV data ───────────────────────────────────────────────────
function loadCSV(csvPath) {
  const text = fs.readFileSync(csvPath, "utf8");
  const lines = text.trim().split("\n");
  const rows = lines.slice(1);
  const gsr = [];
  for (const row of rows) {
    const cols = row.split(",");
    gsr.push(parseFloat(cols[2]));
  }
  return { gsr, sampleRate: 10 };
}

const csvPath = path.join(process.env.HOME, "Downloads", "biomap_020.csv");
if (!fs.existsSync(csvPath)) {
  console.error("File not found:", csvPath);
  process.exit(1);
}

const { gsr: signal, sampleRate: Fs } = loadCSV(csvPath);

console.log("=== DWT Pipeline Comparison — REAL DATA (biomap_020.csv) ===\n");
console.log(`Samples:   ${signal.length}  (${(signal.length / Fs / 60).toFixed(1)} min @ ${Fs} Hz)`);
console.log(`GSR range: ${Math.min(...signal).toFixed(0)} – ${Math.max(...signal).toFixed(0)} µS`);

// ── Helpers ──────────────────────────────────────────────────────────────
function countNegative(rawSignal, tonic) {
  let count = 0, sum = 0, maxExcess = 0;
  for (let i = 0; i < rawSignal.length; i++) {
    const diff = tonic[i] - rawSignal[i];
    if (diff > 0) { count++; sum += diff; if (diff > maxExcess) maxExcess = diff; }
  }
  return { count, sum, maxExcess };
}

function phasicSum(rawSignal, tonic) {
  let sum = 0;
  for (let i = 0; i < rawSignal.length; i++) {
    sum += Math.max(0, rawSignal[i] - tonic[i]);
  }
  return sum;
}

const n = signal.length;
const dwtLevel = 6;

// ── Preprocessing (same for all) ─────────────────────────────────────────
const medSize = Math.max(1, Math.round(1.0 * Fs));
const afterMedian = GsrFilter.applyMedianFilter(signal, medSize);
const lpfSize = Math.max(1, Math.round(0.8 * Fs));
const afterLPF = GsrFilter.applyZeroPhaseMovingAverage(afterMedian, lpfSize);

const rawDWT = DWT.analyzeGSR(afterLPF, dwtLevel);
const smoothWin = Math.max(1, Math.round(5 * Fs));
const baseTonic = GsrFilter.applyZeroPhaseMovingAverage(rawDWT.tonic, smoothWin);
const basePhasic = afterLPF.map((v, i) => v - baseTonic[i]);

// ── Sweep: local-floor window × offset smoothing ─────────────────────────
console.log("\n=== Parameter sweep: floor window × offset smoothing ===\n");
console.log("Floor  Smooth | %Neg   Neg sum(µS)  MaxExcess  Phasic sum(µS)");
console.log("-------+-------|-----------------------------------------------");

const floorWindows = [2, 4, 6, 8, 10, 15];
const smoothWindows = [2, 4, 6, 8, 12];

let best = { fw: 4, sw: 8, count: Infinity, sum: Infinity, pctNeg: 100 };

for (const fw of floorWindows) {
  for (const sw of smoothWindows) {
    const floorHalf = Math.max(1, Math.round(fw * Fs));
    const offsets = new Array(n);
    for (let i = 0; i < n; i++) {
      const s = Math.max(0, i - floorHalf);
      const e = Math.min(n - 1, i + floorHalf);
      let mn = Infinity;
      for (let j = s; j <= e; j++) {
        if (basePhasic[j] < mn) mn = basePhasic[j];
      }
      offsets[i] = mn;
    }
    const smoothOff = GsrFilter.applyZeroPhaseMovingAverage(offsets, Math.round(sw * Fs));
    const tonic = baseTonic.map((v, i) => v + smoothOff[i]);
    const neg = countNegative(afterLPF, tonic);
    const pSum = phasicSum(afterLPF, tonic);

    const pctStr = neg.count === 0 ? " 0.0" : ((neg.count/n)*100).toFixed(1);
    console.log(
      ` ±${fw.toString().padStart(2)}s | ${sw.toString().padStart(2)}s   | ${pctStr.padStart(4)}%  ${neg.sum.toFixed(0).padStart(10)}  ${neg.maxExcess.toFixed(1).padStart(9)}  ${pSum.toFixed(0).padStart(14)}`
    );

    if (neg.count < best.count || (neg.count === best.count && neg.sum < best.sum)) {
      best = { fw, sw, count: neg.count, sum: neg.sum, maxExcess: neg.maxExcess, pctNeg: (neg.count/n)*100, phasicSum: pSum };
    }
  }
}

console.log(`\n🏆 Best: ±${best.fw}s floor, ${best.sw}s smoothing → ${best.pctNeg.toFixed(1)}% neg, ${best.phasicSum.toFixed(0)} µS phasic`);

// ── Also test: percentile-based floor instead of min ────────────────────
console.log("\n=== Percentile-based floor (vs absolute min) ===\n");
console.log("Floor  Smooth | %Neg   Neg sum(µS)  MaxExcess  Phasic sum(µS)");
console.log("-------+-------|-----------------------------------------------");

for (const fw of [4, 6, 8]) {
  for (const sw of [4, 6, 8]) {
    const floorHalf = Math.max(1, Math.round(fw * Fs));
    const offsets = new Array(n);
    for (let i = 0; i < n; i++) {
      const s = Math.max(0, i - floorHalf);
      const e = Math.min(n - 1, i + floorHalf);
      const window = [];
      for (let j = s; j <= e; j++) window.push(basePhasic[j]);
      window.sort((a, b) => a - b);
      // 5th percentile — more robust than absolute min
      offsets[i] = window[Math.floor(window.length * 0.05)];
    }
    const smoothOff = GsrFilter.applyZeroPhaseMovingAverage(offsets, Math.round(sw * Fs));
    const tonic = baseTonic.map((v, i) => v + smoothOff[i]);
    const neg = countNegative(afterLPF, tonic);
    const pSum = phasicSum(afterLPF, tonic);

    const pctStr = neg.count === 0 ? " 0.0" : ((neg.count/n)*100).toFixed(1);
    console.log(
      ` ±${fw.toString().padStart(2)}s | ${sw.toString().padStart(2)}s   | ${pctStr.padStart(4)}%  ${neg.sum.toFixed(0).padStart(10)}  ${neg.maxExcess.toFixed(1).padStart(9)}  ${pSum.toFixed(0).padStart(14)}`
    );
  }
}

// ── Final clamp viability ────────────────────────────────────────────────
console.log("\n=== Is final clamp a good idea? ===");
const currentNeg = 59; // from ±4s floor, 8s smooth
console.log(`  Current pipeline:    ${currentNeg}/${n} samples negative (${((currentNeg/n)*100).toFixed(1)}%)`);
console.log(`  After tightening:    ${best.count}/${n} samples negative (${best.pctNeg.toFixed(1)}%)`);
if (best.count <= 10) {
  console.log(`  ✅ Final clamp would affect ≤${best.count} samples — negligible. Safe to add.`);
} else if (best.count <= 30) {
  console.log(`  ⚠️  Final clamp would affect ${best.count} samples — acceptable but not ideal.`);
} else {
  console.log(`  ❌ Still too many negatives — fix the repositioning first.`);
}
