/**
 * GSR Map SVG Exporter Utility.
 * Compiles Leaflet raster and vector panes into a single
 * Illustrator-compatible layered SVG with zero external references.
 */
const SVG_NS   = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';
const AI_NS    = 'http://ns.adobe.com/AdobeIllustrator/10.0/';
const BG       = '#0b0d16';
const LABEL    = '#000000';

class GSRMapExporter {

  // ═══════════════════════════════════════════════════════════════════
  //  Public
  // ═══════════════════════════════════════════════════════════════════

  static async exportToSvg(mgr) {
    const ctx = this._validate(mgr);
    if (!ctx) return;

    const layers = await this._gather(ctx);
    this._download(this._render(ctx, layers), AppState.viewMode || 'single');
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Validation
  // ═══════════════════════════════════════════════════════════════════

  static _validate(mgr) {
    if (!mgr?.map) { alert("Map not initialized."); return null; }
    const el = document.getElementById(mgr.containerId);
    if (!el)     { alert("Map container not found."); return null; }
    const r = el.getBoundingClientRect();
    return { map: mgr.map, el, r, w: el.clientWidth || 800, h: el.clientHeight || 600, mgr };
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Data gathering
  // ═══════════════════════════════════════════════════════════════════

  static async _gather(ctx) {
    const { map, el, r, mgr } = ctx;
    return {
      tiles:          await this._tiles(el, r),
      surface:        this._surface(ctx),
      osm:            this._vectors(map, mgr.osmLayers),
      tracks:         this._vectors(map, [...mgr.pathSegments, ...mgr.collectivePathSegments]),
      contours:       this._vectors(map, mgr.contourLayers),
      clusters:       this._vectors(map, mgr.clusterLayers),
      dotsAndLabels:  this._markers(map, [...mgr.peakMarkers, ...mgr.collectivePeakMarkers])
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  //  SVG rendering
  // ═══════════════════════════════════════════════════════════════════

  static _render(ctx, L) {
    const { w, h } = ctx;

    const g = (id, name, items, extra = '') =>
      `  <g i:layer="yes" id="${id}" data-name="${name}"${extra ? ' ' + extra : ''}>` +
      (items.length ? '\n' + items.map(e => '    ' + e).join('\n') + '\n  ' : '') +
      `</g>`;

    const specs = [
      ['Base_Map_Tiles',     'Base Map Tiles',              L.tiles],
      ['Shaded_Contours',    'Shaded Contours',             L.surface,      'opacity="0.4"'],
      ['OSM_Shapes',         'OSM Shapes',                  L.osm],
      ['GPS_Track_Paths',    'GPS Track Paths',             L.tracks],
      ['Contour_Lines',      'Contour Lines',               L.contours],
      ['Cluster_Metaballs',  'Cluster Metaballs',           L.clusters],
      ['Stress_Peak_Dots',   'Stress Peak Dots',            L.dotsAndLabels.dots],
      ['Stress_Peak_Labels', 'Stress Peak Labels',          L.dotsAndLabels.labels]
    ];

    return [
      `<svg xmlns="${SVG_NS}" xmlns:xlink="${XLINK_NS}" xmlns:i="${AI_NS}" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">`,
      `  <rect x="0" y="0" width="${w}" height="${h}" fill="${BG}" />`,
      ...specs.map(s => g(...s)),
      '</svg>'
    ].join('\n');
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Tiles
  // ═══════════════════════════════════════════════════════════════════

  static async _tiles(el, r) {
    const out = [];
    const jobs = Array.from(el.querySelectorAll('.leaflet-tile-pane img'), tile => {
      const b = tile.getBoundingClientRect();
      return this._inlineImg(tile).then(url => {
        if (url) out.push(this._img(b.left - r.left, b.top - r.top, b.width, b.height, url));
      });
    });
    await Promise.all(jobs);
    return out;
  }

  /** canvas drawImage → fetch+blob → null */
  static async _inlineImg(img) {
    try {
      const c = Object.assign(document.createElement('canvas'), {
        width: img.naturalWidth || img.width || 256,
        height: img.naturalHeight || img.height || 256
      });
      c.getContext('2d').drawImage(img, 0, 0);
      const u = c.toDataURL('image/png');
      if (u?.startsWith('data:')) return u;
    } catch (_) { /* tainted */ }

    const src = img.getAttribute('src') || img.src;
    if (!src) return null;
    try {
      const res = await fetch(src, { mode: 'cors' });
      if (!res.ok) return null;
      const blob = await res.blob();
      return await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onloadend = () => resolve(fr.result);
        fr.onerror = reject;
        fr.readAsDataURL(blob);
      });
    } catch (_) { return null; }
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Surface
  // ═══════════════════════════════════════════════════════════════════

  static _surface(ctx) {
    const { map, el, r, mgr } = ctx;
    const overlay = mgr.surfaceOverlay;
    if (overlay && typeof overlay.getBounds === 'function') {
      try {
        const bounds = overlay.getBounds();
        const tl = map.latLngToContainerPoint(bounds.getNorthWest());
        const br = map.latLngToContainerPoint(bounds.getSouthEast());
        const x = tl.x;
        const y = tl.y;
        const w = br.x - tl.x;
        const h = br.y - tl.y;

        const imgEl = el.querySelector('.leaflet-overlay-pane img.collective-surface-overlay');
        if (imgEl) {
          return [this._img(x, y, w, h, imgEl.src)];
        }
      } catch (e) {
        console.warn("Mathematically aligned contour surface export failed, falling back to DOM bounds:", e);
      }
    }

    const img = el.querySelector('.leaflet-overlay-pane img.collective-surface-overlay');
    if (img) {
      const b = img.getBoundingClientRect();
      return [this._img(b.left - r.left, b.top - r.top, b.width, b.height, img.src)];
    }
    const canvas = el.querySelector('.leaflet-overlay-pane canvas');
    if (canvas) {
      try {
        const b = canvas.getBoundingClientRect();
        return [this._img(b.left - r.left, b.top - r.top, b.width, b.height, canvas.toDataURL('image/png'))];
      } catch (e) { console.warn("Contour surface export failed:", e); }
    }
    return [];
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Vector layers
  // ═══════════════════════════════════════════════════════════════════

  static _vectors(map, layers) {
    const out = [];
    if (!layers) return out;
    for (const l of layers) {
      const svg = this._pathEl(map, l);
      if (svg) out.push(svg);
    }
    return out;
  }

  static _pathEl(map, layer) {
    if (!layer || typeof layer.getLatLngs !== 'function') return null;
    const latlngs = layer.getLatLngs();
    const isPoly  = layer instanceof L.Polygon;
    const d = this._pathD(map, latlngs, isPoly);
    if (!d) return null;

    const o = layer.options || {};
    const esc = this._esc;
    return `<path d="${d}"` +
      ` stroke="${esc(o.color || '#ff7b00')}"` +
      ` stroke-width="${esc(o.weight || 3)}"` +
      ` stroke-opacity="${esc(o.opacity ?? 0.85)}"` +
      ` stroke-dasharray="${esc(o.dashArray || 'none')}"` +
      ` fill="${esc(isPoly ? (o.fillColor || o.color || '#ff7b00') : 'none')}"` +
      ` fill-opacity="${esc(isPoly ? (o.fillOpacity ?? 0.2) : 0)}"` +
      ` stroke-linecap="round" stroke-linejoin="round" />`;
  }

  static _pathD(map, latlngs, close) {
    if (!latlngs?.length) return '';
    if (Array.isArray(latlngs[0]))
      return latlngs.map(s => this._pathD(map, s, close)).filter(Boolean).join(' ');

    let d = '';
    latlngs.forEach((ll, i) => {
      const p = map.latLngToContainerPoint(ll);
      d += (i ? 'L' : 'M') + `${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
    });
    return close ? d + 'Z' : d;
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Markers
  // ═══════════════════════════════════════════════════════════════════

  static _markers(map, markers) {
    const dots = [], labels = [];
    if (!markers) return { dots, labels };

    for (const m of markers) {
      if (!map.hasLayer(m)) continue;
      const el = m.getElement();
      if (!el) continue;

      const p   = map.latLngToContainerPoint(m.getLatLng());
      const cx  = p.x, cy = p.y;
      const op  = this._esc(parseFloat(window.getComputedStyle(el).opacity) || 1);

      const d = this._dotSvg(el, cx, cy, op);
      if (d) dots.push(d);
      const l = this._labelSvg(el, cx, cy, op);
      if (l) labels.push(l);
    }
    return { dots, labels };
  }

  static _dotSvg(el, cx, cy, opacity) {
    const dot = el.querySelector('.peak-dot') || el.querySelector('.collective-peak-dot');
    if (!dot || window.getComputedStyle(dot).display === 'none') return null;
    const s = window.getComputedStyle(dot);
    return `<circle cx="${cx}" cy="${cy}" r="5"` +
      ` fill="${this._esc(s.backgroundColor || '#f43f5e')}"` +
      ` stroke="${this._esc(s.borderColor || '#ffffff')}"` +
      ` stroke-width="${this._esc(parseFloat(s.borderWidth) || 1.5)}"` +
      ` opacity="${opacity}" />`;
  }

  static _labelSvg(el, cx, cy, opacity) {
    const lbl = el.querySelector('.peak-map-label');
    if (!lbl || window.getComputedStyle(lbl).display === 'none') return null;

    const ls = window.getComputedStyle(lbl);
    const tx = lbl.textContent.trim()
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    const lr = lbl.getBoundingClientRect();
    const wr = el.getBoundingClientRect();

    return `<text x="${cx + (lr.left - wr.left) + lr.width / 2}"` +
      ` y="${cy + (lr.top - wr.top) + lr.height * 0.78}"` +
      ` font-size="${this._esc(ls.fontSize || '10px')}"` +
      ` font-weight="${this._esc(ls.fontWeight || '600')}"` +
      ` font-family="${this._esc(ls.fontFamily || 'sans-serif')}"` +
      ` fill="${LABEL}" text-anchor="middle"` +
      ` opacity="${opacity}">${tx}</text>`;
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Shared
  // ═══════════════════════════════════════════════════════════════════

  static _img(x, y, w, h, url) {
    const u = this._esc(url);
    return `<image href="${u}" xlink:href="${u}" x="${x}" y="${y}" width="${w}" height="${h}" />`;
  }

  static _esc(v) {
    if (v == null) return '';
    return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  static _download(svg, mode) {
    const b = new Blob([svg], { type: 'image/svg+xml' });
    const u = URL.createObjectURL(b);
    const a = Object.assign(document.createElement('a'), {
      download: `biomapping_map_${mode}_export.svg`, href: u
    });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(u);
  }
}

window.GSRMapExporter = GSRMapExporter;
