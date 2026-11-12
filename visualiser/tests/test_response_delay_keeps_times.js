/**
 * The Response delay changes where body data is shown, never when anything
 * happened: moving the slider must leave every stored time alone (rows,
 * filtered signals, the smoothed path, peaks, hotspots), keep the exported
 * rows the same, and an exported walk must load back with its own times.
 *
 * Moves the delay through many settings on the fixture walk and, at each,
 * does everything that reads the delay: re-analysis, single and Collective
 * map redraws (track line, peaks, connectors, hotspots, Arousal Places) and
 * every pairing lookup.
 *
 * Run: node --test tests/test_response_delay_keeps_times.js
 */

const assert = require('node:assert');
const test = require('node:test');
const {
  bootWithFixture,
  showSingle,
} = require('./support/map_render_record.js');
const { ResponseDelay } = require('../src/signal/response_delay.mjs');

const SERIES = [
  'raw',
  'filtered',
  'tonic',
  'phasic',
  'filteredGps',
  'peakDensity',
  'phasicAUC',
  'arousalIndex',
  'triIndex',
];

/** Every stored time on a walk, as one comparable value. */
function timesOf(a) {
  const out = { recordingStartTime: a.recordingStartTime };
  for (const k of SERIES) {
    if (Array.isArray(a[k])) out[k] = a[k].map((r) => r?.time);
  }
  out.peaks = a.peaks.map((p) => [p.index, p.time, p.onsetTime, p.offsetTime]);
  out.hotspots = (a.memorableEvents || []).map((p) => [p.index, p.time]);
  return out;
}

/** The export without its Response delay note (which should differ). */
const exportRows = (a, GSR_CONST) =>
  a
    .exportToCSV(GSR_CONST.GSR_DEFAULT, GSR_CONST.GPS_DEFAULT)
    .split('\n')
    .filter((l) => !l.startsWith('# ResponseDelay:'));

test('moving the Response delay never changes a stored time', async () => {
  const { window, mapManager, GSR_CONST, analyzer, track } =
    await bootWithFixture();
  const AS = window.AppState;
  const gps = structuredClone(GSR_CONST.GPS_DEFAULT);

  AS.setResponseDelay(0);
  analyzer.analyze(track.filterParams, 0);
  const before = timesOf(analyzer);
  const exportAt0 = exportRows(analyzer, GSR_CONST);
  assert.ok(before.raw.length > 1000 && before.peaks.length > 50);

  for (const delay of [0.1, 1, 2, 3.7, 5, 8, 2]) {
    AS.setResponseDelay(delay);
    assert.strictEqual(analyzer.responseDelay, delay);
    analyzer.analyze(track.filterParams, 0);

    showSingle(window, analyzer, track);
    for (const metric of ['gsr', 'phasic', 'tonic']) {
      mapManager.activeColoringMetric = metric;
      mapManager._arousalLastRenderTs = 0;
      mapManager.renderData(analyzer, gps);
    }
    mapManager.refreshPeakMarkers(analyzer, gps, {});
    AS.viewMode = 'collective';
    mapManager._arousalLastRenderTs = 0;
    mapManager.renderCollectiveData(AS.collectiveManager, {});

    const readingAt = ResponseDelay.readingLookup(analyzer);
    const placeRowOf = ResponseDelay.placeRowLookup(analyzer);
    for (let i = 0; i < analyzer.raw.length; i++) {
      analyzer.placeOf(i);
      analyzer.placeRowOf(i);
      analyzer.readingAt(i);
      readingAt(i);
      placeRowOf(i);
    }
    ResponseDelay.byPlace(analyzer, analyzer.phasic);

    assert.deepStrictEqual(timesOf(analyzer), before, `at ${delay} s`);
    assert.deepStrictEqual(
      exportRows(analyzer, GSR_CONST),
      exportAt0,
      `export rows at ${delay} s`,
    );
  }

  // The export notes the delay, and loads back with the walk's own times.
  const csv = analyzer.exportToCSV(GSR_CONST.GSR_DEFAULT, gps);
  assert.ok(csv.includes('# ResponseDelay:2'));
  const reloaded = new window.GSRAnalyzer();
  reloaded.parseCSV(csv);
  assert.strictEqual(reloaded.raw.length, analyzer.raw.length);
  reloaded.raw.forEach((r, i) => {
    assert.ok(
      Math.abs(r.time - analyzer.raw[i].time) < 1e-6,
      `reloaded row ${i}: ${r.time} vs ${analyzer.raw[i].time}`,
    );
  });
});
