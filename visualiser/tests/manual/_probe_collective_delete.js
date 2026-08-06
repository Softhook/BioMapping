'use strict';
// Temporary probe: reproduce "in collective view I removed all the tracks and
// all the peaks and hotspots were left behind." Renders collective with N
// tracks, then deletes tracks one by one (deleteTrack) and after each deletion
// reports what render layers remain ON the map and in the manager registries.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { bootApp } = require('../support/boot_app.js');

const { window, context } = bootApp();
vm.runInContext('RFFluidRenderer = undefined; GSRSpatialClustering = undefined;', context);
window.HTMLCanvasElement.prototype.getContext = () => ({ fillStyle: '', fillRect() {} });
window.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,AA==';

// ── Recording Leaflet (mirrors tests/test_map_layer_ownership.js) ──────────
function installRecordingLeaflet() {
  const RENDER_KINDS = ['path', 'peak', 'connector', 'hotspot', 'collectivePath', 'collectivePeak', 'collectiveConnector'];
  const map = {
    _layers: new Map(), _direct: [], _groups: new Map(), _viaGroup: new Set(), _nextId: 1,
    addLayer(l) { if (!l || typeof l !== 'object') return map; if (l._gsrId === undefined) l._gsrId = map._nextId++; map._layers.set(l._gsrId, l); if (l._isGroup) { map._groups.set(l._gsrId, l); l._onMap = true; l._children.forEach(c => map._viaGroup.add(c)); } else map._direct.push(l); return map; },
    removeLayer(l) { if (!l || l._gsrId === undefined) return map; if (l._isGroup) { map._groups.delete(l._gsrId); map._layers.delete(l._gsrId); l._onMap = false; l._children.forEach(c => map._viaGroup.delete(c)); } else { const i = map._direct.indexOf(l); if (i >= 0) map._direct.splice(i, 1); map._layers.delete(l._gsrId); map._viaGroup.delete(l); for (const g of map._groups.values()) if (g.hasLayer(l)) g._children.delete(l._gsrId); } return map; },
    hasLayer(l) { if (!l || l._gsrId === undefined) return false; if (l._isGroup) return map._groups.has(l._gsrId); return map._direct.includes(l) || map._viaGroup.has(l); },
    latLngToLayerPoint() { return { x: 10, y: 20 }; },
    fitBounds() {}, setView() { return map; },
    getBounds() { return { pad: () => ({ getNorthWest: () => ({ lat: 0, lon: 0 }), getSouthEast: () => ({ lat: 0, lon: 0 }) }) }; },
    getSize() { return { x: 800, y: 600 }; },
    on() {}, remove() {},
    renderKindsOnMap() {
      return [...map._direct, ...map._viaGroup].filter(l => RENDER_KINDS.includes(l._gsrKind)).map(l => l._gsrKind);
    },
    directRenderKinds() {
      return map._direct.filter(l => RENDER_KINDS.includes(l._gsrKind)).map(l => l._gsrKind);
    }
  };
  function makeLayer(kind) {
    return { _gsrId: map._nextId++, _isGroup: false, _gsrKind: kind || 'layer', _gsrLayerGroup: null,
      addTo(m) { m.addLayer(this); return this; }, remove() { map.removeLayer(this); return this; },
      bindPopup() { return this; }, bindTooltip() { return this; }, setZIndexOffset() { return this; },
      setOpacity() { return this; }, setLatLng() { return this; }, on() { return this; }, openPopup() { return this; } };
  }
  function makeGroup() {
    return { _gsrId: map._nextId++, _isGroup: true, _children: new Map(), _onMap: false,
      addLayer(c) { this._children.set(c._gsrId, c); if (this._onMap) map._viaGroup.add(c); return this; },
      removeLayer(c) { this._children.delete(c._gsrId); if (this._onMap) map._viaGroup.delete(c); return this; },
      hasLayer(c) { return this._children.has(c._gsrId); }, addTo(m) { m.addLayer(this); return this; },
      remove() { map.removeLayer(this); return this; },
      getLayers() { return [...this._children.values()]; }, eachLayer(fn) { this._children.forEach(fn); } };
  }
  class FakeControl { constructor(o) { this.options = o || {}; } _onAdd() { return window.document.createElement('div'); } addTo(m) { m.addLayer(this); this._container = this._onAdd(); return this; } getContainer() { return this._container; } }
  FakeControl.extend = (proto) => { class C extends FakeControl {} Object.keys(proto).forEach(k => { C.prototype[k] = proto[k]; }); return C; };
  const L = {
    map: () => map, layerGroup: makeGroup,
    polyline: (ll, o) => { const l = makeLayer('path'); l._latlngs = ll; l._options = o; return l; },
    polygon: (ll, o) => { const l = makeLayer('cluster'); l._latlngs = ll; l._options = o; return l; },
    marker: (ll, o) => { const l = makeLayer('marker'); l._latlng = ll; l._options = o; return l; },
    tileLayer: () => makeLayer('tile'),
    imageOverlay: (u, b, o) => { const l = makeLayer('surface'); l._url = u; l._bounds = b; l._options = o; return l; },
    featureGroup: function (layers) { const g = makeGroup(); (layers || []).forEach(l => g.addLayer(l)); g.getBounds = () => ({ getNorthWest: () => ({ lat: 0, lon: 0 }), getSouthEast: () => ({ lat: 0, lon: 0 }) }); return g; },
    divIcon: (o) => o || {}, icon: (o) => o || {},
    DomUtil: { create: (t, c) => { const el = window.document.createElement(t); if (c) el.className = c; return el; }, setTransform() {} },
    Control: FakeControl
  };
  window.L = L;
  return { L, map };
}
const { map } = installRecordingLeaflet();
window.setup();

