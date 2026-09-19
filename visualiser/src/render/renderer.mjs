export {
  EXCLUDE_BTN,
  EXCLUDED_STYLE,
  getQualityColor,
  getQualityLabel,
  NORMAL_DASH,
  PARK_EDGE_TOLERANCE_M,
} from './renderer_constants.mjs';

import { RendererBands } from './renderer_bands.mjs';
import { RendererChrome } from './renderer_chrome.mjs';
import { RendererCurve } from './renderer_curve.mjs';
import { RendererInteraction } from './renderer_interaction.mjs';
import { RendererMarkers } from './renderer_markers.mjs';

export const GSRRenderer = {
  ...RendererBands,
  ...RendererChrome,
  ...RendererCurve,
  ...RendererInteraction,
  ...RendererMarkers,
  _styleCache: null,
  PARK_EDGE_TOLERANCE_M: 15,
  _bandCache: {
    osm: { analyzer: null, dataVersion: null, segments: null },
    ndvi: { analyzer: null, dataVersion: null, segments: null, range: null },
    emFog: { analyzer: null, dataVersion: null, segments: null, range: null },
  },
  _pulseRingEls: new Map(),

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
};
