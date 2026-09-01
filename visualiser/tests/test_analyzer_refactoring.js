'use strict';

const assert = require('assert');
const test   = require('node:test');
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

loadModule(path.join(__dirname, '../src/gps/geo_utils.js'),          'GeoUtils');
loadModule(path.join(__dirname, '../src/signal/stats_math.js'),         'StatsMath');
loadModule(path.join(__dirname, '../src/map/map_colors.js'),         'MapColors');
loadModule(path.join(__dirname, '../src/gps/gps_filter.js'),         'GpsFilter');
loadModule(path.join(__dirname, '../src/gps/gps_pipeline.js'),       'GpsPipeline');
loadModule(path.join(__dirname, '../src/signal/dwt_filter.js'),         'DWT');
loadModule(path.join(__dirname, '../src/signal/gsr_filter.js'),         'GsrFilter');
loadModule(path.join(__dirname, '../src/signal/deconvolution.js'),      'SCRDeconvolution');

const { GSRAnalyzer } = require('../src/signal/analyzer.js');
const { GSRCSVParser } = require('../src/signal/csv_parser.js');

// ── Time & Date Formatting Tests ─────────────────────────────────────────────

test('GSRAnalyzer formatting: relative fallback when recordingStartTime is 0', () => {
  const a = new GSRAnalyzer();
  a.recordingStartTime = 0;

  // formatClockTime: hours/minutes/seconds
  assert.strictEqual(a.formatClockTime(45), '0:45');
  assert.strictEqual(a.formatClockTime(3665), '1:01:05');

  // formatTimeOnly: falls back to formatClockTime
  assert.strictEqual(a.formatTimeOnly(45), '0:45');
  assert.strictEqual(a.formatTimeOnly(3665), '1:01:05');

  // formatDateUK: falls back to formatClockTime
  assert.strictEqual(a.formatDateUK(45), '0:45');

  // formatDateShort: falls back to formatClockTime
  assert.strictEqual(a.formatDateShort(45), '0:45');
});

test('GSRAnalyzer formatting: absolute dates when recordingStartTime is real', () => {
  const a = new GSRAnalyzer();
  // 1798725600: Tuesday, December 30, 2026 14:00:00 UTC
  a.recordingStartTime = 1798725600;

  // formatClockTime at t = 0
  assert.strictEqual(a.formatClockTime(0), '14:00:00');
  // formatClockTime at t = 75 (14:01:15)
  assert.strictEqual(a.formatClockTime(75), '14:01:15');

  // formatTimeOnly at t = 75
  assert.strictEqual(a.formatTimeOnly(75), '14:01:15');

  // formatDateUK suffixes
  a.recordingStartTime = 1798725600; // Dec 31 (31st)
  assert.strictEqual(a.formatDateUK(0), '31st Dec 2026');

  // test st suffix: Jan 1st 2027 (1798808400 is Jan 1st 13:00 UTC)
  a.recordingStartTime = 1798808400 + 3600; // Jan 1st 14:00 UTC
  assert.strictEqual(a.formatDateUK(0), '1st Jan 2027');

  // test nd suffix: Jan 2nd
  a.recordingStartTime = 1798808400 + 86400 + 3600;
  assert.strictEqual(a.formatDateUK(0), '2nd Jan 2027');

  // test rd suffix: Jan 3rd
  a.recordingStartTime = 1798808400 + 2 * 86400 + 3600;
  assert.strictEqual(a.formatDateUK(0), '3rd Jan 2027');

  // test th suffix: Jan 4th
  a.recordingStartTime = 1798808400 + 3 * 86400 + 3600;
  assert.strictEqual(a.formatDateUK(0), '4th Jan 2027');

  // formatDateShort: Dec 31st 2026
  a.recordingStartTime = 1798725600;
  assert.strictEqual(a.formatDateShort(0), '31.12.2026');

  // test th suffix for teens: Jan 11th 2027
  a.recordingStartTime = 1798808400 + 10 * 86400 + 3600;
  assert.strictEqual(a.formatDateUK(0), '11th Jan 2027');
});

// ── CSV Parsing & Interpolation Tests ────────────────────────────────────────

