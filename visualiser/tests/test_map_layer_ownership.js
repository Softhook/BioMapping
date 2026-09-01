/**
 * Phase 1 (slice 1) behavior tests: the track.layerGroup ownership model.
 *
 * Contract under test (docs/archive/visualizer_architecture_refactor_plan.md, Phase 1):
 *   - Each track owns a single Leaflet layerGroup() — its rendering handle.
 *   - The single-track render path adds path/peak/hotspot layers INTO the
 *     active track's layerGroup, never directly onto the map.
 *   - Removing a track (deleteTrack) / wiping the map (clearMap) = removing
 *     its layerGroup from the map: one call, nothing left behind.
 *   - Peak/hotspot visibility toggles operate on the track's layerGroup.
 *
 * Why these tests matter: the existing smoke tests boot the real app against a
 * universal superMock() Leaflet that swallows every add/remove/hasLayer call,
 * so they can only assert "doesn't throw" — NOT "the right layers are on the
 * map". These tests boot the REAL app with a *recording* Leaflet mock that
 * faithfully tracks which layers were added directly to the map vs. into a
 * layerGroup, and what happens to them on toggle/clear/delete. They are
 * written against the NEW contract, so they FAIL on the pre-slice-1 code
 * (where tracks have no layerGroup and renderers add directly to the map).
 *
 * Run: node --test tests/test_map_layer_ownership.js
 */

const assert = require('assert');
const test = require('node:test');
const vm = require('vm');
const { bootApp } = require('./support/boot_app.js');

// ── Fixture ────────────────────────────────────────────────────────────────
// One clean SCR in raw ADC units (the parser divides by 1000 ⇒ µS), so the
// analyzer finds exactly one peak (and from it, one memorable event / hotspot):
//   baseline 10.0 µS, peak 14.0 µS, rise 1.5s, half-recovery 1.0s — all inside
//   GSR_DEFAULT's shape bounds (rise 0.75–4.0s, half-recovery 0.65–7.5s).
function rampRaw(from, to, steps) {
  const out = [];
  for (let i = 1; i <= steps; i++) out.push(Math.round(from + (to - from) * i / steps));
  return out;
}
const SAMPLE_GSR_RAW = [
  ...Array(8).fill(10000),             // baseline
  ...rampRaw(10000, 14000, 15),        // rise over 1.5s
  14000,                               // apex
  ...rampRaw(14000, 12000, 10),        // drop to half over 1.0s
  ...rampRaw(12000, 10000, 10),        // return to baseline
  ...Array(8).fill(10000)
];
const SAMPLE_CSV = [
  'timestamp,lat,lon,hdop,pdop,sats,fix_type,speed_kts,course_deg,gsr_raw,hacc_m',
  ...SAMPLE_GSR_RAW.map((g, i) => {
    const t = (i * 0.1).toFixed(2);
    const lat = (51.5074 + i * 0.0001).toFixed(6);
    const lon = (-0.1278 + i * 0.0001).toFixed(6);
    return `${t},${lat},${lon},1.0,1.5,8,3,0.5,90,${g},3.0`;
  })
].join('\n');

const RENDER_KINDS = ['path', 'peak', 'connector', 'hotspot', 'collectivePath', 'collectivePeak', 'collectiveConnector'];

// ── Recording Leaflet mock ─────────────────────────────────────────────────
// Faithfully models the ownership semantics tests care about:
//   - map.addLayer(layer)            → "directly added to the map" (tiles,
//                                     legend control, and — pre-slice-1 — the
//                                     render layers themselves).
//   - layerGroup.addTo(map)          → group becomes an on-map group; its
//                                     children are on the map *via* the group
//                                     (not direct adds).
//   - group.addLayer / removeLayer   → children move in/out of the group; if
//                                     the group is on the map they appear/
//                                     disappear from the map with it.
//   - map.removeLayer(group)         → group + all children leave the map.
function installRecordingLeaflet(window) {
  const map = {
    _layers: new Map(),    // id -> top-level thing added to the map
    _direct: [],           // non-group layers added via map.addLayer (recording)
    _groups: new Map(),    // id -> layerGroup added via map.addLayer
    _viaGroup: new Set(),  // layers currently on the map only because their group is
    _nextId: 1,

    addLayer(layer) {
      if (!layer || typeof layer !== 'object') return map;
      if (layer._gsrId === undefined) layer._gsrId = map._nextId++;
      map._layers.set(layer._gsrId, layer);
      if (layer._isGroup) {
        map._groups.set(layer._gsrId, layer);
        layer._onMap = true;
        layer._children.forEach(c => map._viaGroup.add(c));
      } else {
        map._direct.push(layer);
      }
      return map;
    },

    removeLayer(layer) {
      if (!layer || layer._gsrId === undefined) return map;
      if (layer._isGroup) {
        map._groups.delete(layer._gsrId);
        map._layers.delete(layer._gsrId);
        layer._onMap = false;
        layer._children.forEach(c => map._viaGroup.delete(c));
      } else {
        const i = map._direct.indexOf(layer);
        if (i >= 0) map._direct.splice(i, 1);
        map._layers.delete(layer._gsrId);
        map._viaGroup.delete(layer);
        // Defensive: also detach from any on-map group that contained it.
        for (const g of map._groups.values()) {
          if (g.hasLayer(layer)) g._children.delete(layer._gsrId);
        }
      }
      return map;
    },

    hasLayer(layer) {
      if (!layer || layer._gsrId === undefined) return false;
      if (layer._isGroup) return map._groups.has(layer._gsrId);
      return map._direct.includes(layer) || map._viaGroup.has(layer);
    },

    // ── Geometry / lifecycle no-ops the render path touches ──
    latLngToLayerPoint() { return { x: 10, y: 20 }; },
    fitBounds() {},
    setView() { return map; },
    getBounds() { return { pad: () => ({ getNorthWest: () => ({ lat: 0, lon: 0 }), getSouthEast: () => ({ lat: 0, lon: 0 }) }) }; },
    getSize() { return { x: 800, y: 600 }; },
    on() {},
    remove() {},

    // Introspection used by the tests:
    // Render-kind layers ON the map (directly added OR living inside an on-map
    // group). Used for "nothing is left behind" assertions after clear/delete.
    renderKindsOnMap() {
      return [...map._direct, ...map._viaGroup]
        .filter(l => RENDER_KINDS.includes(l._gsrKind))
        .map(l => l._gsrKind);
    },
    // Render-kind layers added DIRECTLY via map.addLayer (not through a group).
    // Used to prove the render path never bypasses the track's layerGroup.
    directRenderKinds() {
      return map._direct
        .filter(l => RENDER_KINDS.includes(l._gsrKind))
        .map(l => l._gsrKind);
    }
  };

  function makeLayer(kind) {
    return {
      _gsrId: map._nextId++,
      _isGroup: false,
      _gsrKind: kind || 'layer',
      _gsrLayerGroup: null,
      addTo(m) { m.addLayer(this); return this; },
      remove() { map.removeLayer(this); return this; },
      bindPopup() { return this; },
      bindTooltip() { return this; },
      setZIndexOffset() { return this; },
      setOpacity() { return this; },
      setLatLng() { return this; },
      on() { return this; },
      openPopup() { return this; }
    };
  }

  function makeGroup() {
    return {
      _gsrId: map._nextId++,
      _isGroup: true,
      _children: new Map(),
      _onMap: false,
      addLayer(child) {
        this._children.set(child._gsrId, child);
        if (this._onMap) map._viaGroup.add(child);
        return this;
      },
      removeLayer(child) {
        this._children.delete(child._gsrId);
        if (this._onMap) map._viaGroup.delete(child);
        return this;
      },
      hasLayer(child) { return this._children.has(child._gsrId); },
      addTo(m) {
        m.addLayer(this); // registers group + marks children on-map
        return this;
      },
      remove() {
        map.removeLayer(this);
        return this;
      },
      getLayers() { return [...this._children.values()]; },
      eachLayer(fn) { this._children.forEach(fn); }
    };
  }

  // Legend control: enough of Leaflet's Control API for _initLegend/updateLegend.
  class FakeControl {
    constructor(options) { this.options = options || {}; }
    _onAdd() { return window.document.createElement('div'); }
    addTo(m) { m.addLayer(this); this._container = this._onAdd(); return this; }
    getContainer() { return this._container; }
    getPosition() { return this.options.position; }
  }
  FakeControl.extend = (proto) => {
    class C extends FakeControl {}
    Object.keys(proto).forEach(k => { C.prototype[k] = proto[k]; });
    return C;
  };

  const L = {
    map: () => map,
    layerGroup: makeGroup,
    polyline: (latlngs, opts) => { const l = makeLayer('path'); l._latlngs = latlngs; l._options = opts; return l; },
    polygon: (latlngs, opts) => { const l = makeLayer('cluster'); l._latlngs = latlngs; l._options = opts; return l; },
    marker: (latlng, opts) => { const l = makeLayer('marker'); l._latlng = latlng; l._options = opts; return l; },
    tileLayer: () => makeLayer('tile'),
    imageOverlay: (url, bounds, opts) => { const l = makeLayer('surface'); l._url = url; l._bounds = bounds; l._options = opts; return l; },
    featureGroup: function (layers) {
      const g = makeGroup();
      (layers || []).forEach(l => g.addLayer(l));
      g.getBounds = () => ({ getNorthWest: () => ({ lat: 0, lon: 0 }), getSouthEast: () => ({ lat: 0, lon: 0 }) });
      return g;
    },
    divIcon: (opts) => opts || {},
    icon: (opts) => opts || {},
    DomUtil: {
      create: (tag, className) => {
        const el = window.document.createElement(tag);
        if (className) el.className = className;
        return el;
      },
      setTransform() {}
    },
    Control: FakeControl
  };

  window.L = L;
  return { L, map };
}

