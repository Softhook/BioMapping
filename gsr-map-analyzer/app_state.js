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

  // ── Track colour palette ───────────────────────────────────────────────────
  trackColors: [
    '#0ea5e9', // Sky blue
    '#10b981', // Emerald green
    '#f43f5e', // Rose red
    '#a855f7', // Purple
    '#f59e0b', // Amber yellow
    '#ec4899', // Pink
    '#14b8a6', // Teal
    '#f97316'  // Orange
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

  MIN_ZOOM: 1.0,
  MAX_ZOOM: 50.0,

  // ── Graph layout constants ──────────────────────────────────────────────────
  margin: {
    top: 30,
    bottom: 50,
    left: 70,
    right: 35,
    gap: 40   // gap between Upper and Lower graphs
  },

  // ── Curve visibility toggles ────────────────────────────────────────────────
  showRaw: true,
  showFiltered: true,
  showTonic: true,
  showPeaks: true,

  // ── Interaction state ──────────────────────────────────────────────────────
  isDragging: false,
  isMapFullscreen: false,
  dragStartMouseX: 0,
  dragStartViewStart: 0,
  hoveredIndex: -1,
  activePeakIndex: -1,

  // ── DOM element cache (populated by cacheDOMElements) ──────────────────────
  sliders: {},
  statFields: {},
  tableBody: null,

  fileInput: null,
  dropZone: null,
  fileInfoBox: null,
  loadedFileName: null,
  loadedFileMeta: null,
  clearFileBtn: null
};
