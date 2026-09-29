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
 * So while zooming:
 *  - the rounding remainder is carried by a fractional map-pane position
 *    (making Leaflet's rounding a no-op);
 *  - tile levels and markers skip their rounding (see patchLeaflet), and
 *    latLngToLayerPoint returns exact positions for tooltips and overlays;
 *  - the container carries ZOOMING_CLASS, under which styles.css gives
 *    markers, tooltips and popups their own GPU layer. Exact positions alone
 *    aren't enough: the browser still snaps text (hotspot stars, labels) to
 *    whole pixels on every repaint unless the element has a layer of its own.
 * When the zoom settles, the pane snaps back to whole pixels once.
 *
 * Canvas-drawn layers (vector paths and circles, the RF overlay) are drawn at
 * rest and then only stretched mid-zoom, until they redraw when it settles.
 * Any sub-pixel error in the drawing or in where the stretch starts from is
 * multiplied by the zoom's scale (~3 px after three levels), and the redraw
 * snaps it back: a visible jump just as the map comes to rest. So on these
 * maps they draw from exact points (exactLayerPoint, and the vector patches
 * in patchLeaflet); DOM markers still round at rest so their text stays crisp.
 *
 * Anything else that moves the map ends a zoom still gliding first, so the two
 * never fight over the map's position: a new view, flyTo, the zoom buttons or
 * a pinch (all go through map._stop), a pan, a resize or a popup auto-pan
 * (panBy / _rawPanBy), and pressing on the map to drag or click.
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

/** Class on the map container while a zoom glides (see styles.css). */
export const ZOOMING_CLASS = 'leaflet-smooth-zooming';

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
// Map methods that move it without the handler's involvement. Each one ends a
// gliding zoom before it runs.
const INTERRUPTING_METHODS = ['_stop', 'panBy', '_rawPanBy'];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Wheel travel in pixels. Raw deltas rather than L.DomEvent.getWheelDelta,
// which divides by a platform/devicePixelRatio fudge factor (3–6x smaller on
// a Mac).
function wheelPixels(e, map) {
  if (e.deltaMode === 1) return e.deltaY * LINE_PX;
  if (e.deltaMode === 2) return e.deltaY * map.getSize().y;
  return e.deltaY;
}

const smoothMaps = new WeakSet(); // maps with this handler
const zoomingMaps = new WeakSet(); // …of those, the ones gliding right now

/** True while a wheel/trackpad zoom on `map` is still moving. */
export function isWheelZooming(map) {
  return zoomingMaps.has(map);
}

// latLngToLayerPoint without Leaflet's rounding.
function exactLatLngToLayerPoint(latlng) {
  return this.project(L.latLng(latlng))._subtract(this.getPixelOrigin());
}

/**
 * Layer point of `latlng` for drawing into a canvas: exact on a smooth-zoom
 * map (see the canvas note at the top), Leaflet's rounded one elsewhere.
 */
export function exactLayerPoint(map, latlng) {
  return smoothMaps.has(map)
    ? exactLatLngToLayerPoint.call(map, latlng)
    : map.latLngToLayerPoint(latlng);
}

// Run `fn` with map.latLngToLayerPoint exact, for Leaflet code that calls it
// directly. Mid-zoom it already is (see start()).
function withExactLayerPoints(map, fn) {
  if (!smoothMaps.has(map) || Object.hasOwn(map, 'latLngToLayerPoint')) {
    return fn();
  }
  map.latLngToLayerPoint = exactLatLngToLayerPoint;
  try {
    return fn();
  } finally {
    delete map.latLngToLayerPoint;
  }
}

let leafletPatched = false;

/**
 * Leaflet-wide changes. None alters a map at rest, and only the last touches
 * maps without this handler (it corrects Leaflet's own zoom animation too):
 *  - markers and tile levels skip their whole-pixel rounding, which would
 *    otherwise shake them against the exact vector canvas mid-zoom (a marker's
 *    latLngToLayerPoint is only exact mid-zoom, so it is still whole at rest;
 *    a tile level's translate only picks up a fraction when it is stretched
 *    between zoom levels, where the tiles are resampled anyway);
 *  - vector paths and circles project to exact points (see the canvas note);
 *  - the vector canvas is stretched from the corner it was actually drawn
 *    at. Leaflet works that out from the map centre remembered at draw time,
 *    which can sit up to half a pixel off the rounded origin the drawing used.
 */
function patchLeaflet() {
  if (leafletPatched || !L.GridLayer) return;
  leafletPatched = true;
  for (const Layer of [L.Polyline, L.CircleMarker, L.Circle]) {
    const project = Layer.prototype._project;
    Layer.include({
      _project() {
        return withExactLayerPoints(this._map, () => project.call(this));
      },
    });
  }
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
  const rendererUpdate = L.Renderer.prototype._update;
  L.Renderer.include({
    _update() {
      rendererUpdate.call(this);
      // World pixel (at this._zoom) of the canvas's top-left corner.
      this._drawnTopLeft = this._bounds.min.add(this._map.getPixelOrigin());
    },
    _updateTransform(center, zoom) {
      const scale = this._map.getZoomScale(zoom, this._zoom);
      const offset = this._drawnTopLeft
        .multiplyBy(scale)
        .subtract(this._map._getNewPixelOrigin(center, zoom));
      L.DomUtil.setTransform(this._container, offset, scale);
    },
  });
}

export function enableSmoothWheelZoom(map) {
  patchLeaflet();
  smoothMaps.add(map);
  const container = map.getContainer();
  let targetZoom = null; // null when no zoom is gliding
  let anchor = null; // container point under the cursor…
  let anchorLatLng = null; // …and the map position pinned to it
  let lastTime = 0;
  let frame = null;

  // Move to `zoom` with anchorLatLng exactly under `anchor`. Solving from the
  // pinned lat/lng each frame (rather than nudging the previous centre) keeps
  // errors from piling up.
  function glideTo(zoom) {
    const halfSize = map.getSize().divideBy(2);
    const centerPx = map
      .project(anchorLatLng, zoom)
      .subtract(anchor.subtract(halfSize));
    // Offset the pane by the fraction that makes the pixel origin _move
    // computes come out whole, so its rounding shifts nothing. (Which whole
    // pixel the pane sits near doesn't matter: the origin moves with it.)
    const base = L.DomUtil.getPosition(map._mapPane).round();
    const rawOrigin = centerPx.subtract(halfSize).add(base);
    L.DomUtil.setPosition(
      map._mapPane,
      base.add(rawOrigin.round().subtract(rawOrigin)),
    );
    map._move(map.unproject(centerPx, zoom), zoom);
  }

  // Put the pane back on whole pixels, keeping the pixel origin (and so every
  // layer position) as it is: the picture moves by under half a pixel. Keeps
  // whatever view the map has, so an interrupting pan isn't undone.
  function snapToPixels() {
    const panePos = L.DomUtil.getPosition(map._mapPane).round();
    L.DomUtil.setPosition(map._mapPane, panePos);
    const centerPx = map
      .getPixelOrigin()
      .add(map.getSize().divideBy(2))
      .subtract(panePos);
    map._move(map.unproject(centerPx));
    // _move only fires 'zoom' when the zoom changed; the snap keeps the zoom,
    // so fire it ourselves or tiles and markers stay on the fractional spot.
    map.fire('zoom');
  }

  function start() {
    map._stop(); // cancel any flyTo or pan animation
    targetZoom = map.getZoom();
    zoomingMaps.add(map);
    container.classList.add(ZOOMING_CLASS);
    // Exact for the length of the zoom, so markers, tooltips and overlays
    // glide too.
    map.latLngToLayerPoint = exactLatLngToLayerPoint;
    anchor = null;
    map._moveStart(true, false);
    lastTime = performance.now() - FRAME_MS;
    frame = requestAnimationFrame(step);
  }

  function finish() {
    if (targetZoom === null) return;
    cancelAnimationFrame(frame);
    frame = null;
    targetZoom = null;
    zoomingMaps.delete(map);
    container.classList.remove(ZOOMING_CLASS);
    delete map.latLngToLayerPoint; // back to Leaflet's rounded version
    snapToPixels();
    map._moveEnd(true);
  }

  function step(now) {
    const zoom = map.getZoom();
    const diff = targetZoom - zoom;
    if (Math.abs(diff) < SETTLE_EPSILON) {
      glideTo(targetZoom);
      finish();
      return;
    }
    const dt = clamp(now - lastTime, 0, 4 * FRAME_MS);
    lastTime = now;
    const ease = 1 - (1 - EASE) ** (dt / FRAME_MS);
    glideTo(zoom + diff * ease);
    frame = requestAnimationFrame(step);
  }

  function onWheel(e) {
    e.preventDefault();
    // Leave the map alone while Leaflet animates a zoom or the user drags it.
    if (map._animatingZoom || map.dragging?.moving()) return;
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

  for (const name of INTERRUPTING_METHODS) {
    const leafletMethod = map[name];
    map[name] = function (...args) {
      finish();
      return leafletMethod.apply(this, args);
    };
  }

  // Capture phase, so the zoom has settled before Leaflet's drag handler
  // records where the map starts from.
  const capture = { capture: true };
  container.addEventListener('wheel', onWheel, { passive: false });
  container.addEventListener('pointerdown', finish, capture);
  map.on('unload', () => {
    finish();
    container.removeEventListener('wheel', onWheel);
    container.removeEventListener('pointerdown', finish, capture);
    for (const name of INTERRUPTING_METHODS) delete map[name];
    smoothMaps.delete(map);
  });
}
