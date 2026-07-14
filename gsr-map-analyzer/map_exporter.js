/**
 * GSR Map SVG Exporter Utility.
 * Compiles Leaflet raster and vector panes into a single Illustrator-compatible layered SVG.
 */
class GSRMapExporter {
  /**
   * Export the current map view to an SVG file (async — waits for tile inlining).
   *
   * @param {GSRMapManager} mapManager - The active map manager instance.
   */
  static async exportToSvg(mapManager) {
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
    const tiles = await this._getTilesLayerAsync(mapEl, mapRect);
    const contourSurface = this._getContourSurfaceLayer(mapEl, mapRect);
    const osmShapes = this._getVectorGroup(map, mapManager.osmLayers);
    const tracks = this._getVectorGroup(map, [...mapManager.pathSegments, ...mapManager.collectivePathSegments]);
    const contours = this._getVectorGroup(map, mapManager.contourLayers);
    const clusters = this._getVectorGroup(map, mapManager.clusterLayers);
    
    const { dots, labels } = this._getMarkerLayers(map, [
      ...mapManager.peakMarkers,
      ...mapManager.collectivePeakMarkers
    ]);

    // Determine if tiles are self-contained for the background fallback
    const hasAnyTiles = tiles.length > 0;

    // 2. Assemble SVG Document String with named illustrator-friendly layer groups
    const parts = [
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:i="http://ns.adobe.com/AdobeIllustrator/10.0/" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">`,
      
      '  <!-- Background fill (always present so export is never fully transparent) -->',
      `  <rect x="0" y="0" width="${w}" height="${h}" fill="#0b0d16" />`,
      
      '  <!-- Layer 1: Base Map Tiles -->',
      '  <g i:layer="yes" id="Base_Map_Tiles" data-name="Base Map Tiles">',
      hasAnyTiles ? tiles.map(t => '    ' + t).join('\n') : '',
      '  </g>',
      
      '  <!-- Layer 2: Shaded Topographic Contours -->',
      `  <g i:layer="yes" id="Shaded_Contours" data-name="Shaded Contours" opacity="0.4">`,
      contourSurface.map(t => '    ' + t).join('\n'),
      '  </g>',
      
      '  <!-- Layer 3: OSM Shapes -->',
      '  <g i:layer="yes" id="OSM_Shapes" data-name="OSM Shapes">',
      osmShapes.map(t => '    ' + t).join('\n'),
      '  </g>',
      
      '  <!-- Layer 4: GPS Track Paths -->',
      '  <g i:layer="yes" id="GPS_Track_Paths" data-name="GPS Track Paths">',
      tracks.map(t => '    ' + t).join('\n'),
      '  </g>',
      
      '  <!-- Layer 5: Contour Lines -->',
      '  <g i:layer="yes" id="Contour_Lines" data-name="Contour Lines">',
      contours.map(t => '    ' + t).join('\n'),
      '  </g>',
      
      '  <!-- Layer 6: Spatial Cluster Metaballs -->',
      '  <g i:layer="yes" id="Cluster_Metaballs" data-name="Cluster Metaballs">',
      clusters.map(t => '    ' + t).join('\n'),
      '  </g>',
      
      '  <!-- Layer 7: Stress Peak Dots -->',
      '  <g i:layer="yes" id="Stress_Peak_Dots" data-name="Stress Peak Dots">',
      dots.map(t => '    ' + t).join('\n'),
      '  </g>',
      
      '  <!-- Layer 8: Stress Peak Labels -->',
      '  <g i:layer="yes" id="Stress_Peak_Labels" data-name="Stress Peak Labels">',
      labels.map(t => '    ' + t).join('\n'),
      '  </g>',
      
      '</svg>'
    ];

    const svgString = parts.join('\n');
    this._triggerDownload(svgString, AppState.viewMode || 'single');
  }

