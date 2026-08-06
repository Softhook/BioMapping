'use strict';
// Isolate why biomap_009 renders nothing in single mode despite GPS fixes.
// Loads ONE track, clicks it, then calls renderData() directly and compares
// on-map layers + inspects the GPS pipeline intermediate counts.
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

const TARGET = process.argv[2] || 'biomap_009.csv';
const trackFiles = [{ name: TARGET, _text: fs.readFileSync(path.join(__dirname, '..', '..', '..', 'tracks', TARGET), 'utf8') }];
console.log(`Loading ${TARGET}...`);
window.GSRTrackManager.loadFilesSequentially(trackFiles);

const errors = [];
window.addEventListener('error', (e) => { errors.push((e.error && e.error.stack) || e.message || String(e)); });
const alerts = [];
window.alert = (m) => { alerts.push(String(m)); };

function countMap() {
  const recMap = window.__recordingMap;
  let paths = 0, peakMarkers = 0, hotspots = 0;
  for (const g of recMap._groups.values()) for (const c of g._children.values()) {
    if (c._gsrKind === 'path' || c._gsrKind === 'collectivePath') paths++;
    else if (c._gsrKind === 'peak' || c._gsrKind === 'collectivePeak') peakMarkers++;
    else if (c._gsrKind === 'hotspot') hotspots++;
  }
  for (const d of recMap._direct) {
    if (d._gsrKind === 'path' || d._gsrKind === 'collectivePath') paths++;
    else if (d._gsrKind === 'peak' || d._gsrKind === 'collectivePeak') peakMarkers++;
    else if (d._gsrKind === 'hotspot') hotspots++;
  }
  return { paths, peaks: peakMarkers, hotspots };
}

