/**
 * OSM enrichment reads the smoothed GPS path, which the Max HDOP and Max
 * Speed sliders shape — so letting go of either re-runs enrichment (from the
 * already-loaded OSM data), with the new value saved first.
 *
 * Run: node --test tests/test_gps_slider_reenrich.js
 */
const assert = require('node:assert');
const test = require('node:test');
const { bootApp } = require('./support/boot_app.js');

async function boot() {
  const { window } = await bootApp();
  window.HTMLCanvasElement.prototype.getContext = () => ({
    fillStyle: '',
    fillRect() {},
  });
  window.setup();
  const calls = [];
  // The objects the handler reaches as Controllers.ui / .trackManager.
  const C = { ui: window.GSRUI, trackManager: window.GSRTrackManager };
  C.ui.enrichTrack = (force) => calls.push(`enrich:${force}`);
  C.trackManager.saveActiveGpsParams = () => calls.push('save');
  return { window, C, calls };
}

for (const id of ['gpsMaxSpeed', 'gpsMaxHdop']) {
  test(`${id}: releasing the slider saves the value, then re-enriches from loaded OSM data`, async () => {
    const { window, C, calls } = await boot();
    C.ui.hasOsmData = () => true;
    window.document
      .getElementById(id)
      .dispatchEvent(new window.Event('change'));
    assert.deepStrictEqual(calls, ['save', 'enrich:false']);
  });
}

test('no OSM data loaded: releasing the slider does not enrich', async () => {
  const { window, C, calls } = await boot();
  C.ui.hasOsmData = () => false;
  window.document
    .getElementById('gpsMaxSpeed')
    .dispatchEvent(new window.Event('change'));
  assert.deepStrictEqual(calls, []);
});

test('display-only GPS sliders (track weight) never re-enrich', async () => {
  const { window, C, calls } = await boot();
  C.ui.hasOsmData = () => true;
  window.document
    .getElementById('gpsTrackWeight')
    .dispatchEvent(new window.Event('change'));
  assert.deepStrictEqual(calls, []);
});