// Boots the real app with the recording Leaflet mock installed before setup().
// RF fluid + spatial clustering are map-level aggregate layers (owned by
// GSRMapManager, out of slice-1 scope); they're nulled via the shared lexical
// binding so the tests exercise a deterministic surface: paths+peaks+hotspots.
// jsdom canvases have no 2d context, but the collective surface renderer needs
// one (fillStyle/fillRect) plus a toDataURL for the image overlay.
function bootWithRecordingL() {
  const { window, context } = bootApp();
  vm.runInContext('RFFluidRenderer = undefined; GSRSpatialClustering = undefined;', context);
  window.HTMLCanvasElement.prototype.getContext = () => ({ fillStyle: '', fillRect() {} });
  window.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,AA==';
  const { map } = installRecordingLeaflet(window);
  window.setup();
  return { window, map, mapManager: window.AppState.mapManager };
}

// Same as bootWithRecordingL() but leaves GSRSpatialClustering defined — used
// only by the skipClustering tests below, which need real cluster-blob
// layers to assert survive-by-reference (vs. replaced) behavior.
function bootWithRecordingLClusteringOn() {
  const { window, context } = bootApp();
  vm.runInContext('RFFluidRenderer = undefined;', context);
  window.HTMLCanvasElement.prototype.getContext = () => ({ fillStyle: '', fillRect() {} });
  window.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,AA==';
  const { map } = installRecordingLeaflet(window);
  window.setup();
  return { window, map, mapManager: window.AppState.mapManager };
}

// Builds a real analyzer + track object directly (no async FileReader dance),
// activates it, and returns the track. analyze() is called explicitly, mirroring
// the real runAnalysis() path with the track's filter params (GSR_DEFAULT for a
// CSV with no import block) and 0 latency.
function addTrack(window, id, name, csvText) {
  const analyzer = new window.GSRAnalyzer();
  analyzer.parseCSV(csvText);
  const track = window.GSRTrackManager.createTrackObject(id, name, '#ff0000', analyzer);
  analyzer.analyze(track.filterParams, 0);
  window.AppState.collectiveManager.addTrack(track);
  window.AppState.activeTrackId = id;
  window.AppState.analyzer = analyzer;
  return track;
}

test('slice1: single-track render owns path/peak/hotspot layers in track.layerGroup', () => {
  const { window, map, mapManager } = bootWithRecordingL();
  const track = addTrack(window, 't1', 't1.csv', SAMPLE_CSV);

  // Fixture self-check: the ownership assertions below are only meaningful if
  // this CSV actually produces peaks and hotspots — fail loudly if it stops.
  assert.ok(track.analyzer.peaks.length > 0, 'fixture must produce at least one peak');
  assert.ok(track.analyzer.memorableEvents.length > 0, 'fixture must produce at least one memorable event');

  mapManager.renderData(track.analyzer, track.gpsFilterParams);

  // The track now owns a single rendering handle, and it is on the map.
  assert.ok(track.layerGroup, 'track.layerGroup should be created by renderData');
  assert.ok(map.hasLayer(track.layerGroup), 'track.layerGroup should be on the map');

  const kinds = track.layerGroup.getLayers().map(l => l._gsrKind);
  assert.ok(kinds.includes('path'), `path segments should live in the layerGroup (got: ${kinds})`);
  assert.ok(kinds.includes('peak'), `peak markers should live in the layerGroup (got: ${kinds})`);
  assert.ok(kinds.includes('hotspot'), `hotspot markers should live in the layerGroup (got: ${kinds})`);

  // The single-track render path must NOT add its layers directly to the map —
  // they render only through the track's layerGroup. (Clusters are a map-level
  // aggregate and out of scope; connectors render with peaks and are checked
  // via the group.)
  const directRenderKinds = map.directRenderKinds();
  assert.deepStrictEqual(directRenderKinds, [],
    `no path/peak/hotspot layers should be added directly to the map (got: ${directRenderKinds})`);

  // Each render layer is reachable on the map through the group.
  track.layerGroup.getLayers().forEach(l => {
    assert.ok(map.hasLayer(l), `${l._gsrKind} layer should be on the map via its group`);
  });
});

test('slice1: peak/hotspot visibility toggles operate on the track.layerGroup', () => {
  const { window, map, mapManager } = bootWithRecordingL();
  const track = addTrack(window, 't1', 't1.csv', SAMPLE_CSV);
  mapManager.renderData(track.analyzer, track.gpsFilterParams);

  const group = track.layerGroup;
  const peakLayers = group.getLayers().filter(l => l._gsrKind === 'peak');
  const hotspotLayers = group.getLayers().filter(l => l._gsrKind === 'hotspot');
  assert.ok(peakLayers.length > 0, 'fixture should render peak markers');
  assert.ok(hotspotLayers.length > 0, 'fixture should render hotspot markers');

  // Toggle peaks OFF — they leave the group (and the map with it); hotspots stay.
  mapManager.showPeaks = false;
  mapManager.updateMarkerVisibility();
  peakLayers.forEach(m => {
    assert.ok(!group.hasLayer(m), 'peak marker should be removed from the group');
    assert.ok(!map.hasLayer(m), 'peak marker should be off the map');
  });
  hotspotLayers.forEach(m => {
    assert.ok(group.hasLayer(m), 'hotspot should be unaffected by the peak toggle');
    assert.ok(map.hasLayer(m), 'hotspot should remain on the map');
  });

  // Toggle peaks back ON.
  mapManager.showPeaks = true;
  mapManager.updateMarkerVisibility();
  peakLayers.forEach(m => {
    assert.ok(group.hasLayer(m), 'peak marker should be restored to the group');
    assert.ok(map.hasLayer(m), 'peak marker should be back on the map');
  });

  // Toggle hotspots OFF — they leave the group; peaks stay.
  mapManager.showHotspots = false;
  mapManager.updateMarkerVisibility();
  hotspotLayers.forEach(m => {
    assert.ok(!group.hasLayer(m), 'hotspot marker should be removed from the group');
    assert.ok(!map.hasLayer(m), 'hotspot marker should be off the map');
  });
  peakLayers.forEach(m => {
    assert.ok(group.hasLayer(m), 'peak should be unaffected by the hotspot toggle');
  });

  // Toggle hotspots back ON.
  mapManager.showHotspots = true;
  mapManager.updateMarkerVisibility();
  hotspotLayers.forEach(m => {
    assert.ok(group.hasLayer(m), 'hotspot marker should be restored to the group');
    assert.ok(map.hasLayer(m), 'hotspot marker should be back on the map');
  });
});

test('slice1: clearMap removes every track.layerGroup from the map and nulls it', () => {
  const { window, map, mapManager } = bootWithRecordingL();
  const track = addTrack(window, 't1', 't1.csv', SAMPLE_CSV);
  mapManager.renderData(track.analyzer, track.gpsFilterParams);

  const oldGroup = track.layerGroup;
  assert.ok(oldGroup && map.hasLayer(oldGroup), 'precondition: rendered track owns an on-map group');
  assert.ok(map.renderKindsOnMap().length > 0, 'precondition: render layers are on the map');

  mapManager.clearMap();

  assert.strictEqual(track.layerGroup, null, 'clearMap should null the track layerGroup');
  assert.ok(!map.hasLayer(oldGroup), 'clearMap should remove the track layerGroup from the map');
  assert.strictEqual(map._groups.size, 0, 'no on-map groups should remain');
  assert.deepStrictEqual(map.renderKindsOnMap(), [], 'no path/peak/hotspot layers should remain on the map');
});

