/**
 * Smooth, continuous scroll-wheel / trackpad zoom for a Leaflet map.
 *
 * Leaflet's built-in scrollWheelZoom collects wheel events for a short pause,
 * then animates one discrete jump, and drops any scrolling that arrives while
 * that jump is still animating — so zooming feels like stepping. This handler
 * instead keeps a target zoom that every wheel event nudges, and eases the map
 * towards it on each animation frame, keeping the point under the cursor fixed.
 *
 * It drives the map the same way flyTo() does (_moveStart → per-frame _move →
 * _moveEnd), so tiles, vector layers, markers and image overlays follow via
 * the 'zoom'/'move' events, and zoomend/moveend fire once when the zoom settles
 * rather than on every step. Layers that only re-anchor on 'zoomanim' need a
 * 'zoom' listener as well (see RFFluidRenderer._bindEvents).
 *
 * Sub-pixel positioning: Leaflet rounds the map's pixel origin, and each tile
 * level's offset, to whole CSS pixels. At rest that keeps tiles crisp, but
 * mid-zoom it shakes the whole picture by up to half a pixel in a random
 * direction every frame — most visible on a Retina screen, and in the slow
 * tail of the ease where the real per-frame motion is smaller than the noise.
 * So while zooming, the rounding remainder is carried by a fractional map-pane
 * position (making Leaflet's rounding a no-op), tile levels and markers skip
 * their rounding (see patchLeafletRounding), latLngToLayerPoint returns exact
 * positions for tooltips and overlays, and the pane snaps back to whole pixels
 * once, when the zoom settles. Exact positions alone don't stop text jitter:
 * the browser still snaps a marker's text (hotspot stars, labels) to whole
 * pixels on each repaint. So the container also carries ZOOMING_CLASS, under
 * which styles.css gives markers and tooltips their own GPU layer
 * (will-change: transform), which the browser moves between pixels.
 *
 * Anything else that moves the map (a pan, flyTo, fitBounds, the zoom buttons,
 * a drag) goes through map._stop(), which here also ends a zoom still gliding,
 * so the two never fight over the map's position.
 *
 * Build the map with SMOOTH_ZOOM_MAP_OPTIONS spread into its options, then call
 * enableSmoothWheelZoom(map).
 */

/**
 * Leaflet map options the handler needs: the built-in wheel zoom off (it would
 * fight this one), and no zoomSnap — with one, the next pan or setView would
 * round the free zoom level and jump.
 */
export const SMOOTH_ZOOM_MAP_OPTIONS = Object.freeze({
  scrollWheelZoom: false,
  zoomSnap: 0,
});

// Zoom levels per pixel of wheel travel. A trackpad pinch arrives as a wheel
// event with ctrlKey set and small deltas, so it gets a faster rate.
const WHEEL_RATE = 1 / 300;
const PINCH_RATE = 1 / 100;
// deltaMode 1 = lines, 2 = pages (e.g. Firefox with some mice); 0 = pixels.
const LINE_PX = 16;
// Largest zoom change a single wheel event can request (tames fast mouse wheels).
const MAX_STEP = 1;
// Fraction of the remaining distance covered per 60 Hz frame (higher =
// snappier); scaled by the real frame time so 120 Hz screens ease the same.
const EASE = 0.25;
const FRAME_MS = 1000 / 60;
const SETTLE_EPSILON = 0.001;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Wheel travel in pixels. Raw deltas rather than L.DomEvent.getWheelDelta,
// which divides by a platform/devicePixelRatio fudge factor (3–6x smaller on
// a Mac).
function wheelPixels(e, map) {
  if (e.deltaMode === 1) return e.deltaY * LINE_PX;
  if (e.deltaMode === 2) return e.deltaY * map.getSize().y;
  return e.deltaY;
}

// On the map container while a zoom glides — see the sub-pixel note above.
export const ZOOMING_CLASS = 'leaflet-smooth-zooming';

const zoomingMaps = new WeakSet();

/** True while a wheel/trackpad zoom on `map` is still moving. */
export function isWheelZooming(map) {
  return zoomingMaps.has(map);
}

let roundingPatched = false;

/**
 * Drop Leaflet's own whole-pixel rounding of tile levels and markers, which
 * would otherwise shake them against the (unrounded) vector canvas mid-zoom.
 * Neither changes the picture at rest: a marker's position from
 * latLngToLayerPoint is already whole there, and a tile level's translate only
 * picks up a fraction when it is scaled (stretched between zoom levels), where
 * the tiles are resampled anyway.
 */
