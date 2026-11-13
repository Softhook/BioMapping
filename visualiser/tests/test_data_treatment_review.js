/**
 * Regression tests for the data-treatment review (GSR + GPS handling). Each
 * test pins one defect that was reproduced against the old code:
 *   peak labels multiplying / spreading / coming back after being cleared,
 *   the smoothed path left behind when every fix fails the gates, a cut-off
 *   last row read as data, and the GSR range warnings ignoring the unit.
 */
const assert = require('node:assert');
const test = require('node:test');

const { GSR_CONST } = require('../src/core/constants.mjs');
const { GSRAnalyzer } = require('../src/signal/analyzer.mjs');
const { GSRCSVParser } = require('../src/signal/csv_parser.mjs');
const { GpsPipeline } = require('../src/gps/gps_pipeline.mjs');

const D = GSR_CONST.GSR_DEFAULT;

/** A 10 Hz walk (µS) with one skin response starting at each of `onsets`. */
function gsrCsv(onsets, { seconds = 120, amp = 0.4 } = {}) {
  const lines = ['Time (s),Raw Conductance (uS)'];
  for (let i = 0; i < seconds * 10; i++) {
    const t = i / 10;
    let v = 5 + 0.002 * Math.sin(t / 7);
    for (const t0 of onsets) {
      if (t > t0)
        v += amp * (Math.exp(-(t - t0) / 2) - Math.exp(-(t - t0) / 0.75));
    }
    lines.push(`${t.toFixed(1)},${v.toFixed(5)}`);
  }
  return `${lines.join('\n')}\n`;
}

function analysed(csv, params = D) {
  const a = new GSRAnalyzer();
  const warn = console.warn;
  console.warn = () => {};
  try {
    a.parseCSV(csv);
  } finally {
    console.warn = warn;
  }
  a.analyze(params);
  return a;
}

const labelsShown = (a) => a.peaks.filter((p) => p.label).map((p) => p.label);

test('a label stays one label when settings change and the peak shifts', () => {
  const a = analysed(gsrCsv([20, 50, 80]));
  assert.strictEqual(a.peaks.length, 3);
  a.relabelPeak(a.peaks[1], 'dog');
  const startTime = a.peaks[1].time;

  // Each of these moves the peak's apex by a sample or two.
  const steps = [
    { useGaitFilter: false },
    { lpfWindow: 2 },
    { tonicWindow: 20 },
    {},
  ];
  let moved = false;
  for (const s of steps) {
    a.analyze({ ...D, ...s });
    const pk = a.peaks.find((p) => p.label === 'dog');
    if (pk && pk.time !== startTime) moved = true;
    assert.deepStrictEqual(labelsShown(a), ['dog']);
    assert.strictEqual(a._userPeakLabels.size, 1, JSON.stringify(s));
    assert.deepStrictEqual(a.hiddenPeakLabels(), []);
  }
  assert.ok(moved, 'the scenario must move the peak, or it tests nothing');
});

test('a label is not copied onto a neighbouring peak within a second of it', () => {
  // Two responses 0.9 s apart, resolved by the deconvolution detector.
  const p = { ...D, useDeconvolution: true, shapeMinSnr: 0 };
  const a = analysed(gsrCsv([30, 60], { amp: 0.5 }), p);
  // Stand in a second peak 0.8 s after the first, as a busy stretch gives.
  const first = a.peaks[0];
  a.relabelPeak(first, 'dog');
  const near = { ...first, index: first.index + 8, time: first.time + 0.8 };
  near.label = '';
  a.peaks.splice(1, 0, near);
  const { oldLabels } = a._preserveLabelsAndExclusions();
  const rebuilt = a._buildPeakObject(
    near.index,
    near.value,
    a.phasic.map((d) => d.val),
    a.phasic.map((d) => d.time),
    { amplitude: 0.1, onsetIdx: near.index - 5, recoveryIdx: -1 },
    oldLabels,
    new Set(),
  );
  assert.strictEqual(rebuilt.label, '', 'the neighbour must not inherit it');
});

