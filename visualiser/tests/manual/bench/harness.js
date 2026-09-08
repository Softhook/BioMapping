'use strict';
/**
 * Shared toolkit for the track-parametrised benchmark runner (bench/run.js).
 *
 * Everything track-specific flows through here: the list of real CSVs, the
 * curated size buckets, the CLI parser, one bootApp() + recording-Leaflet
 * context that every area shares, and the table printer. Areas
 * (bench/areas.js) never touch fs / jsdom / process.argv directly.
 *
 * The recording Leaflet mock is the faithful-ownership one from
 * tests/test_map_layer_ownership.js, plus the coordinate math + pane/zoom
 * stubs _bench_all_perf_areas.js added (label placement and marker geometry
 * need real relative pixel positions). It models add/remove/hasLayer with
 * Maps/Arrays, not real DOM — so pure-compute numbers are faithful and
 * anything that builds map layers understates a real browser (same caveat
 * every bench in this directory carries).
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { bootApp } = require('../../support/boot_app.js');

const TRACKS_DIR = path.join(__dirname, '..', '..', '..', '..', 'tracks');

// ── stats + timing ──────────────────────────────────────────────────────────
function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function percentile(nums, p) {
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
function timeMs(fn) {
  const t0 = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - t0) / 1e6;
}
/**
 * Run `fn` warmup+iters times, discard warmup (JIT / inline-cache settling),
 * return { median, mean, min, max, p95, n }. `iters`/`warmup` are overridable
 * per call so a 300ms area can run 4 iters while a 0.1ms one runs 200.
 */
function bench(fn, { warmup = 3, iters = 15 } = {}) {
  for (let i = 0; i < warmup; i++) fn();
  const samples = [];
  for (let i = 0; i < iters; i++) samples.push(timeMs(fn));
  return {
    median: median(samples),
    mean: samples.reduce((a, b) => a + b, 0) / samples.length,
    min: Math.min(...samples),
    max: Math.max(...samples),
    p95: percentile(samples, 95),
    n: iters,
  };
}

// ── track catalogue ─────────────────────────────────────────────────────────
/** Every biomap_*.csv / *.csv currently on disk (non-empty), basenames. */
function listTracks() {
  return fs.readdirSync(TRACKS_DIR)
    .filter(f => f.endsWith('.csv'))
    .filter(f => {
      try { return fs.statSync(path.join(TRACKS_DIR, f)).size > 512; } catch { return false; }
    })
    .sort();
}

/**
 * Curated buckets. Chosen from a one-off scan of raw-row / peak / cluster
 * counts (they differ a LOT between walks — see the audit): a short indoor
 * clip vs a 40k-row / 900-peak city loop stress the same code paths by
 * 10-40x. `default` is a deliberate spread so one run shows the shape of
 * the curve without loading all 70 files.
 */
const TRACK_SETS = {
  tiny:    ['biomap_048.csv'],                                   // ~5.9k rows, 140 peaks
  small:   ['biomap_113.csv'],                                   // ~11k rows, 332 peaks, 13 clusters
  medium:  ['biomap_015.csv', 'Newhaven.csv'],                   // ~14-15k rows
  large:   ['biomap_016.csv', 'biomap_059.csv', 'biomap_019.csv'], // 35-41k rows, up to 900 peaks / 19 clusters
  default: ['biomap_048.csv', 'biomap_113.csv', 'biomap_015.csv', 'biomap_016.csv'],
};

/**
 * Resolve a `--tracks` spec into a de-duped, on-disk-verified filename list.
 * Spec = comma-separated set names (tiny/small/medium/large/default) and/or
 * filenames (`biomap_016` or `biomap_016.csv`); `all` = every track on disk.
 * Empty / undefined → `default`.
 */
function resolveTracks(spec) {
  const isDefault = !spec || spec === 'default';
  const raw = (spec || 'default').split(',').map(s => s.trim()).filter(Boolean);
  const onDisk = new Set(listTracks());
  const out = [];
  const add = (f) => { if (!out.includes(f)) out.push(f); };
  for (const tok of raw) {
    if (tok === 'all') { listTracks().forEach(add); continue; }
    if (TRACK_SETS[tok]) { TRACK_SETS[tok].forEach(add); continue; }
    const fn = tok.endsWith('.csv') ? tok : `${tok}.csv`;
    if (onDisk.has(fn)) add(fn);
    else console.warn(`  ! skipping unknown track/set: "${tok}"`);
  }
  return out.length ? out : (isDefault ? [...TRACK_SETS.default] : []);
}