test('orphan-fix: clearMap removes legacy no-track-fallback layers, not just the tracking array reference', () => {
  const { window, map, mapManager } = bootWithRecordingL();

  const analyzer = new window.GSRAnalyzer();
  analyzer.parseCSV(SAMPLE_CSV);
  const track = window.GSRTrackManager.createTrackObject('orphan', 'orphan.csv', '#ff0000', analyzer);
  analyzer.analyze(track.filterParams, 0);

  // Deliberately do NOT add this track to AppState.collectiveManager or make
  // it active — renderData() then can't resolve an active track and falls
  // back to the legacy direct-to-map path (GSRMapManager._unownedLayers).
  // Regression test for a bug found in review: _clearRenderedTrackGroups()
  // used to reset _unownedLayers = [] without calling map.removeLayer() on
  // any of them first, so every clearMap() permanently orphaned these layers
  // on the map instead of removing them.
  mapManager.renderData(analyzer, track.gpsFilterParams);

  assert.ok(map.renderKindsOnMap().length > 0, 'precondition: the legacy fallback actually rendered something');
  assert.strictEqual(map.directRenderKinds().length, map.renderKindsOnMap().length,
    'precondition: with no active track, layers go straight to the map, not a group');

  mapManager.clearMap();

  assert.deepStrictEqual(map.renderKindsOnMap(), [],
    'clearMap must remove legacy no-track layers from the map, not just drop the tracking array reference');
});

test('slice1: deleteTrack removes the track layerGroup from the map', () => {
  const { window, map, mapManager } = bootWithRecordingL();
  const track = addTrack(window, 't1', 't1.csv', SAMPLE_CSV);
  mapManager.renderData(track.analyzer, track.gpsFilterParams);

  const oldGroup = track.layerGroup;
  assert.ok(oldGroup && map.hasLayer(oldGroup), 'precondition: rendered track owns an on-map group');

  window.GSRTrackManager.deleteTrack(track.id);

  assert.ok(!window.AppState.collectiveManager.getTrack(track.id), 'track should be removed from the manager');
  assert.ok(!map.hasLayer(oldGroup), 'deleteTrack should remove the track layerGroup from the map');
  assert.strictEqual(map._groups.size, 0, 'no on-map groups should remain');
  assert.deepStrictEqual(map.renderKindsOnMap(), [], 'no render layers should remain on the map');
});

test('slice1: re-rendering the same track leaves exactly one on-map layerGroup', () => {
  const { window, map, mapManager } = bootWithRecordingL();
  const track = addTrack(window, 't1', 't1.csv', SAMPLE_CSV);
  mapManager.renderData(track.analyzer, track.gpsFilterParams);
  const group1 = track.layerGroup;
  assert.ok(map.hasLayer(group1), 'precondition: first render owns an on-map group');

  mapManager.renderData(track.analyzer, track.gpsFilterParams);

  assert.notStrictEqual(track.layerGroup, group1, 're-render should recreate the layerGroup');
  assert.ok(!map.hasLayer(group1), 'the stale layerGroup must be removed on re-render');
  assert.ok(map.hasLayer(track.layerGroup), 'the new layerGroup should be on the map');
  assert.strictEqual(map._groups.size, 1, 'exactly one on-map group for one rendered track');
  const groupKinds = track.layerGroup.getLayers().map(l => l._gsrKind).sort();
  assert.deepStrictEqual(map.renderKindsOnMap().sort(), groupKinds,
    'render layers on the map should exactly match the new group contents');
});

test('slice2: collective render gives each active track its own on-map layerGroup', () => {
  const { window, map, mapManager } = bootWithRecordingL();
  const trackA = addTrack(window, 'A', 'a.csv', SAMPLE_CSV);
  const trackB = addTrack(window, 'B', 'b.csv', SAMPLE_CSV);

  mapManager.renderCollectiveData(window.AppState.collectiveManager, { showShadedSurface: false }, 0);

  // Each active track owns its own on-map layerGroup.
  assert.ok(trackA.layerGroup, 'track A should own a layerGroup');
  assert.ok(trackB.layerGroup, 'track B should own a layerGroup');
  assert.ok(map.hasLayer(trackA.layerGroup), 'track A layerGroup should be on the map');
  assert.ok(map.hasLayer(trackB.layerGroup), 'track B layerGroup should be on the map');
  assert.notStrictEqual(trackA.layerGroup, trackB.layerGroup, 'each track owns a distinct layerGroup');

  // Each group owns that track's path/peak/hotspot layers.
  const kindsA = trackA.layerGroup.getLayers().map(l => l._gsrKind);
  const kindsB = trackB.layerGroup.getLayers().map(l => l._gsrKind);
  assert.ok(kindsA.includes('collectivePath'), `A should own a path (got: ${kindsA})`);
  assert.ok(kindsA.includes('collectivePeak'), `A should own peak markers (got: ${kindsA})`);
  assert.ok(kindsA.includes('hotspot'), `A should own hotspots (got: ${kindsA})`);
  assert.ok(kindsB.includes('collectivePath'), `B should own a path (got: ${kindsB})`);
  assert.ok(kindsB.includes('collectivePeak'), `B should own peak markers (got: ${kindsB})`);
  assert.ok(kindsB.includes('hotspot'), `B should own hotspots (got: ${kindsB})`);

  // No per-track render layer is added directly to the map — everything routes
  // through its track's layerGroup.
  assert.deepStrictEqual(map.directRenderKinds(), [],
    `no collective render layers should be added directly to the map (got: ${map.directRenderKinds()})`);

  // Each group's layers are on the map via their group.
  trackA.layerGroup.getLayers().forEach(l => assert.ok(map.hasLayer(l), `A ${l._gsrKind} should be on the map`));
  trackB.layerGroup.getLayers().forEach(l => assert.ok(map.hasLayer(l), `B ${l._gsrKind} should be on the map`));
});

test('slice2: re-rendering collective without a removed track leaves no stale group behind', () => {
  const { window, map, mapManager } = bootWithRecordingL();
  const trackA = addTrack(window, 'A', 'a.csv', SAMPLE_CSV);
  const trackB = addTrack(window, 'B', 'b.csv', SAMPLE_CSV);

  mapManager.renderCollectiveData(window.AppState.collectiveManager, { showShadedSurface: false }, 0);
  const groupB = trackB.layerGroup;
  assert.ok(groupB && map.hasLayer(groupB), 'precondition: B owns an on-map layerGroup');

  // Remove B from the manager, then re-render collective with A only.
  window.AppState.collectiveManager.removeTrack('B');
  mapManager.renderCollectiveData(window.AppState.collectiveManager, { showShadedSurface: false }, 0);

  assert.ok(!map.hasLayer(groupB), 'the removed track B layerGroup must be gone from the map');
  assert.strictEqual(trackB.layerGroup, null, 'removed track B layerGroup should be nulled');
  assert.ok(map.hasLayer(trackA.layerGroup), 'track A layerGroup should remain on the map');
  assert.strictEqual(map._groups.size, 1, 'exactly one on-map group should remain (A)');
  const aKinds = trackA.layerGroup.getLayers().map(l => l._gsrKind).sort();
  assert.deepStrictEqual(map.renderKindsOnMap().sort(), aKinds,
    'only track A render layers should remain on the map');
});

