/**
 * GSR Map SVG Exporter Utility.
 * Compiles Leaflet raster and vector panes into a single
 * Illustrator-compatible layered SVG with zero external references.
 */
const SVG_NS      = 'http://www.w3.org/2000/svg';
const XLINK_NS    = 'http://www.w3.org/1999/xlink';
const AI_NS       = 'http://ns.adobe.com/AdobeIllustrator/10.0/';
const BG_COLOR    = '#0b0d16';
const LABEL_COLOR = '#000000';

class GSRMapExporter {

  // ═══════════════════════════════════════════════════════════════════
  //  Public API
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Export the current map view to a self-contained layered SVG file.
   * @param {GSRMapManager} mapManager
   */
  static async exportToSvg(mapManager) {
    const { map, mapEl, mapRect, w, h } = this._validateAndMeasure(mapManager);
    if (!map) return;

    const tiles           = await this._collectTiles(mapEl, mapRect);
    const contourSurface  = this._collectContourSurface(mapEl, mapRect);
    const osmShapes       = this._collectVectorGroup(map, mapManager.osmLayers);
    const tracks          = this._collectVectorGroup(map, [...mapManager.pathSegments, ...mapManager.collectivePathSegments]);
    const contours        = this._collectVectorGroup(map, mapManager.contourLayers);
    const clusters        = this._collectVectorGroup(map, mapManager.clusterLayers);
    const { dots, labels } = this._collectMarkers(map, [
      ...mapManager.peakMarkers,
      ...mapManager.collectivePeakMarkers
    ]);

    const svg = this._assembleSvg(w, h, tiles, contourSurface, osmShapes, tracks, contours, clusters, dots, labels);
    this._download(svg, AppState.viewMode || 'single');
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Validation & measurement
  // ═══════════════════════════════════════════════════════════════════

  static _validateAndMeasure(mapManager) {
    if (!mapManager || !mapManager.map) {
      alert("Map is not initialized. Cannot export.");
      return {};
    }
    const map   = mapManager.map;
    const mapEl = document.getElementById(mapManager.containerId);
    if (!mapEl) {
      alert("Map container element not found.");
      return {};
    }
    const w       = mapEl.clientWidth  || 800;
    const h       = mapEl.clientHeight || 600;
    const mapRect = mapEl.getBoundingClientRect();
    return { map, mapEl, mapRect, w, h };
  }

  // ═══════════════════════════════════════════════════════════════════
  //  SVG assembly
  // ═══════════════════════════════════════════════════════════════════

  static _assembleSvg(w, h, tiles, contourSurface, osmShapes, tracks, contours, clusters, dots, labels) {
    const layer = (id, name, items, attrs = '') =>
      `  <g i:layer="yes" id="${id}" data-name="${name}"${attrs ? ' ' + attrs : ''}>\n` +
      (items.length ? items.map(el => '    ' + el).join('\n') : '') +
      '\n  </g>';

    return [
      `<svg xmlns="${SVG_NS}" xmlns:xlink="${XLINK_NS}" xmlns:i="${AI_NS}" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">`,
      `  <rect x="0" y="0" width="${w}" height="${h}" fill="${BG_COLOR}" />`,
      layer('Base_Map_Tiles',     'Base Map Tiles',              tiles),
      layer('Shaded_Contours',    'Shaded Contours',             contourSurface, 'opacity="0.4"'),
      layer('OSM_Shapes',         'OSM Shapes',                  osmShapes),
      layer('GPS_Track_Paths',    'GPS Track Paths',             tracks),
      layer('Contour_Lines',      'Contour Lines',               contours),
      layer('Cluster_Metaballs',  'Cluster Metaballs',           clusters),
      layer('Stress_Peak_Dots',   'Stress Peak Dots',            dots),
      layer('Stress_Peak_Labels', 'Stress Peak Labels',          labels),
      '</svg>'
    ].join('\n');
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Tile raster layer
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Collect tile <img> elements, converting each to a data: URL so the
   * SVG has zero external references.  Tiles that cannot be inlined are
   * silently skipped.
   */
  static async _collectTiles(mapEl, mapRect) {
    const tiles   = mapEl.querySelectorAll('.leaflet-tile-pane img');
    const results = [];
    const tasks   = Array.from(tiles).map(tile => {
      const r = tile.getBoundingClientRect();
      return this._imageToDataUrl(tile).then(dataUrl => {
        if (dataUrl) results.push(this._imageTag(r.left - mapRect.left, r.top - mapRect.top, r.width, r.height, dataUrl));
      });
    });
    await Promise.all(tasks);
    return results;
  }

  /**
   * Convert an <img> element to a base64 data: URL.
   * Strategy 1: canvas drawImage (same-origin).
   * Strategy 2: fetch → blob → FileReader.
   * Returns null when neither works (cross-origin without CORS).
   */
  static async _imageToDataUrl(img) {
    // Strategy 1 — canvas (same-origin / CORS-enabled images)
    try {
      const c = document.createElement('canvas');
      c.width  = img.naturalWidth  || img.width  || 256;
      c.height = img.naturalHeight || img.height || 256;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const url = c.toDataURL('image/png');
      if (url && url.startsWith('data:')) return url;
    } catch (_) { /* tainted — fall through */ }

    // Strategy 2 — fetch
    const src = img.getAttribute('src') || img.src;
    if (!src) return null;
    try {
      const res = await fetch(src, { mode: 'cors' });
      if (!res.ok) return null;
      const blob = await res.blob();
      return await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onloadend = () => resolve(r.result);
        r.onerror   = reject;
        r.readAsDataURL(blob);
      });
    } catch (_) { return null; }
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Contour surface (canvas / imageOverlay)
  // ═══════════════════════════════════════════════════════════════════

  static _collectContourSurface(mapEl, mapRect) {
    const items = [];

    // Collective view: L.imageOverlay → <img class="collective-surface-overlay">
    const img = mapEl.querySelector('.leaflet-overlay-pane img.collective-surface-overlay');
    if (img) {
      const r = img.getBoundingClientRect();
      items.push(this._imageTag(r.left - mapRect.left, r.top - mapRect.top, r.width, r.height, img.src));
      return items;
    }

    // Single-track: <canvas> overlay
    const canvas = mapEl.querySelector('.leaflet-overlay-pane canvas');
    if (canvas) {
      try {
        const r   = canvas.getBoundingClientRect();
        const url = canvas.toDataURL('image/png');
        items.push(this._imageTag(r.left - mapRect.left, r.top - mapRect.top, r.width, r.height, url));
      } catch (err) {
        console.warn("Could not export shaded contour canvas:", err);
      }
    }
    return items;
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Vector layers (paths / polygons)
  // ═══════════════════════════════════════════════════════════════════

  static _collectVectorGroup(map, layers) {
    const items = [];
    if (layers) layers.forEach(l => {
      const svg = this._layerToSvg(map, l);
      if (svg) items.push(svg);
    });
    return items;
  }

  static _layerToSvg(map, layer) {
    if (!layer || typeof layer.getLatLngs !== 'function') return null;
    const latlngs   = layer.getLatLngs();
    const isPolygon = layer instanceof L.Polygon;
    const d = isPolygon
      ? this._polygonPathData(map, latlngs)
      : this._polylinePathData(map, latlngs);
    if (!d) return null;

    const o = layer.options || {};
    return `<path d="${d}"` +
      ` stroke="${this._esc(o.color || '#ff7b00')}"` +
      ` stroke-width="${this._esc(o.weight || 3)}"` +
      ` stroke-opacity="${this._esc(o.opacity ?? 0.85)}"` +
      ` stroke-dasharray="${this._esc(o.dashArray || 'none')}"` +
      ` fill="${this._esc(isPolygon ? (o.fillColor || o.color || '#ff7b00') : 'none')}"` +
      ` fill-opacity="${this._esc(isPolygon ? (o.fillOpacity ?? 0.2) : 0)}"` +
      ` stroke-linecap="round" stroke-linejoin="round" />`;
  }

  static _polylinePathData(map, latlngs) {
    return this._buildPathData(map, latlngs, false);
  }

  static _polygonPathData(map, latlngs) {
    return this._buildPathData(map, latlngs, true);
  }

  /** Recursively flatten Leaflet latlng arrays into SVG path `d` commands. */
  static _buildPathData(map, latlngs, close) {
    if (!latlngs || latlngs.length === 0) return '';
    if (Array.isArray(latlngs[0]))
      return latlngs.map(sub => this._buildPathData(map, sub, close)).filter(Boolean).join(' ');

    let d = '';
    latlngs.forEach((ll, i) => {
      const pt = map.latLngToContainerPoint(ll);
      d += (i === 0 ? 'M' : 'L') + `${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`;
    });
    return close ? d + 'Z' : d;
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Marker layers (peak dots + labels)
  // ═══════════════════════════════════════════════════════════════════

  static _collectMarkers(map, markers) {
    const dots   = [];
    const labels = [];
    if (!markers) return { dots, labels };

    markers.forEach(m => {
      if (!map.hasLayer(m)) return;
      const el = m.getElement();
      if (!el) return;

      const pt      = map.latLngToContainerPoint(m.getLatLng());
      const cx      = pt.x;
      const cy      = pt.y;
      const opacity = this._esc(parseFloat(window.getComputedStyle(el).opacity) || 1);

      // Peak dot
      const dotEl = el.querySelector('.peak-dot') || el.querySelector('.collective-peak-dot');
      if (dotEl && window.getComputedStyle(dotEl).display !== 'none') {
        const ds = window.getComputedStyle(dotEl);
        dots.push(
          `<circle cx="${cx}" cy="${cy}" r="5"` +
          ` fill="${this._esc(ds.backgroundColor || '#f43f5e')}"` +
          ` stroke="${this._esc(ds.borderColor || '#ffffff')}"` +
          ` stroke-width="${this._esc(parseFloat(ds.borderWidth) || 1.5)}"` +
          ` opacity="${opacity}" />`
        );
      }

      // Text label
      const lbl = el.querySelector('.peak-map-label');
      if (!lbl || window.getComputedStyle(lbl).display === 'none') return;

      const ls   = window.getComputedStyle(lbl);
      const text = lbl.textContent.trim()
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

      const lr = lbl.getBoundingClientRect();
      const wr = el.getBoundingClientRect();
      const lx = cx + (lr.left - wr.left) + lr.width / 2;
      const ly = cy + (lr.top  - wr.top)  + lr.height * 0.78;

      labels.push(
        `<text x="${lx}" y="${ly}"` +
        ` font-size="${this._esc(ls.fontSize || '10px')}"` +
        ` font-weight="${this._esc(ls.fontWeight || '600')}"` +
        ` font-family="${this._esc(ls.fontFamily || 'sans-serif')}"` +
        ` fill="${LABEL_COLOR}" text-anchor="middle"` +
        ` opacity="${opacity}">${text}</text>`
      );
    });

    return { dots, labels };
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Shared helpers
  // ═══════════════════════════════════════════════════════════════════

  /** Build an <image> tag with both href and xlink:href for AI compat. */
  static _imageTag(x, y, w, h, dataUrl) {
    const u = this._esc(dataUrl);
    return `<image href="${u}" xlink:href="${u}" x="${x}" y="${y}" width="${w}" height="${h}" />`;
  }

  /** XML-escape an attribute value. */
  static _esc(val) {
    if (val === undefined || val === null) return '';
    return String(val)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ── Download ─────────────────────────────────────────────────────

  static _download(svgString, viewMode) {
    const blob = new Blob([svgString], { type: 'image/svg+xml' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.download = `biomapping_map_${viewMode}_export.svg`;
    a.href     = url;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
}

window.GSRMapExporter = GSRMapExporter;