function rampRaw(from, to, steps) {
  const out = [];
  for (let i = 1; i <= steps; i++) out.push(Math.round(from + (to - from) * i / steps));
  return out;
}
const GSR_RAW = [
  ...Array(8).fill(10000),
  ...rampRaw(10000, 14000, 15),
  14000,
  ...rampRaw(14000, 12000, 10),
  ...rampRaw(12000, 10000, 10),
  ...Array(8).fill(10000)
];
function csvFor(offset) {
  return [
    'timestamp,lat,lon,hdop,pdop,sats,fix_type,speed_kts,course_deg,gsr_raw,hacc_m',
    ...GSR_RAW.map((g, i) => {
      const t = (i * 0.1).toFixed(2);
      const lat = (51.5074 + offset + i * 0.0001).toFixed(6);
      const lon = (-0.1278 + i * 0.0001).toFixed(6);
      return `${t},${lat},${lon},1.0,1.5,8,3,0.5,90,${g},3.0`;
    })
  ].join('\n');
}

function addTrack(id, name, offset) {
  const analyzer = new window.GSRAnalyzer();
  analyzer.parseCSV(csvFor(offset));
  const track = window.GSRTrackManager.createTrackObject(id, name, '#ff0000', analyzer);
  analyzer.analyze(track.filterParams, 0);
  window.AppState.collectiveManager.addTrack(track);
  return track;
}

function countMapLayers() {
  const counts = {};
  for (const l of map.renderKindsOnMap()) counts[l] = (counts[l] || 0) + 1;
  return counts;
}

const A = addTrack('A', 'A.csv', 0);
const B = addTrack('B', 'B.csv', 0.01);
const C = addTrack('C', 'C.csv', 0.02);

window.AppState.activeTrackId = 'A';
window.AppState.viewMode = 'collective';

const mm = window.AppState.mapManager;

console.log('\n== render collective with 3 tracks (peaks ON) ==');
mm.renderCollectiveData(window.AppState.collectiveManager, { showShadedSurface: false }, 0);
console.log('on-map render layers:', JSON.stringify(countMapLayers()));
console.log('groups on map:', map._groups.size, '| manager tracks:', window.AppState.collectiveManager.tracks.length);

console.log('\n-- delete B (middle track) --');
window.GSRTrackManager.deleteTrack('B');
console.log('on-map render layers:', JSON.stringify(countMapLayers()));
console.log('groups on map:', map._groups.size, '| manager tracks:', window.AppState.collectiveManager.tracks.length);

console.log('\n-- delete C --');
window.GSRTrackManager.deleteTrack('C');
console.log('on-map render layers:', JSON.stringify(countMapLayers()));
console.log('groups on map:', map._groups.size, '| manager tracks:', window.AppState.collectiveManager.tracks.length);

console.log('\n-- delete A (last track) --');
window.GSRTrackManager.deleteTrack('A');
console.log('on-map render layers:', JSON.stringify(countMapLayers()));
console.log('groups on map:', map._groups.size, '| manager tracks:', window.AppState.collectiveManager.tracks.length);
console.log('direct render kinds (bypassing groups):', JSON.stringify(map.directRenderKinds()));
console.log('_renderedTrackGroups size:', window.AppState.mapManager._renderedTrackGroups.size);
console.log('_unownedLayers length:', window.AppState.mapManager._unownedLayers.length);

// ── Scenario 2: markers hidden when rendered, then toggled on ───────────────
// Real tracks have many peaks/hotspots. If the user has Peaks/Hotspots toggled
// OFF when the collective render runs, the markers are created but NOT added to
// the group (and get no _gsrLayerGroup). Toggling them ON later uses the legacy
// direct-to-map path — so removing the track (which removes only its group)
// could leave them behind. Reproduce that.
console.log('\n\n== SCENARIO 2: render with peaks/hotspots OFF, toggle ON, then delete ==');
const A2 = addTrack('A2', 'A2.csv', 0);
const B2 = addTrack('B2', 'B2.csv', 0.01);
window.AppState.activeTrackId = 'A2';

mm.showPeaks = false;
mm.showHotspots = false;
mm.showLabels = false;
mm.renderCollectiveData(window.AppState.collectiveManager, { showShadedSurface: false }, 0);
console.log('after render (toggles off): on-map=', JSON.stringify(countMapLayers()), 'groups=', map._groups.size);
console.log('  _unownedLayers:', mm._unownedLayers.length, '| direct kinds:', JSON.stringify(map.directRenderKinds()));

// Toggle peaks + hotspots ON — this is where hidden markers should move into groups.
mm.showPeaks = true;
mm.showHotspots = true;
mm.updateMarkerVisibility();
console.log('after toggles ON: on-map=', JSON.stringify(countMapLayers()), 'groups=', map._groups.size);
console.log('  _unownedLayers:', mm._unownedLayers.length, '| direct kinds:', JSON.stringify(map.directRenderKinds()));

console.log('\n-- delete A2 --');
window.GSRTrackManager.deleteTrack('A2');
console.log('after delete A2: on-map=', JSON.stringify(countMapLayers()), 'groups=', map._groups.size);
console.log('  direct kinds:', JSON.stringify(map.directRenderKinds()));

console.log('\n-- delete B2 (last) --');
window.GSRTrackManager.deleteTrack('B2');
console.log('after delete B2: on-map=', JSON.stringify(countMapLayers()), 'groups=', map._groups.size);
console.log('  direct kinds:', JSON.stringify(map.directRenderKinds()));