test('GSRAnalyzer parseCSV: basic parsing and column mapping', () => {
  const csv = `time,lat,lon,gsr_raw,hdop,sats
1000.0,51.5074,-0.1278,2.5,1.2,8
1000.1,51.5075,-0.1279,2.6,1.3,9`;

  const a = new GSRAnalyzer();
  a.parseCSV(csv);

  assert.strictEqual(a.raw.length, 2);
  assert.strictEqual(a.recordingStartTime, 1000.0);
  assert.ok(Math.abs(a.raw[0].time - 0.0) < 1e-5);
  assert.ok(Math.abs(a.raw[1].time - 0.1) < 1e-5);
  assert.strictEqual(a.raw[0].val, 2.5);
  assert.strictEqual(a.raw[0].lat, 51.5074);
  assert.strictEqual(a.raw[0].lon, -0.1278);
  assert.strictEqual(a.raw[0].hdop, 1.2);
  assert.strictEqual(a.raw[0].sats, 8);
  // sampleRate is derived from a mean of float time diffs, so compare with a
  // tolerance rather than exact equality (1/0.1 !== 10 in IEEE-754).
  assert.ok(Math.abs(a.sampleRate - 10) < 1e-5, `expected sampleRate ~10, got ${a.sampleRate}`);
});

test('GSRAnalyzer parseCSV: metadata comments parsed correctly', () => {
  const csv = `# RecordingStartTime:1798725600
# FilterParams:{"peakThreshold":0.03}
# GpsFilterParams:{"maxHdop":2.5}
# EnrichmentRadius:75
# Band Floors (dBm): rssi_868:-105, rssi_915:-98
time,gsr,osm_road_class
0.0,1.5,"residential"
0.1,1.6,"residential"`;

  const a = new GSRAnalyzer();
  a.parseCSV(csv);

  assert.strictEqual(a.recordingStartTime, 1798725600);
  assert.deepStrictEqual(a.importedFilterParams, { peakThreshold: 0.03 });
  assert.deepStrictEqual(a.importedGpsFilterParams, { maxHdop: 2.5 });
  assert.strictEqual(a.enrichmentRadius, 75);
  assert.deepStrictEqual(a.bandFloors, { rssi_868: -105, rssi_915: -98 });
});

test('GSRAnalyzer parseCSV: quote escaping and comma-handling', () => {
  const csv = `time,gsr,osm_road_class
0.0,1.2,"residential"
0.1,1.3,"primary, trunk"
0.2,1.4,"escaped ""quotes"" here"`;

  const a = new GSRAnalyzer();
  a.parseCSV(csv);

  assert.strictEqual(a.raw[0].osm_road_class, 'residential');
  assert.strictEqual(a.raw[1].osm_road_class, 'primary, trunk');
  assert.strictEqual(a.raw[2].osm_road_class, 'escaped "quotes" here');
});

test('GSRAnalyzer parseCSV: resistance conversion (Ohms -> uS)', () => {
  const csv = `time,ohms
0.0,500000
0.1,1000000`; // 500k Ohm = 2 uS, 1M Ohm = 1 uS

  const a = new GSRAnalyzer();
  a.parseCSV(csv);

  assert.strictEqual(a.isResistance, true);
  assert.strictEqual(a.raw[0].val, 2.0);
  assert.strictEqual(a.raw[1].val, 1.0);
});

test('GSRAnalyzer parseCSV: nanoSiemens conversion to microSiemens', () => {
  const csv = `time,conductance_ns
0.0,1200
0.1,1500`; // 1200 nS = 1.2 uS

  const a = new GSRAnalyzer();
  a.parseCSV(csv);

  assert.strictEqual(a.isResistance, false);
  assert.strictEqual(a.raw[0].val, 1.2);
  assert.strictEqual(a.raw[1].val, 1.5);
});

test('GSRAnalyzer parseCSV: duplicate timestamps reconstructed', () => {
  const csv = `time,gsr
10.0,1.1
10.0,1.2
10.0,1.3
10.0,1.4`;

  const a = new GSRAnalyzer();
  a.parseCSV(csv);

  // Time diffs should be reconstructed with 0.1s increments (since totalTimeDiff is 0)
  assert.ok(Math.abs(a.raw[0].time - 0.0) < 1e-5);
  assert.ok(Math.abs(a.raw[1].time - 0.1) < 1e-5);
  assert.ok(Math.abs(a.raw[2].time - 0.2) < 1e-5);
  assert.ok(Math.abs(a.raw[3].time - 0.3) < 1e-5);
});

test('GSRAnalyzer parseCSV: validation warnings and error checks', () => {
  // Empty check
  const emptyCsv = "";
  const aEmpty = new GSRAnalyzer();
  assert.throws(() => aEmpty.parseCSV(emptyCsv), /CSV file is empty/);

  // Timestamp reversals
  const badCsv = `time,gsr,lat,lon
10.0,1.0,0.0,0.0
9.0,1.1,51.5,-0.1`;
  const aBad = new GSRAnalyzer();
  aBad.parseCSV(badCsv);
  assert.ok(aBad._csvWarnings.some(w => w.includes('non-monotonic')));
  assert.ok(aBad._csvWarnings.some(w => w.includes('startup sentinel')));
});

