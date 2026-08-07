/**
 * GSR Map SVG Exporter Utility.
 * Compiles Leaflet map vector features, contours, track paths, and markers into a single
 * Illustrator-compatible, resolution-independent layered SVG with zero external references.
 */
const SVG_NS   = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';
const AI_NS    = 'http://ns.adobe.com/AdobeIllustrator/10.0/';
const BG       = '#0b0d16';
const LABEL    = '#000000';

class GSRMapExporter {

  // ═══════════════════════════════════════════════════════════════════
  //  Public API
  // ═══════════════════════════════════════════════════════════════════

  static async exportToSvg(mgr) {
    let ctx = this._validate(mgr);
    if (!ctx) return;

    // Isobands at the map edge are drawn extending past the original frame
    // (see _closeOpenIsobandPaths / _tangentExtrapolate) rather than being
    // squared off against it. Growing the canvas here — instead of drawing
    // that extension and then clipping it away — means everything in the
    // export is genuinely visible; there's no invisible geometry to keep in
    // sync with a clip region.
    ctx = this._expandCanvasForIsobands(ctx);

    const layers = await this._gather(ctx);
    this._download(this._render(ctx, layers), AppState.viewMode || 'single');
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Validation & Mercator Projection Setup
  // ═══════════════════════════════════════════════════════════════════

  static _parseLatLng(ll) {
    if (!ll) return { lat: 0, lon: 0 };
    let lat, lon;
    if (Array.isArray(ll)) {
      lat = ll[0]; lon = ll[1];
    } else {
      lat = ll.lat !== undefined ? ll.lat : 0;
      lon = ll.lon !== undefined ? ll.lon : (ll.lng !== undefined ? ll.lng : 0);
    }
    return { lat, lon };
  }

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
        const { lat, lon } = GSRMapExporter._parseLatLng(ll);
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
      const { lat, lon } = GSRMapExporter._parseLatLng(ll);
      return mgr.map.latLngToContainerPoint([lat, lon]);
    };
    return { w, h, project };
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Canvas & Bounding Box Helpers
  // ═══════════════════════════════════════════════════════════════════

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

    // _tiles() positions tiles from raw DOM getBoundingClientRect() values,
    // not through project() — so growing/shifting the canvas here without
    // also shifting the reference rect it measures tiles against left the
    // tile layer anchored to the OLD, pre-expansion origin while everything
    // else (tracks/contours/peaks, via newProject above) moved to fill the
    // new canvas. Whatever margin got added on the right/bottom (or shifted
    // in from the left/top) ended up as tile-less blank canvas — visible as
    // a chunk of missing background tiles wherever the isobands pushed the
    // canvas out furthest. Shifting `r` by the same margin keeps tiles in
    // the same coordinate space as everything else _gather() collects.
    const newR = { left: ctx.r.left - marginLeft, top: ctx.r.top - marginTop };

    return { ...ctx, w: newW, h: newH, project: newProject, r: newR };
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Data Gathering
  // ═══════════════════════════════════════════════════════════════════

  static async _gather(ctx) {
    const { map, el, r, mgr } = ctx;
    // Phase 1 (slice 3): per-track render layers are derived from the track
    // layerGroups via getRenderLayers(); only the aggregate layers (OSM shapes,
    // contours, clusters) are still read off the manager directly.
    const render = (typeof mgr.getRenderLayers === 'function')
      ? mgr.getRenderLayers()
      : { paths: [], peakMarkers: [], hotspots: [] };
    return {
      tiles:          await this._tiles(el, r),
      rfFluid:        this._rfFluid(ctx),
      surface:        this._surface(ctx),
      osm:            this._vectors(ctx, mgr.osmLayers, { exact: true }),
      tracks:         this._vectors(ctx, render.paths),
      contours:       this._vectors(ctx, mgr.contourLayers),
      clusters:       this._vectors(ctx, mgr.clusterLayers),
      dotsAndLabels:  this._markers(ctx, render.peakMarkers),
      hotspots:       this._markers(ctx, render.hotspots)
    };
  }

  static _rfFluid(ctx) {
    const rfRenderer = ctx.mgr?.rfFluidRenderer;
    if (!rfRenderer || !rfRenderer.options || !rfRenderer.options.visible) {
      return { defs: [], polygons: [] };
    }
    if (typeof rfRenderer.exportToSvgElements === 'function') {
      return rfRenderer.exportToSvgElements(ctx.project, ctx.w, ctx.h);
    }
    return { defs: [], polygons: [] };
  }

