/**
 * GSRGlobeManager — replay tour: a sped-up real-time replay of the walk.
 * Class layer for GSRGlobeManager's replay tour
 * (`GSRGlobeReplayTour extends GSRGlobeHotspotTour`). One of two tours; the
 * shared controls (stopTour, pauseTour, tourNext, …) live in globe3d/tour.mjs
 * and dispatch to this layer's _stop/_pause/_resume/_stepReplayTour while
 * `this._tourMode === 'replay'`.
 *
 * A replay clock runs through the walk at REPLAY_BASE_SPEED × real time
 * (scaled by the shared Up/Down `_autoCameraSpeed` dial). Only the part of the
 * walk the clock has reached is drawn:
 *   - the arousal wall is rebuilt with one hidden GeometryInstance per segment
 *     (see _render3DWallAndPath's `this._replay` branch, which also records
 *     `this._replaySegs`), and each segment's `show` attribute is switched on
 *     once the clock passes its end time;
 *   - the segment the clock is currently inside is drawn by a small dynamic
 *     "head" wall entity that grows smoothly from the segment start to the
 *     clock position;
 *   - peak circles/labels and hotspot stars appear once their (latency-
 *     shifted) time is reached.
 * A chase camera follows the head from behind and to one side, easing round
 * as the walk turns while keeping whatever zoom/tilt the user gives it.
 * Stopping the replay (or reaching the end) rebuilds the normal full, merged
 * wall.
 */
import { GeoUtils } from '../../gps/geo_utils.mjs';
import { GSRGlobeHotspotTour } from './hotspot_tour.mjs';

// Walk seconds replayed per real second at the default 1× auto-camera speed.
// The Up/Down shortcuts scale it 0.25×–4× (5×–80× real time).
const REPLAY_BASE_SPEED = 20;
// Matches the wall's own time-gap rule (_render3DWallAndPath): a pause or lost
// fix longer than this is skipped straight over rather than replayed as dead air.
const GAP_SKIP_S = 15.0;
// Longest real-time step one frame may take, so a backgrounded tab doesn't
// leap the replay forward on return.
const MAX_FRAME_S = 0.25;
// Chase-camera defaults; the user's own zoom/tilt replaces them once they touch
// the camera. The camera sits behind and to the right of the walker, looking
// this far left of the direction of travel: straight behind would see the
// wall edge-on and hide its height profile.
const CHASE_SIDE_DEG = -58.0;
const CHASE_RANGE_M = 260.0;
const CHASE_PITCH_DEG = -28.0;
// Travel bearing is taken over ± this many walk seconds, so GPS wobble doesn't
// swing the camera.
const BEARING_SPAN_S = 12.0;
// Exponential ease rate (1/s, real time) of the camera heading towards the
// direction of travel — ~1 s to cover most of a turn.
const HEADING_EASE_PER_S = 1.5;
// Same kind of ease (1/s, real time) for the camera's aim height. The wall's
// height follows the GSR signal sample-to-sample, so aiming straight at it
// bobs the camera up and down; this lags it by ~1.5 s instead.
const AIM_HEIGHT_EASE_PER_S = 0.7;
// The camera's ground aim point is the route averaged over a window centred on
// the replay head (triangular weights, AIM_WINDOW_SAMPLES per side), not the
// head itself: uneven GPS point spacing makes the head speed up and slow down
// point-to-point, which jerks the camera forwards and backwards. The route
// ahead is already recorded, so a centred window smooths without any lag. The
// half-width is AIM_WINDOW_REAL_S of real time at the current replay speed,
// but never under AIM_WINDOW_MIN_S of walk time.
const AIM_WINDOW_REAL_S = 0.5;
const AIM_WINDOW_MIN_S = 4.0;
const AIM_WINDOW_SAMPLES = 6;
// Left/Right hotspot jumps land this many walk seconds before the hotspot so
// its rise is seen being drawn.
const HOTSPOT_LEAD_S = 4.0;

/** Exponential ease of `from` towards `to` at `ratePerSec` over `dtSec`. */
const ease = (from, to, ratePerSec, dtSec) =>
  from + (to - from) * (1 - Math.exp(-ratePerSec * dtSec));

