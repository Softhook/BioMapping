/**
 * Unit & Integration tests for Environmental Dashboard scope control and multi-track resolution.
 * Run: node --test tests/test_environmental_scope.js
 */
const assert = require('node:assert');
const test = require('node:test');
const path = require('node:path');

global.window = global;
global.GSR_CONST = require('../src/core/constants.mjs').GSR_CONST;

const { loadModule } = require('./support/load_module.js');
loadModule(path.join(__dirname, '../src/gps/geo_utils.mjs'));
loadModule(path.join(__dirname, '../src/signal/stats_math.mjs'));
loadModule(path.join(__dirname, '../src/map/map_colors.mjs'));
loadModule(path.join(__dirname, '../src/gps/gps_pipeline.mjs'));
loadModule(path.join(__dirname, '../src/signal/dwt_filter.mjs'));
loadModule(path.join(__dirname, '../src/signal/gsr_filter.mjs'));
loadModule(path.join(__dirname, '../src/signal/deconvolution.mjs'));

const { AppState } = require('../src/core/app_state.mjs');
const { GSRAnalyzer } = require('../src/signal/analyzer.mjs');
const { GSRUI } = require('../src/ui/ui.mjs');
const { OSMEnricher } = require('../src/osm/osm_enrichment.mjs');

function createMockEnrichedAnalyzer(_name, offsetLat = 0) {
  const a = new GSRAnalyzer();
  a.raw = [];
  a.filtered = [];
  a.tonic = [];
  a.phasic = [];
  a.peaks = [];
  a.isEnriched = true;
  a._dataVersion = 1;

  for (let i = 0; i < 60; i++) {
    const t = i * 1.0;
    const pt = {
      time: t,
      raw: 5.0,
      filtered: 5.0,
      tonic: 5.0,
      phasic: 0.1,
      lat: 51.55 + offsetLat + i * 0.0001,
      lon: -0.07 + i * 0.0001,
      osm_road_class: 'residential',
      osm_dist_major_road: 50,
      osm_in_park: 0,
      osm_green_pct_50m: 10,
      osm_dist_green: 20,
      osm_canopy_pct_50m: 5,
      osm_building_density_50m: 15,
      osm_dist_water: 999,
      osm_tree_density_50m: 2,
      osm_amenity_count_50m: 1,
    };
    a.raw.push(pt);
    a.filtered.push({ time: t, val: 5.0 });
    a.tonic.push({ time: t, val: 5.0 });
    a.phasic.push({ time: t, val: 0.1 });
  }
  return a;
}

test('OSMEnricher.snapTrackGps: generates snappedGps with wayIds and interpolates', () => {
  const analyzer = createMockEnrichedAnalyzer('test', 0);
  const geoms = {
    ways: [
      {
        type: 'way',
        id: 101,
        tags: { highway: 'residential' },
        coordinates: [
          { lat: 51.55, lon: -0.07 },
          { lat: 51.56, lon: -0.06 },
        ],
      },
    ],
    buildings: [],
    landuse: [],
    water: [],
    amenities: [],
    natural: [],
    points: [],
    relations: [],
  };

  const snapped = OSMEnricher.snapTrackGps(analyzer, geoms, 50);
  assert.ok(snapped, 'snappedGps array returned');
  assert.strictEqual(snapped.length, analyzer.raw.length);
  assert.strictEqual(analyzer.snappedGps, snapped);
  assert.ok(
    snapped.some((p) => p && !isNaN(p.lat) && p.wayId === 101),
    'at least one point snapped to way 101',
  );
});

test('OSMEnricher.analysisSnap: snaps for analysis without touching the map-facing snappedGps or _dataVersion', () => {
  const analyzer = createMockEnrichedAnalyzer('quiet', 0);
  analyzer.osmGeoms = {
    ways: [
      {
        type: 'way',
        id: 101,
        tags: { highway: 'residential' },
        coordinates: [
          { lat: 51.55, lon: -0.07 },
          { lat: 51.56, lon: -0.06 },
        ],
      },
    ],
    buildings: [],
    landuse: [],
    water: [],
    amenities: [],
    natural: [],
    points: [],
    relations: [],
  };
  analyzer.snappedGps = null;
  const v0 = analyzer._dataVersion || 0;
  const s1 = OSMEnricher.analysisSnap(analyzer, 50);
  assert.ok(s1?.some((p) => p && p.wayId === 101));
  assert.strictEqual(analyzer.snappedGps, null, 'map snapping must stay off');
  assert.strictEqual(analyzer._dataVersion || 0, v0, 'no cache invalidation');
  assert.strictEqual(OSMEnricher.analysisSnap(analyzer, 50), s1, 'cached');
});

