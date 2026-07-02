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

  /**
   * Compute 360° label positions for labelled peak markers, avoiding overlaps.
   *
   * For each labelled peak, 8 candidate positions are generated (N, NE, E, SE,
   * S, SW, W, NW) around the anchor dot. Candidates are scored by distance from
   * the dot (closer = better). Labels are placed greedily in pixel-space order,
   * each picking the closest non-overlapping candidate.
   *
   * Returns a Map<peakIndex, { box, dir }> where `box` is the pixel-space
   * bounding box { left, top, right, bottom } of the label text, and `dir` is
   * the cardinal direction name.
   */
  _computeLabelPositions(peaksWithCoords) {
    const W = 120;               // label box width (px)
    const H = 18;                // label box height (px)
    const GAP = 5;               // gap between dot edge and label box

    const overlap = (a, b) => a.left < b.right && a.right > b.left &&
                              a.top < b.bottom && a.bottom > b.top;

    // Build 8 candidates for each labelled peak
    const items = peaksWithCoords.map(p => {
      const { px, py } = p;
      const raw = [
        { left: px - W / 2,           top: py + GAP,            dir: 'S'  },
        { left: px - W / 2,           top: py - H - GAP,        dir: 'N'  },
        { left: px + GAP,             top: py - H / 2,          dir: 'E'  },
        { left: px - W - GAP,         top: py - H / 2,          dir: 'W'  },
        { left: px + GAP,             top: py + GAP,            dir: 'SE' },
        { left: px - W - GAP,         top: py + GAP,            dir: 'SW' },
        { left: px + GAP,             top: py - H - GAP,        dir: 'NE' },
        { left: px - W - GAP,         top: py - H - GAP,        dir: 'NW' },
      ];
      const candidates = raw.map(c => {
        const box = { left: c.left, top: c.top, right: c.left + W, bottom: c.top + H };
        const bx = (box.left + box.right) / 2;
        const by = (box.top + box.bottom) / 2;
        return { dir: c.dir, box, score: Math.hypot(bx - px, by - py) };
      }).sort((a, b) => a.score - b.score);
      return { idx: p.idx, px, py, candidates };
    });

    // Sort by pixel-y (north→south) for stable placement
    items.sort((a, b) => a.py - b.py);

    const placed = [];          // placed boxes
    const results = new Map();  // idx → { box, dir }

    for (const item of items) {
      let chosen = null;
      for (const cand of item.candidates) {
        if (!placed.some(p => overlap(cand.box, p))) {
          chosen = cand;
          break;
        }
      }
      if (chosen) {
        placed.push(chosen.box);
        results.set(item.idx, chosen);
      }
      // If all 8 candidates overlap → hide label (fall back to dot-only)
    }
    return results;
  }

  /**
   * Build a Leaflet divIcon that renders both the peak dot and its label,
   * positioned via 360° collision avoidance. The container div is sized to
   * exactly enclose both the dot and the label box.
   */
  _buildLabelledIcon(px, py, labelText, dirResult) {
    const W = 120;  // label width
    const H = 18;   // label height
    const box = dirResult.box;
    const DS = 24;  // dot visual diameter

    // Union bounding box of dot area and label box
    const dotL = px - DS / 2, dotR = px + DS / 2;
    const dotT = py - DS / 2, dotB = py + DS / 2;
    const cLeft   = Math.min(dotL, box.left);
    const cRight  = Math.max(dotR, box.right);
    const cTop    = Math.min(dotT, box.top);
    const cBottom = Math.max(dotB, box.bottom);
    const cW = cRight - cLeft;
    const cH = cBottom - cTop;

    // Dot position within the container
    const dotCx = px - cLeft;
    const dotCy = py - cTop;
    // Label position within the container
    const labelL = box.left - cLeft;
    const labelT = box.top - cTop;

    const escapedLabel = labelText.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    const html = [
      '<div class="stress-peak-icon-wrapper" style="position:relative;width:', cW, 'px;height:', cH, 'px;">',
        '<div class="peak-glow-ring" style="position:absolute;top:', (dotCy - 12), 'px;left:', (dotCx - 12), 'px;"></div>',
        '<div class="peak-dot" style="position:absolute;top:', (dotCy - 5), 'px;left:', (dotCx - 5), 'px;width:10px;height:10px;"></div>',
        '<div class="peak-map-label" style="position:absolute;top:', labelT, 'px;left:', labelL, 'px;width:', W, 'px;text-align:center;font-size:10px;font-weight:600;">', escapedLabel, '</div>',
      '</div>'
    ].join('');

    return L.divIcon({
      className: '',
      html,
      iconSize: [cW, cH],
      iconAnchor: [px - cLeft, py - cTop]
    });
  }

  _renderPeakMarkers(analyzer, data) {
    const map = this.map;
    const labelCandidates = [];
    const allPeaks = [];

    // First pass: collect pixel positions
    analyzer.peaks.forEach((peak, index) => {
      const row = data[peak.index];
      if (!row || !row.hasGps || isNaN(row.lat) || isNaN(row.lon)) return;
      const pt = map.latLngToLayerPoint([row.lat, row.lon]);
      allPeaks.push({ peak, index, row, px: pt.x, py: pt.y });
      if (peak.label && peak.label.trim()) {
        labelCandidates.push({ idx: index, px: pt.x, py: pt.y });
      }
    });

    // Compute 360° label positions
    const labelPositions = this._computeLabelPositions(labelCandidates);

    // Compact dot-only icon for peaks without labels
    const simpleIcon = L.divIcon({
      className: '',
      html: '<div class="stress-peak-icon-wrapper" style="position:relative;width:24px;height:24px;"><div class="peak-glow-ring" style="position:absolute;top:0;left:0;"></div><div class="peak-dot" style="position:absolute;top:7px;left:7px;width:10px;height:10px;"></div></div>',
      iconSize: [24, 24], iconAnchor: [12, 12]
    });

    allPeaks.forEach(({ peak, index, row, px, py }) => {
      const displayLabel = peak.label || '';
      const escapedLabel = displayLabel.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

      let marker;
      const hasLabel = displayLabel && displayLabel.trim();
      if (hasLabel) {
        const dirResult = labelPositions.get(index);
        if (dirResult) {
          marker = L.marker([row.lat, row.lon], {
            icon: this._buildLabelledIcon(px, py, displayLabel, dirResult)
          });
          // Bump labeled markers above unlabeled markers and path layers
          marker.setZIndexOffset(1000);
        } else {
          // All 8 positions overlapped — fall back to dot-only
          marker = L.marker([row.lat, row.lon], { icon: simpleIcon });
        }
      } else {
        marker = L.marker([row.lat, row.lon], { icon: simpleIcon });
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
            updatePeakLabel(index, input.value);
          });
          L.DomEvent.on(input, 'keydown', function(e) {
            if (e.key === 'Enter') {
              updatePeakLabel(index, input.value);
              input.blur();
            }
          });
          L.DomEvent.disableClickPropagation(input);
        }
        return container;
      });

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
      // Ensure filteredGps is populated — if missing, run GPS filter now
      const gpsParams = { downsample: true };
      if (!track.analyzer.filteredGps || track.analyzer.filteredGps.length !== data.length) {
        const gpsPoints = this._collectGpsPoints(data);
        if (gpsPoints.length > 0) {
          this._reconstructFilteredGps(track.analyzer, data, gpsPoints);
        }
      }
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

      // 2. Draw peak dot markers — 360° label placement with collision avoidance
      const trackId = track.id;
      const map = this.map;
      const collectiveLabelCandidates = [];
      const collectiveAllPeaks = [];

      // First pass: collect pixel positions
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
        if (!isNaN(lat) && !isNaN(lon)) {
          const pt = map.latLngToLayerPoint([lat, lon]);
          collectiveAllPeaks.push({ peak, index, lat, lon, px: pt.x, py: pt.y });
          if (peak.label && peak.label.trim()) {
            collectiveLabelCandidates.push({ idx: index, px: pt.x, py: pt.y });
          }
        }
      });

      // 360° collision avoidance for collective labels
      const collectivePositions = this._computeLabelPositions(collectiveLabelCandidates);

      // Compact dot-only icon for unlabeled peaks
      const collectiveSimpleIcon = L.divIcon({
        className: '',
        html: `<div style="position:relative;width:12px;height:12px;"><div class="collective-peak-dot" style="width:10px;height:10px;border-radius:50%;background:${trackColor};box-shadow:0 0 6px ${trackColor};border:1.5px solid #fff;"></div></div>`,
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
            // Build container: union of dot area and label box
            const W = 120, H = 18, DS = 12;
            const box = dirResult.box;
            const dotL = px - DS / 2, dotR = px + DS / 2;
            const dotT = py - DS / 2, dotB = py + DS / 2;
            const cLeft   = Math.min(dotL, box.left);
            const cRight  = Math.max(dotR, box.right);
            const cTop    = Math.min(dotT, box.top);
            const cBottom = Math.max(dotB, box.bottom);
            const cW = cRight - cLeft, cH = cBottom - cTop;
            const dotCx = px - cLeft, dotCy = py - cTop;
            const labelL = box.left - cLeft, labelT = box.top - cTop;

            const html = [
              '<div style="position:relative;width:', cW, 'px;height:', cH, 'px;">',
                '<div class="collective-peak-dot" style="position:absolute;top:', (dotCy - 5), 'px;left:', (dotCx - 5), 'px;width:10px;height:10px;border-radius:50%;background:', trackColor, ';box-shadow:0 0 6px ', trackColor, ';border:1.5px solid #fff;"></div>',
                '<div class="peak-map-label" style="position:absolute;top:', labelT, 'px;left:', labelL, 'px;width:', W, 'px;text-align:center;font-size:9px;font-weight:600;color:rgba(255,255,255,0.9);text-shadow:0 0 4px rgba(0,0,0,0.95),0 0 8px rgba(0,0,0,0.85),0 1px 3px rgba(0,0,0,0.8);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none;line-height:1.2;">', escapedLabel, '</div>',
              '</div>'
            ].join('');

            marker = L.marker([lat, lon], {
              icon: L.divIcon({ className: '', html, iconSize: [cW, cH], iconAnchor: [px - cLeft, py - cTop] })
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
              updatePeakLabel(index, input.value, trackId);
            });
            L.DomEvent.on(input, 'keydown', function(e) {
              if (e.key === 'Enter') {
                updatePeakLabel(index, input.value, trackId);
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
