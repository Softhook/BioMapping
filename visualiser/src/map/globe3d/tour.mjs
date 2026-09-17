/**
 * GSRGlobeManager — automated cinematic Hotspot tour.
 * Prototype-augment split from globe3d.js: loaded after globe3d.js, adds
 * these methods to GSRGlobeManager.prototype.
 *
 * _computeTourWaypoints visits analyzer.memorableEvents (the curated Hotspot
 * subset — same star markers the map/graph show) in walk order, falling back
 * to generic evenly-spaced track sampling when there are no hotspots; reads
 * this.currentAnalyzer/_getMetricSeries/_latencyCoords/_peakWallHeight
 * (core/peaks.js). _executeTourStep drives the camera the same way flyToPeak
 * does but with its own dwell/timeout bookkeeping (this._tourStepTimeout
 * etc.) and a side-on angled shot per hotspot instead of a fixed offset.

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

// ── Hotspot shot-side selection tuning ──────────────────────────────────────
// See _chooseTourShot's doc comment for the cost model these combine into.
const SIDE_ANGLE_DEG = 122.0; // off the direction of travel — between a flat 90° profile and a straight 180° chase-cam
const OBSTRUCTION_COST_RAD = 0.5; // per blocking point, in turn-equivalent radians
const SIDE_STICKINESS_RAD = 0.8; // bias favouring whichever side the previous hotspot used
const MAX_TURN_RATE_RAD_PER_SEC = (65.0 * Math.PI) / 180.0; // ~65°/s: brisk but legible

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
   * Local track bearing at drawn-point index `idx`: looks `lookAheadSteps`
   * points ahead along the path (or behind, near the very end) so the
   * heading is smoothed rather than jittering sample-to-sample. Shared by
   * both waypoint builders so a hotspot's camera framing and the generic
   * track tour agree on what "facing forward" means at a given point.
   */
  _trackBearingAt(pts, idx, lookAheadSteps) {
    const p = pts[idx];
    if (idx < pts.length - 1) {
      const lookAheadIdx = Math.min(pts.length - 1, idx + lookAheadSteps);
      return this._calculateBearing(p, pts[lookAheadIdx] || pts[idx + 1]);
    }
    if (idx > 0) {
      const lookBehindIdx = Math.max(0, idx - lookAheadSteps);
      return this._calculateBearing(pts[lookBehindIdx] || pts[idx - 1], p);
    }
    return 0;
  },

  /**
   * Compute the tour's waypoint sequence. Prefers the real curated Hotspots
   * (analyzer.memorableEvents — the same red-star markers the map/graph show)
   * visited in walk order; falls back to generic evenly-spaced track sampling
   * when there are no hotspots to visit (e.g. a very short or quiet walk).
   */
  _computeTourWaypoints() {
    const hotspotWaypoints = this._computeHotspotTourWaypoints();
    if (hotspotWaypoints.length > 0) return hotspotWaypoints;
    return this._computeTrackTourWaypoints();
  },

  /**
   * Build tour waypoints from analyzer.memorableEvents (the curated Hotspot
   * subset), one per hotspot, ordered chronologically (the order they occurred
   * during the walk) so the tour replays the journey rather than jumping
   * around by rank. Each waypoint's position/height reuse the exact same
   * helpers the hotspot star markers themselves are drawn with
   * (_latencyCoords/_peakWallHeight), so the camera lands exactly where the
   * star is. Local track bearing (for camera framing) is read from the
   * nearest drawn track sample.
   */
  _computeHotspotTourWaypoints() {
    const a = this.currentAnalyzer;
    const events = a?.memorableEvents;
    const pts = this.currentDrawPoints;
    if (!a || !events || events.length === 0 || !pts || pts.length < 2)
      return [];

    const peakIndexOf = this._peakIndexMap(a);
    const lookAheadSteps = Math.max(
      3,
      Math.min(10, Math.floor(pts.length / 30)),
    );

    // Resolve each hotspot's marker position and its nearest drawn track
    // sample (to read local bearing from).
    const resolved = [];
    for (const peak of events) {
      const coords = this._latencyCoords(a, peak);
      if (!coords || isNaN(coords.lat) || isNaN(coords.lon)) continue;
      let nearestIdx = -1;
      let nearestDsq = Infinity;
      for (let i = 0; i < pts.length; i++) {
        const dLat = pts[i].lat - coords.lat;
        const dLon = pts[i].lon - coords.lon;
        const dsq = dLat * dLat + dLon * dLon;
        if (dsq < nearestDsq) {
          nearestDsq = dsq;
          nearestIdx = i;
        }
      }
      if (nearestIdx === -1) continue;
      resolved.push({ peak, coords, drawIdx: nearestIdx });
    }
    if (resolved.length === 0) return [];

    // Walk order: earliest response first.
    resolved.sort((x, y) => (x.peak.time ?? 0) - (y.peak.time ?? 0));

    return resolved.map((r, i) => {
      const idx = r.drawIdx;
      const p = pts[idx];
      const bearingDeg = this._trackBearingAt(pts, idx, lookAheadSteps);

      const wallHeight = this._peakWallHeight(a, r.peak);
      // Headroom for the spire tip + star label sitting above the wall
      // (mirrors _renderHotspots' wallHeight + 11 star height).
      const effectiveHeight = Math.max(wallHeight + 14.0, 20.0);

      // Time window for the GSR graph to frame while this hotspot is on
      // camera: from well before onset to well after the response, padded
      // generously so the graph reads as "zoomed out" context around the
      // response rather than a tight crop on just the rise.
      const t = typeof r.peak.time === 'number' ? r.peak.time : p.time || 0;
      const onset =
        typeof r.peak.onsetTime === 'number' ? r.peak.onsetTime : t - 3;
      const graphWinStart = Math.max(0, onset - 6);
      const graphWinDuration = Math.max(16, Math.min(34, t - onset + 16));

      return {
        index: i,
        drawPointIndex: idx,
        origIdx: r.peak.index,
        lat: r.coords.lat,
        lon: r.coords.lon,
        time: t,
        bearingDeg,
        gsrHeight: wallHeight,
        effectiveHeight,
        isPeak: true,
        rank: i,
        peakIdx: peakIndexOf.has(r.peak) ? peakIndexOf.get(r.peak) : -1,
        graphWinStart,
        graphWinDuration,
      };
    });
  },

  /**
   * Fallback waypoint builder: evenly-spaced samples along the track plus
   * plain analyzer.peaks (used only when the walk has no curated Hotspots to
   * tour between).
   */
  _computeTrackTourWaypoints() {
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
      const bearingDeg = this._trackBearingAt(pts, idx, lookAheadSteps);

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
    this._isPaused = false;
    this._tourStepIndex = 0;
    this._tourLastSide = null;
    this._wakeRenderLoop();

    this._executeTourStep(0);
  },

  /**
   * Pause the running tour: freezes the camera exactly where it is right now
   * (cancelling any in-flight camera.flyTo, or clearing a pending dwell
   * timer) without losing tour progress. resumeTour() continues from the
   * same waypoint. No-op unless a tour is actually running and not already
   * paused. The Space-bar shortcut's pause half (see toggleTourPause).
   */
  pauseTour() {
    if (!this._isTouring || this._isPaused) return;
    this._isPaused = true;
    if (this._tourStepTimeout) {
      clearTimeout(this._tourStepTimeout);
      this._tourStepTimeout = null;
    }
    this._cancelTourFlight();
  },

  /**
   * Resume a paused tour from the same waypoint it was frozen at — re-flies
   * from wherever the camera currently sits onto that waypoint's shot and
   * re-enters the normal dwell/advance chain from there. No-op unless the
   * tour is actually paused. The Space-bar shortcut's resume half.
   */
  resumeTour() {
    if (!this._isTouring || !this._isPaused) return;
    this._isPaused = false;
    this._executeTourStep(this._tourStepIndex);
  },

  /** Toggle pause/resume — the Space-bar shortcut's entry point. */
  toggleTourPause() {
    if (this._isPaused) this.resumeTour();
    else this.pauseTour();
    return this._isPaused;
  },

  /**
   * Jump straight to the next/previous tour waypoint (Left/Right-arrow
   * shortcuts), cancelling whatever the camera is currently doing and
   * implicitly un-pausing. No wraparound — a step past either end is simply
   * a no-op, so repeatedly pressing the arrow at the first/last hotspot just
   * stays put rather than looping.
   */
  tourNext() {
    this._jumpToTourStep(this._tourStepIndex + 1);
  },
  tourPrevious() {
    this._jumpToTourStep(this._tourStepIndex - 1);
  },

  _jumpToTourStep(stepIdx) {
    if (!this._isTouring) return;
    if (stepIdx < 0 || stepIdx >= this._tourWaypoints.length) return;
    if (this._tourStepTimeout) {
      clearTimeout(this._tourStepTimeout);
      this._tourStepTimeout = null;
    }
    this._isPaused = false;
    this._cancelTourFlight();
    this._executeTourStep(stepIdx);
  },

  /**
   * Cancel whatever camera.flyTo the tour currently has in flight, without
   * letting that flight's own `cancel` callback (see _executeTourStep) treat
   * the interruption as an externally-stopped tour — pause/jump navigation
   * cancels flights on purpose and wants tour state to survive it. A no-op
   * (nothing in flight, or no flight to cancel) is harmless: Cesium simply
   * ignores cancelFlight() when idle.
   */
  _cancelTourFlight() {
    if (typeof this.viewer?.camera?.cancelFlight !== 'function') return;
    this._tourManualInterrupt = true;
    this.viewer.camera.cancelFlight();
    this._tourManualInterrupt = false;
  },

  /**
   * `targetRad`'s angle, shifted by a multiple of 2π so it's the numerically
   * closest representation to `fromRad`. Used so a computed camera heading
   * always turns the short way — clockwise or anticlockwise, whichever is
   * nearer — from wherever the camera currently is, instead of the raw
   * degree arithmetic happening to wrap the long way around.
   *
   * `fromRad` MUST be the camera's actual live `viewer.camera.heading`, read
   * fresh each call — never a self-tracked "last heading" carried forward
   * across steps. Cesium's own flyTo interpolator (CameraFlightPath) adjusts
   * its *live* current heading by at most one ±2π shift to land within π of
   * whatever heading we hand it; it does not correct for a target that's
   * already many turns away from reality. A carried-forward reference is
   * only ever kept within π of the *previous* step's reference, so over many
   * tour stops it can drift several full turns from Cesium's live heading —
   * and once that drifted number is passed to flyTo, Cesium's single-shift
   * correction can't bring the two close enough, and the camera visibly
   * spins through multiple full turns to get there. Anchoring on the live
   * heading every time keeps the number we hand to flyTo always within one
   * turn of reality, matching what Cesium itself assumes.
   */
  _shortestHeadingTo(targetRad, fromRad) {
    if (typeof fromRad !== 'number' || !isFinite(fromRad)) return targetRad;
    const twoPi = Math.PI * 2;
    let delta = (targetRad - fromRad) % twoPi;
    if (delta > Math.PI) delta -= twoPi;
    else if (delta < -Math.PI) delta += twoPi;
    return fromRad + delta;
  },

  /**
   * 3D-aware obstruction count for a shot from (camLat, camLon, camAlt) at
   * (targetLat, targetLon): how many OTHER drawn track samples actually stick
   * up into that sightline, height included. On a looped or doubled-back
   * walk, one side of a hotspot often looks straight through another leg of
   * the same track to reach it — but only if that other leg's own wall is
   * tall enough to break the line of sight; a low stretch nearby doesn't
   * block a shot angled down from above it. `camAlt` is the camera's height
   * above LOCAL ground (this method works in ground-relative heights
   * throughout, matching how gsrHeight/effectiveHeight are computed, and
   * ignores absolute terrain elevation — a fair approximation at hotspot
   * shot range). A point counts as blocking as soon as its own wall height
   * pokes above the sightline from the camera down to the target's BASE
   * (ground level) — the most sensitive of the target's height range, so
   * something tall enough to hide the foot of the hotspot's wall counts even
   * if its spire would still peek out above it; the aim is to keep the
   * *whole* wall height clear, not just its top or its base.
   * @private
   */
  _sightlineObstructionCount(
    pts,
    targetDrawIdx,
    camLat,
    camLon,
    camAlt,
    targetLat,
    targetLon,
    heightSeries,
    baseH,
    extScale,
  ) {
    const dLat = targetLat - camLat;
    const dLon = targetLon - camLon;
    const lenSq = dLat * dLat + dLon * dLon;
    if (!(lenSq > 0) || !pts) return 0;

    const EXCLUDE_SAMPLES = 8;
    const NEAR_M = 12.0;
    const HEIGHT_MARGIN_M = 1.0;
    let count = 0;
    for (let i = 0; i < pts.length; i++) {
      if (Math.abs(i - targetDrawIdx) <= EXCLUDE_SAMPLES) continue;
      const p = pts[i];
      const pLat = p.lat - camLat;
      const pLon = p.lon - camLon;
      // Project P onto the camera->target ground line; only points strictly
      // between the two (short of the target, in front of the camera) can occlude.
      const t = (pLat * dLat + pLon * dLon) / lenSq;
      if (t <= 0.05 || t >= 0.95) continue;
      const offLat = p.lat - (camLat + dLat * t);
      const offLon = p.lon - (camLon + dLon * t);
      // Perpendicular distance in metres (small-angle approx — fine at this scale).
      const distM = Math.sqrt(offLat * offLat + offLon * offLon) * 111320.0;
      if (distM >= NEAR_M) continue;

      // This point's own wall height, ground-relative (same formula as the
      // wall/height-metric renderer).
      const rawVal =
        heightSeries && p.origIdx != null ? heightSeries[p.origIdx] : null;
      const pointHeight = baseH + Math.max(0, seriesValue(rawVal)) * extScale;

      // Sightline altitude at this point's position, from the camera down to
      // the target's ground level (t=0 -> camAlt, t=1 -> 0).
      const sightAlt = camAlt * (1 - t);
      if (pointHeight > sightAlt + HEIGHT_MARGIN_M) count++;
    }
    return count;
  },

  /**
   * Pick which side of the track to shoot a hotspot from — roughly
   * SIDE_ANGLE_DEG off the direction of travel, between a flat 90° profile
   * shot and a straight chase-cam behind (180°). Either side is an equally
   * valid angle in principle, so both are scored and the cheaper one wins:
   * turn angle from wherever the camera just was (in radians) plus a
   * per-point penalty for any OTHER leg of the track whose own wall height
   * actually pokes up into that side's sightline (height-aware — a low
   * stretch nearby doesn't block a shot angled down from above it; see
   * _sightlineObstructionCount), minus a stickiness bonus for whichever side
   * the previous hotspot's shot used. Turning is weighted to dominate: a
   * couple of borderline obstruction points shouldn't spin the camera
   * around, but a genuinely blocked view (many points along the whole
   * sightline, e.g. looking straight through a parallel leg of a loop)
   * outweighs even a big turn. Without the stickiness bonus a near-tie in
   * turn/obstruction cost could flip sides on consecutive hotspots for no
   * real benefit — each flip is itself a ~2×SIDE_ANGLE_DEG turn (roughly the
   * short way round, ~116°), which reads as the camera swinging/spinning
   * rather than making the simpler move of just panning within the same
   * side.
   *
   * Records the winning side onto `this._tourLastSide` for the next call's
   * stickiness bonus, and returns
   * `{ side, headingRad, camLat, camLon, obstructions, turnCost, cost }`.
   */
  _chooseTourShot(wp, backDistMeters, altitudeOffset) {
    // Always the camera's REAL, live heading (Cesium keeps this canonical,
    // never drifting) — see _shortestHeadingTo's doc for why this must not
    // be a self-tracked value carried forward from a previous step.
    const camHeading = this.viewer.camera?.heading;
    const prevHeadingRad = typeof camHeading === 'number' ? camHeading : 0;
    const latRad = (wp.lat * Math.PI) / 180.0;
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

    const candidates = [1, -1].map((side) => {
      const offsetBearingRad =
        ((wp.bearingDeg + side * SIDE_ANGLE_DEG) * Math.PI) / 180.0;
      const headingRad = this._shortestHeadingTo(
        offsetBearingRad + Math.PI, // look back across the track at the hotspot
        prevHeadingRad,
      );
      const camLat =
        wp.lat + (backDistMeters * Math.cos(offsetBearingRad)) / 111320.0;
      const camLon =
        wp.lon +
        (backDistMeters * Math.sin(offsetBearingRad)) /
          (111320.0 * Math.max(0.1, Math.cos(latRad)));
      const obstructions = this._sightlineObstructionCount(
        this.currentDrawPoints,
        wp.drawPointIndex,
        camLat,
        camLon,
        altitudeOffset,
        wp.lat,
        wp.lon,
        heightSeries,
        baseH,
        extScale,
      );
      // headingRad is already expressed as the closest representation to
      // prevHeadingRad, so the raw difference IS the turn angle.
      const turnCost = Math.abs(headingRad - prevHeadingRad);
      let cost = turnCost + OBSTRUCTION_COST_RAD * obstructions;
      if (this._tourLastSide === side) cost -= SIDE_STICKINESS_RAD;
      return { side, headingRad, camLat, camLon, obstructions, turnCost, cost };
    });

    const chosen =
      candidates[0].cost <= candidates[1].cost ? candidates[0] : candidates[1];
    this._tourLastSide = chosen.side;
    return chosen;
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

    // Flight duration scales with the great-circle hop from the previous
    // waypoint — a short jump between nearby hotspots cuts quickly, a long
    // leg across the walk gets a slower, more sweeping glide.
    let flightDuration;
    if (stepIdx === 0) {
      flightDuration = 2.6;
    } else {
      const prev = this._tourWaypoints[stepIdx - 1];
      const hopMeters = GeoUtils.haversineMeters(
        prev.lat,
        prev.lon,
        wp.lat,
        wp.lon,
      );
      flightDuration = Math.max(2.2, Math.min(6.5, 2.0 + hopMeters / 220));
    }

    // Explicitly pass gsrHeight so the blue scrub dot is elevated to sit on top of the track
    this.setScrubPosition(wp.lat, wp.lon, wp.gsrHeight);

    // Pitch: angled down (-30°) to read the ground path and the hotspot together
    const pitchDeg = -30.0;
    const pitchRad = (pitchDeg * Math.PI) / 180.0;

    // Altitude & distance: dynamically adapt to the effective track height & annotations
    const effH = wp.effectiveHeight || wp.gsrHeight || 16.0;
    const backDistMeters = Math.max(90.0, effH * 2.2 + 70.0);

    // Target look-at height centred on the vertical mid-region of the track/spires
    const targetLookAtHeight = effH * 0.45;
    const altitudeOffset =
      targetLookAtHeight + backDistMeters * Math.tan(Math.abs(pitchRad));

    // Cinematic framing: park the camera to the side of the track (see
    // _chooseTourShot for the turn/obstruction/stickiness cost model behind
    // which side gets picked) — angled down onto the hotspot so both the
    // track's approach/departure and exactly where the hotspot sits on it
    // read clearly.
    const chosen = this._chooseTourShot(wp, backDistMeters, altitudeOffset);
    const { camLat, camLon, headingRad: lookHeadingRad, turnCost } = chosen;

    // Floor the flight duration by how far the camera actually has to turn —
    // the hop-distance estimate above knows nothing about heading, so two
    // hotspots that sit close together but need a big turn between them
    // (e.g. a genuine side-swap) would otherwise get a very short flight and
    // read as a rapid spin instead of a deliberate pan.
    flightDuration = Math.max(
      flightDuration,
      turnCost / MAX_TURN_RATE_RAD_PER_SEC,
    );
    // Up/Down speed shortcuts (globe3d_view.mjs) — applied last so they scale
    // the whole flight uniformly, turn-duration floor included. Only takes
    // effect from this hop onward; Cesium can't retarget an in-flight
    // duration, so a speed change mid-flight lands on the NEXT waypoint.
    flightDuration = flightDuration / (this._autoCameraSpeed || 1.0);

    // Notify listeners (scrub sync / GSR graph pan, in sync with the flight) —
    // after flightDuration's final value so the graph tween runs the same
    // length as the camera flight even when the turn-duration floor above
    // stretched it.
    if (this._tourCallback) {
      this._tourCallback(
        stepIdx,
        this._tourWaypoints.length,
        wp,
        flightDuration,
      );
    }

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

    this.viewer.camera.flyTo({
      destination: destination,
      orientation: {
        heading: lookHeadingRad,
        pitch: pitchRad,
        roll: 0.0,
      },
      duration: flightDuration,
      complete: () => {
        if (!this._isTouring) return;
        // Pause at each waypoint (longer pause on hotspots so user can
        // observe), scaled by the same speed multiplier as the flight.
        const pauseMs =
          (wp.isPeak ? 2800 : 1500) / (this._autoCameraSpeed || 1.0);
        this._tourStepTimeout = setTimeout(() => {
          if (this._isTouring) {
            this._executeTourStep(stepIdx + 1);
          }
        }, pauseMs);
      },
      cancel: () => {
        // Pause/jump navigation cancels flights on purpose (see
        // _cancelTourFlight) — only an externally-interrupted flight (e.g.
        // the user grabs the camera) counts as the tour being stopped.
        if (this._tourManualInterrupt) return;
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
    this._isPaused = false;
    if (wasTouring && this._tourCallback) {
      this._tourCallback(null, 0, null);
    }
  },
};

Object.assign(GSRGlobeManager.prototype, __methods);
