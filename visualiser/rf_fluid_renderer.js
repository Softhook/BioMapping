/**
 * RFFluidRenderer — Pre-Calculated Spatial Ray-Casted RF Fluid Overlay for Leaflet
 *
 * Renders static 3-frequency (815, 868, 915 MHz) RSSI spatial fields as a fluid-like
 * background layer filling street canyons between OpenStreetMap building geometries.
 *
 * Native Leaflet GPU Hardware Acceleration & Layer Stacking:
 * Uses a dedicated Leaflet map pane ('rfFluidPane', zIndex 220) so the RF fluid field
 * sits safely BEHIND the GSR path tracks (400), peak markers (600), clusters, and labels.
 *
 * - Map Panning: 100% GPU accelerated by Leaflet's pane transform (0ms CPU usage).
 * - Map Zooming: 100% GPU scaled in lockstep with base map tiles during zoom gestures.
 * - Zoom End: Redrawn at crisp resolution.
 */

class RFFluidRenderer {
  constructor(map, options = {}) {
    this.map = map;
    this.options = Object.assign({
      opacity: 0.85, // High opacity as requested for vibrant, punchy fluid overlay
      radiusMeters: 35, // refined street canyon propagation radius in world meters
      numRays: 24, // number of radial rays cast per node
      mode: 'triband', // 'triband', '815', '868', '915', 'fog'
      visible: true,
      gain: 1.25, // Contrast/brightness gain boost
      autoRange: true // Adaptive RSSI dynamic range normalization per band
    }, options);

    this.canvas = null;
    this.ctx = null;
    this.drawPoints = [];
    this.osmGeomsRef = null;
    this.buildingPolygons = []; // combined across all tracks in the last setData(For Tracks) call
    this.cachedNodes = [];      // combined across all tracks in the last setData(For Tracks) call
    this.rssiStats = null;
    this._currentBounds = null;
    this._canvasTopLeftLayer = { x: 0, y: 0 };
    this.enabled = true;

    // Phase 5: per-track fan-cast cache. Key is whatever id setDataForTracks()
    // was called with (a track id, or '__single__' via the setData() wrapper).
    // Each entry holds the expensive-to-compute nodes/buildingPolygons for one
    // track, plus the inputs that produced them — a track whose drawPoints/
    // osmGeoms references and radius/rayCount are unchanged since the last call
    // reuses its entry instead of re-running _precalculateSpatialFans().
    this._trackCache = new Map();
    this._lastTracksData = null;

    this._initCanvas();
    this._bindEvents();
  }

  _initCanvas() {
    if (!this.map || typeof L === 'undefined') return;

    // Create a dedicated Leaflet map pane positioned between base tiles (200) and overlay vectors (400)
    if (!this.map.getPane('rfFluidPane')) {
      const pane = this.map.createPane('rfFluidPane');
      pane.style.zIndex = '220';
      pane.style.pointerEvents = 'none';
    }

    // Add leaflet-zoom-animated class so Leaflet GPU scales canvas in lockstep with base map tiles
    this.canvas = L.DomUtil.create('canvas', 'leaflet-zoom-animated rf-fluid-layer');
    this.canvas.style.position = 'absolute';
    this.canvas.style.pointerEvents = 'none';

    const rfPane = this.map.getPane('rfFluidPane');
    if (rfPane) {
      rfPane.appendChild(this.canvas);
    }
    this.ctx = this.canvas.getContext('2d');
    this.resizeCanvas();
  }

  _bindEvents() {
    if (!this.map || typeof this.map.on !== 'function') return;

    // Smooth Leaflet GPU Zoom Animation lockstep
    this.map.on('zoomanim', (e) => {
      if (!this.map || !this.canvas || !this._currentBounds) return;
      const scale = this.map.getZoomScale(e.zoom, this.map.getZoom());
      const nw = this._currentBounds.getNorthWest();
      const offset = this.map._latLngToNewLayerPoint(nw, e.zoom, e.center);
      L.DomUtil.setTransform(this.canvas, offset, scale);
    });

    // On zoom end or move end, re-anchor canvas and crisp redraw
    this.map.on('moveend zoomend resize viewreset', () => {
      this.resizeCanvas();
      this.redraw();
    });
  }

