'use strict';
// Temporary probe: reproduce "RF fluid visible in collective mode even when the
// RF Fluid button is not pressed." Traces the sync between the button's
// 'active' class, GSRMapManager.showRFFluid, and the RFFluidRenderer visibility.
const path = require('path');
const vm = require('vm');
const { bootApp } = require('../support/boot_app.js');

const { window, context } = bootApp();
// Keep RFFluidRenderer REAL so we can observe its options.visible; stub only the
// spatial clustering aggregate. Canvas needs a 2d context + map stub.
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
    createPane() { const p = window.document.createElement('div'); return p; },
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

const btn = window.document.getElementById('btnToggleRFFluid');
const mm = window.AppState.mapManager;

function state(label) {
  const r = mm.rfFluidRenderer;
  console.log(`${label.padEnd(46)} btn.active=${btn.classList.contains('active')} disabled=${btn.hasAttribute('disabled')} showRFFluid=${mm.showRFFluid} renderer.visible=${r ? r.options.visible : 'no-renderer'}`);
}

console.log('— initial state (HTML button starts class="... active") —');
state('initial');

// 1. A track WITHOUT RF data gets rendered → _updateRfFluidButtonState(false)
console.log('\n— simulate: render a no-RF track (single mode) → _updateRfFluidButtonState(false) —');
mm._updateRfFluidButtonState(false);
state('after _updateRfFluidButtonState(false)');

// 2. Now switch to collective mode where the active set HAS RF data
console.log('\n— simulate: collective render with an RF track → _updateRfFluidButtonState(true) —');
mm._updateRfFluidButtonState(true);
state('after _updateRfFluidButtonState(true)');

console.log('\n— bug check —');
const fluidRenders = mm.showRFFluid && mm.rfFluidRenderer && mm.rfFluidRenderer.options.visible;
const buttonPressed = btn.classList.contains('active');
console.log(`button pressed? ${buttonPressed} | fluid will render? ${fluidRenders}`);
if (!buttonPressed && fluidRenders) {
  console.log('  ^^ BUG: fluid renders while button shows unpressed (desync)');
} else {
  console.log('  states consistent');
}

// ── Scenario B: user explicitly toggled RF fluid OFF, then no-RF track, then RF track ──
console.log('\n— scenario B: user toggled OFF → no-RF track → RF track —');
mm.toggleRFFluid(false);            // user presses button off
state('after toggleRFFluid(false)');
mm._updateRfFluidButtonState(false); // render a no-RF track
state('after no-RF render');
mm._updateRfFluidButtonState(true);  // collective render with RF track
state('after RF render');
const fluidRendersB = mm.showRFFluid && mm.rfFluidRenderer && mm.rfFluidRenderer.options.visible;
const buttonPressedB = btn.classList.contains('active');
console.log(`button pressed? ${buttonPressedB} | fluid will render? ${fluidRendersB}`);
if (!buttonPressedB && !fluidRendersB) {
  console.log('  OK: user toggled off — fluid stays hidden, button stays unpressed');
} else {
  console.log('  ^^ MISMATCH: expected both off');
}