// ── Canonical column-synonym matching ────────────────────────────────────────

test('GSRAnalyzer parseCSV: canonical column synonyms (sec/latitude/longitude/nsats/fix/speed/course)', () => {
  // Headers deliberately ordered so the parser's timestamp/gsr fallbacks (col 0
  // / col 1) can NOT mask a broken synonym mapping:
  //  - 'sec' sits at index 1, NOT the fallback column (0). If the TIME keyword
  //    match breaks, timestamp resolves to col 0 (the 'lat' column) whose
  //    0.0001 spacing differs from the intended 0.1s -> the time assertions fail.
  //  - 'gsr' sits at index 2, NOT the fallback column (1). If the GSR keyword
  //    match breaks, gsr_raw resolves to col 1 (the 'sec' column) -> val=0 fails.
  const csv = `lat,sec,gsr,longitude,hdop,pdop,nsats,speed_kts,course_deg,fix
51.5074,0,2.5,-0.1278,1.2,1.5,8,3.2,270,3
51.5075,0.1,2.6,-0.1279,1.3,1.6,9,3.4,271,3`;

  const a = new GSRAnalyzer();
  a.parseCSV(csv);

  assert.strictEqual(a.raw.length, 2);
  // 'sec' is a TIME_KEYWORDS synonym
  assert.ok(Math.abs(a.raw[0].time - 0.0) < 1e-5);
  assert.ok(Math.abs(a.raw[1].time - 0.1) < 1e-5);
  // 'gsr' is a GSR_KEYWORDS synonym
  assert.strictEqual(a.raw[0].val, 2.5);
  // 'latitude'/'longitude' map to lat/lon
  assert.strictEqual(a.raw[0].lat, 51.5074);
  assert.strictEqual(a.raw[0].lon, -0.1278);
  // hdop / pdop
  assert.strictEqual(a.raw[0].hdop, 1.2);
  assert.strictEqual(a.raw[0].pdop, 1.5);
  // 'nsats' -> sats
  assert.strictEqual(a.raw[0].sats, 8);
  // speed_kts / course_deg
  assert.strictEqual(a.raw[0].speedKts, 3.2);
  assert.strictEqual(a.raw[0].course, 270);
  // 'fix' -> fix_type fallback (older schema)
  assert.strictEqual(a.raw[0].fixType, 3);
});

test('GSRAnalyzer parseCSV: longitude lng synonym and explicit is_gps_fix column', () => {
  const csv = `time,gsr,lat,lng,is_gps_fix
0.0,1.0,51.5,-0.1,1
0.1,1.1,51.6,-0.2,0`;

  const a = new GSRAnalyzer();
  a.parseCSV(csv);

  assert.strictEqual(a.raw[0].lat, 51.5);
  // 'lng' is a recognized longitude synonym
  assert.strictEqual(a.raw[0].lon, -0.1);
  // explicit is_gps_fix column overrides the lat/lon-presence heuristic
  assert.strictEqual(a.raw[0]._isGpsFix, true);
  assert.strictEqual(a.raw[1]._isGpsFix, false);
});

// ── Failure cases ────────────────────────────────────────────────────────────

test('GSRAnalyzer parseCSV: header-only CSV throws no-valid-data error', () => {
  const a = new GSRAnalyzer();
  assert.throws(() => a.parseCSV('time,gsr\n'), /No valid numeric data/);
});

// ── Extracted helper: GSRCSVParser ───────────────────────────────────────────

test('GSRCSVParser.parse: returns the documented result fields', () => {
  const csv = `# RecordingStartTime:1798725600
# FilterParams:{"peakThreshold":0.03}
# GpsFilterParams:{"maxHdop":2.5}
# EnrichmentRadius:75
time,gsr,osm_road_class
0.0,1.5,"residential"
0.1,1.6,"residential"`;

  const res = GSRCSVParser.parse(csv);

  assert.ok(Array.isArray(res.raw));
  assert.strictEqual(res.raw.length, 2);
  assert.strictEqual(res.isResistance, false);
  assert.strictEqual(res.recordingStartTime, 1798725600);
  assert.deepStrictEqual(res.importedFilterParams, { peakThreshold: 0.03 });
  assert.deepStrictEqual(res.importedGpsFilterParams, { maxHdop: 2.5 });
  // EnrichmentRadius metadata passthrough + enriched flag (OSM column present)
  assert.strictEqual(res.enrichmentRadius, 75);
  assert.strictEqual(res.isEnriched, true);
  assert.strictEqual(res.hasRfData, false);
  assert.ok(res.rfPeakIndices instanceof Set);
  assert.strictEqual(res.warnings, null);
  assert.ok(res.importedPeakLabels instanceof Map);
  assert.ok(res.importedPeakExcluded instanceof Map);
  assert.ok(Math.abs(res.sampleRate - 10) < 1e-5, `expected sampleRate ~10, got ${res.sampleRate}`);
});

