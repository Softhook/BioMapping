// Leaflet.js Map Manager for GSR + GPS Visualisation
// Handles path rendering, arousal color-coding, and peak marker overlays.

class GSRMapManager {
  constructor(mapContainerId) {
    this.containerId = mapContainerId;
    this.map = null;
    this.pathSegments = [];
    this.peakMarkers = [];
    this.collectivePathSegments = [];
    this.collectivePeakMarkers = [];
    this.contourLayers = [];
    this.scrubMarker = null;
    this.showPeaks = true;
    
    this.initMap();
  }

  /**
   * Initialize Leaflet map with CartoDB Dark Matter tile layer
   */
  initMap() {
    // Default view zoomed out
    this.map = L.map(this.containerId, {
      zoomControl: false,
      scrollWheelZoom: true
    }).setView([0, 0], 2);

    // Light Map Style (OpenStreetMap base, CartoDB Positron)
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      maxZoom: 19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a>',
      crossOrigin: true
    }).addTo(this.map);

    // Initialise scrubbing indicator marker (pulsing blue circle)
    const scrubIcon = L.divIcon({
      className: 'scrub-marker-icon',
      html: '<div class="scrub-dot"></div>',
      iconSize: [16, 16],
      iconAnchor: [8, 8]
    });
    this.scrubMarker = L.marker([0, 0], { icon: scrubIcon });
  }

  /**
   * Reset path and markers on map
   */
  clearMap() {
    if (!this.map) return;
    this.pathSegments.forEach(seg => this.map.removeLayer(seg));
    this.pathSegments = [];
    
    this.peakMarkers.forEach(m => this.map.removeLayer(m));
    this.peakMarkers = [];

    if (this.map.hasLayer(this.scrubMarker)) {
      this.map.removeLayer(this.scrubMarker);
    }
  }

  _getHslColor(ratio, saturation = 100, lightness = 50) {
    const r = Math.max(0, Math.min(1, ratio));
    const hue = (1.0 - r) * 120;
    return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
  }

  /**
   * Map value to HSL color (Green = 120 -> Yellow -> Red = 0)
   */
  getColorForValue(val, minVal, maxVal) {
    if (maxVal === minVal) return 'hsl(120, 90%, 50%)'; // default green
    const ratio = (val - minVal) / (maxVal - minVal);
    return this._getHslColor(ratio, 90, 50);
  }

  /**
   * Render color-coded path segments and add stress peak markers.
   *
   * @param {GSRAnalyzer} analyzer
   * @param {object} [gpsParams] – GPS filter settings
   */
  renderData(analyzer, gpsParams) {
    if (!gpsParams) gpsParams = {};
    this.clearMap();

    const p = gpsParams;
    const data = analyzer.raw;
    if (!data || data.length === 0) return;

    // 1-6: GPS filter pipeline
    let gpsPoints = this._collectGpsPoints(data);
    if (gpsPoints.length === 0) return;

    gpsPoints = this._applySatelliteGate(gpsPoints, p.minSats);
    gpsPoints = this._applyAllFilters(gpsPoints, p, analyzer.sampleRate || 10.0);

    // Reconstruct full 10 Hz filtered GPS path for CSV export
    this._reconstructFilteredGps(analyzer, data, gpsPoints);

    // 7-8: Downsample and simplify for drawing
    let drawPoints = this._downsampleForDisplay(gpsPoints, analyzer.sampleRate || 10.0, p.downsample !== false);
    drawPoints = GpsFilter.applyRDP(drawPoints, p.rdpTolerance || 0);
    if (drawPoints.length === 0) return;

    // 9-11: Render on Leaflet map
    this._fitBounds(drawPoints);
    this._renderPathSegments(drawPoints, data, p.trackWeight || 5);

    // 13: Peak markers (with latency compensation)
    this._renderPeakMarkers(analyzer, data, p.peakLatency || 0);
  }

  // ── Pipeline helpers ──────────────────────────────────────────────────────

  _collectGpsPoints(data) {
    const pts = [];
    for (let i = 0; i < data.length; i++) {
      if (data[i].hasGps && !isNaN(data[i].lat) && !isNaN(data[i].lon)) {
        pts.push({ ...data[i], origIdx: i });
      }
    }
    return pts;
  }

  _applySatelliteGate(pts, minSats) {
    if (minSats > 0) {
      return pts.filter(d => d.sats >= minSats);
    }
    return pts;
  }

  _applyAllFilters(pts, p, sampleRate) {
    // 3. Hampel outlier filter
    if (p.hampelWindow > 0 && p.hampelSigma > 0) {
      const k = Math.round(p.hampelWindow * sampleRate);
      pts = GpsFilter.applyHampelFilter(pts, k, p.hampelSigma);
    }
    // 4. Speed plausibility filter
    if (p.maxSpeed > 0) {
      pts = GpsFilter.applySpeedFilter(pts, p.maxSpeed);
    }
    // 5. DBSCAN stop collapse
    if (p.dbscanRadius > 0 && (p.dbscanMinPts || 0) > 1) {
      const minPts = Math.round(p.dbscanMinPts * sampleRate);
      pts = GpsFilter.applyDBSCAN(pts, p.dbscanRadius, minPts);
    }
    // 6. Kalman filter smoothing
    if (p.kalmanR > 0 && p.kalmanQ > 0) {
      pts = GpsFilter.applyKalman(pts, p.kalmanQ, p.kalmanR);
    }
    return pts;
  }

  _reconstructFilteredGps(analyzer, data, gpsPoints) {
    const filteredGps = new Array(data.length);
    const filteredMap = new Map();
    gpsPoints.forEach(p => filteredMap.set(p.origIdx, { lat: p.lat, lon: p.lon }));

    const validIndices = gpsPoints.map(p => p.origIdx).sort((a, b) => a - b);
    if (validIndices.length === 0) {
      for (let i = 0; i < data.length; i++) filteredGps[i] = { lat: NaN, lon: NaN };
      analyzer.filteredGps = filteredGps;
      return;
    }

    // Fill before first
    const firstIdx = validIndices[0];
    const firstCoord = filteredMap.get(firstIdx);
    for (let i = 0; i < firstIdx; i++) filteredGps[i] = { lat: firstCoord.lat, lon: firstCoord.lon };

    // Interpolate between valid points
    for (let k = 0; k < validIndices.length - 1; k++) {
      const idxA = validIndices[k], idxB = validIndices[k + 1];
      const cA = filteredMap.get(idxA), cB = filteredMap.get(idxB);
      filteredGps[idxA] = { lat: cA.lat, lon: cA.lon };
      for (let i = idxA + 1; i < idxB; i++) {
        const ratio = (i - idxA) / (idxB - idxA);
        filteredGps[i] = { lat: cA.lat + ratio * (cB.lat - cA.lat), lon: cA.lon + ratio * (cB.lon - cA.lon) };
      }
    }

    // Fill after last
    const lastIdx = validIndices[validIndices.length - 1];
    const lastCoord = filteredMap.get(lastIdx);
    for (let i = lastIdx; i < data.length; i++) filteredGps[i] = { lat: lastCoord.lat, lon: lastCoord.lon };

    analyzer.filteredGps = filteredGps;
  }

  _downsampleForDisplay(gpsPoints, sampleRate, doDownsample) {
    const step = doDownsample ? Math.max(1, Math.round(sampleRate)) : 1;
    const draw = [];
    for (let i = 0; i < gpsPoints.length; i += step) {
      draw.push({ ...gpsPoints[i] });
    }
    if (gpsPoints.length > 0 && (gpsPoints.length - 1) % step !== 0) {
      draw.push({ ...gpsPoints[gpsPoints.length - 1] });
    }
    return draw;
  }

  _fitBounds(drawPoints) {
    const bounds = drawPoints.map(p => [p.lat, p.lon]);
    this.map.fitBounds(bounds, { padding: [30, 30] });
  }

  _renderPathSegments(drawPoints, data, trackWeight) {
    // Use reduce to avoid Math.min(...spread) stack overflow on large datasets
    let minVal = Infinity, maxVal = -Infinity;
    for (let i = 0; i < data.length; i++) {
      const v = data[i].val;
      if (v < minVal) minVal = v;
      if (v > maxVal) maxVal = v;
    }
    if (maxVal === minVal) maxVal = minVal + 1;

    // ── Batch consecutive segments by quantized color bucket ────────────────
    // Individual per-segment L.polylines create thousands of SVG <path>
    // elements, crushing Leaflet pan/zoom performance.  Instead, quantise the
    // [0,1] colour ratio into ~30 buckets and merge all consecutive segments
    // that fall in the same bucket into a single L.polyline.
    const range = maxVal - minVal;
    const COLOR_BUCKETS = 30;
    let batchStart = 0;

    while (batchStart < drawPoints.length - 1) {
      const startVal = (drawPoints[batchStart].val + drawPoints[batchStart + 1].val) / 2;
      const startBucket = Math.floor(((startVal - minVal) / range) * COLOR_BUCKETS);

      // Extend the batch while consecutive points stay in the same bucket
      let batchEnd = batchStart + 1;
      while (batchEnd < drawPoints.length - 1) {
        const val = (drawPoints[batchEnd].val + drawPoints[batchEnd + 1].val) / 2;
        const bucket = Math.floor(((val - minVal) / range) * COLOR_BUCKETS);
        if (bucket !== startBucket) break;
        batchEnd++;
      }

      // Build coordinate array for the batch (inclusive of both endpoints)
      const latlngs = [];
      for (let i = batchStart; i <= batchEnd; i++) {
        latlngs.push([drawPoints[i].lat, drawPoints[i].lon]);
      }

      // Mid-batch value for the colour (smooth transition at bucket edges)
      const midIdx = Math.floor((batchStart + batchEnd) / 2);
      const midVal = (drawPoints[midIdx].val + drawPoints[midIdx + 1].val) / 2;
      const color = this.getColorForValue(midVal, minVal, maxVal);

      this.pathSegments.push(
        L.polyline(latlngs, { color, weight: trackWeight, opacity: 0.95 }).addTo(this.map)
      );

      batchStart = batchEnd;
    }
  }

  // Note: Cartographic label placement algorithms and HTML builders moved to GSRLabelManager in label_placement.js

  _renderPeakMarkers(analyzer, data, peakLatency) {
    const map = this.map;
    const labelCandidates = [];
    const allPeaks = [];

    // First pass: collect pixel positions
    analyzer.peaks.forEach((peak, index) => {
      // Original (unshifted) position — used for connector line
      const origCoords = analyzer.getCoordinates(peak.index);
      const origPt = origCoords ? map.latLngToLayerPoint([origCoords.lat, origCoords.lon]) : null;

      // Apply latency: find GPS position at (peak time - latency)
      let si = peak.index;
      if (peakLatency > 0) {
        const shiftedTime = Math.max(0, peak.time - peakLatency);
        si = analyzer.findClosestIndex(shiftedTime);
        if (si < 0) si = peak.index;
      }
      const coords = analyzer.getCoordinates(si);
      if (!coords) return;
      const pt = map.latLngToLayerPoint([coords.lat, coords.lon]);
      const origLatLon = origCoords ? [origCoords.lat, origCoords.lon] : null;
      allPeaks.push({ peak, index, coords, px: pt.x, py: pt.y, origPt, origLatLon });
      if (peak.label && peak.label.trim()) {
        labelCandidates.push({ idx: index, px: pt.x, py: pt.y, text: peak.label });
      }
    });

    // Compute 360° label positions
    const labelPositions = GSRLabelManager.computeLabelPositions(labelCandidates);

    // Compact dot-only icon for peaks without labels
    const simpleIcon = L.divIcon({
      className: '',
      html: '<div class="stress-peak-icon-wrapper" style="position:relative;width:24px;height:24px;"><div class="peak-glow-ring" style="position:absolute;top:0;left:0;"></div><div class="peak-dot" style="position:absolute;top:7px;left:7px;width:10px;height:10px;"></div></div>',
      iconSize: [24, 24], iconAnchor: [12, 12]
    });

    allPeaks.forEach(({ peak, index, coords, px, py }) => {
      const displayLabel = peak.label || '';
      const escapedLabel = displayLabel.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

      let marker;
      const hasLabel = displayLabel && displayLabel.trim();
      if (hasLabel) {
        const dirResult = labelPositions.get(index);
        if (dirResult) {
          marker = L.marker([coords.lat, coords.lon], {
            icon: GSRLabelManager.buildLabelledIcon(px, py, displayLabel, dirResult)
          });
          // Bump labeled markers above unlabeled markers and path layers
          marker.setZIndexOffset(1000);
        } else {
          // All 8 positions overlapped — fall back to dot-only
          marker = L.marker([coords.lat, coords.lon], { icon: simpleIcon });
        }
      } else {
        marker = L.marker([coords.lat, coords.lon], { icon: simpleIcon });
      }

      if (this.showPeaks) marker.addTo(this.map);

      marker.bindPopup(function() {
        const container = L.DomUtil.create('div');
        container.className = 'map-popup-card';
        container.innerHTML = [
          '<h4><i class="fa-solid fa-triangle-exclamation"></i> SCR Event <span class="peak-label-display">' +
            (displayLabel ? escapedLabel : '#' + (index + 1)) +
          '</span></h4>',
          '<div class="popup-label-edit">',
            '<label>Label:</label>',
            '<input class="popup-label-input" type="text" value="' + escapedLabel + '" ' +
              'placeholder="Enter label…" data-peak-idx="' + index + '">',
          '</div>',
          '<table class="popup-table">',
          '<tr><td>Time:</td><td><b>', peak.time.toFixed(1), ' s</b></td></tr>',
          '<tr><td>Onset:</td><td>', peak.onsetTime.toFixed(1), ' s</td></tr>',
          '<tr><td>Amplitude:</td><td><b>', peak.amplitude.toFixed(3), ' μS</b></td></tr>',
          '<tr><td>Rise Time:</td><td>', (peak.time - peak.onsetTime).toFixed(1), ' s</td></tr>',
          '</table></div>'
        ].join('');

        const input = container.querySelector('.popup-label-input');
        if (input) {
          L.DomEvent.on(input, 'change', function() {
            GSRUI.updatePeakLabel(index, input.value);
          });
          L.DomEvent.on(input, 'keydown', function(e) {
            if (e.key === 'Enter') {
              GSRUI.updatePeakLabel(index, input.value);
              input.blur();
            }
          });
          L.DomEvent.disableClickPropagation(input);
        }
        return container;
      });

      this.peakMarkers.push(marker);
    });

    // Draw connector lines from original (unshifted) to shifted position
    if (peakLatency > 0) {
      for (const ap of allPeaks) {
        if (!ap.origLatLon) continue;
        const shiftedLatLon = [ap.coords.lat, ap.coords.lon];
        const conn = L.polyline([ap.origLatLon, shiftedLatLon], {
          color: '#f43f5e',
          weight: 1.5,
          opacity: 0.35,
          dashArray: '3, 5'
        }).addTo(this.map);
        this.peakMarkers.push(conn); // store so clearMap removes them
      }
    }
  }

  /**
   * Zoom the map in by one level.
   */
  zoomIn() {
    if (this.map) {
      this.map.zoomIn();
    }
  }

  /**
   * Zoom the map out by one level.
   */
  zoomOut() {
    if (this.map) {
      this.map.zoomOut();
    }
  }

  /**
   * Zoom and pan the map to fit the current polyline track extent.
   */
  fitToTrack() {
    if (this.map && this.pathSegments.length > 0) {
      const group = new L.featureGroup(this.pathSegments);
      this.map.fitBounds(group.getBounds(), { padding: [30, 30] });
    }
  }

  /**
   * Toggle the visibility of the stress peak markers on the map layer.
   */
  togglePeaks(visible) {
    this.showPeaks = visible;
    const toggle = (m) => {
      if (visible) {
        if (!this.map.hasLayer(m)) m.addTo(this.map);
      } else {
        if (this.map.hasLayer(m)) this.map.removeLayer(m);
      }
    };
    this.peakMarkers.forEach(toggle);
    this.collectivePeakMarkers.forEach(toggle);
  }

  /**
   * Set scrubbing indicator dot position
   */
  setScrubPosition(lat, lon, panTo = false) {
    if (isNaN(lat) || isNaN(lon)) {
      if (this.map.hasLayer(this.scrubMarker)) {
        this.map.removeLayer(this.scrubMarker);
      }
      return;
    }

    this.scrubMarker.setLatLng([lat, lon]);
    if (!this.map.hasLayer(this.scrubMarker)) {
      this.scrubMarker.addTo(this.map);
    }

    if (panTo) {
      const pos = [lat, lon];
      if (!this.map.getBounds().contains(pos)) {
        this.map.panTo(pos);
      }
    }
  }

  /**
   * Remove all collective track paths and peak markers from the map.
   */
  clearCollectiveLayers() {
    if (this.collectivePathSegments) {
      this.collectivePathSegments.forEach(seg => this.map.removeLayer(seg));
    }
    this.collectivePathSegments = [];

    if (this.collectivePeakMarkers) {
      this.collectivePeakMarkers.forEach(m => this.map.removeLayer(m));
    }
    this.collectivePeakMarkers = [];

    this.clearContours();
  }

  /**
   * Remove only the topographic isolines layer from the map.
   */
  clearContours() {
    if (this.contourLayers) {
      this.contourLayers.forEach(layer => this.map.removeLayer(layer));
    }
    this.contourLayers = [];

    if (this.surfaceOverlay) {
      this.map.removeLayer(this.surfaceOverlay);
      this.surfaceOverlay = null;
    }
  }

  /**
   * Render all active tracks overlaid simultaneously, then draw contour lines.
   */
  renderCollectiveData(collectiveManager, contourParams = {}, peakLatency) {
    this.clearMap(); // Clear single-track drawing
    this.clearCollectiveLayers();

    const activeTracks = collectiveManager.getActiveTracks();
    if (activeTracks.length === 0) return;

    // 1. Draw dashed, semi-transparent paths for each track
    activeTracks.forEach(track => {
      const data = track.analyzer.raw;
      if (!track.analyzer.filteredGps || track.analyzer.filteredGps.length !== data.length) {
        const gpsPoints = this._collectGpsPoints(data);
        if (gpsPoints.length > 0) {
          this._reconstructFilteredGps(track.analyzer, data, gpsPoints);
        }
      }
      const drawPoints = [];

      const step = Math.max(1, Math.round(track.analyzer.sampleRate || 10.0));
      for (let i = 0; i < data.length; i += step) {
        const coords = track.analyzer.getCoordinates(i);
        if (coords) {
          drawPoints.push({ lat: coords.lat, lon: coords.lon });
        }
      }

      if (drawPoints.length < 2) return;

      const latlngs = drawPoints.map(p => [p.lat, p.lon]);
      const trackColor = track.color || '#0ea5e9';

      const poly = L.polyline(latlngs, {
        color: trackColor,
        weight: 3,
        opacity: 0.35,
        dashArray: '5, 8'
      }).addTo(this.map);

      this.collectivePathSegments.push(poly);

      // 2. Draw peak dot markers — 360° label placement with collision avoidance
      const trackId = track.id;
      const map = this.map;
      const collectiveLabelCandidates = [];
      const collectiveAllPeaks = [];

      // First pass: collect pixel positions (with latency compensation)
      track.analyzer.peaks.forEach((peak, index) => {
        // Original (unshifted) GPS position for connector line
        const origCoords = track.analyzer.getCoordinates(peak.index);

        // Shifted position (with latency)
        let si = peak.index;
        if (peakLatency > 0) {
          const shiftedTime = Math.max(0, peak.time - peakLatency);
          si = track.analyzer.findClosestIndex(shiftedTime);
          if (si < 0) si = peak.index;
        }
        const coords = track.analyzer.getCoordinates(si);
        if (coords) {
          const pt = map.latLngToLayerPoint([coords.lat, coords.lon]);
          collectiveAllPeaks.push({
            peak, index, lat: coords.lat, lon: coords.lon, px: pt.x, py: pt.y,
            origLatLon: origCoords ? [origCoords.lat, origCoords.lon] : null
          });
          if (peak.label && peak.label.trim()) {
            collectiveLabelCandidates.push({ idx: index, px: pt.x, py: pt.y, text: peak.label });
          }
        }
      });

      // 360° collision avoidance for collective labels
      const collectivePositions = GSRLabelManager.computeLabelPositions(collectiveLabelCandidates);

      // Compact dot-only icon for unlabeled peaks
      const collectiveSimpleIcon = L.divIcon({
        className: '',
        html: `<div style="position:relative;width:12px;height:12px;"><div class="collective-peak-dot" style="width:10px;height:10px;border-radius:50%;background:${trackColor};box-shadow:0 1px 3px rgba(0,0,0,0.15);border:1.5px solid #fff;"></div></div>`,
        iconSize: [12, 12],
        iconAnchor: [6, 6]
      });

      collectiveAllPeaks.forEach(({ peak, index, lat, lon, px, py }) => {
        const displayLabel = peak.label || '';
        const escapedLabel = displayLabel.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

        let marker;
        const hasLabel = displayLabel && displayLabel.trim();
        if (hasLabel) {
          const dirResult = collectivePositions.get(index);
          if (dirResult) {
            marker = L.marker([lat, lon], {
              icon: GSRLabelManager.buildCollectiveLabelledIcon(px, py, displayLabel, dirResult, trackColor)
            });
            // Bump labeled markers above everything else on the map
            marker.setZIndexOffset(1000);
          } else {
            marker = L.marker([lat, lon], { icon: collectiveSimpleIcon });
          }
        } else {
          marker = L.marker([lat, lon], { icon: collectiveSimpleIcon });
        }

        marker.bindPopup(function() {
          const container = L.DomUtil.create('div');
          container.className = 'map-popup-card compact';
          container.innerHTML = `
            <h4>${track.name}</h4>
            <p><b>${displayLabel || ('Peak Event #' + (index + 1))}</b></p>
            <div class="popup-label-edit">
              <label>Label:</label>
              <input class="popup-label-input" type="text" value="${escapedLabel}" placeholder="Enter label…">
            </div>
            <p>Amplitude: <b>${peak.amplitude.toFixed(3)} μS</b></p>
          `;
          const input = container.querySelector('.popup-label-input');
          if (input) {
            L.DomEvent.on(input, 'change', function() {
              GSRUI.updatePeakLabel(index, input.value, trackId);
            });
            L.DomEvent.on(input, 'keydown', function(e) {
              if (e.key === 'Enter') {
                GSRUI.updatePeakLabel(index, input.value, trackId);
                input.blur();
              }
            });
            L.DomEvent.disableClickPropagation(input);
          }
          return container;
        });
        marker.addTo(this.map);
        this.collectivePeakMarkers.push(marker);
      });

      // Draw connector lines from original to shifted position (collective)
      if (peakLatency > 0) {
        for (const ap of collectiveAllPeaks) {
          if (!ap.origLatLon) continue;
          const shiftedLatLon = [ap.lat, ap.lon];
          const conn = L.polyline([ap.origLatLon, shiftedLatLon], {
            color: trackColor,
            weight: 1,
            opacity: 0.25,
            dashArray: '2, 4'
          }).addTo(this.map);
          this.collectivePeakMarkers.push(conn);
        }
      }
    });

    // 3. Zoom and Pan Map to fit collective bounding envelope
    const bounds = collectiveManager.getBounds();
    if (bounds) {
      this.map.fitBounds([
        [bounds.minLat, bounds.minLon],
        [bounds.maxLat, bounds.maxLon]
      ], { padding: [40, 40] });
    }

    // 4. Calculate and render topographic contour lines
    this.renderContours(collectiveManager, contourParams);
  }

  /**
   * Call contour generation math and draw vector polyline boundaries
   */
  renderContours(collectiveManager, contourParams) {
    this.clearContours();

    const surfaceData = collectiveManager.generateContourSurface(contourParams);
    if (!surfaceData || !surfaceData.contours) return;

    const { contours, grid, minVal, maxVal, bounds } = surfaceData;
    const { showShadedSurface = true, surfaceOpacity = 0.40 } = contourParams;

    // 1. Draw shaded continuous surface overlay
    if (showShadedSurface && grid && grid.length > 0 && bounds) {
      const rows = grid.length;
      const cols = grid[0].length;

      const canvas = document.createElement('canvas');
      canvas.width = cols;
      canvas.height = rows;
      const ctx = canvas.getContext('2d');

      const valRange = maxVal - minVal;
      const rangeEpsilon = 1e-9;

      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const val = grid[r][c];
          if (val === null || isNaN(val)) {
            continue;
          }

          let ratio = 0;
          if (valRange > rangeEpsilon) {
            ratio = (val - minVal) / valRange;
          }

          ctx.fillStyle = this._getHslColor(ratio, 100, 50);

          // Flip row index vertically for canvas space
          const x = c;
          const y = rows - 1 - r;
          ctx.fillRect(x, y, 1, 1);
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
      }).addTo(this.map);
    }

    // 2. Draw vector isoline boundaries
    contours.forEach(c => {
      const color = this._getHslColor(c.ratio, 100, 55);

      c.segments.forEach(seg => {
        const poly = L.polyline([
          [seg[0].lat, seg[0].lon],
          [seg[1].lat, seg[1].lon]
        ], {
          color: color,
          weight: 4.5,
          opacity: 0.85,
          lineCap: 'round',
          lineJoin: 'round'
        });

        const formattedVal = c.level.toFixed(3);
        const unit = (contourParams.topographySource === 'peaks') ? '' : ' μS';
        poly.bindTooltip(`Level: ${formattedVal}${unit}`, {
          sticky: true,
          className: 'contour-tooltip-label'
        });

        poly.addTo(this.map);
        this.contourLayers.push(poly);
      });
    });
  }
}

window.GSRMapManager = GSRMapManager;