const nowMs = () =>
  typeof performance !== 'undefined' ? performance.now() : Date.now();

export class GSRGlobeReplayTour extends GSRGlobeHotspotTour {
  /**
   * Register a progress callback for the replay, fired every tick with
   * `{ time, lat, lon, origIdx, drawIdx }` for the replay head, and with
   * `null` once the replay stops.
   */
  onReplayTourProgress(cb) {
    this._replayCallback = typeof cb === 'function' ? cb : null;
  }

  /**
   * Toggle the replay tour. Starting it stops a running hotspot tour first,
   * so the button always ends up running this one unless it already was.
   */
  toggleReplayTour() {
    if (this._isTouring && this._tourMode === 'replay') this.stopTour();
    else this.startReplayTour();
    return this._isTouring;
  }

  /** Start the replay from the beginning of the walk. */
  startReplayTour() {
    const pts = this.currentDrawPoints;
    if (!this.viewer || !pts || pts.length < 2) return;
    if (this._isTouring) this.stopTour();
    if (this._isOrbiting) this.stopOrbit();
    this.releaseFollowScrub();

    this._isTouring = true;
    this._isPaused = false;
    this._tourMode = 'replay';
    this._replay = {
      time: pts[0].time,
      lastTickMs: null,
      // Chase camera. `target` is the last look-at point, so the user's zoom
      // can be read back as the camera's distance to it.
      target: null,
      range: CHASE_RANGE_M,
      pitch: Cesium.Math.toRadians(CHASE_PITCH_DEG),
      heading: null,
      aimHeight: null,
      // Segments [0, shown) of _replaySegs currently have show=true on
      // `wallRef`; reset when a rebuild swaps the wall primitive.
      shown: 0,
      wallRef: null,
      headSeg: null,
      headFrac: 0,
    };

    // Rebuild in replay mode: per-segment hidden wall, no ground path, and
    // markers hidden until reached (_rebuildLayers applies the reveal).
    this._rebuildLayers();
    this._addReplayHead();

    this._holdContinuousRender();
    this._replayRemoveTick = this.viewer.clock.onTick.addEventListener(() =>
      this._replayTick(nowMs()),
    );
  }

  /** Stop the replay and put the normal full track back (via stopTour). */
  _stopReplayTour() {
    const wasRunning = Boolean(this._replay);
    this._isTouring = false;
    this._isPaused = false;
    this._tourMode = null;
    if (!wasRunning) return;

    this._replay = null;
    this._replaySegs = [];
    if (this._replayRemoveTick) {
      this._replayRemoveTick();
      this._replayRemoveTick = null;
    }
    if (this.viewer) {
      if (this._replayHeadEntity) {
        this.viewer.entities.remove(this._replayHeadEntity);
      }
      this.viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
      this._releaseContinuousRender();
      if (this.currentAnalyzer && this.currentDrawPoints?.length >= 2) {
        this._rebuildLayers();
      }
    }
    this._replayHeadEntity = null;
    if (this._replayCallback) this._replayCallback(null);
  }

  /** Freeze the replay clock; the camera stays free to look around. */
  _pauseReplayTour() {
    this._isPaused = true;
  }

  _resumeReplayTour() {
    this._isPaused = false;
  }

  /**
   * Jump the clock to just before the next (`delta` > 0) or previous hotspot,
   * implicitly un-pausing. Past the last one Next is a no-op; before the
   * first, Previous goes back to the start of the walk.
   */
  _stepReplayTour(delta) {
    const r = this._replay;
    if (!r) return;
    const times = this._replayHotspotTimes();
    let t;
    if (delta > 0) {
      t = times.find((h) => h > r.time + 0.5);
    } else {
      const earlier = times.filter((h) => h < r.time - 1.0);
      t = earlier.length
        ? earlier[earlier.length - 1]
        : this.currentDrawPoints[0].time;
    }
    if (t === undefined) return;
    r.time = t;
    this._isPaused = false;
    this._applyReplayReveal();
  }