test('slice2: toggling showTracks removes only the collective path layers (via their groups)', () => {
  const { window, map, mapManager } = bootWithRecordingL();
  const trackA = addTrack(window, 'A', 'a.csv', SAMPLE_CSV);
  const trackB = addTrack(window, 'B', 'b.csv', SAMPLE_CSV);

  mapManager.renderCollectiveData(window.AppState.collectiveManager, { showShadedSurface: false }, 0);
  const pathsA = trackA.layerGroup.getLayers().filter(l => l._gsrKind === 'collectivePath');
  const peaksA = trackA.layerGroup.getLayers().filter(l => l._gsrKind === 'collectivePeak');
  assert.ok(pathsA.length > 0, 'fixture should render a collective path for A');
  assert.ok(peaksA.length > 0, 'fixture should render collective peak markers for A');
  pathsA.forEach(p => assert.ok(map.hasLayer(p), 'precondition: path is on the map'));

  mapManager.showTracks = false;
  mapManager.toggleTracks(false);

  pathsA.forEach(p => {
    assert.ok(!trackA.layerGroup.hasLayer(p), 'path should be removed from its track group');
    assert.ok(!map.hasLayer(p), 'path should be off the map');
  });
  peaksA.forEach(m => {
    assert.ok(trackA.layerGroup.hasLayer(m), 'peak markers should be unaffected by showTracks');
    assert.ok(map.hasLayer(m), 'peak markers should remain on the map');
  });

  // Re-enable.
  mapManager.showTracks = true;
  mapManager.toggleTracks(true);
  pathsA.forEach(p => {
    assert.ok(trackA.layerGroup.hasLayer(p), 'path should be restored to its track group');
    assert.ok(map.hasLayer(p), 'path should be back on the map');
  });
});

test('slice2: surface overlay is recreated on render while hidden, so it can be toggled back on', () => {
  // Regression for: "delete a track while the collective surface is off, and
  // the surface won't come back when toggled on." renderContours() used to gate
  // overlay *creation* on the button's showShadedSurface, but every render
  // calls clearContours() which nulls surfaceOverlay — so a re-render while
  // hidden (exactly what deleteTrack triggers via updateCollectiveMap) left
  // surfaceOverlay null, and toggleSurface(true)'s `if (!this.surfaceOverlay)
  // return;` had nothing to re-add.
  const { window, map, mapManager } = bootWithRecordingL();
  addTrack(window, 'A', 'a.csv', SAMPLE_CSV);
  addTrack(window, 'B', 'b.csv', SAMPLE_CSV);

  // 1. Render with the surface ON.
  mapManager.renderCollectiveData(window.AppState.collectiveManager, {}, 0);
  const firstOverlay = mapManager.surfaceOverlay;
  assert.ok(firstOverlay, 'precondition: a surface overlay should exist when the surface is on');
  assert.ok(map.hasLayer(firstOverlay), 'precondition: the surface should be on the map');

  // 2. Toggle the surface off.
  mapManager.toggleSurface(false);
  assert.ok(!map.hasLayer(firstOverlay), 'surface removed when toggled off');

  // 3. Simulate deleting a track while the surface is off: the delete path
  //    re-renders collective with the button's (now off) contourParams.
  mapManager.renderCollectiveData(window.AppState.collectiveManager, { showShadedSurface: false }, 0);
  assert.ok(mapManager.surfaceOverlay, 'render while hidden must recreate the overlay (not leave it null)');
  assert.ok(!map.hasLayer(mapManager.surfaceOverlay), 'recreated overlay stays hidden while showSurface=false');

  // 4. Toggling the surface back on must bring it back — the reported bug.
  mapManager.toggleSurface(true);
  assert.ok(map.hasLayer(mapManager.surfaceOverlay), 'surface overlay should reappear when toggled on');
});

test('slice3: getRenderLayers() derives the per-track layers from the layerGroups (single)', () => {
  const { window, map, mapManager } = bootWithRecordingL();
  const track = addTrack(window, 't1', 't1.csv', SAMPLE_CSV);
  mapManager.renderData(track.analyzer, track.gpsFilterParams);

  // The flat arrays are gone — getRenderLayers() is the source of truth,
  // derived from the track's layerGroup (so the SVG exporter can still work).
  assert.strictEqual(mapManager.pathSegments, undefined, 'pathSegments flat array should be removed');
  assert.strictEqual(mapManager.peakMarkers, undefined, 'peakMarkers flat array should be removed');
  assert.strictEqual(mapManager.hotspotMarkers, undefined, 'hotspotMarkers flat array should be removed');

  const render = mapManager.getRenderLayers();
  assert.ok(render.paths.length > 0, 'paths should be derived from the group');
  assert.ok(render.peakMarkers.length > 0, 'peak markers should be derived from the group');
  assert.ok(render.hotspots.length > 0, 'hotspots should be derived from the group');

  const groupLayers = track.layerGroup.getLayers();
  render.paths.forEach(p => assert.ok(groupLayers.includes(p), 'path should come from the group'));
  render.peakMarkers.forEach(m => assert.ok(groupLayers.includes(m), 'peak/connector should come from the group'));
  render.hotspots.forEach(m => assert.ok(groupLayers.includes(m), 'hotspot should come from the group'));

  // All the group's per-track layers are reachable through the accessor.
  const renderSet = new Set([...render.paths, ...render.peakMarkers, ...render.hotspots]);
  groupLayers.forEach(l => {
    if (['path', 'peak', 'connector', 'hotspot'].includes(l._gsrKind)) {
      assert.ok(renderSet.has(l), `group ${l._gsrKind} should be exposed via getRenderLayers()`);
    }
  });
});

test('slice3: getRenderLayers() derives the collective layers from each track group', () => {
  const { window, map, mapManager } = bootWithRecordingL();
  const trackA = addTrack(window, 'A', 'a.csv', SAMPLE_CSV);
  const trackB = addTrack(window, 'B', 'b.csv', SAMPLE_CSV);
  mapManager.renderCollectiveData(window.AppState.collectiveManager, { showShadedSurface: false }, 0);

  const render = mapManager.getRenderLayers();
  assert.ok(render.paths.some(p => p._gsrKind === 'collectivePath'), 'collective paths should be exposed');
  assert.ok(render.peakMarkers.some(m => m._gsrKind === 'collectivePeak'), 'collective peaks should be exposed');
  assert.ok(render.hotspots.length > 0, 'collective hotspots should be exposed');

  // All collective layers come from per-track groups.
  const allGroupLayers = [...trackA.layerGroup.getLayers(), ...trackB.layerGroup.getLayers()];
  const renderSet = new Set([...render.paths, ...render.peakMarkers, ...render.hotspots]);
  allGroupLayers.forEach(l => assert.ok(renderSet.has(l), `${l._gsrKind} should be exposed via getRenderLayers()`));
});

test('slice3: getPeakMarkerByIndex resolves the marker for a peak index', () => {
  const { window, map, mapManager } = bootWithRecordingL();
  const track = addTrack(window, 't1', 't1.csv', SAMPLE_CSV);
  mapManager.renderData(track.analyzer, track.gpsFilterParams);

  const marker = mapManager.getPeakMarkerByIndex(0);
  assert.ok(marker, 'peak marker for index 0 should resolve');
  assert.strictEqual(marker._gsrKind, 'peak', 'resolved marker should be a peak marker');
  assert.ok(track.layerGroup.hasLayer(marker), 'resolved marker should live in the track group');

  assert.strictEqual(mapManager.getPeakMarkerByIndex(9999), null,
    'an out-of-range peak index should resolve to null (no crash)');
});

test('slice3: clearCollectiveLayers clears the per-track layerGroups (stale-group fix)', () => {
  // Regression for: uncheck the last track in collective view -> ui.js calls
  // clearCollectiveLayers() and returns (no re-render), so the previous
  // render's per-track groups used to linger on the map.
  const { window, map, mapManager } = bootWithRecordingL();
  const track = addTrack(window, 'A', 'a.csv', SAMPLE_CSV);
  mapManager.renderCollectiveData(window.AppState.collectiveManager, { showShadedSurface: false }, 0);
  const group = track.layerGroup;
  assert.ok(group && map.hasLayer(group), 'precondition: rendered track owns an on-map group');

  mapManager.clearCollectiveLayers();

  assert.ok(!map.hasLayer(group), 'clearCollectiveLayers should remove the per-track group');
  assert.strictEqual(track.layerGroup, null, 'clearCollectiveLayers should null the track layerGroup');
  assert.strictEqual(map._groups.size, 0, 'no on-map groups should remain');
  assert.deepStrictEqual(map.renderKindsOnMap(), [], 'no render layers should remain on the map');
});

test('slice3: fitToTrack still fits the rendered paths without the flat arrays', () => {
  const { window, map, mapManager } = bootWithRecordingL();
  const track = addTrack(window, 't1', 't1.csv', SAMPLE_CSV);
  mapManager.renderData(track.analyzer, track.gpsFilterParams);
  assert.doesNotThrow(() => mapManager.fitToTrack(), 'fitToTrack should work off the derived paths');
});