  resizeCanvas() {
    if (!this.map || !this.canvas) return;

    // Pad bounds so canvas covers slightly beyond visible map viewport
    const bounds = this.map.getBounds().pad(0.5);
    this._currentBounds = bounds;

    const nw = bounds.getNorthWest();
    const se = bounds.getSouthEast();

    const topLeft = this.map.latLngToLayerPoint(nw);
    const bottomRight = this.map.latLngToLayerPoint(se);

    const w = Math.max(10, Math.round(Math.abs(bottomRight.x - topLeft.x)));
    const h = Math.max(10, Math.round(Math.abs(bottomRight.y - topLeft.y)));

    L.DomUtil.setPosition(this.canvas, topLeft);
    L.DomUtil.setTransform(this.canvas, topLeft, 1);

    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';

    this._canvasTopLeftLayer = topLeft;

    if (this.ctx) {
      this.ctx.resetTransform();
      this.ctx.scale(dpr, dpr);
    }
  }

  /**
   * Set RF sample data & building geometries for a single logical track (or the
   * whole dataset, in single-track view). Thin wrapper around setDataForTracks()
   * using one fixed pseudo-id, so single-track view gets the same fan-cast
   * reuse fast path as collective view.
   */
  setData(drawPoints, osmGeoms) {
    this.drawPoints = drawPoints || [];
    this.osmGeomsRef = osmGeoms;
    this.setDataForTracks([{ id: '__single__', drawPoints, osmGeoms }]);
  }

  /**
   * Set RF sample data & building geometries for potentially several tracks at
   * once (collective view). Fan-casting (_precalculateSpatialFans) is the
   * expensive step — O(points x rays x building segments) — so it only re-runs
   * for a track whose drawPoints/osmGeoms reference (or radius/ray count)
   * actually changed since the last call; unchanged tracks reuse their cached
   * nodes. The combine step (concatenate per-track nodes/buildings, recompute
   * rssiStats, redraw) is cheap and always runs.
   *
   * @param {Array<{id: *, drawPoints: Array, osmGeoms: Object}>} tracksData
   */
  setDataForTracks(tracksData) {
    tracksData = tracksData || [];
    this._lastTracksData = tracksData;

    const radiusMeters = this.options.radiusMeters || 120;
    const numRays = this.options.numRays || 24;

    const activeIds = new Set();
    const combinedNodes = [];
    const combinedBuildingPolygons = [];

    for (let i = 0; i < tracksData.length; i++) {
      const t = tracksData[i];
      if (!t || t.id === undefined || t.id === null) continue;
      activeIds.add(t.id);

      const cached = this._trackCache.get(t.id);
      const reusable = cached &&
        cached.drawPointsRef === t.drawPoints &&
        cached.osmGeomsRef === t.osmGeoms &&
        cached.radiusMeters === radiusMeters &&
        cached.numRays === numRays;

      const entry = reusable ? cached : this._buildTrackEntry(t.drawPoints, t.osmGeoms, radiusMeters, numRays);
      if (!reusable) this._trackCache.set(t.id, entry);

      if (entry.nodes.length > 0) combinedNodes.push(...entry.nodes);
      if (entry.buildingPolygons.length > 0) combinedBuildingPolygons.push(...entry.buildingPolygons);
    }

    // Drop cache entries for tracks no longer present in this call — bounds
    // cache growth as tracks are added/removed over a session (mirrors the
    // "invalidated by that track's own data changing" scope from the plan;
    // a track that's gone is trivially "changed").
    for (const key of this._trackCache.keys()) {
      if (!activeIds.has(key)) this._trackCache.delete(key);
    }

    this.cachedNodes = combinedNodes;
    this.buildingPolygons = combinedBuildingPolygons;
    this._calculateRssiStats();
    this.redraw();
  }

  /**
   * Blank the canvas immediately without touching the per-track fan cache.
   * clearMap()/clearCollectiveLayers() (map.js) call this at the START of every
   * render pass as a "definitely no orphaned RF fluid" safety net, immediately
   * followed by a real setData()/setDataForTracks() call later in the same pass
   * — using setData([], null) here instead would prune every track's cached fan
   * geometry via that empty call's own bookkeeping, forcing a full recompute on
   * every single re-render and defeating the cache this method exists to keep.
   */
  clear() {
    this.cachedNodes = [];
    this.buildingPolygons = [];
    this.redraw();
  }