const start = Date.now();
const check = () => {
  const n = window.AppState.collectiveManager.tracks.length;
  if (n >= trackFiles.length) {
    const mm = window.AppState.mapManager;
    const track = window.AppState.collectiveManager.tracks[0];
    const anal = track.analyzer;
    console.log(`Loaded ${track.name}; peaks=${anal.peaks.length}; raw=${anal.raw.length}`);
    let nFixes = 0;
    for (const d of anal.raw) if (d._isGpsFix && !isNaN(d.lat) && !isNaN(d.lon)) nFixes++;
    console.log(`gps fixes (raw): ${nFixes}`);
    console.log(`filteredGps defined: ${!!anal.filteredGps}; length=${anal.filteredGps ? anal.filteredGps.length : 'n/a'}`);
    if (anal.filteredGps) {
      let fFixes = 0;
      for (let i = 0; i < anal.raw.length; i++) {
        const fg = anal.filteredGps[i];
        if (fg && !isNaN(fg.lat) && !isNaN(fg.lon)) fFixes++;
      }
      console.log(`filteredGps non-NaN lat/lon: ${fFixes}`);
    }

    console.log('\n-- after click (switchActiveTrack path) --');
    window.AppState.viewMode = 'single';
    window.GSRTrackManager.renderTrackList();
    const li = window.document.querySelector(`li[data-track-id="${track.id}"] .track-details`);
    if (li) li.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    else window.GSRTrackManager.switchActiveTrack(track.id);
    console.log('activeTrackId =', window.AppState.activeTrackId);
    console.log('map counts after click:', JSON.stringify(countMap()));

    console.log('\n-- direct renderData call --');
    try {
      const gp = window.GSRStorage.buildGpsParams();
      console.log('gpsParams:', JSON.stringify(gp));
      mm.renderData(anal, gp);
      console.log('map counts after direct renderData:', JSON.stringify(countMap()));
      const rl = mm.getRenderLayers();
      console.log('getRenderLayers: paths=%d peakMarkers=%d hotspots=%d', rl.paths.length, rl.peakMarkers.length, rl.hotspots.length);
    } catch (e) {
      console.log('direct renderData threw:', e.stack);
    }

    console.log('\n-- GPS pipeline intermediate --');
    try {
      const res = mm._getOrBuildDrawPoints('iso', anal, window.GSRStorage.buildGpsParams());
      console.log('_getOrBuildDrawPoints: gpsPoints=%d drawPoints=%d', res.gpsPoints.length, res.drawPoints.length);
    } catch (e) {
      console.log('_getOrBuildDrawPoints threw:', e.stack);
    }

    console.log('\n-- peak coordinate resolution (can peaks be placed?) --');
    try {
      const gp = window.GSRStorage.buildGpsParams();
      const peakLatency = gp.peakLatency || 0;
      let resolvable = 0, unresolvable = 0;
      const firstFew = [];
      anal.peaks.forEach((peak, index) => {
        const si = mm._resolveLatencyIndex(anal, peak, peakLatency);
        const coords = anal.getCoordinates(si);
        if (coords && !isNaN(coords.lat) && !isNaN(coords.lon)) {
          resolvable++;
          if (firstFew.length < 3) firstFew.push({ index, lat: coords.lat, lon: coords.lon });
        } else {
          unresolvable++;
        }
      });
      console.log(`peaks resolvable=${resolvable} unresolvable=${unresolvable}`);
      console.log(`sample coords: ${JSON.stringify(firstFew)}`);
    } catch (e) {
      console.log('peak resolution threw:', e.stack);
    }

    console.log('\n-- GPS pipeline stage-by-stage --');
    try {
      const p = window.GSRStorage.buildGpsParams();
      const data = anal.raw;
      let pts = mm._collectGpsPoints(data);
      console.log(`1 _collectGpsPoints: ${pts.length}`);
      const pts0 = pts;
      pts = window.GpsPipeline.applyHdopGate(pts, p.maxHdop || 2.0);
      console.log(`2 applyHdopGate(maxHdop=${p.maxHdop||2.0}): ${pts.length} (dropped ${pts0.length - pts.length})`);
      // breakdown of dropped by hdop value
      const droppedHdop = pts0.filter(d => !(isNaN(d.hdop) || d.hdop <= (p.maxHdop||2.0)));
      const hdopVals = {};
      droppedHdop.forEach(d => { const k = d.hdop == null ? 'null' : d.hdop; hdopVals[k] = (hdopVals[k]||0)+1; });
      console.log(`   hdop-dropped breakdown: ${JSON.stringify(hdopVals)}`);
      const pts1 = pts;
      pts = window.GpsPipeline.applyFixTypeGate(pts);
      console.log(`3 applyFixTypeGate: ${pts.length} (dropped ${pts1.length - pts.length})`);
      const pts2 = pts;
      pts = window.GpsPipeline.applyPreKalmanFilters(pts, p.smoothing||0.5, p.maxSpeed||3.0);
      console.log(`4 applyPreKalmanFilters: ${pts.length} (dropped ${pts2.length - pts.length})`);
      const pts3 = pts;
      if (anal.snappedGps) {
        pts = window.GpsPipeline.applySnapCorrection(pts, anal.snappedGps);
        console.log(`5 applySnapCorrection: ${pts.length}`);
      }
      const pts4 = pts;
      pts = window.GpsFilter.applyKalman(pts, p.smoothing||0.5, p.kalmanR||10);
      console.log(`6 applyKalman: ${pts.length} (dropped ${pts4.length - pts.length})`);
    } catch (e) {
      console.log('stage-by-stage threw:', e.stack);
    }

    if (errors.length) {
      console.log(`\nCaptured ${errors.length} window.onerror:`);
      const counts = {};
      errors.forEach(e => { const k = e.split('\n')[0]; counts[k] = (counts[k] || 0) + 1; });
      Object.entries(counts).forEach(([msg, c]) => console.log(`  x${c}  ${msg}`));
    }
    if (alerts.length) console.log(`alerts: ${alerts.length}`, alerts[0]);
    console.log(`elapsed ${Date.now() - start}ms`);
    return;
  }
  if (Date.now() - start > 60000) { console.log('timed out waiting for load'); return; }
  setTimeout(check, 25);
};
check();
