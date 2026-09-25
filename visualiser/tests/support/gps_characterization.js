/**
 * Shared metric computation for the GPS filter pipeline characterisation
 * harness (test_gps_characterization.js + gen_gps_characterization_baseline.js
 * both call this, so the golden-master generator and the checker can never
 * drift apart).
 *
 * Runs the production stages themselves (GpsPipeline.collectFixes →
 * filterFixes → reconstructFilteredGps, as src/map/manager/process.mjs
 * does, without road snap) — and reduces
 * the result to the aggregate metrics docs/todo.md's "Characterisation
 * harness" note asks for: total path length, vertex count, % interpolated,
 * max deviation from raw. No display-stage (downsample/RDP) is included — those have their own
 * tolerance knobs and are a rendering concern, not part of the state
 * estimate this harness is guarding.
 */
const { GSRAnalyzer } = require('../../src/signal/analyzer.mjs');
const { GpsPipeline } = require('../../src/gps/gps_pipeline.mjs');
const { GeoUtils } = require('../../src/gps/geo_utils.mjs');
const { GSR_CONST } = require('../../src/core/constants.mjs');

function pathLengthMeters(seq, latKey = 'lat', lonKey = 'lon') {
  let total = 0;
  for (let i = 1; i < seq.length; i++) {
    total += GeoUtils.haversineMeters(
      seq[i - 1][latKey],
      seq[i - 1][lonKey],
      seq[i][latKey],
      seq[i][lonKey],
    );
  }
  return total;
}

/**
 * @param {string} csvText - raw CSV file contents
 * @param {object} [paramOverrides] - overrides merged onto GSR_CONST.GPS_DEFAULT
 * @returns {{n_raw:number, n_raw_gps_fixes:number, n_after_gates:number,
 *   vertex_count:number, pct_interpolated:number, total_path_length_m:number,
 *   raw_path_length_m:number, max_deviation_from_raw_m:number}}
 */
function computeCharacterizationMetrics(csvText, paramOverrides = {}) {
  const p = { ...GSR_CONST.GPS_DEFAULT, ...paramOverrides };

  const analyzer = new GSRAnalyzer();
  analyzer.parseCSV(csvText);
  const data = analyzer.raw;

  const rawPts = GpsPipeline.collectFixes(data);
  const nAfterGates = GpsPipeline.applyFixTypeGate(
    GpsPipeline.applyHdopGate(rawPts, p.maxHdop),
  ).length;
  const finalPts = GpsPipeline.filterFixes(rawPts, p);

  GpsPipeline.reconstructFilteredGps(analyzer, data, finalPts, p.maxSpeed);
  const fg = analyzer.filteredGps;

  const validFg = [];
  for (let i = 0; i < fg.length; i++) {
    if (!isNaN(fg[i].lat) && !isNaN(fg[i].lon))
      validFg.push({ idx: i, ...fg[i] });
  }

  const anchorSet = new Set(finalPts.map((pt) => pt.origIdx));
  const interpolatedCount = validFg.filter((v) => !anchorSet.has(v.idx)).length;
  const pctInterpolated =
    validFg.length > 0 ? (interpolatedCount / validFg.length) * 100 : 0;

  let maxDeviationM = 0;
  for (const pt of finalPts) {
    const raw = data[pt.origIdx];
    const filtered = fg[pt.origIdx];
    const dist = GeoUtils.haversineMeters(
      raw.lat,
      raw.lon,
      filtered.lat,
      filtered.lon,
    );
    if (dist > maxDeviationM) maxDeviationM = dist;
  }

  return {
    n_raw: data.length,
    n_raw_gps_fixes: rawPts.length,
    n_after_gates: nAfterGates,
    vertex_count: finalPts.length,
    pct_interpolated: +pctInterpolated.toFixed(2),
    total_path_length_m: +pathLengthMeters(validFg).toFixed(1),
    raw_path_length_m: +pathLengthMeters(rawPts).toFixed(1),
    max_deviation_from_raw_m: +maxDeviationM.toFixed(2),
  };
}

module.exports = {
  computeCharacterizationMetrics,
};