  /**
   * Build one track's worth of building segments + fan-cast nodes. Pure
   * function of its arguments (radiusMeters/numRays are read from options by
   * the caller so cache-key comparisons and the actual computation always
   * agree) — no instance state is read or written here.
   */
  _buildTrackEntry(drawPoints, osmGeoms, radiusMeters, numRays) {
    const buildingPolygons = [];
    const buildingSegmentsGeo = [];

    if (osmGeoms) {
      const allWays = (osmGeoms.ways || []).concat(osmGeoms.relations || []);
      allWays.forEach(geom => {
        if (!geom.tags || !geom.tags.building) return;
        if (geom.type === 'way' && geom.coordinates && geom.coordinates.length > 2) {
          buildingPolygons.push(geom.coordinates);
        } else if (geom.type === 'relation' && geom.outerWays) {
          geom.outerWays.forEach(way => {
            if (way.coordinates && way.coordinates.length > 2) {
              buildingPolygons.push(way.coordinates);
            }
          });
        }
      });
    }

    // Build building line segments in Geographic Coordinates (lat/lon)
    for (let b = 0; b < buildingPolygons.length; b++) {
      const ring = buildingPolygons[b];
      for (let i = 0; i < ring.length - 1; i++) {
        buildingSegmentsGeo.push({ p1: ring[i], p2: ring[i + 1] });
      }
      if (ring.length > 2) {
        buildingSegmentsGeo.push({ p1: ring[ring.length - 1], p2: ring[0] });
      }
    }

    const nodes = this._precalculateSpatialFans(drawPoints, buildingSegmentsGeo, radiusMeters, numRays);

    return { drawPointsRef: drawPoints, osmGeomsRef: osmGeoms, radiusMeters, numRays, nodes, buildingPolygons };
  }

