/**
 * Regression tests for the 2026-09-24 maths review. Each test pins one
 * defect that was reproduced against the old code:
 *   unit detection, map-match angle wrap, SparsEDA speed labels, the
 *   matching-pursuit gate, the marching-squares saddle, prominence plateaus,
 *   hillshade zenith, KDE/AUC edge bias, buffer area weights, the Kalman
 *   joint gate, the collective envelope floor and the EDASymp time axis.
 */
const assert = require('node:assert');
const test = require('node:test');

global.GSR_CONST = require('./mock_constants.js');
const { GSRCSVParser } = require('../src/signal/csv_parser.mjs');
const { MapMatcher } = require('../src/gps/map_match.mjs');
const { SCRDeconvolution } = require('../src/signal/deconvolution.mjs');
const { GSRAnalyzer } = require('../src/signal/analyzer.mjs');
const { MarchingSquares } = require('../src/render/marching_squares.mjs');
const { PeakDetectors } = require('../src/signal/peak_detectors.mjs');
const { Hillshade } = require('../src/map/hillshade.mjs');
const { AnalyzerStats } = require('../src/signal/analyzer_stats.mjs');
const { OSMEnricher } = require('../src/osm/osm_enrichment.mjs');
const { GpsFilter } = require('../src/gps/gps_filter.mjs');
const {
  GSRCollectiveManager,
} = require('../src/spatial/collective_manager.mjs');
const { SpectralEDA } = require('../src/signal/spectral_eda.mjs');

const csvOf = (header, vals) =>
  `timestamp,${header}\n${vals.map((v, i) => `${(i / 10).toFixed(1)},${v}`).join('\n')}`;

test('gsr_raw is nS by schema even when the recording is mostly disconnected', () => {
  // Mean ~20 nS: under the old magnitude guess this stayed 1000x too large.
  const vals = Array.from({ length: 50 }, (_, i) => (i === 25 ? 800 : 16.9));
  const raw = GSRCSVParser.parse(csvOf('gsr_raw', vals)).raw;
  assert.ok(Math.abs(raw[0].val - 0.0169) < 1e-9, `got ${raw[0].val}`);
  assert.ok(Math.abs(raw[25].val - 0.8) < 1e-9);
});

test('an explicit (uS) header is never rescaled, whatever its magnitude', () => {
  const vals = Array.from({ length: 20 }, () => 150); // > MICROSIEMENS_MIN_AVG
  const raw = GSRCSVParser.parse(csvOf('Raw Conductance (uS)', vals)).raw;
  assert.strictEqual(raw[0].val, 150);
});

test('map-match angular difference is never negative and never exceeds π', () => {
  const deg = (x) => (x * Math.PI) / 180;
  for (let c = 0; c < 360; c += 5) {
    for (let b = -175; b <= 180; b += 5) {
      const d = MapMatcher._angularDiff(deg(c), deg(b));
      assert.ok(
        d >= 0 && d <= Math.PI + 1e-12,
        `course ${c} bearing ${b}: ${d}`,
      );
    }
  }
  // 350° vs 280° (atan2 −80°) is 70°, not −70°.
  const d = MapMatcher._angularDiff(deg(350), deg(-80));
  assert.ok(Math.abs(d - deg(70)) < 1e-9);
});

test('SparsEDA labels a fast (time-compressed) SCR fast and a slow one slow', () => {
  const fs = 10;
  const n = 1200;
  const x = new Float64Array(n);
  const add = (t0, ts, tf) => {
    for (let i = 0; i < n; i++) {
      const t = i / fs - t0;
      if (t > 0) x[i] += Math.exp(-t / ts) - Math.exp(-t / tf);
    }
  };
  add(20, 1.0, 0.25); // standard kernel compressed 2x
  add(70, 3.0, 0.75); // stretched 1.5x
  const r = SCRDeconvolution.deconvolve(x, fs, { algorithm: 'sparseda' });
  const near = (t0) =>
    r.impulseLog
      .filter((e) => Math.abs(e.trueIndex / fs - t0) < 3)
      .sort((a, b) => b.amplitude - a.amplitude)[0];
  assert.strictEqual(near(20).speedLabel, 'Very Fast');
  assert.strictEqual(near(20).durationScale, 0.5);
  assert.strictEqual(near(70).speedLabel, 'Very Slow');
  assert.strictEqual(near(70).durationScale, 1.5);
});

