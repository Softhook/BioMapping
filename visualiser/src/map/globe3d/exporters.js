/**
 * BioMapping 2.0 — 3D track exporters (CZML / KML)
 * Copyright (c) 2026 Christian Nold
 * Licensed under the Bio Mapping Community Licence 1.0.
 *
 * Pure builders: given an analysed track + the display points the 2D map drew,
 * they return a file string. Invoked from the main Export Options panel
 * (src/ui/events.js) — no live CesiumJS viewer required. The extruded-wall
 * height for a point is
 *     baseHeight + max(0, metricValue) * extrusionScale
 * matching the on-screen wall in src/map/globe3d.js.
 */

// Mirrors SERIES_FIELD in src/map/globe3d.js (and DERIVED_METRIC_SERIES in map.js) —
// coloring metric -> analyzer per-sample series field.
const G3DX_SERIES_FIELD = {
  phasic: 'phasic', tonic: 'tonic', arousalIndex: 'arousalIndex', triIndex: 'triIndex',
  peakDensity: 'peakDensity', phasicAUC: 'phasicAUC', em_fog: 'em_fog', emFog: 'em_fog'
};
const g3dxSeriesValue = (d) =>
  (d && typeof d === 'object' && 'val' in d) ? d.val : (typeof d === 'number' ? d : 0);

const GSRGlobe3DExport = {
  DEFAULT_BASE_HEIGHT: 2.0,
  DEFAULT_EXTRUSION: 8.0,

  /** Per-sample float series for `metric`, indexed like analyzer.raw. */
  resolveSeries(analyzer, metric) {
    const field = G3DX_SERIES_FIELD[metric];
    if (field && analyzer[field] && analyzer[field].length > 0) {
      return analyzer[field].map(g3dxSeriesValue);
    }
    const raw = analyzer.raw || [];
    return raw.map((d) => (d.gsr !== undefined ? d.gsr : (d.val !== undefined ? d.val : 0)));
  },

  _resolveOpts(opts) {
    return {
      metric: opts.metric || 'phasic',
      baseHeight: (opts.baseHeight != null) ? opts.baseHeight : this.DEFAULT_BASE_HEIGHT,
      extrusionScale: (opts.extrusionScale != null && isFinite(opts.extrusionScale))
        ? opts.extrusionScale : this.DEFAULT_EXTRUSION
    };
  },

  /**
   * CZML (Cesium 3D JSON) — one extruded `wall` entity following the track.
   * @returns {string} pretty-printed JSON
   */
  buildCzml(analyzer, drawPoints, opts = {}) {
    const { metric, baseHeight, extrusionScale } = this._resolveOpts(opts);
    const series = this.resolveSeries(analyzer, metric);

    const positions = [];
    const minHeights = [];
    const maxHeights = [];
    for (let i = 0; i < drawPoints.length; i++) {
      const pt = drawPoints[i];
      const val = Math.max(0, series[pt.origIdx] || 0);
      positions.push(pt.lon, pt.lat, 0);
      minHeights.push(0);
      maxHeights.push(baseHeight + val * extrusionScale);
    }

    return JSON.stringify([
      { id: 'document', name: 'BioMapping 3D Emotional Topography', version: '1.0' },
      {
        id: 'biomap_3d_ribbon',
        name: 'GSR Emotional Ribbon',
        wall: {
          positions: { cartographicDegrees: positions },
          minimumHeights: minHeights,
          maximumHeights: maxHeights,
          material: { solidColor: { color: { rgba: [0, 212, 255, 200] } } }
        }
      }
    ], null, 2);
  },

  /**
   * 3D KML — an extruded <LineString> for Google Earth.
   * @returns {string} KML document
   */
  buildKml(analyzer, drawPoints, opts = {}) {
    const { metric, baseHeight, extrusionScale } = this._resolveOpts(opts);
    const series = this.resolveSeries(analyzer, metric);

    let coords = '';
    for (let i = 0; i < drawPoints.length; i++) {
      const pt = drawPoints[i];
      const val = Math.max(0, series[pt.origIdx] || 0);
      const height = baseHeight + val * extrusionScale;
      coords += `${pt.lon},${pt.lat},${height.toFixed(1)}\n`;
    }

    return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>BioMapping 3D Emotional Landscape</name>
    <Style id="biomapWallStyle">
      <LineStyle>
        <color>ff00ffff</color>
        <width>3</width>
      </LineStyle>
      <PolyStyle>
        <color>aa00d4ff</color>
      </PolyStyle>
    </Style>
    <Placemark>
      <name>3D Arousal Ribbon</name>
      <styleUrl>#biomapWallStyle</styleUrl>
      <LineString>
        <extrude>1</extrude>
        <tessellate>1</tessellate>
        <altitudeMode>relativeToGround</altitudeMode>
        <coordinates>
${coords.trim()}
        </coordinates>
      </LineString>
    </Placemark>
  </Document>
</kml>`;
  },

  /** Trigger a browser download of `text` as `filename`. No-op outside a DOM. */
  download(text, filename, mime) {
    if (typeof document === 'undefined' || !document.body) return;
    const blob = new Blob([text], { type: mime || 'text/plain' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.download = filename;
    link.href = url;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GSRGlobe3DExport };
}
if (typeof window !== 'undefined') {
  window.GSRGlobe3DExport = GSRGlobe3DExport;
}
