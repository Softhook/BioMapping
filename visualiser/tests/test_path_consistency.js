/**
 * The map's drawn line and analyzer.filteredGps (read by peaks, the scrub
 * dot and the analyses) must stay the same path, and single-view enrichment
 * / NDVI must build it with the walk's own GPS settings.
 *
 * Run: node --test tests/test_path_consistency.js
 */
const assert = require('node:assert');
const test = require('node:test');
const { bootApp } = require('./support/boot_app.js');
const { GpsPipeline } = require('../src/gps/gps_pipeline.mjs');

function csv() {
  const rows = ['timestamp,lat,lon,hdop,fix_type,speed_kts,course_deg,gsr_raw'];
  for (let i = 0; i < 300; i++) {
    const lon = -0.1278 + (i === 150 ? 0.0009 : 0); // one 60 m sideways jump
    rows.push(
      `${(i * 0.1).toFixed(1)},${(51.5074 + i * 0.00001).toFixed(6)},${lon.toFixed(6)},1.0,3,2.1,0,10000`,
    );
  }
  return rows.join('\n');
}

async function boot() {
  const { window } = await bootApp();
  window.HTMLCanvasElement.prototype.getContext = () => ({
    fillStyle: '',
    fillRect() {},
  });
  window.setup();
  return window;
}

test('the map restores its own path if an analysis rebuilt it with other settings', async () => {
  const window = await boot();
  const mm = window.AppState.mapManager;
  const a = new window.GSRAnalyzer();
  a.parseCSV(csv());
  const p = { maxHdop: 3, maxSpeed: 3 };

  const first = mm._getOrBuildDrawPoints('t', a, p).drawPoints;
  const drawn = first.map((d) => [d.lat, d.lon]);

  // Something else rebuilds the path with different settings...
  GpsPipeline.ensureFilteredGps(a, { maxHdop: 3, maxSpeed: 0.5 });
  // ...the next map call puts it back, so filteredGps matches the line.
  const again = mm._getOrBuildDrawPoints('t', a, p).drawPoints;
  assert.deepStrictEqual(
    again.map((d) => [d.lat, d.lon]),
    drawn,
  );
  for (const d of again) {
    assert.strictEqual(a.filteredGps[d.origIdx].lat, d.lat);
    assert.strictEqual(a.filteredGps[d.origIdx].lon, d.lon);
  }
});

test('single view: getSpatialTracks carries the walk’s GPS settings', async () => {
  const window = await boot();
  const a = new window.GSRAnalyzer();
  a.parseCSV(csv());
  const params = { maxHdop: 2, maxSpeed: 1.5 };
  const S = window.AppState;
  S.viewMode = 'single';
  S.analyzer = a;
  S.activeTrackId = 'trk1';
  S.collectiveManager.getTrack = (id) =>
    id === 'trk1'
      ? { id, name: 'Walk', analyzer: a, gpsFilterParams: params }
      : null;
  const { validTracks } = window.GSRUI.getSpatialTracks({ silent: true });
  assert.strictEqual(validTracks.length, 1);
  assert.strictEqual(validTracks[0].gpsFilterParams, params);
});
