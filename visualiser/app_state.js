/**
 * Central application state — single source of truth for all shared globals.
 * Replaces the ~25 module-level variables previously scattered across
 * sketch.js, ui.js, and renderer.js.
 *
 * All files access state through `AppState.xxx` instead of bare globals.
 */

const AppState = {

  // ── Core engine instances ──────────────────────────────────────────────────
  analyzer: null,           // GSRAnalyzer (current active track)
  collectiveManager: null,  // GSRCollectiveManager
  mapManager: null,          // GSRMapManager (Leaflet controller)

  // ── Track library ───────────────────────────────────────────────────────────
  activeTrackId: null,
  viewMode: 'single',       // 'single' | 'collective'

  // ── Track colour palette (Classic primary-inspired Swiss palette) ───────────
  trackColors: [
    '#005bc4', // Classic blue
    '#d10024', // Classic red
    '#008f3c', // Rich green
    '#7b00cc', // Deep purple
    '#e59e00', // Amber yellow
    '#cc0088', // Magenta pink
    '#0099aa', // Teal
    '#e56a00'  // Dark orange
  ],
  trackColorIndex: 0,

  getNextTrackColor() {
    const c = AppState.trackColors[AppState.trackColorIndex];
    AppState.trackColorIndex = (AppState.trackColorIndex + 1) % AppState.trackColors.length;
    return c;
  },

  // ── p5.js canvas ──────────────────────────────────────────────────────────
  myCanvas: null,

  // ── Timeline / viewport ────────────────────────────────────────────────────
  yTimelineTop: 0,
  yTimelineBottom: 0,
  yGraphBottom: 0,
  isDraggingTimeline: false,

  totalDuration: 120.0,
  
  _viewStartTime: 0.0,
  get viewStartTime() {
    return this._viewStartTime;
  },
  set viewStartTime(t) {
    if (typeof t !== 'number' || isNaN(t)) return;
    this._viewStartTime = Math.max(0.0, Math.min(t, this.totalDuration));
  },

  _viewDuration: 120.0,
  get viewDuration() {
    return this._viewDuration;
  },
  set viewDuration(d) {
    if (typeof d !== 'number' || isNaN(d)) return;
    const minDur = (typeof GSR_CONST !== 'undefined') ? GSR_CONST.ZOOM_MIN_DURATION : 2.0;
    this._viewDuration = Math.max(minDur, Math.min(d, this.totalDuration));
  },

  _zoomFactor: 1.0,
  get zoomFactor() {
    return this._zoomFactor;
  },
  set zoomFactor(z) {
    if (typeof z !== 'number' || isNaN(z)) return;
    const minZ = (typeof GSR_CONST !== 'undefined') ? GSR_CONST.ZOOM_MIN : 1.0;
    const maxZ = (typeof GSR_CONST !== 'undefined') ? GSR_CONST.ZOOM_MAX : 50.0;
    this._zoomFactor = Math.max(minZ, Math.min(maxZ, z));
  },

  // ── Curve visibility toggles ────────────────────────────────────────────────
  showRaw: true,
  showFiltered: true,
  showTonic: true,
  showPeaks: true,
  showHotspots: true, // "Hotspots" = analyzer.memorableEvents, drawn via drawHotspotMarkers()

  // ── Lower graph metric selector ─────────────────────────────────────────────
  // 'phasic' | 'peakDensity' | 'phasicAUC' | 'arousalIndex' — see
  // GSR_CONST.LOWER_GRAPH_MODES for display config of each option.
  lowerGraphMode: 'phasic',

  // ── Interaction state ──────────────────────────────────────────────────────
  isDragging: false,
  isMapFullscreen: false,
  isGsrCollapsed: false,
  isBrowserFullscreen: false,
  dragStartMouseX: 0,
  dragStartViewStart: 0,
  hoveredIndex: -1,
  activePeakIndex: -1,
  mouseOverCanvas: true,

  // ── DOM element cache (populated by cacheDOMElements) ──────────────────────
  sliders: {},
  statFields: {},
  tableBody: null,

  fileInput: null,
  dropZone: null,

  // ── Minimal event notification (Phase 3 pilot, see
  // docs/visualizer_architecture_refactor_plan.md) ───────────────────────────
  // A handful of named events, not a generic pub-sub library: plain
  // array-of-listeners per event name. Lets a mutation point (e.g.
  // deleteTrack) announce what happened once instead of every caller having
  // to remember every downstream consumer to notify by hand.
  _listeners: {},
  on(event, fn) {
    (AppState._listeners[event] = AppState._listeners[event] || []).push(fn);
  },
  emit(event, ...args) {
    (AppState._listeners[event] || []).forEach(fn => fn(...args));
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { AppState };
}
if (typeof window !== 'undefined') {
  window.AppState = AppState;
}
