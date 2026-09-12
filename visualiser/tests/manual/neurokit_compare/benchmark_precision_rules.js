/**
 * Benchmark candidate precision/rejection rules for BioMapping Full-Scan
 * against:
 * 1. Multi-seed synthetic ground-truth (12 clean tracks, 210 true injected SCRs)
 * 2. Multi-seed compound scenarios (regression check for clustered responses)
 * 3. Multi-seed low-amplitude/slow-rise scenarios (regression check for subtle SCRs)
 * 4. Real reference tracks (agreement recall against NeuroKit2)
 *
 * Usage:
 *   node benchmark_precision_rules.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execSync } = require('child_process');

global.window = global;
global.GSR_CONST = require('../../mock_constants.js');

function loadModule(filePath, varName) {
  const src = fs.readFileSync(filePath, 'utf8');
  const wrapped = src
    .replace(new RegExp(`class ${varName}\\s*{`), `global.${varName} = class ${varName} {`)
    .replace(new RegExp(`const ${varName}\\s*=`), `global.${varName} =`);
  vm.runInThisContext(wrapped, { filename: filePath });
}

const SRC = path.join(__dirname, '../../../src/signal');
loadModule(path.join(SRC, 'dwt_filter.js'), 'DWT');
loadModule(path.join(SRC, 'gsr_filter.js'), 'GsrFilter');
global.CVXEDA = require(path.join(SRC, 'cvxeda.js'));
loadModule(path.join(SRC, 'deconvolution.js'), 'SCRDeconvolution');
loadModule(path.join(SRC, 'csv_parser.js'), 'GSRCSVParser');
loadModule(path.join(SRC, 'analyzer.js'), 'GSRAnalyzer');

const { GSRAnalyzer } = global;
const D = global.GSR_CONST.GSR_DEFAULT;

const RULES = [
  { name: 'Baseline Full-Scan',           filter: () => true },
  { name: 'Full-Scan (Prom >= 0.010 uS)', filter: p => p.prominence >= 0.010 },
  { name: 'Full-Scan (Prom >= 0.015 uS)', filter: p => p.prominence >= 0.015 },
  { name: 'Full-Scan (Prom >= 0.020 uS)', filter: p => p.prominence >= 0.020 },
  { name: 'Full-Scan (Qual >= 0.60)',     filter: p => p.qualityScore >= 0.60 },
  { name: 'Full-Scan (Qual >= 0.65)',     filter: p => p.qualityScore >= 0.65 },
  { name: 'Full-Scan (Prom>=0.015 | Qual>=0.60)', filter: p => p.prominence >= 0.015 || p.qualityScore >= 0.60 },
  { name: 'Full-Scan (Prom>=0.015 & Qual>=0.60)', filter: p => p.prominence >= 0.015 && p.qualityScore >= 0.60 },
];

// Helper to score peaks against ground truth
function scoreTruth(peaks, truth, tol = 1.0) {
  const used = new Array(truth.length).fill(false);
  let tp = 0;
  const deltas = [];
  const ampPairs = [];

  for (const p of peaks) {
    let bestIdx = -1, bestD = Infinity;
    for (let i = 0; i < truth.length; i++) {
      if (used[i]) continue;
      const d = Math.abs(p.time - truth[i].time);
      if (d < bestD) { bestIdx = i; bestD = d; }
    }
    if (bestIdx >= 0 && bestD <= tol) {
      used[bestIdx] = true;
      tp++;
      deltas.push(bestD);
      ampPairs.push([p.amplitude, truth[bestIdx].amplitude]);
    }
  }

  const fn = truth.length - tp;
  const fp = peaks.length - tp;
  const recall = truth.length ? tp / truth.length : 0;
  const prec = peaks.length ? tp / peaks.length : 0;
  const f1 = (recall + prec) > 0 ? 2 * recall * prec / (recall + prec) : 0;
  const meanDelta = deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : NaN;

  let sumAbsErr = 0, sumRelErr = 0;
  for (const [det, tru] of ampPairs) {
    sumAbsErr += Math.abs(det - tru);
    sumRelErr += Math.abs(det - tru) / tru;
  }
  const meanAbsErr = ampPairs.length ? sumAbsErr / ampPairs.length : NaN;
  const meanRelErr = ampPairs.length ? sumRelErr / ampPairs.length : NaN;

  return { tp, fn, fp, recall, prec, f1, meanDelta, meanAbsErr, meanRelErr };
}

// 1. Generate multi-seed synthetic ground-truth tracks
const tmpDir = execSync('mktemp -d -t synth_benchmark.XXXXXX').toString().trim();
const pyBin = process.env.NEUROKIT_PYTHON || path.join(process.env.HOME, 'neurokit/.venv/bin/python');
const pyScript = path.join(__dirname, 'generate_ground_truth.py');

console.log('Generating 3-seed synthetic ground-truth suite...');
execSync(`GROUND_TRUTH_NUM_SEEDS=3 "${pyBin}" "${pyScript}" "${tmpDir}"`, { stdio: 'ignore' });

// Load clean scenarios
const cleanScenarios = ['synth_sparse_clean', 'synth_dense_clean', 'synth_compound_clean', 'synth_low_slow_clean'];
const cleanTracks = [];
for (const seed of ['_s1', '_s2', '_s3']) {
  for (const scen of cleanScenarios) {
    const stem = `${scen}${seed}`;
    cleanTracks.push({
      stem,
      scen,
      csv: path.join(tmpDir, `${stem}.csv`),
      gt: path.join(tmpDir, `${stem}.ground_truth.json`),
    });
  }
}

// Evaluate synthetic performance
console.log('\n================================================================================');
console.log('=== PART 1: Synthetic Ground-Truth Evaluation (12 clean tracks, 210 true SCRs) ===');
console.log('================================================================================');

const synthResults = RULES.map(r => ({ rule: r.name, tp: 0, fn: 0, fp: 0, ampPairs: [] }));
const compoundResults = RULES.map(r => ({ rule: r.name, tp: 0, fn: 0, fp: 0 }));
const lowSlowResults = RULES.map(r => ({ rule: r.name, tp: 0, fn: 0, fp: 0 }));

for (const tr of cleanTracks) {
  const truth = JSON.parse(fs.readFileSync(tr.gt, 'utf8')).scrs;
  const a = new GSRAnalyzer();
  a.parseCSV(fs.readFileSync(tr.csv, 'utf8'));
  a.analyze({ ...D, useGaitFilter: false }, 0);
  const basePeaks = a.peaks;

  for (let rIdx = 0; rIdx < RULES.length; rIdx++) {
    const rule = RULES[rIdx];
    const filteredPeaks = basePeaks.filter(rule.filter);
    const s = scoreTruth(filteredPeaks, truth);

    synthResults[rIdx].tp += s.tp;
    synthResults[rIdx].fn += s.fn;
    synthResults[rIdx].fp += s.fp;

    if (tr.scen === 'synth_compound_clean') {
      compoundResults[rIdx].tp += s.tp;
      compoundResults[rIdx].fn += s.fn;
      compoundResults[rIdx].fp += s.fp;
    }
    if (tr.scen === 'synth_low_slow_clean') {
      lowSlowResults[rIdx].tp += s.tp;
      lowSlowResults[rIdx].fn += s.fn;
      lowSlowResults[rIdx].fp += s.fp;
    }
  }
}

console.log('Rule                             | Recall | Precision | F1 Score | TP / 210 | FP (Clean) | Compound TP/36 | Low-Slow TP/36');
console.log('---------------------------------|--------|-----------|----------|----------|------------|----------------|---------------');
for (let i = 0; i < RULES.length; i++) {
  const tot = synthResults[i];
  const rec = tot.tp / (tot.tp + tot.fn);
  const prec = (tot.tp + tot.fp) > 0 ? tot.tp / (tot.tp + tot.fp) : 0;
  const f1 = (rec + prec) > 0 ? 2 * rec * prec / (rec + prec) : 0;
  const cTp = compoundResults[i].tp;
  const lsTp = lowSlowResults[i].tp;
  console.log(
    `${tot.rule.padEnd(32)} | ${(100*rec).toFixed(1).padStart(5)}% | ` +
    `${(100*prec).toFixed(1).padStart(8)}% | ${f1.toFixed(3).padStart(8)} | ` +
    `${String(tot.tp).padStart(4)}/210 | ${String(tot.fp).padStart(10)} | ` +
    `${String(cTp).padStart(8)}/36   | ${String(lsTp).padStart(8)}/36`
  );
}

// 2. Evaluate real tracks against NeuroKit2
console.log('\n================================================================================');
console.log('=== PART 2: Real Track Agreement with NeuroKit2 ===');
console.log('================================================================================');

const realTracks = [
  'tracks/biomap_live_2026-09-10T17-20-02-105Z.csv',
  'tracks/biomap_028.csv',
  'tracks/biomap_053.csv',
  'tracks/biomap_019.csv',
  'tracks/biomap_027.csv',
];

const nkScript = path.join(__dirname, 'run_neurokit.py');
const nkOut = JSON.parse(execSync(`"${pyBin}" "${nkScript}" ${realTracks.map(t => `"${t}"`).join(' ')}`).toString());

console.log('Track                     | NK Peaks | Baseline Full | Prom >= 0.010 | Prom >= 0.015 | Prom >= 0.020 | Qual >= 0.60');
console.log('--------------------------|----------|---------------|---------------|---------------|---------------|-------------');

for (const t of realTracks) {
  const stem = path.basename(t, '.csv');
  const nkData = nkOut[stem];
  if (!nkData) continue;
  const nkPeaks = nkData.peak_times;

  const a = new GSRAnalyzer();
  a.parseCSV(fs.readFileSync(t, 'utf8'));
  // Use clean comparison mode (gaitFilter off) for stationary tracks, or default for outdoor
  const isIndoor = stem.includes('live') || stem === 'biomap_028';
  a.analyze({ ...D, useGaitFilter: !isIndoor }, 0);
  const basePeaks = a.peaks;

  const recalls = [];
  for (const rule of [
    RULES[0], // Baseline
    RULES[1], // Prom >= 0.010
    RULES[2], // Prom >= 0.015
    RULES[3], // Prom >= 0.020
    RULES[4], // Qual >= 0.60
  ]) {
    const kept = basePeaks.filter(rule.filter);
    let matched = 0;
    for (const nkt of nkPeaks) {
      if (kept.some(p => Math.abs(p.time - nkt) <= 1.0)) matched++;
    }
    const rec = (100 * matched / nkPeaks.length).toFixed(1) + '%';
    recalls.push(`${matched}/${nkPeaks.length} (${rec})`);
  }

  console.log(
    `${stem.slice(0, 25).padEnd(25)} | ${String(nkPeaks.length).padStart(8)} | ` +
    `${recalls[0].padEnd(13)} | ${recalls[1].padEnd(13)} | ${recalls[2].padEnd(13)} | ` +
    `${recalls[3].padEnd(13)} | ${recalls[4]}`
  );
}

// Clean up
try { execSync(`rm -rf "${tmpDir}"`); } catch (e) {}