  /**
   * Pre-compute radial propagation fan polygons in geographic lat/lon coordinates
   * for one track's drawPoints against one track's building segments.
   * Downsamples nodes spatially (~6m world spacing) to keep node count optimal.
   * Pure function — returns the nodes array rather than writing this.cachedNodes,
   * so per-track results can be cached and combined by setDataForTracks().
   */
  _precalculateSpatialFans(drawPoints, buildingSegmentsGeo, radiusMeters, numRays) {
    const nodes = [];
    if (!drawPoints || drawPoints.length === 0) return nodes;

    numRays = numRays || this.options.numRays || 24;
    radiusMeters = radiusMeters || this.options.radiusMeters || 120;
    const metersPerDegLat = 111320;

    // Spatial node downsampling: ensure min ~6.0 meters separation in world space
    const minSpatialDistMeters = 6.0;
    let lastLat = null, lastLon = null;

    for (let i = 0; i < drawPoints.length; i++) {
      const pt = drawPoints[i];
      if (!pt || isNaN(pt.lat) || isNaN(pt.lon)) continue;

      const lat = pt.lat;
      const lon = pt.lon;

      // A momentary RF spike (pt.isRfPeak, see GSRAnalyzer._detectRfPeakIndices())
      // always gets its own node — otherwise this spatial dedup silently erases
      // exactly the brief emissions this renderer exists to show, and multi-track
      // collective sessions revisiting the same spot make that far more likely.
      if (lastLat !== null && !pt.isRfPeak) {
        const dLatM = (lat - lastLat) * metersPerDegLat;
        const dLonM = (lon - lastLon) * metersPerDegLat * Math.cos((lat * Math.PI) / 180.0);
        if (dLatM * dLatM + dLonM * dLonM < minSpatialDistMeters * minSpatialDistMeters) {
          continue; // Skip points too close in geographic space
        }
      }
      lastLat = lat;
      lastLon = lon;

      const cosLat = Math.cos((lat * Math.PI) / 180.0);
      const metersPerDegLon = metersPerDegLat * Math.max(0.1, cosLat);

      const dLatMax = radiusMeters / metersPerDegLat;
      const dLonMax = radiusMeters / metersPerDegLon;

      const origin = { lat, lon };
      const fanGeo = [];

      // Spatial bounding box filter for candidate building segments
      const nearbySegments = [];
      const nodeBbox = {
        minLat: lat - dLatMax * 1.2,
        maxLat: lat + dLatMax * 1.2,
        minLon: lon - dLonMax * 1.2,
        maxLon: lon + dLonMax * 1.2
      };

      for (let s = 0; s < buildingSegmentsGeo.length; s++) {
        const seg = buildingSegmentsGeo[s];
        if (Math.min(seg.p1.lat, seg.p2.lat) <= nodeBbox.maxLat &&
            Math.max(seg.p1.lat, seg.p2.lat) >= nodeBbox.minLat &&
            Math.min(seg.p1.lon, seg.p2.lon) <= nodeBbox.maxLon &&
            Math.max(seg.p1.lon, seg.p2.lon) >= nodeBbox.minLon) {
          nearbySegments.push(seg);
        }
      }

      // Cast spatial rays
      for (let r = 0; r < numRays; r++) {
        const angle = (r / numRays) * Math.PI * 2;
        const dirGeo = {
          dLon: Math.cos(angle) * dLonMax,
          dLat: Math.sin(angle) * dLatMax
        };

        let closestT = 1.0;

        for (let s = 0; s < nearbySegments.length; s++) {
          const seg = nearbySegments[s];
          const t = this._raySegmentIntersectionGeo(origin, dirGeo, seg.p1, seg.p2);
          if (t !== null && t < closestT) {
            closestT = t;
          }
        }

        fanGeo.push({
          lat: lat + dirGeo.dLat * closestT,
          lon: lon + dirGeo.dLon * closestT
        });
      }

      // Extract RSSI readings & RF presence flags
      const has815 = pt.rssi_815 !== undefined && !isNaN(pt.rssi_815);
      const has868 = pt.rssi_868 !== undefined && !isNaN(pt.rssi_868);
      const has915 = pt.rssi_915 !== undefined && !isNaN(pt.rssi_915);
      const emFogMissing = pt.em_fog === undefined || isNaN(pt.em_fog);
      let fog = emFogMissing ? 0 : pt.em_fog;
      if (emFogMissing && typeof GSRAnalyzer !== 'undefined' && GSRAnalyzer.calcEmFog) {
        const fallback = GSRAnalyzer.calcEmFog(pt);
        if (!isNaN(fallback)) fog = fallback;
      }
      const hasFog = fog > 0;

      const r815 = has815 ? pt.rssi_815 : (pt.r_815 || -91.5);
      const r868 = has868 ? pt.rssi_868 : (pt.r_868 || -91.5);
      const r915 = has915 ? pt.rssi_915 : (pt.r_915 || -91.5);
      const hasRf = has815 || has868 || has915 || hasFog;

      nodes.push({
        lat, lon,
        r815, r868, r915, fog,
        hasRf, has815, has868, has915, hasFog,
        fanGeo
      });
    }

    return nodes;
  }

  /**
   * Calculate adaptive noise floor and peak RSSI per band across loaded nodes
   */
  _calculateRssiStats() {
    let min815 = Infinity, max815 = -Infinity;
    let min868 = Infinity, max868 = -Infinity;
    let min915 = Infinity, max915 = -Infinity;

    for (let i = 0; i < this.cachedNodes.length; i++) {
      const node = this.cachedNodes[i];
      if (node.has815 && !isNaN(node.r815)) {
        if (node.r815 < min815) min815 = node.r815;
        if (node.r815 > max815) max815 = node.r815;
      }
      if (node.has868 && !isNaN(node.r868)) {
        if (node.r868 < min868) min868 = node.r868;
        if (node.r868 > max868) max868 = node.r868;
      }
      if (node.has915 && !isNaN(node.r915)) {
        if (node.r915 < min915) min915 = node.r915;
        if (node.r915 > max915) max915 = node.r915;
      }
    }

    // Absolute Hardware / Squelch noise floor cutoff (-90.0 dBm).
    // Readings at or below -90.0 dBm are ambient noise, not active RF detections.
    const hardNoiseFloor = -90.0;

    const calcBandStats = (minVal, maxVal) => {
      const floor = isFinite(minVal) ? minVal : -91.5;
      const peak  = isFinite(maxVal) ? maxVal : -91.5;
      // Active signal flag: peak must exceed absolute noise floor (-90.0 dBm) AND rise >= 3.0 dBm above track minimum floor
      const hasActiveSignal = (peak > hardNoiseFloor) && ((peak - floor) >= 3.0);
      return { floor, peak, hasActiveSignal };
    };

    this.rssiStats = {
      815: calcBandStats(min815, max815),
      868: calcBandStats(min868, max868),
      915: calcBandStats(min915, max915)
    };
  }

