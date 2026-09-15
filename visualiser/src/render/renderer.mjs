/**
 * Graphics Rendering & Drawing Utilities (p5.js Canvas View).
 * All shared state accessed through AppState.
 */

/**
 * Get peak quality color hex based on quality score.
 * High (≥0.7) → green #008f3c, Medium (≥0.4) → amber #e59e00, Low → red #d10024.
 * If alphaSuffix is provided (e.g. '20'), appends it for RGBA-style hex.
 */
export function getQualityColor(score, alphaSuffix) {
  const base = score >= 0.7 ? '#008f3c' : score >= 0.4 ? '#e59e00' : '#d10024';
  return alphaSuffix ? base + alphaSuffix : base;
}

/**
 * Get peak quality label string ('High', 'Med', 'Low') and percent.
 */
export function getQualityLabel(score) {
  const pct = Math.round(score * 100);
  const label = score >= 0.7 ? 'High' : score >= 0.4 ? 'Med' : 'Low';
  return { pct, label };
}

// Excluded-peak visual style constants
export const EXCLUDED_STYLE = {
  color: '#9a9a9a',
  lineColor: '#b0b0b0',
  lineAlpha: '3c',
  fillAlpha: '1a',
  dash: [2, 4],
  weight: 1.2,
  dotWeight: 1.5,
};

export const NORMAL_DASH = [3, 3];

export const EXCLUDE_BTN = {
  r: 5, // button radius
  offsetY: -8, // Y offset from yBottomU (bottom of upper graph)
  symbol: '\u2715', // ✕ character
};

export const GSRRenderer = {
  _styleCache: null,
  // Boundary-digitising slack for "is this footpath in the park" — see
  // _classifyOsmContext's doc comment.
  PARK_EDGE_TOLERANCE_M: 15,
  // One cache slot per background-band overlay (OSM context, NDVI) —
  // {analyzer, dataVersion, segments, ...} — invalidated the same way for
  // both: a fresh RLE pass only when the analyzer instance or its
  // _dataVersion has changed since the last call. See _getBandSegments.
  _bandCache: {
    osm: { analyzer: null, dataVersion: null, segments: null },
    ndvi: { analyzer: null, dataVersion: null, segments: null, range: null },
    emFog: { analyzer: null, dataVersion: null, segments: null, range: null },
  },

  /**
   * Helper to retrieve CSS variable values from document stylesheet.
   * Caches styles locally during a drawing pass to avoid heavy DOM reads.
   */
  getThemeColor(varName, defaultVal) {
    if (typeof window === 'undefined' || !window.getComputedStyle)
      return defaultVal;
    if (!this._styleCache) {
      this._styleCache = window.getComputedStyle(document.documentElement);
    }
    const val = this._styleCache.getPropertyValue(varName).trim();
    return val || defaultVal;
  },

  /**
   * Clear style cache to force DOM re-evaluation (e.g. on window resize).
   */
  clearThemeCache() {
    this._styleCache = null;
  },

  drawPlaceholder() {
    const bg = this.getThemeColor('--canvas-bg', '#ffffff');
    background(bg);
    this.clearPulseRings();
  },

  // GSRRenderer is completed by object-augment files loaded immediately
  // after this one (see index.html / boot_app.js SCRIPT_ORDER):
  //   renderer_bands.js       — OSM/NDVI/EM-fog background context bands
  //   renderer_curve.js       — signal curve, phasic area, response-dynamics overlay
  //   renderer_markers.js     — peak markers + pulse animation, hotspot markers
  //   renderer_interaction.js — click/hit-testing + graph-scrub hover
  //   renderer_chrome.js      — grid, tooltip, timeline overview
};