test('matching-pursuit reconstruction excludes impulses below peakThreshold', () => {
  const fs = 10;
  const k = SCRDeconvolution.buildSCRFKernel(fs, 2, 0.75, 10);
  const rows = ['timestamp,Raw Conductance (uS)'];
  const y = new Float64Array(900).fill(5);
  const add = (i0, a) => {
    for (let j = 0; j < k.length && i0 + j < y.length; j++)
      y[i0 + j] += a * k[j];
  };
  add(150, 0.6);
  add(500, 0.01); // well under the default 0.045 threshold
  for (let i = 0; i < y.length; i++)
    rows.push(`${(i / fs).toFixed(1)},${y[i]}`);
  const a = new GSRAnalyzer();
  a.parseCSV(rows.join('\n'));
  a.analyze({ ...GSR_CONST.GSR_DEFAULT, useDeconvolution: true }, 0);
  let tiny = 0;
  for (let i = 480; i < 560; i++) tiny = Math.max(tiny, a.phasicClean[i].val);
  assert.ok(tiny < 1e-6, `sub-threshold atom leaked into phasicClean: ${tiny}`);
});

test('marching-squares saddles are disambiguated the same way on both diagonals', () => {
  const b = { minLat: 0, maxLat: 1, minLon: 0, maxLon: 1 };
  // Centre mean 0.7 ≥ 0.5 → highs joined → the two LOW corners are cut off.
  const lowCorners = (g) =>
    MarchingSquares.getContourLines(g, 2, 2, b, 0.5).map((seg) => {
      const lat = seg[0].lat + seg[1].lat < 1 ? 0 : 1;
      const lon = seg[0].lon + seg[1].lon < 1 ? 0 : 1;
      return `${lat}${lon}`;
    });
  const case5 = [
    [0.4, 1.0],
    [1.0, 0.4],
  ];
  const case10 = [
    [1.0, 0.4],
    [0.4, 1.0],
  ];
  assert.deepStrictEqual(lowCorners(case5).sort(), ['00', '11']);
  assert.deepStrictEqual(lowCorners(case10).sort(), ['01', '10']);
  for (const g of [case5, case10]) {
    assert.deepStrictEqual(
      MarchingSquares.getContourLines(g, 2, 2, b, 0.5),
      MarchingSquares.getContourLinesMulti(g, 2, 2, b, [0.5]).get(0.5),
    );
  }
});

test('a flat two-sample apex keeps its prominence and is detected', () => {
  const v = [0, 0.1, 0.2, 0.3, 0.2, 0.1, 0, 0.1, 0.25, 0.25, 0.1, 0, 0.05, 0];
  const prom = PeakDetectors.topographicProminence(v);
  assert.ok(Math.abs(prom[8] - 0.25) < 1e-12);
  assert.ok(PeakDetectors.prominenceNMS(v, prom, 0.045, 1, 80).includes(8));
});

test('hillshade lights flat ground at sin(altitude) (solar zenith convention)', () => {
  const grid = Array.from({ length: 5 }, () => new Array(5).fill(1));
  const s = Hillshade.compute(grid, 5, 5, 1, 1, { altitudeDeg: 35 });
  assert.ok(Math.abs(s[12] - Math.sin((35 * Math.PI) / 180)) < 1e-6);
});

test('peak density and AUC are not biased low at the recording edges', () => {
  const ph = [];
  for (let i = 0; i <= 3000; i++) ph.push({ time: i / 10, val: 0.1 });
  const peaks = [];
  for (let t = 2; t <= 300; t += 4) peaks.push({ time: t });
  const d = AnalyzerStats.computeTemporalPeakDensity(ph, peaks, 60);
  for (const i of [0, 150, 1500, 3000]) {
    assert.ok(Math.abs(d[i].val - 15) < 0.1, `density[${i}] = ${d[i].val}`);
  }
  const auc = AnalyzerStats.computePhasicAUC(ph, 10, false, null, 30).series;
  for (const i of [0, 1500, 3000]) {
    assert.ok(Math.abs(auc[i].val - 3.0) < 0.05, `auc[${i}] = ${auc[i].val}`);
  }
});