  /**
   * Thresholded RSSI Normalizer:
   * Returns 0.0 for ambient noise floor signals (<= -85.0 dBm or <= floor + 5.0 dBm).
   * Scales smoothly [0.0 -> 1.0] ONLY for active RF signals exceeding noise floor.
   */
  _normDbm(val, bandKey) {
    if (val === undefined || isNaN(val)) return 0.0;
    const stats = (this.options.autoRange && this.rssiStats && this.rssiStats[bandKey])
      ? this.rssiStats[bandKey]
      : { floor: -91.5, peak: -60.0, hasActiveSignal: false };

    // If band has no active signals exceeding noise floor on this track, return 0.0
    if (!stats.hasActiveSignal) return 0.0;

    const hardNoiseFloor = -90.0;
    const floor = stats.floor;
    const peak  = stats.peak;

    // Threshold offset: signal must exceed both absolute hard noise floor (-90 dBm) AND local floor + 3.0 dBm
    const threshold = Math.max(hardNoiseFloor, floor + 3.0);

    if (val <= threshold) {
      return 0.0; // Ambient noise floor — zero fluid rendered
    }

    const activeRange = Math.max(5.0, peak - threshold);
    let norm = (val - threshold) / activeRange;
    norm = Math.max(0, Math.min(1, norm));

    // Non-linear gamma curve (0.75) for high visual contrast on active detections
    const boosted = Math.pow(norm, 0.75) * (this.options.gain || 1.15);
    return Math.max(0, Math.min(1, boosted));
  }

  setMode(mode) {
    this.options.mode = mode;
    this.redraw();
  }

  setOpacity(opacity) {
    this.options.opacity = opacity;
    this.redraw();
  }

  setRadius(radius) {
    this.options.radiusMeters = radius;
    // Re-run the last setData(For Tracks) call — every per-track cache entry's
    // radiusMeters check in setDataForTracks() will now mismatch the new value,
    // so this naturally recomputes fans for every active track without needing
    // to manually clear _trackCache first.
    this.setDataForTracks(this._lastTracksData || []);
  }

  setVisible(visible) {
    this.options.visible = visible;
    if (this.canvas) {
      this.canvas.style.display = visible ? 'block' : 'none';
    }
    if (visible) this.redraw();
  }

  /**
   * Ray-segment intersection in Geographic (lat/lon) Space
   */
  _raySegmentIntersectionGeo(origin, dirGeo, segP1, segP2) {
    const ox = origin.lon, oy = origin.lat;
    const dx = dirGeo.dLon, dy = dirGeo.dLat;
    const x1 = segP1.lon, y1 = segP1.lat;
    const x2 = segP2.lon, y2 = segP2.lat;

    const sx = x2 - x1;
    const sy = y2 - y1;

    const denom = dx * sy - dy * sx;
    if (Math.abs(denom) < 1e-12) return null; // Parallel

    const t = ((x1 - ox) * sy - (y1 - oy) * sx) / denom;
    const u = ((x1 - ox) * dy - (y1 - oy) * dx) / denom;

    if (t > 0 && u >= 0 && u <= 1) {
      return t; // Distance fraction [0, 1]
    }
    return null;
  }