test('slice3: the single-track path always renders regardless of showTracks (toggle is collective-only)', () => {
  // Regression: gating the single-track path on showTracks meant a leftover
  // showTracks=false from a collective toggle hid the active track's path in
  // single mode — with no way to restore it (the Tracks button is hidden in
  // single view). The single path always renders; toggleTracks only affects
  // collective paths.
  const { window, map, mapManager } = bootWithRecordingL();
  const track = addTrack(window, 't1', 't1.csv', SAMPLE_CSV);

  mapManager.showTracks = false;
  mapManager.renderData(track.analyzer, track.gpsFilterParams);
  const kinds = track.layerGroup.getLayers().map(l => l._gsrKind);
  assert.ok(kinds.includes('path'), 'single-track path should always render, even with showTracks=false');
  assert.ok(kinds.includes('peak'), 'peak markers should render');

  // toggleTracks must NOT hide the single-track path (it only affects collective paths).
  mapManager.toggleTracks(false);
  assert.ok(track.layerGroup.getLayers().some(l => l._gsrKind === 'path'),
    'toggling tracks off must not hide the single-track path');
});

test('slice3: renderData renders peaks/hotspots even when every GPS fix is quality-gated out', () => {
  // Regression for: "a track in single mode where I couldn't see any of the
  // peaks." Some real tracks have ALL GPS fixes dropped by the quality gates
  // (e.g. every HDOP > the 3.0 default), so the GPS pipeline returns an empty
  // drawPoints array. renderData used to early-return on `drawPoints.length ===
  // 0`, silently hiding the path AND the peaks/hotspots — even though peak and
  // hotspot markers resolve their own coordinates from the RAW data via
  // analyzer.getCoordinates, independent of the filter pipeline. The map must
  // still show the track's events (peaks + hotspots) when there's no drawable
  // path.
  const { window, map, mapManager } = bootWithRecordingL();

  // Same SCR fixture as SAMPLE_CSV but with HDOP 9.0 on every fix — well above
  // the default gate (GPS_DEFAULT.maxHdop = 3.0), so the whole path is gated.
  const GATED_CSV = [
    'timestamp,lat,lon,hdop,pdop,sats,fix_type,speed_kts,course_deg,gsr_raw,hacc_m',
    ...SAMPLE_GSR_RAW.map((g, i) => {
      const t = (i * 0.1).toFixed(2);
      const lat = (51.5074 + i * 0.0001).toFixed(6);
      const lon = (-0.1278 + i * 0.0001).toFixed(6);
      return `${t},${lat},${lon},9.0,1.5,8,3,0.5,90,${g},3.0`;
    })
  ].join('\n');

  const track = addTrack(window, 't1', 't1.csv', GATED_CSV);

  // Fixture self-check: the analyzer must still detect peaks (from GSR), and
  // those peaks must be placeable from raw GPS coords.
  assert.ok(track.analyzer.peaks.length > 0, 'fixture must still produce peaks');
  assert.ok(track.analyzer.peaks.every((peak, idx) => {
    const coords = track.analyzer.getCoordinates(idx);
    return coords && !isNaN(coords.lat) && !isNaN(coords.lon);
  }), 'fixture peaks must be resolvable from raw data');

  mapManager.renderData(track.analyzer, track.gpsFilterParams);

  // The path is fully gated out — but the track's events must still render.
  const group = track.layerGroup;
  assert.ok(group, 'a layerGroup should be created even when the path is gated out');
  assert.ok(map.hasLayer(group), 'the layerGroup should be on the map');
  const kinds = group.getLayers().map(l => l._gsrKind);
  assert.ok(!kinds.includes('path'), `no path when every fix is gated out (got: ${kinds})`);
  assert.ok(kinds.includes('peak'), `peak markers must render without a path (got: ${kinds})`);
  assert.ok(kinds.includes('hotspot'), `hotspot markers must render without a path (got: ${kinds})`);

  // Peaks must be on the map (via the group) and resolvable by index.
  group.getLayers().forEach(l => assert.ok(map.hasLayer(l), `${l._gsrKind} should be on the map`));
  assert.ok(mapManager.getPeakMarkerByIndex(0), 'peak index 0 should resolve to a rendered marker');
});

test('slice3: peaks/hotspots hidden at render time still route through the track group (removal-safe)', () => {
  // Regression for: "in collective view I removed all the tracks and all the
  // peaks and hotspots were left behind." When peaks/hotspots were toggled OFF
  // at render time, their markers were created but never tagged with
  // _gsrLayerGroup (the tag lived inside the `shouldAdd` / `showHotspots`
  // gate). Toggling them ON later made _toggleLayer fall back to the legacy
  // direct-to-map add — so removing the track (which removes only its
  // layerGroup) left those peaks/hotspots on the map. The group tag must be
  // applied regardless of visibility.
  const { window, map, mapManager } = bootWithRecordingL();
  addTrack(window, 'A', 'a.csv', SAMPLE_CSV);
  addTrack(window, 'B', 'b.csv', SAMPLE_CSV);
  window.AppState.activeTrackId = 'A';
  window.AppState.viewMode = 'collective';

  // Render collective with peaks/hotspots OFF (hidden at render time).
  mapManager.showPeaks = false;
  mapManager.showHotspots = false;
  mapManager.showLabels = false;
  mapManager.renderCollectiveData(window.AppState.collectiveManager, { showShadedSurface: false }, 0);

  // Toggle them back ON — this is where the old code leaked markers to the map.
  mapManager.showPeaks = true;
  mapManager.showHotspots = true;
  mapManager.updateMarkerVisibility();

  assert.deepStrictEqual(map.directRenderKinds(), [],
    'toggling peaks/hotspots on must not add any render layer directly to the map (they belong in track groups)');

  const trackA = window.AppState.collectiveManager.getTrack('A');
  const trackB = window.AppState.collectiveManager.getTrack('B');
  const peakCount = trackA.layerGroup.getLayers().filter(l => l._gsrKind === 'collectivePeak').length;
  const hotspotCount = trackA.layerGroup.getLayers().filter(l => l._gsrKind === 'hotspot').length;
  assert.ok(peakCount > 0, 'toggled-on collective peaks should live in track A group');
  assert.ok(hotspotCount > 0, 'toggled-on hotspots should live in track A group');

  // Snapshot A's rendered layers so we can prove removal takes them all.
  const aGroup = trackA.layerGroup;
  const aGroupLayers = aGroup.getLayers();
  assert.ok(aGroupLayers.length > 0, 'precondition: A owns on-map group layers');

  // Removing a track must take its (now group-owned) peaks/hotspots with it.
  window.GSRTrackManager.deleteTrack('A');
  assert.ok(!map.hasLayer(aGroup), 'track A group should be removed from the map');
  aGroupLayers.forEach(l => {
    assert.ok(!map.hasLayer(l), `A's ${l._gsrKind} should be off the map after removal`);
  });

  // B's group survives (only A was removed) — then removing B empties the map.
  assert.ok(map.hasLayer(trackB.layerGroup), 'track B group should remain on the map');
  window.GSRTrackManager.deleteTrack('B');
  assert.deepStrictEqual(map.renderKindsOnMap(), [],
    `deleting all tracks must leave no render layers behind (got: ${map.renderKindsOnMap()})`);
  assert.strictEqual(map._groups.size, 0, 'no on-map groups should remain');
});

test('slice3: RF Fluid button stays in sync with showRFFluid across no-RF→RF renders', () => {
  // Regression for: "RF fluid visible on the loaded track even when the button
  // is not pressed, in collective mode." _updateRfFluidButtonState(false) (a
  // no-RF track) used to clear the button's 'active' class and disable it while
  // leaving showRFFluid true and the renderer visible. A later
  // _updateRfFluidButtonState(true) (collective render where a track has RF
  // data) re-enabled the button but did NOT restore its pressed state — so the
  // fluid rendered behind an "unpressed" button with no way to turn it off.
  // The button + renderer must be re-synced to the real showRFFluid value.
  const { window, mapManager } = bootWithRecordingL();
  const btn = window.document.getElementById('btnToggleRFFluid');
  assert.ok(btn, 'RF Fluid button should exist in the booted DOM');

  // Default: button pressed (HTML starts with 'active') and fluid on.
  assert.ok(mapManager.showRFFluid, 'precondition: showRFFluid starts true');
  assert.ok(btn.classList.contains('active'), 'precondition: button starts pressed');

  // 1. Render a no-RF track → button disabled + unpressed, but showRFFluid stays true.
  mapManager._updateRfFluidButtonState(false);
  assert.ok(btn.hasAttribute('disabled'), 'no-RF track should disable the RF Fluid button');
  assert.ok(!btn.classList.contains('active'), 'no-RF track should unpressed the button');

  // 2. Render with RF data again → button re-enabled AND re-pressed (matching
  //    the still-true showRFFluid), so the fluid is clearly "on".
  mapManager._updateRfFluidButtonState(true);
  assert.ok(!btn.hasAttribute('disabled'), 'RF track should re-enable the button');
  assert.ok(btn.classList.contains('active'),
    'RF track must restore the button pressed state to match showRFFluid (regression)');
  assert.ok(mapManager.showRFFluid, 'showRFFluid unchanged by button-state sync');

  // 3. User toggles fluid OFF → showRFFluid false; a no-RF then RF sequence
  //    must NOT silently re-enable the fluid.
  mapManager.showRFFluid = false;
  mapManager._updateRfFluidButtonState(false); // no-RF track
  mapManager._updateRfFluidButtonState(true);  // RF track
  assert.ok(!btn.classList.contains('active'),
    'after user toggled off, the RF Fluid button must stay unpressed through a re-render');
  assert.ok(!mapManager.showRFFluid, 'showRFFluid stays false after user toggled off');
});