// ── Analyzer helpers: findClosestIndex / getMatchingLabel / peak density ────

test('GSRAnalyzer findClosestIndex: binary search over raw timestamps', () => {
  const a = new GSRAnalyzer();

  // Empty raw -> -1
  assert.strictEqual(a.findClosestIndex(15), -1);

  a.raw = [{ time: 0 }, { time: 10 }, { time: 20 }, { time: 30 }];
  // Before first / after last clamp to the endpoints
  assert.strictEqual(a.findClosestIndex(-5), 0);
  assert.strictEqual(a.findClosestIndex(40), 3);
  // Exact match returns that index
  assert.strictEqual(a.findClosestIndex(10), 1);
  assert.strictEqual(a.findClosestIndex(30), 3);
  // Between two points returns the nearer index
  assert.strictEqual(a.findClosestIndex(14), 1);  // nearer to 10
  assert.strictEqual(a.findClosestIndex(16), 2);  // nearer to 20
});

test('GSRAnalyzer getMatchingLabel: exact match then nearest within tolerance', () => {
  const a = new GSRAnalyzer();
  assert.strictEqual(a.getMatchingLabel(10.0), '');   // no labels stored

  a.setPeakLabel(10.0, 'A');
  a.setPeakLabel(20.0, 'B');

  assert.strictEqual(a.getMatchingLabel(10.0), 'A');  // exact key match
  assert.strictEqual(a.getMatchingLabel(10.5), 'A');  // nearest within 1.0s
  assert.strictEqual(a.getMatchingLabel(11.0), 'A');  // at the tolerance boundary
  assert.strictEqual(a.getMatchingLabel(11.1), '');   // outside tolerance
  assert.strictEqual(a.getMatchingLabel(19.0), 'B');  // nearer to B
  assert.strictEqual(a.getMatchingLabel(null), '');   // null target
  // Custom tolerance actually narrows the window: 0.4s is within the default
  // 1.0s but outside a 0.3s tolerance.
  assert.strictEqual(a.getMatchingLabel(10.4, 0.3), '');
  assert.strictEqual(a.getMatchingLabel(10.4), 'A');

  // Clearing a label removes it (exact + nearby keys)
  a.setPeakLabel(10.0, '');
  assert.strictEqual(a.getMatchingLabel(10.0), '');
});

test('GSRAnalyzer _dataVersion: bumped by every mutation path a self-validating cache must key on', () => {
  // Phase 2 (docs/archive/visualizer_architecture_refactor_plan.md): callers that cache
  // derived data off an analyzer (e.g. GSRUI's environmental dashboard) key
  // their cache on _dataVersion instead of relying on being told to invalidate.
  // This only works if every mutation path actually bumps it — that's what's
  // under test here, not the counter mechanics themselves.
  const a = new GSRAnalyzer();
  assert.strictEqual(a._dataVersion, 0);

  a.setPeakLabel(10.0, 'A');
  assert.strictEqual(a._dataVersion, 1, 'setPeakLabel bumps _dataVersion');

  a.peaks = [{ time: 10, excluded: false }];
  a.setPeakExcluded(0, true);
  assert.strictEqual(a.peaks[0].excluded, true, 'setPeakExcluded flips the flag');
  assert.strictEqual(a._dataVersion, 2, 'setPeakExcluded bumps _dataVersion');

  // Out-of-range index is a no-op, including for the version counter.
  a.setPeakExcluded(5, true);
  assert.strictEqual(a._dataVersion, 2, 'setPeakExcluded on an invalid index does not bump _dataVersion');

  a.raw = [{ time: 0, val: 1 }, { time: 1, val: 2 }];
  a.analyze(GSR_CONST.GSR_DEFAULT, 0);
  assert.strictEqual(a._dataVersion, 3, 'analyze() bumps _dataVersion');
});

