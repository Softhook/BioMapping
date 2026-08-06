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

loadModule(path.join(__dirname, '../geo_utils.js'),          'GeoUtils');
loadModule(path.join(__dirname, '../stats_math.js'),         'StatsMath');
loadModule(path.join(__dirname, '../map_colors.js'),         'MapColors');
loadModule(path.join(__dirname, '../gps_filter.js'),         'GpsFilter');
loadModule(path.join(__dirname, '../gps_pipeline.js'),       'GpsPipeline');
loadModule(path.join(__dirname, '../dwt_filter.js'),         'DWT');
loadModule(path.join(__dirname, '../gsr_filter.js'),         'GsrFilter');
loadModule(path.join(__dirname, '../deconvolution.js'),      'SCRDeconvolution');

const { GSRAnalyzer } = require('../analyzer.js');
const { GSRCSVParser } = require('../csv_parser.js');

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
  const csv = `sec,gsr,latitude,longitude,hdop,pdop,nsats,speed_kts,course_deg,fix
0,2.5,51.5074,-0.1278,1.2,1.5,8,3.2,270,3
0.1,2.6,51.5075,-0.1279,1.3,1.6,9,3.4,271,3`;

  const a = new GSRAnalyzer();
  a.parseCSV(csv);

  assert.strictEqual(a.raw.length, 2);
  // 'sec' is a TIME_KEYWORDS synonym
  assert.ok(Math.abs(a.raw[0].time - 0.0) < 1e-5);
  assert.ok(Math.abs(a.raw[1].time - 0.1) < 1e-5);
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
  assert.strictEqual(a.getMatchingLabel(10.0, 0.5), 'A'); // custom tolerance (exact still hits)

  // Clearing a label removes it (exact + nearby keys)
  a.setPeakLabel(10.0, '');
  assert.strictEqual(a.getMatchingLabel(10.0), '');
});

test('GSRAnalyzer computeTemporalPeakDensity: centered sliding window, peaks/min', () => {
  const a = new GSRAnalyzer();
  assert.deepStrictEqual(a.computeTemporalPeakDensity(60), []); // empty phasic

  a.phasic = [{ time: 0 }, { time: 30 }, { time: 60 }];
  a.peaks = [
    { time: 10, excluded: false },
    { time: 20, excluded: false },
    { time: 50, excluded: false }
  ];

  const d = a.computeTemporalPeakDensity(60);
  assert.strictEqual(d.length, 3);
  // Window ±30s: t=0 counts peaks 10,20 (2); t=30 counts all three (3); t=60 counts peak 50 only (1)
  assert.strictEqual(d[0].time, 0);
  assert.strictEqual(d[0].val, 2);
  assert.strictEqual(d[1].val, 3);
  assert.strictEqual(d[2].val, 1);

  // Excluded peaks are ignored by the count
  a.peaks.push({ time: 15, excluded: true });
  const d2 = a.computeTemporalPeakDensity(60);
  assert.strictEqual(d2[0].val, 2);
  assert.strictEqual(d2[1].val, 3);

  // Narrower window scales the rate: ±15s, 1 peak in window -> (60/30) = 2 peaks/min
  const a2 = new GSRAnalyzer();
  a2.phasic = [{ time: 0 }];
  a2.peaks = [{ time: 10, excluded: false }, { time: 20, excluded: false }];
  const d3 = a2.computeTemporalPeakDensity(30);
  assert.strictEqual(d3[0].val, 2);
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
