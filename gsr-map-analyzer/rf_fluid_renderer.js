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
      opacity: 0.65,
      radiusMeters: 120, // propagation radius in world meters
      numRays: 24, // number of radial rays cast per node
      mode: 'triband', // 'triband', '815', '868', '915', 'fog'
      visible: true
    }, options);

    this.canvas = null;
    this.ctx = null;
    this.drawPoints = [];
    this.osmGeomsRef = null;
    this.buildingPolygons = [];
    this.buildingSegmentsGeo = [];
    this.cachedNodes = [];
    this._currentBounds = null;
    this._canvasTopLeftLayer = { x: 0, y: 0 };
    this.enabled = true;

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
   * Set RF sample data & building geometries.
   * Only re-precalculates spatial fans when data array or OSM reference actually changes.
   */
  setData(drawPoints, osmGeoms) {
    const dataChanged = (this.drawPoints !== drawPoints);
    const geomsChanged = (this.osmGeomsRef !== osmGeoms);

    if (!dataChanged && !geomsChanged && this.cachedNodes.length > 0) {
      // Data reference unchanged — fast redraw cached state
      this.redraw();
      return;
    }

    this.drawPoints = drawPoints || [];
    this.osmGeomsRef = osmGeoms;
    this.buildingPolygons = [];
    this.buildingSegmentsGeo = [];

    if (osmGeoms) {
      const allWays = (osmGeoms.ways || []).concat(osmGeoms.relations || []);
      allWays.forEach(geom => {
        if (!geom.tags || !geom.tags.building) return;
        if (geom.type === 'way' && geom.coordinates && geom.coordinates.length > 2) {
          this.buildingPolygons.push(geom.coordinates);
        } else if (geom.type === 'relation' && geom.outerWays) {
          geom.outerWays.forEach(way => {
            if (way.coordinates && way.coordinates.length > 2) {
              this.buildingPolygons.push(way.coordinates);
            }
          });
        }
      });
    }

    // Build building line segments in Geographic Coordinates (lat/lon)
    for (let b = 0; b < this.buildingPolygons.length; b++) {
      const ring = this.buildingPolygons[b];
      for (let i = 0; i < ring.length - 1; i++) {
        this.buildingSegmentsGeo.push({ p1: ring[i], p2: ring[i + 1] });
      }
      if (ring.length > 2) {
        this.buildingSegmentsGeo.push({ p1: ring[ring.length - 1], p2: ring[0] });
      }
    }

    this._precalculateSpatialFans();
    this.redraw();
  }

  /**
   * Pre-compute radial propagation fan polygons in geographic lat/lon coordinates.
   * Downsamples nodes spatially (~6m world spacing) to keep node count optimal.
   */
  _precalculateSpatialFans() {
    this.cachedNodes = [];
    if (!this.drawPoints || this.drawPoints.length === 0) return;

    const numRays = this.options.numRays || 24;
    const radiusMeters = this.options.radiusMeters || 120;
    const metersPerDegLat = 111320;

    // Spatial node downsampling: ensure min ~6.0 meters separation in world space
    const minSpatialDistMeters = 6.0;
    let lastLat = null, lastLon = null;

    for (let i = 0; i < this.drawPoints.length; i++) {
      const pt = this.drawPoints[i];
      if (!pt || isNaN(pt.lat) || isNaN(pt.lon)) continue;

      const lat = pt.lat;
      const lon = pt.lon;

      if (lastLat !== null) {
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

      for (let s = 0; s < this.buildingSegmentsGeo.length; s++) {
        const seg = this.buildingSegmentsGeo[s];
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

      // Extract RSSI readings
      const r815 = pt.rssi_815 !== undefined && !isNaN(pt.rssi_815) ? pt.rssi_815 : (pt.r_815 || -91.5);
      const r868 = pt.rssi_868 !== undefined && !isNaN(pt.rssi_868) ? pt.rssi_868 : (pt.r_868 || -91.5);
      const r915 = pt.rssi_915 !== undefined && !isNaN(pt.rssi_915) ? pt.rssi_915 : (pt.r_915 || -91.5);
      const fog  = pt.em_fog   !== undefined && !isNaN(pt.em_fog)   ? pt.em_fog   : 0;

      this.cachedNodes.push({
        lat, lon,
        r815, r868, r915, fog,
        fanGeo
      });
    }
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
    this._precalculateSpatialFans();
    this.redraw();
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

    const bounds = this.map.getBounds().pad(0.3);
    const visibleNodes = [];

    const originLayerOffset = this._canvasTopLeftLayer || { x: 0, y: 0 };

    for (let i = 0; i < this.cachedNodes.length; i++) {
      const node = this.cachedNodes[i];
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
    const normDbm = (val) => Math.max(0, Math.min(1, (val - (-91.5)) / ((-30) - (-91.5))));

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
      let alpha = 0.5;

      if (mode === 'triband') {
        const n815 = normDbm(node.r815);
        const n868 = normDbm(node.r868);
        const n915 = normDbm(node.r915);

        rVal = Math.round(n815 * 244 + n915 * 100);
        gVal = Math.round(n868 * 220 + n915 * 60);
        bVal = Math.round(n915 * 240 + n815 * 90);
        alpha = Math.max(0.2, Math.max(n815, n868, n915) * 0.7);
      } else if (mode === '815') {
        const n = normDbm(node.r815);
        rVal = 244; gVal = 63; bVal = 94;
        alpha = n * 0.8;
      } else if (mode === '868') {
        const n = normDbm(node.r868);
        rVal = 16; gVal = 185; bVal = 129;
        alpha = n * 0.8;
      } else if (mode === '915') {
        const n = normDbm(node.r915);
        rVal = 6; gVal = 182; bVal = 212;
        alpha = n * 0.8;
      } else if (mode === 'fog') {
        const n = Math.min(1, node.fog / 30.0);
        rVal = Math.round(n * 255);
        gVal = Math.round((1 - n) * 150 + n * 50);
        bVal = Math.round((1 - n) * 255);
        alpha = Math.max(0.25, n * 0.75);
      }

      // Create Radial Gradient Fan
      const grad = this.ctx.createRadialGradient(originPx.x, originPx.y, 0, originPx.x, originPx.y, Math.max(10, maxPxRadius));
      grad.addColorStop(0, `rgba(${rVal}, ${gVal}, ${bVal}, ${alpha})`);
      grad.addColorStop(0.5, `rgba(${rVal}, ${gVal}, ${bVal}, ${alpha * 0.5})`);
      grad.addColorStop(1, `rgba(${rVal}, ${gVal}, ${bVal}, 0)`);

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
}