test('GSRAnalyzer computeTemporalPeakDensity: Gaussian KDE scaled by spotlight window, peaks/min', () => {
  const a = new GSRAnalyzer();
  assert.deepStrictEqual(a.computeTemporalPeakDensity(60), []); // empty phasic

  a.phasic = [{ time: 0 }, { time: 30 }, { time: 100 }];
  a.peaks = [
    { time: 28, excluded: false },
    { time: 32, excluded: false }
  ];

  const d = a.computeTemporalPeakDensity(60);
  assert.strictEqual(d.length, 3);
  assert.strictEqual(d[0].time, 0);
  // All density values are non-negative and continuous floats
  assert.ok(d.every(pt => pt.val >= 0));
  // t=30 is centrally situated near the burst at 28s and 32s -> high continuous density
  assert.ok(d[1].val > d[0].val && d[1].val > d[2].val, 'density peaks at t=30 near the event cluster');

  // Excluded peaks are ignored by the count
  const valBefore = d[1].val;
  a.peaks.push({ time: 30, excluded: true });
  const d2 = a.computeTemporalPeakDensity(60);
  assert.ok(Math.abs(d2[1].val - valBefore) < 1e-9, 'excluded peak does not affect density');

  // Active peak at t=30 increases the continuous density at t=30
  a.peaks.push({ time: 30, excluded: false });
  const d3 = a.computeTemporalPeakDensity(60);
  assert.ok(d3[1].val > valBefore, 'active peak at t=30 increases density');
});

// ── GSRCSVParser statics: _csvEscape / _detectRfPeakIndices ─────────────────

test('GSRCSVParser._csvEscape: RFC4180 double-quote escaping', () => {
  assert.strictEqual(GSRCSVParser._csvEscape(null), '');
  assert.strictEqual(GSRCSVParser._csvEscape(undefined), '');
  assert.strictEqual(GSRCSVParser._csvEscape('plain'), '"plain"');
  assert.strictEqual(GSRCSVParser._csvEscape('has "quotes"'), '"has ""quotes"""');
  assert.strictEqual(GSRCSVParser._csvEscape(123), '"123"');
});

test('GSRCSVParser._detectRfPeakIndices: momentary spike on any band', () => {
  // Middle sample is 5 dB above both neighbours -> spike
  const spike = GSRCSVParser._detectRfPeakIndices([
    { rssi_868: -100 },
    { rssi_868: -95 },
    { rssi_868: -100 }
  ]);
  assert.deepStrictEqual([...spike], [1]);

  // Gradual/no prominent peak -> empty set
  const noSpike = GSRCSVParser._detectRfPeakIndices([
    { rssi_868: -100 },
    { rssi_868: -101 },
    { rssi_868: -100 }
  ]);
  assert.strictEqual(noSpike.size, 0);

  // Spike on the first row (no previous neighbour) is still detected
  const boundary = GSRCSVParser._detectRfPeakIndices([
    { rssi_868: -95 },
    { rssi_868: -100 },
    { rssi_868: -100 }
  ]);
  assert.deepStrictEqual([...boundary], [0]);

  // Spike on a different band is found too
  const otherBand = GSRCSVParser._detectRfPeakIndices([
    { rssi_915: -90 },
    { rssi_915: -85 },
    { rssi_915: -90 }
  ]);
  assert.deepStrictEqual([...otherBand], [1]);
});

// ── Peak labelling & scoring: _assignLabelsToPeaks / quality / salience ─────

test('GSRAnalyzer _assignLabelsToPeaks: assigns nearest label within 1.0s window', () => {
  const a = new GSRAnalyzer();
  a.setPeakLabel(10.0, 'A');
  a.setPeakLabel(20.0, 'B');

  const peaks = [{ time: 10.0 }, { time: 10.4 }, { time: 20.0 }, { time: 50.0 }];
  a._assignLabelsToPeaks(peaks);

  assert.strictEqual(peaks[0].label, 'A');   // exact match
  assert.strictEqual(peaks[2].label, 'B');   // exact match
  // 10.4 is within 1.0s of 'A', but 'A' is already used 1-to-1; too far from 'B'
  assert.strictEqual(peaks[1].label, undefined);
  assert.strictEqual(peaks[3].label, undefined);  // 50.0 too far from any label
});

test('GSRAnalyzer _assignLabelsToPeaks: greedy 1-to-1, closest peak wins the label', () => {
  const a = new GSRAnalyzer();
  a.setPeakLabel(10.0, 'A');

  const peaks = [{ time: 10.2 }, { time: 10.0 }];
  a._assignLabelsToPeaks(peaks);

  // The exact-match peak (index 1) grabs the label; the farther one (10.2) gets nothing
  assert.strictEqual(peaks[1].label, 'A');
  assert.strictEqual(peaks[0].label, undefined);
});