  // ═══════════════════════════════════════════════════════════════════
  //  SVG Layer Assembly & XML Rendering
  // ═══════════════════════════════════════════════════════════════════

  static _render(ctx, L) {
    const { w, h } = ctx;

    const g = (id, name, items, extra = '') =>
      `  <g i:layer="yes" id="${id}" data-name="${name}"${extra ? ' ' + extra : ''}>` +
      (items && items.length ? '\n' + items.map(e => '    ' + e).join('\n') + '\n  ' : '') +
      `</g>`;

    const surfObj = Array.isArray(L.surface)
      ? { mesh: [], isobands: [] }
      : (L.surface || { mesh: [], isobands: [] });

    const rfObj = L.rfFluid || { defs: [], layers: {}, polygons: [] };
    const hasMask = rfObj.defs && rfObj.defs.some(d => d.includes('id="rfBuildingMask"'));
    const maskAttr = hasMask ? 'mask="url(#rfBuildingMask)"' : '';

    // Build separated frequency sub-layers for Illustrator
    const rfSubLayers = [];
    if (rfObj.layers) {
      if (rfObj.layers['815'] && rfObj.layers['815'].length) {
        rfSubLayers.push(g('RF_815MHz_LTE', 'RF 815 MHz (LTE Edge)', rfObj.layers['815'], 'style="mix-blend-mode: screen;"'));
      }
      if (rfObj.layers['868'] && rfObj.layers['868'].length) {
        rfSubLayers.push(g('RF_868MHz_Grid', 'RF 868 MHz (Grid Smart)', rfObj.layers['868'], 'style="mix-blend-mode: screen;"'));
      }
      if (rfObj.layers['915'] && rfObj.layers['915'].length) {
        rfSubLayers.push(g('RF_915MHz_SubGHz', 'RF 915 MHz (ISM SubGHz)', rfObj.layers['915'], 'style="mix-blend-mode: screen;"'));
      }
      if (rfObj.layers['fog'] && rfObj.layers['fog'].length) {
        rfSubLayers.push(g('RF_EM_Fog', 'RF Electromagnetic Fog', rfObj.layers['fog'], 'style="mix-blend-mode: screen;"'));
      }
    }

    const rfLayerItems = rfSubLayers.length > 0 ? rfSubLayers : (rfObj.polygons || []);
    const rfMasterAttr = hasMask ? maskAttr : 'style="mix-blend-mode: screen;"';

    const defsContent = rfObj.defs && rfObj.defs.length > 0
      ? `  <defs>\n${rfObj.defs.map(d => '    ' + d).join('\n')}\n  </defs>`
      : '';

    const specs = [
      ['Base_Map_Tiles',          'Base Map Tiles',              L.tiles],
      ['Vector_Surface_Mesh',     'Vector Surface Mesh',         surfObj.mesh,        'opacity="0.4"'],
      // Isobands at the map edge are deliberately extrapolated past the original
      // frame (so the curve reads as continuing into an unbounded field rather
      // than being squared off against the boundary). Rather than hiding that
      // extension behind a clip-path, exportToSvg() grows the canvas ahead of
      // time (_expandCanvasForIsobands) so the full rounded shape is genuinely
      // visible here — nothing in this layer is invisible or clipped.
      ['Vector_Surface_Isobands', 'Vector Surface Isobands',     surfObj.isobands,    'opacity="0.4"'],
      ['RF_Fluid_Field',          'RF Fluid Field',              rfLayerItems,        rfMasterAttr],
      ['OSM_Shapes',              'OSM Shapes',                  L.osm],
      ['GPS_Track_Paths',         'GPS Track Paths',             L.tracks],
      ['Contour_Lines',           'Contour Lines',               L.contours],
      ['Cluster_Metaballs',       'Cluster Metaballs',           L.clusters],
      ['Stress_Peak_Dots',        'Stress Peak Dots',            L.dotsAndLabels.dots],
      ['Hotspot_Dots',            'Hotspot Dots',                L.hotspots.dots],
      ['Stress_Peak_Labels',      'Stress Peak Labels',          L.dotsAndLabels.labels]
    ];

    const lines = [
      `<svg xmlns="${SVG_NS}" xmlns:xlink="${XLINK_NS}" xmlns:i="${AI_NS}" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">`,
      `  <rect x="0" y="0" width="${w}" height="${h}" fill="${BG}" />`
    ];
    if (defsContent) lines.push(defsContent);
    lines.push(...specs.map(s => g(...s)));
    lines.push('</svg>');
    return lines.join('\n');
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Vector Surface & Isoband Builders
  // ═══════════════════════════════════════════════════════════════════

  static _surface(ctx) {
    const surfaceData = ctx.mgr?.surfaceData;
    if (!surfaceData || !surfaceData.grid || !surfaceData.bounds) {
      return { mesh: [], isobands: [] };
    }
    return {
      mesh: this._buildVectorMesh(ctx, surfaceData),
      isobands: this._buildVectorIsobands(ctx, surfaceData)
    };
  }

  /**
   * Generates cell-by-cell vector mesh polygons, each colored by its exact percentile rank.
   */
  static _buildVectorMesh(ctx, surfaceData) {
    const { grid, minVal, maxVal, bounds, sortedVals } = surfaceData;
    const rows = grid.length;
    const cols = grid[0].length;
    const valRange = maxVal - minVal;
    const rangeEpsilon = 1e-9;
    const useRankColor = sortedVals && sortedVals.length > 1;
    const project = ctx.project || (ll => ctx.map.latLngToContainerPoint(ll));
    const mesh = [];

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
        
        mesh.push(
          `<polygon points="${pointsStr}" fill="${this._esc(fillColor)}" stroke="${this._esc(fillColor)}" stroke-width="0.5" stroke-linejoin="round" />`
        );
      }
    }
    return mesh;
  }

  /**
   * Generates smooth, boundary-closed vector Isoband fills.
   *
   * Interior isoband rings (fully enclosed within the grid) are already closed
   * by marching squares + stitching, so they're smoothed and filled directly.
   * Rings that get cut off by the edge of the grid/map extent trace out as an
   * OPEN path instead.
   *
   * Those open paths are closed here (_closeOpenIsobandPaths) by walking the
   * boundary between open ends, using boundary values to determine which side
   * is inside the band.
   */
  static _buildVectorIsobands(ctx, surfaceData) {
    const { grid, bounds, contours } = surfaceData;
    if (!contours || !Array.isArray(contours)) return [];

    const rows = grid.length;
    const cols = grid[0].length;
    const isobands = [];

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
        isobands.push(
          `<path d="${d}" fill="${this._esc(fillColor)}" stroke="none" />`
        );
      };

      // Interior rings — already closed, smooth + fill as-is.
      closedPaths.forEach(fillRing);

      // Edge-touching rings — closed against real grid boundary loops.
      const closedFromOpen = this._closeOpenIsobandPaths(openPaths, grid, rows, cols, bounds, level);
      closedFromOpen.forEach(fillRing);
    });

    return isobands;
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
  static _tangentExtrapolate(pts, diag, extrapStart = true, extrapEnd = true, startNormal = null, endNormal = null) {
    if (!pts || pts.length < 2) return pts || [];

    const unit = (v) => {
      const len = Math.hypot(v.lat, v.lon) || 1e-9;
      return { lat: v.lat / len, lon: v.lon / len };
    };

    // `normalWeight` grows from near to far, so the two extrapolated points
    // aren't collinear with the path's local tangent — the continuation curves
    // gently outward rather than shooting away as a dead-straight line.
    const blendedDir = (from, to, normal, normalWeight) => {
      const tangent = unit({ lat: to.lat - from.lat, lon: to.lon - from.lon });
      const n = normal || { lat: 0, lon: 0 };
      return unit({ lat: tangent.lat + n.lat * normalWeight, lon: tangent.lon + n.lon * normalWeight });
    };

    const n = pts.length;
    // How far the visible continuation reaches past the real edge before
    // curving into the closure — a fraction of the *relevant* boundary's own
    // diagonal.
    const L1 = 0.12 * diag, L2 = 0.28 * diag;
    const extend = (from, dir, dist) => ({ lat: from.lat + dir.lat * dist, lon: from.lon + dir.lon * dist });

    const head = [];
    if (extrapStart) {
      const nearDir = blendedDir(pts[Math.min(1, n - 1)], pts[0], startNormal, 0.35);
      const farDir  = blendedDir(pts[Math.min(1, n - 1)], pts[0], startNormal, 0.7);
      head.push(extend(pts[0], farDir, L2), extend(pts[0], nearDir, L1));
    }
    const tail = [];
    if (extrapEnd) {
      const nearDir = blendedDir(pts[Math.max(0, n - 2)], pts[n - 1], endNormal, 0.35);
      const farDir  = blendedDir(pts[Math.max(0, n - 2)], pts[n - 1], endNormal, 0.7);
      tail.push(extend(pts[n - 1], nearDir, L1), extend(pts[n - 1], farDir, L2));
    }

    return [...head, ...pts, ...tail];
  }

  /**
   * Turn a raw, ordered array of {lat, lon, ...} points into a closed "loop":
   * each point gets a cumulative arc-length `t` (real distance in degrees from
   * points[0], increasing around the loop), and the loop remembers its total
   * length (arc back from the last point to the first, closing it), plus its
   * own bounding-box diagonal (`diag`) — used to scale how far a boundary
   * walk or tangent-extrapolated tip pushes outward.
   */
  static _toLoop(rawPoints) {
    if (!rawPoints || rawPoints.length === 0) return { points: [], length: 0, diag: 0 };
    let t = 0;
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    const points = rawPoints.map((p, i) => {
      if (i > 0) {
        const prev = rawPoints[i - 1];
        t += Math.hypot(p.lat - prev.lat, p.lon - prev.lon);
      }
      if (p.lat < minLat) minLat = p.lat;
      if (p.lat > maxLat) maxLat = p.lat;
      if (p.lon < minLon) minLon = p.lon;
      if (p.lon > maxLon) maxLon = p.lon;
      return { ...p, t };
    });
    const first = points[0], last = points[points.length - 1];
    const closingLen = Math.hypot(first.lat - last.lat, first.lon - last.lon);
    const diag = Math.hypot(maxLat - minLat, maxLon - minLon) || 1e-9;
    return { points, length: last.t + closingLen, diag };
  }

  /**
   * The literal bounding rectangle as a loop, at grid resolution — this is the
   * only "boundary" that exists for a fully-populated grid (no masked cells),
   * and it's always included even when a data mask is also present.
   */
  static _buildRectangleLoop(grid, rows, cols, bounds) {
    const latSpan = bounds.maxLat - bounds.minLat, lonSpan = bounds.maxLon - bounds.minLon;
    const raw = [];
    for (let c = 0; c < cols; c++) raw.push({ lat: bounds.maxLat, lon: bounds.minLon + (c / (cols - 1)) * lonSpan, val: grid[rows - 1][c], normal: { lat: 1, lon: 0 } });
    for (let r = rows - 2; r >= 0; r--) raw.push({ lat: bounds.minLat + (r / (rows - 1)) * latSpan, lon: bounds.maxLon, val: grid[r][cols - 1], normal: { lat: 0, lon: 1 } });
    for (let c = cols - 2; c >= 0; c--) raw.push({ lat: bounds.minLat, lon: bounds.minLon + (c / (cols - 1)) * lonSpan, val: grid[0][c], normal: { lat: -1, lon: 0 } });
    for (let r = 1; r <= rows - 2; r++) raw.push({ lat: bounds.minLat + (r / (rows - 1)) * latSpan, lon: bounds.minLon, val: grid[r][0], normal: { lat: 0, lon: -1 } });
    return this._toLoop(raw);
  }

  /**
   * Traces the "coastline" between valid (real number) and masked (null)
   * grid cells — e.g. the edge of a GPS track's isolationRadius corridor in
   * collective_manager.js's generateContourSurface, where most of the grid
   * outside the walked path is deliberately left null.
   *
   * Mirrors MarchingSquares' own cell-marching loop on a binary valid/invalid
   * field, tagging each traced point with the real DATA value of whichever
   * corner is valid and the true local outward direction.
   */
  static _traceMaskBoundary(grid, rows, cols, bounds) {
    const isValid = (r, c) => grid[r][c] !== null && grid[r][c] !== undefined && !isNaN(grid[r][c]);
    const minLat = bounds.minLat, maxLat = bounds.maxLat, minLon = bounds.minLon, maxLon = bounds.maxLon;
    const pos = (r, c) => ({
      lat: minLat + (r / (rows - 1)) * (maxLat - minLat),
      lon: minLon + (c / (cols - 1)) * (maxLon - minLon)
    });
    const edgePoint = (r1, c1, r2, c2) => {
      const p1 = pos(r1, c1), p2 = pos(r2, c2);
      const v1Valid = isValid(r1, c1);
      const validPos = v1Valid ? p1 : p2, nullPos = v1Valid ? p2 : p1;
      const validVal = v1Valid ? grid[r1][c1] : grid[r2][c2];
      const dir = { lat: nullPos.lat - validPos.lat, lon: nullPos.lon - validPos.lon };
      const len = Math.hypot(dir.lat, dir.lon) || 1e-9;
      return {
        lat: (p1.lat + p2.lat) / 2, lon: (p1.lon + p2.lon) / 2,
        val: validVal,
        normal: { lat: dir.lat / len, lon: dir.lon / len }
      };
    };

    const segs = [];
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const vNW = isValid(r, c), vNE = isValid(r, c + 1), vSE = isValid(r + 1, c + 1), vSW = isValid(r + 1, c);
        let idx = 0;
        if (vNW) idx |= 8;
        if (vNE) idx |= 4;
        if (vSE) idx |= 2;
        if (vSW) idx |= 1;
        if (idx === 0 || idx === 15) continue;

        const T = () => edgePoint(r, c, r, c + 1);
        const R = () => edgePoint(r, c + 1, r + 1, c + 1);
        const B = () => edgePoint(r + 1, c, r + 1, c + 1);
        const L = () => edgePoint(r, c, r + 1, c);

        switch (idx) {
          case 1:  segs.push([B(), L()]); break;
          case 2:  segs.push([R(), B()]); break;
          case 3:  segs.push([R(), L()]); break;
          case 4:  segs.push([T(), R()]); break;
          case 5:  segs.push([T(), R()]); segs.push([B(), L()]); break;
          case 6:  segs.push([T(), B()]); break;
          case 7:  segs.push([T(), L()]); break;
          case 8:  segs.push([L(), T()]); break;
          case 9:  segs.push([B(), T()]); break;
          case 10: segs.push([L(), B()]); segs.push([T(), R()]); break;
          case 11: segs.push([R(), T()]); break;
          case 12: segs.push([L(), R()]); break;
          case 13: segs.push([B(), R()]); break;
          case 14: segs.push([L(), B()]); break;
        }
      }
    }
    return segs;
  }

  /**
   * Corner-cuts a closed sequence of {lat, lon, val, normal} points the same
   * way GeoUtils.chaikinSmooth does, but also blends `val` and `normal` along
   * with position (chaikinSmooth only knows about lat/lon and would silently
   * drop them). This prevents staircase raster artifacts on mask boundaries.
   */
  static _smoothLoopPoints(points, iterations = 2) {
    if (!points || points.length < 3) return points || [];
    let pts = points;
    for (let iter = 0; iter < iterations; iter++) {
      const n = pts.length;
      const next = [];
      const blend = (a, b, f) => a + (b - a) * f;
      for (let i = 0; i < n; i++) {
        const p0 = pts[i], p1 = pts[(i + 1) % n];
        const mk = (f) => {
          const nlat = blend(p0.normal.lat, p1.normal.lat, f);
          const nlon = blend(p0.normal.lon, p1.normal.lon, f);
          const nlen = Math.hypot(nlat, nlon) || 1e-9;
          return {
            lat: blend(p0.lat, p1.lat, f),
            lon: blend(p0.lon, p1.lon, f),
            val: blend(p0.val ?? 0, p1.val ?? 0, f),
            normal: { lat: nlat / nlen, lon: nlon / nlen }
          };
        };
        next.push(mk(0.25), mk(0.75));
      }
      pts = next;
    }
    return pts;
  }

  /**
   * Replaces each point's outward normal with one derived from the *smoothed
   * loop's own local tangent* (perpendicular to it), rather than the raw
   * per-cell valid→null direction _traceMaskBoundary computed.
   */
  static _recomputeSmoothNormals(points) {
    const n = points.length;
    if (n < 3) return points;
    return points.map((p, i) => {
      const prev = points[(i - 1 + n) % n];
      const next = points[(i + 1) % n];
      const tangent = { lat: next.lat - prev.lat, lon: next.lon - prev.lon };
      const len = Math.hypot(tangent.lat, tangent.lon) || 1e-9;
      const perpA = { lat: -tangent.lon / len, lon: tangent.lat / len };
      const dot = perpA.lat * p.normal.lat + perpA.lon * p.normal.lon;
      const chosen = dot >= 0 ? perpA : { lat: -perpA.lat, lon: -perpA.lon };
      return { ...p, normal: chosen };
    });
  }

  /**
   * All the closed boundary loops an open isoline path could plausibly need
   * to close against: the literal bounding rectangle, always, plus one loop
   * per disconnected masked-data "island" if the grid has any null cells.
   */
  static _buildBoundaryLoops(grid, rows, cols, bounds) {
    const loops = [this._buildRectangleLoop(grid, rows, cols, bounds)];

    const hasNull = grid.some(row => row.some(v => v === null || v === undefined || isNaN(v)));
    if (!hasNull) return loops;

    const segs = this._traceMaskBoundary(grid, rows, cols, bounds);
    if (!segs.length) return loops;

    const stitched = (typeof GSRSpatialClustering !== 'undefined' && typeof GSRSpatialClustering.stitchSegments === 'function')
      ? GSRSpatialClustering.stitchSegments(segs)
      : segs.map(s => [s[0], s[1]]);

    stitched.forEach(path => {
      if (!path || path.length < 3) return;
      const first = path[0], last = path[path.length - 1];
      const closed = Math.hypot(first.lat - last.lat, first.lon - last.lon) < 1e-9;
      if (!closed) return;
      const smoothed = this._recomputeSmoothNormals(this._smoothLoopPoints(path.slice(0, -1), 3));
      loops.push(this._toLoop(smoothed));
    });

    return loops;
  }

  /**
   * Close the open isoline paths that get cut off at the edge of the grid/map
   * extent. Each open end is extended past the edge along its own tangent
   * (_tangentExtrapolate).
   *
   * Where two ends need to be joined and the correct side is not the nearby one,
   * the real grid values sampled along that boundary stretch are reused as a chain
   * of data points nudged outward.
   *
   * Returns an array of closed point rings ready to be smoothed and filled.
   */
  static _closeOpenIsobandPaths(openPaths, grid, rows, cols, bounds, level) {
    if (!openPaths || openPaths.length === 0) return [];

    const getLL = (p) => ({
      lat: p.lat !== undefined ? p.lat : p[0],
      lon: p.lon !== undefined ? p.lon : (p.lng !== undefined ? p.lng : p[1])
    });

    const loops = this._buildBoundaryLoops(grid, rows, cols, bounds);
    if (loops.length === 0) return [];

    const nearestOnLoop = (loop, latlon) => {
      let best = null;
      loop.points.forEach(p => {
        const d = Math.hypot(p.lat - latlon.lat, p.lon - latlon.lon);
        if (!best || d < best.d) best = { d, t: p.t, normal: p.normal };
      });
      return best;
    };

    const endpoints = [];
    openPaths.forEach((path, idx) => {
      const first = getLL(path[0]);
      const last = getLL(path[path.length - 1]);
      let bestLoopIdx = 0, bestScore = Infinity, bestFirst = null, bestLast = null;
      loops.forEach((loop, li) => {
        if (loop.points.length === 0) return;
        const nf = nearestOnLoop(loop, first);
        const nl = nearestOnLoop(loop, last);
        const score = nf.d + nl.d;
        if (score < bestScore) { bestScore = score; bestLoopIdx = li; bestFirst = nf; bestLast = nl; }
      });
      if (!bestFirst) return;
      endpoints.push({ t: bestFirst.t, loopIdx: bestLoopIdx, normal: bestFirst.normal, pathIdx: idx, which: 'start' });
      endpoints.push({ t: bestLast.t, loopIdx: bestLoopIdx, normal: bestLast.normal, pathIdx: idx, which: 'end' });
    });
    if (endpoints.length === 0) return [];

    const rings = [];
    const byLoop = new Map();
    endpoints.forEach(e => {
      if (!byLoop.has(e.loopIdx)) byLoop.set(e.loopIdx, []);
      byLoop.get(e.loopIdx).push(e);
    });

    byLoop.forEach((groupEndpoints, loopIdx) => {
      const loop = loops[loopIdx];
      const sorted = groupEndpoints.slice().sort((a, b) => a.t - b.t);
      const n = sorted.length;
      if (n === 0) return;
      const L = loop.length || 1e-9;
      const L2 = 0.28 * (loop.diag || 1e-9);
      const isMaskLoop = loopIdx !== 0;

      const endpointIndex = new Map();
      sorted.forEach((e, i) => endpointIndex.set(`${e.pathIdx}:${e.which}`, i));

      const T_EPS = 1e-7;
      const sampleLoopVal = (tRaw) => {
        const t = ((tRaw % L) + L) % L;
        const pts = loop.points;
        for (let i = 0; i < pts.length; i++) {
          const a = pts[i];
          if (Math.abs(a.t - t) < T_EPS) return a.val;
          const b = pts[(i + 1) % pts.length];
          const bt = (i === pts.length - 1) ? b.t + L : b.t;
          if (Math.abs(bt - t) < T_EPS) return b.val;
          if (t >= a.t && t <= bt) {
            if (a.val === null || b.val === null || isNaN(a.val) || isNaN(b.val)) return null;
            const span = (bt - a.t) || 1e-9;
            return a.val + (b.val - a.val) * ((t - a.t) / span);
          }
        }
        return pts.length ? pts[0].val : null;
      };

      const boundaryWalk = (tFrom, tTo) => {
        let span = tTo - tFrom;
        while (span <= 1e-9) span += L;
        const nodes = loop.points
          .map(node => ({ node, rel: (((node.t - tFrom) % L) + L) % L }))
          .filter(({ rel }) => rel > 1e-9 && rel < span - 1e-9)
          .sort((a, b) => a.rel - b.rel);
        if (nodes.length === 0) return [];

        if (isMaskLoop) {
          return nodes.map(({ node }) => ({ lat: node.lat, lon: node.lon }));
        }

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
          const dist = L2 * envelope * (0.3 + 0.7 * dataFrac);
          return { lat: node.lat + node.normal.lat * dist, lon: node.lon + node.normal.lon * dist };
        });
      };

      const arcInsideForward = new Array(n);
      for (let i = 0; i < n; i++) {
        const tA = sorted[i].t;
        let tB = sorted[(i + 1) % n].t;
        if (tB <= tA) tB += L;
        const v = sampleLoopVal((tA + tB) / 2);
        arcInsideForward[i] = v !== null && v >= level;
      }

      const usedEndpoint = new Array(n).fill(false);

      for (let s = 0; s < n; s++) {
        if (usedEndpoint[s]) continue;

        const segments = [];
        let curIdx = s;
        let closedOk = false;
        let guard = 0;

        while (guard++ <= n + 2) {
          if (usedEndpoint[curIdx]) { closedOk = false; break; }
          usedEndpoint[curIdx] = true;

          const ep = sorted[curIdx];
          const path = openPaths[ep.pathIdx];
          let curvePts, otherIdx;
          if (ep.which === 'start') {
            curvePts = path.map(getLL);
            otherIdx = endpointIndex.get(`${ep.pathIdx}:end`);
          } else {
            curvePts = path.slice().reverse().map(getLL);
            otherIdx = endpointIndex.get(`${ep.pathIdx}:start`);
          }
          if (otherIdx === undefined) { closedOk = false; break; }
          usedEndpoint[otherIdx] = true;

          const prevIdx = (otherIdx - 1 + n) % n;
          const forward = arcInsideForward[otherIdx];
          const backward = arcInsideForward[prevIdx];

          let nextIdx, boundaryPts;
          if (forward && !backward) {
            nextIdx = (otherIdx + 1) % n;
            boundaryPts = boundaryWalk(sorted[otherIdx].t, sorted[nextIdx].t);
          } else if (backward && !forward) {
            nextIdx = prevIdx;
            boundaryPts = boundaryWalk(sorted[nextIdx].t, sorted[otherIdx].t).reverse();
          } else if (forward) {
            nextIdx = (otherIdx + 1) % n;
            boundaryPts = boundaryWalk(sorted[otherIdx].t, sorted[nextIdx].t);
          } else { closedOk = false; break; }

          segments.push({ curvePts, boundaryPtsAfter: boundaryPts, startNormal: ep.normal, endNormal: sorted[otherIdx].normal });

          if (nextIdx === s) { closedOk = true; break; }
          curIdx = nextIdx;
        }

        const ring = [];
        if (closedOk) {
          // Second pass: now that every segment's neighbours are known,
          // extend each path's own ends past the boundary along its tangent
          // *only* where it joins directly to another path's tip (no
          // boundary-walk stretch in between).
          const m = segments.length;
          for (let i = 0; i < m; i++) {
            const prevBoundary = segments[(i - 1 + m) % m].boundaryPtsAfter;
            const extrapStart = prevBoundary.length === 0;
            const extrapEnd = segments[i].boundaryPtsAfter.length === 0;
            ring.push(...this._tangentExtrapolate(
              segments[i].curvePts, loop.diag, extrapStart, extrapEnd,
              segments[i].startNormal, segments[i].endNormal
            ));
            ring.push(...segments[i].boundaryPtsAfter);
          }
        }

        if (closedOk && ring.length >= 3) rings.push(ring);
      }
    });

    return rings;
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Tile & Vector Element Processors
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
    } catch (err) {
      // Canvas is tainted (cross-origin tiles) — fall through to the fetch path below.
      if (typeof GSRNotices !== 'undefined') GSRNotices.report(err, 'map_exporter:rasterizeImage(tainted canvas)');
    }

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
    } catch (err) {
      if (typeof GSRNotices !== 'undefined') GSRNotices.report(err, 'map_exporter:rasterizeImage(fetch)');
      return null;
    }
  }

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
    const isPoly = !!(
      (typeof L !== 'undefined' && L.Polygon && layer instanceof L.Polygon) ||
      (typeof window !== 'undefined' && window.L && window.L.Polygon && layer instanceof window.L.Polygon) ||
      (layer.options && (layer.options.fill || layer.options.fillColor || layer.options.fillOpacity > 0))
    );
    // "exact" layers (OSM building/park/water shapes) are authoritative vector
    // geometry, not sensor data — every vertex is a real, deliberate coordinate,
    // so none of the GPS-track-oriented smoothing/culling below should touch them.
    const exact = !!opts.exact;

    // Apply Chaikin pre-smoothing ONLY to track paths to filter micro-jitter before screen projection
    if (!isPoly && !exact && Array.isArray(latlngs) && latlngs.length >= 3 && typeof GeoUtils !== 'undefined') {
      try {
        const flat = Array.isArray(latlngs[0]) ? latlngs.flat() : latlngs;
        if (flat.length >= 3 && flat[0] && (typeof flat[0].lat === 'number' || Array.isArray(flat[0]))) {
          latlngs = GeoUtils.chaikinSmooth(flat, 2, false);
        }
      } catch (err) {
        if (typeof GSRNotices !== 'undefined') GSRNotices.report(err, 'map_exporter:_vectors(smoothing)');
      }
    }

    const d = this._pathD(ctx, latlngs, isPoly, !exact, exact);
    if (!d) return null;

    const o = layer.options || {};
    const esc = this._esc;
    // Reduced stroke size: 1.2px thin stroke for exported track vectors.
    // Exact/OSM shapes keep their authored weight untouched — no cosmetic thinning.
    const strokeWidth = exact
      ? (o.weight !== undefined ? o.weight : 1)
      : (o.weight !== undefined ? Math.min(1.5, o.weight * 0.4) : 1.2);

    return `<path d="${d}"` +
      ` stroke="${esc(this._toHex(o.color || '#ff7b00'))}"` +
      ` stroke-width="${esc(strokeWidth)}"` +
      ` stroke-opacity="${esc(o.opacity ?? 0.85)}"` +
      ` stroke-dasharray="${esc(o.dashArray || 'none')}"` +
      ` fill="${esc(isPoly ? this._toHex(o.fillColor || o.color || '#ff7b00') : 'none')}"` +
      ` fill-opacity="${esc(isPoly ? (o.fillOpacity ?? 0.2) : 0)}"` +
      (exact
        ? ` stroke-linecap="square" stroke-linejoin="miter" stroke-miterlimit="10" />`
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
  //  Marker Processors
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
    // its in-app rendered size.
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
    } catch (err) {
      if (typeof GSRNotices !== 'undefined') GSRNotices.report(err, 'map_exporter:label placement');
    }

    return `<text x="${x.toFixed(3)}"` +
      ` y="${y.toFixed(3)}"` +
      ` font-size="${this._esc(ls.fontSize || '11px')}"` +
      ` font-weight="${this._esc(ls.fontWeight || '600')}"` +
      ` font-family="${this._esc(ls.fontFamily || 'sans-serif')}"` +
      ` fill="${LABEL}" text-anchor="middle"` +
      ` opacity="${opacity}">${tx}</text>`;
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Color, String & Download Utilities
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

  /**
   * Convert a CSS color to a #rrggbb hex string so the exported SVG does not
   * depend on a viewer's hsl() support. Track paths, contour isolines and
   * cluster outlines all carry their color as an hsl(...) string (often with
   * a long-decimal hue, e.g. hsl(109.0909090909091, 100%, 55%)) which some SVG
   * renderers / Illustrator fail to parse and paint black — the "GPS tracks /
   * ISO contours export as black & white" bug. Hex, rgb()/rgba() and named
   * colors pass through unchanged.
   * @private
   */
  static _toHex(color) {
    if (!color || typeof color !== 'string' || color[0] === '#') return color;
    const m = color.match(/^hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)$/i);
    if (m) {
      return this._hslToHex(parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]));
    }
    return color;
  }

  static _img(x, y, w, h, url) {
    const u = this._esc(url);
    return `<image href="${u}" xlink:href="${u}" x="${x}" y="${y}" width="${w}" height="${h}" />`;
  }

  static _esc(v) {
    if (v == null) return '';
    return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  static async _download(svg, mode) {
    const baseName = (typeof GSRUI !== 'undefined' && typeof GSRUI._exportFilenameBase === 'function')
      ? GSRUI._exportFilenameBase()
      : 'biomapping';
    const suggestedName = `${baseName}_map_${mode}_export.svg`;
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    await GSRFileSaver.saveFile(blob, suggestedName);
  }
}

window.GSRMapExporter = GSRMapExporter;