  /**
   * Hotspot jump targets (walk seconds), ascending: each curated hotspot's
   * latency-shifted time, less HOTSPOT_LEAD_S. Falls back to plain peaks when
   * the walk has no hotspots.
   */
  _replayHotspotTimes() {
    const hotspots = this._tourHotspots();
    const events = hotspots.length ? hotspots : this.currentPeaks || [];
    const start = this.currentDrawPoints[0].time;
    const latency = this.peakLatency || 0;
    return events
      .filter((pk) => pk && !pk.excluded && typeof pk.time === 'number')
      .map((pk) => Math.max(start, pk.time + latency - HOTSPOT_LEAD_S))
      .sort((x, y) => x - y);
  }

  /**
   * One replay frame: advance the clock (unless paused or the wall is still
   * compiling), skip time gaps, reveal, move the camera, report progress.
   */
  _replayTick(tickMs) {
    const r = this._replay;
    const pts = this.currentDrawPoints;
    if (!r || !this.viewer || !pts || pts.length < 2) return;
    const dt =
      r.lastTickMs == null
        ? 0
        : Math.min(MAX_FRAME_S, (tickMs - r.lastTickMs) / 1000);
    r.lastTickMs = tickMs;

    const wallReady = !this.wallPrimitive || this.wallPrimitive.ready;
    if (!this._isPaused && wallReady) {
      r.time += dt * this._replaySpeed();
      r.time = this._skipReplayGap(r.time);
    }

    if (r.time >= pts[pts.length - 1].time) {
      this.stopTour();
      this.flyToTrack(false);
      return;
    }

    this._applyReplayReveal();
    const head = this._replayHeadPoint(r.time);
    if (!this._isPaused) this._updateReplayCamera(head, dt);
    if (this._replayCallback) this._replayCallback(head);
  }

  /** Walk seconds replayed per real second right now. */
  _replaySpeed() {
    return REPLAY_BASE_SPEED * (this._autoCameraSpeed || 1.0);
  }

  // ── Replay clock → track position ────────────────────────────────────────

  /** Index of the last drawn point at or before `time` (binary search). */
  _drawIndexAtTime(time) {
    const pts = this.currentDrawPoints;
    let lo = 0;
    let hi = pts.length - 1;
    if (time <= pts[0].time) return 0;
    if (time >= pts[hi].time) return hi;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (pts[mid].time <= time) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  /** Jump over a >GAP_SKIP_S pause/lost-fix gap to the next recorded point. */
  _skipReplayGap(time) {
    const pts = this.currentDrawPoints;
    const i = this._drawIndexAtTime(time);
    const next = pts[i + 1];
    if (next && next.time - pts[i].time > GAP_SKIP_S) return next.time;
    return time;
  }

  /**
   * Full-resolution replay head at `time`: position interpolated between the
   * two surrounding drawn points, plus the origIdx of the one at/before it
   * (for the graph cursor).
   */
  _replayHeadPoint(time) {
    const pts = this.currentDrawPoints;
    const i = this._drawIndexAtTime(time);
    const p = pts[i];
    const q = pts[i + 1];
    let f = 0;
    if (q && q.time > p.time && q.time - p.time <= GAP_SKIP_S) {
      f = Math.min(1, Math.max(0, (time - p.time) / (q.time - p.time)));
    }
    return {
      time,
      lat: q ? p.lat + (q.lat - p.lat) * f : p.lat,
      lon: q ? p.lon + (q.lon - p.lon) * f : p.lon,
      origIdx: p.origIdx,
      drawIdx: i,
    };
  }

  // ── Reveal: wall segments, growing head, markers ─────────────────────────

  /**
   * Bring the wall segments' and markers' visibility in line with the replay
   * clock. Called every tick, on a seek, and by _rebuildLayers after a
   * mid-replay rebuild.
   */
  _applyReplayReveal() {
    const r = this._replay;
    if (!r) return;
    this._revealReplaySegments(r);
    this._locateReplayHeadSegment(r);
    this._applyReplayMarkers(r.time);
  }

  /**
   * Switch wall segments on/off so exactly those ending by the clock show.
   * Walks `r.shown` forwards or backwards from where it was, so a normal
   * frame touches only the segment(s) just passed, and a seek backwards hides
   * what's now in the future. Waits (shows nothing) while the primitive is
   * still compiling.
   */
  _revealReplaySegments(r) {
    const segs = this._replaySegs || [];
    const prim = this.wallPrimitive;
    if (prim !== r.wallRef) {
      r.wallRef = prim;
      r.shown = 0;
    }
    if (
      !prim?.ready ||
      typeof prim.getGeometryInstanceAttributes !== 'function'
    )
      return;
    const setShow = (seg, v) => {
      const attrs = prim.getGeometryInstanceAttributes(seg.id);
      if (attrs) attrs.show = Cesium.ShowGeometryInstanceAttribute.toValue(v);
    };
    while (r.shown < segs.length && segs[r.shown].t1 <= r.time) {
      setShow(segs[r.shown], true);
      r.shown++;
    }
    while (r.shown > 0 && segs[r.shown - 1].t1 > r.time) {
      r.shown--;
      setShow(segs[r.shown], false);
    }
  }

  /**
   * The head segment: the first one not yet fully passed, if the clock has
   * actually entered it (it may be sitting in a gap before it). Sets
   * `r.headSeg` / `r.headFrac` for the head wall entity.
   */
  _locateReplayHeadSegment(r) {
    const segs = this._replaySegs || [];
    let lo = 0;
    let hi = segs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (segs[mid].t1 <= r.time) lo = mid + 1;
      else hi = mid;
    }
    const seg = segs[lo];
    if (seg && seg.t0 <= r.time && seg.t1 > seg.t0) {
      r.headSeg = seg;
      r.headFrac = (r.time - seg.t0) / (seg.t1 - seg.t0);
    } else {
      r.headSeg = null;
      r.headFrac = 0;
    }
  }

