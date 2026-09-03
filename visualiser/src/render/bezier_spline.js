/**
 * Pure, coordinate-system-agnostic point-to-Bézier curve fitting. Operates on
 * plain {x,y} point arrays (typically already-projected pixel coordinates) —
 * no SVG string building, no DOM, no lat/lon assumptions.
 */
const BezierSpline = {
  /**
   * Centripetal Catmull-Rom spline, converted to cubic Bézier segments.
   *
   * Knot spacing is parameterised by distance^0.5 (centripetal) rather than
   * uniform spacing — uniform Catmull-Rom assumes evenly-spaced points, which
   * traced/smoothed contour paths never are, and it overshoots/loops exactly
   * where spacing is uneven. Centripetal parameterisation is the standard fix
   * and is well-behaved even on pathological point sets.
   *
   * @param {Array<{x:number,y:number}>} points
   * @param {boolean} [closed=false] - whether the path is a closed loop.
   *   Only meaningful when `points` explicitly duplicates the closing vertex
   *   (points[0] === points[n-1]); otherwise treated as open regardless.
   * @returns {{start:{x,y}, segments:Array<{c1:{x,y}, c2:{x,y}, end:{x,y}}>}}
   */
  catmullRomToBezier(points, closed = false) {
    const n = points ? points.length : 0;
    if (n === 0) return { start: { x: 0, y: 0 }, segments: [] };
    if (n === 1) return { start: points[0], segments: [] };

    const isDuplicateClosed = closed && n >= 3 &&
      Math.abs(points[0].x - points[n - 1].x) < 1e-6 && Math.abs(points[0].y - points[n - 1].y) < 1e-6;
    const m = isDuplicateClosed ? n - 1 : n;

    const start = points[0];
    const segments = [];
    const EPS = 1e-6;

    for (let i = 0; i < n - 1; i++) {
      const pPrev = isDuplicateClosed ? points[(i - 1 + m) % m] : points[Math.max(0, i - 1)];
      const pCurr = points[i];
      const pNext = points[i + 1];
      const pFut  = isDuplicateClosed ? points[(i + 2) % m] : points[Math.min(n - 1, i + 2)];

      const t01 = Math.max(EPS, Math.hypot(pCurr.x - pPrev.x, pCurr.y - pPrev.y) ** 0.5);
      const t12 = Math.max(EPS, Math.hypot(pNext.x - pCurr.x, pNext.y - pCurr.y) ** 0.5);
      const t23 = Math.max(EPS, Math.hypot(pFut.x - pNext.x, pFut.y - pNext.y) ** 0.5);
      const t0 = 0, t1 = t01, t2 = t01 + t12, t3 = t01 + t12 + t23;

      const m1x = (t2 - t1) * ((pCurr.x - pPrev.x) / (t1 - t0) - (pNext.x - pPrev.x) / (t2 - t0) + (pNext.x - pCurr.x) / (t2 - t1));
      const m1y = (t2 - t1) * ((pCurr.y - pPrev.y) / (t1 - t0) - (pNext.y - pPrev.y) / (t2 - t0) + (pNext.y - pCurr.y) / (t2 - t1));
      const m2x = (t2 - t1) * ((pNext.x - pCurr.x) / (t2 - t1) - (pFut.x - pCurr.x) / (t3 - t1) + (pFut.x - pNext.x) / (t3 - t2));
      const m2y = (t2 - t1) * ((pNext.y - pCurr.y) / (t2 - t1) - (pFut.y - pCurr.y) / (t3 - t1) + (pFut.y - pNext.y) / (t3 - t2));

      segments.push({
        c1: { x: pCurr.x + m1x / 3, y: pCurr.y + m1y / 3 },
        c2: { x: pNext.x - m2x / 3, y: pNext.y - m2y / 3 },
        end: { x: pNext.x, y: pNext.y }
      });
    }

    return { start, segments };
  },

  /**
   * Uniform cubic B-spline, converted to cubic Bézier segments. Only produces
   * a meaningful (non-degenerate) curve for closed rings with >= 3 points —
   * returns an empty segment list otherwise, since the shared safety property
   * below depends on wraparound.
   *
   * Every segment's Bézier hull is a weighted average (not interpolation) of
   * 4 consecutive points, with weights that sum to 1 and are never negative —
   * so the curve is mathematically confined to that hull. Unlike an
   * interpolating spline (Catmull-Rom), it cannot overshoot past a
   * neighbouring contour level's line, and it cannot degenerate into a
   * straight through-line when a ring has only a few points left.
   *
   * @param {Array<{x:number,y:number}>} points
   * @param {boolean} [closed=false]
   * @returns {{start:{x,y}, segments:Array<{c1:{x,y}, c2:{x,y}, end:{x,y}}>}}
   */
  bsplineToBezier(points, closed = false) {
    const n = points ? points.length : 0;
    if (n === 0) return { start: { x: 0, y: 0 }, segments: [] };

    const isDuplicateClosed = closed && n >= 3 &&
      Math.abs(points[0].x - points[n - 1].x) < 1e-6 && Math.abs(points[0].y - points[n - 1].y) < 1e-6;
    const m = isDuplicateClosed ? n - 1 : n;
    if (!isDuplicateClosed || m < 3) return { start: points[0], segments: [] };

    const P = i => points[((i % m) + m) % m];
    const seg = i => {
      const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
      return {
        start: { x: (p0.x + 4 * p1.x + p2.x) / 6, y: (p0.y + 4 * p1.y + p2.y) / 6 },
        c1: { x: (2 * p1.x + p2.x) / 3, y: (2 * p1.y + p2.y) / 3 },
        c2: { x: (p1.x + 2 * p2.x) / 3, y: (p1.y + 2 * p2.y) / 3 },
        end: { x: (p1.x + 4 * p2.x + p3.x) / 6, y: (p1.y + 4 * p2.y + p3.y) / 6 }
      };
    };

    const first = seg(0);
    const segments = [];
    for (let i = 0; i < m; i++) {
      const s = seg(i);
      segments.push({ c1: s.c1, c2: s.c2, end: s.end });
    }

    return { start: first.start, segments };
  },

  /**
   * Fit cubic Bézier spline curve(s) to points and format as an SVG path data string (`d`).
   *
   * @param {Array<{x:number, y:number}>} points - Screen/pixel coordinates.
   * @param {object} [options]
   * @param {'catmull-rom'|'bspline'|'none'} [options.curveMode='catmull-rom'] - Spline interpolation mode.
   * @param {boolean} [options.closed=false] - Whether to close the path (with 'Z').
   * @param {number} [options.precision=3] - Floating-point coordinate decimal places.
   * @returns {string} SVG path `d` attribute string.
   */
  fitPathD(points, { curveMode = 'catmull-rom', closed = false, precision = 3 } = {}) {
    if (!points || points.length === 0) return '';
    const prec = precision;
    if (points.length === 1) return `M${points[0].x.toFixed(prec)} ${points[0].y.toFixed(prec)}`;
    if (curveMode === 'none' || points.length === 2) {
      let d = `M${points[0].x.toFixed(prec)} ${points[0].y.toFixed(prec)}`;
      for (let i = 1; i < points.length; i++) {
        d += ` L${points[i].x.toFixed(prec)} ${points[i].y.toFixed(prec)}`;
      }
      return closed ? d + ' Z' : d;
    }

    let fit = null;
    if (curveMode === 'bspline') {
      fit = BezierSpline.bsplineToBezier(points, closed);
      if (fit.segments.length === 0) fit = null;
    }
    if (!fit) fit = BezierSpline.catmullRomToBezier(points, closed);

    let d = `M${fit.start.x.toFixed(prec)} ${fit.start.y.toFixed(prec)}`;
    for (let i = 0; i < fit.segments.length; i++) {
      const s = fit.segments[i];
      d += ` C${s.c1.x.toFixed(prec)} ${s.c1.y.toFixed(prec)}, ${s.c2.x.toFixed(prec)} ${s.c2.y.toFixed(prec)}, ${s.end.x.toFixed(prec)} ${s.end.y.toFixed(prec)}`;
    }
    return closed ? d + ' Z' : d;
  }
};

if (typeof window !== 'undefined') window.BezierSpline = BezierSpline;
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { BezierSpline };
}