// ── CLI ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { areas: null, tracks: 'default', iters: null, warmup: null, json: false, list: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      args.help = true;
    } else if (a === '--list' || a === '-l') {
      args.list = true;
    } else if (a === '--json') {
      args.json = true;
    } else if (a.startsWith('--tracks=')) {
      args.tracks = a.slice(9);
    } else if (a === '--tracks' && i + 1 < argv.length) {
      args.tracks = argv[++i];
    } else if (a.startsWith('--areas=')) {
      const parsed = a.slice(8).split(',').map(s => s.trim()).filter(Boolean);
      args.areas = (args.areas || []).concat(parsed);
    } else if (a === '--areas' && i + 1 < argv.length) {
      const parsed = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
      args.areas = (args.areas || []).concat(parsed);
    } else if (a.startsWith('--iters=')) {
      args.iters = Math.max(1, parseInt(a.slice(8), 10) || 1);
    } else if (a === '--iters' && i + 1 < argv.length) {
      args.iters = Math.max(1, parseInt(argv[++i], 10) || 1);
    } else if (a.startsWith('--warmup=')) {
      args.warmup = Math.max(0, parseInt(a.slice(9), 10) || 0);
    } else if (a === '--warmup' && i + 1 < argv.length) {
      args.warmup = Math.max(0, parseInt(argv[++i], 10) || 0);
    } else if (!a.startsWith('-')) {
      (args.areas = args.areas || []).push(a); // bare word = area name
    }
  }
  return args;
}