test('slice3: entering collective (0 active tracks) drops a lingering scrub marker', () => {
  // Regression for: "black pulsing dot on the map while not in the scrub graph
  // window." Hovering the single-track graph shows the map scrub indicator;
  // entering collective with 0 active tracks calls clearCollectiveLayers() (not
  // clearMap), which used to leave that marker on the map — and with noLoop()
  // stopping handleScrubber there, nothing ever hid it.
  const { window, map, mapManager } = bootWithRecordingL();
  addTrack(window, 'A', 'a.csv', SAMPLE_CSV);

  // Show the scrub indicator (as if hovering the graph in single mode).
  mapManager.setScrubPosition(51.5, -0.1);
  assert.ok(map.hasLayer(mapManager.scrubMarker), 'precondition: scrub marker shown on the map');

  // The 0-active-tracks collective path (ui.js _updateCollectiveMapNow) only
  // calls clearCollectiveLayers().
  mapManager.clearCollectiveLayers();

  assert.ok(!map.hasLayer(mapManager.scrubMarker),
    'clearCollectiveLayers should drop the scrub marker (no graph to scrub in collective view)');
});

// ── refreshPeakMarkers (docs/archive/visualizer_rendering_perf_routes.md §2.2) ──────
// A label edit only ever changes one peak's label chip/popup; refreshPeakMarkers()
// exists so that no longer costs a full renderData() clear+rebuild of the path
// and hotspot layers too. These tests pin the contract: path/hotspot layers
// must survive by reference (proving they weren't touched), peak/connector
// layers must be fully replaced (proving the label/collision change actually
// took effect), and nothing is left orphaned or duplicated on the map.

test('refreshPeakMarkers: rebuilds only peak/connector layers, leaving path and hotspot layers untouched', () => {
  const { window, map, mapManager } = bootWithRecordingL();
  const track = addTrack(window, 't1', 't1.csv', SAMPLE_CSV);
  mapManager.renderData(track.analyzer, track.gpsFilterParams);

  const byKind = (layers, kinds) => layers.filter(l => kinds.includes(l._gsrKind));
  const before = track.layerGroup.getLayers();
  const pathBefore = byKind(before, ['path']);
  const hotspotBefore = byKind(before, ['hotspot']);
  const peakBefore = byKind(before, ['peak', 'connector']);
  assert.ok(pathBefore.length > 0, 'fixture renders at least one path segment');
  assert.ok(hotspotBefore.length > 0, 'fixture renders at least one hotspot');
  assert.ok(peakBefore.length > 0, 'fixture renders at least one peak marker');

  track.analyzer.peaks[0].label = 'Edited label';
  mapManager.refreshPeakMarkers(track.analyzer, track.gpsFilterParams);

  const after = track.layerGroup.getLayers();
  const pathAfter = byKind(after, ['path']);
  const hotspotAfter = byKind(after, ['hotspot']);
  const peakAfter = byKind(after, ['peak', 'connector']);

  assert.strictEqual(pathAfter.length, pathBefore.length, 'path layer count unchanged');
  assert.ok(pathBefore.every(l => pathAfter.includes(l)), 'every path layer instance survives refreshPeakMarkers untouched');

  assert.strictEqual(hotspotAfter.length, hotspotBefore.length, 'hotspot layer count unchanged');
  assert.ok(hotspotBefore.every(l => hotspotAfter.includes(l)), 'every hotspot layer instance survives refreshPeakMarkers untouched');

  assert.ok(peakBefore.every(l => !peakAfter.includes(l)), 'old peak/connector layer instances are replaced, not reused');
  peakBefore.forEach(l => assert.ok(!map.hasLayer(l), 'old peak/connector layer removed from the map'));
  peakAfter.forEach(l => assert.ok(map.hasLayer(l), 'new peak/connector layer is on the map via the track group'));

  // No duplicates and no orphans: exactly one on-map group, its contents are
  // exactly path (untouched) + hotspot (untouched) + the fresh peak/connector set.
  assert.strictEqual(map._groups.size, 1, 'still exactly one on-map layerGroup for the track');
  assert.strictEqual(after.length, pathAfter.length + hotspotAfter.length + peakAfter.length,
    'group contains only path+hotspot+peak/connector layers — nothing orphaned or duplicated');
});

test('refreshPeakMarkers: falls back to a full renderData() when there is no resolvable active track', () => {
  const { window, map, mapManager } = bootWithRecordingL();
  const track = addTrack(window, 't1', 't1.csv', SAMPLE_CSV);
  mapManager.renderData(track.analyzer, track.gpsFilterParams);

  // Simulate the legacy no-track fallback (see _getTrackLayerGroup's doc
  // comment): activeTrackId no longer resolves to a managed track.
  window.AppState.activeTrackId = 'does-not-exist';

  mapManager.refreshPeakMarkers(track.analyzer, track.gpsFilterParams);

  const kinds = map.renderKindsOnMap();
  assert.ok(kinds.includes('path'), 'fallback renderData() still renders the path');
  assert.ok(kinds.includes('peak'), 'fallback renderData() still renders peaks');
  assert.ok(kinds.includes('hotspot'), 'fallback renderData() still renders hotspots');
});

test('updatePeakLabel (ui.js): commits a label via refreshPeakMarkers, not a full renderData() rebuild', () => {
  const { window, map, mapManager } = bootWithRecordingL();
  const track = addTrack(window, 't1', 't1.csv', SAMPLE_CSV);
  window.AppState.viewMode = 'single';
  mapManager.renderData(track.analyzer, track.gpsFilterParams);

  const before = track.layerGroup.getLayers();
  const pathBefore = before.filter(l => l._gsrKind === 'path');
  const hotspotBefore = before.filter(l => l._gsrKind === 'hotspot');
  assert.ok(pathBefore.length > 0, 'fixture renders at least one path segment');
  assert.ok(hotspotBefore.length > 0, 'fixture renders at least one hotspot');

  window.GSRUI.updatePeakLabel(0, 'Interesting spot');

  assert.strictEqual(track.analyzer.peaks[0].label, 'Interesting spot', 'label was actually committed');

  const after = track.layerGroup.getLayers();
  const pathAfter = after.filter(l => l._gsrKind === 'path');
  const hotspotAfter = after.filter(l => l._gsrKind === 'hotspot');
  assert.deepStrictEqual(pathAfter, pathBefore, 'committing a label through the real ui.js path must not rebuild path layers');
  assert.deepStrictEqual(hotspotAfter, hotspotBefore, 'committing a label through the real ui.js path must not rebuild hotspot layers');
});

// ── togglePeakExclusion (ui.js) — Phase 6 step 2 ────────────────────────────
// Same shape as the updatePeakLabel migration above: an exclusion toggle only
// changes one peak marker's styling, so it should go through
// refreshPeakMarkers() too, not a full renderData() rebuild.

