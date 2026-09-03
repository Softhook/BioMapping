/**
 * Peak-marker popup DOM builders — extracted from map.js (GSRMapManager).
 *
 * These build the editable "peak popup card" (label textarea, date/time/quality
 * rows, Street View link, exclude button) and hold no map state. Used by the 2D
 * Leaflet view (GSRMapManager peak/hotspot markers) and by the 3D globe
 * (globe3d_view.js _editPeakLabel, which shows the identical card).
 *
 * Depends on the globals L (Leaflet), GSRUI (label/exclude handlers), GeoUtils
 * (bearing), and getQualityLabel/getQualityColor (renderer.js) — all resolved
 * when a popup opens, not at load time.
 */
const MapPopups = {

  getHeadingAtPeak(analyzer, peak) {
    if (!analyzer || !peak) return 0;

    const idx = peak.index;
    const rawPoint = analyzer.raw[idx];
    if (rawPoint && !isNaN(rawPoint.course) && rawPoint.course !== null) {
      return rawPoint.course;
    }

    const n = analyzer.raw.length;
    const offset = Math.max(1, Math.round(analyzer.sampleRate || 10.0));

    let pCurrent = analyzer.getCoordinates(idx);
    if (!pCurrent) return 0;

    let pNext = null;
    let idxNext = idx;
    while (idxNext < n - 1 && idxNext - idx < offset) {
      idxNext++;
      const p = analyzer.getCoordinates(idxNext);
      if (p && (p.lat !== pCurrent.lat || p.lon !== pCurrent.lon)) {
        pNext = p;
        break;
      }
    }

    if (!pNext) {
      let idxPrev = idx;
      while (idxPrev > 0 && idx - idxPrev < offset) {
        idxPrev--;
        const p = analyzer.getCoordinates(idxPrev);
        if (p && (p.lat !== pCurrent.lat || p.lon !== pCurrent.lon)) {
          pNext = pCurrent;
          pCurrent = p;
          break;
        }
      }
    }

    if (pCurrent && pNext) {
      if (typeof GeoUtils !== 'undefined' && typeof GeoUtils.bearingDeg === 'function') {
        return GeoUtils.bearingDeg(pCurrent.lat, pCurrent.lon, pNext.lat, pNext.lon);
      }
      const rad = Math.PI / 180;
      const lat1Rad = pCurrent.lat * rad, lat2Rad = pNext.lat * rad;
      const dLonRad = (pNext.lon - pCurrent.lon) * rad;
      const y = Math.sin(dLonRad) * Math.cos(lat2Rad);
      const x = Math.cos(lat1Rad) * Math.sin(lat2Rad) -
                Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(dLonRad);
      const brng = Math.atan2(y, x) / rad;
      return (brng + 360) % 360;
    }

    return 0;
  },

  _buildStreetViewButton(lat, lon, label, heading) {
    const btn = L.DomUtil.create('button', 'btn-external-link streetview');
    btn.title = 'View street-level imagery';
    btn.innerHTML = '<i class="fa-solid fa-street-view"></i> Street View';
    L.DomEvent.on(btn, 'click', function(e) {
      L.DomEvent.stopPropagation(e);
      GSRUI.openStreetView(lat, lon, label, heading);
    });
    L.DomEvent.disableClickPropagation(btn);
    return btn;
  },

  /**
   * Shared popup builder used by both single-track and collective views.
   * @param {Object} opts
   * @param {string} opts.heading        - Popup header text
   * @param {Object} opts.analyzerRef    - GSRAnalyzer instance (for date/time formatting)
   * @param {Object} opts.peak           - Peak event object
   * @param {number} opts.index          - Peak index
   * @param {number} opts.lat            - Latitude
   * @param {number} opts.lon            - Longitude
   * @param {Object} opts.marker         - Leaflet marker (for closePopup)
   * @param {string} [opts.trackId]      - Track ID (collective); omitted for single
   * @param {string} [opts.extraClass]   - Extra CSS class, e.g. 'compact'
   */
  buildPeakPopup(opts) {
    const { heading, analyzerRef, peak, index, lat, lon, marker, trackId, extraClass } = opts;
    const displayLabel = peak.label || '';
    const quality = getQualityLabel(peak.qualityScore);

    const container = L.DomUtil.create('div');
    container.className = 'map-popup-card' + (extraClass ? ' ' + extraClass : '');

    const headerRow = L.DomUtil.create('div', 'popup-header-row', container);
    const h4 = L.DomUtil.create('h4', '', headerRow);
    h4.textContent = heading;

    const table = L.DomUtil.create('table', 'popup-table', container);

    // --- Label row (editable) ---
    const trLabel = L.DomUtil.create('tr', '', table);
    L.DomUtil.create('td', '', trLabel).textContent = 'Label:';
    const tdLabel2 = L.DomUtil.create('td', '', trLabel);
    const input = L.DomUtil.create('textarea', 'popup-label-input peak-popup-label-input', tdLabel2);
    input.rows = 1;
    input.value = displayLabel;
    input.placeholder = 'Enter label…';

    // Auto-size on render
    setTimeout(() => {
      input.style.height = 'auto';
      input.style.height = input.scrollHeight + 'px';
    }, 0);

    // --- Date row ---
    const trDate = L.DomUtil.create('tr', '', table);
    L.DomUtil.create('td', '', trDate).textContent = 'Date:';
    L.DomUtil.create('td', '', trDate).textContent = analyzerRef.formatDateUK(peak.time);

    // --- Time row ---
    const trTime = L.DomUtil.create('tr', '', table);
    L.DomUtil.create('td', '', trTime).textContent = 'Time:';
    L.DomUtil.create('td', '', trTime).textContent = analyzerRef.formatTimeOnly(peak.time);

    // --- Quality row ---
    const trQuality = L.DomUtil.create('tr', '', table);
    L.DomUtil.create('td', '', trQuality).textContent = 'Quality:';
    const tdQuality2 = L.DomUtil.create('td', '', trQuality);
    tdQuality2.innerHTML = '<span style="color:' + getQualityColor(peak.qualityScore) +
      ';font-weight:600;">' + quality.label + ' (' + quality.pct + '%)</span>';

    // --- Bottom row: external links (left) + exclude button (right) ---
    const bottomRow = L.DomUtil.create('div', 'popup-bottom-row', container);
    const links = L.DomUtil.create('div', 'popup-external-links', bottomRow);
    const headingVal = MapPopups.getHeadingAtPeak(analyzerRef, peak);
    links.appendChild(MapPopups._buildStreetViewButton(
      lat, lon,
      displayLabel || ('Peak #' + (index + 1)),
      headingVal
    ));

    const excludeBtn = L.DomUtil.create('button', 'btn-exclude-popup', bottomRow);
    excludeBtn.title = peak.excluded ? 'Include peak' : 'Exclude peak';
    excludeBtn.innerHTML = peak.excluded
      ? '<i class="fa-solid fa-plus"></i>'
      : '<i class="fa-solid fa-xmark"></i>';

    // --- Event handlers ---
    L.DomEvent.on(input, 'input', () => {
      input.style.height = 'auto';
      input.style.height = input.scrollHeight + 'px';
      GSRUI.handleLiveLabelInput(index, input.value, trackId);
    });
    L.DomEvent.on(input, 'change', () => GSRUI.updatePeakLabel(index, input.value, trackId));
    L.DomEvent.on(input, 'keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        GSRUI.updatePeakLabel(index, input.value, trackId);
        input.blur();
      }
    });
    L.DomEvent.disableClickPropagation(input);

    L.DomEvent.on(excludeBtn, 'click', () => {
      GSRUI.togglePeakExclusion(index, trackId);
      marker.closePopup();
    });
    L.DomEvent.disableClickPropagation(excludeBtn);

    return container;
  },

  buildSinglePeakPopup(analyzer, peak, index, coords, marker) {
    return MapPopups.buildPeakPopup({
      heading:     peak.label || ('#' + (index + 1)),
      analyzerRef: analyzer,
      peak:        peak,
      index:       index,
      lat:         coords.lat,
      lon:         coords.lon,
      marker:      marker
    });
  },

  buildCollectivePeakPopup(track, peak, index, lat, lon, marker) {
    return MapPopups.buildPeakPopup({
      heading:     track.name,
      analyzerRef: track.analyzer,
      peak:        peak,
      index:       index,
      lat:         lat,
      lon:         lon,
      marker:      marker,
      trackId:     track.id,
      extraClass:  'compact'
    });
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { MapPopups };
}
if (typeof window !== 'undefined') {
  window.MapPopups = MapPopups;
}
