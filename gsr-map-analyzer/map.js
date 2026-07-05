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
    this.osmLayers = [];
    this.scrubMarker = null;
    this.showPeaks = true;
    this.activeColoringMetric = 'gsr';
    
    this.initMap();
  }

  /**
   * Initialize Leaflet map with CartoDB Dark Matter tile layer
   */
  initMap() {
    // Default view zoomed out
    this.map = L.map(this.containerId, {
      zoomControl: false,
      scrollWheelZoom: true,
      preferCanvas: true
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
   * Remove all layers in the array from the map and clear the array.
   */
  _clearLayerGroup(arr) {
    if (!this.map) return;
    if (arr) arr.forEach(item => this.map.removeLayer(item));
    return [];
  }

  /**
   * Reset path and markers on map
   */
  clearMap() {
    if (!this.map) return;
    this.pathSegments = this._clearLayerGroup(this.pathSegments);
    this.peakMarkers = this._clearLayerGroup(this.peakMarkers);
    this.clearOsmShapes();

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
        let drawPoints = this._downsampleForDisplay(gpsPoints, analyzer.sampleRate || 10.0, p.downsample === 1);
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
    // Calculate actual sample rate of GPS coordinates dynamically to avoid
    // scaling windows/durations by the 10 Hz GSR sample rate.
    const gpsSampleRate = pts.length > 1
      ? (pts.length - 1) / (pts[pts.length - 1].time - pts[0].time)
      : 1.0;

    // 3. Hampel outlier filter
    if (p.hampelWindow > 0 && p.hampelSigma > 0) {
      const k = Math.round(p.hampelWindow * gpsSampleRate);
      pts = GpsFilter.applyHampelFilter(pts, k, p.hampelSigma);
    }
    // 4. Speed plausibility filter
    if (p.maxSpeed > 0) {
      pts = GpsFilter.applySpeedFilter(pts, p.maxSpeed);
    }
    // 5. DBSCAN stop collapse
    if (p.dbscanRadius > 0 && (p.dbscanMinPts || 0) > 1) {
      const minPts = Math.round(p.dbscanMinPts * gpsSampleRate);
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

  _getMetricKey(metric) {
    const keys = {
      'gsr': 'val',
      'roadClass': 'osm_road_class',
      'distMajorRoad': 'osm_dist_major_road',
      'inPark': 'osm_in_park',
      'greenPct': 'osm_green_pct_50m',
      'buildingDensity': 'osm_building_density_50m',
      'distWater': 'osm_dist_water',
      'treeDensity': 'osm_tree_density_50m',
      'amenityCount': 'osm_amenity_count_50m'
    };
    return keys[metric] || 'val';
  }

  getColorForMetric(metric, val, minVal, maxVal) {
    if (metric === 'gsr') {
      return this.getColorForValue(val, minVal, maxVal);
    }
    
    if (metric === 'roadClass') {
      const roadColors = {
        'motorway': '#ff0055',
        'trunk': '#ff4400',
        'primary': '#ff6600',
        'secondary': '#ffaa00',
        'tertiary': '#ffd500',
        'residential': '#0099ff',
        'pedestrian': '#00ffc4',
        'footway': '#00e575',
        'path': '#80e500',
        'cycleway': '#00ffd5',
        'living_street': '#9b5de5',
        'service': '#b8c0ff'
      };
      return roadColors[val] || '#666666';
    }
    
    if (metric === 'inPark') {
      return val === 1 ? '#00e575' : '#666666';
    }
    
    let ratio = 0;
    if (maxVal !== minVal) {
      ratio = (val - minVal) / (maxVal - minVal);
    }
    ratio = Math.max(0, Math.min(1, ratio));

    if (metric === 'greenPct') {
      // Brown (0%) to Green (100%)
      const hue = 30 + ratio * 100;
      return `hsl(${hue}, 80%, 45%)`;
    }
    
    if (metric === 'buildingDensity') {
      // Green (low density) to Red (high density)
      const hue = (1.0 - ratio) * 120;
      return `hsl(${hue}, 85%, 50%)`;
    }
    
    if (metric === 'distMajorRoad') {
      // Close (Red) to Far (Green)
      const hue = ratio * 120;
      return `hsl(${hue}, 85%, 50%)`;
    }
    
    if (metric === 'distWater') {
      // Close (Cyan/Blue) to Far (Brown/Gray)
      const hue = 200 - ratio * 170;
      return `hsl(${hue}, 80%, 45%)`;
    }
    
    if (metric === 'treeDensity') {
      // None (Gray) to Many (Emerald Green)
      const hue = 60 + ratio * 80;
      const sat = 30 + ratio * 60;
      return `hsl(${hue}, ${sat}%, 45%)`;
    }
    
    if (metric === 'amenityCount') {
      // None (Gray) to Many (Purple/Red)
      const hue = 240 - ratio * 240;
      return `hsl(${hue}, 85%, 55%)`;
    }
    
    return '#666666';
  }

  drawOsmShapes(osmJson) {
    this.clearOsmShapes();
    if (!osmJson || !this.map) return;
    
    this.osmLayers = [];
    const geoms = OSMEnricher.reconstructGeometries(osmJson);

    geoms.ways.concat(geoms.relations).forEach(geom => {
      const tags = geom.tags;
      if (!tags) return;

      const isPark = tags.leisure === 'park' || tags.leisure === 'garden' || tags.landuse === 'grass' || tags.landuse === 'forest' || tags.natural === 'wood';
      const isWater = tags.natural === 'water' || tags.waterway === 'river' || tags.waterway === 'canal' || tags.waterway === 'stream' || tags.landuse === 'reservoir';
      const isBuilding = !!tags.building;

      let color = null;
      let fillColor = null;
      let fillOpacity = 0.15;

      if (isPark) {
        color = '#2d6a4f';
        fillColor = '#52b788';
      } else if (isWater) {
        color = '#0077b6';
        fillColor = '#90e0ef';
        fillOpacity = 0.25;
      } else if (isBuilding) {
        color = '#4a4e69';
        fillColor = '#9a8c98';
        fillOpacity = 0.1;
      }

      if (color) {
        if (geom.type === 'way' && geom.coordinates.length > 2) {
          const latlngs = geom.coordinates.map(pt => [pt.lat, pt.lon]);
          const poly = L.polygon(latlngs, { color, fillColor, fillOpacity, weight: 1 }).addTo(this.map);
          this.osmLayers.push(poly);
        } else if (geom.type === 'relation' && geom.outerWays) {
          geom.outerWays.forEach(way => {
            const latlngs = way.coordinates.map(pt => [pt.lat, pt.lon]);
            const poly = L.polygon(latlngs, { color, fillColor, fillOpacity, weight: 1 }).addTo(this.map);
            this.osmLayers.push(poly);
          });
        }
      }
    });
  }

  clearOsmShapes() {
    if (this.osmLayers) {
      this.osmLayers.forEach(layer => this.map.removeLayer(layer));
    }
    this.osmLayers = [];
  }

  _renderPathSegments(drawPoints, data, trackWeight) {
    const metric = this.activeColoringMetric || 'gsr';
    const key = this._getMetricKey(metric);
    const isCategorical = (metric === 'roadClass');

    let minVal = Infinity, maxVal = -Infinity;
    if (!isCategorical) {
      for (let i = 0; i < data.length; i++) {
        const v = data[i][key];
        if (v !== undefined && v !== null && !isNaN(v)) {
          if (v < minVal) minVal = v;
          if (v > maxVal) maxVal = v;
        }
      }
      if (minVal === Infinity) {
        minVal = 0;
        maxVal = 1;
      }
      if (maxVal === minVal) maxVal = minVal + 1;
    }

    const range = maxVal - minVal;
    const COLOR_BUCKETS = 30;
    let batchStart = 0;

    while (batchStart < drawPoints.length - 1) {
      const startVal = drawPoints[batchStart][key];
      
      let startBucket = 0;
      if (!isCategorical) {
        const avgVal = (drawPoints[batchStart][key] + drawPoints[batchStart + 1][key]) / 2;
        startBucket = Math.floor(((avgVal - minVal) / range) * COLOR_BUCKETS);
      }

      let batchEnd = batchStart + 1;
      while (batchEnd < drawPoints.length - 1) {
        if (isCategorical) {
          const val = drawPoints[batchEnd][key];
          if (val !== startVal) break;
        } else {
          const val = (drawPoints[batchEnd][key] + drawPoints[batchEnd + 1][key]) / 2;
          const bucket = Math.floor(((val - minVal) / range) * COLOR_BUCKETS);
          if (bucket !== startBucket) break;
        }
        batchEnd++;
      }

      const latlngs = [];
      for (let i = batchStart; i <= batchEnd; i++) {
        latlngs.push([drawPoints[i].lat, drawPoints[i].lon]);
      }

      let colorVal;
      if (isCategorical) {
        colorVal = startVal;
      } else {
        const midIdx = Math.floor((batchStart + batchEnd) / 2);
        colorVal = (drawPoints[midIdx][key] + drawPoints[midIdx + 1][key]) / 2;
      }
      
      const color = this.getColorForMetric(metric, colorVal, minVal, maxVal);

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

      // Dim excluded peak markers
      if (peak.excluded) {
        marker.setOpacity(0.35);
      }

      marker.bindPopup(function() {
        const container = L.DomUtil.create('div');
        container.className = 'map-popup-card';
        container.innerHTML = [
          '<div class="popup-header-row">',
            '<h4>' + (displayLabel ? escapedLabel : '#' + (index + 1)) + '</h4>',
            '<button class="btn-exclude-popup" data-peak-idx="' + index + '" ' +
              'title="' + (peak.excluded ? 'Include peak' : 'Exclude peak') + '">' +
              (peak.excluded ? '<i class="fa-solid fa-plus"></i>' : '<i class="fa-solid fa-xmark"></i>') +
            '</button>',
          '</div>',
          '<div class="popup-label-edit">',
            '<label>Label:</label>',
            '<input class="popup-label-input" type="text" value="' + escapedLabel + '" ' +
              'placeholder="Enter label…" data-peak-idx="' + index + '">',
          '</div>',
          '<table class="popup-table">',
          '<tr><td>Date:</td><td>', analyzer.formatDateUK(peak.time), '</td></tr>',
          '<tr><td>Time:</td><td>', analyzer.formatTimeOnly(peak.time), '</td></tr>',
          '<tr><td>Amplitude:</td><td>', peak.amplitude.toFixed(3), ' μS</td></tr>',
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
        const excludeBtn = container.querySelector('.btn-exclude-popup');
        if (excludeBtn) {
          L.DomEvent.on(excludeBtn, 'click', function() {
            GSRUI.togglePeakExclusion(index);
            marker.closePopup();
          });
          L.DomEvent.disableClickPropagation(excludeBtn);
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
    this.collectivePathSegments = this._clearLayerGroup(this.collectivePathSegments);
    this.collectivePeakMarkers = this._clearLayerGroup(this.collectivePeakMarkers);
    this.clearContours();
  }

  /**
   * Remove only the topographic isolines layer from the map.
   */
  clearContours() {
    this.contourLayers = this._clearLayerGroup(this.contourLayers);
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
            <div class="popup-header-row">
              <h4>${track.name}</h4>
              <button class="btn-exclude-popup" data-peak-idx="${index}" data-track-id="${trackId}"
                title="${peak.excluded ? 'Include peak' : 'Exclude peak'}">
                ${peak.excluded ? '<i class="fa-solid fa-plus"></i>' : '<i class="fa-solid fa-xmark"></i>'}
              </button>
            </div>
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
          const excludeBtn = container.querySelector('.btn-exclude-popup');
          if (excludeBtn) {
            L.DomEvent.on(excludeBtn, 'click', function() {
              GSRUI.togglePeakExclusion(index, trackId);
              marker.closePopup();
            });
            L.DomEvent.disableClickPropagation(excludeBtn);
          }
          return container;
        });
        marker.addTo(this.map);
        // Dim excluded peak markers
        if (peak.excluded) {
          marker.setOpacity(0.35);
        }
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
