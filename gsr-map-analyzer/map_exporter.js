/**
 * GSR Map SVG Exporter Utility.
 * Compiles Leaflet raster and vector panes into a single Illustrator-compatible layered SVG.
 */
class GSRMapExporter {
  /**
   * Export the current map view to an SVG file.
   *
   * @param {GSRMapManager} mapManager - The active map manager instance.
   */
  static exportToSvg(mapManager) {
    if (!mapManager || !mapManager.map) {
      alert("Map is not initialized. Cannot export.");
      return;
    }

    const map = mapManager.map;
    const mapEl = document.getElementById(mapManager.containerId);
    if (!mapEl) {
      alert("Map container element not found.");
      return;
    }

    const w = mapEl.clientWidth || 800;
    const h = mapEl.clientHeight || 600;
    const mapRect = mapEl.getBoundingClientRect();

    // 1. Gather elements grouped by semantic layer
    const tiles = this._getTilesLayer(mapEl, mapRect);
    const contourSurface = this._getContourSurfaceLayer(mapEl, mapRect);
    const osmShapes = this._getVectorGroup(map, mapManager.osmLayers);
    const tracks = this._getVectorGroup(map, [...mapManager.pathSegments, ...mapManager.collectivePathSegments]);
    const contours = this._getVectorGroup(map, mapManager.contourLayers);
    const clusters = this._getVectorGroup(map, mapManager.clusterLayers);
    
    const { dots, labels } = this._getMarkerLayers(map, [
      ...mapManager.peakMarkers,
      ...mapManager.collectivePeakMarkers
    ]);

    // 2. Assemble SVG Document String with named illustrator-friendly layer groups
    const parts = [
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" style="background-color: #0b0d16;">`,
      
      '  <!-- Layer 1: Base Map Tiles -->',
      '  <g id="base-map-tiles">',
      tiles.map(t => '    ' + t).join('\n'),
      '  </g>',
      
      '  <!-- Layer 2: Shaded Topographic Contours -->',
      `  <g id="shaded-contours" opacity="0.4">`,
      contourSurface.map(t => '    ' + t).join('\n'),
      '  </g>',
      
      '  <!-- Layer 3: OSM Environmental Polygons -->',
      '  <g id="osm-shapes">',
      osmShapes.map(t => '    ' + t).join('\n'),
      '  </g>',
      
      '  <!-- Layer 4: GPS Track Paths -->',
      '  <g id="track-paths">',
      tracks.map(t => '    ' + t).join('\n'),
      '  </g>',
      
      '  <!-- Layer 5: Contour Lines -->',
      '  <g id="contour-lines">',
      contours.map(t => '    ' + t).join('\n'),
      '  </g>',
      
      '  <!-- Layer 6: Spatial Cluster Metaballs -->',
      '  <g id="cluster-metaballs">',
      clusters.map(t => '    ' + t).join('\n'),
      '  </g>',
      
      '  <!-- Layer 7: Stress Peak Dots -->',
      '  <g id="peak-dots">',
      dots.map(t => '    ' + t).join('\n'),
      '  </g>',
      
      '  <!-- Layer 8: Stress Peak Text Labels -->',
      '  <g id="peak-labels">',
      labels.map(t => '    ' + t).join('\n'),
      '  </g>',
      
      '</svg>'
    ];

    const svgString = parts.join('\n');
    this._triggerDownload(svgString, AppState.viewMode || 'single');
  }

