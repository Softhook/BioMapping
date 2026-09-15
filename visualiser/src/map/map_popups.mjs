/**
 * Peak-marker popup DOM builders — extracted from map.js (GSRMapManager).
 *
 * These build the editable "peak popup card" (a label textarea, Street View
 * link, and exclude button — no name/date/time/quality chrome) and hold no
 * map state. Used by the 2D Leaflet view (GSRMapManager peak/hotspot markers)
 * and by the 3D globe (globe3d_view.js _editPeakLabel, which shows the
 * identical card).
 *
 * Depends on the globals L (Leaflet), GSRUI (label/exclude handlers), and
 * GeoUtils (bearing) — all resolved when a popup opens, not at load time.
 */
import { GeoUtils } from '../gps/geo_utils.mjs';
import { GSRUI } from '../ui/ui.mjs';

export const MapPopups = {

  /**
   * Resize+reposition an open popup to fit its current content WITHOUT
   * Leaflet's public Popup.update(), which also calls _updateContent() —
   * that re-invokes the bindPopup(fn) content function, discarding and
   * rebuilding the whole DOM subtree (a fresh textarea replaces the one the
   * user is typing into, killing focus mid-keystroke; see the auto-resize
   * handlers below, which call this on every keystroke). _updateLayout() +
   * _updatePosition() do the same resize/reposition Popup.update() does,
   * reading the EXISTING _contentNode's measured size, with no content
   * rebuild. Leaflet-internal (`_`-prefixed) API — guarded so a future
   * Leaflet upgrade that removes them just skips the resize rather than
   * reintroducing the content-rebuild bug via a .update() fallback.
   * @private
   */
  _reflowPopup(popup) {
    if (!popup) return;
    if (typeof popup._updateLayout === 'function') popup._updateLayout();
    if (typeof popup._updatePosition === 'function') popup._updatePosition();
  },

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
      return GeoUtils.bearingDeg(pCurrent.lat, pCurrent.lon, pNext.lat, pNext.lon);
    }

    return 0;
  },

  _buildStreetViewButton(lat, lon, label, heading) {
    const btn = L.DomUtil.create('button', 'btn-external-link btn-icon-only streetview');
    btn.title = 'View street-level imagery';
    btn.setAttribute('aria-label', 'View street-level imagery');
    btn.innerHTML = '<i class="fa-solid fa-street-view"></i>';
    L.DomEvent.on(btn, 'click', function(e) {
      L.DomEvent.stopPropagation(e);
      GSRUI.openStreetView(lat, lon, label, heading);
    });
    L.DomEvent.disableClickPropagation(btn);
    return btn;
  },

  /**
   * Shared popup builder used by both single-track and collective views. The
   * label textarea IS the popup — no name/date/time/quality chrome — since
   * labelling a peak from the map is the action this popup exists for.
   * @param {Object} opts
   * @param {Object} opts.analyzerRef    - GSRAnalyzer instance (heading lookup for Street View)
   * @param {Object} opts.peak           - Peak event object
   * @param {number} opts.index          - Peak index
   * @param {number} opts.lat            - Latitude
   * @param {number} opts.lon            - Longitude
   * @param {Object} opts.marker         - Leaflet marker for 2D, or a plain
   *   { closePopup } shim for the 3D globe (globe3d_view.js _editPeakLabel)
   * @param {string} [opts.trackId]      - Track ID (collective); omitted for single
   * @param {string} [opts.extraClass]   - Extra CSS class, e.g. 'compact'
   * @param {Function} [opts.onResize]   - Called after the textarea's height
   *   changes, so the caller can reflow its OWN wrapper to fit: the 2D
   *   Leaflet popup (card/tip position — see MapPopups._reflowPopup) and the
   *   3D globe's floating div (re-clamped screen position — see
   *   GSRGlobe3DView._reflowPeakPopup) resize completely differently, so this
   *   builder stays agnostic and just tells whichever one is listening.
   */
  buildPeakPopup(opts) {
    const { analyzerRef, peak, index, lat, lon, marker, trackId, extraClass, onResize } = opts;
    const displayLabel = peak.label || '';

    const container = L.DomUtil.create('div');
    container.className = 'map-popup-card' + (extraClass ? ' ' + extraClass : '');

    // The label textarea IS the body of the popup. Empty (peak still at its
    // default numbered name) shows the "Enter label…" placeholder; a
    // previously-entered label shows as the value.
    const input = L.DomUtil.create('textarea', 'popup-label-input peak-popup-label-input peak-popup-label-input-main', container);
    input.rows = 4;
    input.value = displayLabel;
    input.placeholder = 'Enter label…';

    // Auto-size on render. onResize() lets the caller reflow its wrapper to
    // the new height — without it a multi-line label gets clipped (2D: the
    // popup card/tip stays at its original size; 3D: the floating div can
    // grow past the point its position was clamped to).
    setTimeout(() => {
      input.style.height = 'auto';
      input.style.height = input.scrollHeight + 'px';
      if (typeof onResize === 'function') onResize();
    }, 0);

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
      ? '<i class="fa-solid fa-plus"></i> Include'
      : '<i class="fa-solid fa-xmark"></i> Exclude';

    // --- Event handlers ---
    L.DomEvent.on(input, 'input', () => {
      input.style.height = 'auto';
      input.style.height = input.scrollHeight + 'px';
      if (typeof onResize === 'function') onResize();
      GSRUI.handleLiveLabelInput(index, input.value, trackId);
    });
    L.DomEvent.on(input, 'change', () => GSRUI.updatePeakLabel(index, input.value, trackId));
    L.DomEvent.on(input, 'keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        // Close BEFORE committing the label — updatePeakLabel() rebuilds the
        // peak-marker layer (a new marker replaces this one), so closing
        // after that would be acting on an already-discarded marker.
        marker.closePopup();
        GSRUI.updatePeakLabel(index, input.value, trackId);
      }
    });
    L.DomEvent.disableClickPropagation(input);

    L.DomEvent.on(excludeBtn, 'click', () => {
      // Same ordering reason as the Enter handler above: togglePeakExclusion()
      // rebuilds the peak-marker layer, so this marker must close its own
      // popup before that swap happens.
      marker.closePopup();
      GSRUI.togglePeakExclusion(index, trackId);
    });
    L.DomEvent.disableClickPropagation(excludeBtn);

    return container;
  },

  buildSinglePeakPopup(analyzer, peak, index, coords, marker) {
    return MapPopups.buildPeakPopup({
      analyzerRef: analyzer,
      peak:        peak,
      index:       index,
      lat:         coords.lat,
      lon:         coords.lon,
      marker:      marker,
      onResize:    () => MapPopups._reflowPopup(marker.getPopup())
    });
  },

  buildCollectivePeakPopup(track, peak, index, lat, lon, marker) {
    return MapPopups.buildPeakPopup({
      analyzerRef: track.analyzer,
      peak:        peak,
      index:       index,
      lat:         lat,
      lon:         lon,
      marker:      marker,
      trackId:     track.id,
      extraClass:  'compact',
      onResize:    () => MapPopups._reflowPopup(marker.getPopup())
    });
  },

  /**
   * Popup for an Arousal Place (map_manager_arousal_places.js _renderArousalPlaces). Shows
   * the dwell-normalised score plus the aggregates behind it and, when OSM
   * enrichment has run, the street context at the place centroid.
   * @param {Object} place - Record from GSRArousalPlaces.buildPlaces().
   * @param {{collective:boolean, activeTrackCount:number}} ctx
   */
  buildArousalPlacePopup(place, ctx) {
    const multiTrack = ctx && ctx.collective && ctx.activeTrackCount > 1;

    const container = L.DomUtil.create('div');
    container.className = 'map-popup-card compact';

    const headerRow = L.DomUtil.create('div', 'popup-header-row', container);
    L.DomUtil.create('h4', '', headerRow).textContent =
      `${place.label} — ${place.memberCount} ${place.memberCount === 1 ? 'peak' : 'peaks'}`;

    const table = L.DomUtil.create('table', 'popup-table', container);
    const row = (k, v) => {
      const tr = L.DomUtil.create('tr', '', table);
      L.DomUtil.create('td', '', tr).textContent = k;
      L.DomUtil.create('td', '', tr).textContent = v;
    };

    if (multiTrack) {
      row('Walks:', `${place.trackCount} of ${ctx.activeTrackCount}${place.provisional ? ' (provisional)' : ''}`);
    }
    row('Arousal rate:', `${place.rate.toFixed(2)} µS·s/min`);
    row('Arousal energy:', `${place.energy.toFixed(2)} µS·s`);
    row('Dwell:', formatMMSS(place.dwellSeconds));
    row('Peak amplitude:', `${place.meanAmp.toFixed(3)} µS mean / ${place.maxAmp.toFixed(3)} µS max`);
    if (place.firstTime != null) row('First visit:', formatMMSS(place.firstTime));

    if (place.osm) {
      L.DomUtil.create('div', 'popup-subhead', container).textContent = 'Street context';
      const t2 = L.DomUtil.create('table', 'popup-table', container);
      const row2 = (k, v) => {
        const tr = L.DomUtil.create('tr', '', t2);
        L.DomUtil.create('td', '', tr).textContent = k;
        L.DomUtil.create('td', '', tr).textContent = v;
      };
      if (place.osm.roadClass != null) row2('Road class:', String(place.osm.roadClass));
      if (place.osm.distGreen != null) row2('Dist. to green:', `${Math.round(place.osm.distGreen)} m`);
      if (place.osm.canopyPct != null) row2('Tree canopy:', `${place.osm.canopyPct.toFixed(0)} %`);
    } else {
      L.DomUtil.create('div', 'popup-note', container).textContent =
        'Run OSM enrichment for street context.';
    }

    return container;
  }
};

export function formatMMSS(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}