  /**
   * Helper: returns true if a CSS color string represents a "dark" color
   * that would be invisible on the dark SVG background.
   * Accepts hex (#111111), rgb(), rgba() formats.
   *
   * @private
   */
  static _isDarkForExport(colorStr) {
    if (!colorStr) return false;
    // Match rgb(r, g, b) or rgba(r, g, b, ...)
    const m = colorStr.match(/rgba?\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (m) {
      const r = parseInt(m[1], 10) / 255;
      const g = parseInt(m[2], 10) / 255;
      const b = parseInt(m[3], 10) / 255;
      // Relative luminance (sRGB)
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      return lum < 0.35;
    }
    // Hex shorthand
    if (colorStr.startsWith('#')) {
      let hex = colorStr.slice(1);
      if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
      if (hex.length >= 6) {
        const r = parseInt(hex.slice(0, 2), 16) / 255;
        const g = parseInt(hex.slice(2, 4), 16) / 255;
        const b = parseInt(hex.slice(4, 6), 16) / 255;
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        return lum < 0.35;
      }
    }
    return false;
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
   * Attempt to convert a tile image to a self-contained data: URL.
   * Tries three strategies in order:
   *   1. Canvas drawImage + toDataURL (works for same-origin / CORS-enabled images)
   *   2. fetch() the src and convert blob → data: URL via FileReader
   *   3. Return null so the caller can skip the tile
   *
   * @param {HTMLImageElement} img - The tile <img> element
   * @returns {Promise<string|null>} A data: URL string, or null if all methods fail
   * @private
   */
  static async _getBase64ImageAsync(img) {
    // Strategy 1: canvas draw (fast, works for same-origin)
    try {
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = img.naturalWidth || img.width || 256;
      tempCanvas.height = img.naturalHeight || img.height || 256;
      const ctx = tempCanvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const dataUrl = tempCanvas.toDataURL('image/png');
      if (dataUrl && dataUrl.startsWith('data:')) return dataUrl;
    } catch (_) {
      // Canvas tainted by cross-origin image — fall through to fetch
    }

    // Strategy 2: fetch the raw image URL (may work if server sends CORS headers)
    const src = img.getAttribute('src') || img.src;
    if (!src) return null;

    try {
      const response = await fetch(src, { mode: 'cors' });
      if (response.ok) {
        const blob = await response.blob();
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
        if (dataUrl && dataUrl.startsWith('data:')) return dataUrl;
      }
    } catch (_) {
      // fetch also failed (CORS or network) — tile cannot be inlined
    }

    return null;
  }

  /**
   * Synchronous fallback kept for compatibility.  Prefer _getBase64ImageAsync.
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
      return null;
    }
  }

  /**
   * Compiles the background tiles group list (async — attempts to inline every tile).
   * Tiles that cannot be inlined are silently skipped so the SVG contains zero
   * external references.
   *
   * @returns {Promise<string[]>}
   * @private
   */
  static async _getTilesLayerAsync(mapEl, mapRect) {
    const tilesLayer = [];
    const tiles = mapEl.querySelectorAll('.leaflet-tile-pane img');
    const promises = [];

    tiles.forEach(tile => {
      const rect = tile.getBoundingClientRect();
      const x = rect.left - mapRect.left;
      const y = rect.top - mapRect.top;

      promises.push(
        this._getBase64ImageAsync(tile).then(dataUrl => {
          if (dataUrl) {
            const escaped = this._escapeAttr(dataUrl);
            tilesLayer.push(
              `<image href="${escaped}" xlink:href="${escaped}" x="${x}" y="${y}" width="${rect.width}" height="${rect.height}" />`
            );
          }
          // else: tile cannot be inlined — skip it silently
        })
      );
    });

    await Promise.all(promises);
    return tilesLayer;
  }

  /**
   * Synchronous fallback for _getTilesLayer (kept for backward compat).
   * Tiles that can't be inlined will be skipped.
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
      if (tileSrc) {
        const escaped = this._escapeAttr(tileSrc);
        tilesLayer.push(
          `<image href="${escaped}" xlink:href="${escaped}" x="${x}" y="${y}" width="${rect.width}" height="${rect.height}" />`
        );
      }
      // else skip — no external URLs in the SVG
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
    
    // In collective view, the surface is rendered as a Leaflet L.imageOverlay (an <img> tag with class 'collective-surface-overlay')
    const img = mapEl.querySelector('.leaflet-overlay-pane img.collective-surface-overlay');
    if (img) {
      const rect = img.getBoundingClientRect();
      const x = rect.left - mapRect.left;
      const y = rect.top - mapRect.top;
      const src = img.src; // This is already a base64 PNG data URL, so it is fully self-contained!
      const escaped = this._escapeAttr(src);
      contourSurfaceLayer.push(
        `<image href="${escaped}" xlink:href="${escaped}" x="${x}" y="${y}" width="${rect.width}" height="${rect.height}" />`
      );
    } else {
      // Fallback for canvas overlays (single-track or other views)
      const canvas = mapEl.querySelector('.leaflet-overlay-pane canvas');
      if (canvas) {
        const rect = canvas.getBoundingClientRect();
        const x = rect.left - mapRect.left;
        const y = rect.top - mapRect.top;
        try {
          const dataUrl = canvas.toDataURL('image/png');
          const escaped = this._escapeAttr(dataUrl);
          contourSurfaceLayer.push(
            `<image href="${escaped}" xlink:href="${escaped}" x="${x}" y="${y}" width="${rect.width}" height="${rect.height}" />`
          );
        } catch (err) {
          console.warn("Could not export shaded contour canvas due to CORS/security rules:", err);
        }
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
        const rawColor = labelStyle.color || '#ffffff';
        // Collective labels use dark text (#111) with a white text-shadow halo on the
        // map — the shadow doesn't carry into SVG, so force white for legibility.
        const color = this._escapeAttr(this._isDarkForExport(rawColor) ? '#ffffff' : rawColor);
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
    const blob = new Blob([svgString], { type: 'image/svg+xml' });
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
