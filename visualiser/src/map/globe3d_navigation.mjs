/**
 * GSRGlobeManager — camera fly-to/focus + turntable orbit.
 * Prototype-augment split from globe3d.js: loaded after globe3d.js, adds
 * these methods to GSRGlobeManager.prototype.
 *
 * flyToPeak/focusOnPeakLocation read _latencyCoords/_peakWallHeight from
 * globe3d_peaks.js (resolved via the shared prototype at call time — file
 * load order between augment files doesn't matter here, only that they all
 * load after globe3d.js itself).

 * Assigned onto GSRGlobeManager.prototype via Object.assign at the file's
 * tail (a plain ESM static import/export, loaded once by app_entry.mjs).
 */
import { AppState } from '../core/app_state.mjs';
import { GSRGlobeManager } from './globe3d.mjs';

export const __methods = {
  /**
   * Fly camera to focus on a specific peak index.
   * @param {number} peakIdx  index into analyzer.peaks
   * @param {GSRAnalyzer} [analyzer]  analyzer reference (defaults to AppState.analyzer)
   */
  flyToPeak(peakIdx, analyzer) {
    if (!this.viewer || typeof Cesium === 'undefined') return;
    const a =
      analyzer || (typeof AppState !== 'undefined' ? AppState.analyzer : null);
    if (!a || !a.peaks || peakIdx < 0 || peakIdx >= a.peaks.length) return;

    const peak = a.peaks[peakIdx];
    const coords = this._latencyCoords(a, peak);
    if (!coords || isNaN(coords.lat) || isNaN(coords.lon)) return;

    this.releaseFollowScrub();
    this.stopTour();
    if (this._isOrbiting) this.stopOrbit();
    this._wakeRenderLoop();

    const lat = coords.lat;
    const lon = coords.lon;
    const wallHeight = this._peakWallHeight(a, peak);

    // Center on the 3D spire position
    const targetPos = Cesium.Cartesian3.fromDegrees(lon, lat, wallHeight + 3.0);
    const boundingSphere = new Cesium.BoundingSphere(targetPos, 25.0);

    const heading = this.viewer.camera.heading;
    const pitch = Cesium.Math.toRadians(-35.0);
    const range = Math.max(120.0, wallHeight * 1.5 + 80.0);
    const offset = new Cesium.HeadingPitchRange(heading, pitch, range);

    this.viewer.camera.flyToBoundingSphere(boundingSphere, {
      offset: offset,
      duration: 1.2,
    });
  },

  /**
   * Park the scrub dot at a peak's position and fly to it, with no popup. The
   * 3D counterpart of GSRMapManager.focusOnPeakLocation, driven by the SCR
   * Events table. Reuses the graph-scrub marker as the single "you are here"
   * indicator, so it shows even when the peak spires are hidden (the next graph
   * hover repositions it).
   * @param {number} peakIdx  index into analyzer.peaks
   * @param {GSRAnalyzer} [analyzer]  analyzer reference (defaults to AppState.analyzer)
   */
  focusOnPeakLocation(peakIdx, analyzer) {
    if (!this.viewer || typeof Cesium === 'undefined') return;
    const a =
      analyzer || (typeof AppState !== 'undefined' ? AppState.analyzer : null);
    if (!a || !a.peaks || peakIdx < 0 || peakIdx >= a.peaks.length) return;

    const peak = a.peaks[peakIdx];
    const coords = this._latencyCoords(a, peak);
    if (!coords || isNaN(coords.lat) || isNaN(coords.lon)) return;

    // Restore a peak circle hidden by a previous focus call.
    if (this._focusHiddenPeakPoint) {
      this._focusHiddenPeakPoint.show = true;
      this._focusHiddenPeakPoint = null;
    }

    // Hide THIS peak's own red circle while the locator dot marks it — two
    // coincident Cesium points can't be made to reliably draw one-over-the-
    // other (a sub-metre altitude nudge is sub-pixel at fly-to range and the
    // depth-sort tie still lets the red circle bleed through as a ring). The
    // next full re-render (clearPeakEntities) brings every circle back; a
    // later focus restores this one explicitly via _focusHiddenPeakPoint.
    if (Array.isArray(this.peakEntities)) {
      for (const ent of this.peakEntities) {
        if (!ent || ent._biomapPeakIndex !== peakIdx) continue;
        // The circle is either the batched PointPrimitive itself or, in the
        // entity fallback, the beacon entity's point graphic. A latency-
        // connector entity shares the same _biomapPeakIndex but is the rose
        // line, not the circle (no point graphic) — skip it.
        const pt = ent._isPeakPointPrimitive
          ? ent
          : ent.point && !ent.polyline
            ? ent.point
            : null;
        if (!pt) continue;
        pt.show = false;
        this._focusHiddenPeakPoint = pt;
        break;
      }
    }

    // Sit the dot on the exact peak-beacon position — _renderPeakSpires uses
    // wallHeight + 3.0 (ellipsoid-relative, no terrain add), whereas
    // setScrubPosition() adds the terrain altitude on top, which floated the
    // dot well above the circle over any non-flat ground.
    if (this.scrubEntity) {
      const wallHeight = this._peakWallHeight(a, peak);
      this.scrubEntity.position = Cesium.Cartesian3.fromDegrees(
        coords.lon,
        coords.lat,
        wallHeight + 3.0,
      );
      this.scrubEntity.show = true;
    }
    this.flyToPeak(peakIdx, a);
  },

  /**
   * Fly camera to encompass and perfectly center the entire active track.
   * Releases any active follow-cam lookAt transform first — flyToBoundingSphere
   * and a live lookAt fight each other and neither wins cleanly.
   */
  flyToTrack(stopTour = true) {
    if (!this.viewer || this.currentDrawPoints.length === 0) return;
    if (stopTour) this.stopTour();
    // Drop the graph-scrub follow-cam before flying — a live lookAt transform
    // competes with flyToBoundingSphere and prevents the flight from landing.
    this.releaseFollowScrub();
    this._wakeRenderLoop();

    // Convert track points to 3D Cartesian positions
    const positions = this.currentDrawPoints.map((p) =>
      Cesium.Cartesian3.fromDegrees(p.lon, p.lat),
    );

    // Compute exact 3D bounding sphere encompassing the walk
    const boundingSphere = Cesium.BoundingSphere.fromPoints(positions);

    // Isometric 45-degree pitch, looking North, with radius-proportional range
    const pitch = Cesium.Math.toRadians(-45.0);
    const heading = Cesium.Math.toRadians(0.0);
    const range = Math.max(boundingSphere.radius * 2.2, 450.0);

    const offset = new Cesium.HeadingPitchRange(heading, pitch, range);

    this.viewer.camera.flyToBoundingSphere(boundingSphere, {
      offset: offset,
      duration: 1.5,
    });
  },

  /**
   * Toggle 360-degree turntable orbit around track center
   */
  toggleOrbit() {
    if (this._isOrbiting) {
      this.stopOrbit();
    } else {
      this.startOrbit();
    }
    return this._isOrbiting;
  },

  startOrbit() {
    if (!this.viewer || this.currentDrawPoints.length === 0 || this._isOrbiting)
      return;
    this.stopTour();

    // Render the spin a little softer so it stays smooth on slower GPUs;
    // stopOrbit() puts it back. See _orbitResolutionScale.
    this.viewer.resolutionScale = this._orbitResolutionScale;

    const coords = this.currentDrawPoints.map((p) =>
      Cesium.Cartographic.fromDegrees(p.lon, p.lat),
    );
    const rectangle = Cesium.Rectangle.fromCartographicArray(coords);
    const centerCartographic = Cesium.Rectangle.center(rectangle);
    const center = Cesium.Cartographic.toCartesian(centerCartographic);

    const distance =
      Cesium.Cartesian3.distance(
        center,
        Cesium.Cartographic.toCartesian(Cesium.Rectangle.northwest(rectangle)),
      ) * 2.5;

    let heading = this.viewer.camera.heading;
    const pitch = Cesium.Math.toRadians(-35.0);

    const orbitStep = () => {
      heading += 0.003;
      this.viewer.camera.lookAt(
        center,
        new Cesium.HeadingPitchRange(heading, pitch, Math.max(distance, 300)),
      );
    };

    // Continuous rendering for the duration of the orbit — render-on-demand
    // (requestRenderMode) makes a per-tick camera animation visibly steppy.
    // Cancel any pending idle-retire so the smoothness bridge can't flip the
    // scene back to on-demand mid-orbit.
    if (this._idleRenderTimer) {
      clearTimeout(this._idleRenderTimer);
      this._idleRenderTimer = null;
    }
    this.viewer.scene.requestRenderMode = false;
    this._orbitRemoveCallback =
      this.viewer.clock.onTick.addEventListener(orbitStep);
    this._isOrbiting = true;
  },

  stopOrbit() {
    if (!this._isOrbiting) return;
    if (this._orbitRemoveCallback) {
      this._orbitRemoveCallback();
      this._orbitRemoveCallback = null;
    }
    this.viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    this._isOrbiting = false;
    if (this.viewer) {
      // Back to render-on-demand (no-op when this host runs continuously anyway)
      // and back to the normal render resolution.
      this.viewer.scene.requestRenderMode = this.requestRenderMode;
      this.viewer.resolutionScale = this._resolutionScale;
    }
  },
};

Object.assign(GSRGlobeManager.prototype, __methods);