  /**
   * Helper to safely escape attribute values for XML compatibility.
   *
   * @private
   */
  static _escapeAttr(val) {
    if (val === undefined || val === null) return '';
    return String(val)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * Helper to attempt inlining a DOM image element as a base64 Data URL.
   *
   * @private
   */
  static _getBase64Image(img) {
    try {
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = img.naturalWidth || img.width || 256;
      tempCanvas.height = img.naturalHeight || img.height || 256;
      const ctx = tempCanvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      return tempCanvas.toDataURL('image/png');
    } catch (err) {
      console.warn("Could not inline tile image as base64 data URL, falling back to original source reference:", err);
      return null;
    }
  }

  /**
   * Compiles the background tiles group list.
   *
   * @private
   */
  static _getTilesLayer(mapEl, mapRect) {
    const tilesLayer = [];
    const tiles = mapEl.querySelectorAll('.leaflet-tile-pane img');
    tiles.forEach(tile => {
      const rect = tile.getBoundingClientRect();
      const x = rect.left - mapRect.left;
      const y = rect.top - mapRect.top;
      
      let tileSrc = this._getBase64Image(tile);
      if (!tileSrc) {
        const rawSrc = tile.getAttribute('src') || tile.src;
        tileSrc = this._escapeAttr(rawSrc);
      }

      tilesLayer.push(
        `<image href="${tileSrc}" x="${x}" y="${y}" width="${rect.width}" height="${rect.height}" />`
      );
    });
    return tilesLayer;
  }

  /**
   * Compiles the shaded contour canvas element.
   *
   * @private
   */
  static _getContourSurfaceLayer(mapEl, mapRect) {
    const contourSurfaceLayer = [];
    const canvas = mapEl.querySelector('.leaflet-overlay-pane canvas');
    if (canvas) {
      const rect = canvas.getBoundingClientRect();
      const x = rect.left - mapRect.left;
      const y = rect.top - mapRect.top;
      try {
        const dataUrl = canvas.toDataURL('image/png');
        contourSurfaceLayer.push(
          `<image href="${dataUrl}" x="${x}" y="${y}" width="${rect.width}" height="${rect.height}" />`
        );
      } catch (err) {
        console.warn("Could not export shaded contour canvas due to CORS/security rules:", err);
      }
    }
    return contourSurfaceLayer;
  }

  /**
   * Helper to generate SVG path command data in memory for polylines.
   *
   * @private
   */
  static _getPathData(map, latlngs) {
    if (!latlngs || latlngs.length === 0) return '';
    if (Array.isArray(latlngs[0])) {
      return latlngs.map(sub => this._getPathData(map, sub)).filter(s => s).join(' ');
    }
    let d = '';
    latlngs.forEach((ll, idx) => {
      const pt = map.latLngToContainerPoint(ll);
      d += (idx === 0 ? 'M' : 'L') + `${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`;
    });
    return d;
  }

  /**
   * Helper to generate SVG path command data in memory for polygons.
   *
   * @private
   */
  static _getPolygonData(map, latlngs) {
    if (!latlngs || latlngs.length === 0) return '';
    if (Array.isArray(latlngs[0])) {
      return latlngs.map(sub => this._getPolygonData(map, sub)).filter(s => s).join(' ');
    }
    let d = '';
    latlngs.forEach((ll, idx) => {
      const pt = map.latLngToContainerPoint(ll);
      d += (idx === 0 ? 'M' : 'L') + `${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`;
    });
    d += 'Z';
    return d;
  }

  /**
   * Reconstructs a single Leaflet vector layer as an SVG path string.
   *
   * @private
   */
  static _reconstructVectorLayer(map, layer) {
    if (!layer || typeof layer.getLatLngs !== 'function') return null;

    const latlngs = layer.getLatLngs();
    const isPolygon = layer instanceof L.Polygon;
    const d = isPolygon ? this._getPolygonData(map, latlngs) : this._getPathData(map, latlngs);
    if (!d) return null;

    const o = layer.options || {};
    const stroke = this._escapeAttr(o.color || '#ff7b00');
    const strokeWidth = this._escapeAttr(o.weight || 3);
    const strokeOpacity = this._escapeAttr(o.opacity !== undefined ? o.opacity : 0.85);
    const dashArray = this._escapeAttr(o.dashArray || 'none');
    
    const fill = this._escapeAttr(isPolygon ? (o.fillColor || stroke) : 'none');
    const fillOpacity = this._escapeAttr(isPolygon ? (o.fillOpacity !== undefined ? o.fillOpacity : 0.2) : 0);

    return `<path d="${d}" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-opacity="${strokeOpacity}" stroke-dasharray="${dashArray}" fill="${fill}" fill-opacity="${fillOpacity}" stroke-linecap="round" stroke-linejoin="round" />`;
  }

  /**
   * Processes an array of Leaflet vector layers and converts them into SVG element strings.
   *
   * @private
   */
  static _getVectorGroup(map, layersList) {
    const vectorGroup = [];
    if (layersList) {
      layersList.forEach(layer => {
        const svg = this._reconstructVectorLayer(map, layer);
        if (svg) vectorGroup.push(svg);
      });
    }
    return vectorGroup;
  }

  /**
   * Compiles coordinates, circles, and labels for active stress peak markers.
   *
   * @private
   */
  static _getMarkerLayers(map, markersList) {
    const dots = [];
    const labels = [];

    if (!markersList) return { dots, labels };

    markersList.forEach(marker => {
      if (!map.hasLayer(marker)) return;

      const latLng = marker.getLatLng();
      const pt = map.latLngToContainerPoint(latLng);
      const cx = pt.x;
      const cy = pt.y;

      const markerEl = marker.getElement();
      if (!markerEl) return;

      const markerOpacity = window.getComputedStyle(markerEl).opacity || '1.0';

      // A. Peak Dot
      const dot = markerEl.querySelector('.peak-dot') || markerEl.querySelector('.collective-peak-dot');
      if (dot && window.getComputedStyle(dot).display !== 'none') {
        const dotStyle = window.getComputedStyle(dot);
        const fill = this._escapeAttr(dotStyle.backgroundColor || '#f43f5e');
        const stroke = this._escapeAttr(dotStyle.borderColor || '#ffffff');
        const strokeWidth = this._escapeAttr(parseFloat(dotStyle.borderWidth) || 1.5);
        const opacity = this._escapeAttr(parseFloat(markerOpacity));
        dots.push(
          `<circle cx="${cx}" cy="${cy}" r="5" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" opacity="${opacity}" />`
        );
      }

      // B. Text Label
      const label = markerEl.querySelector('.peak-map-label');
      if (label && window.getComputedStyle(label).display !== 'none') {
        const text = label.textContent.trim();
        const labelStyle = window.getComputedStyle(label);
        const color = this._escapeAttr(labelStyle.color || '#ffffff');
        const fontSize = this._escapeAttr(labelStyle.fontSize || '10px');
        const fontWeight = this._escapeAttr(labelStyle.fontWeight || '600');
        const fontFamily = this._escapeAttr(labelStyle.fontFamily || 'sans-serif');
        const opacity = this._escapeAttr(parseFloat(markerOpacity));

        const labelRect = label.getBoundingClientRect();
        const wrapperRect = markerEl.getBoundingClientRect();
        const lx = cx + (labelRect.left - wrapperRect.left) + labelRect.width / 2;
        const ly = cy + (labelRect.top - wrapperRect.top) + labelRect.height * 0.78;

        const escapedText = text
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');

        labels.push(
          `<text x="${lx}" y="${ly}" font-size="${fontSize}" font-weight="${fontWeight}" font-family="${fontFamily}" fill="${color}" stroke="#000000" stroke-width="2" paint-order="stroke fill" text-anchor="middle" opacity="${opacity}">${escapedText}</text>`
        );
      }
    });

    return { dots, labels };
  }

  /**
   * Bundles the completed SVG string into a blob and triggers a browser download.
   *
   * @private
   */
  static _triggerDownload(svgString, viewMode) {
    const blob = new Blob([svgString], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    
    const filename = `biomapping_map_${viewMode}_export.svg`;
    link.download = filename;
    link.href = url;
    link.setAttribute('download', filename);
    
    document.body.appendChild(link);
    link.click();
    
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }
}

// Make globally available
window.GSRMapExporter = GSRMapExporter;
