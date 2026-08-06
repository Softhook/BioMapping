'use strict';
// Temporary probe: reproduce "many real tracks open → repeated error, ~track 17".
// Loads REAL track CSVs from ../tracks through the real loadFilesSequentially
// pipeline, then runs the per-frame draw() for each active track, capturing the
// first thrown error + stack. Real tracks carry RF columns / em_fog / many peaks
// that the synthetic fixtures don't.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { bootApp } = require('../support/boot_app.js');

const { window, context } = bootApp();
vm.runInContext('RFFluidRenderer = undefined; GSRSpatialClustering = undefined;', context);
window.HTMLCanvasElement.prototype.getContext = () => ({ fillStyle: '', fillRect() {} });
window.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,AA==';
window.width = 800;
window.height = 600;
// draw() calls p5's drawingContext for dashed lines.
window.drawingContext = { setLineDash() {} };
// Extra p5 drawing globals drawPeakMarkers etc. use but bootApp doesn't stub.
['circle', 'ellipse', 'arc', 'point', 'textStyle', 'textSize', 'textFont', 'textWidth',
 'rectMode', 'ellipseMode', 'strokeCap', 'strokeJoin', 'bezier', 'quadraticVertex', 'curveDetail', 'roundRect'
].forEach(fn => { window[fn] = window[fn] || function () {}; });
['BOLD', 'NORMAL', 'ITALIC', 'LIGHT'].forEach(c => { window[c] = window[c] || c; });
['millis', 'noCursor', 'cursor', 'textLeading', 'textDescent', 'textAscent'].forEach(fn => { window[fn] = window[fn] || (() => 0); });
['mouseX', 'mouseY', 'pmouseX', 'pmouseY', 'frameCount', 'movedX', 'movedY', 'deltaTime'].forEach(v => { if (window[v] === undefined) window[v] = 0; });

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
    on() {}, remove() {}
  };
  function makeLayer(kind) { return { _gsrId: map._nextId++, _isGroup: false, _gsrKind: kind || 'layer', _gsrLayerGroup: null, addTo(m) { m.addLayer(this); return this; }, remove() { map.removeLayer(this); return this; }, bindPopup() { return this; }, bindTooltip() { return this; }, setZIndexOffset() { return this; }, setOpacity() { return this; }, on() { return this; }, openPopup() { return this; } }; }
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
    divIcon: (o) => o || {}, icon: (o) => o || {},
    DomUtil: { create: (t, c) => { const el = window.document.createElement(t); if (c) el.className = c; return el; }, setTransform() {} },
    Control: FakeControl
  };
  window.L = L;
}
installRecordingLeaflet();
window.setup();

window.FileReader = class {
  readAsText(file) {
    setTimeout(() => {
      this.result = file._text;
      if (this.onload) this.onload({ target: this });
    }, 0);
  }
};

// Load the first N real tracks from ../tracks (repo root).
const trackFiles = fs.readdirSync(path.join(__dirname, '..', '..', '..', 'tracks'))
  .filter(f => /^biomap_\d+\.csv$/.test(f))
  .sort()
  .slice(0, 20)
  .map(name => ({ name, _text: fs.readFileSync(path.join(__dirname, '..', '..', '..', 'tracks', name), 'utf8') }));

console.log(`Loading ${trackFiles.length} real tracks...`);
window.GSRTrackManager.loadFilesSequentially(trackFiles);

const errors = [];
window.addEventListener('error', (e) => {
  errors.push((e.error && e.error.stack) || e.message || String(e));
});

const start = Date.now();
const check = () => {
  const n = window.AppState.collectiveManager.tracks.length;
  if (n >= trackFiles.length) {
    console.log(`\n== ${n} real tracks loaded in ${Date.now() - start}ms; load errors: ${errors.length} ==`);
    if (errors.length) {
      const counts = {};
      errors.forEach(e => { const k = e.split('\n')[0]; counts[k] = (counts[k] || 0) + 1; });
      Object.entries(counts).forEach(([msg, c]) => console.log(`\nload x${c}  ${msg}`));
    }

    // Now the user's exact repro: click each track in the track list (single
    // mode), then let the p5 draw loop run for ~1s, capturing window.onerror
    // (which is what fires the red toast burst).
    console.log('\n-- click track -> draw loop (simulated p5 frames) --');
    window.AppState.viewMode = 'single';
    window.GSRTrackManager.renderTrackList();
    for (let i = 0; i < n; i++) {
      const track = window.AppState.collectiveManager.tracks[i];
      // Real DOM click path: find the track item's .track-details and click it.
      const li = window.document.querySelector(`li[data-track-id="${track.id}"] .track-details`);
      if (li) li.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      else window.GSRTrackManager.switchActiveTrack(track.id);

      const frameErrors = [];
      const before = errors.length;
      for (let f = 0; f < 40; f++) {
        try { window.draw(); } catch (e) { frameErrors.push(e.message); }
      }
      const newErrors = errors.slice(before);
      if (newErrors.length === 0 && frameErrors.length === 0) {
        console.log(`OK   track ${i + 1} (${track.name})`);
      } else {
        console.log(`FAIL track ${i + 1} (${track.name}): ${newErrors.length} onerror + ${frameErrors.length} draw-throws`);
        if (frameErrors.length) console.log(`     draw-err: ${frameErrors[0]}`);
        if (newErrors.length) console.log(`     onerror: ${newErrors[0].split('\n')[0]}`);
      }
    }
    return;
  }
  if (Date.now() - start > 60000) {
    console.log(`timed out with ${n}/${trackFiles.length} tracks; errors=${errors.length}`);
    return;
  }
  setTimeout(check, 25);
};
check();
