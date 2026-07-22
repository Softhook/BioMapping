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
    let ctx = this._validate(mgr);
    if (!ctx) return;

    // Isobands at the map edge are drawn extending past the original frame
    // (see _closeOpenIsobandPaths / _tangentExtrapolate) rather than being
    // squared off against it. Growing the canvas here — instead of drawing
    // that extension and then clipping it away — means everything in the
    // export is actually visible; there's no invisible geometry to keep in
    // sync with a clip region.
    ctx = this._expandCanvasForIsobands(ctx);

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

  /**
   * Bounding box (in the SVG's own coordinate space) of a path `d` string built
   * from M / L / C / Z commands only (i.e. anything _pathD can produce). Curves
   * are flattened by sampling the cubic Bézier at a fine resolution rather than
   * just looking at control points, since a Bézier's control points can lie
   * outside the box the curve itself actually sweeps through — but for these
   * gently-rounded contour paths the control points are a close enough envelope
   * and cheap to test directly, so start there and only sample when a curve is
   * present.
   */
  static _pathBBox(d) {
    if (!d) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const see = (x, y) => {
      if (isNaN(x) || isNaN(y)) return;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    };

    const cubicAt = (p0, p1, p2, p3, t) => {
      const mt = 1 - t;
      const a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, e = t * t * t;
      return { x: a * p0.x + b * p1.x + c * p2.x + e * p3.x, y: a * p0.y + b * p1.y + c * p2.y + e * p3.y };
    };

    const tokens = d.match(/[MLCZ][^MLCZ]*/gi);
    if (!tokens) return null;

    let cur = { x: 0, y: 0 };
    tokens.forEach(tok => {
      const cmd = tok[0];
      const nums = (tok.slice(1).match(/-?\d*\.?\d+(?:e-?\d+)?/gi) || []).map(Number);
      if (cmd === 'M' || cmd === 'L') {
        for (let i = 0; i + 1 < nums.length; i += 2) {
          cur = { x: nums[i], y: nums[i + 1] };
          see(cur.x, cur.y);
        }
      } else if (cmd === 'C') {
        for (let i = 0; i + 5 < nums.length; i += 6) {
          const p1 = { x: nums[i], y: nums[i + 1] };
          const p2 = { x: nums[i + 2], y: nums[i + 3] };
          const p3 = { x: nums[i + 4], y: nums[i + 5] };
          see(p1.x, p1.y); see(p2.x, p2.y); see(p3.x, p3.y);
          const STEPS = 12;
          for (let s = 1; s < STEPS; s++) {
            const pt = cubicAt(cur, p1, p2, p3, s / STEPS);
            see(pt.x, pt.y);
          }
          cur = p3;
        }
      }
      // 'Z' carries no coordinates.
    });

    if (!isFinite(minX)) return null;
    return { minX, minY, maxX, maxY };
  }

  /**
   * Runs the isoband layer once against the base (un-expanded) projection just
   * to measure how far the extrapolated edge contours actually reach, then
   * returns a new ctx whose canvas (w/h) and projection are grown/shifted so
   * that full extent is visible with a small safety margin — instead of
   * drawing that extension and clipping it away, we just make room for it.
   */
  static _expandCanvasForIsobands(ctx) {
    const surfObj = this._surface(ctx);
    const paths = (surfObj && surfObj.isobands) || [];
    if (!paths.length) return ctx;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    paths.forEach(p => {
      const m = p.match(/d="([^"]*)"/);
      if (!m) return;
      const bbox = this._pathBBox(m[1]);
      if (!bbox) return;
      if (bbox.minX < minX) minX = bbox.minX;
      if (bbox.minY < minY) minY = bbox.minY;
      if (bbox.maxX > maxX) maxX = bbox.maxX;
      if (bbox.maxY > maxY) maxY = bbox.maxY;
    });
    if (!isFinite(minX)) return ctx;

    const { w, h, project } = ctx;
    // A little extra breathing room beyond the measured extent, so a stroked
    // outline (which sits centered on the fill's edge) doesn't get shaved by
    // sub-pixel rounding at the new canvas edge.
    const SAFETY = 4;
    const marginLeft   = Math.max(0, Math.ceil(-minX + SAFETY));
    const marginTop    = Math.max(0, Math.ceil(-minY + SAFETY));
    const marginRight  = Math.max(0, Math.ceil(maxX - w + SAFETY));
    const marginBottom = Math.max(0, Math.ceil(maxY - h + SAFETY));

    if (!marginLeft && !marginTop && !marginRight && !marginBottom) return ctx;

    const newW = w + marginLeft + marginRight;
    const newH = h + marginTop + marginBottom;
    const newProject = (ll) => {
      const p = project(ll);
      return { x: p.x + marginLeft, y: p.y + marginTop };
    };

    return { ...ctx, w: newW, h: newH, project: newProject };
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
      // Isobands at the map edge are deliberately extrapolated past the original
      // frame (so the curve reads as continuing into an unbounded field rather
      // than being squared off against the boundary). Rather than hiding that
      // extension behind a clip-path, exportToSvg() grows the canvas ahead of
      // time (_expandCanvasForIsobands) so the full rounded shape is genuinely
      // visible here — nothing in this layer is invisible or clipped.
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

      // ── B. Vector Isoband Fills (smooth, boundary-closed) & Isoline Outlines ──
      //
      // Interior isoband rings (fully enclosed within the grid) are already closed
      // by marching squares + stitching, so they're smoothed and filled directly —
      // same as they always were. Rings that get cut off by the edge of the grid/map
      // extent trace out as an OPEN path instead, because marching squares only
      // follows the contour where it crosses a cell edge and simply stops once it
      // runs off the grid.
      //
      // Those open paths are closed here (_closeOpenIsobandPaths) by walking the
      // actual boundary rectangle between pairs of open ends, using the grid's own
      // boundary values to work out which side of the rectangle is really "inside"
      // the band — between any two adjacent boundary crossings the value can't cross
      // the isolevel again, so sampling the midpoint settles it unambiguously. That
      // replaces an earlier version of this code which instead guessed "whichever
      // way around the rectangle is numerically shorter", which isn't the same thing
      // and produced a straight chord cutting across the shape whenever it guessed
      // wrong — and a later version which gave up on closing the smooth curve
      // altogether and filled a blocky per-grid-cell tiling instead. Neither is
      // needed: closing the same smooth curve correctly gives a fill that simply
      // continues along the map edge, with no seam and no blockiness.
      if (contours && Array.isArray(contours)) {
        contours.forEach(c => {
          const fillColor = this._ratioToHex(c.ratio);
          const level = c.level;

          const stitchedPaths = (typeof GSRSpatialClustering !== 'undefined' && typeof GSRSpatialClustering.stitchSegments === 'function')
            ? GSRSpatialClustering.stitchSegments(c.segments)
            : (c.segments || []).map(seg => [seg[0], seg[1]]);

          const isClosedPath = (rawPath) => rawPath.length >= 3 &&
            Math.abs((rawPath[0].lat ?? rawPath[0][0]) - (rawPath[rawPath.length - 1].lat ?? rawPath[rawPath.length - 1][0])) < 1e-9 &&
            Math.abs((rawPath[0].lon ?? rawPath[0][1]) - (rawPath[rawPath.length - 1].lon ?? rawPath[rawPath.length - 1][1])) < 1e-9;

          const closedPaths = [];
          const openPaths = [];
          stitchedPaths.forEach(rawPath => {
            if (!rawPath || rawPath.length < 2) return;
            (isClosedPath(rawPath) ? closedPaths : openPaths).push(rawPath);
          });

          const smoothRing = (ring) => (typeof GeoUtils !== 'undefined' && typeof GeoUtils.chaikinSmooth === 'function')
            ? GeoUtils.chaikinSmooth(ring, 2, true)
            : ring;

          const fillRing = (ring) => {
            const d = this._pathD(ctx, smoothRing(ring), true, true);
            if (!d) return;
            res.isobands.push(
              `<path d="${d}" fill="${this._esc(fillColor)}" fill-opacity="0.45" stroke="none" />`
            );
          };
          const strokeRing = (ring) => {
            const d = this._pathD(ctx, smoothRing(ring), true, true);
            if (!d) return;
            res.isobands.push(
              `<path d="${d}" fill="none" stroke="${this._esc(fillColor)}" stroke-width="0.4" stroke-opacity="0.8" stroke-linejoin="round" stroke-linecap="round" />`
            );
          };

          // B1a. Interior rings — already closed, smooth + fill as-is.
          closedPaths.forEach(fillRing);

          // B1b. Edge-touching rings — closed against the real grid boundary by
          // extrapolating each open end past the edge (_tangentExtrapolate),
          // and — where the correct side to close on isn't the immediately-
          // adjacent one — walking the real per-node boundary data
          // (_closeOpenIsobandPaths' boundaryWalk) instead of a literal
          // rectangle. Rendered exactly like an interior ring (fillRing) —
          // nothing here needs special treatment anymore, since the export
          // canvas is sized upfront (_expandCanvasForIsobands) to fit whatever
          // this produces.
          const closedFromOpen = this._closeOpenIsobandPaths(openPaths, grid, rows, cols, bounds, level);
          closedFromOpen.forEach(fillRing);

          // B2. Thin decorative outline (fill="none") tracing the same closed
          // shapes as the fill above — interior rings as-is, and (for
          // edge-touching contours) the exact same fully-closed ring produced
          // by _closeOpenIsobandPaths, not the raw open marching-squares
          // fragment. An earlier version of this traced the raw open path
          // directly and tangent-extrapolated it in isolation, with no
          // boundary-walk closure — for short/noisy fragments that produced a
          // visibly straight spike shooting out from the real curve, and even
          // where it looked fine it was inconsistent with the (properly
          // closed) fill it's supposed to trace the edge of. Reusing the same
          // ring guarantees the outline always reads as the border of the
          // actual filled shape, with the same organic, boundary-data-driven
          // curve at the edges.
          closedPaths.forEach(strokeRing);
          closedFromOpen.forEach(strokeRing);
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

  /**
   * Extend an open path a bit past each of its two ends, continuing in whatever
   * direction it was already heading (its local tangent) when it hit the edge of
   * the grid — rather than squaring it off against the boundary rectangle. Used
   * so an isoline reads as if it kept going into an unbounded field instead of
   * stopping dead or being closed off with a straight line.
   *
   * A small outward bias is blended in on top of the pure tangent so a path that
   * happens to run almost exactly parallel to the edge still moves clearly away
   * from the real bounds (rather than grazing along just inside/along it).
   *
   * Returns a NEW array: [2 prepended points, ...original points, 2 appended
   * points]. These extra points are meant to be fully visible in the final
   * export — see _closeOpenIsobandPaths for how consecutive paths' extrapolated
   * ends are smoothed directly into one another to close the shape, and
   * _expandCanvasForIsobands for how the export canvas grows to fit all of it.
   */
  /**
   * Extend one or both ends of an open curve past the real boundary along its
   * own tangent, so it reads as continuing naturally into an unbounded field
   * instead of stopping dead at the edge.
   *
   * `extrapStart`/`extrapEnd` let a caller skip extrapolating a given end: that
   * matters when this end is about to be joined to a `boundaryWalk` stretch
   * (see _closeOpenIsobandPaths) rather than directly to another path's own
   * extrapolated tip. boundaryWalk already tapers its own push down to zero
   * right at the point where it meets the real curve, so adding a further
   * Far/Near tip *there too* would mean the ring goes real-boundary-point →
   * (boundaryWalk, tapering back up) → Far → Near → real-boundary-point again —
   * a non-monotonic zigzag that reads as a needle-like spike once smoothed.
   * Skipping extrapolation on that end leaves a single, smooth, monotonic taper
   * (owned entirely by boundaryWalk) instead of two independent ones stacked
   * back-to-back.
   */
  static _tangentExtrapolate(pts, bounds, extrapStart = true, extrapEnd = true) {
    if (!pts || pts.length < 2) return pts || [];

    const latSpan = (bounds.maxLat - bounds.minLat) || 1e-9;
    const lonSpan = (bounds.maxLon - bounds.minLon) || 1e-9;
    const diag = Math.hypot(latSpan, lonSpan);

    const outwardNormal = (lat, lon) => {
      const dTop = Math.abs(lat - bounds.maxLat), dRight = Math.abs(lon - bounds.maxLon);
      const dBottom = Math.abs(lat - bounds.minLat), dLeft = Math.abs(lon - bounds.minLon);
      const m = Math.min(dTop, dRight, dBottom, dLeft);
      if (m === dTop)    return { lat: 1, lon: 0 };
      if (m === dRight)  return { lat: 0, lon: 1 };
      if (m === dBottom) return { lat: -1, lon: 0 };
      return { lat: 0, lon: -1 };
    };

    const unit = (v) => {
      const len = Math.hypot(v.lat, v.lon) || 1e-9;
      return { lat: v.lat / len, lon: v.lon / len };
    };

    // `normalWeight` grows from near to far, so the two extrapolated points
    // aren't collinear with the path's local tangent — the continuation curves
    // gently outward rather than shooting away as a dead-straight line, which
    // reads as an obvious ruler-straight spike for any open fragment whose
    // local tangent happens to be poorly determined (e.g. a very short raw
    // isoline fragment).
    const blendedDir = (from, to, normalWeight) => {
      const tangent = unit({ lat: to.lat - from.lat, lon: to.lon - from.lon });
      const normal = outwardNormal(to.lat, to.lon);
      return unit({ lat: tangent.lat + normal.lat * normalWeight, lon: tangent.lon + normal.lon * normalWeight });
    };

    const n = pts.length;
    // How far the visible continuation reaches past the real edge before curving
    // into the closure — a fraction of the map's own diagonal, so it scales
    // sensibly with map size instead of being an arbitrary fixed distance.
    const L1 = 0.12 * diag, L2 = 0.28 * diag;

    const extend = (from, dir, dist) => ({ lat: from.lat + dir.lat * dist, lon: from.lon + dir.lon * dist });

    const head = [];
    if (extrapStart) {
      const nearDir = blendedDir(pts[Math.min(1, n - 1)], pts[0], 0.35);
      const farDir  = blendedDir(pts[Math.min(1, n - 1)], pts[0], 0.7);
      head.push(extend(pts[0], farDir, L2), extend(pts[0], nearDir, L1));
    }
    const tail = [];
    if (extrapEnd) {
      const nearDir = blendedDir(pts[Math.max(0, n - 2)], pts[n - 1], 0.35);
      const farDir  = blendedDir(pts[Math.max(0, n - 2)], pts[n - 1], 0.7);
      tail.push(extend(pts[n - 1], nearDir, L1), extend(pts[n - 1], farDir, L2));
    }

    return [...head, ...pts, ...tail];
  }

  /**
   * Close the open isoline paths that get cut off at the edge of the grid/map
   * extent. Each open end is extended past the edge along its own tangent
   * (_tangentExtrapolate). Where two ends need to be joined and the correct
   * side is the immediately-adjacent one, that's all there is to it — their
   * extrapolated tips sit right next to each other and the normal Catmull-Rom
   * smoothing pass (applied to the whole ring at once, same as an ordinary
   * closed interior ring) bridges them with a smooth, rounded curve.
   *
   * But sometimes the correct side is *not* the nearby one — most of the
   * boundary can legitimately be "inside" the band with only a small notch of
   * open path breaking it up (e.g. a big hot region that touches three sides
   * of the map with one small cool dip cut into an edge). In that case the
   * fill has to actually continue along the rest of the boundary to enclose
   * the right area — but tracing the literal bounding rectangle would draw the
   * exact hard straight edges this feature exists to avoid. Instead, the real
   * grid values already sampled all along that boundary stretch (`profile`,
   * built below) are reused as a chain of real data points, each nudged
   * outward past the edge by an amount that grows with how far above the
   * isolevel that particular point on the boundary is — so a strongly "hot"
   * stretch of edge bulges out further than a stretch that's only barely
   * above level, tapering down to the same small nudge the path's own
   * tangent-extrapolated tip gets right at the point where the data actually
   * crosses the isolevel. It's still built from the real field, so it reads
   * as organic continuation rather than a drafted boundary, and it's never
   * perfectly straight unless the underlying data along that stretch truly is
   * uniform (in which case a straight line is simply the honest answer).
   *
   * Which pair of open ends belong together, and which way to walk, comes from
   * the real grid data, not a guess: every open endpoint sits exactly on the
   * bounding rectangle (that's *why* the path is open — marching squares only
   * traces where the contour crosses a cell edge, and stops the moment it runs
   * off the grid), and between any two boundary-adjacent open endpoints the
   * grid's own boundary value can't cross the isolevel again — otherwise
   * there'd be another open endpoint in between — so sampling the midpoint of
   * that stretch tells us, from the actual data, whether that side is inside
   * the band. That's what decides which endpoints pair up and which direction
   * to walk (an earlier, buggier version of this guessed based on arc length
   * instead, which picks the wrong side whenever the correct arc isn't also the
   * shorter one).
   *
   * Returns an array of closed point rings, ready to be smoothed and filled
   * exactly like an ordinary interior ring.
   */
  static _closeOpenIsobandPaths(openPaths, grid, rows, cols, bounds, level) {
    if (!openPaths || openPaths.length === 0) return [];

    const getLL = (p) => ({
      lat: p.lat !== undefined ? p.lat : p[0],
      lon: p.lon !== undefined ? p.lon : (p.lng !== undefined ? p.lng : p[1])
    });

    const latSpan = (bounds.maxLat - bounds.minLat) || 1e-9;
    const lonSpan = (bounds.maxLon - bounds.minLon) || 1e-9;
    const diag = Math.hypot(latSpan, lonSpan);
    // Same reach as _tangentExtrapolate's L1/L2, so a boundary-walk point right
    // next to a path's own tangent-extrapolated tip (where val ≈ level, nudge ≈
    // L1) lines up with that tip's own first extrapolated point instead of
    // jumping to a noticeably different distance.
    const L1 = 0.12 * diag, L2 = 0.28 * diag;

    // Perimeter position in [0, 4): 0-1 top (W->E), 1-2 right (N->S),
    // 2-3 bottom (E->W), 3-4 left (S->N) — clockwise on a standard lat/lon map.
    const perimT = (lat, lon) => {
      const dTop    = Math.abs(lat - bounds.maxLat);
      const dRight  = Math.abs(lon - bounds.maxLon);
      const dBottom = Math.abs(lat - bounds.minLat);
      const dLeft   = Math.abs(lon - bounds.minLon);
      const m = Math.min(dTop, dRight, dBottom, dLeft);
      if (m === dTop)    return (lon - bounds.minLon) / lonSpan;
      if (m === dRight)  return 1 + (bounds.maxLat - lat) / latSpan;
      if (m === dBottom) return 2 + (bounds.maxLon - lon) / lonSpan;
      return 3 + (lat - bounds.minLat) / latSpan;
    };

    // Real grid values AND positions sampled all the way around the boundary, in
    // increasing-t order, so "which side is inside" is read off the actual data
    // instead of assumed, and (for the boundary walk below) each node can also be
    // nudged outward from its own real lat/lon. Grid row r=0 is minLat and
    // r=rows-1 is maxLat (same convention as getLatLng elsewhere in this file and
    // in MarchingSquares) — so the "top" edge (t 0-1, lat=maxLat) reads from grid
    // row rows-1, not row 0.
    const profile = [];
    for (let c = 0; c < cols; c++) profile.push({ t: c / (cols - 1), lat: bounds.maxLat, lon: bounds.minLon + (c / (cols - 1)) * lonSpan, val: grid[rows - 1][c], normal: { lat: 1, lon: 0 } });
    for (let r = rows - 2; r >= 0; r--) profile.push({ t: 1 + (rows - 1 - r) / (rows - 1), lat: bounds.minLat + (r / (rows - 1)) * latSpan, lon: bounds.maxLon, val: grid[r][cols - 1], normal: { lat: 0, lon: 1 } });
    for (let c = cols - 2; c >= 0; c--) profile.push({ t: 2 + (cols - 1 - c) / (cols - 1), lat: bounds.minLat, lon: bounds.minLon + (c / (cols - 1)) * lonSpan, val: grid[0][c], normal: { lat: -1, lon: 0 } });
    for (let r = 1; r <= rows - 2; r++) profile.push({ t: 3 + r / (rows - 1), lat: bounds.minLat + (r / (rows - 1)) * latSpan, lon: bounds.minLon, val: grid[r][0], normal: { lat: 0, lon: -1 } });

    const sampleBoundary = (tRaw) => {
      const t = ((tRaw % 4) + 4) % 4;
      for (let i = 0; i < profile.length; i++) {
        const a = profile[i];
        const b = profile[(i + 1) % profile.length];
        const bt = (i === profile.length - 1) ? b.t + 4 : b.t;
        if (t >= a.t && t <= bt) {
          if (a.val === null || b.val === null || isNaN(a.val) || isNaN(b.val)) return null;
          const span = (bt - a.t) || 1e-9;
          return a.val + (b.val - a.val) * ((t - a.t) / span);
        }
      }
      return profile[0].val;
    };

    // Real boundary-node points, nudged outward, whose position lies strictly
    // between tFrom and tTo, walking forward (increasing t, wrapping past 4) —
    // i.e. the actual data-driven stand-in for "walk the rectangle" when the
    // correct side to close a ring on isn't the immediately-adjacent one.
    //
    // The outward nudge for each node combines two things:
    //  - A smooth positional envelope (sin, 0 at both ends of this specific
    //    arc, peaking in the middle) — this alone guarantees the whole stretch
    //    is curved, never a straight run, regardless of what the data does. It
    //    also reaches exactly 0 at both ends, matching the real curve
    //    endpoints there continuously (a boundary-walk arc always starts/ends
    //    exactly where the data crosses `level`).
    //  - How far above `level` each node is, normalized against the highest
    //    value seen *on this specific arc* — not the whole boundary. Using a
    //    single global peak to normalize would crush the nudge to ~0 for any
    //    arc that happens to run far from wherever the field peaks (e.g. the
    //    long way around a big low-lying region while a sharp hotspot sits
    //    elsewhere on the map) — producing a flat, literally-straight stretch
    //    exactly where "no straight lines" matters most. Normalizing per arc
    //    means every arc gets its own gentle, data-shaped bulge no matter what
    //    the rest of the field is doing.
    const boundaryWalk = (tFrom, tTo) => {
      let span = tTo - tFrom;
      while (span <= 1e-9) span += 4;
      const nodes = profile
        .map(node => ({ node, rel: (((node.t - tFrom) % 4) + 4) % 4 }))
        .filter(({ rel }) => rel > 1e-9 && rel < span - 1e-9)
        .sort((a, b) => a.rel - b.rel);
      if (nodes.length === 0) return [];

      let localMax = 0;
      nodes.forEach(({ node }) => {
        const excess = (node.val === null || isNaN(node.val)) ? 0 : Math.max(0, node.val - level);
        if (excess > localMax) localMax = excess;
      });

      return nodes.map(({ node, rel }) => {
        const relPos = rel / span;
        const envelope = Math.sin(Math.PI * relPos);
        const excess = (node.val === null || isNaN(node.val)) ? 0 : Math.max(0, node.val - level);
        const dataFrac = localMax > 1e-9 ? excess / localMax : 0;
        // 0.3 floor keeps a real bulge present even where the data along this
        // arc is essentially uniform (dataFrac ~ 0 everywhere); the remaining
        // 0.7 lets genuinely "more inside" stretches bulge out further than
        // barely-inside ones.
        const dist = L2 * envelope * (0.3 + 0.7 * dataFrac);
        return { lat: node.lat + node.normal.lat * dist, lon: node.lon + node.normal.lon * dist };
      });
    };

    // Two endpoints per open path, sorted by their position around the perimeter.
    const endpoints = [];
    openPaths.forEach((path, idx) => {
      const first = getLL(path[0]);
      const last = getLL(path[path.length - 1]);
      endpoints.push({ t: perimT(first.lat, first.lon), pathIdx: idx, which: 'start' });
      endpoints.push({ t: perimT(last.lat, last.lon), pathIdx: idx, which: 'end' });
    });
    endpoints.sort((a, b) => a.t - b.t);
    const n = endpoints.length;
    if (n === 0) return [];

    const endpointIndex = new Map();
    endpoints.forEach((e, i) => endpointIndex.set(`${e.pathIdx}:${e.which}`, i));

    // Whether the forward arc (i -> i+1, increasing t) is inside the band. Between
    // any two adjacent endpoints the boundary value can't cross `level` again, so a
    // single midpoint sample classifies the whole arc.
    const arcInsideForward = new Array(n);
    for (let i = 0; i < n; i++) {
      const tA = endpoints[i].t;
      let tB = endpoints[(i + 1) % n].t;
      if (tB <= tA) tB += 4;
      const v = sampleBoundary((tA + tB) / 2);
      arcInsideForward[i] = v !== null && v >= level;
    }

    const usedEndpoint = new Array(n).fill(false);
    const rings = [];

    for (let s = 0; s < n; s++) {
      if (usedEndpoint[s]) continue;

      // First pass: walk the endpoint graph and collect each path segment
      // together with whatever boundary-walk stretch (if any) follows it,
      // without deciding yet how each segment's own ends should be
      // extrapolated — that depends on what's on *both* sides of it, which
      // isn't known until the whole loop closes.
      const segments = [];
      let curIdx = s;
      let closedOk = false;
      let guard = 0;

      while (guard++ <= n + 2) {
        if (usedEndpoint[curIdx]) { closedOk = false; break; }
        usedEndpoint[curIdx] = true;

        const ep = endpoints[curIdx];
        const path = openPaths[ep.pathIdx];
        let curvePts, otherIdx;
        if (ep.which === 'start') {
          curvePts = path.map(getLL);
          otherIdx = endpointIndex.get(`${ep.pathIdx}:end`);
        } else {
          curvePts = path.slice().reverse().map(getLL);
          otherIdx = endpointIndex.get(`${ep.pathIdx}:start`);
        }
        usedEndpoint[otherIdx] = true;

        // From `otherIdx`, exactly one of the two neighbouring arcs reads as
        // "inside" the band (they strictly alternate all the way around the
        // rectangle) — that tells us which open end comes next in the ring, and
        // (via boundaryWalk) which real boundary-data stretch has to be nudged
        // outward and inserted to actually enclose that side when it isn't the
        // immediately-adjacent one.
        const prevIdx = (otherIdx - 1 + n) % n;
        const forward = arcInsideForward[otherIdx];
        const backward = arcInsideForward[prevIdx];

        let nextIdx, boundaryPts;
        if (forward && !backward) {
          nextIdx = (otherIdx + 1) % n;
          boundaryPts = boundaryWalk(endpoints[otherIdx].t, endpoints[nextIdx].t);
        } else if (backward && !forward) {
          nextIdx = prevIdx;
          boundaryPts = boundaryWalk(endpoints[nextIdx].t, endpoints[otherIdx].t).reverse();
        } else if (forward) { // degenerate tie — pick a side rather than stall
          nextIdx = (otherIdx + 1) % n;
          boundaryPts = boundaryWalk(endpoints[otherIdx].t, endpoints[nextIdx].t);
        } else { closedOk = false; break; } // neither side reads inside — bail out safely

        segments.push({ curvePts, boundaryPtsAfter: boundaryPts });

        if (nextIdx === s) { closedOk = true; break; }
        curIdx = nextIdx;
      }

      const ring = [];
      if (closedOk) {
        // Second pass: now that every segment's neighbours are known, extend
        // each path's own ends past the boundary along its tangent *only*
        // where it joins directly to another path's tip (no boundary-walk
        // stretch in between) — that's the case a synthetic tip is needed to
        // read as "continuing into the field". Where a boundary-walk stretch
        // already runs up to this segment, it already tapers its own outward
        // nudge down to exactly 0 right at the join, so it's already smooth
        // and continuous with the real curve there; adding a second,
        // independently-placed tip on top of that would create a needless
        // (and visually spiky) second bulge stacked on the first.
        const m = segments.length;
        for (let i = 0; i < m; i++) {
          const prevBoundary = segments[(i - 1 + m) % m].boundaryPtsAfter;
          const extrapStart = prevBoundary.length === 0;
          const extrapEnd = segments[i].boundaryPtsAfter.length === 0;
          ring.push(...this._tangentExtrapolate(segments[i].curvePts, bounds, extrapStart, extrapEnd));
          ring.push(...segments[i].boundaryPtsAfter);
        }
      }

      if (closedOk && ring.length >= 3) rings.push(ring);
    }

    return rings;
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
