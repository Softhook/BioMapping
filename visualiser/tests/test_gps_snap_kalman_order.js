/**
 * Regression coverage for the snap-vs-Kalman ordering fix (docs/todo.md's
 * "GPS pipeline architecture" §Core issue, fixed 2026-09-18 in
 * manager/process.js): road snap correction must run AFTER the Kalman
 * filter, not before, so a wrong HMM road-match can't poison the filter's
 * internal state and drag genuine fixes around it off course.
 *
 * Scenario: a straight synthetic walk with a sustained wrong-street snap
 * (~8m sideways, alpha 0.9) over a stretch, then genuine unsnapped fixes
 * resume. If snap ran before Kalman, those resuming genuine fixes would be
 * measurably pulled toward the residual contamination in the filter's
 * state; with snap after Kalman, the filter never saw the bad snap, so the
 * genuine fixes come out close to their true position (only the ordinary
 * RTS boundary-smoothing effect, not the snap).
 *
 * Run: node --test tests/test_gps_snap_kalman_order.js
 */

const assert = require('node:assert');
const test = require('node:test');
const vm = require('node:vm');
const { bootApp } = require('./support/boot_app.js');

async function boot() {
  const { window } = await bootApp();
  window.HTMLCanvasElement.prototype.getContext = () => ({
    fillStyle: '',
    fillRect() {},
  });
  window.setup();
  return { window, mapManager: window.AppState.mapManager };
}

// A straight walk north at 1.4 m/s, 1 Hz fixes, good HDOP/PDOP throughout.
// speed_kts/course_deg are left blank so applyStopAveraging/applySpeedFilter/
// applyVelocitySmoothing (which all early-return without velocity data) stay
// no-ops — isolating the test to the snap/Kalman interaction only.
function buildStraightWalkCsv(n, latDegPerStep) {
  const lines = [
    'timestamp,lat,lon,hdop,pdop,sats,fix_type,speed_kts,course_deg,gsr_raw,hacc_m',
  ];
  const LAT0 = 51.5,
    LON0 = -0.1;
  for (let i = 0; i < n; i++) {
    const lat = LAT0 + i * latDegPerStep;
    lines.push(
      `${i}.00,${lat.toFixed(9)},${LON0.toFixed(9)},1.0,1.0,10,3,,,5.0,`,
    );
  }
  return lines.join('\n');
}

test('road snap applied after Kalman does not drag genuine fixes that follow a wrong-street stretch off course', async () => {
  const { mapManager } = await boot();
  const GeoUtils = vm.runInThisContext('GeoUtils');
  const GSR_CONST = vm.runInThisContext('GSR_CONST');

  const N = 16;
  const speedMs = 1.4;
  const scale = GeoUtils.getGeodesicScale(51.5);
  const latDegPerStep = speedMs / scale.degToMeterLat;
  const csv = buildStraightWalkCsv(N, latDegPerStep);

  const analyzer = new window.GSRAnalyzer();
  analyzer.parseCSV(csv);
  assert.strictEqual(
    analyzer.raw.length,
    N,
    'synthetic track parsed with N rows',
  );

  // Sustained wrong-street snap on indices 4-9: each step's offset (~8m) is
  // individually small enough that the Kalman chi-squared gate wouldn't flag
  // it as a one-off outlier if it were fed in as the measurement — this is
  // what makes a systematic wrong-road match dangerous, unlike a single
  // wild jump the gate already catches on its own.
  const lonOffsetDeg = 8 / scale.degToMeterLon;
  const snappedGps = {};
  for (let i = 4; i <= 9; i++) {
    snappedGps[i] = {
      alpha: 0.9,
      roadLat: analyzer.raw[i].lat,
      roadLon: analyzer.raw[i].lon + lonOffsetDeg,
    };
  }
  analyzer.snappedGps = snappedGps;

  const p = { ...GSR_CONST.GPS_DEFAULT };
  const { drawPoints } = mapManager._getOrBuildDrawPoints(
    'snap-order-test',
    analyzer,
    p,
  );
  assert.ok(drawPoints.length > 0, 'produced draw points');

  const byOrigIdx = new Map(drawPoints.map((pt) => [pt.origIdx, pt]));

  // Genuine fixes resuming right after the bad-snap stretch (indices 10-13):
  // should stay close to their true raw position. The only distortion
  // remaining at this point is ordinary RTS boundary smoothing on a short
  // synthetic track, not snap contamination — bounded well under half the
  // ~8m snap offset itself.
  for (const i of [10, 11, 12, 13]) {
    const rendered = byOrigIdx.get(i);
    assert.ok(rendered, `drawPoints has an entry for origIdx ${i}`);
    const trueLat = analyzer.raw[i].lat;
    const trueLon = analyzer.raw[i].lon;
    const devM = GeoUtils.haversineMeters(
      trueLat,
      trueLon,
      rendered.lat,
      rendered.lon,
    );
    assert.ok(
      devM < 4.0,
      `origIdx ${i}: genuine fix after the wrong-snap stretch stays near truth (${devM.toFixed(2)}m, expected < 4m)`,
    );
  }

  // The wrongly-snapped stretch itself (indices 4-9) SHOULD show the snap's
  // cosmetic pull almost at full strength (alpha=0.9 of the 8m offset) —
  // confirming snap correction is genuinely the last transform applied, not
  // silently gated away by anything downstream.
  for (const i of [5, 6, 7, 8]) {
    const rendered = byOrigIdx.get(i);
    const trueLat = analyzer.raw[i].lat;
    const trueLon = analyzer.raw[i].lon;
    const devM = GeoUtils.haversineMeters(
      trueLat,
      trueLon,
      rendered.lat,
      rendered.lon,
    );
    assert.ok(
      devM > 5.0,
      `origIdx ${i}: wrong-snap stretch still visibly pulled toward the road (${devM.toFixed(2)}m, expected > 5m)`,
    );
  }
});
