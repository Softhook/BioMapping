/**
 * GSRUI — collective (multi-track) map trigger. Object-augment split from
 * ui.js: loaded immediately after ui.js, adds these methods to the shared
 * GSRUI object.
 *
 * updateCollectiveMap() debounces rapid callers (slider drag, track toggles)
 * before _updateCollectiveMapNow() reads the contour controls, renders the
 * collective surface via AppState.mapManager, and refreshes the aggregate
 * stat cards.
 */
(function () {
const __methods = {

  /**
   * Render all active tracks on the collective map with contour lines.
   * Debounced at 150 ms to avoid redundant recalculation during slider drag.
   */
  updateCollectiveMap() {
    if (!AppState.mapManager) return;

    // Debounce: coalesce rapid calls (slider drag, multiple track toggles)
    if (this._collectiveDebounceId) {
      clearTimeout(this._collectiveDebounceId);
    }
    this._collectiveDebounceId = setTimeout(() => {
      this._collectiveDebounceId = null;
      this._updateCollectiveMapNow();
    }, 150);
  },

  _updateCollectiveMapNow() {
    if (!AppState.mapManager) return;

    if (GSRTrackManager.getActiveTracks().length === 0) {
      AppState.mapManager.clearCollectiveLayers();
      const F0 = AppState.statFields;
      if (F0.duration)  F0.duration.innerText  = '--';
      if (F0.meanSCL)   F0.meanSCL.innerText   = '--';
      if (F0.peakCount) F0.peakCount.innerText = '--';
      if (F0.peakFreq)  F0.peakFreq.innerText  = '--';
      return;
    }

    const cc = AppState.contourControls;
    const contourParams = {
      gridResolution:    parseInt(cc.gridResolution ? cc.gridResolution.value : GSR_CONST.COLLECTIVE.gridResolution),
      contourCount:      parseInt(cc.contourCount ? cc.contourCount.value : GSR_CONST.COLLECTIVE.contourCount),
      isolationRadius:   parseFloat(cc.isolationRadius ? cc.isolationRadius.value : GSR_CONST.COLLECTIVE.isolationRadius),
      idwExponent:       parseFloat(cc.idwExponent ? cc.idwExponent.value : GSR_CONST.COLLECTIVE.idwExponent),
      peakPreservation:  parseFloat(cc.peakPreservation ? cc.peakPreservation.value : GSR_CONST.COLLECTIVE.peakPreservation),
      coverageWeighting: parseFloat(cc.coverageWeighting ? cc.coverageWeighting.value : GSR_CONST.COLLECTIVE.coverageWeighting),
      topographySource:  cc.topoSource ? cc.topoSource.value : 'phasic',
      showShadedSurface: cc.showShadedSurface ? cc.showShadedSurface.classList.contains('active') : true,
      normalizeZScore:   cc.normalizeZScore ? cc.normalizeZScore.checked : true,
      surfaceOpacity:    cc.surfaceOpacity ? parseFloat(cc.surfaceOpacity.value) : 0.40,
      hillshadeStrength: cc.hillshadeStrength ? parseFloat(cc.hillshadeStrength.value) : 0.0
    };

    const lat = parseFloat(AppState.sliders.gpsPeakLatency ? AppState.sliders.gpsPeakLatency.value : GSR_CONST.GPS_DEFAULT.peakLatency);
    AppState.mapManager.renderCollectiveData(AppState.collectiveManager, contourParams, lat);

    let totalDur = 0, totalPeaks = 0, sumSCL = 0, sclCount = 0;

    GSRTrackManager.getActiveTracks().forEach(track => {
      const stats = track.analyzer.getStats();
      totalDur += stats.duration;
      totalPeaks += stats.peakCount;
      track.analyzer.tonic.forEach(d => {
        sumSCL += d.val;
        sclCount++;
      });
    });

    const meanSCL = sclCount > 0 ? (sumSCL / sclCount) : 0;
    const meanPeakFreq = (totalDur > 0) ? (totalPeaks / (totalDur / 60.0)) : 0;

    const F = AppState.statFields;
    if (F.date)      F.date.innerText      = '--';
    if (F.startTime) F.startTime.innerText  = '--';
    if (F.duration) F.duration.innerText = (totalDur / 60.0).toFixed(1) + " min";
    if (F.meanSCL)  F.meanSCL.innerText  = meanSCL.toFixed(3) + " \u03bcS";
    if (F.peakCount) F.peakCount.innerText = totalPeaks;
    if (F.peakFreq)  F.peakFreq.innerText  = meanPeakFreq.toFixed(2) + " / min";
  },

};

if (typeof module !== 'undefined' && module.exports) {
  Object.assign(global, require('./ui.mjs'));
  module.exports = __methods;
} else {
  Object.assign(GSRUI, __methods);
}
})();