test('togglePeakExclusion (ui.js): commits via refreshPeakMarkers, not a full renderData() rebuild', () => {
  const { window, map, mapManager } = bootWithRecordingL();
  const track = addTrack(window, 't1', 't1.csv', SAMPLE_CSV);
  window.AppState.viewMode = 'single';
  mapManager.renderData(track.analyzer, track.gpsFilterParams);

  const before = track.layerGroup.getLayers();
  const pathBefore = before.filter(l => l._gsrKind === 'path');
  const hotspotBefore = before.filter(l => l._gsrKind === 'hotspot');
  assert.ok(pathBefore.length > 0, 'fixture renders at least one path segment');
  assert.ok(hotspotBefore.length > 0, 'fixture renders at least one hotspot');

  const wasExcluded = track.analyzer.peaks[0].excluded;
  window.GSRUI.togglePeakExclusion(0);

  assert.strictEqual(track.analyzer.peaks[0].excluded, !wasExcluded, 'exclusion flag was actually flipped');

  const after = track.layerGroup.getLayers();
  const pathAfter = after.filter(l => l._gsrKind === 'path');
  const hotspotAfter = after.filter(l => l._gsrKind === 'hotspot');
  assert.deepStrictEqual(pathAfter, pathBefore, 'toggling exclusion through the real ui.js path must not rebuild path layers');
  assert.deepStrictEqual(hotspotAfter, hotspotBefore, 'toggling exclusion through the real ui.js path must not rebuild hotspot layers');
});

// ── refreshPeakMarkers skipClustering (docs/archive/visualizer_rendering_perf_routes.md §2.4) ──
// Found via real A/B benchmarking: refreshPeakMarkers() unconditionally
// recomputed spatial-cluster blobs even for a label-only edit, which
// clusterPeaks() can't be affected by (it only reads lat/lon/amplitude per
// non-excluded peak). updatePeakLabel() now passes { skipClustering: true };
// togglePeakExclusion() must NOT, since excluding a peak changes
// clusterPeaks()'s input set. These tests need real cluster layers, so they
// use bootWithRecordingLClusteringOn() instead of the suite's usual
// bootWithRecordingL() (which nulls GSRSpatialClustering out of scope for
// every other test in this file).

test('updatePeakLabel (ui.js): a label edit leaves existing cluster blob layers untouched by reference', () => {
  const { window, mapManager } = bootWithRecordingLClusteringOn();
  const track = addTrack(window, 't1', 't1.csv', SAMPLE_CSV);
  window.AppState.viewMode = 'single';
  mapManager.renderData(track.analyzer, track.gpsFilterParams);

  const clustersBefore = mapManager.clusterLayers.slice();
  assert.ok(clustersBefore.length > 0, 'fixture renders at least one cluster blob');

  window.GSRUI.updatePeakLabel(0, 'Interesting spot');

  assert.strictEqual(track.analyzer.peaks[0].label, 'Interesting spot', 'label was actually committed');
  assert.deepStrictEqual(mapManager.clusterLayers, clustersBefore,
    'a label edit must not recompute cluster blobs — clusterPeaks() input (lat/lon/amplitude) is unaffected by a label');
});

test('togglePeakExclusion (ui.js): an exclusion toggle DOES recompute cluster blob layers (clusterPeaks() input changed)', () => {
  const { window, mapManager } = bootWithRecordingLClusteringOn();
  const track = addTrack(window, 't1', 't1.csv', SAMPLE_CSV);
  window.AppState.viewMode = 'single';
  mapManager.renderData(track.analyzer, track.gpsFilterParams);

  const clustersBefore = mapManager.clusterLayers.slice();
  assert.ok(clustersBefore.length > 0, 'fixture renders at least one cluster blob');

  window.GSRUI.togglePeakExclusion(0);

  // The fixture's one peak just became excluded, so activePeaks is now
  // empty and no cluster blobs should remain — the important assertion is
  // that the array was actually touched (recomputed), not left as-is.
  assert.notDeepStrictEqual(mapManager.clusterLayers, clustersBefore,
    'toggling exclusion must recompute cluster blobs, unlike a label edit');
});

test('refreshPeakMarkers({ skipClustering: true }): replaces peak/connector layers exactly like the default call, only clustering differs', () => {
  const { window, map, mapManager } = bootWithRecordingLClusteringOn();
  const track = addTrack(window, 't1', 't1.csv', SAMPLE_CSV);
  mapManager.renderData(track.analyzer, track.gpsFilterParams);

  const byKind = (layers, kinds) => layers.filter(l => kinds.includes(l._gsrKind));
  const peakBefore = byKind(track.layerGroup.getLayers(), ['peak', 'connector']);
  assert.ok(peakBefore.length > 0, 'fixture renders at least one peak marker');

  track.analyzer.peaks[0].label = 'Edited label';
  mapManager.refreshPeakMarkers(track.analyzer, track.gpsFilterParams, { skipClustering: true });

  const peakAfter = byKind(track.layerGroup.getLayers(), ['peak', 'connector']);
  assert.ok(peakBefore.every(l => !peakAfter.includes(l)), 'old peak/connector layer instances are still replaced, not reused');
  peakBefore.forEach(l => assert.ok(!map.hasLayer(l), 'old peak/connector layer removed from the map'));
  peakAfter.forEach(l => assert.ok(map.hasLayer(l), 'new peak/connector layer is on the map via the track group'));
});

// ── refreshPath (docs/archive/visualizer_rendering_perf_routes.md §2.2) ────────────
// The map-coloring-metric dropdown only changes how the path is colored;
// refreshPath() exists so that no longer costs a full renderData() rebuild of
// peak and hotspot layers too. Mirrors the refreshPeakMarkers contract tests
// above with path/peaks swapped.

test('refreshPath: rebuilds only path layers, leaving peak/connector and hotspot layers untouched', () => {
  const { window, map, mapManager } = bootWithRecordingL();
  const track = addTrack(window, 't1', 't1.csv', SAMPLE_CSV);
  mapManager.renderData(track.analyzer, track.gpsFilterParams);

  const byKind = (layers, kinds) => layers.filter(l => kinds.includes(l._gsrKind));
  const before = track.layerGroup.getLayers();
  const pathBefore = byKind(before, ['path']);
  const hotspotBefore = byKind(before, ['hotspot']);
  const peakBefore = byKind(before, ['peak', 'connector']);
  assert.ok(pathBefore.length > 0, 'fixture renders at least one path segment');
  assert.ok(hotspotBefore.length > 0, 'fixture renders at least one hotspot');
  assert.ok(peakBefore.length > 0, 'fixture renders at least one peak marker');

  mapManager.activeColoringMetric = 'hdopQuality';
  mapManager.refreshPath(track.analyzer, track.gpsFilterParams);

  const after = track.layerGroup.getLayers();
  const pathAfter = byKind(after, ['path']);
  const hotspotAfter = byKind(after, ['hotspot']);
  const peakAfter = byKind(after, ['peak', 'connector']);

  assert.ok(peakBefore.every(l => peakAfter.includes(l)), 'every peak/connector layer instance survives refreshPath untouched');
  assert.ok(hotspotBefore.every(l => hotspotAfter.includes(l)), 'every hotspot layer instance survives refreshPath untouched');

  assert.ok(pathBefore.every(l => !pathAfter.includes(l)), 'old path layer instances are replaced, not reused');
  pathBefore.forEach(l => assert.ok(!map.hasLayer(l), 'old path layer removed from the map'));
  pathAfter.forEach(l => assert.ok(map.hasLayer(l), 'new path layer is on the map via the track group'));

  assert.strictEqual(map._groups.size, 1, 'still exactly one on-map layerGroup for the track');
  assert.strictEqual(after.length, pathAfter.length + hotspotAfter.length + peakAfter.length,
    'group contains only path+hotspot+peak/connector layers — nothing orphaned or duplicated');
});

test('refreshPath: falls back to a full renderData() when there is no resolvable active track', () => {
  const { window, map, mapManager } = bootWithRecordingL();
  const track = addTrack(window, 't1', 't1.csv', SAMPLE_CSV);
  mapManager.renderData(track.analyzer, track.gpsFilterParams);

  window.AppState.activeTrackId = 'does-not-exist';

  mapManager.refreshPath(track.analyzer, track.gpsFilterParams);

  const kinds = map.renderKindsOnMap();
  assert.ok(kinds.includes('path'), 'fallback renderData() still renders the path');
  assert.ok(kinds.includes('peak'), 'fallback renderData() still renders peaks');
  assert.ok(kinds.includes('hotspot'), 'fallback renderData() still renders hotspots');
});

