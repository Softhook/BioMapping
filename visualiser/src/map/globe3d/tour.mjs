/**
 * GSRGlobeManager — automated sequential track tour.
 * Prototype-augment split from globe3d.js: loaded after globe3d.js, adds
 * these methods to GSRGlobeManager.prototype.
 *
 * _computeTourWaypoints reads this.currentAnalyzer/_getMetricSeries (core);
 * _executeTourStep drives the camera the same way flyToPeak does but with
 * its own dwell/timeout bookkeeping (this._tourStepTimeout etc.).

 * Assigned onto GSRGlobeManager.prototype via Object.assign at the file's
 * tail (a plain ESM static import/export, loaded once by app_entry.mjs).
 * below copies globe3d.js's entire export surface onto `global` rather than
 * naming individual identifiers — globe3d.js's module.exports is the single
 * source of truth for what's available bare; a name missing there is a bug in
 * globe3d.js's exports, not something to patch around here.
 */
import { GeoUtils } from '../../gps/geo_utils.mjs';
import {
  GSRGlobeManager,
  HEIGHT_CAPABLE_METRICS,
  seriesValue,
} from '../globe3d.mjs';

export const __methods = {
  /**
   * Register a progress callback for the automated tour: (stepIndex, totalSteps, waypoint) => void
   */
  onTourStep(cb) {
    this._tourCallback = typeof cb === 'function' ? cb : null;
  },

  /**
   * Toggle automated sequential tour along the track
   */
  toggleTour() {
    if (this._isTouring) {
      this.stopTour();
    } else {
      this.startTour();
    }
    return this._isTouring;
  },

  /**
   * Calculate forward azimuth/bearing (in degrees 0-360) from p1 to p2.
   */
  _calculateBearing(p1, p2) {
    if (!p1 || !p2) return 0;
    return GeoUtils.bearingDeg(p1.lat, p1.lon, p2.lat, p2.lon);
  },

  /**
   * Compute a sequence of tour waypoints along the track.
   * Prioritizes track start/end, significant peaks/hotspots, and evenly distributed path steps.
   */
  _computeTourWaypoints() {
    const pts = this.currentDrawPoints;
    if (!pts || pts.length < 2) return [];

    const metric = this.activeColoringMetric;
    const heightMetric = HEIGHT_CAPABLE_METRICS?.has(metric)
      ? metric
      : this.heightMetric || 'phasic';
    const heightSeries = this._getMetricSeries(
      this.currentAnalyzer,
      heightMetric,
    );
    const extScale = this.extrusionScale || 8.0;
    const baseH = this.baseHeight || 2.0;

    // Collect candidate indices along the track
    const candidateIndices = new Set();
    candidateIndices.add(0);
    candidateIndices.add(pts.length - 1);

    // Add peak indices (both original sample index and latency-shifted index)
    if (this.currentPeaks && this.currentPeaks.length > 0) {
      this.currentPeaks.forEach((pk) => {
        if (pk && typeof pk.index === 'number') {
          const matchIdx = pts.findIndex((p) => p.origIdx === pk.index);
          if (matchIdx !== -1) candidateIndices.add(matchIdx);
          if (
            this.peakLatency > 0 &&
            this.currentAnalyzer &&
            typeof this.currentAnalyzer.resolveLatencyIndex === 'function'
          ) {
            const shiftedOrigIdx = this.currentAnalyzer.resolveLatencyIndex(
              pk,
              this.peakLatency,
            );
            const shiftedMatchIdx = pts.findIndex(
              (p) => p.origIdx === shiftedOrigIdx,
            );
            if (shiftedMatchIdx !== -1) candidateIndices.add(shiftedMatchIdx);
          }
        }
      });
    }

    // Add evenly spaced samples (aiming for ~16-24 waypoints total)
    const targetSteps = Math.min(24, Math.max(12, Math.floor(pts.length / 20)));
    const stepSize = Math.max(1, Math.floor(pts.length / targetSteps));
    for (let i = stepSize; i < pts.length - 1; i += stepSize) {
      candidateIndices.add(i);
    }

    const sortedIndices = Array.from(candidateIndices).sort((a, b) => a - b);
    const waypoints = [];

    // Helper to calculate wall height at any draw point
    const heightAtPoint = (p) => {
      if (!p || p.origIdx == null || !heightSeries) return baseH;
      const rawVal = heightSeries[p.origIdx];
      return baseH + Math.max(0, seriesValue(rawVal)) * extScale;
    };

    const lookAheadSteps = Math.max(
      3,
      Math.min(10, Math.floor(pts.length / 30)),
    );

    for (let i = 0; i < sortedIndices.length; i++) {
      const idx = sortedIndices[i];
      const p = pts[idx];

      // Smooth forward bearing by looking ahead along the path
      let bearingDeg;
      if (idx < pts.length - 1) {
        const lookAheadIdx = Math.min(pts.length - 1, idx + lookAheadSteps);
        bearingDeg = this._calculateBearing(
          p,
          pts[lookAheadIdx] || pts[idx + 1],
        );
      } else if (idx > 0) {
        const lookBehindIdx = Math.max(0, idx - lookAheadSteps);
        bearingDeg = this._calculateBearing(
          pts[lookBehindIdx] || pts[idx - 1],
          p,
        );
      } else {
        bearingDeg = 0;
      }

      // GSR arousal height at this point
      const gsrHeight = heightAtPoint(p);

      // Check if this waypoint is at or near a peak or hotspot
      const isPeak = (this.currentPeaks || []).some((pk) => {
        if (!pk) return false;
        if (pk.index === p.origIdx) return true;
        if (
          this.peakLatency > 0 &&
          this.currentAnalyzer &&
          typeof this.currentAnalyzer.resolveLatencyIndex === 'function'
        ) {
          return (
            this.currentAnalyzer.resolveLatencyIndex(pk, this.peakLatency) ===
            p.origIdx
          );
        }
        return false;
      });

      // Find local max height in the upcoming track window (+16 points ahead)
      const windowStart = Math.max(0, idx - 4);
      const windowEnd = Math.min(pts.length - 1, idx + 16);
      let localMaxHeight = gsrHeight;
      for (let w = windowStart; w <= windowEnd; w++) {
        const hW = heightAtPoint(pts[w]);
        if (hW > localMaxHeight) localMaxHeight = hW;
      }

      // Effective height for camera framing:
      // Includes local track wall height, headroom for upcoming peaks,
      // and spire/star/label annotation heights (spire: +3m, hotspot: +11m, label: +15m)
      const annotationHeadroom = isPeak ? 15.0 : 0.0;
      const effectiveHeight = Math.max(
        gsrHeight + annotationHeadroom,
        localMaxHeight * 0.9 + annotationHeadroom * 0.5,
        16.0,
      );

      waypoints.push({
        index: i,
        drawPointIndex: idx,
        origIdx: p.origIdx,
        lat: p.lat,
        lon: p.lon,
        time: p.time,
        bearingDeg,
        gsrHeight,
        effectiveHeight,
        isPeak,
      });
    }

    return waypoints;
  },

  /**
   * Start the automated sequential tour.
   */
  startTour() {
    if (
      !this.viewer ||
      !this.currentDrawPoints ||
      this.currentDrawPoints.length < 2
    )
      return;
    if (this._isOrbiting) this.stopOrbit();
    this.releaseFollowScrub();

    this._tourWaypoints = this._computeTourWaypoints();
    if (this._tourWaypoints.length === 0) return;

    this._isTouring = true;
    this._tourStepIndex = 0;
    this._wakeRenderLoop();

    this._executeTourStep(0);
  },

  /**
   * Execute a single tour step and schedule the next.
   */
  _executeTourStep(stepIdx) {
    if (!this._isTouring || !this.viewer) return;
    if (stepIdx >= this._tourWaypoints.length) {
      // Tour reached the end - perform a smooth final overview flight and stop
      this.flyToTrack(false);
      this.stopTour();
      return;
    }

    this._tourStepIndex = stepIdx;
    const wp = this._tourWaypoints[stepIdx];

    // Notify listeners (scrub sync / UI)
    if (this._tourCallback) {
      this._tourCallback(stepIdx, this._tourWaypoints.length, wp);
    }
    // Explicitly pass gsrHeight so the blue scrub dot is elevated to sit on top of the track
    this.setScrubPosition(wp.lat, wp.lon, wp.gsrHeight);

    // Forward-facing camera configuration:
    // Placed behind the point looking forward along the direction of travel,
    // zoomed back and elevated so the track wall, blue scrub dot, and peak spires/annotations
    // are framed clearly with generous vertical and horizon context.
    const headingRad = (wp.bearingDeg * Math.PI) / 180.0;
    const inverseHeadingRad = headingRad + Math.PI;

    // Pitch: angled down (-24°) to capture ground path, rising ribbon, and skyline
    const pitchDeg = -24.0;
    const pitchRad = (pitchDeg * Math.PI) / 180.0;

    // Altitude & distance: dynamically adapt to the effective track height & annotations
    const effH = wp.effectiveHeight || wp.gsrHeight || 16.0;
    const backDistMeters = Math.max(85.0, effH * 2.4 + 60.0);

    // Target look-at height centred on the vertical mid-region of the track/spires
    const targetLookAtHeight = effH * 0.45;
    const altitudeOffset =
      targetLookAtHeight + backDistMeters * Math.tan(Math.abs(pitchRad));

    // Offset backwards along inverse heading in meters
    const latOffsetDeg =
      (backDistMeters * Math.cos(inverseHeadingRad)) / 111320.0;
    const latRad = (wp.lat * Math.PI) / 180.0;
    const lonOffsetDeg =
      (backDistMeters * Math.sin(inverseHeadingRad)) /
      (111320.0 * Math.max(0.1, Math.cos(latRad)));

    const camLat = wp.lat + latOffsetDeg;
    const camLon = wp.lon + lonOffsetDeg;

    let terrainAlt = 0;
    try {
      if (
        this.viewer.scene?.globe &&
        typeof this.viewer.scene.globe.getHeight === 'function'
      ) {
        const cartoCam = Cesium.Cartographic.fromDegrees(camLon, camLat);
        const cartoWp = Cesium.Cartographic.fromDegrees(wp.lon, wp.lat);
        const hCam = this.viewer.scene.globe.getHeight(cartoCam);
        const hWp = this.viewer.scene.globe.getHeight(cartoWp);
        const validHCam =
          typeof hCam === 'number' && isFinite(hCam) ? Math.max(0, hCam) : 0;
        const validHWp =
          typeof hWp === 'number' && isFinite(hWp) ? Math.max(0, hWp) : 0;
        terrainAlt = Math.max(validHCam, validHWp);
      }
    } catch (_e) {}

    const targetAltitude = terrainAlt + altitudeOffset;
    const destination = Cesium.Cartesian3.fromDegrees(
      camLon,
      camLat,
      targetAltitude,
    );

    const flightDuration = stepIdx === 0 ? 2.0 : 1.6;

    this.viewer.camera.flyTo({
      destination: destination,
      orientation: {
        heading: headingRad,
        pitch: pitchRad,
        roll: 0.0,
      },
      duration: flightDuration,
      complete: () => {
        if (!this._isTouring) return;
        // Pause at each waypoint (longer pause on peaks/hotspots so user can observe)
        const pauseMs = wp.isPeak ? 2400 : 1500;
        this._tourStepTimeout = setTimeout(() => {
          if (this._isTouring) {
            this._executeTourStep(stepIdx + 1);
          }
        }, pauseMs);
      },
      cancel: () => {
        if (this._isTouring) {
          this.stopTour();
        }
      },
    });
  },

  /**
   * Stop tour playback and clear timers.
   */
  stopTour() {
    if (this._tourStepTimeout) {
      clearTimeout(this._tourStepTimeout);
      this._tourStepTimeout = null;
    }
    const wasTouring = this._isTouring;
    this._isTouring = false;
    if (wasTouring && this._tourCallback) {
      this._tourCallback(null, 0, null);
    }
  },
};

Object.assign(GSRGlobeManager.prototype, __methods);