test('GSRAnalyzer _assignLabelsToPeaks: no-ops and boundary cases', () => {
  const a = new GSRAnalyzer();

  // No labels stored -> no-op
  const peaks = [{ time: 10.0 }];
  a._assignLabelsToPeaks(peaks);
  assert.strictEqual(peaks[0].label, undefined);

  // null / empty peaks -> no throw
  a.setPeakLabel(5, 'X');
  a._assignLabelsToPeaks(null);
  a._assignLabelsToPeaks([]);

  // Empty-string labels are skipped (candidate requires a truthy label)
  const b = new GSRAnalyzer();
  b._userPeakLabels = new Map([[10.0, '']]);
  const peaks2 = [{ time: 10.0 }];
  b._assignLabelsToPeaks(peaks2);
  assert.strictEqual(peaks2[0].label, undefined);

  // A peak exactly at the 1.0s tolerance boundary still matches
  const c = new GSRAnalyzer();
  c.setPeakLabel(10.0, 'A');
  const peaks3 = [{ time: 11.0 }, { time: 11.1 }];
  c._assignLabelsToPeaks(peaks3);
  assert.strictEqual(peaks3[0].label, 'A');
  assert.strictEqual(peaks3[1].label, undefined);
});

test('GSRAnalyzer _computePeakQuality: ideal peak scores 1, poor peak scores low', () => {
  const a = new GSRAnalyzer();
  const near = (actual, expected, msg) => {
    assert.ok(Math.abs(actual - expected) < 1e-9, `${msg} — got ${actual}, expected ${expected}`);
  };

  // All shape metrics ideal -> every weight contributes fully -> 1.0
  const ideal = {
    amplitude: 0.5, halfRecoveryTime: 2.0, riseTime: 1.0, skewnessRatio: 0.5,
    onsetSlope: 0.5, snr: 5.0, decaySlope: 0.05
  };
  near(a._computePeakQuality(ideal), 1.0, 'ideal peak');

  // Everything outside the credited ranges -> only amplitude contributes (0.02)
  const poor = {
    amplitude: 0.05, riseTime: 10, halfRecoveryTime: 20, skewnessRatio: 5,
    onsetSlope: 10, snr: 1.0, decaySlope: 0
  };
  near(a._computePeakQuality(poor), 0.02, 'poor peak');

  // Half-credit branches: 0.5 amplitude, edge-of-ideal recovery/rise, etc.
  const partial = {
    amplitude: 0.25, riseTime: 4.0, halfRecoveryTime: 6.0, skewnessRatio: 1.5,
    onsetSlope: 2.0, snr: 2.5, decaySlope: 0.002
  };
  // 0.10 + 0.075 + 0.075 + 0.09 + 0.05 + 0.105 + 0.10 = 0.595
  near(a._computePeakQuality(partial), 0.595, 'partial peak');
});

test('GSRAnalyzer _computeSalienceScore: fast, high-amplitude, high-SNR peaks win', () => {
  const a = new GSRAnalyzer();
  const near = (actual, expected, msg) => {
    assert.ok(Math.abs(actual - expected) < 1e-9, `${msg} — got ${actual}, expected ${expected}`);
  };

  // All maxed -> 1.0
  near(a._computeSalienceScore({ amplitude: 0.5, onsetSlope: 0.5, snr: 3.0 }), 1.0, 'salient');
  // All zero -> 0.0
  near(a._computeSalienceScore({ amplitude: 0, onsetSlope: 0, snr: 0 }), 0.0, 'faint');
  // onsetSlope missing -> falls back to amplitude/riseTime
  near(a._computeSalienceScore({ amplitude: 0.5, riseTime: 1.0, snr: 3.0 }), 1.0, 'slope fallback');
  // snr missing -> default 0.5 score (0.50 + 0.30 + 0.5*0.20 = 0.90)
  near(a._computeSalienceScore({ amplitude: 0.5, onsetSlope: 0.5 }), 0.90, 'no snr default');
});

// ── _computeNoiseFloor perf fix (2026-08-07) ────────────────────────────────
// Found via real A/B benchmarking (docs/archive/visualizer_architecture_refactor_plan.md
// Phase 8): _computeNoiseFloor() used to rebuild `this.filtered.map(d => d.val)`
// — a full-array copy — on every call, even though it only ever reads a small
// ±halfWindow slice. Called once per candidate peak inside detectPeaks()'s main
// loop (hundreds per track), this was ~170ms of a ~210ms analyze() call on a
// real 35k-row track. Fixed to index directly into this.filtered instead.
// These tests pin the windowed stdev computation itself (unaffected by the
// fix — same math, different array access) plus the boundary-clamp behavior
// the fix's array-length handling depends on getting right.
test('GSRAnalyzer _computeNoiseFloor: population stdev over the exact ±halfWindow slice', () => {
  const a = new GSRAnalyzer();
  // filtered[3..7] = [1, 2, 3, 4, 5] around idx=5, halfWindow=2 -> window [3..7].
  a.filtered = [10, 10, 10, 1, 2, 3, 4, 5, 10, 10].map((val, i) => ({ time: i, val }));
  const windowVals = [1, 2, 3, 4, 5];
  const mean = windowVals.reduce((s, v) => s + v, 0) / windowVals.length;
  const expected = Math.sqrt(windowVals.reduce((s, v) => s + (v - mean) ** 2, 0) / windowVals.length);
  const actual = a._computeNoiseFloor(5, 2);
  assert.ok(Math.abs(actual - expected) < 1e-9, `expected ${expected}, got ${actual}`);
});