test('mapColoringMetric dropdown (events.js): single-track view commits via refreshPath, not a full rerenderMap()', () => {
  const { window, map, mapManager } = bootWithRecordingL();
  const track = addTrack(window, 't1', 't1.csv', SAMPLE_CSV);
  window.AppState.viewMode = 'single';
  mapManager.renderData(track.analyzer, track.gpsFilterParams);

  const before = track.layerGroup.getLayers();
  const peakBefore = before.filter(l => l._gsrKind === 'peak' || l._gsrKind === 'connector');
  const hotspotBefore = before.filter(l => l._gsrKind === 'hotspot');
  assert.ok(peakBefore.length > 0, 'fixture renders at least one peak marker');
  assert.ok(hotspotBefore.length > 0, 'fixture renders at least one hotspot');

  const select = window.document.getElementById('mapColoringMetric');
  select.value = 'hdopQuality';
  select.dispatchEvent(new window.Event('change'));

  assert.strictEqual(mapManager.activeColoringMetric, 'hdopQuality', 'metric was actually applied');

  const after = track.layerGroup.getLayers();
  const peakAfter = after.filter(l => l._gsrKind === 'peak' || l._gsrKind === 'connector');
  const hotspotAfter = after.filter(l => l._gsrKind === 'hotspot');
  assert.deepStrictEqual(peakAfter, peakBefore, 'switching coloring metric through the real events.js wiring must not rebuild peak layers');
  assert.deepStrictEqual(hotspotAfter, hotspotBefore, 'switching coloring metric through the real events.js wiring must not rebuild hotspot layers');
});

// ── refreshCollectivePeakMarkers (Phase 6 step 2, collective-mode investigation) ──
// A label edit in collective view only ever changes one track's one peak's
// label chip/popup + that track's own 360° label-collision layout — nothing
// else in collective mode reads peak.label (clustering and the contour
// surface only read lat/lon/amplitude/excluded). refreshCollectivePeakMarkers
// exists so that no longer costs a full renderCollectiveData() rebuild:
// unlike togglePeakExclusion (still full-rebuild — excluded IS read by
// clustering/contours), this is safe to scope to just the edited track.

test('refreshCollectivePeakMarkers: rebuilds only the target track\'s peak/connector layers, leaving its own path/hotspot and the OTHER track entirely untouched', () => {
  const { window, map, mapManager } = bootWithRecordingL();
  const trackA = addTrack(window, 'A', 'a.csv', SAMPLE_CSV);
  const trackB = addTrack(window, 'B', 'b.csv', SAMPLE_CSV);
  mapManager.renderCollectiveData(window.AppState.collectiveManager, { showShadedSurface: false }, 0);

  const byKind = (layers, kinds) => layers.filter(l => kinds.includes(l._gsrKind));
  const beforeA = trackA.layerGroup.getLayers();
  const pathBeforeA = byKind(beforeA, ['collectivePath']);
  const hotspotBeforeA = byKind(beforeA, ['hotspot']);
  const peakBeforeA = byKind(beforeA, ['collectivePeak', 'collectiveConnector']);
  assert.ok(pathBeforeA.length > 0, 'fixture renders at least one path segment for A');
  assert.ok(hotspotBeforeA.length > 0, 'fixture renders at least one hotspot for A');
  assert.ok(peakBeforeA.length > 0, 'fixture renders at least one peak marker for A');
  const beforeB = trackB.layerGroup.getLayers().slice();

  trackA.analyzer.peaks[0].label = 'Edited in collective view';
  mapManager.refreshCollectivePeakMarkers(trackA, 0);

  const afterA = trackA.layerGroup.getLayers();
  const pathAfterA = byKind(afterA, ['collectivePath']);
  const hotspotAfterA = byKind(afterA, ['hotspot']);
  const peakAfterA = byKind(afterA, ['collectivePeak', 'collectiveConnector']);

  assert.strictEqual(pathAfterA.length, pathBeforeA.length, 'A: path layer count unchanged');
  assert.ok(pathBeforeA.every(l => pathAfterA.includes(l)), 'A: every path layer instance survives untouched');
  assert.strictEqual(hotspotAfterA.length, hotspotBeforeA.length, 'A: hotspot layer count unchanged');
  assert.ok(hotspotBeforeA.every(l => hotspotAfterA.includes(l)), 'A: every hotspot layer instance survives untouched');

  assert.ok(peakBeforeA.every(l => !peakAfterA.includes(l)), 'A: old peak/connector layer instances are replaced, not reused');
  peakBeforeA.forEach(l => assert.ok(!map.hasLayer(l), 'A: old peak/connector layer removed from the map'));
  peakAfterA.forEach(l => assert.ok(map.hasLayer(l), 'A: new peak/connector layer is on the map via the track group'));

  assert.deepStrictEqual(trackB.layerGroup.getLayers(), beforeB,
    'B: an unrelated track\'s layers must be completely untouched by a refresh scoped to A');

  assert.strictEqual(map._groups.size, 2, 'still exactly two on-map layerGroups (A + B)');
  assert.strictEqual(afterA.length, pathAfterA.length + hotspotAfterA.length + peakAfterA.length,
    'A: group contains only path+hotspot+peak/connector layers — nothing orphaned or duplicated');
});

test('refreshCollectivePeakMarkers: falls back to a full collective rebuild when the track has no layerGroup', async () => {
  const { window, map, mapManager } = bootWithRecordingL();
  const trackA = addTrack(window, 'A', 'a.csv', SAMPLE_CSV);
  window.AppState.viewMode = 'collective';
  // Never rendered — trackA.layerGroup is still null.
  assert.strictEqual(trackA.layerGroup, null, 'precondition: track has not been rendered yet');

  mapManager.refreshCollectivePeakMarkers(trackA, 0);
  // refreshCollectivePeakMarkers's fallback goes through the real, debounced
  // GSRUI.updateCollectiveMap() (150ms) — same entry point every other
  // collective-mode trigger uses.
  await new Promise(resolve => setTimeout(resolve, 250));

  assert.ok(trackA.layerGroup, 'fallback should have rendered the track, giving it a layerGroup');
  const kinds = trackA.layerGroup.getLayers().map(l => l._gsrKind);
  assert.ok(kinds.includes('collectivePath'), 'fallback full rebuild still renders the path');
  assert.ok(kinds.includes('collectivePeak'), 'fallback full rebuild still renders peaks');
  assert.ok(kinds.includes('hotspot'), 'fallback full rebuild still renders hotspots');
});

test('updatePeakLabel (ui.js) in collective mode: commits via refreshCollectivePeakMarkers, not a full rebuild', () => {
  const { window, map, mapManager } = bootWithRecordingL();
  const trackA = addTrack(window, 'A', 'a.csv', SAMPLE_CSV);
  const trackB = addTrack(window, 'B', 'b.csv', SAMPLE_CSV);
  window.AppState.viewMode = 'collective';
  mapManager.renderCollectiveData(window.AppState.collectiveManager, { showShadedSurface: false }, 0);

  const pathBeforeA = trackA.layerGroup.getLayers().filter(l => l._gsrKind === 'collectivePath');
  const hotspotBeforeA = trackA.layerGroup.getLayers().filter(l => l._gsrKind === 'hotspot');
  const beforeB = trackB.layerGroup.getLayers().slice();

  window.GSRUI.updatePeakLabel(0, 'Committed label', 'A');

  assert.strictEqual(trackA.analyzer.peaks[0].label, 'Committed label', 'label was actually committed');

  const pathAfterA = trackA.layerGroup.getLayers().filter(l => l._gsrKind === 'collectivePath');
  const hotspotAfterA = trackA.layerGroup.getLayers().filter(l => l._gsrKind === 'hotspot');
  assert.deepStrictEqual(pathAfterA, pathBeforeA, 'committing a label through the real ui.js path must not rebuild A\'s path layers');
  assert.deepStrictEqual(hotspotAfterA, hotspotBeforeA, 'committing a label through the real ui.js path must not rebuild A\'s hotspot layers');
  assert.deepStrictEqual(trackB.layerGroup.getLayers(), beforeB, 'track B must be completely untouched');
});

test('_refreshTrackLayers helper: correctly strips target kind layers and dispatches renderFn', () => {
  const { window, mapManager } = bootWithRecordingL();
  const track = addTrack(window, 'A', 'a.csv', SAMPLE_CSV);
  mapManager.renderData(track.analyzer, { trackWeight: 5, peakLatency: 0 });

  const initialPeaks = track.layerGroup.getLayers().filter(l => l._gsrKind === 'peak');
  assert.ok(initialPeaks.length > 0);

  let rendered = false;
  mapManager._refreshTrackLayers(track, new Set(['peak']), () => {
    rendered = true;
  });

  assert.strictEqual(rendered, true);
  const remainingPeaks = track.layerGroup.getLayers().filter(l => l._gsrKind === 'peak');
  assert.strictEqual(remainingPeaks.length, 0, 'peak layers were stripped before renderFn');
});
