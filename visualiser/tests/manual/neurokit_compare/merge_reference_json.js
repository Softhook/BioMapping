/**
 * Merges the per-track JSON outputs of run_neurokit.py, run_ledalab.py, and
 * run_cvxeda_reference.py into one combined object keyed by track name, so
 * check_ground_truth.js/compare.js can read every reference toolbox's
 * fields (nk.peak_times, nk.ledalab_peak_times, nk.cvxeda_ref_driver_peak_times,
 * ...) off a single object per track without their own argument parsing
 * needing to change. Missing/unreadable input files are skipped, not fatal -
 * a reference toolbox that isn't installed shouldn't block scoring the ones
 * that are.
 *
 * Usage: node merge_reference_json.js <output.json> <input1.json> [input2.json ...]
 */
'use strict';

const fs = require('fs');

const [, , outputPath, ...inputPaths] = process.argv;
if (!outputPath || inputPaths.length === 0) {
  console.error('Usage: node merge_reference_json.js <output.json> <input1.json> [input2.json ...]');
  process.exit(1);
}

const merged = {};
for (const inputPath of inputPaths) {
  if (!fs.existsSync(inputPath)) {
    console.warn(`merge_reference_json: skipping missing ${inputPath}`);
    continue;
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  } catch (exc) {
    console.warn(`merge_reference_json: skipping unparsable ${inputPath}: ${exc.message}`);
    continue;
  }
  for (const [track, fields] of Object.entries(data)) {
    merged[track] = { ...(merged[track] || {}), ...fields };
  }
}

fs.writeFileSync(outputPath, JSON.stringify(merged));
