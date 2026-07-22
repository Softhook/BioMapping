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
    const proj = this._getProjection(mgr, el);
    return { map: mgr.map, el, r, w: proj.w, h: proj.h, project: proj.project, mgr };
  }

  static _getProjection(mgr, el) {
    const bounds = mgr?.getBounds ? mgr.getBounds() : null;
    if (bounds && typeof bounds.minLat === 'number' && !isNaN(bounds.minLat) && (bounds.maxLat - bounds.minLat) > 0) {
      const latSpan = bounds.maxLat - bounds.minLat;
      const lonSpan = bounds.maxLon - bounds.minLon;
      const padLat = latSpan > 0 ? latSpan * 0.05 : 0.005;
      const padLon = lonSpan > 0 ? lonSpan * 0.05 : 0.005;

      const minLat = bounds.minLat - padLat;
      const maxLat = bounds.maxLat + padLat;
      const minLon = bounds.minLon - padLon;
      const maxLon = bounds.maxLon + padLon;

      const mercY = lat => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
      const minY = mercY(minLat);
      const maxY = mercY(maxLat);
      const ySpan = maxY - minY;
      const xSpan = maxLon - minLon;

      const targetW = 2000;
      const targetH = Math.max(800, Math.min(4000, Math.round(targetW * (ySpan / (xSpan || 1)))));

      const project = (ll) => {
        if (!ll) return { x: 0, y: 0 };
        let lat, lon;
        if (Array.isArray(ll)) {
          lat = ll[0]; lon = ll[1];
        } else {
          lat = ll.lat !== undefined ? ll.lat : 0;
          lon = ll.lon !== undefined ? ll.lon : (ll.lng !== undefined ? ll.lng : 0);
        }
        const x = ((lon - minLon) / (xSpan || 1)) * targetW;
        const y = (1 - (mercY(lat) - minY) / (ySpan || 1)) * targetH;
        return { x, y };
      };

      return { w: targetW, h: targetH, project };
    }

    const w = el.clientWidth || 800;
    const h = el.clientHeight || 600;
    const project = (ll) => {
      if (!ll) return { x: 0, y: 0 };
      let lat, lon;
      if (Array.isArray(ll)) {
        lat = ll[0]; lon = ll[1];
      } else {
        lat = ll.lat !== undefined ? ll.lat : 0;
        lon = ll.lon !== undefined ? ll.lon : (ll.lng !== undefined ? ll.lng : 0);
      }
      return mgr.map.latLngToContainerPoint([lat, lon]);
    };
    return { w, h, project };
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Data gathering
  // ═══════════════════════════════════════════════════════════════════

  static async _gather(ctx) {
    const { map, el, r, mgr } = ctx;
    return {
      tiles:          await this._tiles(el, r),
      surface:        this._surface(ctx),
      osm:            this._vectors(ctx, mgr.osmLayers, { exact: true }),
      tracks:         this._vectors(ctx, [...mgr.pathSegments, ...mgr.collectivePathSegments]),
      contours:       this._vectors(ctx, mgr.contourLayers),
      clusters:       this._vectors(ctx, mgr.clusterLayers),
      dotsAndLabels:  this._markers(ctx, [...mgr.peakMarkers, ...mgr.collectivePeakMarkers]),
      hotspots:       this._markers(ctx, [...(mgr.hotspotMarkers || []), ...(mgr.collectiveHotspotMarkers || [])])
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  //  SVG rendering
  // ═══════════════════════════════════════════════════════════════════

  static _render(ctx, L) {
    const { w, h } = ctx;

    const g = (id, name, items, extra = '') =>
      `  <g i:layer="yes" id="${id}" data-name="${name}"${extra ? ' ' + extra : ''}>` +
      (items && items.length ? '\n' + items.map(e => '    ' + e).join('\n') + '\n  ' : '') +
      `</g>`;

    const surfObj = Array.isArray(L.surface)
      ? { mesh: [], isobands: [], raster: L.surface }
      : (L.surface || { mesh: [], isobands: [], raster: [] });

    const specs = [
      ['Base_Map_Tiles',          'Base Map Tiles',              L.tiles],
      ['Vector_Surface_Mesh',     'Vector Surface Mesh',         surfObj.mesh,        'opacity="0.4"'],
      ['Vector_Surface_Isobands', 'Vector Surface Isobands',     surfObj.isobands,    'opacity="0.5"'],
      ['Raster_Surface_Fallback', 'Raster Surface Fallback',     surfObj.raster,      'opacity="0.4"'],
      ['OSM_Shapes',              'OSM Shapes',                  L.osm],
      ['GPS_Track_Paths',         'GPS Track Paths',             L.tracks],
      ['Contour_Lines',           'Contour Lines',               L.contours],
      ['Cluster_Metaballs',       'Cluster Metaballs',           L.clusters],
      ['Stress_Peak_Dots',        'Stress Peak Dots',            L.dotsAndLabels.dots],
      ['Hotspot_Dots',            'Hotspot Dots',                L.hotspots.dots],
      ['Stress_Peak_Labels',      'Stress Peak Labels',          L.dotsAndLabels.labels]
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
    const tiles = Array.from(el.querySelectorAll('.leaflet-tile-pane img'));
    const jobs = tiles.map(async tile => {
      const b = tile.getBoundingClientRect();
      const url = await this._inlineImg(tile);
      return url ? this._img(b.left - r.left, b.top - r.top, b.width, b.height, url) : null;
    });
    const results = await Promise.all(jobs);
    return results.filter(Boolean);
  }

  /** canvas drawImage → fetch+blob → null */
  static async _inlineImg(img) {
    const src = img.getAttribute('src') || img.src;
    if (!src) return null;
    if (src.startsWith('data:')) return src;

    try {
      const c = Object.assign(document.createElement('canvas'), {
        width: img.naturalWidth || img.width || 256,
        height: img.naturalHeight || img.height || 256
      });
      c.getContext('2d').drawImage(img, 0, 0);
      const u = c.toDataURL('image/png');
      if (u?.startsWith('data:')) return u;
    } catch (_) { /* tainted */ }

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
  //  Surface & Projection Helpers
  // ═══════════════════════════════════════════════════════════════════

  static _hslToHex(h, s = 100, l = 50) {
    s /= 100;
    l /= 100;
    const a = s * Math.min(l, 1 - l);
    const f = n => {
      const k = (n + h / 30) % 12;
      const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
      return Math.round(255 * color).toString(16).padStart(2, '0');
    };
    return `#${f(0)}${f(8)}${f(4)}`;
  }

  static _ratioToHex(ratio) {
    const r = Math.max(0, Math.min(1, ratio));
    const hue = (1.0 - r) * 120; // 120 = Green, 60 = Yellow, 0 = Red
    return this._hslToHex(hue, 100, 50);
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Surface
  // ═══════════════════════════════════════════════════════════════════

  static _surface(ctx) {
    const { map, el, r, mgr } = ctx;
    const project = ctx.project || (ll => map.latLngToContainerPoint(ll));
    const res = {
      mesh: [],
      isobands: [],
      raster: []
    };

    // 1. If mgr.surfaceData exists, generate vector mesh and vector isobands
    const surfaceData = mgr?.surfaceData;
    if (surfaceData && surfaceData.grid && surfaceData.bounds) {
      const { grid, minVal, maxVal, bounds, sortedVals, contours } = surfaceData;
      const rows = grid.length;
      const cols = grid[0].length;
      const valRange = maxVal - minVal;
      const rangeEpsilon = 1e-9;
      const useRankColor = sortedVals && sortedVals.length > 1;

      // ── A. Vector Mesh Cell Polygons ───────────────────────────────
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const val = grid[row][col];
          if (val === null || isNaN(val)) continue;

          let ratio;
          if (useRankColor && typeof StatsMath !== 'undefined' && typeof StatsMath.percentileRank === 'function') {
            ratio = StatsMath.percentileRank(val, sortedVals);
          } else {
            ratio = valRange > rangeEpsilon ? (val - minVal) / valRange : 0.5;
          }

          const fillColor = this._ratioToHex(ratio);

          const dLat = (rows > 1) ? 0.5 * (bounds.maxLat - bounds.minLat) / (rows - 1) : 0;
          const dLon = (cols > 1) ? 0.5 * (bounds.maxLon - bounds.minLon) / (cols - 1) : 0;
          const gridLat = (rows > 1) ? bounds.minLat + (row / (rows - 1)) * (bounds.maxLat - bounds.minLat) : bounds.minLat;
          const gridLon = (cols > 1) ? bounds.minLon + (col / (cols - 1)) * (bounds.maxLon - bounds.minLon) : bounds.minLon;

          const latSouth = gridLat - dLat;
          const latNorth = gridLat + dLat;
          const lonWest  = gridLon - dLon;
          const lonEast  = gridLon + dLon;

          const pNW = project([latNorth, lonWest]);
          const pNE = project([latNorth, lonEast]);
          const pSE = project([latSouth, lonEast]);
          const pSW = project([latSouth, lonWest]);

          const pointsStr = `${pNW.x.toFixed(3)},${pNW.y.toFixed(3)} ${pNE.x.toFixed(3)},${pNE.y.toFixed(3)} ${pSE.x.toFixed(3)},${pSE.y.toFixed(3)} ${pSW.x.toFixed(3)},${pSW.y.toFixed(3)}`;
          
          res.mesh.push(
            `<polygon points="${pointsStr}" fill="${this._esc(fillColor)}" stroke="${this._esc(fillColor)}" stroke-width="0.5" stroke-linejoin="round" />`
          );
        }
      }

      // ── B. Vector Isoband Fills (per-cell clip) & Isoline Outlines ──
      //
      // Previously the fill for each isoband came from the marching-squares isoline
      // itself: paths were stitched from raw segments, and only stitched paths whose
      // start/end points happened to coincide (isClosed) were filled — anything the
      // grid boundary cut off partway through (i.e. any region touching the edge of
      // the map extent) came back as an open path and was rendered as an unfilled
      // stroke instead, which is why isobands at the edge of the map never showed
      // their green fill.
      //
      // Fix: derive the fill independently, per grid cell, via Sutherland-Hodgman
      // clipping (_clipCellIsoband) against "value >= level". A boundary cell's own
      // corners already sit exactly on the map extent, so its clipped polygon is
      // closed by construction — there is no separate "closing" step that can go
      // wrong, and the fill runs flush to the edge instead of stopping short of it.
      // The marching-squares isoline is kept only as a thin decorative outline
      // (fill:none), where being open at the edge is harmless.
      if (contours && Array.isArray(contours)) {
        const getLatLng = (r, c) => ({
          lat: bounds.minLat + (r / (rows - 1)) * (bounds.maxLat - bounds.minLat),
          lon: bounds.minLon + (c / (cols - 1)) * (bounds.maxLon - bounds.minLon)
        });

        contours.forEach(c => {
          const fillColor = this._ratioToHex(c.ratio);
          const level = c.level;

          // B1. Filled isoband polygons, tiled from clipped grid cells.
          for (let row = 0; row < rows - 1; row++) {
            for (let col = 0; col < cols - 1; col++) {
              const vNW = grid[row][col];
              const vNE = grid[row][col + 1];
              const vSE = grid[row + 1][col + 1];
              const vSW = grid[row + 1][col];
              if (vNW === null || vNE === null || vSE === null || vSW === null ||
                  isNaN(vNW) || isNaN(vNE) || isNaN(vSE) || isNaN(vSW)) continue;
              // Cell has no overlap with this band at all — skip early.
              if (vNW < level && vNE < level && vSE < level && vSW < level) continue;

              const corners = [
                { ...getLatLng(row, col),         val: vNW },
                { ...getLatLng(row, col + 1),     val: vNE },
                { ...getLatLng(row + 1, col + 1), val: vSE },
                { ...getLatLng(row + 1, col),     val: vSW }
              ];

              // vb = Infinity: this band is "everything at or above `level`" — matches
              // the old closed-ring semantics of "the area enclosed by this isoline",
              // just clipped per-cell instead of traced as one big loop.
              const poly = this._clipCellIsoband(corners, level, Infinity);
              if (!poly) continue;

              const pts = poly.map(p => project(p)).filter(p => p && typeof p.x === 'number' && !isNaN(p.x));
              if (pts.length < 3) continue;

              const d = `M${pts.map(p => `${p.x.toFixed(3)} ${p.y.toFixed(3)}`).join(' L')} Z`;
              res.isobands.push(
                `<path d="${d}" fill="${this._esc(fillColor)}" fill-opacity="0.45" stroke="none" />`
              );
            }
          }

          // B2. Thin decorative outline traced from the raw marching-squares isoline.
          // Purely cosmetic (fill="none"), so unlike the fill above it never needs to
          // be a closed loop — a stroke that runs off the edge of the map is fine.
          const stitchedPaths = (typeof GSRSpatialClustering !== 'undefined' && typeof GSRSpatialClustering.stitchSegments === 'function')
            ? GSRSpatialClustering.stitchSegments(c.segments)
            : (c.segments || []).map(seg => [seg[0], seg[1]]);

          stitchedPaths.forEach(rawPath => {
            if (!rawPath || rawPath.length < 2) return;

            const isClosed = rawPath.length >= 3 &&
              Math.abs((rawPath[0].lat ?? rawPath[0][0]) - (rawPath[rawPath.length - 1].lat ?? rawPath[rawPath.length - 1][0])) < 1e-9 &&
              Math.abs((rawPath[0].lon ?? rawPath[0][1]) - (rawPath[rawPath.length - 1].lon ?? rawPath[rawPath.length - 1][1])) < 1e-9;

            const smoothed = (typeof GeoUtils !== 'undefined' && typeof GeoUtils.chaikinSmooth === 'function')
              ? GeoUtils.chaikinSmooth(rawPath, 2, isClosed)
              : rawPath;
            const d = this._pathD(ctx, smoothed, isClosed, true);
            if (!d) return;

            res.isobands.push(
              `<path d="${d}" fill="none" stroke="${this._esc(fillColor)}" stroke-width="1.2" stroke-opacity="0.8" stroke-linejoin="round" stroke-linecap="round" />`
            );
          });
        });
      }
    }

    // ── C. Raster Surface Fallback ──────────────────────────────────
    const overlay = mgr?.surfaceOverlay;
    if (overlay) {
      try {
        const bounds = overlay.getBounds();
        const tl = project(bounds.getNorthWest());
        const br = project(bounds.getSouthEast());
        const x = tl.x, y = tl.y, w = br.x - tl.x, h = br.y - tl.y;
        const src = overlay._url || (overlay.getElement() ? overlay.getElement().src : null);
        if (src) res.raster.push(this._img(x, y, w, h, src));
      } catch (e) {
        console.warn("Raster surface overlay bounds export failed:", e);
      }
    }
    if (res.raster.length === 0) {
      const img = el.querySelector('.collective-surface-overlay');
      if (img) {
        const b = img.getBoundingClientRect();
        res.raster.push(this._img(b.left - r.left, b.top - r.top, b.width, b.height, img.src));
      }
    }

    return res;
  }

  static _clipCellIsoband(corners, va, vb) {
    if (!corners || corners.length < 3) return null;

    // 1. Clip quadrilateral against scalar threshold V >= va
    let poly = [];
    let n = corners.length;
    for (let i = 0; i < n; i++) {
      const pA = corners[i];
      const pB = corners[(i + 1) % n];
      const inA = pA.val >= va;
      const inB = pB.val >= va;

      if (inA && inB) {
        poly.push(pB);
      } else if (inA && !inB) {
        const t = (va - pA.val) / (pB.val - pA.val || 1e-9);
        poly.push({
          lat: pA.lat + t * (pB.lat - pA.lat),
          lon: pA.lon + t * (pB.lon - pA.lon),
          val: va
        });
      } else if (!inA && inB) {
        const t = (va - pA.val) / (pB.val - pA.val || 1e-9);
        poly.push({
          lat: pA.lat + t * (pB.lat - pA.lat),
          lon: pA.lon + t * (pB.lon - pA.lon),
          val: va
        });
        poly.push(pB);
      }
    }

    if (poly.length < 3) return null;

    // 2. Clip resulting polygon against scalar threshold V <= vb
    let finalPoly = [];
    n = poly.length;
    for (let i = 0; i < n; i++) {
      const pA = poly[i];
      const pB = poly[(i + 1) % n];
      const inA = pA.val <= vb;
      const inB = pB.val <= vb;

      if (inA && inB) {
        finalPoly.push(pB);
      } else if (inA && !inB) {
        const t = (vb - pA.val) / (pB.val - pA.val || 1e-9);
        finalPoly.push({
          lat: pA.lat + t * (pB.lat - pA.lat),
          lon: pA.lon + t * (pB.lon - pA.lon),
          val: vb
        });
      } else if (!inA && inB) {
        const t = (vb - pA.val) / (pB.val - pA.val || 1e-9);
        finalPoly.push({
          lat: pA.lat + t * (pB.lat - pA.lat),
          lon: pA.lon + t * (pB.lon - pA.lon),
          val: vb
        });
        finalPoly.push(pB);
      }
    }

    return finalPoly.length >= 3 ? finalPoly : null;
  }



  // ═══════════════════════════════════════════════════════════════════
  //  Vector layers
  // ═══════════════════════════════════════════════════════════════════

  static _vectors(ctx, layers, opts) {
    const out = [];
    if (!layers) return out;
    for (const l of layers) {
      const svg = this._pathEl(ctx, l, opts);
      if (svg) out.push(svg);
    }
    return out;
  }

  static _pathEl(ctx, layer, opts = {}) {
    if (!layer || typeof layer.getLatLngs !== 'function') return null;
    let latlngs = layer.getLatLngs();
    const isPoly  = window.L && layer instanceof window.L.Polygon;
    // "exact" layers (OSM building/park/water shapes) are authoritative vector
    // geometry, not sensor data — every vertex is a real, deliberate coordinate,
    // so none of the GPS-track-oriented smoothing/culling below should touch them.
    const exact = !!opts.exact;

    // Apply Chaikin pre-smoothing to track paths to filter micro-jitter before screen projection
    if (!isPoly && !exact && Array.isArray(latlngs) && latlngs.length >= 3 && typeof GeoUtils !== 'undefined') {
      try {
        const flat = Array.isArray(latlngs[0]) ? latlngs.flat() : latlngs;
        if (flat.length >= 3 && flat[0] && (typeof flat[0].lat === 'number' || Array.isArray(flat[0]))) {
          latlngs = GeoUtils.chaikinSmooth(flat, 2, false);
        }
      } catch (_) {}
    }

    const d = this._pathD(ctx, latlngs, isPoly, !exact, exact);
    if (!d) return null;

    const o = layer.options || {};
    const esc = this._esc;
    // Reduced, elegant stroke size: 1.2px thin stroke for exported track vectors.
    // Exact/OSM shapes keep their authored weight untouched — no cosmetic thinning.
    const strokeWidth = exact
      ? (o.weight !== undefined ? o.weight : 1)
      : (o.weight !== undefined ? Math.min(1.5, o.weight * 0.4) : 1.2);
    return `<path d="${d}"` +
      ` stroke="${esc(o.color || '#ff7b00')}"` +
      ` stroke-width="${esc(strokeWidth)}"` +
      ` stroke-opacity="${esc(o.opacity ?? 0.85)}"` +
      ` stroke-dasharray="${esc(o.dashArray || 'none')}"` +
      ` fill="${esc(isPoly ? (o.fillColor || o.color || '#ff7b00') : 'none')}"` +
      ` fill-opacity="${esc(isPoly ? (o.fillOpacity ?? 0.2) : 0)}"` +
      (exact
        ? ` stroke-linecap="square" stroke-linejoin="miter" />`
        : ` stroke-linecap="round" stroke-linejoin="round" />`);
  }

  static _pathD(ctx, latlngs, close, smooth = true, exact = false) {
    if (!latlngs?.length) return '';
    const project = (typeof ctx === 'function')
      ? ctx
      : (ctx?.project
        ? ctx.project
        : (ll => (ctx?.map?.latLngToContainerPoint ? ctx.map.latLngToContainerPoint(ll) : (ctx?.latLngToContainerPoint ? ctx.latLngToContainerPoint(ll) : { x: 0, y: 0 }))));

    if (Array.isArray(latlngs[0]))
      return latlngs.map(s => this._pathD(ctx, s, close, smooth, exact)).filter(Boolean).join(' ');

    const rawPts = latlngs.map(ll => project(ll)).filter(p => p && typeof p.x === 'number' && !isNaN(p.x));
    if (rawPts.length === 0) return '';
    if (rawPts.length === 1) return `M${rawPts[0].x.toFixed(3)} ${rawPts[0].y.toFixed(3)}`;

    // Exact mode (OSM shapes): keep every projected vertex verbatim — no micro-jitter
    // culling. That culling exists to smooth out GPS/sensor noise on track paths; on
    // authoritative building/road/water outlines it silently deletes real corners
    // whenever two vertices happen to land within ~1.5px of each other on screen.
    let pts;
    if (exact) {
      pts = rawPts;
    } else {
      // Filter consecutive micro-jitter points in pixel space (< 1.5px apart)
      pts = [rawPts[0]];
      for (let i = 1; i < rawPts.length; i++) {
        const prev = pts[pts.length - 1];
        const curr = rawPts[i];
        if (!curr || !prev) continue;
        const distSq = (curr.x - prev.x) ** 2 + (curr.y - prev.y) ** 2;
        if (i === rawPts.length - 1 || distSq >= 2.25) {
          pts.push(curr);
        }
      }
    }

    if (pts.length < 2) return `M${rawPts[0].x.toFixed(3)} ${rawPts[0].y.toFixed(3)}`;
    if (pts.length === 2 || !smooth || exact) {
      let d = `M${pts[0].x.toFixed(3)} ${pts[0].y.toFixed(3)}`;
      for (let i = 1; i < pts.length; i++) {
        d += ` L${pts[i].x.toFixed(3)} ${pts[i].y.toFixed(3)}`;
      }
      return close ? d + ' Z' : d;
    }

    // Catmull-Rom to Cubic Bézier spline smoothing for continuous, smooth strokes
    let d = `M${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
    const n = pts.length;
    for (let i = 0; i < n - 1; i++) {
      const pPrev = pts[Math.max(0, i - 1)];
      const pCurr = pts[i];
      const pNext = pts[i + 1];
      const pFut  = pts[Math.min(n - 1, i + 2)];

      const c1x = pCurr.x + (pNext.x - pPrev.x) / 6;
      const c1y = pCurr.y + (pNext.y - pPrev.y) / 6;
      const c2x = pNext.x - (pFut.x - pCurr.x) / 6;
      const c2y = pNext.y - (pFut.y - pCurr.y) / 6;

      d += ` C${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${pNext.x.toFixed(1)} ${pNext.y.toFixed(1)}`;
    }
    return close ? d + ' Z' : d;
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Markers
  // ═══════════════════════════════════════════════════════════════════

  static _markers(ctx, markers) {
    const dots = [], labels = [];
    if (!markers) return { dots, labels };
    const leafletMap = ctx?.map || (ctx?.hasLayer ? ctx : null);
    const project = ctx?.project || (ll => (leafletMap?.latLngToContainerPoint ? leafletMap.latLngToContainerPoint(ll) : { x: 0, y: 0 }));

    for (const m of markers) {
      if (!m) continue;
      if (leafletMap && typeof leafletMap.hasLayer === 'function' && !leafletMap.hasLayer(m)) continue;
      const el = typeof m.getElement === 'function' ? m.getElement() : null;
      if (!el) continue;

      const p = project(m.getLatLng());
      if (!p || typeof p.x !== 'number') continue;
      const cx = p.x, cy = p.y;
      const op = this._esc(parseFloat(window.getComputedStyle(el).opacity) || 1);

      const d = this._dotSvg(el, cx, cy, op);
      if (d) dots.push(d);
      const l = this._labelSvg(el, cx, cy, op);
      if (l) labels.push(l);
    }
    return { dots, labels };
  }

  static _dotSvg(el, cx, cy, opacity) {
    const dot = el.querySelector('.peak-dot') || el.querySelector('.hotspot-dot');
    if (!dot || window.getComputedStyle(dot).display === 'none') return null;
    const s = window.getComputedStyle(dot);
    const strokeWidth = (parseFloat(s.borderWidth) || 1.5) * 0.5;
    // Radius = half the CSS dot's own diameter, so the exported dot matches
    // its in-app rendered size. Was width*0.15 (~30% of the correct radius)
    // — a leftover fudge factor that made every exported dot render far
    // smaller/fainter than what's shown live in the browser.
    const r = (parseFloat(s.width) || 10) * 0.5;
    return `<circle cx="${cx}" cy="${cy}" r="${r}"` +
      ` fill="${this._esc(s.backgroundColor || '#f43f5e')}"` +
      ` stroke="${this._esc(s.borderColor || '#ffffff')}"` +
      ` stroke-width="${this._esc(strokeWidth)}"` +
      ` opacity="${opacity}" />`;
  }

  static _labelSvg(el, cx, cy, opacity) {
    const lbl = el.querySelector('.peak-map-label');
    if (!lbl || window.getComputedStyle(lbl).display === 'none') return null;

    const ls = window.getComputedStyle(lbl);
    const tx = lbl.textContent.trim()
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    let x = cx;
    let y = cy - 8;

    try {
      const lr = lbl.getBoundingClientRect();
      const wr = el.getBoundingClientRect();
      if (lr && wr && wr.width > 0) {
        x = cx + (lr.left - wr.left) + lr.width / 2;
        y = cy + (lr.top - wr.top) + lr.height * 0.78;
      }
    } catch (_) {}

    return `<text x="${x.toFixed(3)}"` +
      ` y="${y.toFixed(3)}"` +
      ` font-size="${this._esc(ls.fontSize || '11px')}"` +
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
