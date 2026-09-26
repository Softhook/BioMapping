/**
 * Regression tests for the 2026-09-24 maths review. Each test pins one
 * defect that was reproduced against the old code:
 *   unit detection, map-match angle wrap, SparsEDA speed labels, the
 *   matching-pursuit gate, the marching-squares saddle, prominence plateaus,
 *   hillshade zenith, KDE/AUC edge bias, buffer area weights, the
 *   collective envelope floor and the EDASymp time axis.
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
  // Speed runs opposite to the kernel stretch: the compressed one is fastest.
  assert.strictEqual(near(20).speedLabel, 'Sharp');
  assert.strictEqual(near(20).durationScale, 0.5);
  assert.strictEqual(near(70).durationScale, 1.5);
  assert.ok(near(70).scaleFactor < near(20).scaleFactor);
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

// ── 2026-09-26 numerical-hardening pass ────────────────────────────────────

const { StatsMath } = require('../src/signal/stats_math.mjs');
const { GsrFilter } = require('../src/signal/gsr_filter.mjs');
const { GeoUtils } = require('../src/gps/geo_utils.mjs');

test('the gait filter on a file sampled below 2 Hz passes the signal through, not NaN', () => {
  // A 1 Hz low-pass at 1.5 Hz is above Nyquist: the biquad went unstable.
  const x = Array.from({ length: 400 }, (_, i) => 5 + Math.sin(i / 20));
  const y = GsrFilter.applyZeroPhaseLinkwitzRiley(x, 1.0, 1.5);
  assert.deepStrictEqual(y, x);
  // Below Nyquist it still filters.
  const z = GsrFilter.applyZeroPhaseLinkwitzRiley(x, 1.0, 10);
  assert.ok(z.every(Number.isFinite));
});

test('Pearson r stays accurate on large values with a small spread', () => {
  // UTM-northing-sized x: the raw-sums formula drifted ~1% here.
  let seed = 1;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const x = Array.from({ length: 36000 }, () => 5.7e6 + 20 * rnd());
  const y = x.map((v) => v * 0.01 + rnd());
  const mx = x.reduce((a, b) => a + b) / x.length;
  const my = y.reduce((a, b) => a + b) / y.length;
  let sxy = 0,
    sxx = 0,
    syy = 0;
  for (let i = 0; i < x.length; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
    syy += (y[i] - my) ** 2;
  }
  const want = sxy / Math.sqrt(sxx * syy);
  const { r } = StatsMath.calculatePearsonCorrelation(x, y);
  assert.ok(Math.abs(r - want) < 1e-9, `r ${r} vs ${want}`);
});

test('Pearson r of a perfect line is exactly within [-1, 1]', () => {
  const x = Array.from({ length: 1000 }, (_, i) => 1e6 + i * 0.1);
  assert.ok(Math.abs(StatsMath.calculatePearsonCorrelation(x, x).r) <= 1);
  const neg = x.map((v) => -3 * v);
  assert.ok(StatsMath.calculatePearsonCorrelation(x, neg).r >= -1);
});

test('haversine of antipodal points is half the circumference, not NaN', () => {
  // This pair rounds the haversine term to 1.0000000000000002.
  const lat = -82.49999999999991;
  const d = GeoUtils.haversineMeters(lat, -179.9, -lat, 0.1);
  assert.ok(Math.abs(d - Math.PI * GeoUtils.EARTH_RADIUS_M) < 1, `${d}`);
});

test('OSM metrics before the first GPS fix hold its value, not a backwards extrapolation', () => {
  const metrics = (green, distRoad) => ({
    roadClass: 'residential',
    inPark: 0,
    distMajorRoad: distRoad,
    greenSpacePct: green,
    distGreen: 40,
    canopyPct: 0,
    buildingDensity: 1,
    distWater: 200,
    treeDensity: 0,
    amenityCount: 0,
  });
  // First fix at row 50: rows 0-49 have no position yet.
  const computed = [
    { idx: 50, metrics: metrics(20, 100) },
    { idx: 60, metrics: metrics(40, 50) },
  ];
  const raw = Array.from({ length: 61 }, () => ({}));
  OSMEnricher._projectToTimeline(raw, computed);
  // Unclamped, row 0 read green -80 % and a -150 m road distance.
  assert.strictEqual(raw[0].osm_green_pct_50m, 20);
  assert.strictEqual(raw[0].osm_dist_major_road, 100);
  assert.strictEqual(raw[55].osm_green_pct_50m, 30); // still interpolates between fixes
});

test('meta-analysis of walks with identical correlations gives a finite p, not p = 0', () => {
  const x = Array.from({ length: 40 }, (_, i) => Math.sin(i * 1.7) + i * 0.01);
  const y = x.map((v, i) => 0.3 * v + Math.cos(i * 2.3));
  const walk = { x, y };
  const { p, k } = StatsMath.metaCorrelation([walk, walk, walk]);
  assert.strictEqual(k, 3);
  assert.ok(p > 0 && p < 1, `p ${p}`);
});

test('Pearson r on arrays of different lengths uses the common prefix, not NaN', () => {
  const x = [1, 2, 3, 4, 5, 6];
  const y = [2, 4, 5, 8];
  const { r } = StatsMath.calculatePearsonCorrelation(x, y);
  assert.strictEqual(
    r,
    StatsMath.calculatePearsonCorrelation(x.slice(0, 4), y).r,
  );
  assert.ok(Number.isFinite(r));
});

test('regression R² is never below 0 for an orthogonal fit', () => {
  // Unclamped, this fit's R² rounds to -4.4e-16.
  const x = [0.4, 0.8, 0.6, 0.6];
  const y = [0.2, 0.2, 0.30000000000000004, 0.30000000000000004];
  assert.ok(StatsMath.calculateLinearRegression(x, y).r2 >= 0);
});

test('road profile: a zero-arousal road class gives a μS gap, not "Infinity%"', async () => {
  const { bootApp } = require('./support/boot_app.js');
  const { window, document } = await bootApp();
  window.setup();
  const row = {
    name: 'primary',
    timeSpent: 60,
    effSamples: 10,
    meanPhasic: 0.045,
    stdPhasic: 0.01,
    ciPhasic: 0.01,
    meanTonic: 5,
    ciTonic: 0.1,
    peakRate: 2,
  };
  const quiet = { ...row, name: 'path', meanPhasic: 0 };
  window.GSRUI.renderRoadProfile([row, quiet], null);
  const text = document.getElementById('roadInterpretationText').textContent;
  assert.ok(!text.includes('Infinity'), text);
  assert.ok(text.includes('0.045 μS higher'), text);
});
