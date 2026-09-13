/**
 * Live view follow-map peak / hotspot markers.
 *
 * The live map draws stress-peak dots and memorable-event hotspot stars with
 * the SAME shared icons the main visualiser's 2D map uses
 * (GSRMapMarkers in src/map/map_markers.js), reconciled incrementally as the
 * live analyser's trailing window slides. These tests pin that contract:
 *
 *   1. peaks -> small peak-dot markers, hotspots -> hotspot-star markers,
 *      both actually on the Leaflet map;
 *   2. re-rendering is idempotent (no duplicate markers, no flicker);
 *   3. the showPeaks / showHotspots toggles add/remove their own layer only;
 *   4. resetSession clears every marker.
 *
 * Uses tests/support/boot_live.js's Leaflet mock (extended with L.marker /
 * L.divIcon so the real GSRMapMarkers icon builders run against it).
 */

const test = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const { bootLive } = require('./support/boot_live.js');

const run = (context, expr) => vm.runInContext(expr, context);

// A flat baseline then one sharp SCR (rise at ~t6s, slow decay) — one
// detected peak, and HOTSPOT_PERCENTILE's "at least 1" makes it memorable.
function feedScr(context) {
  run(context, `
    for (let i = 0; i < 140; i++) {
      const t = i * 0.3;
      let us = 5;
      const d = t - 6;
      if (d > 0) us += 1.2 * Math.exp(-d / 4) * (1 - Math.exp(-d / 0.6));
      LiveState.addPacket({ valid: true, lat: 51.5 + i * 1e-5, lon: -0.12 + i * 1e-5,
        gsrRaw: us * 1000, hdop: 1, pdop: 1, speedKts: 1, courseDeg: 90, sats: 9, fixType: 3, timestamp: t });
    }
  `);
}

test('the live map draws peak dots and hotspot stars from the shared GSRMapMarkers icons', () => {
  const { context } = bootLive();
  run(context, 'showMap()');
  feedScr(context);

  assert.ok(run(context, 'liveAnalyzer.peaks.length') > 0, 'the SCR produced a peak');
  assert.ok(run(context, 'liveAnalyzer.memorableEvents.length') > 0, 'the SCR was curated as a hotspot');
  assert.ok(run(context, 'liveMapPeakMarkers.size') > 0, 'peak markers rendered');
  assert.ok(run(context, 'liveMapHotspotMarkers.size') > 0, 'hotspot markers rendered');

  const peakIcon = run(context, 'liveMapPeakMarkers.values().next().value.options.icon.options.html');
  assert.match(peakIcon, /peak-dot/, 'peak markers use the shared peak-dot icon');
  const hotspotIcon = run(context, 'liveMapHotspotMarkers.values().next().value.options.icon.options.html');
  assert.match(hotspotIcon, /hotspot-star/, 'hotspot markers use the shared hotspot-star icon');

  // Every marker is actually on the Leaflet map.
  const onMap = run(context, `liveMap._layers.filter(l => l.options && l.options.icon).length`);
  assert.strictEqual(onMap, run(context, 'liveMapPeakMarkers.size + liveMapHotspotMarkers.size'),
    'each rendered marker is a layer on the map');
});

test('live map markers are reconciled incrementally — repeated renders add no duplicates', () => {
  const { context } = bootLive();
  run(context, 'showMap()');
  feedScr(context);

  const before = run(context, 'liveMapPeakMarkers.size + liveMapHotspotMarkers.size');
  assert.ok(before > 0);
  run(context, 'renderLiveMapMarkers(); renderLiveMapMarkers(); renderLiveMapMarkers();');
  assert.strictEqual(run(context, 'liveMapPeakMarkers.size + liveMapHotspotMarkers.size'), before,
    'no duplicate markers across renders');
});

test('toggling showPeaks off removes only the peak markers; hotspots stay', () => {
  const { context } = bootLive();
  run(context, 'showMap()');
  feedScr(context);
  assert.ok(run(context, 'liveMapPeakMarkers.size') > 0);

  run(context, 'liveGsrView.showPeaks = false; renderLiveMapMarkers();');
  assert.strictEqual(run(context, 'liveMapPeakMarkers.size'), 0, 'peak markers removed');
  assert.ok(run(context, 'liveMapHotspotMarkers.size') > 0, 'hotspot markers stay');

  run(context, 'liveGsrView.showHotspots = false; renderLiveMapMarkers();');
  assert.strictEqual(run(context, 'liveMapHotspotMarkers.size'), 0, 'hotspot markers removed too');
});

test('resetSession clears every live map marker', () => {
  const { context } = bootLive();
  run(context, 'showMap()');
  feedScr(context);
  assert.ok(run(context, 'liveMapPeakMarkers.size + liveMapHotspotMarkers.size') > 0);

  run(context, 'resetSession()');
  assert.strictEqual(run(context, 'liveMapPeakMarkers.size'), 0);
  assert.strictEqual(run(context, 'liveMapHotspotMarkers.size'), 0);
});
