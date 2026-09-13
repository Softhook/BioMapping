/**
 * EDASymp comparison (JS side) — see check_edasymp.py.
 *
 * Loads BioMapping's REAL SpectralEDA module (src/signal/spectral_eda.js),
 * re-reads each raw track CSV with the same µS unit conversion the Python
 * side applies (run_neurokit.to_microsiemens), and reports per-track
 * ratio + cross-track Pearson r against NeuroKit2's
 * nk.eda_sympathetic(posada2016) scalar.
 *
 * Usage (normally via check_edasymp.sh, not directly):
 *   node check_edasymp.js <python.json> <tracksdir>
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { SpectralEDA } = require('../../../src/signal/spectral_eda.js');

// Mirrors run_neurokit.to_microsiemens (same unit detection as GSRCSVParser).
function toMicrosiemens(vals) {
  const avg = vals.reduce((s, v) => s + v, 0) / vals.length;
  if (avg > 50000) return vals.map(v => (v > 0 ? 1e6 / v : 0));
  if (avg > 100 && avg <= 50000) return vals.map(v => v / 1000);
  return vals;
}

function loadTrack(csvPath) {
  const lines = fs.readFileSync(csvPath, 'utf8').split('\n');
  const headerIdx = lines.findIndex(l => /^timestamp,/.test(l));
  if (headerIdx < 0) throw new Error(`No timestamp header in ${csvPath}`);
  const header = lines[headerIdx].split(',');
  const gsrIdx = header.indexOf('gsr_raw');
  const timeIdx = header.indexOf('timestamp');
  const times = [], vals = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const p = lines[i].split(',');
    if (p.length <= gsrIdx) continue;
    const t = parseFloat(p[timeIdx]);
    const v = parseFloat(p[gsrIdx]);
    if (!isNaN(t) && !isNaN(v)) { times.push(t); vals.push(v); }
  }
  return { us: toMicrosiemens(vals), times };
}

function samplingRateHz(times) {
  if (times.length < 2) return 10;
  const dt = times[times.length - 1] - times[0];
  return dt > 0 ? (times.length - 1) / dt : 10;
}

function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  let sa = 0, sb = 0, sab = 0, sa2 = 0, sb2 = 0;
  for (let i = 0; i < n; i++) {
    sa += a[i]; sb += b[i]; sab += a[i] * b[i]; sa2 += a[i] * a[i]; sb2 += b[i] * b[i];
  }
  const cov = sab / n - (sa / n) * (sb / n);
  const va = sa2 / n - (sa / n) * (sa / n);
  const vb = sb2 / n - (sb / n) * (sb / n);
  return cov / Math.sqrt(va * vb);
}

const [, , jsonPath, tracksDir] = process.argv;
if (!jsonPath || !tracksDir) {
  console.error('Usage: node check_edasymp.js <python.json> <tracksdir>');
  process.exit(1);
}

const py = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
const names = Object.keys(py);

const ours = [], theirs = [];
console.log('=== EDASymp (0.045-0.25 Hz) agreement — ours (SpectralEDA) vs NeuroKit2 posada2016 ===');
for (const name of names) {
  const ref = py[name];
  if (ref.eda_sympathetic == null) {
    console.log(`  ${name}: NeuroKit2 returned NaN (signal <= 64 s) — skipped`);
    continue;
  }
  const track = loadTrack(path.join(tracksDir, name + '.csv'));
  const fs = samplingRateHz(track.times);
  const s = SpectralEDA.computeScalar(track.us, fs);
  const ratio = s.sympathetic / ref.eda_sympathetic;
  ours.push(s.sympathetic); theirs.push(ref.eda_sympathetic);
  console.log(`  ${name}: NK=${ref.eda_sympathetic.toFixed(6)} ours=${s.sympathetic.toFixed(6)} ratio=${ratio.toFixed(4)}  (n=${ref.n_samples}, fs=${ref.sampling_rate.toFixed(2)})`);
}

if (ours.length >= 2) {
  const r = pearson(ours, theirs);
  console.log(`\n  cross-track Pearson r = ${r.toFixed(6)} over ${ours.length} tracks`);
}
