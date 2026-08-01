/**
 * Color scale and LUT helpers for the Bio Mapping GSR analyser map.
 */
const MapColors = {
  _colorLutCache: new Map(),

  getHslColor(ratio, saturation = 100, lightness = 50) {
    const r = Math.max(0, Math.min(1, ratio));
    const hue = (1.0 - r) * 120;
    return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
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
        metric === 'peakDensity' || metric === 'phasicAUC' || metric === 'arousalIndex') {
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
      const roadColors = {
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
      };
      return roadColors[val] || '#666666';
    }
    
    if (metric === 'inPark') {
      return val === 1 ? '#00e575' : '#666666';
    }

    if (metric === 'hdopQuality') {
      // Low HDOP = good accuracy (green), high HDOP = poor accuracy (red).
      // Sentinel 99.9 (no data) rendered gray.
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
      // Close (Cyan/Blue) to Far (Brown/Gray)
      const hue = 200 - ratio * 170;
      return `hsl(${hue}, 80%, 45%)`;
    }
    
    if (metric === 'treeDensity') {
      // None (Gray) to Many (Emerald Green)
      const hue = 60 + ratio * 80;
      const sat = 30 + ratio * 60;
      return `hsl(${hue}, ${sat}%, 45%)`;
    }
    
    if (metric === 'amenityCount') {
      // None (Gray) to Many (Purple/Red)
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
