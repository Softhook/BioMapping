/**
 * The recording's calibrated per-band noise floors ("# Band Floors (dBm)")
 * set the "nothing here" level of the per-band RF map views — the 2D fluid
 * overlay and the 3D expanse — not just EM fog. Without a floors line the
 * views fall back to the band's quietest reading on the track.
 */
const assert = require('node:assert');
const test = require('node:test');

global.GSR_CONST = require('./mock_constants.js');
const { GSRAnalyzer } = require('../src/signal/analyzer.mjs');
const { GpsPipeline } = require('../src/gps/gps_pipeline.mjs');
const { RFFluidRenderer } = require('../src/render/rf_fluid_renderer.mjs');

const FLOORS_LINE = '# Band Floors (dBm): 815:-91.5,868:-91.5,915:-91.5';

// 815 MHz sits at -89.5 dBm (2 dB over the calibrated -91.5 floor, so
// noise) apart from one quiet -95 dip and one real -70 burst.
function csv(withFloors) {
  const rows = [];
  for (let i = 0; i < 40; i++) {
    const r815 = i === 5 ? -95 : i === 20 ? -70 : -89.5;
    rows.push(
      `${(i * 0.1).toFixed(2)},${(51.5 + i * 1e-3).toFixed(7)},-0.1,1.0,1.5,12,3,3.0,90,5000,1.0,${r815},-91.5,-91.5`,
    );
  }
  return [
    '# RecordingStartTime:1790349547',
    ...(withFloors ? [FLOORS_LINE] : []),
    'timestamp,lat,lon,hdop,pdop,sats,fix_type,speed_kts,course_deg,gsr_raw,hacc_m,rssi_815,rssi_868,rssi_915',
    ...rows,
  ].join('\n');
}

function drawPointsFor(text) {
  const a = new GSRAnalyzer();
  a.parseCSV(text);
  const filtered = a.raw.map((r) => ({ lat: r.lat, lon: r.lon }));
  return { a, points: GpsPipeline.buildDrawPoints(a.raw, filtered, 10, false) };
}

const mockMap = {
  getPanes: () => ({ overlayPane: { appendChild: () => {} } }),
  getSize: () => ({ x: 800, y: 600 }),
  on: () => {},
};
const lit815 = (renderer) =>
  renderer.cachedNodes.filter(
    (n) => renderer._normDbm(n.r815, 815, n.floors) > 0,
  ).length;

test('parsed rows and the map points built from them carry the floors', () => {
  const { a, points } = drawPointsFor(csv(true));
  assert.deepStrictEqual(a.raw[0].bandFloors, {
    815: -91.5,
    868: -91.5,
    915: -91.5,
  });
  assert.strictEqual(points[0].bandFloors, a.bandFloors);
});

test('2D overlay: readings within 3 dB of the calibrated floor are noise', () => {
  const withFloors = new RFFluidRenderer(mockMap);
  withFloors.setData(drawPointsFor(csv(true)).points, null);
  // Only the -70 burst clears -91.5 + 3 dB.
  assert.strictEqual(lit815(withFloors), 1);

  // No floors line: the -95 dip becomes the floor, so -89.5 lights up.
  const without = new RFFluidRenderer(mockMap);
  without.setData(drawPointsFor(csv(false)).points, null);
  assert.ok(lit815(without) > 30);
});

test('2D overlay, collective: each track is judged against its own floors', () => {
  const quietFloor = drawPointsFor(csv(true)).points;
  const lowFloor = drawPointsFor(
    csv(true).replace(
      FLOORS_LINE,
      '# Band Floors (dBm): 815:-100,868:-100,915:-100',
    ),
  ).points;
  const r = new RFFluidRenderer(mockMap);
  r.setDataForTracks([
    { id: 'a', drawPoints: quietFloor, osmGeoms: null },
    { id: 'b', drawPoints: lowFloor, osmGeoms: null },
  ]);
  const litIn = (floor) =>
    r.cachedNodes.filter(
      (n) => n.floors[815] === floor && r._normDbm(n.r815, 815, n.floors) > 0,
    ).length;
  assert.strictEqual(litIn(-91.5), 1, 'track a: only the burst');
  assert.ok(litIn(-100) > 30, 'track b: -89.5 is 10 dB over its floor');
});

test('3D expanse: a band that never clears its calibrated floor is squelched', () => {
  // Minimal Cesium stand-in (constructors, as buildPrimitive calls `new`).
  function Ctor(o) {
    Object.assign(this, o);
  }
  global.Cesium = {
    Cartesian3: Object.assign(function () {}, { fromDegrees: () => ({}) }),
    Color: function () {},
    ColorGeometryInstanceAttribute: { fromColor: (c) => c },
    EllipsoidGeometry: Ctor,
    GeometryInstance: Ctor,
    Primitive: Ctor,
    PerInstanceColorAppearance: Object.assign(function () {}, {
      VERTEX_FORMAT: {},
    }),
    Transforms: { eastNorthUpToFixedFrame: () => ({}) },
  };
  const { GSRGlobe3DRf } = require('../src/map/globe3d/rf_expanse.mjs');
  // 868 MHz wanders -93..-89.5: a 3.5 dB spread over its quietest reading
  // (active by that rule) but never 3 dB over the calibrated -91.5 floor.
  const build = (bandFloors) => {
    const raw = [];
    const pts = [];
    for (let i = 0; i < 60; i++) {
      raw.push({ rssi_868: i % 2 ? -89.5 : -93, bandFloors });
      pts.push({ lat: 51.5 + i * 1e-4, lon: -0.1, origIdx: i });
    }
    return GSRGlobe3DRf.buildPrimitive({ raw, bandFloors }, pts, {
      mode: '868',
    });
  };
  assert.strictEqual(build({ 815: -91.5, 868: -91.5, 915: -91.5 }), null);
  assert.ok(build(null), 'without floors the 3.5 dB wander still draws');
  delete global.Cesium;
});
