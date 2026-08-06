'use strict';
// Temporary probe: does the RF Fluid button desync generalize to ALL map toggle
// buttons? Checks the invariant `button.classList.contains('active')` ⇔ the
// manager's corresponding `showX` state across: initial boot, a single-track
// render, a collective render, and a "data absent" render (the RF fluid case).
const path = require('path');
const vm = require('vm');
const { bootApp } = require('../support/boot_app.js');

const { window, context } = bootApp();
window.HTMLCanvasElement.prototype.getContext = () => ({ fillStyle: '', fillRect() {}, clearRect() {}, resetTransform() {}, scale() {}, setLineDash() {} });
window.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,AA==';

function installRecordingLeaflet() {
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
    getPane() { return window.document.createElement('div'); },
    createPane() { return window.document.createElement('div'); },
    getZoomScale() { return 1; }, getZoom() { return 15; },
    _latLngToNewLayerPoint() { return { x: 0, y: 0 }; }
  };
  function makeLayer(kind) { return { _gsrId: map._nextId++, _isGroup: false, _gsrKind: kind || 'layer', _gsrLayerGroup: null, addTo(m) { m.addLayer(this); return this; }, remove() { map.removeLayer(this); return this; }, bindPopup() { return this; }, bindTooltip() { return this; }, setZIndexOffset() { return this; }, setOpacity() { return this; }, setLatLng() { return this; }, on() { return this; }, openPopup() { return this; } }; }
  function makeGroup() { return { _gsrId: map._nextId++, _isGroup: true, _children: new Map(), _onMap: false, addLayer(c) { this._children.set(c._gsrId, c); if (this._onMap) map._viaGroup.add(c); return this; }, removeLayer(c) { this._children.delete(c._gsrId); if (this._onMap) map._viaGroup.delete(c); return this; }, hasLayer(c) { return this._children.has(c._gsrId); }, addTo(m) { m.addLayer(this); return this; }, remove() { map.removeLayer(this); return this; }, getLayers() { return [...this._children.values()]; }, eachLayer(fn) { this._children.forEach(fn); } }; }
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
    DomUtil: { create: (t, c) => { const el = window.document.createElement(t); if (c) el.className = c; return el; }, setTransform() {}, setPosition() {} },
    Control: FakeControl
  };
  window.L = L;
  return { L, map };
}
installRecordingLeaflet();
window.setup();

const mm = window.AppState.mapManager;

// (buttonId, managerShowXGetter) — map toggle buttons that have a manager-side state.
const MAP_TOGGLES = [
  ['btnToggleMapPeaks',    () => mm.showPeaks],
  ['btnToggleMapHotspots', () => mm.showHotspots],
  ['btnToggleMapLabels',   () => mm.showLabels],
  ['btnToggleMapClusters', () => mm.showClusters],
  ['btnToggleMapIsolines', () => mm.showIsolines],
  ['btnToggleMapSurface',  () => mm.showSurface],
  ['btnToggleMapTracks',   () => mm.showTracks],
  ['btnToggleRFFluid',     () => mm.showRFFluid]
];

let problems = 0;
function check(label) {
  MAP_TOGGLES.forEach(([btnId, getState]) => {
    const btn = window.document.getElementById(btnId);
    const pressed = btn.classList.contains('active');
    const state = !!getState();
    const ok = pressed === state;
    if (!ok) problems++;
    console.log(`  [${ok ? 'OK ' : 'BAD'}] ${label.padEnd(14)} ${btnId.padEnd(22)} pressed=${pressed} state=${state}`);
  });
}

console.log('== Invariant: button.pressed ⇔ manager.showX ==\n');
console.log('— after boot (no data) —');
check('boot');

console.log('\n— user toggles each button (simulate click) —');
MAP_TOGGLES.forEach(([btnId, getState]) => {
  const btn = window.document.getElementById(btnId);
  btn.classList.toggle('active');
  const pressed = btn.classList.contains('active');
  const method = {
    btnToggleMapPeaks: 'togglePeaks', btnToggleMapHotspots: 'toggleHotspots',
    btnToggleMapLabels: 'toggleLabels', btnToggleMapClusters: 'toggleClusters',
    btnToggleMapIsolines: 'toggleIsolines', btnToggleMapSurface: 'toggleSurface',
    btnToggleMapTracks: 'toggleTracks', btnToggleRFFluid: 'toggleRFFluid'
  }[btnId];
  mm[method](pressed);
});

console.log('\n— after single-track render with a track that has NO RF data —');
mm._updateRfFluidButtonState(false); // the no-RF-data path (RF fluid bug trigger)
check('no-RF render');

console.log('\n— after collective render with RF data present (the reported scenario) —');
mm._updateRfFluidButtonState(true);
check('RF render');

console.log('\n— after toggling peaks/hotspots/etc off then re-render —');
mm.togglePeaks(false);
mm.toggleHotspots(false);
mm.toggleLabels(false);
check('peaks/hotspots/labels off');

console.log(`\n== ${problems === 0 ? 'ALL CONSISTENT — RF Fluid was the only desync' : problems + ' DESYNCS FOUND'} ==`);
