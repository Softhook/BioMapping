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

    // Dark Map Style (OpenStreetMap base)
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
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

  /**
   * Map value to HSL color (Green = 120 -> Yellow -> Red = 0)
   */
  getColorForValue(val, minVal, maxVal) {
    if (maxVal === minVal) return 'hsl(120, 100%, 50%)'; // default green
    const ratio = Math.max(0, Math.min(1, (val - minVal) / (maxVal - minVal)));
    const hue = (1.0 - ratio) * 120; // 120 is green, 0 is red
    return `hsl(${hue}, 90%, 50%)`;
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

    // 7-9: Downsample, simplify, and deduplicate for drawing
    let drawPoints = this._downsampleForDisplay(gpsPoints, analyzer.sampleRate || 10.0, p.downsample !== false);
    drawPoints = GpsFilter.applyRDP(drawPoints, p.rdpTolerance || 0);
    drawPoints = this._minDistFilter(drawPoints, p.minDist || 0);
    if (drawPoints.length === 0) return;

    // 10-12: Render on Leaflet map
    this._fitBounds(drawPoints);
    this._renderPathSegments(drawPoints, data, p.trackWeight || 5);

    // 13: Peak markers
    this._renderPeakMarkers(analyzer, data);
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

  _minDistFilter(drawPoints, minDist) {
    if (minDist <= 0 || drawPoints.length < 2) return drawPoints;
    const kept = [drawPoints[0]];
    for (let i = 1; i < drawPoints.length; i++) {
      const prev = kept[kept.length - 1];
      const d = GpsFilter.haversineDistance(prev.lat, prev.lon, drawPoints[i].lat, drawPoints[i].lon);
      if (d >= minDist) kept.push(drawPoints[i]);
    }
    return kept.length > 1 ? kept : drawPoints;
  }

  _fitBounds(drawPoints) {
    const bounds = drawPoints.map(p => [p.lat, p.lon]);
    this.map.fitBounds(bounds, { padding: [30, 30] });
  }

  _renderPathSegments(drawPoints, data, trackWeight) {
    // Use reduce to avoid Math.min(...spread) stack overflow on large datasets
    var minVal = Infinity, maxVal = -Infinity;
    for (var i = 0; i < data.length; i++) {
      var v = data[i].val;
      if (v < minVal) minVal = v;
      if (v > maxVal) maxVal = v;
    }

    for (let i = 0; i < drawPoints.length - 1; i++) {
      const pA = drawPoints[i], pB = drawPoints[i + 1];
      const avgVal = (pA.val + pB.val) / 2.0;
      const color = this.getColorForValue(avgVal, minVal, maxVal);

      const segment = L.polyline([[pA.lat, pA.lon], [pB.lat, pB.lon]], {
        color, weight: trackWeight, opacity: 0.95
      }).addTo(this.map);

      this.pathSegments.push(segment);
    }
  }

  _renderPeakMarkers(analyzer, data) {
    const peakIcon = L.divIcon({
      className: 'stress-peak-icon',
      html: '<div class="peak-glow-ring"></div><div class="peak-dot"></div>',
      iconSize: [24, 24], iconAnchor: [12, 12]
    });

    analyzer.peaks.forEach((peak, index) => {
      const row = data[peak.index];
      if (!row || !row.hasGps || isNaN(row.lat) || isNaN(row.lon)) return;

      const marker = L.marker([row.lat, row.lon], { icon: peakIcon });
      if (this.showPeaks) marker.addTo(this.map);

      marker.bindPopup([
        '<div class="map-popup-card">',
        '<h4><i class="fa-solid fa-triangle-exclamation"></i> Peak SCR Event #', index + 1, '</h4>',
        '<table class="popup-table">',
        '<tr><td>Time:</td><td><b>', peak.time.toFixed(1), ' s</b></td></tr>',
        '<tr><td>Onset:</td><td>', peak.onsetTime.toFixed(1), ' s</td></tr>',
        '<tr><td>Amplitude:</td><td><b>', peak.amplitude.toFixed(3), ' μS</b></td></tr>',
        '<tr><td>Rise Time:</td><td>', (peak.time - peak.onsetTime).toFixed(1), ' s</td></tr>',
        '</table></div>'
      ].join(''));

      this.peakMarkers.push(marker);
    });
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
    var toggle = function(m) {
      if (visible) {
        if (!this.map.hasLayer(m)) m.addTo(this.map);
      } else {
        if (this.map.hasLayer(m)) this.map.removeLayer(m);
      }
    }.bind(this);
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
      this.map.panTo([lat, lon]);
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
  renderCollectiveData(collectiveManager, contourParams = {}) {
    this.clearMap(); // Clear single-track drawing
    this.clearCollectiveLayers();

    const activeTracks = collectiveManager.getActiveTracks();
    if (activeTracks.length === 0) return;

    // 1. Draw dashed, semi-transparent paths for each track
    activeTracks.forEach(track => {
      const data = track.analyzer.raw;
      const filteredGps = track.analyzer.filteredGps || [];
      const drawPoints = [];

      const step = Math.max(1, Math.round(track.analyzer.sampleRate || 10.0));
      for (let i = 0; i < data.length; i += step) {
        let lat = NaN, lon = NaN;
        if (filteredGps[i] && !isNaN(filteredGps[i].lat)) {
          lat = filteredGps[i].lat;
          lon = filteredGps[i].lon;
        } else if (data[i] && !isNaN(data[i].lat)) {
          lat = data[i].lat;
          lon = data[i].lon;
        }

        if (!isNaN(lat) && !isNaN(lon)) {
          drawPoints.push({ lat, lon });
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

      // 2. Draw small peak dot markers for this track
      const peakIcon = L.divIcon({
        className: 'collective-peak-icon',
        html: `<div class="collective-peak-dot" style="background-color: ${trackColor}; box-shadow: 0 0 6px ${trackColor};"></div>`,
        iconSize: [12, 12],
        iconAnchor: [6, 6]
      });

      track.analyzer.peaks.forEach((peak, index) => {
        const matchingRow = data[peak.index];
        let lat = NaN, lon = NaN;
        if (filteredGps[peak.index] && !isNaN(filteredGps[peak.index].lat)) {
          lat = filteredGps[peak.index].lat;
          lon = filteredGps[peak.index].lon;
        } else if (matchingRow && !isNaN(matchingRow.lat)) {
          lat = matchingRow.lat;
          lon = matchingRow.lon;
        }

        if (!isNaN(lat) && !isNaN(lon) && this.showPeaks) {
          const marker = L.marker([lat, lon], { icon: peakIcon });
          const popupHtml = `
            <div class="map-popup-card compact">
              <h4>${track.name}</h4>
              <p>Peak Event #${index + 1}</p>
              <p>Amplitude: <b>${peak.amplitude.toFixed(3)} μS</b></p>
            </div>
          `;
          marker.bindPopup(popupHtml);
          marker.addTo(this.map);
          this.collectivePeakMarkers.push(marker);
        }
      });
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

          // Map ratio to color (Green = 120 -> Yellow = 60 -> Red = 0)
          const hue = (1.0 - ratio) * 120;
          ctx.fillStyle = `hsl(${hue}, 100%, 50%)`;

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
      // Map ratio to color (Green = 120 -> Yellow = 60 -> Red = 0)
      const hue = (1.0 - c.ratio) * 120;
      const color = `hsl(${hue}, 100%, 55%)`;

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