function patchLeafletRounding() {
  if (roundingPatched || !L.GridLayer) return;
  roundingPatched = true;
  L.Marker.include({
    update() {
      if (this._icon && this._map) {
        this._setPos(this._map.latLngToLayerPoint(this._latlng));
      }
      return this;
    },
  });
  L.GridLayer.include({
    _setZoomTransform(level, center, zoom) {
      const scale = this._map.getZoomScale(zoom, level.zoom);
      const translate = level.origin
        .multiplyBy(scale)
        .subtract(this._map._getNewPixelOrigin(center, zoom));
      L.DomUtil.setTransform(level.el, translate, scale);
    },
  });
}

// latLngToLayerPoint without Leaflet's rounding, installed on the map only for
// the length of a zoom so markers, tooltips and overlays glide too.
function exactLatLngToLayerPoint(latlng) {
  return this.project(L.latLng(latlng))._subtract(this.getPixelOrigin());
}

export function enableSmoothWheelZoom(map) {
  patchLeafletRounding();
  const container = map.getContainer();
  let targetZoom = null;
  let anchor = null; // container point under the cursor…
  let anchorLatLng = null; // …and the map position pinned to it
  let basePanePos = null; // whole-pixel map-pane position at gesture start
  let lastTime = 0;
  let frame = null;

  // Move to `zoom` with anchorLatLng exactly under `anchor`. Solving from the
  // pinned lat/lng each frame (rather than nudging the previous centre) keeps
  // errors from piling up. With `snap`, the pane goes back to whole pixels.
  function moveTo(zoom, snap) {
    const halfSize = map.getSize().divideBy(2);
    const centerPx = map
      .project(anchorLatLng, zoom)
      .subtract(anchor.subtract(halfSize));
    let panePos = basePanePos;
    if (!snap) {
      // Pick the pane offset that makes the pixel origin _move computes come
      // out whole, so its rounding shifts nothing.
      const rawOrigin = centerPx.subtract(halfSize).add(basePanePos);
      panePos = basePanePos.add(rawOrigin.round().subtract(rawOrigin));
    }
    L.DomUtil.setPosition(map._mapPane, panePos);
    map._move(map.unproject(centerPx, zoom), zoom);
    // _move only fires 'zoom' when the zoom changed; the snap keeps the zoom,
    // so fire it ourselves or tiles and markers stay on the fractional spot.
    if (snap) map.fire('zoom');
  }

  function finish() {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    targetZoom = null;
    zoomingMaps.delete(map);
    container.classList.remove(ZOOMING_CLASS);
    delete map.latLngToLayerPoint; // back to Leaflet's rounded version
    moveTo(map.getZoom(), true);
    map._moveEnd(true);
  }

  // Leaflet calls _stop() before any other movement; end our zoom first.
  const leafletStop = map._stop;
  map._stop = function () {
    if (targetZoom !== null) finish();
    return leafletStop.call(this);
  };

  function step(now) {
    const zoom = map.getZoom();
    const diff = targetZoom - zoom;
    if (Math.abs(diff) < SETTLE_EPSILON) {
      moveTo(targetZoom, false);
      finish();
      return;
    }
    const dt = Math.max(0, Math.min(now - lastTime, 4 * FRAME_MS));
    lastTime = now;
    const ease = 1 - (1 - EASE) ** (dt / FRAME_MS);
    moveTo(zoom + diff * ease, false);
    frame = requestAnimationFrame(step);
  }

  // Begin a new gesture: cancel any flyTo/pan, announce the zoom, start easing.
  function start() {
    map._stop();
    targetZoom = map.getZoom();
    zoomingMaps.add(map);
    container.classList.add(ZOOMING_CLASS);
    map.latLngToLayerPoint = exactLatLngToLayerPoint;
    basePanePos = L.DomUtil.getPosition(map._mapPane).round();
    anchor = null;
    map._moveStart(true, false);
    lastTime = performance.now() - FRAME_MS;
    frame = requestAnimationFrame(step);
  }

  function onWheel(e) {
    e.preventDefault();
    const delta = -wheelPixels(e, map);
    if (!delta) return;
    if (targetZoom === null) start();

    // Re-pin only when the cursor has really moved, so a steady scroll keeps
    // one fixed point rather than re-reading it every event.
    const point = map.mouseEventToContainerPoint(e);
    if (!anchor || point.distanceTo(anchor) > 1) {
      anchor = point;
      anchorLatLng = map.containerPointToLatLng(anchor);
    }
    const rate = e.ctrlKey ? PINCH_RATE : WHEEL_RATE;
    targetZoom = clamp(
      targetZoom + clamp(delta * rate, -MAX_STEP, MAX_STEP),
      map.getMinZoom(),
      map.getMaxZoom(),
    );
  }

  container.addEventListener('wheel', onWheel, { passive: false });
}