// ── recording Leaflet (faithful ownership model + coordinate math) ───────────
function installRecordingLeaflet(window) {
  const map = {
    _layers: new Map(), _direct: [], _groups: new Map(), _viaGroup: new Set(), _nextId: 1,
    addLayer(layer) {
      if (!layer || typeof layer !== 'object') return map;
      if (layer._gsrId === undefined) layer._gsrId = map._nextId++;
      map._layers.set(layer._gsrId, layer);
      if (layer._isGroup) {
        map._groups.set(layer._gsrId, layer);
        layer._onMap = true;
        layer._children.forEach(c => map._viaGroup.add(c));
      } else { map._direct.push(layer); }
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
        for (const g of map._groups.values()) if (g.hasLayer(layer)) g._children.delete(layer._gsrId);
      }
      return map;
    },
    hasLayer(layer) {
      if (!layer || layer._gsrId === undefined) return false;
      if (layer._isGroup) return map._groups.has(layer._gsrId);
      return map._direct.includes(layer) || map._viaGroup.has(layer);
    },
    // Linear lon/lat -> pixel. Affine, so relative geometry (all label
    // placement / marker collision cares about) is exact regardless of where
    // the track actually is.
    latLngToLayerPoint(ll) {
      const lat = Array.isArray(ll) ? ll[0] : ll.lat;
      const lon = Array.isArray(ll) ? ll[1] : (ll.lng !== undefined ? ll.lng : ll.lon);
      return { x: (lon + 0.15) * 50000, y: (51.6 - lat) * 50000 };
    },
    layerPointToLatLng(pt) { return { lat: 51.6 - pt.y / 50000, lng: pt.x / 50000 - 0.15 }; },
    latLngToContainerPoint(ll) { return map.latLngToLayerPoint(ll); },
    project(ll) { return map.latLngToLayerPoint(ll); },
    unproject(pt) { return map.layerPointToLatLng(pt); },
    fitBounds() {}, setView() { return map; }, panTo() { return map; }, flyTo() { return map; },
    getBounds() {
      return {
        pad: () => ({ getNorthWest: () => ({ lat: 51.6, lon: -0.2 }), getSouthEast: () => ({ lat: 51.4, lon: -0.05 }) }),
        contains: () => true,
      };
    },
    getZoom() { return 14; }, getSize() { return { x: 900, y: 600 }; },
    getPane() { return { appendChild() {} }; }, createPane() { return { style: {}, appendChild() {} }; },
    on() {}, off() {}, remove() {}, invalidateSize() {}, addControl() {}, removeControl() {},
  };

  function makeLayer(kind) {
    return {
      _gsrId: map._nextId++, _isGroup: false, _gsrKind: kind || 'layer', _gsrLayerGroup: null,
      addTo(m) { m.addLayer(this); return this; },
      remove() { map.removeLayer(this); return this; },
      bindPopup() { return this; }, bindTooltip() { return this; }, unbindTooltip() { return this; },
      openPopup() { return this; }, setTooltipContent() { return this; },
      setZIndexOffset() { return this; }, setOpacity() { return this; }, setStyle() { return this; },
      setLatLng() { return this; }, setIcon() { return this; }, getLatLng() { return this._latlng; },
      getLatLngs() { return this._latlngs || []; }, redraw() { return this; },
      on() { return this; }, off() { return this; }, addEventParent() { return this; },
    };
  }
  function makeGroup() {
    return {
      _gsrId: map._nextId++, _isGroup: true, _children: new Map(), _onMap: false,
      addLayer(c) { this._children.set(c._gsrId, c); if (this._onMap) map._viaGroup.add(c); return this; },
      removeLayer(c) { this._children.delete(c._gsrId); if (this._onMap) map._viaGroup.delete(c); return this; },
      hasLayer(c) { return this._children.has(c._gsrId); },
      clearLayers() { this._children.forEach(c => map._viaGroup.delete(c)); this._children.clear(); return this; },
      addTo(m) { m.addLayer(this); return this; },
      remove() { map.removeLayer(this); return this; },
      getLayers() { return [...this._children.values()]; },
      eachLayer(fn) { this._children.forEach(fn); },
    };
  }
  class FakeControl {
    constructor(options) { this.options = options || {}; }
    _onAdd() { return window.document.createElement('div'); }
    addTo(m) { m.addLayer(this); this._container = this._onAdd(); return this; }
    getContainer() { return this._container; }
    getPosition() { return this.options.position; }
  }
  FakeControl.extend = (proto) => { class C extends FakeControl {} Object.keys(proto).forEach(k => { C.prototype[k] = proto[k]; }); return C; };

  window.L = {
    map: () => map,
    layerGroup: makeGroup,
    featureGroup: function (layers) {
      const g = makeGroup();
      (layers || []).forEach(l => g.addLayer(l));
      g.getBounds = () => ({ getNorthWest: () => ({ lat: 0, lon: 0 }), getSouthEast: () => ({ lat: 0, lon: 0 }), isValid: () => true });
      return g;
    },
    latLng: (a, b) => ({ lat: a, lng: b, distanceTo: () => 1 }),
    point: (x, y) => ({ x, y }),
    polyline: (ll, o) => { const l = makeLayer('path'); l._latlngs = ll; l._options = o; return l; },
    polygon: (ll, o) => { const l = makeLayer('polygon'); l._latlngs = ll; l._options = o; return l; },
    marker: (ll, o) => { const l = makeLayer('marker'); l._latlng = ll; l._options = o; return l; },
    circleMarker: (ll, o) => { const l = makeLayer('circleMarker'); l._latlng = ll; l._options = o; return l; },
    circle: (ll, o) => { const l = makeLayer('circle'); l._latlng = ll; l._options = o; return l; },
    tileLayer: () => makeLayer('tile'),
    imageOverlay: (u, b, o) => { const l = makeLayer('surface'); l._url = u; l._bounds = b; l._options = o; return l; },
    divIcon: (o) => o || {}, icon: (o) => o || {},
    DomUtil: { create: (tag, cls) => { const el = window.document.createElement(tag); if (cls) el.className = cls; return el; }, setTransform() {}, setPosition() {}, remove() {}, addClass() {}, removeClass() {} },
    Browser: { any3d: false, mobile: false, retina: false },
    Control: FakeControl,
  };
  return { L: window.L, map };
}

// ── boot context ────────────────────────────────────────────────────────────
/**
 * bootApp() + recording Leaflet + the p5 / canvas globals renderer.js and
 * sketch.js reference as bare identifiers, then window.setup().
 *
 * A FRESH context per area (run.js calls this once per area, not once per
 * process): analyze() mutates its analyzer, renderData() warms mapManager's
 * GPS + arousal caches, generateContourSurface() reads a warm filteredGps —
 * sharing one context across areas silently makes later areas look 3-6x
 * faster than they are (measured). Booting is ~150ms; the per-track analyze()
 * is the real cost and is unavoidable either way.
 */
