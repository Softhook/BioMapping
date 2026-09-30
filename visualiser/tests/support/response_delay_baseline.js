/**
 * What the app produces for one walk at a response delay of 0 s: the record
 * behind "at 0 s everything is exactly where it is today"
 * (docs/time_offsets_review.md, Solution design, step 1).
 *
 * Each part is reduced to a count and a hash of its values (rounded to 9
 * significant figures, so harmless float noise doesn't count as a change).
 * Hotspots are left out on purpose: the build is allowed to change them
 * (findings 1 and 2, and the "placed at every setting" rule).
 *
 * Used by test_response_delay_zero_baseline.js (the fixture walk) and by
 * tests/manual/response_delay/baseline.js (every walk in tracks/).
 */

const crypto = require('node:crypto');

const round = (v) =>
  typeof v === 'number' && Number.isFinite(v) ? Number(v.toPrecision(9)) : v;
const deepRound = (x) =>
  Array.isArray(x)
    ? x.map(deepRound)
    : x && typeof x === 'object'
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, deepRound(x[k])]),
        )
      : round(x);

function part(values) {
  const json = JSON.stringify(deepRound(values));
  return {
    count: Array.isArray(values) ? values.length : 1,
    hash: crypto.createHash('sha256').update(json).digest('hex').slice(0, 16),
  };
}

const TOPO_SOURCES = [
  'phasic',
  'tonic',
  'gsr',
  'auc',
  'peak_density',
  'arousal_index',
  'tri_index',
  'peaks',
];
const PATH_METRICS = [
  'gsr',
  'phasic',
  'tonic',
  'phasicAUC',
  'peakDensity',
  'arousalIndex',
  'triIndex',
  'hdopQuality',
];

/**
 * @param {object} a - an analysed GSRAnalyzer with its smoothed path built
 * @param {object} deps - { GSRCollectiveManager, GSRMapPath, GpsPipeline, superMock }
 */
function walkRecord(a, deps) {
  const { GSRCollectiveManager, GSRMapPath, GpsPipeline, superMock } = deps;
  a.setResponseDelay?.(0);
  const rec = {};

  rec.peaks = part(a.peaks.map((p) => [p.index, p.amplitude, !!p.excluded]));
  rec.peakPlaces = part(
    a.peaks.map((p) => {
      const c = a.placeOf ? a.placeOf(p.index) : a.getCoordinates(p.index);
      return c ? [c.lat, c.lon] : null;
    }),
  );

  for (const src of TOPO_SOURCES) {
    const cm = new GSRCollectiveManager();
    cm.addTrack({
      id: 'w',
      enabled: true,
      analyzer: a,
      gpsFilterParams: { peakLatency: 0 },
    });
    const params = cm._resolveContourParams({
      topographySource: src,
      normalizeZScore: true,
    });
    const { points, peaks } = cm._collectContourPoints(
      cm.getActiveTracks(),
      params,
    );
    rec[`groupMap_${src}`] = part({
      points: points.map((p) => [p.lat, p.lon, p.val]),
      peaks: peaks.map((p) => [p.lat, p.lon, p.amplitude]),
    });
  }

  const drawPoints = GpsPipeline.buildDrawPoints(
    a.raw,
    a.filteredGps,
    a.sampleRate || 10,
    false,
    new Set(),
  );
  const mm = Object.create(GSRMapPath.prototype);
  mm.map = null;
  const savedL = global.L;
  global.L = superMock();
  try {
    for (const metric of PATH_METRICS) {
      mm.activeColoringMetric = metric;
      try {
        mm._renderPathSegments(drawPoints, 5, a, null);
      } catch {
        // Drawing needs a real map; the value lookup is kept before that.
      }
      rec[`pathColour_${metric}`] = part(
        drawPoints.map((dp) => {
          const v = mm._lastPathGetVal(dp);
          return v == null || Number.isNaN(v) ? null : v;
        }),
      );
    }
  } finally {
    global.L = savedL;
  }
  return rec;
}