test('GSRAnalyzer _computeNoiseFloor: clamps the window at the start of the array (idx=0)', () => {
  const a = new GSRAnalyzer();
  a.filtered = [1, 2, 3, 4, 5].map((val, i) => ({ time: i, val }));
  // idx=0, halfWindow=2 -> window clamps to [0..2] = [1, 2, 3], not [-2..2].
  const windowVals = [1, 2, 3];
  const mean = windowVals.reduce((s, v) => s + v, 0) / windowVals.length;
  const expected = Math.sqrt(windowVals.reduce((s, v) => s + (v - mean) ** 2, 0) / windowVals.length);
  const actual = a._computeNoiseFloor(0, 2);
  assert.ok(Math.abs(actual - expected) < 1e-9, `expected ${expected}, got ${actual}`);
});

test('GSRAnalyzer _computeNoiseFloor: clamps the window at the end of the array (idx=length-1)', () => {
  const a = new GSRAnalyzer();
  a.filtered = [1, 2, 3, 4, 5].map((val, i) => ({ time: i, val }));
  // idx=4 (last), halfWindow=2 -> window clamps to [2..4] = [3, 4, 5], not [2..6].
  const windowVals = [3, 4, 5];
  const mean = windowVals.reduce((s, v) => s + v, 0) / windowVals.length;
  const expected = Math.sqrt(windowVals.reduce((s, v) => s + (v - mean) ** 2, 0) / windowVals.length);
  const actual = a._computeNoiseFloor(4, 2);
  assert.ok(Math.abs(actual - expected) < 1e-9, `expected ${expected}, got ${actual}`);
});

test('GSRAnalyzer _computeNoiseFloor: constant window has zero noise floor', () => {
  const a = new GSRAnalyzer();
  a.filtered = [5, 5, 5, 5, 5].map((val, i) => ({ time: i, val }));
  assert.strictEqual(a._computeNoiseFloor(2, 2), 0);
});

// ── §A perf fix: sliding-window minimum correctness (2026-08-07) ─────────────
// The O(N) monotonic-deque localOffsets result must be identical to the
// O(N×W) brute-force nested loop it replaced. These tests verify the algorithm
// in isolation on synthetic data (boundary cases + mid-track) and confirm that
// analyze() still produces non-negative phasic values (the floor's purpose).

function bruteForceWindowMin(arr, halfWindow) {
  const n = arr.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const s = Math.max(0, i - halfWindow);
    const e = Math.min(n - 1, i + halfWindow);
    let mn = Infinity;
    for (let j = s; j <= e; j++) if (arr[j] < mn) mn = arr[j];
    out[i] = mn;
  }
  return out;
}

function dequeWindowMin(arr, halfWindow) {
  // Verbatim copy of the two-pass algorithm now in analyze().
  const n = arr.length;
  const result = new Array(n);
  const bwd = new Array(n);
  const dq1 = [];
  for (let i = 0; i < n; i++) {
    if (dq1.length > 0 && dq1[0] < i - halfWindow) dq1.shift();
    while (dq1.length > 0 && arr[dq1[dq1.length - 1]] >= arr[i]) dq1.pop();
    dq1.push(i);
    bwd[i] = arr[dq1[0]];
  }
  const dq2 = [];
  for (let i = n - 1; i >= 0; i--) {
    if (dq2.length > 0 && dq2[0] > i + halfWindow) dq2.shift();
    while (dq2.length > 0 && arr[dq2[dq2.length - 1]] >= arr[i]) dq2.pop();
    dq2.push(i);
    result[i] = Math.min(bwd[i], arr[dq2[0]]);
  }
  return result;
}

test('§A sliding-window min: deque matches brute-force on a 200-sample synthetic signal', () => {
  const n = 200, halfW = 20;
  const arr = [];
  for (let i = 0; i < n; i++) arr.push(Math.sin(i * 0.3) * 5 - i * 0.01);
  const brute = bruteForceWindowMin(arr, halfW);
  const deque = dequeWindowMin(arr, halfW);
  for (let i = 0; i < n; i++) {
    assert.ok(Math.abs(deque[i] - brute[i]) < 1e-12,
      `index ${i}: deque=${deque[i]} brute=${brute[i]}`);
  }
});

test('§A sliding-window min: single-element array (window >> length)', () => {
  assert.deepStrictEqual(dequeWindowMin([42], 100), bruteForceWindowMin([42], 100));
});

