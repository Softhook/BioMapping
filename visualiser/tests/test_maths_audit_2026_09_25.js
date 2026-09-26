/**
 * Regression tests for the 2026-09-25 maths audit. Each test pins one defect
 * that was reproduced against the old code: east-west distance to a segment
 * away from the equator, single-series effective sample size, and the
 * p-value of a perfect correlation.
 */
const assert = require('node:assert');
const test = require('node:test');

global.GSR_CONST = require('../src/core/constants.mjs').GSR_CONST;
const { GeoUtils } = require('../src/gps/geo_utils.mjs');
const { StatsMath } = require('../src/signal/stats_math.mjs');

test('distanceToSegmentMeters: east-west offset at London latitude matches haversine', () => {
  // North-south segment along lon 0; point 0.001° east of its middle.
  const lat = 51.5;
  const d = GeoUtils.distanceToSegmentMeters(
    lat,
    0.001,
    lat - 0.01,
    0,
    lat + 0.01,
    0,
  );
  const truth = GeoUtils.haversineMeters(lat, 0, lat, 0.001);
  // Old code returned ~1.6x truth here.
  assert.ok(Math.abs(d - truth) / truth < 0.01, `got ${d}, want ~${truth}`);
});

test('distanceToSegmentMeters: diagonal offset at 60°N matches haversine to the foot point', () => {
  const r = GeoUtils.projectPointToSegment(
    60.0005,
    10.002,
    60,
    10,
    60.001,
    10.004,
  );
  const truth = GeoUtils.haversineMeters(60.0005, 10.002, r.lat, r.lon);
  assert.ok(
    Math.abs(r.distance - truth) < 0.05,
    `got ${r.distance}, want ~${truth}`,
  );
});

test('effectiveSampleSize: AR(1) series follows Bartlett (linear ρ), not ρ²', () => {
  // AR(1) with φ = 0.85: Bartlett VIF → (1+φ)/(1-φ) ≈ 12.3.
  // The old ρ² sum gave (1+φ²)/(1-φ²) ≈ 5.3, i.e. n_eff ~2.3x too large.
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const gauss = () =>
    Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
  const phi = 0.85;
  const n = 5000;
  const x = new Array(n);
  x[0] = gauss();
  for (let i = 1; i < n; i++) x[i] = phi * x[i - 1] + gauss();

  const nEff = StatsMath.effectiveSampleSize(x);
  const bartlett = n / ((1 + phi) / (1 - phi));
  const squared = n / ((1 + phi * phi) / (1 - phi * phi));
  assert.ok(
    Math.abs(nEff - bartlett) < Math.abs(nEff - squared),
    `nEff ${nEff.toFixed(0)} should be nearer Bartlett ${bartlett.toFixed(0)} than ρ² ${squared.toFixed(0)}`,
  );
  assert.ok(
    nEff < 1.4 * bartlett,
    `nEff ${nEff.toFixed(0)} vs Bartlett ${bartlett.toFixed(0)}`,
  );
});

test('calculatePearsonCorrelation: perfect correlation gives p = 0, not 1', () => {
  const x = [1, 2, 3, 4, 5, 6];
  const { r, p } = StatsMath.calculatePearsonCorrelation(
    x,
    x.map((v) => 2 * v + 1),
  );
  assert.ok(Math.abs(r - 1) < 1e-12);
  assert.strictEqual(p, 0);
});
