/**
 * GSRMapMarkers — shared peak / hotspot map-marker geometry and icons.
 *
 * The single-track 2D map, the collective map and the Live view's
 * follow-map all draw peak dots and hotspot stars from this one definition,
 * so they can't drift apart. Hotspot stars are CSS-styled
 * (.hotspot-star / .hotspot-glow-ring in styles.css).
 *
 * Plain peaks are drawn on the map's canvas rather than as DOM markers. A
 * walk has hundreds of them (a collective view, many hundreds), and a DOM
 * marker is restyled and repainted by the browser on every frame of a zoom,
 * which alone made zooming stutter on phones. On the canvas they are redrawn
 * once when the zoom settles and simply stretched with it in between.
 *
 * `L` (Leaflet) is passed in explicitly rather than read from a global, so
 * the app pages and the tests' hand-rolled mocks call the same code with
 * whatever L they have.
 */

// The plain peak dot, matching the DOM dot it replaced: 6 px across including
// a 1 px white ring (fill radius 2, ring to 3), 75% opaque, --color-peak.
const PEAK_DOT_STYLE = {
  radius: 2.5,
  weight: 1,
  color: '#ffffff',
  opacity: 0.75,
  fillOpacity: 0.75,
};
const PEAK_COLOR_FALLBACK = '#d10024';
// Extra pixels around a dot that still count as tapping it — the DOM marker
// it replaced was a 24 px box.
const PEAK_DOT_TAP_SLOP_PX = 9;
// Opacity multiplier for an excluded peak.
const EXCLUDED_OPACITY = 0.35;

let peakColor = null;
const onTopCanvasClasses = new WeakMap(); // L -> class, built on first use
const peakDotClasses = new WeakMap();

// A canvas that keeps layers flagged `onTop` (peak dots) above every other
// shape, whatever order they were added in. Leaflet both draws and hit-tests a
// canvas in one list order (last = on top), and the path is re-added on every
// recolour, so without this it would bury the dots and take their taps.
function onTopCanvasClass(L) {
  let OnTopCanvas = onTopCanvasClasses.get(L);
  if (OnTopCanvas) return OnTopCanvas;
  OnTopCanvas = L.Canvas.extend({
    _initPath(layer) {
      L.Canvas.prototype._initPath.call(this, layer); // appended at the end
      const order = layer._order;
      if (layer.options.onTop) {
        this._firstOnTop = this._firstOnTop || order;
        return;
      }
      const top = this._firstOnTop;
      if (!top) return;
      // Move it from the end to just before the first on-top layer.
      this._drawLast = order.prev;
      order.prev.next = null;
      order.prev = top.prev;
      order.next = top;
      if (top.prev) top.prev.next = order;
      else this._drawFirst = order;
      top.prev = order;
    },
    _removePath(layer) {
      if (layer._order === this._firstOnTop) {
        this._firstOnTop = layer._order.next; // the next one is on top too
      }
      L.Canvas.prototype._removePath.call(this, layer);
    },
  });
  onTopCanvasClasses.set(L, OnTopCanvas);
  return OnTopCanvas;
}

function peakDotClass(L) {
  let PeakDot = peakDotClasses.get(L);
  if (PeakDot) return PeakDot;
  PeakDot = L.CircleMarker.extend({
    options: { ...PEAK_DOT_STYLE, onTop: true },
    isPeakDot: true,
    _clickTolerance() {
      return (
        L.CircleMarker.prototype._clickTolerance.call(this) +
        PEAK_DOT_TAP_SLOP_PX
      );
    },
  });
  peakDotClasses.set(L, PeakDot);
  return PeakDot;
}

function resolvePeakColor() {
  if (peakColor) return peakColor;
  try {
    peakColor =
      getComputedStyle(document.documentElement)
        .getPropertyValue('--color-peak')
        .trim() || PEAK_COLOR_FALLBACK;
  } catch (_e) {
    peakColor = PEAK_COLOR_FALLBACK;
  }
  return peakColor;
}

export const GSRMapMarkers = {
  /**
   * The canvas renderer to build a map with (Leaflet's `renderer` option), so
   * peak dots stay on top of the path and shapes. Undefined when this L has
   * no canvas (test mocks), which leaves Leaflet's default.
   */
  createMapRenderer(L) {
    return L.Canvas ? new (onTopCanvasClass(L))() : undefined;
  },

  /**
   * An unlabelled, non-hotspot peak: a small quality-neutral --color-peak
   * dot on the map's canvas, no per-track colour, no animation (hotspots are
   * the visually dominant layer). Takes popups, tooltips and click handlers
   * like any Leaflet layer.
   */
  buildPeakDot(L, latlng) {
    return new (peakDotClass(L))(latlng, {
      fillColor: resolvePeakColor(),
    });
  },

  /** True for a layer made by buildPeakDot. */
  isPeakDot(layer) {
    return layer?.isPeakDot === true;
  },

  /** Fade an excluded peak — a canvas dot or a DOM (labelled) marker. */
  dimPeakMarker(marker) {
    if (typeof marker.setOpacity === 'function') {
      marker.setOpacity(EXCLUDED_OPACITY);
    } else {
      marker.setStyle({
        opacity: PEAK_DOT_STYLE.opacity * EXCLUDED_OPACITY,
        fillOpacity: PEAK_DOT_STYLE.fillOpacity * EXCLUDED_OPACITY,
      });
    }
  },

  /**
   * SVG for a peak dot in an export: the dot's outer edge (fill + ring) as
   * the radius, and the dimming as opacity — the same output the DOM dot's
   * export gave.
   */
  peakDotSvg(dot, cx, cy) {
    const o = dot.options;
    const opacity =
      Math.round((o.fillOpacity / PEAK_DOT_STYLE.fillOpacity) * 1000) / 1000;
    return (
      `<circle cx="${cx}" cy="${cy}" r="${o.radius + o.weight / 2}"` +
      ` fill="${o.fillColor}" stroke="${o.color}"` +
      ` stroke-width="${o.weight * 0.5}" opacity="${opacity}" />`
    );
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