  /**
   * Show a peak circle / label / latency connector / hotspot star only once
   * the replay reaches its (latency-shifted) time. Every marker carries its
   * analyzer.peaks index — directly or in its pick `id` — see
   * globe3d/peaks.mjs.
   */
  _applyReplayMarkers(t) {
    const peaks = this.currentAnalyzer?.peaks || [];
    const latency = this.peakLatency || 0;
    const apply = (o) => {
      if (!o) return;
      const idx = o._biomapPeakIndex ?? o.id?._biomapPeakIndex;
      const pk = peaks[idx];
      if (!pk || typeof pk.time !== 'number') return;
      const v = pk.time + latency <= t;
      if (o.show !== v) o.show = v;
    };
    (this.peakEntities || []).forEach(apply);
    (this.hotspotEntities || []).forEach(apply);
    const labels = this._peakLabels;
    if (labels && typeof labels.get === 'function') {
      for (let i = 0; i < labels.length; i++) apply(labels.get(i));
    }
  }

  /**
   * The growing tip of the wall: one dynamic two-point wall entity spanning
   * the current head segment from its start to the clock position, in that
   * segment's colour. Kept outside trackEntities so a mid-replay rebuild
   * doesn't remove it.
   */
  _addReplayHead() {
    if (!this.viewer?.entities) return;
    const positions = () => {
      const r = this._replay;
      const s = r?.headSeg;
      if (!s || r.headFrac <= 0) return undefined;
      const lat = s.a.lat + (s.b.lat - s.a.lat) * r.headFrac;
      const lon = s.a.lon + (s.b.lon - s.a.lon) * r.headFrac;
      // Too short to form a wall — WallGeometry drops coincident points.
      if (GeoUtils.haversineMeters(s.a.lat, s.a.lon, lat, lon) < 0.3)
        return undefined;
      return Cesium.Cartesian3.fromDegreesArray([s.a.lon, s.a.lat, lon, lat]);
    };
    const heights = () => {
      const r = this._replay;
      const s = r?.headSeg;
      if (!s) return [0, 0];
      return [s.h1, s.h1 + (s.h2 - s.h1) * r.headFrac];
    };
    const color = () =>
      this._replay?.headSeg?.color || Cesium.Color.TRANSPARENT;
    this._replayHeadEntity = this.viewer.entities.add({
      name: 'Biomap Replay Head',
      wall: {
        positions: new Cesium.CallbackProperty(positions, false),
        maximumHeights: new Cesium.CallbackProperty(heights, false),
        minimumHeights: [0, 0],
        material: new Cesium.ColorMaterialProperty(
          new Cesium.CallbackProperty(color, false),
        ),
      },
    });
  }