test('a label cleared after loading a saved file stays cleared', () => {
  const a = analysed(gsrCsv([20, 50, 80]));
  a.relabelPeak(a.peaks[1], 'dog');
  const b = analysed(a.exportToCSV(D, GSR_CONST.GPS_DEFAULT));
  assert.deepStrictEqual(labelsShown(b), ['dog']);

  b.relabelPeak(
    b.peaks.find((p) => p.label === 'dog'),
    '',
  );
  b.analyze({ ...D, peakThreshold: D.peakThreshold + 0.001 });
  b.analyze(D);
  assert.deepStrictEqual(labelsShown(b), []);
  assert.strictEqual(b._userPeakLabels.size, 0);
});

test('when every fix fails the HDOP gate the old smoothed path is not kept', () => {
  const lines = ['timestamp,lat,lon,hdop,pdop,sats,fix_type,gsr_raw'];
  for (let i = 0; i < 300; i++) {
    lines.push(
      `${(i / 10).toFixed(2)},${(51.5 + i * 1e-5).toFixed(7)},-0.0700000,1.5,2.0,12,3,5000.0`,
    );
  }
  const a = new GSRAnalyzer();
  const warn = console.warn;
  console.warn = () => {};
  try {
    a.parseCSV(`${lines.join('\n')}\n`);
  } finally {
    console.warn = warn;
  }
  const placed = () => a.filteredGps.filter((p) => !isNaN(p.lat)).length;

  GpsPipeline.ensureFilteredGps(a, { maxHdop: 3, maxSpeed: 3 });
  assert.strictEqual(placed(), 300);
  const fixes = GpsPipeline.ensureFilteredGps(a, { maxHdop: 0.8, maxSpeed: 3 });
  assert.strictEqual(fixes.length, 0);
  assert.strictEqual(placed(), 0);
  // And it comes back when the gate is opened again.
  GpsPipeline.ensureFilteredGps(a, { maxHdop: 3, maxSpeed: 3 });
  assert.strictEqual(placed(), 300);
});

test('fill-in between fixes follows time when rows are unevenly spaced', () => {
  // Fixes at t = 0 and t = 1; the rows between sit at 0.1, 0.2 and 0.9 s.
  const data = [0, 0.1, 0.2, 0.9, 1].map((time) => ({ time }));
  const analyzer = {};
  GpsPipeline.reconstructFilteredGps(
    analyzer,
    data,
    [
      { origIdx: 0, lat: 51.5, lon: 0 },
      { origIdx: 4, lat: 51.5001, lon: 0 },
    ],
    3,
  );
  const frac = (i) => (analyzer.filteredGps[i].lat - 51.5) / 0.0001;
  assert.ok(Math.abs(frac(1) - 0.1) < 1e-6, `row 1 at ${frac(1)}`);
  assert.ok(Math.abs(frac(3) - 0.9) < 1e-6, `row 3 at ${frac(3)}`);
});

const deviceFile = (lastRow) => {
  const lines = [
    '# Integrity: crc32 v1',
    '# RecordingStartTime:1785792563',
    'timestamp,lat,lon,hdop,pdop,sats,fix_type,speed_kts,course_deg,gsr_raw',
  ];
  for (let i = 0; i < 100; i++) {
    lines.push(
      `${(i / 10).toFixed(2)},51.5538002,-0.0690060,1.0,1.5,18,3,2.50,200.0,${(4900 + i).toFixed(1)}`,
    );
  }
  return `${lines.join('\n')}\n${lastRow}`;
};

const parseQuiet = (csv) => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    return GSRCSVParser.parse(csv);
  } finally {
    console.warn = warn;
  }
};

test('a device recording cut off mid-row leaves that row out', () => {
  // Cut before the GSR value, and cut inside it (5000.0 → "50").
  for (const cut of [
    '10.00,51.5538002,-0.0690060,1.0',
    '10.00,51.5538002,-0.0690060,1.0,1.5,18,3,2.50,200.0,50',
  ]) {
    const r = parseQuiet(deviceFile(cut));
    assert.strictEqual(r.raw.length, 100, cut);
    assert.ok(Math.abs(r.raw[99].val - 4.999) < 1e-9, `last ${r.raw[99].val}`);
    assert.ok(r.warnings.some((w) => w.includes('cut off')));
    assert.strictEqual(r.integrity.status, 'incomplete');
  }
});