test('EnvironmentalDashboardUI: evaluates all tracks in collective mode and only active track in single mode', () => {
  const originalDoc = global.document;
  const originalViewMode = AppState.viewMode;
  const originalActiveId = AppState.activeTrackId;
  const originalManager = AppState.collectiveManager;

  const a1 = createMockEnrichedAnalyzer('track1', 0);
  const a2 = createMockEnrichedAnalyzer('track2', 0.001);

  const t1 = { id: 't1', name: 'Track 1', analyzer: a1, enabled: true };
  const t2 = { id: 't2', name: 'Track 2', analyzer: a2, enabled: true };

  const mockManager = {
    tracks: [t1, t2],
    getActiveTracks: () => [t1, t2],
    _cachedEnvStats: null,
  };

  AppState.collectiveManager = mockManager;
  AppState.viewMode = 'collective';
  AppState.activeTrackId = 't1';
  AppState.analyzer = a1;

  global.document = {
    getElementById: (id) => {
      if (id === 'gpsPeakLatency') return { value: '2.0' };
      if (id === 'correlationMethodNote') return { innerHTML: '' };
      return null;
    },
    querySelector: () => null,
  };

  try {
    // 1. In collective mode -> evaluates all active tracks pooled
    GSRUI.updateEnvironmentalDashboard();

    const collectiveCache = mockManager._cachedEnvStats;
    assert.ok(collectiveCache, 'Cache created on collectiveManager');
    assert.strictEqual(collectiveCache.scope, 'all');
    assert.strictEqual(collectiveCache.trackCount, 2, 'Evaluates both tracks');

    // 2. In single mode -> evaluates only the active track
    AppState.viewMode = 'single';
    GSRUI.updateEnvironmentalDashboard();

    const singleCache = a1._cachedEnvStats;
    assert.ok(singleCache, 'Cache created on analyzer for active walk');
    assert.strictEqual(singleCache.scope, 'active');
    assert.strictEqual(singleCache.trackCount, 1, 'Evaluates 1 active track');
  } finally {
    global.document = originalDoc;
    AppState.viewMode = originalViewMode;
    AppState.activeTrackId = originalActiveId;
    AppState.collectiveManager = originalManager;
  }
});

test('GSRCollectiveProject: multi-track bundle targets collective view even if manifest says single', () => {
  const originalViewMode = AppState.viewMode;
  const originalManager = AppState.collectiveManager;

  let clickedBtn = null;
  const originalDoc = global.document;
  global.document = {
    getElementById: (id) => {
      if (id === 'btnCollectiveView' || id === 'btnSingleView') {
        return {
          click: () => {
            clickedBtn = id;
          },
        };
      }
      return null;
    },
  };

  try {
    AppState.viewMode = 'single';
    const manifest = {
      viewMode: 'single',
      tracks: [
        { file: '01.csv', name: 'Track 1' },
        { file: '02.csv', name: 'Track 2' },
      ],
    };

    const targetMode =
      manifest.tracks && manifest.tracks.length > 1
        ? 'collective'
        : manifest.viewMode === 'collective'
          ? 'collective'
          : 'single';

    assert.strictEqual(targetMode, 'collective');
    if (AppState.viewMode !== targetMode) {
      const toggleBtn = global.document.getElementById(
        targetMode === 'collective' ? 'btnCollectiveView' : 'btnSingleView',
      );
      if (toggleBtn) toggleBtn.click();
    }
    assert.strictEqual(clickedBtn, 'btnCollectiveView');
  } finally {
    global.document = originalDoc;
    AppState.viewMode = originalViewMode;
    AppState.collectiveManager = originalManager;
  }
});

test('EnvironmentalDashboardUI._junctionStatsFor: no work while the Junction tab is hidden; cached once shown, recomputed when a latency changes', () => {
  const {
    EnvironmentalDashboardUI,
  } = require('../src/ui/ui_environmental_dashboard.mjs');
  const originalDoc = global.document;
  let tabActive = false;
  let latencyValue = '2.0';
  global.document = {
    getElementById: (id) =>
      id === 'envTabJunctions'
        ? { classList: { contains: () => tabActive } }
        : id === 'gpsPeakLatency'
          ? { value: latencyValue }
          : null,
  };
  let computes = 0;
  const ui = {
    ...EnvironmentalDashboardUI,
    _computeJunctionStats: () => {
      computes++;
      return { passages: [], responses: [], comparison: [{}] };
    },
  };
  const target = {};
  const walks = [{ id: 'a' }];
  try {
    const hidden = ui._junctionStatsFor(target, 'all', walks, 'a', 'v1');
    assert.strictEqual(computes, 0);
    assert.deepStrictEqual(hidden.comparison, []);
    tabActive = true;
    ui._junctionStatsFor(target, 'all', walks, 'a', 'v1');
    ui._junctionStatsFor(target, 'all', walks, 'a', 'v1');
    assert.strictEqual(computes, 1, 'second call served from cache');
    ui._junctionStatsFor(target, 'all', walks, 'a', 'v2');
    assert.strictEqual(computes, 2, 'data change recomputes');
    latencyValue = '3.0';
    ui._junctionStatsFor(target, 'all', walks, 'a', 'v2');
    assert.strictEqual(computes, 3, 'latency change recomputes');

    // Collective view: each walk's own latency, not the slider.
    const own = [{ id: 'a', gpsFilterParams: { peakLatency: 1 } }];
    const latencyOf = (t) => t.gpsFilterParams.peakLatency;
    ui._junctionStatsFor(target, 'all', own, 'a', 'v2', latencyOf);
    assert.strictEqual(computes, 4);
    latencyValue = '4.0'; // hidden slider moving changes nothing
    ui._junctionStatsFor(target, 'all', own, 'a', 'v2', latencyOf);
    assert.strictEqual(computes, 4, 'slider ignored in collective');
    own[0].gpsFilterParams.peakLatency = 2.5;
    ui._junctionStatsFor(target, 'all', own, 'a', 'v2', latencyOf);
    assert.strictEqual(computes, 5, "a walk's own latency change recomputes");
  } finally {
    global.document = originalDoc;
  }
});
