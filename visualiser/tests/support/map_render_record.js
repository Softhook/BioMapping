/**
 * What the map draws for the fixture walk (fixtures/default_processed.csv):
 * every track-line piece (its points, colour and width), every peak dot,
 * connector and hotspot, the legend range, the overlap-colour outcome, and
 * the Collective view's Arousal Places — at several Response delays, line
 * widths and colour metrics.
 *
 * Each part is reduced to a count and a hash (see response_delay_baseline.js
 * `part`), so the saved record stays small. The app is booted with the
 * bench's recording Leaflet (tests/manual/bench/harness.js): layers are
 * recorded, not drawn, which is all a "did the output change?" check needs.
 *
 * Used by test_map_render_baseline.js and gen_map_render_baseline.js.
 */

const fs = require('node:fs');
const path = require('node:path');
const { part } = require('./response_delay_baseline.js');
const harness = require('../manual/bench/harness.js');

const FIXTURE = path.join(__dirname, '../../fixtures/default_processed.csv');

const DELAYS = [0, 2, 5.3];
const WEIGHTS = [5, 40]; // 40 widens the overlap radius, so more is pooled
const METRICS = [
  'gsr',
  'phasic',
  'tonic',
  'arousalIndex',
  'hdopQuality',
  'responseDynamics',
  'roadClass',
];

/** Boot the app and load the fixture walk as its one track. */
async function bootWithFixture() {
  const ctx = await harness.boot();
  const { window } = ctx;
  const analyzer = new window.GSRAnalyzer();
  analyzer.parseCSV(fs.readFileSync(FIXTURE, 'utf8'));
  const track = window.GSRTrackManager.createTrackObject(
    'fixture',
    'default_processed.csv',
    '#ff5533',
    analyzer,
  );
  analyzer.analyze(track.filterParams, 0);
  window.AppState.collectiveManager.addTrack(track);
  return { ...ctx, analyzer, track };
}

/** Show the fixture walk on its own (single view). */
function showSingle(window, analyzer, track) {
  Object.assign(window.AppState, {
    viewMode: 'single',
    activeTrackId: track.id,
    currentTrack: track,
    analyzer,
  });
}

// A recorded layer, as data.
const layer = (l) => [l._gsrKind, l._latlngs, l._options, l._latlng];

async function mapRenderRecord() {
  const { window, mapManager, GSR_CONST, analyzer, track } =
    await bootWithFixture();
  const AS = window.AppState;
  const rec = {};

  for (const delay of DELAYS) {
    AS.setResponseDelay(delay);
    analyzer.setResponseDelay(delay);
    showSingle(window, analyzer, track);
    for (const weight of WEIGHTS) {
      const gps = {
        ...structuredClone(GSR_CONST.GPS_DEFAULT),
        trackWeight: weight,
      };
      for (const metric of METRICS) {
        mapManager.activeColoringMetric = metric;
        // A redraw straight after another counts as a slider drag, which
        // reuses the last Arousal Places; every redraw here is a settled one.
        mapManager._arousalLastRenderTs = 0;
        mapManager.renderData(analyzer, gps);
        const drawn = mapManager.getRenderLayers();
        rec[`line_${delay}s_w${weight}_${metric}`] = part({
          pieces: drawn.paths.map(layer),
          legend: [
            mapManager._legendMinVal,
            mapManager._legendMaxVal,
            [...(mapManager._legendUniqueVals || [])].sort(),
          ],
          overlap: [mapManager._lastPathOverlapSig, mapManager._pathHasRetrace],
        });
        if (weight === WEIGHTS[0] && metric === METRICS[0]) {
          rec[`peaks_${delay}s`] = part(drawn.peakMarkers.map(layer));
          rec[`hotspots_${delay}s`] = part(drawn.hotspots.map(layer));
          rec[`places_${delay}s`] = part(
            (mapManager.clusterLayers || []).map(layer),
          );
        }
      }
    }

    AS.viewMode = 'collective';
    mapManager._arousalLastRenderTs = 0;
    mapManager.renderCollectiveData(AS.collectiveManager, {});
    const drawn = mapManager.getRenderLayers();
    rec[`collective_${delay}s`] = part({
      layers: [...drawn.paths, ...drawn.peakMarkers, ...drawn.hotspots].map(
        layer,
      ),
      places: (mapManager.clusterLayers || []).map(layer),
    });
  }
  return rec;
}

module.exports = { mapRenderRecord, bootWithFixture, showSingle, FIXTURE };
