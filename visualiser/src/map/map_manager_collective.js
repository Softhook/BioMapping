/**
 * GSRMapManager — collective / multi-track view rendering. Prototype-augment
 * split from map.js: loaded immediately after map.js, adds these methods to
 * GSRMapManager.prototype.
 *
 * renderCollectiveData() overlays every active track (dashed paths + per-track
 * peak/hotspot markers via the map_manager_peaks.js methods), runs one global
 * spatial-clustering pass, frames the combined bounds, and calls
 * renderContours(); renderContours() turns collectiveManager.generateContourSurface()
 * output into the shaded surface overlay (+ optional hillshade relief and
 * coverage hatch) and the smoothed isoline polylines. clearCollectiveLayers() /
 * clearContours() tear those down.
 *
 * Depends on the globals L, MapColors, Hillshade, StatsMath, GSR_CONST,
 * GSRSpatialClustering, GeoUtils and AppState (resolved at call time).
 */
Object.assign(GSRMapManager.prototype, {

  /**
   * Remove all collective track paths and peak markers from the map.
   */
  clearCollectiveLayers() {
    // Phase 1 (slice 3): the collective per-track layers live in the track
    // layerGroups — clear them here too (idempotent with clearMap) so the
    // "uncheck the last track" path (which calls this without a re-render)
    // can't leave a stale group behind.
    this._clearRenderedTrackGroups();
    this.clusterLayers = this._clearLayerGroup(this.clusterLayers);
    this.clearContours();
    this._clearRfFluid();
    // There is no graph to scrub in collective view — drop any scrub indicator
    // left over from single-track hover. clearMap covers the full clearAll()
    // path; this covers the 0-active-tracks path, which only calls
    // clearCollectiveLayers() (and noLoop() stops handleScrubber from hiding it).
    if (this.scrubMarker && this.map && this.map.hasLayer(this.scrubMarker)) {
      this.map.removeLayer(this.scrubMarker);
    }
  },

  /**
   * Remove only the topographic isolines layer from the map.
   */
  clearContours() {
    this.contourLayers = this._clearLayerGroup(this.contourLayers);
    if (this.surfaceOverlay) {
      this.map.removeLayer(this.surfaceOverlay);
      this.surfaceOverlay = null;
    }
    if (this.coverageOverlay) {
      this.map.removeLayer(this.coverageOverlay);
      this.coverageOverlay = null;
    }
  },

  /**
   * Render all active tracks overlaid simultaneously, then draw contour lines.
   */
  renderCollectiveData(collectiveManager, contourParams = {}, peakLatency) {
    this.clearAll(); // Clear single-track drawing + prior collective layers

    const activeTracks = collectiveManager.getActiveTracks();
    if (activeTracks.length === 0) {
      // Force a re-fit next time any track becomes active again — otherwise if the user
      // pans/zooms elsewhere while the collective view is empty, then reactivates the exact
      // same track set later, the stale signature below would wrongly look "unchanged" and
      // skip re-framing them.
      this._lastFitBoundsTrackSet = null;
      return;
    }

    // Signature of which tracks are active — used below to only auto-fit the viewport when
    // the active track set actually changed, not on every contour/cluster slider re-render.
    const trackSetSignature = activeTracks.map(t => t.id).sort().join(',');

    const allActivePeaksAcrossTracks = [];
    let collectiveDrawPoints = [];
    // Phase 5: per-track drawPoints/osmGeoms references (not concatenated) so
    // RFFluidRenderer.setDataForTracks() can reuse cached fan-cast geometry
    // for tracks whose data didn't change (see that method's doc comment).
    const rfTracksData = [];

    // 1. Draw dashed, semi-transparent paths for each track
    activeTracks.forEach(track => {
      const data = track.analyzer.raw;
      const p = track.gpsFilterParams || {};

      // Phase 1 (slice 2): each active track owns a layerGroup; all of this
      // track's collective layers (path, peaks, connectors, hotspots) render
      // into it, so removal/deactivation of the track reduces to
      // map.removeLayer(track.layerGroup).
      const layerGroup = this._getTrackLayerGroup(track);

      // Use cached GPS pipeline (cache keyed by track id)
      const { drawPoints } = this._getOrBuildDrawPoints(track.id, track.analyzer, p);
      if (drawPoints.length > 0) {
        collectiveDrawPoints.push(...drawPoints);
        rfTracksData.push({ id: track.id, drawPoints, osmGeoms: track.analyzer && track.analyzer.osmGeoms });
      }

      if (drawPoints.length < 2) return;

      const latlngs = drawPoints.map(pt => [pt.lat, pt.lon]);
      const trackColor = track.color || '#0ea5e9';

      const poly = L.polyline(latlngs, {
        color: trackColor,
        weight: 3,
        opacity: 0.35,
        dashArray: '5, 8'
      });
      // Phase 1 (slice 2): the collective path renders into this track's own
      // layerGroup, never directly onto the map. Tag the group ALWAYS (even
      // when showTracks is off) so toggling the Tracks control back on routes
      // the path through the group — tagging only when visible made paths
      // fall back to direct-to-map adds that survived the track's removal.
      poly._gsrKind = 'collectivePath';
      poly._gsrLayerGroup = layerGroup;
      if (this.showTracks) {
        layerGroup.addLayer(poly);
      }
      this._registerTrackLayer(track, poly);

      // 2. Draw peak dot markers — 360° label placement with collision avoidance
      this._renderCollectiveTrackPeaks(track, layerGroup, trackColor, peakLatency, allActivePeaksAcrossTracks);

      // Hotspot markers for this track — same shared icon/styling as the
      // single-track view (_renderHotspotMarkers), deliberately NOT
      // track-coloured like the regular collective peak dots above: a
      // hotspot's whole point is to stand out as "one of the biggest events,
      // in any track," so it keeps the fixed hotspot-red across every track
      // rather than blending into that track's own color scheme.
      this._renderCollectiveTrackHotspots(track, peakLatency);
    });

    if (collectiveDrawPoints.length > 0) {
      this._lastDrawPoints = collectiveDrawPoints;
    }
    if (this.rfFluidRenderer && rfTracksData.length > 0) {
      this.rfFluidRenderer.setDataForTracks(rfTracksData);
    }
    this._updateRfFluidButtonState(activeTracks.some(t => t.analyzer && t.analyzer.hasRfData));

    // Render collective global clusters across all active tracks
    if (allActivePeaksAcrossTracks.length > 0 && typeof GSRSpatialClustering !== 'undefined') {
      // Retrieve dynamic clustering parameters from UI sliders
      const { boundaryRadius, sigma, effectiveProximity } = this._getClusteringParams();

      const refAmplitude = this._meanAmplitude(allActivePeaksAcrossTracks);
      const clusters = GSRSpatialClustering.clusterPeaks(allActivePeaksAcrossTracks, effectiveProximity, boundaryRadius, sigma);
      this._renderClusters(clusters, refAmplitude, sigma, boundaryRadius);
    }

    // 3. Zoom and Pan Map to fit collective bounding envelope — but only when the active
    // track set actually changed (tracks added/removed/toggled). Re-fitting on every contour
    // slider tweak would reset the zoom the user had picked to inspect a specific area.
    if (trackSetSignature !== this._lastFitBoundsTrackSet) {
      const bounds = collectiveManager.getBounds();
      if (bounds && this.map) {
        const bbox = [
          [bounds.minLat, bounds.minLon],
          [bounds.maxLat, bounds.maxLon]
        ];
        this._flyOrFitBounds(bbox, { padding: [40, 40] });
      }
      this._lastFitBoundsTrackSet = trackSetSignature;
      if (!this._lastFitBoundsTrackId && typeof AppState !== 'undefined' && AppState.activeTrackId) {
        this._lastFitBoundsTrackId = AppState.activeTrackId;
      }
    }

    // 4. Calculate and render topographic contour lines
    this.renderContours(collectiveManager, contourParams);

    // Apply the active peak/label toggle styles
    this.updateMarkerVisibility();

    // Update legend for collective view
    this.updateLegend();

    if (typeof AppState !== 'undefined' && AppState.emit) AppState.emit('map:rendered');
  },

  /**
   * Call contour generation math and draw vector polyline boundaries
   */
  renderContours(collectiveManager, contourParams) {
    this.clearContours();

    const surfaceData = collectiveManager.generateContourSurface(contourParams);
    if (!surfaceData || !surfaceData.contours) {
      this._collectiveTopographySource = null;
      this._legendMinVal = 0;
      this._legendMaxVal = 0;
      return;
    }
    this.surfaceData = surfaceData;

    const { contours, grid, minVal, maxVal, bounds, sortedVals, upsampledCoverageRatioGrid } = surfaceData;
    this._collectiveTopographySource = contourParams.topographySource;
    this._legendMinVal = minVal;
    this._legendMaxVal = maxVal;
    const { surfaceOpacity = 0.40 } = contourParams;
    const hillshadeStrength = contourParams.hillshadeStrength !== undefined ? contourParams.hillshadeStrength : 0.0;
    const coverageWeighting = contourParams.coverageWeighting !== undefined ? contourParams.coverageWeighting : 0.0;

    // 1. Draw shaded continuous surface overlay.
    //    The overlay is created whenever there is surface data — it is NOT gated
    //    on the button's showShadedSurface state. Gating creation meant a
    //    re-render while the surface was hidden (e.g. deleting a track with the
    //    surface off) ran clearContours() (which nulls surfaceOverlay) and then
    //    skipped recreating it, so toggleSurface(true)'s `if (!this.surfaceOverlay)
    //    return;` had nothing to re-add and the surface never came back. Visibility
    //    is a pure add/remove of this overlay via this.showSurface — same pattern
    //    as the isoline/track toggles, which also always create their layers.
    const activeGrid = surfaceData.upsampledGrid || grid;
    if (activeGrid && activeGrid.length > 0 && bounds) {
      const rows = activeGrid.length;
      const cols = activeGrid[0].length;

      const canvas = document.createElement('canvas');
      canvas.width = cols;
      canvas.height = rows;
      const ctx = canvas.getContext('2d');

      // Remember for GSRMapExporter's SVG export, which recomputes this same
      // shading over its own vector mesh (map_exporter.js _buildVectorMesh)
      // and needs to match what's currently on screen.
      this._hillshadeStrength = hillshadeStrength;

      const drawCell = (r, c, ratio, lightness) => {
        ctx.fillStyle = MapColors.getHslColor(ratio, 100, lightness);
        ctx.fillRect(c, rows - 1 - r, 1, 1);
      };

      if (hillshadeStrength <= 0) {
        // True zero-overhead path at 0% strength: no ratio grid, no
        // Hillshade.compute() slope/aspect pass, no per-cell shade blend —
        // just Hillshade.valueRatio() (an O(1), allocation-free lookup) per
        // cell at a fixed 50% lightness, the same cost class as the
        // pre-hillshade single-pass loop this replaced.
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            const val = activeGrid[r][c];
            if (val === null || isNaN(val)) continue;
            drawCell(r, c, Hillshade.valueRatio(val, minVal, maxVal, sortedVals, StatsMath.percentileRank), 50);
          }
        }
      } else {
        // ratioGrid is the SAME field that drives both the fill hue below
        // and, in generateContourSurface(), where the isoline levels
        // themselves land (both percentile-based, not linear-value-based —
        // see that method's comment on why: it keeps bands/lines spread
        // across where the distribution actually varies instead of bunching
        // on a flat majority). shadeValueGrid() hillshades that SAME ratio
        // field, not the raw value, so the relief is the literal same
        // surface the isolines and colors are drawn from.
        const hc = GSR_CONST.HILLSHADE;
        const { ratioGrid, shade } = Hillshade.shadeValueGrid(activeGrid, rows, cols, {
          minVal, maxVal, sortedVals, rankFn: StatsMath.percentileRank,
          exaggeration: hc.exaggeration, azimuthDeg: hc.azimuthDeg, altitudeDeg: hc.altitudeDeg
        });

        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            const ratio = ratioGrid[r][c];
            if (ratio === null) continue;
            // Lightness carries the hillshade relief (dark = shadowed, bright =
            // sun-facing); hue/saturation still carry the data value via `ratio`.
            const lightness = Hillshade.blendLightness(shade[r * cols + c], hillshadeStrength, hc.minLightness, hc.maxLightness);
            drawCell(r, c, ratio, lightness);
          }
        }
      }

      const imageBounds = [
        [bounds.minLat, bounds.minLon],
        [bounds.maxLat, bounds.maxLon]
      ];

      this.surfaceOverlay = L.imageOverlay(canvas.toDataURL(), imageBounds, {
        opacity: surfaceOpacity,
        interactive: false,
        className: 'collective-surface-overlay'
      });
      if (this.showSurface) this.surfaceOverlay.addTo(this.map);

      // 1b. Coverage hatch — a SEPARATE raster layer, not baked into the color canvas
      // above. That canvas is intentionally small and gets stretched with smooth
      // interpolation (bicubic-upsampled, blurred) so the color gradient looks continuous —
      // exactly the wrong scaling mode for a crisp overlay pattern, which would blur into
      // grey mush at most zoom levels if it shared that canvas. Instead this draws its own
      // raster at a finer resolution, and .collective-coverage-hatch (styles.css) forces
      // nearest-neighbour scaling on just this layer, so the lines stay crisp at any zoom
      // while the color layer underneath keeps its smooth blur.
      //
      // Diagonal lines, not a checkerboard: a checkerboard's alternating cells read via
      // brightness CONTRAST BETWEEN NEIGHBORING cells — which the color data underneath
      // (itself varying cell to cell) visually collides with, breaking the grid up into
      // noise. A continuous diagonal stroke carries its own orientation regardless of what
      // color it crosses, so it stays legible as "this is a texture laid over the data"
      // instead of blending into the data's own variation.
      if (coverageWeighting > 0 && upsampledCoverageRatioGrid) {
        // Rendered at a multiple of the data grid's own resolution — fine, dense lines read
        // as "quite high resolution" hatching rather than a handful of chunky diagonal
        // staircase steps; the coverage lookup below just maps each hatch pixel back down to
        // its data cell, so this costs more canvas fill calls but no extra coverage math.
        const HATCH_SCALE = 3;
        const hatchCols = cols * HATCH_SCALE;
        const hatchRows = rows * HATCH_SCALE;
        const LINE_SPACING = 5; // hatch-canvas px between diagonal line starts
        const LINE_WIDTH = 2;   // hatch-canvas px wide

        const hatchCanvas = document.createElement('canvas');
        hatchCanvas.width = hatchCols;
        hatchCanvas.height = hatchRows;
        const hctx = hatchCanvas.getContext('2d');
        hctx.fillStyle = 'rgba(43, 40, 35, 0.6)';
        for (let hr = 0; hr < hatchRows; hr++) {
          const r = Math.floor(hr / HATCH_SCALE);
          const covRow = upsampledCoverageRatioGrid[r];
          if (!covRow) continue;
          // Points where (hr + hc) is constant form a 45° diagonal; testing that sum modulo
          // a period draws repeating parallel diagonal bands with no separate pattern tile.
          for (let hc = 0; hc < hatchCols; hc++) {
            if ((hr + hc) % LINE_SPACING >= LINE_WIDTH) continue;
            const c = Math.floor(hc / HATCH_SCALE);
            const covRatio = covRow[c];
            // Below the confidence threshold — the slider value, read directly as a
            // percentile rank (see generateContourSurface()'s coverage block).
            if (covRatio === null || covRatio === undefined || covRatio >= coverageWeighting) continue;
            hctx.fillRect(hc, hatchRows - 1 - hr, 1, 1);
          }
        }
        this.coverageOverlay = L.imageOverlay(hatchCanvas.toDataURL(), imageBounds, {
          opacity: 1,
          interactive: false,
          className: 'collective-coverage-hatch'
        });
        if (this.showSurface) this.coverageOverlay.addTo(this.map);
      }
    }

    // 2. Draw isoline curves. Marching Squares returns raw, unordered 2-point segments —
    // stitch them into continuous paths first (same stitching used for cluster blob
    // boundaries), then apply a light Chaikin smoothing pass so the grid-aligned corners
    // read as smooth curves rather than a jagged staircase. This also collapses what used
    // to be hundreds of separate thick, disconnected strokes per level into a handful of
    // thin, continuous lines.
    contours.forEach(c => {
      const color = MapColors.getHslColor(c.ratio, 100, 55);
      const formattedVal = c.level.toFixed(3);
      const topoCfg = (typeof GSR_CONST !== 'undefined' && GSR_CONST.TOPOGRAPHY_SOURCES && GSR_CONST.TOPOGRAPHY_SOURCES[contourParams.topographySource]) || null;
      const unit = (topoCfg && topoCfg.unit !== undefined) ? topoCfg.unit : ' μS';

      const stitchedPaths = (typeof GSRSpatialClustering !== 'undefined')
        ? GSRSpatialClustering.stitchSegments(c.segments)
        : c.segments.map(seg => [seg[0], seg[1]]);

      stitchedPaths.forEach(path => {
        if (!path || path.length < 2) return;

        const isClosed = path.length > 2 &&
          Math.abs(path[0].lat - path[path.length - 1].lat) < 1e-9 &&
          Math.abs(path[0].lon - path[path.length - 1].lon) < 1e-9;

        const smoothed = GeoUtils.chaikinSmooth(path, 3, isClosed);

        const poly = L.polyline(smoothed.map(p => [p.lat, p.lon]), {
          color: color,
          weight: 0.75,
          opacity: 0.85,
          lineCap: 'round',
          lineJoin: 'round',
          // Leaflet simplifies polyline vertices for rendering performance by default
          // (smoothFactor: 1.0). That simplification would strip out the extra points
          // Chaikin smoothing just added, undoing the smoothing. Disable it so every
          // smoothed vertex actually renders.
          smoothFactor: 0
        });

        poly.bindTooltip(`Level: ${formattedVal}${unit}`, {
          sticky: true,
          className: 'contour-tooltip-label'
        });

        // Aggregate layer (owned by GSRMapManager, not any single track) — tagged
        // so tests/exporter can tell it apart from per-track render layers.
        poly._gsrKind = 'contour';
        if (this.showIsolines) poly.addTo(this.map);
        this.contourLayers.push(poly);
      });
    });
  }

});