test('§A sliding-window min: window of 1 (halfWindow=0 clamp to 1)', () => {
  const arr = [3, 1, 4, 1, 5, 9, 2, 6];
  // halfWindow=1 → each position sees [i-1..i+1]
  assert.deepStrictEqual(dequeWindowMin(arr, 1), bruteForceWindowMin(arr, 1));
});

test('§A sliding-window min: all-equal values', () => {
  const arr = new Array(50).fill(7.5);
  assert.deepStrictEqual(dequeWindowMin(arr, 15), bruteForceWindowMin(arr, 15));
});

test('§A sliding-window min: analyze() phasic is non-negative after deque fix', () => {
  const fs = require('fs'), path = require('path');
  const csvPath = path.join(__dirname, '..', '..', 'tracks', 'biomap_048.csv');
  if (!fs.existsSync(csvPath)) { return; } // skip if tracks dir absent
  const a = new GSRAnalyzer();
  a.parseCSV(fs.readFileSync(csvPath, 'utf8'));
  a.analyze(JSON.parse(JSON.stringify(GSR_CONST.GSR_DEFAULT)), 0);
  assert.strictEqual(a.phasic.length, a.raw.length);
  for (let i = 0; i < a.phasic.length; i++) {
    assert.ok(a.phasic[i].val >= -1e-9, `phasic[${i}]=${a.phasic[i].val} should be >= 0`);
  }
});

// ── §B perf fix: computeCombinedArousalIndex with precomputedAUC (2026-08-07) ─

test('§B computeCombinedArousalIndex: precomputedAUC gives identical values to fresh-computed path', () => {
  const fs = require('fs'), path = require('path');
  const csvPath = path.join(__dirname, '..', '..', 'tracks', 'biomap_048.csv');
  if (!fs.existsSync(csvPath)) { return; }
  const a = new GSRAnalyzer();
  a.parseCSV(fs.readFileSync(csvPath, 'utf8'));
  a.analyze(JSON.parse(JSON.stringify(GSR_CONST.GSR_DEFAULT)), 0);

  const fresh  = a.computeCombinedArousalIndex(0.3, 0.7, null);   // fresh AUC
  const reused = a.computeCombinedArousalIndex(0.3, 0.7, a.phasicAUC); // reused

  assert.strictEqual(fresh.length, reused.length, 'length mismatch');
  for (let i = 0; i < fresh.length; i++) {
    assert.ok(Math.abs(fresh[i].val - reused[i].val) < 1e-9,
      `index ${i}: fresh=${fresh[i].val} reused=${reused[i].val}`);
    assert.strictEqual(fresh[i].time, reused[i].time);
  }
});

test('§B computeCombinedArousalIndex: standalone call (no precomputedAUC) still works', () => {
  const fs = require('fs'), path = require('path');
  const csvPath = path.join(__dirname, '..', '..', 'tracks', 'biomap_048.csv');
  if (!fs.existsSync(csvPath)) { return; }
  const a = new GSRAnalyzer();
  a.parseCSV(fs.readFileSync(csvPath, 'utf8'));
  a.analyze(JSON.parse(JSON.stringify(GSR_CONST.GSR_DEFAULT)), 0);
  const result = a.computeCombinedArousalIndex(); // no args — must not throw
  assert.strictEqual(result.length, a.phasic.length);
  assert.ok(isFinite(result[0].val));
});

test('GSRAnalyzer computeTriIndex: precomputed arrays match fresh standalone computation', () => {
  const fs = require('fs'), path = require('path');
  const csvPath = path.join(__dirname, '..', '..', 'tracks', 'biomap_048.csv');
  if (!fs.existsSync(csvPath)) { return; }
  const a = new GSRAnalyzer();
  a.parseCSV(fs.readFileSync(csvPath, 'utf8'));
  a.analyze(JSON.parse(JSON.stringify(GSR_CONST.GSR_DEFAULT)), 0);

  const fresh = a.computeTriIndex(0.10, 0.45, 0.45, null, null);
  const reused = a.computeTriIndex(0.10, 0.45, 0.45, a.phasicAUC, a.peakDensity);

  assert.strictEqual(fresh.length, reused.length, 'length mismatch');
  for (let i = 0; i < fresh.length; i++) {
    assert.ok(Math.abs(fresh[i].val - reused[i].val) < 1e-9,
      `index ${i}: fresh=${fresh[i].val} reused=${reused[i].val}`);
    assert.strictEqual(fresh[i].time, reused[i].time);
  }
});

test('GSRAnalyzer computeTriIndex: empty input returns empty array and default args work', () => {
  const a = new GSRAnalyzer();
  assert.deepStrictEqual(a.computeTriIndex(), []);
});