  /**
   * Crisp Redraw Loop
   * Projects pre-computed geographic fan points to container pixels using Leaflet layer points.
   */
  redraw() {
    if (!this.ctx || !this.canvas || !this.options.visible || !this.map) return;

    const size = this.map.getSize();
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    if (!this.cachedNodes || this.cachedNodes.length === 0) return;
    if (!this.cachedNodes.some(n => n.hasRf)) return;

    const bounds = this.map.getBounds().pad(0.3);
    const visibleNodes = [];

    const originLayerOffset = this._canvasTopLeftLayer || { x: 0, y: 0 };

    for (let i = 0; i < this.cachedNodes.length; i++) {
      const node = this.cachedNodes[i];
      if (!node.hasRf) continue;
      if (!bounds.contains([node.lat, node.lon])) continue;

      const layerPt = this.map.latLngToLayerPoint([node.lat, node.lon]);
      const canvasPt = {
        x: layerPt.x - originLayerOffset.x,
        y: layerPt.y - originLayerOffset.y
      };

      visibleNodes.push({
        node,
        originPx: canvasPt
      });
    }

    if (visibleNodes.length === 0) return;

    // Viewport-Clipped Building Footprints: project ONLY buildings inside active view
    const screenBuildingPolys = [];
    for (let b = 0; b < this.buildingPolygons.length; b++) {
      const ring = this.buildingPolygons[b];
      let inBounds = false;
      for (let i = 0; i < ring.length; i++) {
        if (bounds.contains([ring[i].lat, ring[i].lon])) {
          inBounds = true;
          break;
        }
      }
      if (!inBounds) continue;

      const pts = [];
      for (let i = 0; i < ring.length; i++) {
        const lpt = this.map.latLngToLayerPoint([ring[i].lat, ring[i].lon]);
        pts.push({
          x: lpt.x - originLayerOffset.x,
          y: lpt.y - originLayerOffset.y
        });
      }
      screenBuildingPolys.push(pts);
    }

    // Configure canvas opacity and screen composite mode
    this.ctx.save();
    this.ctx.globalAlpha = this.options.opacity;
    this.ctx.globalCompositeOperation = 'screen';

    const mode = this.options.mode;

    // Draw pre-calculated propagation fans
    for (let p = 0; p < visibleNodes.length; p++) {
      const { node, originPx } = visibleNodes[p];

      // Fast projection of pre-computed lat/lon fan points
      const rayPoints = [];
      let maxPxRadius = 10;

      for (let r = 0; r < node.fanGeo.length; r++) {
        const ptGeo = node.fanGeo[r];
        const lpt = this.map.latLngToLayerPoint([ptGeo.lat, ptGeo.lon]);
        const pxPt = {
          x: lpt.x - originLayerOffset.x,
          y: lpt.y - originLayerOffset.y
        };
        rayPoints.push(pxPt);

        const dx = pxPt.x - originPx.x;
        const dy = pxPt.y - originPx.y;
        const distSq = dx * dx + dy * dy;
        if (distSq > maxPxRadius * maxPxRadius) {
          maxPxRadius = Math.sqrt(distSq);
        }
      }

      // Multi-Spectral Color based on Mode
      let rVal = 0, gVal = 0, bVal = 0;
      let alpha = 0.0;

      if (mode === 'triband') {
        const n815 = node.has815 ? this._normDbm(node.r815, 815) : 0;
        const n868 = node.has868 ? this._normDbm(node.r868, 868) : 0;
        const n915 = node.has915 ? this._normDbm(node.r915, 915) : 0;

        // Pure orthogonal additive multi-spectral RGB synthesis:
        // 815 MHz (LTE Edge)   -> Pure Red   (255, 0, 0)
        // 868 MHz (Grid Smart) -> Pure Green (0, 255, 0)
        // 915 MHz (ISM SubGHz) -> Pure Blue  (0, 0, 255)
        rVal = Math.round(n815 * 255);
        gVal = Math.round(n868 * 255);
        bVal = Math.round(n915 * 255);

        rVal = Math.min(255, rVal);
        gVal = Math.min(255, gVal);
        bVal = Math.min(255, bVal);

        const maxN = Math.max(n815, n868, n915);
        alpha = Math.min(1.0, maxN * 0.95);
      } else if (mode === '815') {
        const n = node.has815 ? this._normDbm(node.r815, 815) : 0;
        rVal = 255; gVal = 0; bVal = 0;
        alpha = Math.min(1.0, n * 0.95);
      } else if (mode === '868') {
        const n = node.has868 ? this._normDbm(node.r868, 868) : 0;
        rVal = 0; gVal = 255; bVal = 0;
        alpha = Math.min(1.0, n * 0.95);
      } else if (mode === '915') {
        const n = node.has915 ? this._normDbm(node.r915, 915) : 0;
        rVal = 0; gVal = 0; bVal = 255;
        alpha = Math.min(1.0, n * 0.95);
      } else if (mode === 'fog') {
        if (!node.hasFog || node.fog <= 0) {
          alpha = 0;
        } else {
          const n = Math.min(1, Math.max(0, node.fog / 100.0));
          rVal = Math.round(n * 255);
          gVal = 0;
          bVal = Math.round((1 - n) * 255);
          alpha = n > 0.05 ? Math.min(1.0, n * 0.95) : 0.0;
        }
      }

      if (alpha <= 0) continue;

      // Smooth Gaussian falloff gradient fan
      const grad = this.ctx.createRadialGradient(originPx.x, originPx.y, 0, originPx.x, originPx.y, Math.max(8, maxPxRadius));
      grad.addColorStop(0.0, `rgba(${rVal}, ${gVal}, ${bVal}, ${alpha})`);
      grad.addColorStop(0.4, `rgba(${rVal}, ${gVal}, ${bVal}, ${alpha * 0.75})`);
      grad.addColorStop(0.8, `rgba(${rVal}, ${gVal}, ${bVal}, ${alpha * 0.30})`);
      grad.addColorStop(1.0, `rgba(${rVal}, ${gVal}, ${bVal}, 0)`);

      // Fill pre-computed ray polygon
      this.ctx.beginPath();
      this.ctx.moveTo(rayPoints[0].x, rayPoints[0].y);
      for (let r = 1; r < rayPoints.length; r++) {
        this.ctx.lineTo(rayPoints[r].x, rayPoints[r].y);
      }
      this.ctx.closePath();

      this.ctx.fillStyle = grad;
      this.ctx.fill();
    }

    // Clip out Building Footprints so zero fluid bleeds inside buildings
    if (screenBuildingPolys.length > 0) {
      this.ctx.globalCompositeOperation = 'destination-out';
      this.ctx.fillStyle = 'rgba(0, 0, 0, 1)';

      for (let b = 0; b < screenBuildingPolys.length; b++) {
        const pts = screenBuildingPolys[b];
        if (pts.length < 3) continue;
        this.ctx.beginPath();
        this.ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) {
          this.ctx.lineTo(pts[i].x, pts[i].y);
        }
        this.ctx.closePath();
        this.ctx.fill();
      }
    }