test('a complete last row and an end marker are both still read normally', () => {
  const whole = '10.00,51.5538002,-0.0690060,1.0,1.5,18,3,2.50,200.0,5000.0\n';
  const r = parseQuiet(deviceFile(whole));
  assert.strictEqual(r.raw.length, 101);
  assert.strictEqual(r.warnings, null);
  // A trailer with no newline after it is not a cut-off row.
  const withTrailer = parseQuiet(
    deviceFile(`${whole}# End rows:101 bytes:1 crc32:00000000`),
  );
  assert.strictEqual(withTrailer.raw.length, 101);
  // A file from elsewhere (no integrity marker) keeps its last line.
  const other = parseQuiet(
    'timestamp,gsr_raw\n0.0,5000.0\n0.1,5001.0\n0.2,5002.0',
  );
  assert.strictEqual(other.raw.length, 3);
});

test('GSR range warnings judge a µS file and an nS file the same way', () => {
  const rows = (hdr, f) =>
    `timestamp,${hdr}\n${Array.from({ length: 200 }, (_, i) => `${(i / 10).toFixed(1)},${f(i)}`).join('\n')}\n`;
  const wave = (i) => Math.abs(Math.sin(i / 9));
  const has = (r, text) => (r.warnings || []).some((w) => w.includes(text));

  // A low but normal reading: 0.05–0.09 µS = 50–90 nS.
  const lowUs = parseQuiet(
    rows('Raw Conductance (uS)', (i) => (0.05 + 0.04 * wave(i)).toFixed(4)),
  );
  const lowNs = parseQuiet(
    rows('gsr_raw', (i) => (50 + 40 * wave(i)).toFixed(1)),
  );
  assert.ok(!has(lowUs, 'near-zero'), 'µS file must not be flagged');
  assert.ok(!has(lowNs, 'near-zero'));

  // Past the top of the range: 60 µS = 60 000 nS.
  const highUs = parseQuiet(
    rows('Raw Conductance (uS)', (i) => (60 + wave(i)).toFixed(4)),
  );
  const highNs = parseQuiet(
    rows('gsr_raw', (i) => (60000 + 1000 * wave(i)).toFixed(1)),
  );
  assert.ok(has(highUs, 'rail-saturation'), 'µS file must be flagged');
  assert.ok(has(highNs, 'rail-saturation'));

  // A real disconnect floor in either unit.
  const zeroUs = parseQuiet(
    rows('Raw Conductance (uS)', (i) =>
      (i === 50 ? 0 : 5 + wave(i)).toFixed(4),
    ),
  );
  assert.ok(has(zeroUs, 'near-zero'));
});

test('rows without a GSR value are counted as missing, not as readings', () => {
  // GPS on every row, GSR on one row in four.
  const lines = ['timestamp,lat,lon,gsr_raw'];
  for (let i = 0; i < 200; i++) {
    lines.push(
      `${(i / 10).toFixed(1)},51.5,-0.07,${i % 4 === 0 ? (5000 + i).toFixed(1) : ''}`,
    );
  }
  const r = parseQuiet(`${lines.join('\n')}\n`);
  assert.ok(
    r.warnings.some((w) => w.includes('Only 50/200 rows have GSR data')),
    JSON.stringify(r.warnings),
  );
});

test('a label read from a file stays on its own row when rows are re-sorted', () => {
  // The labelled row (t = 0.5) is written last in the file; sorting moves it.
  const head =
    'Time (s),Raw Conductance (uS),IsPeak,PeakAmplitude,PeakLabel,PeakExcluded';
  const rows = [];
  for (let i = 0; i < 20; i++) {
    if (i === 5) continue;
    rows.push(`${(i / 10).toFixed(3)},5.0000,0,,"",`);
  }
  rows.push('0.500,5.0000,1,0.1000,"dog",0');
  const r = parseQuiet(`${head}\n${rows.join('\n')}\n`);
  assert.deepStrictEqual([...r.importedPeakLabels.entries()], [[0.5, 'dog']]);
});
