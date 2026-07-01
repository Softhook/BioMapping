// Leaflet.js Map Manager for GSR + GPS Visualisation
// Handles path rendering, arousal color-coding, and peak marker overlays.

class GSRMapManager {
  constructor(mapContainerId) {
    this.containerId = mapContainerId;
    this.map = null;
    this.pathSegments = [];
    this.peakMarkers = [];
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
   * Haversine distance between two lat/lon points in metres.
   */
  haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000; // Earth radius in metres
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(Δφ / 2) ** 2 +
              Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /**
   * Render color-coded path segments and add stress peak markers.
   *
   * @param {GSRAnalyzer} analyzer
   * @param {object} [gpsParams] – GPS filter settings
   */
  renderData(analyzer, gpsParams = {}) {
    this.clearMap();

    const {
      minSats      = 0,
      maxSpeed     = 5,
      hampelWindow = 3,
      hampelSigma  = 3.0,
      dbscanRadius = 10,
      dbscanMinPts = 4,
      kalmanR      = 25,
      kalmanQ      = 1e-4,
      rdpTolerance = 5,
      minDist      = 0,
      trackWeight  = 5
    } = gpsParams;

    const data = analyzer.raw;
    if (!data || data.length === 0) return;

    // ── 1. Collect valid GPS points ───────────────────────────────────────────
    let gpsPoints = [];
    for (let i = 0; i < data.length; i++) {
      if (data[i].hasGps && !isNaN(data[i].lat) && !isNaN(data[i].lon)) {
        gpsPoints.push({
          ...data[i],
          origIdx: i
        });
      }
    }
    if (gpsPoints.length === 0) return;

    // ── 2. Satellite quality gate ─────────────────────────────────────────────
    if (minSats > 0) {
      const filtered = gpsPoints.filter(d => d.sats >= minSats);
      if (filtered.length > 1) gpsPoints = filtered;
    }

    // ── 3. Hampel outlier filter ──────────────────────────────────────────────
    if (hampelWindow > 0 && hampelSigma > 0) {
      const k = Math.round(hampelWindow * (analyzer.sampleRate || 10.0));
      gpsPoints = this.applyHampelFilter(gpsPoints, k, hampelSigma);
    }

    // ── 4. Speed plausibility filter ──────────────────────────────────────────
    if (maxSpeed > 0) {
      gpsPoints = this.applySpeedFilter(gpsPoints, maxSpeed);
    }

    // ── 5. DBSCAN stop collapse ───────────────────────────────────────────────
    if (dbscanRadius > 0 && dbscanMinPts > 1) {
      const minPts = Math.round(dbscanMinPts * (analyzer.sampleRate || 10.0));
      gpsPoints = this.applyDBSCAN(gpsPoints, dbscanRadius, minPts);
    }

    // ── 6. Kalman filter smoothing ────────────────────────────────────────────
    if (kalmanR > 0 && kalmanQ > 0) {
      gpsPoints = this.applyKalman(gpsPoints, kalmanQ, kalmanR);
    }

    // Reconstruct full 10Hz filtered GPS path for CSV export
    const filteredGps = new Array(data.length);
    const filteredMap = new Map();
    gpsPoints.forEach(p => {
      filteredMap.set(p.origIdx, { lat: p.lat, lon: p.lon });
    });

    const validIndices = gpsPoints.map(p => p.origIdx).sort((a, b) => a - b);
    if (validIndices.length > 0) {
      const firstIdx = validIndices[0];
      const firstCoord = filteredMap.get(firstIdx);
      for (let i = 0; i < firstIdx; i++) {
        filteredGps[i] = { lat: firstCoord.lat, lon: firstCoord.lon };
      }
      
      for (let k = 0; k < validIndices.length - 1; k++) {
        const idxA = validIndices[k];
        const idxB = validIndices[k + 1];
        const cA = filteredMap.get(idxA);
        const cB = filteredMap.get(idxB);
        
        filteredGps[idxA] = { lat: cA.lat, lon: cA.lon };
        
        for (let i = idxA + 1; i < idxB; i++) {
          const ratio = (i - idxA) / (idxB - idxA);
          const lat = cA.lat + ratio * (cB.lat - cA.lat);
          const lon = cA.lon + ratio * (cB.lon - cA.lon);
          filteredGps[i] = { lat, lon };
        }
      }
      
      const lastIdx = validIndices[validIndices.length - 1];
      const lastCoord = filteredMap.get(lastIdx);
      for (let i = lastIdx; i < data.length; i++) {
        filteredGps[i] = { lat: lastCoord.lat, lon: lastCoord.lon };
      }
    } else {
      for (let i = 0; i < data.length; i++) {
        filteredGps[i] = { lat: NaN, lon: NaN };
      }
    }
    analyzer.filteredGps = filteredGps;

    // ── 7. Downsample to ~1 Hz to prevent Leaflet performance lag ────────────
    const step = (gpsParams.downsample !== false)
      ? Math.max(1, Math.round(analyzer.sampleRate))
      : 1;
    let drawPoints = [];
    for (let i = 0; i < gpsPoints.length; i += step) {
      drawPoints.push({ ...gpsPoints[i] }); // shallow copy so we don't mutate original data
    }
    if (gpsPoints.length > 0 && (gpsPoints.length - 1) % step !== 0) {
      drawPoints.push({ ...gpsPoints[gpsPoints.length - 1] });
    }

    // ── 8. Ramer-Douglas-Peucker simplification ──────────────────────────────
    if (rdpTolerance > 0) {
      drawPoints = this.applyRDP(drawPoints, rdpTolerance);
    }

    // ── 9. Minimum inter-point distance filter ────────────────────────────────
    if (minDist > 0 && drawPoints.length > 1) {
      const kept = [drawPoints[0]];
      for (let i = 1; i < drawPoints.length; i++) {
        const prev = kept[kept.length - 1];
        const d = this.haversineDistance(prev.lat, prev.lon, drawPoints[i].lat, drawPoints[i].lon);
        if (d >= minDist) kept.push(drawPoints[i]);
      }
      if (kept.length > 1) drawPoints = kept;
    }

    if (drawPoints.length === 0) return;

    // ── 10. Fit map bounds ─────────────────────────────────────────────────────
    const bounds = drawPoints.map(p => [p.lat, p.lon]);
    this.map.fitBounds(bounds, { padding: [30, 30] });

    // ── 11. Colour scale using all raw data values ─────────────────────────────
    const vals = data.map(d => d.val);
    const minVal = Math.min(...vals);
    const maxVal = Math.max(...vals);

    // ── 12. Draw polyline segments ─────────────────────────────────────────────
    for (let i = 0; i < drawPoints.length - 1; i++) {
      const pA = drawPoints[i];
      const pB = drawPoints[i + 1];

      const avgVal = (pA.val + pB.val) / 2.0;
      const color = this.getColorForValue(avgVal, minVal, maxVal);

      const segment = L.polyline([[pA.lat, pA.lon], [pB.lat, pB.lon]], {
        color: color,
        weight: trackWeight,
        opacity: 0.95
      }).addTo(this.map);

      segment.on('mouseover', () => {
        if (window.updateTimelineScrub) {
          window.updateTimelineScrub(pA.time);
        }
      });

      this.pathSegments.push(segment);
    }

    // ── 13. Render Stress Peaks as Glowing Markers ─────────────────────────────
    const peakIcon = L.divIcon({
      className: 'stress-peak-icon',
      html: '<div class="peak-glow-ring"></div><div class="peak-dot"></div>',
      iconSize: [24, 24],
      iconAnchor: [12, 12]
    });

    analyzer.peaks.forEach((peak, index) => {
      const matchingRow = data[peak.index];
      if (matchingRow && matchingRow.hasGps && !isNaN(matchingRow.lat) && !isNaN(matchingRow.lon)) {
        const marker = L.marker([matchingRow.lat, matchingRow.lon], { icon: peakIcon });
        if (this.showPeaks) {
          marker.addTo(this.map);
        }

        const popupHtml = `
          <div class="map-popup-card">
            <h4><i class="fa-solid fa-triangle-exclamation"></i> Peak SCR Event #${index + 1}</h4>
            <table class="popup-table">
              <tr><td>Time:</td><td><b>${peak.time.toFixed(1)} s</b></td></tr>
              <tr><td>Onset:</td><td>${peak.onsetTime.toFixed(1)} s</td></tr>
              <tr><td>Amplitude:</td><td><b>${peak.amplitude.toFixed(3)} μS</b></td></tr>
              <tr><td>Rise Time:</td><td>${(peak.time - peak.onsetTime).toFixed(1)} s</td></tr>
            </table>
          </div>
        `;
        marker.bindPopup(popupHtml);
        this.peakMarkers.push(marker);
      }
    });
  }

  /**
   * Speed plausibility check: calculates Haversine speed between consecutive points
   * and drops points that imply speed > maxSpeed (m/s).
   */
  applySpeedFilter(points, maxSpeed) {
    if (points.length < 2) return points;
    const kept = [points[0]];
    for (let i = 1; i < points.length; i++) {
      const prev = kept[kept.length - 1];
      const curr = points[i];
      const dist = this.haversineDistance(prev.lat, prev.lon, curr.lat, curr.lon);
      const dt = curr.time - prev.time;
      if (dt > 0.001) {
        const speed = dist / dt;
        if (speed <= maxSpeed) {
          kept.push(curr);
        }
      } else {
        kept.push(curr);
      }
    }
    return kept;
  }

  /**
   * Hampel filter (MAD-based outlier detection) applied independently to Lat and Lon.
   */
  applyHampelFilter(points, k, nSigma) {
    if (points.length < 2 * k + 1) return points;
    const n = points.length;
    const result = [];

    const getMedianAndMAD = (arr) => {
      const sorted = [...arr].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      const absDevs = arr.map(x => Math.abs(x - median));
      const sortedDevs = absDevs.sort((a, b) => a - b);
      const mad = sortedDevs[Math.floor(sortedDevs.length / 2)];
      return { median, mad };
    };

    for (let i = 0; i < n; i++) {
      const start = Math.max(0, i - k);
      const end = Math.min(n - 1, i + k);

      const windowLats = [];
      const windowLons = [];
      for (let j = start; j <= end; j++) {
        windowLats.push(points[j].lat);
        windowLons.push(points[j].lon);
      }

      const latStats = getMedianAndMAD(windowLats);
      const lonStats = getMedianAndMAD(windowLons);

      const sigmaLat = 1.4826 * latStats.mad;
      const sigmaLon = 1.4826 * lonStats.mad;

      const diffLat = Math.abs(points[i].lat - latStats.median);
      const diffLon = Math.abs(points[i].lon - lonStats.median);

      const isLatOutlier = sigmaLat > 1e-9 && diffLat > nSigma * sigmaLat;
      const isLonOutlier = sigmaLon > 1e-9 && diffLon > nSigma * sigmaLon;

      if (isLatOutlier || isLonOutlier) {
        result.push({
          ...points[i],
          lat: latStats.median,
          lon: lonStats.median
        });
      } else {
        result.push(points[i]);
      }
    }
    return result;
  }

  /**
   * DBSCAN-inspired sequential clustering of stationary periods.
   */
  applyDBSCAN(points, epsilon, minPts) {
    if (points.length < minPts) return points;
    const n = points.length;
    const result = points.map(p => ({ ...p }));

    let i = 0;
    while (i < n) {
      let j = i;
      let sumLat = result[i].lat;
      let sumLon = result[i].lon;
      let count = 1;

      while (j + 1 < n) {
        const nextLat = result[j + 1].lat;
        const nextLon = result[j + 1].lon;
        const avgLat = sumLat / count;
        const avgLon = sumLon / count;

        const dist = this.haversineDistance(avgLat, avgLon, nextLat, nextLon);
        if (dist <= epsilon) {
          j++;
          sumLat += nextLat;
          sumLon += nextLon;
          count++;
        } else {
          break;
        }
      }

      if (count >= minPts) {
        const centroidLat = sumLat / count;
        const centroidLon = sumLon / count;
        for (let k = i; k <= j; k++) {
          result[k].lat = centroidLat;
          result[k].lon = centroidLon;
        }
      }

      i = j + 1;
    }
    return result;
  }

  /**
   * Zero-phase 1D Kalman filter smoothing on Lat and Lon.
   */
  applyKalman(points, Q_m2, R_m2) {
    if (points.length < 2) return points;
    const n = points.length;

    // Convert R and Q from metres squared to degrees squared
    const M_TO_DEG = 1.0 / 111320.0;
    const M2_TO_DEG2 = M_TO_DEG * M_TO_DEG;

    const R = R_m2 * M2_TO_DEG2;
    const Q = Q_m2 * M2_TO_DEG2;

    // Forward pass
    const forwardLats = new Array(n);
    const forwardLons = new Array(n);

    let xLat = points[0].lat;
    let xLon = points[0].lon;
    let PLat = 1.0;
    let PLon = 1.0;

    for (let i = 0; i < n; i++) {
      const pPLat = PLat + Q;
      const pPLon = PLon + Q;

      const kLat = pPLat / (pPLat + R);
      const kLon = pPLon / (pPLon + R);

      xLat = xLat + kLat * (points[i].lat - xLat);
      xLon = xLon + kLon * (points[i].lon - xLon);

      PLat = (1 - kLat) * pPLat;
      PLon = (1 - kLon) * pPLon;

      forwardLats[i] = xLat;
      forwardLons[i] = xLon;
    }

    // Backward pass for zero phase lag
    const result = new Array(n);
    let bxLat = forwardLats[n - 1];
    let bxLon = forwardLons[n - 1];
    let bPLat = 1.0;
    let bPLon = 1.0;

    for (let i = n - 1; i >= 0; i--) {
      const pPLat = bPLat + Q;
      const pPLon = bPLon + Q;

      const kLat = pPLat / (pPLat + R);
      const kLon = pPLon / (pPLon + R);

      bxLat = bxLat + kLat * (forwardLats[i] - bxLat);
      bxLon = bxLon + kLon * (forwardLons[i] - bxLon);

      bPLat = (1 - kLat) * pPLat;
      bPLon = (1 - kLon) * pPLon;

      result[i] = {
        ...points[i],
        lat: bxLat,
        lon: bxLon
      };
    }

    return result;
  }

  /**
   * Ramer-Douglas-Peucker (RDP) trajectory simplification.
   */
  applyRDP(points, tolerance) {
    if (tolerance <= 0.001 || points.length < 3) return points;

    const getPerpendicularDistance = (p, s, e) => {
      const latRad = s.lat * Math.PI / 180;
      const cosLat = Math.cos(latRad);

      const xS = 0;
      const yS = 0;
      const xE = (e.lon - s.lon) * 111320.0 * cosLat;
      const yE = (e.lat - s.lat) * 111320.0;
      const xP = (p.lon - s.lon) * 111320.0 * cosLat;
      const yP = (p.lat - s.lat) * 111320.0;

      const lineLen2 = (xE - xS) * (xE - xS) + (yE - yS) * (yE - yS);
      if (lineLen2 === 0) {
        return Math.sqrt(xP * xP + yP * yP);
      }

      let t = ((xP - xS) * (xE - xS) + (yP - yS) * (yE - yS)) / lineLen2;
      t = Math.max(0, Math.min(1, t));

      const projX = xS + t * (xE - xS);
      const projY = yS + t * (yE - yS);

      const dx = xP - projX;
      const dy = yP - projY;
      return Math.sqrt(dx * dx + dy * dy);
    };

    const rdpRecurse = (pts, startIdx, endIdx) => {
      let maxDist = 0;
      let index = -1;

      for (let i = startIdx + 1; i < endIdx; i++) {
        const dist = getPerpendicularDistance(pts[i], pts[startIdx], pts[endIdx]);
        if (dist > maxDist) {
          maxDist = dist;
          index = i;
        }
      }

      if (maxDist > tolerance) {
        const results1 = rdpRecurse(pts, startIdx, index);
        const results2 = rdpRecurse(pts, index, endIdx);
        return results1.slice(0, results1.length - 1).concat(results2);
      } else {
        return [pts[startIdx], pts[endIdx]];
      }
    };

    return rdpRecurse(points, 0, points.length - 1);
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
    this.peakMarkers.forEach(m => {
      if (visible) {
        if (!this.map.hasLayer(m)) {
          m.addTo(this.map);
        }
      } else {
        if (this.map.hasLayer(m)) {
          this.map.removeLayer(m);
        }
      }
    });
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
}

window.GSRMapManager = GSRMapManager;