function boot() {
  const { window, context } = bootApp();

  vm.runInContext('RFFluidRenderer = undefined;', context);
  // p5 "global mode" identifiers renderer.js / sketch.js use bare, beyond what
  // boot_app already stubs (grepped from those two files).
  const p5names = ['circle', 'ellipse', 'triangle', 'arc', 'point', 'quad', 'bezier', 'bezierVertex',
    'quadraticVertex', 'curveVertex', 'curveTightness', 'strokeCap', 'strokeJoin', 'textFont',
    'textWidth', 'textLeading', 'textAscent', 'textDescent', 'rectMode', 'ellipseMode',
    'drawingContext', 'clear', 'translate', 'rotate', 'scale', 'noSmooth', 'smooth', 'cursor', 'noCursor'];
  for (const n of p5names) if (window[n] === undefined) window[n] = () => {};
  window.drawingContext = { setLineDash() {}, canvas: { width: 1200, height: 600 }, measureText: () => ({ width: 10 }) };
  Object.assign(window, { width: 1200, height: 600, mouseX: 500, mouseY: 300, pmouseX: 500, pmouseY: 300,
    winMouseX: 500, winMouseY: 300, movedX: 0, movedY: 0, frameCount: 1, deltaTime: 16, focused: true,
    BOLD: 'bold', NORMAL: 'normal', ITALIC: 'italic', LIGHT: 'light' });
  window.millis = window.millis || (() => 0);
  window.document.elementFromPoint = () => (window.AppState && window.AppState.myCanvas ? window.AppState.myCanvas.elt : null);
  window.HTMLCanvasElement.prototype.getContext = () => ({
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: '', textBaseline: '', globalAlpha: 1,
    fillRect() {}, strokeRect() {}, clearRect() {}, beginPath() {}, closePath() {}, moveTo() {}, lineTo() {},
    arc() {}, ellipse() {}, rect() {}, fill() {}, stroke() {}, save() {}, restore() {}, translate() {}, scale() {},
    rotate() {}, setLineDash() {}, setTransform() {}, resetTransform() {}, fillText() {}, measureText: () => ({ width: 10 }),
    createLinearGradient: () => ({ addColorStop() {} }), createRadialGradient: () => ({ addColorStop() {} }),
    drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(4) }), putImageData() {},
  });
  window.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,AA==';

  installRecordingLeaflet(window);
  window.setup();

  return {
    window, context,
    mapManager: window.AppState.mapManager,
    L: window.L,
    map: window.L.map(),
    GSR_CONST: vm.runInContext('GSR_CONST', context),
    ctxGlobal: (name) => vm.runInContext(name, context),
  };
}

/**
 * parseCSV + analyze + register the track with the collective manager.
 * Returns { id, filename, analyzer, track, rows, peaks }.
 */
function loadTrack(window, filename, id) {
  const analyzer = new window.GSRAnalyzer();
  analyzer.parseCSV(fs.readFileSync(path.join(TRACKS_DIR, filename), 'utf8'));
  const track = window.GSRTrackManager.createTrackObject(id, filename, '#ff5533', analyzer);
  analyzer.analyze(track.filterParams, 0);
  if (!window.AppState.collectiveManager.getTrack(id)) window.AppState.collectiveManager.addTrack(track);
  return {
    id, filename, analyzer, track,
    rows: analyzer.raw.length,
    peaks: analyzer.peaks.filter(p => !p.excluded).length,
  };
}

/**
 * Run the GPS filter pipeline once so `analyzer.filteredGps` exists — every
 * production render path does this before it reads peak coordinates
 * (analyzer.getCoordinates prefers filteredGps over raw), so an area that
 * clusters / places / projects peaks without priming would be working off raw
 * GPS and drift from what the app actually renders. Cheap: one pass, then the
 * mapManager GPS cache holds it. Returns nothing.
 */
function primeGps(mapManager, track, GSR_CONST) {
  const p = JSON.parse(JSON.stringify(GSR_CONST.GPS_DEFAULT));
  mapManager._getOrBuildDrawPoints(track.id, track.analyzer, p);
}

// ── table printer ───────────────────────────────────────────────────────────
function fmt(v) {
  if (v == null) return '-';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2);
  return String(v);
}
/**
 * @param {string} title
 * @param {Array<{key,label}>} columns
 * @param {Array<object>} rows  each row: { track, <colKey>: value }
 */
function printTable(title, columns, rows) {
  const cols = [{ key: 'track', label: 'track' }, ...columns];
  const widths = cols.map(c =>
    Math.max(c.label.length, ...rows.map(r => fmt(r[c.key]).length)));
  const line = (cells) => '  ' + cells.map((s, i) => String(s).padEnd(widths[i])).join('  ');
  console.log(`\n${title}`);
  console.log(line(cols.map(c => c.label)));
  console.log('  ' + widths.map(w => '─'.repeat(w)).join('  '));
  for (const r of rows) console.log(line(cols.map(c => fmt(r[c.key]))));
}

module.exports = {
  TRACKS_DIR, TRACK_SETS,
  listTracks, resolveTracks, parseArgs,
  bench, median, percentile, timeMs,
  boot, loadTrack, primeGps, installRecordingLeaflet,
  printTable, fmt,
};