  // ── Chase camera ─────────────────────────────────────────────────────────

  /**
   * Chase camera: look at the (smoothed) replay head from behind and to one
   * side (CHASE_SIDE_DEG), heading eased round as the walk turns. The range
   * and pitch are read back from the camera each frame, so a wheel-zoom or
   * tilt by the user sticks; a heading drag is gently steered back.
   */
  _updateReplayCamera(head, dtSec) {
    const r = this._replay;
    const camera = this.viewer.camera;
    this._readBackUserCamera(r, camera);

    // Aim at the wall's mid-height so its top and base both stay in frame,
    // eased so the camera doesn't bounce with the GSR.
    const aimHeight = this._getPointHeight(head.origIdx) * 0.5;
    r.aimHeight =
      r.aimHeight == null
        ? aimHeight
        : ease(r.aimHeight, aimHeight, AIM_HEIGHT_EASE_PER_S, dtSec);

    const want = this._chaseHeadingAt(head.time);
    if (r.heading == null) {
      r.heading = want ?? 0;
    } else if (want != null) {
      const target = this._shortestHeadingTo(want, r.heading);
      r.heading = ease(r.heading, target, HEADING_EASE_PER_S, dtSec);
    }

    const ground = this._replayAimPoint(head.time);
    r.target = Cesium.Cartesian3.fromDegrees(
      ground.lon,
      ground.lat,
      r.aimHeight,
    );
    camera.lookAt(
      r.target,
      new Cesium.HeadingPitchRange(r.heading, r.pitch, r.range),
    );
  }

  /**
   * Adopt whatever the user did to the camera since the last frame: its
   * distance to the last target (wheel-zoom), its pitch (tilt, clamped to
   * [-89°, -10°]) and its heading (drag). No-op on the first frame.
   */
  _readBackUserCamera(r, camera) {
    if (!r.target) return;
    const d = Cesium.Cartesian3.distance(camera.positionWC, r.target);
    if (typeof d === 'number' && isFinite(d) && d > 20) r.range = d;
    if (typeof camera.pitch === 'number' && isFinite(camera.pitch)) {
      r.pitch = Math.min(
        Cesium.Math.toRadians(-10),
        Math.max(Cesium.Math.toRadians(-89), camera.pitch),
      );
    }
    if (typeof camera.heading === 'number' && isFinite(camera.heading))
      r.heading = camera.heading;
  }

  /**
   * The chase heading (radians) at replay `time`: the direction of travel over
   * ±BEARING_SPAN_S, turned CHASE_SIDE_DEG. Null when the walker is standing
   * still over that span.
   */
  _chaseHeadingAt(time) {
    const pts = this.currentDrawPoints;
    const back = pts[this._drawIndexAtTime(time - BEARING_SPAN_S)];
    const ahead = pts[this._drawIndexAtTime(time + BEARING_SPAN_S)];
    if (!back || !ahead || (back.lat === ahead.lat && back.lon === ahead.lon))
      return null;
    const bearing = GeoUtils.bearingDeg(
      back.lat,
      back.lon,
      ahead.lat,
      ahead.lon,
    );
    return Cesium.Math.toRadians(bearing + CHASE_SIDE_DEG);
  }

  /**
   * Smoothed ground aim point for the chase camera at replay `time`: the
   * route averaged over a centred, triangular-weighted window (see
   * AIM_WINDOW_REAL_S).
   */
  _replayAimPoint(time) {
    const half = Math.max(
      AIM_WINDOW_MIN_S,
      AIM_WINDOW_REAL_S * this._replaySpeed(),
    );
    let lat = 0;
    let lon = 0;
    let wSum = 0;
    for (let k = -AIM_WINDOW_SAMPLES; k <= AIM_WINDOW_SAMPLES; k++) {
      const f = k / (AIM_WINDOW_SAMPLES + 1);
      const w = 1 - Math.abs(f);
      const p = this._replayHeadPoint(time + f * half);
      lat += w * p.lat;
      lon += w * p.lon;
      wSum += w;
    }
    return { lat: lat / wSum, lon: lon / wSum };
  }
}
