// Leaflet.js Map Manager for GSR + GPS Visualisation
// Handles path rendering, arousal color-coding, and peak marker overlays.

class GSRMapManager {
  constructor(mapContainerId) {
    this.containerId = mapContainerId;
    this.map = null;
    this.pathSegments = [];
    this.peakMarkers = [];
    this.scrubMarker = null;
    
    this.initMap();
  }

  /**
   * Initialize Leaflet map with CartoDB Dark Matter tile layer
   */
  initMap() {
    // Default view zoomed out
    this.map = L.map(this.containerId, {
      zoomControl: true,
      scrollWheelZoom: true
    }).setView([0, 0], 2);

    // Dark Map Style (OpenStreetMap base)
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      maxZoom: 19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a>'
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
   * Render color-coded path segments and add stress peak markers
   */
  renderData(analyzer) {
    this.clearMap();

    const data = analyzer.raw;
    if (!data || data.length === 0) return;

    // Filter points that have valid GPS positions
    const gpsPoints = data.filter(d => d.hasGps && !isNaN(d.lat) && !isNaN(d.lon));
    if (gpsPoints.length === 0) return;

    // 1. Zoom/Pan map to fit the path bounding box
    const bounds = gpsPoints.map(p => [p.lat, p.lon]);
    this.map.fitBounds(bounds, { padding: [30, 30] });

    // 2. Draw Color-Coded Segments representing GSR arousal
    // Determine min/max values for color scaling
    const vals = data.map(d => d.val);
    const minVal = Math.min(...vals);
    const maxVal = Math.max(...vals);

    // Downsample the path rendering to ~1 Hz to prevent Leaflet performance lag
    const step = Math.max(1, Math.round(analyzer.sampleRate));
    let drawPoints = [];
    for (let i = 0; i < gpsPoints.length; i += step) {
      drawPoints.push(gpsPoints[i]);
    }
    if (gpsPoints.length > 0 && (gpsPoints.length - 1) % step !== 0) {
      drawPoints.push(gpsPoints[gpsPoints.length - 1]);
    }

    // Draw polyline segments between downsampled coordinates
    for (let i = 0; i < drawPoints.length - 1; i++) {
      const pA = drawPoints[i];
      const pB = drawPoints[i + 1];
      
      // Calculate color based on the average GSR value of the segment
      const avgVal = (pA.val + pB.val) / 2.0;
      const color = this.getColorForValue(avgVal, minVal, maxVal);

      const segment = L.polyline([[pA.lat, pA.lon], [pB.lat, pB.lon]], {
        color: color,
        weight: 5,
        opacity: 0.95
      }).addTo(this.map);

      // Mouse interactive scrubbing inside map
      segment.on('mouseover', () => {
        if (window.updateTimelineScrub) {
          window.updateTimelineScrub(pA.time);
        }
      });

      this.pathSegments.push(segment);
    }
    // 3. Render Stress Peaks as Glowing Markers
    const peakIcon = L.divIcon({
      className: 'stress-peak-icon',
      html: '<div class="peak-glow-ring"></div><div class="peak-dot"></div>',
      iconSize: [24, 24],
      iconAnchor: [12, 12]
    });

    analyzer.peaks.forEach((peak, index) => {
      // Find matching coordinate row by time/index
      const matchingRow = data[peak.index];
      if (matchingRow && matchingRow.hasGps && !isNaN(matchingRow.lat) && !isNaN(matchingRow.lon)) {
        const marker = L.marker([matchingRow.lat, matchingRow.lon], { icon: peakIcon })
          .addTo(this.map);

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
