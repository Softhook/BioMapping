/**
 * Central application state — single source of truth for all shared globals.
 * Replaces the ~25 module-level variables previously scattered across
 * sketch.js, ui.js, and renderer.js.
 *
 * All files access state through `AppState.xxx` instead of bare globals.
 */

/**
 * Cross-browser Fullscreen API helpers.
 * Handles unprefixed, webkit (Safari <16), and moz (Firefox <64).
 */
const Fullscreen = {
  get active() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement);
  },
  request(el) {
    const fn = el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen;
    if (fn) return fn.call(el).catch(function () {});  // swallow permission denials
    return null;
  },
  exit() {
    const fn = document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen;
    if (fn) return fn.call(document).catch(function () {});
    return null;
  },
  onChange(fn) {
    document.addEventListener('fullscreenchange', fn);
    document.addEventListener('webkitfullscreenchange', fn);
    document.addEventListener('mozfullscreenchange', fn);
  }
};

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
  viewStartTime: 0.0,
  viewDuration: 120.0,
  zoomFactor: 1.0,

  // ── Curve visibility toggles ────────────────────────────────────────────────
  showRaw: true,
  showFiltered: true,
  showTonic: true,
  showPeaks: true,

  // ── Interaction state ──────────────────────────────────────────────────────
  isDragging: false,
  isMapFullscreen: false,
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
  dropZone: null
};
