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

  // High but inside the device's limit (75 µS): 60 µS = 60 000 nS.
  const midUs = parseQuiet(
    rows('Raw Conductance (uS)', (i) => (60 + wave(i)).toFixed(4)),
  );
  const midNs = parseQuiet(
    rows('gsr_raw', (i) => (60000 + 1000 * wave(i)).toFixed(1)),
  );
  assert.ok(
    !has(midUs, 'more than skin conducts'),
    'µS file must not be flagged',
  );
  assert.ok(!has(midNs, 'more than skin conducts'));

  // Past the top of the range: 80 µS = 80 000 nS.
  const highUs = parseQuiet(
    rows('Raw Conductance (uS)', (i) => (80 + wave(i)).toFixed(4)),
  );
  const highNs = parseQuiet(
    rows('gsr_raw', (i) => (80000 + 1000 * wave(i)).toFixed(1)),
  );
  assert.ok(has(highUs, 'more than skin conducts'), 'µS file must be flagged');
  assert.ok(has(highNs, 'more than skin conducts'));

  // A real disconnect floor in either unit.
  const zeroUs = parseQuiet(
    rows('Raw Conductance (uS)', (i) =>
      (i === 50 ? 0 : 5 + wave(i)).toFixed(4),
    ),
  );
  assert.ok(has(zeroUs, 'near-zero'));
});

test('a file whose every GSR reading is 0 is reported as having no GSR, not as an electrode problem', () => {
  // What GPS + RF mode (and a device that can't reach its GSR sensor) writes:
  // the usual GPS+GSR+RF columns with gsr_raw 0.0 on every row. No Mode line
  // here, as in a file from before the line existed.
  const lines = [
    'timestamp,lat,lon,hdop,pdop,sats,fix_type,speed_kts,course_deg,gsr_raw,hacc_m,rssi_815,rssi_868,rssi_915',
  ];
  for (let i = 0; i < 200; i++) {
    const lat = (51.5 + i * 1e-5).toFixed(7);
    lines.push(
      `${(i / 10).toFixed(2)},${lat},-0.0700000,0.8,1.2,12,3,1.20,90.0,0.0,2.5,-90.0,-88.5,-91.0`,
    );
  }
  const r = parseQuiet(`${lines.join('\n')}\n`);
  const warnings = r.warnings || [];
  assert.strictEqual(r.hasGsrData, false);
  assert.ok(
    warnings.some((w) => w.includes('no GSR readings')),
    'says the file has no GSR',
  );
  for (const blame of ['near-zero', 'flat', 'skin contact', 'disconnected']) {
    assert.ok(
      !warnings.some((w) => w.includes(blame)),
      `no "${blame}" warning: ${JSON.stringify(warnings)}`,
    );
  }

  // One real reading among the zeros is a GSR file again.
  const one = parseQuiet(
    `${lines.join('\n').replace(/,0\.0,2\.5,/, ',5000.0,2.5,')}\n`,
  );
  assert.strictEqual(one.hasGsrData, true);
});

test('a stretch with the cuffs off is reported, with or without a device calibration', () => {
  const has = (r, text) => (r.warnings || []).some((w) => w.includes(text));
  // 60 s walk; rows 200-399 (20 s) read the flat open-circuit value.
  const file = (floor) =>
    `timestamp,gsr_raw\n${Array.from({ length: 600 }, (_, i) => {
      const v = i >= 200 && i < 400 ? floor : 5000 + 300 * Math.sin(i / 9);
      return `${(i / 10).toFixed(2)},${v.toFixed(1)}`;
    }).join('\n')}\n`;

  // Uncalibrated floor (16.9 nS) and a calibrated one (the offset, 107 nS,
  // which is above the firmware's 100 nS line).
  for (const floor of [16.9, 107.0]) {
    const r = parseQuiet(file(floor));
    assert.ok(has(r, 'looks disconnected for about 2'), `floor ${floor}`);
    assert.ok(has(r, 'in the middle (1 stretch)'));
    assert.ok(has(r, 'bridges it.'));
  }

  // Cuffs put on after pressing record (first 15 s flat) and taken off
  // before stopping (last 10 s flat): said by position, with no repair
  // advice, since neither can be bridged.
  const edges = parseQuiet(
    `timestamp,gsr_raw\n${Array.from({ length: 600 }, (_, i) => {
      const v = i < 150 || i >= 500 ? 16.9 : 5000 + 300 * Math.sin(i / 9);
      return `${(i / 10).toFixed(2)},${v.toFixed(1)}`;
    }).join('\n')}\n`,
  );
  const edgeMsg = (edges.warnings || []).find((w) =>
    w.includes('looks disconnected'),
  );
  assert.ok(edgeMsg, 'start/end stretches reported');
  assert.match(
    edgeMsg,
    /about the first 1\d s and the last \d+ s of this recording\.$/,
  );
  assert.ok(!edgeMsg.includes('Repair'), edgeMsg);
  // The same walk with no flat stretch has nothing to report.
  const clean = parseQuiet(
    `timestamp,gsr_raw\n${Array.from({ length: 600 }, (_, i) => `${(i / 10).toFixed(2)},${(5000 + 300 * Math.sin(i / 9)).toFixed(1)}`).join('\n')}\n`,
  );
  assert.strictEqual(clean.warnings, null);
});

