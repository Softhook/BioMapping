'use strict';
// Temporary probe: reproduce "single track mode where I couldn't see any of the
// peaks" with REAL track CSVs. Loads all real tracks, then for each track enters
// single mode and counts path/peak/hotspot layers actually ON the map (via the
// recording Leaflet map) and in the manager's registries, plus captured errors.
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
window.drawingContext = { setLineDash() {} };
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
  window.__recordingMap = map;
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

const trackFiles = fs.readdirSync(path.join(__dirname, '..', '..', '..', 'tracks'))
  .filter(f => /^biomap_\d+\.csv$/.test(f))
  .sort()
  .map(name => ({ name, _text: fs.readFileSync(path.join(__dirname, '..', '..', '..', 'tracks', name), 'utf8') }));

console.log(`Loading ${trackFiles.length} real tracks...`);
window.GSRTrackManager.loadFilesSequentially(trackFiles);

const errors = [];
window.addEventListener('error', (e) => {
  errors.push((e.error && e.error.stack) || e.message || String(e));
});
const alerts = [];
window.alert = (m) => { alerts.push(String(m)); };

const start = Date.now();
let lastSeenN = -1;
const check = () => {
  const n = window.AppState.collectiveManager.tracks.length;
  const stalled = n === lastSeenN && lastSeenN >= 0 && lastSeenN < trackFiles.length && (Date.now() - start > 60000);
  if (n >= trackFiles.length || stalled) {
    const loaded = n >= trackFiles.length;
    if (loaded) {
      console.log(`All ${n} loaded.`);
    } else {
      console.log(`\n!! LOADING STALLED at ${n}/${trackFiles.length} tracks (60s) — running per-track checks on what loaded.`);
    }
    const loadedNames = new Set(window.AppState.collectiveManager.tracks.map(t => t.name));
    const missing = trackFiles.map(f => f.name).filter(fn => !loadedNames.has(fn));
    if (missing.length) console.log(`Missing tracks: ${missing.join(', ')}`);
    console.log(`\n== ${n} real tracks loaded in ${Date.now() - start}ms; load errors: ${errors.length} ==`);
    const mm = window.AppState.mapManager;

    console.log('\n-- single-track mode: per-track on-map layer counts --');
    window.AppState.viewMode = 'single';
    window.GSRTrackManager.renderTrackList();
    const peaks = [];   // analyzer peak counts
    const noPeaks = [];
    for (let i = 0; i < n; i++) {
      const track = window.AppState.collectiveManager.tracks[i];
      const li = window.document.querySelector(`li[data-track-id="${track.id}"] .track-details`);
      let clickErr = null;
      try {
        if (li) li.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
        else window.GSRTrackManager.switchActiveTrack(track.id);
      } catch (e) {
        clickErr = e;
      }

      const anal = track.analyzer;
      const nPeaks = anal && anal.peaks ? anal.peaks.length : -1;
      // GPS-fix count (renderData early-returns when drawPoints is empty)
      const raw = anal && anal.raw ? anal.raw : [];
      let nFixes = 0;
      for (const d of raw) if (d._isGpsFix && !isNaN(d.lat) && !isNaN(d.lon)) nFixes++;
      const recMap = window.__recordingMap;

      // Count layers currently visible on the map (via group children on map + direct)
      let paths = 0, peakMarkers = 0, hotspots = 0;
      for (const g of recMap._groups.values()) {
        for (const c of g._children.values()) {
          if (c._gsrKind === 'path' || c._gsrKind === 'collectivePath') paths++;
          else if (c._gsrKind === 'peak' || c._gsrKind === 'collectivePeak') peakMarkers++;
          else if (c._gsrKind === 'hotspot') hotspots++;
        }
      }
      for (const d of recMap._direct) {
        if (d._gsrKind === 'path' || d._gsrKind === 'collectivePath') paths++;
        else if (d._gsrKind === 'peak' || d._gsrKind === 'collectivePeak') peakMarkers++;
        else if (d._gsrKind === 'hotspot') hotspots++;
      }
      const isRf = track.analyzer && track.analyzer.hasRfData;
      const flag = (nPeaks > 0 && peakMarkers === 0) ? '  <-- PEAKS MISSING' : '';
      const errTag = clickErr ? `  clickErr=${String(clickErr.message).split('\n')[0]}` : '';
      if (nPeaks === 0) noPeaks.push(track.name);
      peaks.push({ i: i + 1, name: track.name, nPeaks, peakMarkers, paths, hotspots, isRf: !!isRf });
      console.log(`track ${String(i + 1).padStart(2)} ${track.name.padEnd(16)} peaks=${String(nPeaks).padStart(4)} onMap=${String(peakMarkers).padStart(4)} paths=${String(paths).padStart(4)} hotspot=${String(hotspots).padStart(4)} fixes=${String(nFixes).padStart(5)} rf=${isRf ? 'y' : 'n'}${flag}${errTag}`);
    }

    const missingPeaks = peaks.filter(p => p.nPeaks > 0 && p.peakMarkers === 0);
    console.log(`\nTracks with analyzer peaks but 0 on-map peak markers: ${missingPeaks.length}`);
    missingPeaks.forEach(m => console.log(`  ${m.i}: ${m.name} peaks=${m.nPeaks}`));
    console.log(`Tracks with 0 analyzer peaks: ${noPeaks.length}`);
    if (errors.length) {
      console.log(`\nCaptured ${errors.length} window.onerror:`);
      const counts = {};
      errors.forEach(e => { const k = e.split('\n')[0]; counts[k] = (counts[k] || 0) + 1; });
      Object.entries(counts).forEach(([msg, c]) => console.log(`  x${c}  ${msg}`));
    }
    return;
  }
  if (Date.now() - start > 180000) {
    console.log(`timed out with ${n}/${trackFiles.length} tracks; errors=${errors.length}`);
    return;
  }
  if (lastSeenN !== n) lastSeenN = n;
  setTimeout(check, 25);
};
check();
