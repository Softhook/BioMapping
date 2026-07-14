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

    // Helper to safely escape attribute values for XML compatibility
    const escapeAttr = (val) => {
      if (val === undefined || val === null) return '';
      return String(val)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    };

    // Helper to attempt inlining a DOM image element as a base64 Data URL (prevents broken links in Illustrator)
    const getBase64Image = (img) => {
      try {
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = img.naturalWidth || img.width || 256;
        tempCanvas.height = img.naturalHeight || img.height || 256;
        const ctx = tempCanvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        return tempCanvas.toDataURL('image/png');
      } catch (err) {
        // Tainted canvas or security restriction (e.g. file:/// protocol in Chrome)
        console.warn("Could not inline tile image as base64 data URL, falling back to original source reference:", err);
        return null;
      }
    };

    // 1. Get dimensions
    const w = mapEl.clientWidth;
    const h = mapEl.clientHeight;
    const mapRect = mapEl.getBoundingClientRect();

    // 2. Initialize Layer Groups
    const layers = {
      tiles: [],
      contourSurface: [],
      osmShapes: [],
      tracks: [],
      contours: [],
      clusters: [],
      dots: [],
      labels: []
    };

    // ── Layer 1: Base Map Tiles ──────────────────────────────────────────────
    const tiles = mapEl.querySelectorAll('.leaflet-tile-pane img');
    tiles.forEach(tile => {
      const rect = tile.getBoundingClientRect();
      const x = rect.left - mapRect.left;
      const y = rect.top - mapRect.top;
      
      // Attempt to inline as base64 first to avoid link-reference warnings in Illustrator
      let tileSrc = getBase64Image(tile);
      if (!tileSrc) {
        // Fallback: use the raw source attribute. Keeping it relative prevents hardcoding local absolute paths
        const rawSrc = tile.getAttribute('src') || tile.src;
        tileSrc = escapeAttr(rawSrc);
      }

      layers.tiles.push(
        `<image href="${tileSrc}" x="${x}" y="${y}" width="${rect.width}" height="${rect.height}" />`
      );
    });

    // ── Layer 2: Shaded Contours (Canvas raster base64) ──────────────────────
    const canvas = mapEl.querySelector('.leaflet-overlay-pane canvas');
    if (canvas) {
      const rect = canvas.getBoundingClientRect();
      const x = rect.left - mapRect.left;
      const y = rect.top - mapRect.top;
      try {
        const dataUrl = canvas.toDataURL('image/png');
        layers.contourSurface.push(
          `<image href="${dataUrl}" x="${x}" y="${y}" width="${rect.width}" height="${rect.height}" />`
        );
      } catch (err) {
        console.warn("Could not export shaded contour canvas due to CORS/security rules:", err);
      }
    }

    // Helpers to generate SVG paths in memory using Leaflet projection
    const getPathData = (latlngs) => {
      if (!latlngs || latlngs.length === 0) return '';
      if (Array.isArray(latlngs[0])) {
        return latlngs.map(sub => getPathData(sub)).filter(s => s).join(' ');
      }
      let d = '';
      latlngs.forEach((ll, idx) => {
        const pt = map.latLngToContainerPoint(ll);
        d += (idx === 0 ? 'M' : 'L') + `${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`;
      });
      return d;
    };

    const getPolygonData = (latlngs) => {
      if (!latlngs || latlngs.length === 0) return '';
      if (Array.isArray(latlngs[0])) {
        return latlngs.map(sub => getPolygonData(sub)).filter(s => s).join(' ');
      }
      let d = '';
      latlngs.forEach((ll, idx) => {
        const pt = map.latLngToContainerPoint(ll);
        d += (idx === 0 ? 'M' : 'L') + `${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`;
      });
      d += 'Z';
      return d;
    };

    const reconstructVectorLayer = (layer) => {
      if (!layer || typeof layer.getLatLngs !== 'function') return null;

      const latlngs = layer.getLatLngs();
      const isPolygon = layer instanceof L.Polygon;
      const d = isPolygon ? getPolygonData(latlngs) : getPathData(latlngs);
      if (!d) return null;

      const o = layer.options || {};
      const stroke = escapeAttr(o.color || '#ff7b00');
      const strokeWidth = escapeAttr(o.weight || 3);
      const strokeOpacity = escapeAttr(o.opacity !== undefined ? o.opacity : 0.85);
      const dashArray = escapeAttr(o.dashArray || 'none');
      
      const fill = escapeAttr(isPolygon ? (o.fillColor || stroke) : 'none');
      const fillOpacity = escapeAttr(isPolygon ? (o.fillOpacity !== undefined ? o.fillOpacity : 0.2) : 0);

      return `<path d="${d}" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-opacity="${strokeOpacity}" stroke-dasharray="${dashArray}" fill="${fill}" fill-opacity="${fillOpacity}" stroke-linecap="round" stroke-linejoin="round" />`;
    };

    // ── Layer 3: OSM Shapes ──────────────────────────────────────────────────
    if (mapManager.osmLayers) {
      mapManager.osmLayers.forEach(layer => {
        const svg = reconstructVectorLayer(layer);
        if (svg) layers.osmShapes.push(svg);
      });
    }

    // ── Layer 4: Track Paths ─────────────────────────────────────────────────
    const trackPaths = [...mapManager.pathSegments, ...mapManager.collectivePathSegments];
    trackPaths.forEach(layer => {
      const svg = reconstructVectorLayer(layer);
      if (svg) layers.tracks.push(svg);
    });

    // ── Layer 5: Contour Isolines ────────────────────────────────────────────
    if (mapManager.contourLayers) {
      mapManager.contourLayers.forEach(layer => {
        const svg = reconstructVectorLayer(layer);
        if (svg) layers.contours.push(svg);
      });
    }

    // ── Layer 6: Cluster Metaballs ───────────────────────────────────────────
    if (mapManager.clusterLayers) {
      mapManager.clusterLayers.forEach(layer => {
        const svg = reconstructVectorLayer(layer);
        if (svg) layers.clusters.push(svg);
      });
    }

    // ── Layers 7, 8: Peak Markers (Dots, Labels) ─────────────────────────────
    const activeMarkers = [...mapManager.peakMarkers, ...mapManager.collectivePeakMarkers];
    activeMarkers.forEach(marker => {
      // Only export active markers currently rendered on the map layer
      if (!map.hasLayer(marker)) return;

      // Project coordinates in memory
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
        const fill = escapeAttr(dotStyle.backgroundColor || '#f43f5e');
        const stroke = escapeAttr(dotStyle.borderColor || '#ffffff');
        const strokeWidth = escapeAttr(parseFloat(dotStyle.borderWidth) || 1.5);
        const opacity = escapeAttr(parseFloat(markerOpacity));
        layers.dots.push(
          `<circle cx="${cx}" cy="${cy}" r="5" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" opacity="${opacity}" />`
        );
      }

      // B. Text Label
      const label = markerEl.querySelector('.peak-map-label');
      if (label && window.getComputedStyle(label).display !== 'none') {
        const text = label.textContent.trim();
        const labelStyle = window.getComputedStyle(label);
        const color = escapeAttr(labelStyle.color || '#ffffff');
        const fontSize = escapeAttr(labelStyle.fontSize || '10px');
        const fontWeight = escapeAttr(labelStyle.fontWeight || '600');
        // Font families often contain unescaped double quotes (e.g. "Segoe UI"), which MUST be XML-escaped
        const fontFamily = escapeAttr(labelStyle.fontFamily || 'sans-serif');
        const opacity = escapeAttr(parseFloat(markerOpacity));

        // Position text relative to the projected marker coordinate center
        const labelRect = label.getBoundingClientRect();
        const wrapperRect = markerEl.getBoundingClientRect();
        const lx = cx + (labelRect.left - wrapperRect.left) + labelRect.width / 2;
        const ly = cy + (labelRect.top - wrapperRect.top) + labelRect.height * 0.78; // approx baseline offset

        const escapedText = text
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');

        // Add a 2px black vector outline (stroke) behind the white text for legibility on all backdrops
        layers.labels.push(
          `<text x="${lx}" y="${ly}" font-size="${fontSize}" font-weight="${fontWeight}" font-family="${fontFamily}" fill="${color}" stroke="#000000" stroke-width="2" paint-order="stroke fill" text-anchor="middle" opacity="${opacity}">${escapedText}</text>`
        );
      }
    });

    // 3. Assemble SVG Document String with named illustrator-friendly layer groups
    const parts = [
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" style="background-color: #0b0d16;">`,
      
      '  <!-- Layer 1: Base Map Tiles -->',
      '  <g id="base-map-tiles">',
      layers.tiles.map(t => '    ' + t).join('\n'),
      '  </g>',
      
      '  <!-- Layer 2: Shaded Topographic Contours -->',
      `  <g id="shaded-contours" opacity="0.4">`,
      layers.contourSurface.map(t => '    ' + t).join('\n'),
      '  </g>',
      
      '  <!-- Layer 3: OSM Environmental Polygons -->',
      '  <g id="osm-shapes">',
      layers.osmShapes.map(t => '    ' + t).join('\n'),
      '  </g>',
      
      '  <!-- Layer 4: GPS Track Paths -->',
      '  <g id="track-paths">',
      layers.tracks.map(t => '    ' + t).join('\n'),
      '  </g>',
      
      '  <!-- Layer 5: Contour Lines -->',
      '  <g id="contour-lines">',
      layers.contours.map(t => '    ' + t).join('\n'),
      '  </g>',
      
      '  <!-- Layer 6: Spatial Cluster Metaballs -->',
      '  <g id="cluster-metaballs">',
      layers.clusters.map(t => '    ' + t).join('\n'),
      '  </g>',
      
      '  <!-- Layer 7: Stress Peak Dots -->',
      '  <g id="peak-dots">',
      layers.dots.map(t => '    ' + t).join('\n'),
      '  </g>',
      
      '  <!-- Layer 8: Stress Peak Text Labels -->',
      '  <g id="peak-labels">',
      layers.labels.map(t => '    ' + t).join('\n'),
      '  </g>',
      
      '</svg>'
    ];

    const svgString = parts.join('\n');

    // 4. Trigger Download
    const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    
    // Choose appropriate name based on single vs collective mode
    const viewMode = AppState.viewMode || 'single';
    link.download = `biomapping_map_${viewMode}_export.svg`;
    link.href = url;
    document.body.appendChild(link);
    link.click();
    
    // Clean up
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }
}

// Make globally available
window.GSRMapExporter = GSRMapExporter;