test('track averages and peak rate leave out the disconnected stretch', () => {
  const { AnalyzerStats } = require('../src/signal/analyzer_stats.mjs');
  // 100 s at 1 Hz. Rows 0-49 are a disconnected stretch at the floor
  // (0.017 µS); rows 50-100 read 4 µS. Two peaks: one inside the stretch
  // (the reconnect jump), one in the connected part.
  const series = (on, off) =>
    Array.from({ length: 101 }, (_, i) => ({
      time: i,
      val: i < 50 ? off : on,
    }));
  const raw = series(4, 0.017);
  const peaks = [
    { index: 49, amplitude: 3, excluded: false },
    { index: 80, amplitude: 0.5, excluded: false },
  ];
  const auc = series(10, 0);
  const off = [{ startIdx: 0, endIdx: 49 }];

  const s = AnalyzerStats.getStats(raw, raw, peaks, auc, off);
  assert.strictEqual(s.duration, 100, 'duration is still the whole recording');
  assert.strictEqual(s.connectedDuration, 51);
  assert.strictEqual(s.meanSCL, 4, 'floor rows are not averaged in');
  assert.strictEqual(
    s.peakCount,
    1,
    'the peak inside the stretch is not counted',
  );
  assert.strictEqual(s.meanPeakAmplitude, 0.5);
  assert.ok(
    Math.abs(s.peakFrequency - 60 / 51) < 1e-9,
    'peaks per connected minute',
  );
  assert.strictEqual(s.meanPhasicAUC, 10);

  // No stretches: same as before (whole-track means).
  const all = AnalyzerStats.getStats(raw, raw, peaks, auc, []);
  assert.strictEqual(all.peakCount, 2);
  assert.ok(Math.abs(all.meanSCL - (50 * 0.017 + 51 * 4) / 101) < 1e-9);

  // Everything disconnected: falls back to the whole track, not zeros.
  const flat = AnalyzerStats.getStats(raw, raw, peaks, auc, [
    { startIdx: 0, endIdx: 100 },
  ]);
  assert.strictEqual(flat.peakCount, 2);
  assert.strictEqual(flat.connectedDuration, 100);

  // End to end: a walk whose first 30 s are the open-circuit floor. The
  // analyser's average skin conductance must come from the connected part.
  const lines = ['timestamp,gsr_raw'];
  for (let i = 0; i < 1200; i++) {
    const nS = i < 300 ? 16.9 : 5000 + 300 * Math.sin(i / 9);
    lines.push(`${(i / 10).toFixed(2)},${nS.toFixed(1)}`);
  }
  const a = new GSRAnalyzer();
  const warn = console.warn;
  console.warn = () => {};
  try {
    a.parseCSV(lines.join('\n'));
    a.analyze(JSON.parse(JSON.stringify(GSR_CONST.GSR_DEFAULT)));
  } finally {
    console.warn = warn;
  }
  assert.ok(a.gsrDisconnectSpans.length >= 1, 'the floor stretch is found');
  const st = a.getStats();
  // Tonic sits a little under the raw ~5 µS (peaks ride on top of it), and
  // its 45 s smoothing drags the floor into the first ~10 s after the
  // reconnect, so ~4.4 µS. Averaging the floor rows in as well would give
  // ~3.3 µS.
  const allTonic = a.tonic.reduce((acc, d) => acc + d.val, 0) / a.tonic.length;
  assert.ok(
    st.meanSCL > 4 && st.meanSCL > allTonic * 1.2,
    `mean SCL ${st.meanSCL} µS (whole track ${allTonic}) should not be pulled down by the floor`,
  );
  assert.ok(st.connectedDuration < st.duration);
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

test('a GPS + RF recording (its Mode line) has no GSR and gets no GSR notice; another mode reading all 0 says the sensor was not found', () => {
  const body = (mode) => {
    const lines = [
      '# RecordingStartTime:1795165687',
      '# DeviceName:Tester',
      `# Mode:${mode}`,
      'timestamp,lat,lon,hdop,pdop,sats,fix_type,speed_kts,course_deg,gsr_raw,hacc_m,rssi_815,rssi_868,rssi_915',
    ];
    for (let i = 0; i < 200; i++) {
      const lat = (51.5 + i * 1e-5).toFixed(7);
      lines.push(
        `${(i / 10).toFixed(2)},${lat},-0.0700000,0.8,1.2,12,3,1.20,90.0,0.0,2.5,-90.0,-88.5,-91.0`,
      );
    }
    return `${lines.join('\n')}\n`;
  };

  const radio = parseQuiet(body(GSR_CONST.GPS_RF_MODE));
  assert.strictEqual(radio.recordingMode, 'GPS + RF');
  assert.strictEqual(radio.hasGsrData, false);
  assert.ok(
    !(radio.warnings || []).some((w) => /GSR|sensor|electrode/i.test(w)),
    `no GSR notice for a radio recording: ${JSON.stringify(radio.warnings)}`,
  );
  // Kept with the device lines, so a processed export still says it.
  assert.ok(radio.deviceHeaderLines.includes('# Mode:GPS + RF'));

  const broken = parseQuiet(body('GPS + GSR + RF'));
  assert.strictEqual(broken.hasGsrData, false);
  assert.deepStrictEqual(
    (broken.warnings || []).filter((w) => w.includes('no GSR readings')),
    [
      "This recording has no GSR readings (every value is 0): the GSR sensor wasn't found.",
    ],
  );
});

test('the GSR Calibration and GSR Bias header lines are read into gsrSetup and kept for export', () => {
  const file = (extra) =>
    `${[
      '# RecordingStartTime:1795165687',
      '# DeviceName:Tester',
      ...extra,
      'timestamp,gsr_raw',
      ...Array.from(
        { length: 60 },
        (_, i) =>
          `${(i / 10).toFixed(2)},${(5000 + 50 * Math.sin(i / 4)).toFixed(1)}`,
      ),
    ].join('\n')}\n`;

  const cal =
    '# GSR Calibration: gain:1.0123,zero_counts:-321.4,r2:0.9991,noise_ns:0.40,1.10,2.39,cal_time:1790000000';
  const both = parseQuiet(
    file([cal, '# GSR Bias: measured_mv:498.6,used_mv:498.6']),
  );
  assert.deepStrictEqual(both.gsrSetup, {
    calibration: {
      gain: 1.0123,
      zeroCounts: -321.4,
      r2: 0.9991,
      noiseNs: [0.4, 1.1, 2.39],
      calTime: 1790000000,
    },
    bias: { measuredMv: 498.6, usedMv: 498.6 },
  });
  assert.ok(both.deviceHeaderLines.includes(cal));

  // A failed check is written "none"; uncalibrated has no calibration line.
  const failed = parseQuiet(
    file(['# GSR Bias: measured_mv:none,used_mv:500.0']),
  );
  assert.deepStrictEqual(failed.gsrSetup, {
    calibration: null,
    bias: { measuredMv: null, usedMv: 500 },
  });

  // Neither line (a file from elsewhere): nothing to say.
  assert.strictEqual(parseQuiet(file([])).gsrSetup, null);
  assert.strictEqual(parseQuiet(file([])).recordingMode, null);
});
