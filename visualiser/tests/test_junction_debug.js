/**
 * Junction debug overlay: which walks it draws in Collective view, and that
 * OSM tag text in its popups is escaped.
 *
 * Run: node --test tests/test_junction_debug.js
 */
const assert = require('node:assert');
const test = require('node:test');

const { AppState } = require('../src/core/app_state.mjs');
const { OSMEnricher } = require('../src/osm/osm_enrichment.mjs');
const { JunctionDebug } = require('../src/map/junction_debug.mjs');

// Minimal Leaflet stand-in that records popup HTML.
const popups = [];
const layer = () => {
  const l = {
    addTo: () => l,
    bindPopup: (html) => {
      popups.push(html);
      return l;
    },
  };
  return l;
};
global.L = {
  layerGroup: layer,
  polyline: layer,
  circleMarker: layer,
  control: () => ({ addTo() {}, remove() {} }),
  DomUtil: { create: () => ({ style: {} }) },
};

const passage = {
  key: 'n1',
  lat: 51.5,
  lon: -0.1,
  i: 0,
  time: 0,
  decision: 'turn',
  kind: 'change',
  degree: 3,
  turnAngleDeg: 90,
  rawTurnAngleDeg: 88,
  inClass: 'footway|<img src=x onerror=alert(1)>|',
  outClass: 'residential||yes',
};

function setup(tracks) {
  popups.length = 0;
  const seen = [];
  OSMEnricher.junctionPassages = (a) => {
    seen.push(a.name);
    return {
      pts: [{ lat: 51.5, lon: -0.1 }],
      passages: [passage],
      nodes: new Map(),
    };
  };
  AppState.viewMode = 'collective';
  AppState.mapManager = { map: { removeLayer() {} } };
  AppState.collectiveManager = {
    tracks,
    getActiveTracks: () => tracks.filter((t) => t.enabled),
  };
  return seen;
}

const track = (name, enabled) => ({
  id: name,
  enabled,
  analyzer: { name, isEnriched: true, osmGeoms: { ways: [] } },
});

test('Collective view: only enabled walks get junction rings', () => {
  const seen = setup([track('on', true), track('off', false)]);
  JunctionDebug.toggle(true);
  JunctionDebug.toggle(false);
  assert.deepStrictEqual(seen, ['on']);
});

test('popup escapes OSM road-character tag text', () => {
  setup([track('on', true)]);
  JunctionDebug.toggle(true);
  JunctionDebug.toggle(false);
  assert.strictEqual(popups.length, 1);
  assert.ok(!popups[0].includes('<img'), popups[0]);
  assert.ok(popups[0].includes('&lt;img'), popups[0]);
});