test('green/canopy buffer sampling points are area-weighted', () => {
  const g = OSMEnricher._buildSamplingGrid(51.5, -0.1, 50);
  const sum = g.reduce((s, p) => s + p.w, 0);
  assert.ok(Math.abs(sum - 1) < 1e-12);
  // Perimeter ring = annulus 0.75r..r = 7/16 of the disc (was 16/25).
  const perimeter = g.slice(9).reduce((s, p) => s + p.w, 0);
  assert.ok(Math.abs(perimeter - 7 / 16) < 1e-12);
});

test('Kalman gate never half-applies a fix (joint 2-D test)', () => {
  const pts = [];
  for (let i = 0; i < 20; i++)
    pts.push({ lat: 51.5, lon: -0.1, time: i, hdop: 1 });
  // A jump that is extreme in longitude only.
  pts[10] = { lat: 51.50002, lon: -0.099, time: 10, hdop: 1 };
  const out = GpsFilter._kalmanForwardPass(
    pts,
    1e-10,
    1e-10,
    1e-9,
    1e-9,
    () => 1e-9,
    () => 1e-9,
  );
  assert.strictEqual(out.isOutlier[10], 1);
  // Rejected as a whole: latitude must not have moved toward the bad fix.
  assert.strictEqual(out.forwardLats[10], out.forwardLats[9]);
});

test('collective peak-preservation envelope does not lift z-scored troughs toward 0', () => {
  const n = 144;
  const pts = [];
  const z = [];
  for (let i = 0; i < n; i++) {
    const r = Math.floor(i / 12);
    const c = i % 12;
    pts.push({ lat: 51.5 + r * 0.0003, lon: -0.1 + c * 0.0005 });
    const v = r === 3 && c === 3 ? 2 : r === 8 && c === 8 ? -2 : 0;
    z.push({ time: i, val: v });
  }
  const m = new GSRCollectiveManager();
  m.addTrack({
    id: 't',
    enabled: true,
    analyzer: {
      raw: new Array(n).fill(0),
      sampleRate: 1,
      getCoordinates: (i) => pts[i],
      phasic: z,
      phasicZ: z,
      tonic: z,
      tonicZ: z,
      phasicAUC: z,
      arousalIndex: z,
      triIndex: z,
      filtered: z,
      peakDensity: z,
      phasicStd: 1,
      peaks: [],
    },
  });
  const res = m.generateContourSurface({
    topographySource: 'phasic',
    normalizeZScore: true,
    peakPreservation: 0.5,
    blurIterations: 0,
    temporalSmoothingWindow: 0,
  });
  // Old code: min ≈ −0.26 against max ≈ +1.22.
  assert.ok(res.minVal < -0.6, `trough flattened: ${res.minVal}`);
});

test('EDASymp window times come from the real timestamps, not an even-rate assumption', () => {
  // 10 Hz nominal with one sample in 50 dropped (~9.8 Hz effective).
  const times = [];
  let t = 0;
  for (let i = 0; i < 6000; i++) {
    times.push(t);
    t += i % 50 === 49 ? 0.2 : 0.1;
  }
  const sig = times.map((s) => 5 + 0.2 * Math.sin(s / 7));
  const series = SpectralEDA.computeSeries(
    sig,
    Float64Array.from(times),
    10,
    {},
  );
  const last = series[series.length - 1];
  const tEnd = times[times.length - 1];
  // A 64 s window's centre sits ≥ 32 s before the end, and within one hop of it.
  assert.ok(
    tEnd - last.time >= 32 - 1e-6 && tEnd - last.time < 32 + 6,
    `${tEnd - last.time}`,
  );
});
