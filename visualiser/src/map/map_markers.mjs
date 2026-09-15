/**
 * GSRMapMarkers — shared peak / hotspot map-marker geometry and icons.
 *
 * Extracted from map_manager_peaks.js so the single-track 2D map, the
 * collective map, and the Live view's follow-map all draw peak dots and
 * hotspot stars from ONE definition (the Live view previously had no map
 * markers at all, and had it drawn its own it could never have matched the
 * main map's look after any future tweak). The glyphs are CSS-styled
 * (.peak-dot / .hotspot-star / .hotspot-glow-ring in styles.css), so the
 * markers automatically track the app theme.
 *
 * `L` (Leaflet) is passed in explicitly rather than read from a global, so
 * both entry points (index.html's real Leaflet, live.html's real Leaflet, and
 * the tests' hand-rolled mocks) call the same code with whatever L they have.
 * `analyzer` is a GSRAnalyzer instance whose .raw rows carry { lat, lon } —
 * the same shape feedLiveAnalyzer() builds for the live view.
 */
export const GSRMapMarkers = {
  /**
   * Raw-sample index a peak/hotspot marker should be planted at, applying the
   * optional GPS-latency shift (find the GPS fix at peak.time - peakLatency,
   * falling back to peak.index). Mirrors the logic map_manager_peaks.js used
   * to own inline; kept here so live + single-track + collective can't drift.
   */
  resolveLatencyIndex(analyzer, peak, peakLatency) {
    if (analyzer && typeof analyzer.resolveLatencyIndex === 'function') {
      return analyzer.resolveLatencyIndex(peak, peakLatency);
    }
    if (!(peakLatency > 0)) return peak.index;
    const shiftedTime = Math.max(0, peak.time - peakLatency);
    const si = analyzer.findClosestIndex(shiftedTime);
    return si >= 0 ? si : peak.index;
  },

  /** { lat, lon } for a marker, with latency applied. Returns null when the
   *  analyser has no coordinates at that index (e.g. a GPS-less packet). */
  hotspotMarkerCoords(analyzer, peak, peakLatency) {
    return analyzer.getCoordinates(
      GSRMapMarkers.resolveLatencyIndex(analyzer, peak, peakLatency),
    );
  },

  /**
   * Leaflet divIcon for an unlabelled, non-hotspot peak: a small
   * quality-neutral --color-peak red dot, no per-track colour, no animation
   * (hotspots are the visually dominant layer).
   */
  buildPeakIcon(L) {
    return L.divIcon({
      className: '',
      html: '<div class="stress-peak-icon-wrapper" style="position:relative;width:24px;height:24px;"><div class="peak-dot" style="position:absolute;top:9px;left:9px;width:6px;height:6px;"></div></div>',
      iconSize: [24, 24],
      iconAnchor: [12, 12],
    });
  },

  /**
   * Leaflet divIcon for a memorable-event hotspot: a red star (★) with the
   * expanding pulse-glow ring behind it — consistent with the GSR graph and
   * the 3D globe (peaks are a small circle everywhere; hotspots are a star).
   */
  buildHotspotIcon(L) {
    return L.divIcon({
      className: '',
      html:
        '<div class="stress-peak-icon-wrapper" style="position:relative;width:28px;height:28px;">' +
        '<div class="hotspot-glow-ring" style="position:absolute;top:0;left:0;"></div>' +
        '<div class="hotspot-star" style="position:absolute;top:0;left:0;width:28px;height:28px;">★</div>' +
        '</div>',
      iconSize: [28, 28],
      iconAnchor: [14, 14],
    });
  },
};