/** Dashboard numbers for a set of enriched walks at 0 s. */
function dashboardRecord(tracks, EnvironmentalStats) {
  for (const t of tracks) t.analyzer.setResponseDelay?.(0);
  const stats = EnvironmentalStats.compute(tracks, () => 0);
  return {
    samples: part(
      stats.allData.map((d) => [
        d.trackId,
        d.time,
        d.val,
        d.phasic,
        d.tonic,
        d.speed,
        d.osm_road_class ?? null,
        d.osm_dist_major_road,
        d.tonicEnv?.osm_dist_major_road,
      ]),
    ),
    correlations: part(
      stats.correlationMatrix.map((r) => [r.key, r.rPhasic, r.rTonic]),
    ),
    roads: part(
      stats.roadProfile.map((r) => [r.roadClass ?? r.name ?? r.key, r]),
    ),
  };
}

/** The exported CSV at 0 s, minus the settings lines the build changes. */
function exportRecord(a, GSR_CONST) {
  a.setResponseDelay?.(0);
  const csv = a
    .exportToCSV(GSR_CONST.GSR_DEFAULT, GSR_CONST.GPS_DEFAULT)
    .split('\n')
    .filter(
      (l) =>
        !l.startsWith('# GpsFilterParams:') &&
        !l.startsWith('# ResponseDelay:'),
    );
  return part(csv);
}

/**
 * The full record for the repo's fixture walk (fixtures/default_processed.csv):
 * the walk itself, plus the dashboard on three copies of it with made-up
 * surroundings (the same copies test_environmental_stats.js uses).
 */
function fixtureRecord() {
  const fs = require('node:fs');
  const path = require('node:path');
  global.window = global;
  const { GSR_CONST } = require('../../src/core/constants.mjs');
  global.GSR_CONST = GSR_CONST;
  const { GSRAnalyzer } = require('../../src/signal/analyzer.mjs');
  const { GpsPipeline } = require('../../src/gps/gps_pipeline.mjs');
  const {
    GSRCollectiveManager,
  } = require('../../src/spatial/collective_manager.mjs');
  const {
    EnvironmentalStats,
  } = require('../../src/spatial/environmental_stats.mjs');
  const { GSRMapPath } = require('../../src/map/manager/path.mjs');
  const { superMock } = require('./realm_bridge.js');

  const csv = fs.readFileSync(
    path.join(__dirname, '../../fixtures/default_processed.csv'),
    'utf8',
  );
  const a = new GSRAnalyzer();
  a.parseCSV(csv);
  a.setResponseDelay?.(0);
  GpsPipeline.ensureFilteredGps(a, GSR_CONST.GPS_DEFAULT);
  a.analyze(GSR_CONST.GSR_DEFAULT, 0);

  const rec = walkRecord(a, {
    GSRCollectiveManager,
    GSRMapPath,
    GpsPipeline,
    superMock,
  });
  rec.export = exportRecord(a, GSR_CONST);

  const copy = (id, seed) => {
    const w = Object.create(a);
    w.raw = a.raw.map((pt, i) => ({
      ...pt,
      osm_road_class: ['residential', 'path', 'primary'][(i + seed) % 3],
      osm_dist_major_road: 20 + ((i * (seed + 1)) % 53),
      osm_in_park: (i + seed) % 7 === 0,
      osm_green_pct_50m: ((i + seed * 13) % 100) / 100,
    }));
    w.isEnriched = true;
    return { id, analyzer: w };
  };
  const dash = dashboardRecord(
    [copy('w0', 0), copy('w1', 1), copy('w2', 2)],
    EnvironmentalStats,
  );
  for (const [k, v] of Object.entries(dash)) rec[`dashboard_${k}`] = v;
  return rec;
}

module.exports = {
  walkRecord,
  dashboardRecord,
  exportRecord,
  fixtureRecord,
  part,
};