    this.ctx.restore();
  }

  /**
   * Export pre-calculated ray fans and building footprint clip mask as Illustrator-compatible SVG elements.
   * @param {Function} project Mercator projection function converting {lat, lon} or [lat, lon] to SVG canvas (x, y)
   * @param {number} targetW SVG canvas width in pixels
   * @param {number} targetH SVG canvas height in pixels
   * @returns {{ defs: string[], polygons: string[] }} SVG defs and polygon markup strings
   */
  exportToSvgElements(project, targetW = 2000, targetH = 2000) {
    const result = { defs: [], layers: { '815': [], '868': [], '915': [], 'fog': [] }, polygons: [] };
    if (!this.cachedNodes || this.cachedNodes.length === 0) return result;
    if (!this.cachedNodes.some(n => n.hasRf)) return result;

    const mode = this.options.mode;
    const globalOpacity = this.options.opacity !== undefined ? this.options.opacity : 0.85;
    const defs = [];
    const layers = { '815': [], '868': [], '915': [], 'fog': [] };
    const polygons = [];

    const addGradientAndPoly = (gradId, rVal, gVal, bVal, alpha, ptsStr, effectiveRadius, originPx, targetLayerKey) => {
      const gradStr =
        `<radialGradient id="${gradId}" cx="${originPx.x.toFixed(2)}" cy="${originPx.y.toFixed(2)}" r="${effectiveRadius.toFixed(2)}" gradientUnits="userSpaceOnUse">\n` +
        `  <stop offset="0%" stop-color="rgb(${rVal},${gVal},${bVal})" stop-opacity="${(alpha * globalOpacity).toFixed(3)}" />\n` +
        `  <stop offset="40%" stop-color="rgb(${rVal},${gVal},${bVal})" stop-opacity="${(alpha * 0.75 * globalOpacity).toFixed(3)}" />\n` +
        `  <stop offset="80%" stop-color="rgb(${rVal},${gVal},${bVal})" stop-opacity="${(alpha * 0.30 * globalOpacity).toFixed(3)}" />\n` +
        `  <stop offset="100%" stop-color="rgb(${rVal},${gVal},${bVal})" stop-opacity="0" />\n` +
        `</radialGradient>`;

      defs.push(gradStr);
      const polyStr = `<polygon points="${ptsStr}" fill="url(#${gradId})" />`;
      polygons.push(polyStr);
      if (layers[targetLayerKey]) {
        layers[targetLayerKey].push(polyStr);
      }
    };

    for (let i = 0; i < this.cachedNodes.length; i++) {
      const node = this.cachedNodes[i];
      if (!node.hasRf || !node.fanGeo || node.fanGeo.length === 0) continue;

      const originPx = project({ lat: node.lat, lon: node.lon });
      if (isNaN(originPx.x) || isNaN(originPx.y)) continue;

      const rayPoints = [];
      let maxPxRadius = 10;

      for (let r = 0; r < node.fanGeo.length; r++) {
        const ptGeo = node.fanGeo[r];
        const pxPt = project({ lat: ptGeo.lat, lon: ptGeo.lon });
        rayPoints.push(pxPt);

        const dx = pxPt.x - originPx.x;
        const dy = pxPt.y - originPx.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > maxPxRadius) {
          maxPxRadius = dist;
        }
      }

      if (rayPoints.length < 3) continue;
      const ptsStr = rayPoints.map(p => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
      const effectiveRadius = Math.max(8, maxPxRadius);

      // Separate exports for individual frequency channels
      const process815 = mode === 'triband' || mode === '815';
      const process868 = mode === 'triband' || mode === '868';
      const process915 = mode === 'triband' || mode === '915';
      const processFog = mode === 'fog';

      if (process815 && node.has815) {
        const n815 = this._normDbm(node.r815, 815);
        const alpha815 = Math.min(1.0, n815 * 0.95);
        if (alpha815 > 0) {
          addGradientAndPoly(`rfGrad_815_node_${i}`, 255, 0, 0, alpha815, ptsStr, effectiveRadius, originPx, '815');
        }
      }

      if (process868 && node.has868) {
        const n868 = this._normDbm(node.r868, 868);
        const alpha868 = Math.min(1.0, n868 * 0.95);
        if (alpha868 > 0) {
          addGradientAndPoly(`rfGrad_868_node_${i}`, 0, 255, 0, alpha868, ptsStr, effectiveRadius, originPx, '868');
        }
      }

      if (process915 && node.has915) {
        const n915 = this._normDbm(node.r915, 915);
        const alpha915 = Math.min(1.0, n915 * 0.95);
        if (alpha915 > 0) {
          addGradientAndPoly(`rfGrad_915_node_${i}`, 0, 0, 255, alpha915, ptsStr, effectiveRadius, originPx, '915');
        }
      }

      if (processFog && node.hasFog && node.fog > 0) {
        const nFog = Math.min(1, Math.max(0, node.fog / 100.0));
        const alphaFog = nFog > 0.05 ? Math.min(1.0, nFog * 0.95) : 0.0;
        if (alphaFog > 0) {
          const rVal = Math.round(nFog * 255);
          const bVal = Math.round((1 - nFog) * 255);
          addGradientAndPoly(`rfGrad_fog_node_${i}`, rVal, 0, bVal, alphaFog, ptsStr, effectiveRadius, originPx, 'fog');
        }
      }
    }

    // Building Footprint Clip Mask Definition
    if (this.buildingPolygons && this.buildingPolygons.length > 0) {
      const maskPolys = [];
      for (let b = 0; b < this.buildingPolygons.length; b++) {
        const ring = this.buildingPolygons[b];
        if (!ring || ring.length < 3) continue;
        const pts = ring.map(ll => project({ lat: ll.lat, lon: ll.lon }));
        const ptsStr = pts.map(p => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
        maskPolys.push(`    <polygon points="${ptsStr}" fill="#000000" />`);
      }

      if (maskPolys.length > 0) {
        const maskStr =
          `<mask id="rfBuildingMask" maskUnits="userSpaceOnUse">\n` +
          `  <rect x="0" y="0" width="${targetW}" height="${targetH}" fill="#ffffff" />\n` +
          maskPolys.join('\n') + '\n' +
          `</mask>`;
        defs.push(maskStr);
      }
    }

    result.defs = defs;
    result.layers = layers;
    result.polygons = polygons;
    return result;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { RFFluidRenderer };
}
if (typeof window !== 'undefined') {
  window.RFFluidRenderer = RFFluidRenderer;
}
