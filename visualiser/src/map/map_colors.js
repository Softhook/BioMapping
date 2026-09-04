/**
 * Color scale and LUT helpers for the Bio Mapping GSR analyser map.
 */
const MapColors = {
  _colorLutCache: new Map(),

  ROAD_COLORS: {
    'motorway':       '#ff0055',
    'trunk':          '#ff4400',
    'primary':        '#ff6600',
    'secondary':      '#ffaa00',
    'tertiary':       '#ffd500',
    'residential':    '#0099ff',
    'pedestrian':     '#00ffc4',
    'footway':        '#00e575',
    'path':           '#80e500',
    'cycleway':       '#00ffd5',
    'living_street':  '#9b5de5',
    'service':        '#b8c0ff',
    'track':          '#a0522d',
    'unclassified':   '#8899aa',
    'steps':          '#cc9966'
  },

  getHslColor(ratio, saturation = 100, lightness = 50) {
    const r = Math.max(0, Math.min(1, ratio));
    const hue = (1.0 - r) * 120;
    return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
  },

  /**
   * Convert HSL color values to hex string (#rrggbb).
   *
   * @param {number} h - Hue [0, 360).
   * @param {number} [s=100] - Saturation [0, 100].
   * @param {number} [l=50] - Lightness [0, 100].
   * @returns {string} Hex color string.
   */
  hslToHex(h, s = 100, l = 50) {
    const lFrac = l / 100;
    const a = (s * Math.min(lFrac, 1 - lFrac)) / 100;
    const f = (n) => {
      const k = (n + h / 30) % 12;
      const color = lFrac - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
      return Math.round(255 * color).toString(16).padStart(2, '0');
    };
    return `#${f(0)}${f(8)}${f(4)}`;
  },

  /**
   * Parse an hsl(...) color string to hex (#rrggbb).
   *
   * @param {string} hslStr - HSL string.
   * @returns {string} Hex string.
   */
  hslStringToHex(hslStr) {
    if (!hslStr || typeof hslStr !== 'string' || !hslStr.startsWith('hsl(')) return hslStr;
    const m = hslStr.match(/hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)/i);
    if (m) {
      return MapColors.hslToHex(parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]));
    }
    return hslStr;
  },

  /**
   * Convert a normalised [0, 1] ratio to a green-to-red HSL string.
   *
   * @param {number} ratio - Normalised ratio [0, 1].
   * @param {number} [saturation=100] - Saturation percentage.
   * @param {number} [lightness=50] - Lightness percentage.
   * @returns {string} HSL string.
   */
  ratioToHsl(ratio, saturation = 100, lightness = 50) {
    const r = Math.max(0, Math.min(1, parseFloat(ratio) || 0));
    const hue = (1.0 - r) * 120; // 120 = Green, 60 = Yellow, 0 = Red
    return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
  },

  /**
   * Convert a normalised [0, 1] ratio to a green-to-red hex (#rrggbb) string.
   *
   * @param {number} ratio - Normalised ratio [0, 1].
   * @param {number} [lightness=50] - Lightness percentage.
   * @returns {string} Hex string.
   */
  ratioToHex(ratio, lightness = 50) {
    const r = Math.max(0, Math.min(1, parseFloat(ratio) || 0));
    const hue = (1.0 - r) * 120;
    return MapColors.hslToHex(hue, 100, lightness);
  },

  /**
   * Map value to HSL color (Green = 120 -> Yellow -> Red = 0)
   */
  getColorForValue(val, minVal, maxVal) {
    if (maxVal === minVal) return 'hsl(120, 90%, 50%)'; // default green
    const ratio = (val - minVal) / (maxVal - minVal);
    return MapColors.getHslColor(ratio, 90, 50);
  },

  getColorForMetric(metric, val, minVal, maxVal) {
    // Raw GSR and the four derived arousal metrics (Phasic, Tonic, Peak
    // Density, Phasic AUC, Combined Arousal Index) all share the same
    // low=green / high=red gradient — they're all "how aroused" on
    // different scales, so a consistent gradient keeps them comparable.
    if (metric === 'gsr' || metric === 'phasic' || metric === 'tonic' ||
        metric === 'peakDensity' || metric === 'phasicAUC' || metric === 'arousalIndex' ||
        metric === 'triIndex') {
      return MapColors.getColorForValue(val, minVal, maxVal);
    }

    if (metric === 'em_fog' || metric === 'emFog') {
      let ratio = 0;
      if (maxVal !== minVal) ratio = (val - minVal) / (maxVal - minVal);
      ratio = Math.max(0, Math.min(1, ratio));
      const hue = 220 + ratio * 80; // Blue (220) -> Purple/Magenta (300)
      return `hsl(${hue}, 90%, 55%)`;
    }
    
    if (metric === 'roadClass') {
      return MapColors.ROAD_COLORS[val] || '#666666';
    }
    
    if (metric === 'inPark') {
      return val === 1 ? '#00e575' : '#666666';
    }

    if (metric === 'hdopQuality') {
      // Low HDOP = good accuracy (green), high HDOP = poor accuracy (red).
      // Sentinel 99.9 (no data) rendered grey.
      if (isNaN(val) || val >= 50) return '#888888';
      let ratio = 0;
      if (maxVal !== minVal) ratio = (val - minVal) / (maxVal - minVal);
      ratio = Math.max(0, Math.min(1, ratio));
      const hue = Math.round((1.0 - ratio) * 120);
      return `hsl(${hue}, 90%, 45%)`;
    }

    let ratio = 0;
    if (maxVal !== minVal) {
      ratio = (val - minVal) / (maxVal - minVal);
    }
    ratio = Math.max(0, Math.min(1, ratio));

    if (metric === 'greenPct') {
      // Brown (0%) to Green (100%)
      const hue = 30 + ratio * 100;
      return `hsl(${hue}, 80%, 45%)`;
    }

    if (metric === 'distGreen') {
      // In / next to green space (vivid green) → far from any green (muted brown).
      const hue = 130 - ratio * 95;
      const sat = 70 - ratio * 40;
      return `hsl(${hue}, ${sat}%, 45%)`;
    }

    if (metric === 'canopyPct') {
      // Open sky (pale) → dense tree canopy (deep forest green).
      const hue = 95 + ratio * 40;
      const sat = 25 + ratio * 55;
      const light = 55 - ratio * 22;
      return `hsl(${hue}, ${sat}%, ${light}%)`;
    }
    
    if (metric === 'buildingDensity') {
      // Green (low density) to Red (high density)
      const hue = (1.0 - ratio) * 120;
      return `hsl(${hue}, 85%, 50%)`;
    }
    
    if (metric === 'distMajorRoad') {
      // Close (Red) to Far (Green)
      const hue = ratio * 120;
      return `hsl(${hue}, 85%, 50%)`;
    }
    
    if (metric === 'distWater') {
      // Close (Cyan/Blue) to Far (Brown/Grey)
      const hue = 200 - ratio * 170;
      return `hsl(${hue}, 80%, 45%)`;
    }
    
    if (metric === 'treeDensity') {
      // None (Grey) to Many (Emerald Green)
      const hue = 60 + ratio * 80;
      const sat = 30 + ratio * 60;
      return `hsl(${hue}, ${sat}%, 45%)`;
    }
    
    if (metric === 'amenityCount') {
      // None (Grey) to Many (Purple/Red)
      const hue = 240 - ratio * 240;
      return `hsl(${hue}, 85%, 55%)`;
    }
    
    return '#666666';
  },

  getColorLut(metric, minVal, maxVal) {
    const cacheKey = `${metric}|${minVal.toFixed(4)}|${maxVal.toFixed(4)}`;
    let lut = MapColors._colorLutCache.get(cacheKey);
    if (lut) return lut;

    lut = new Array(30);
    const range = maxVal - minVal;
    for (let b = 0; b < 30; b++) {
      const ratio = range > 1e-9 ? (b + 0.5) / 30 : 0.5;
      lut[b] = MapColors.getColorForMetric(metric, minVal + ratio * range, minVal, maxVal);
    }
    MapColors._colorLutCache.set(cacheKey, lut);
    // Limit cache size
    if (MapColors._colorLutCache.size > 50) {
      const firstKey = MapColors._colorLutCache.keys().next().value;
      MapColors._colorLutCache.delete(firstKey);
    }
    return lut;
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { MapColors };
}
if (typeof window !== 'undefined') {
  window.MapColors = MapColors;
}
