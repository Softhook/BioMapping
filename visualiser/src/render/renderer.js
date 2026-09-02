/**
 * Graphics Rendering & Drawing Utilities (p5.js Canvas View).
 * All shared state accessed through AppState.
 */

/**
 * Get peak quality color hex based on quality score.
 * High (≥0.7) → green #008f3c, Medium (≥0.4) → amber #e59e00, Low → red #d10024.
 * If alphaSuffix is provided (e.g. '20'), appends it for RGBA-style hex.
 */
function getQualityColor(score, alphaSuffix) {
  const base = score >= 0.7 ? '#008f3c' : (score >= 0.4 ? '#e59e00' : '#d10024');
  return alphaSuffix ? base + alphaSuffix : base;
}

/**
 * Get peak quality label string ('High', 'Med', 'Low') and percent.
 */
function getQualityLabel(score) {
  const pct = Math.round(score * 100);
  const label = score >= 0.7 ? 'High' : (score >= 0.4 ? 'Med' : 'Low');
  return { pct, label };
}

// Excluded-peak visual style constants
const EXCLUDED_STYLE = {
  color:     '#9a9a9a',
  lineColor: '#b0b0b0',
  lineAlpha: '3c',
  fillAlpha: '1a',
  dash:      [2, 4],
  weight:    1.2,
  dotWeight: 1.5
};

const NORMAL_DASH = [3, 3];

const EXCLUDE_BTN = {
  r: 5,              // button radius
  offsetY: -8,       // Y offset from yBottomU (bottom of upper graph)
  symbol: '\u2715'   // ✕ character
};

const GSRRenderer = {
  _styleCache: null,

  /**
   * Helper to retrieve CSS variable values from document stylesheet.
   * Caches styles locally during a drawing pass to avoid heavy DOM reads.
   */
  getThemeColor(varName, defaultVal) {
    if (!this._styleCache) {
      this._styleCache = window.getComputedStyle(document.documentElement);
    }
    const val = this._styleCache.getPropertyValue(varName).trim();
    return val || defaultVal;
  },

  /**
   * Clear style cache to force DOM re-evaluation (e.g. on window resize).
   */
  clearThemeCache() {
    this._styleCache = null;
  },

  drawPlaceholder() {
    const bg = this.getThemeColor('--canvas-bg', '#ffffff');
    background(bg);
    this.clearPulseRings();
  },

  /**
   * @param {boolean} [singleGraph] - When true there is only one plot region
   *   spanning MARGIN.top..yUpperBottom (yLowerBottom is ignored); time labels
   *   sit just below the plot instead of in the inter-graph gap.
   */
  drawGridX(tMin, tMax, yUpperBottom, yLowerBottom, singleGraph) {
    const span = tMax - tMin;
    let step = 10;
    if (span < 5) step = 0.5;
    else if (span < 15) step = 1;
    else if (span < 30) step = 5;
    else if (span < 120) step = 10;
    else if (span < 300) step = 30;
    else if (span < 900) step = 60;
    else if (span < 1800) step = 300;
    else if (span < 3600) step = 600;
    else if (span < 7200) step = 1200;
    else step = 1800;

    const firstGridTime = Math.floor(tMin / step) * step;

    const gridColor = this.getThemeColor('--canvas-grid', 'rgba(17, 17, 17, 0.06)');
    const textColor = this.getThemeColor('--canvas-text', '#444444');
    const axisColor = this.getThemeColor('--canvas-axis', 'rgba(17, 17, 17, 0.15)');

    stroke(gridColor);
    strokeWeight(1);
    textAlign(CENTER, CENTER);
    textSize(10);

    for (let t = firstGridTime; t <= tMax; t += step) {
      if (t < tMin) continue;
      const x = map(t, tMin, tMax, GSR_CONST.MARGIN.left, width - GSR_CONST.MARGIN.right);
      line(x, GSR_CONST.MARGIN.top, x, yUpperBottom);
      if (!singleGraph) line(x, yUpperBottom + GSR_CONST.MARGIN.gap, x, yLowerBottom);

      // Time label: in the gap between the two graphs, or just below the single plot
      fill(textColor);
      noStroke();

      let label = t.toFixed(t % 1 !== 0 ? 1 : 0) + 's';
      if (t >= 3600) {
        const h = Math.floor(t / 3600);
        const m = Math.floor((t % 3600) / 60);
        const s = Math.floor(t % 60);
        label = h + ':' + (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
      } else if (t >= 60) {
        const m = Math.floor(t / 60);
        const s = Math.floor(t % 60);
        label = m + ':' + (s < 10 ? '0' : '') + s;
      }
      text(label, x, singleGraph ? yUpperBottom + 10 : yUpperBottom + GSR_CONST.MARGIN.gap / 2);
      stroke(gridColor);
    }

    stroke(axisColor);
    line(GSR_CONST.MARGIN.left, GSR_CONST.MARGIN.top, GSR_CONST.MARGIN.left, yUpperBottom);
    line(GSR_CONST.MARGIN.left, yUpperBottom, width - GSR_CONST.MARGIN.right, yUpperBottom);
    if (!singleGraph) {
      line(GSR_CONST.MARGIN.left, yUpperBottom + GSR_CONST.MARGIN.gap, GSR_CONST.MARGIN.left, yLowerBottom);
      line(GSR_CONST.MARGIN.left, yLowerBottom, width - GSR_CONST.MARGIN.right, yLowerBottom);
    }
  },

  /**
   * Draw horizontal grid lines with labels for a Y-axis region.
   * @param {number} yMin - Data minimum
   * @param {number} yMax - Data maximum
   * @param {number} yBottom - Bottom pixel position of the drawing region
   * @param {number} yTop - Top pixel position of the drawing region
   * @param {Array<Array<number>>} stepRanges - [[spanThreshold, stepSize], ...] sorted ascending
   * @param {number} defaultStep - Step to use when span exceeds all thresholds
   * @param {number} decimals - Number of decimal places in value labels
   */
  drawGridY(yMin, yMax, yBottom, yTop, stepRanges, defaultStep, decimals, unitSuffix) {
    const unit = unitSuffix !== undefined ? unitSuffix : ' \u03bcS';
    const span = yMax - yMin;
    let step = defaultStep;
    for (const [threshold, s] of stepRanges) {
      if (span < threshold) { step = s; break; }
    }

    const firstGridVal = Math.floor(yMin / step) * step;

    const gridColor = this.getThemeColor('--canvas-grid', 'rgba(17, 17, 17, 0.06)');
    const textColor = this.getThemeColor('--canvas-text', '#444444');

    stroke(gridColor);
    textAlign(RIGHT, CENTER);
    textSize(10);

    const labelHeight = 14;
    let lastLabelY = null;

    for (let val = firstGridVal; val <= yMax; val += step) {
      if (val < yMin) continue;
      const y = map(val, yMin, yMax, yBottom, yTop);
      line(GSR_CONST.MARGIN.left, y, width - GSR_CONST.MARGIN.right, y);

      if (lastLabelY !== null && Math.abs(y - lastLabelY) < labelHeight) continue;

      noStroke();
      fill(textColor);
      text(val.toFixed(decimals) + unit, GSR_CONST.MARGIN.left - 8, y);
      stroke(gridColor);
      lastLabelY = y;
    }
  },

  /**
   * Compute common context for curve drawing: clamped indices, step, spline decision, and scale factors.
   *
   * @param {Array<number>} [forceIndices] - Indices that must always be drawn
   *   as their own vertex, regardless of the uniform decimation stride. Used
   *   so peak markers never sit above/beside a decimated straight-line
   *   segment that "cuts the corner" past their true value — confirmed this
   *   was happening in practice once deconvolution mode started reporting
   *   many more, closer-together peaks (see _detectPeaksFromCurve() in
   *   analyzer.js): at a typical full-track zoom, the curve draws roughly
   *   one vertex every 2.5s while peaks can legitimately be 1s apart, so
   *   ~96% of peak markers landed between drawn vertices even though every
   *   one of them is an exact local maximum of the underlying data.
   */
  _buildCurveContext(data, tMin, tMax, yMin, yMax, yTop, yBottom, forceIndices) {
    const startIdx = Math.max(0, AppState.analyzer.findClosestIndex(tMin) - 1);
    const endIdx   = Math.min(data.length - 1, AppState.analyzer.findClosestIndex(tMax) + 1);
    const count = endIdx - startIdx + 1;
    if (count <= 0) return null;

    const step = Math.max(1, Math.ceil(count / GSR_CONST.DRAW_MAX_VERTICES));
    const useSpline = count < GSR_CONST.SPLINE_THRESHOLD;

    const tSpan = tMax - tMin;
    const xSpan = (width - GSR_CONST.MARGIN.right) - GSR_CONST.MARGIN.left;
    const yScale = (yMax - yMin) > 0 ? ((yTop - yBottom) / (yMax - yMin)) : 0;
    const xScale = tSpan > 0 ? (xSpan / tSpan) : 0;

    // Build the actual index sequence to draw: the uniform stride, plus any
    // forced indices merged in and de-duplicated, kept in ascending order.
    // Skipped entirely (falls back to the plain stride below) when no forced
    // indices are given or none fall in the visible range, so curves drawn
    // without peaks (raw/tonic/etc.) do exactly the same work as before.
    let indices = null;
    if (forceIndices && forceIndices.length > 0) {
      const forced = [];
      for (const idx of forceIndices) {
        if (idx >= startIdx && idx <= endIdx) forced.push(idx);
      }
      if (forced.length > 0) {
        const merged = new Set();
        for (let i = startIdx; i <= endIdx; i += step) merged.add(i);
        merged.add(endIdx);
        for (const idx of forced) merged.add(idx);
        indices = Array.from(merged).sort((a, b) => a - b);
      }
    }

    return { startIdx, endIdx, count, step, useSpline, xScale, yScale, indices };
  },

  _drawVertices(ctx, data, tMin, yMin, yBottom, useCurveVertex) {
    const drawIndices = ctx.indices || null;
    const vertexFn = useCurveVertex ? curveVertex : vertex;

    if (drawIndices) {
      for (const i of drawIndices) {
        const d = data[i];
        const x = GSR_CONST.MARGIN.left + (d.time - tMin) * ctx.xScale;
        const y = yBottom + (d.val - yMin) * ctx.yScale;
        vertexFn(x, y);
      }
    } else {
      for (let i = ctx.startIdx; i <= ctx.endIdx; i += ctx.step) {
        const d = data[i];
        const x = GSR_CONST.MARGIN.left + (d.time - tMin) * ctx.xScale;
        const y = yBottom + (d.val - yMin) * ctx.yScale;
        vertexFn(x, y);
      }
    }
  },

  _drawPeakShadedRegion(p, tMin, scales, yBottomL, yMinL, fillColor, xOnset, xPeak) {
    fill(fillColor);
    noStroke();
    beginShape();
    vertex(xOnset, yBottomL);
    for (let i = p.onsetIndex; i <= p.index; i++) {
      const xVal = GSR_CONST.MARGIN.left + (AppState.analyzer.phasic[i].time - tMin) * scales.xScale;
      const yVal = yBottomL + (AppState.analyzer.phasic[i].val - yMinL) * scales.yScaleL;
      vertex(xVal, yVal);
    }
    vertex(xPeak, yBottomL);
    endShape(CLOSE);
  },

  /**
   * Draw a line/curve from data points with optional spline smoothing.
   * @param {Array<number>} [forceIndices] - See _buildCurveContext().
   */
  drawSignalCurve(data, tMin, tMax, yMin, yMax, yTop, yBottom, lineColor, lineWt, forceIndices) {
    if (!data || data.length === 0) return;
    const ctx = this._buildCurveContext(data, tMin, tMax, yMin, yMax, yTop, yBottom, forceIndices);
    if (!ctx) return;
    const drawIndices = ctx.indices || null;

    noFill();
    stroke(lineColor);
    strokeWeight(lineWt);

    beginShape();
    if (ctx.useSpline) {
      const dFirst = data[ctx.startIdx];
      const xFirst = GSR_CONST.MARGIN.left + (dFirst.time - tMin) * ctx.xScale;
      const yFirst = yBottom + (dFirst.val - yMin) * ctx.yScale;
      curveVertex(xFirst, yFirst);
      this._drawVertices(ctx, data, tMin, yMin, yBottom, true);
      const dLast = data[ctx.endIdx];
      const xLast = GSR_CONST.MARGIN.left + (dLast.time - tMin) * ctx.xScale;
      const yLast = yBottom + (dLast.val - yMin) * ctx.yScale;
      curveVertex(xLast, yLast);
    } else {
      this._drawVertices(ctx, data, tMin, yMin, yBottom, false);
    }
    endShape();
  },

  /**
   * Draw a filled area from data points, closed to the baseline (yBottom).
   * `fillColorHex` defaults to the phasic theme color for backward compatibility
   * with existing call sites; pass an explicit hex to draw other lower-graph
   * metrics (peak density, phasic AUC, arousal index) in their own color.
   */
  /**
   * @param {Array<number>} [forceIndices] - See _buildCurveContext().
   */
  drawPhasicArea(data, tMin, tMax, yMin, yMax, yTop, yBottom, fillColorHex, forceIndices) {
    if (!data || data.length === 0) return;
    const ctx = this._buildCurveContext(data, tMin, tMax, yMin, yMax, yTop, yBottom, forceIndices);
    if (!ctx) return;
    const drawIndices = ctx.indices || null;

    noStroke();
    const fillHex = fillColorHex || this.getThemeColor('--color-phasic', '#008f3c');
    fill(color(fillHex + '19'));

    const dFirst = data[ctx.startIdx];
    const xStart = GSR_CONST.MARGIN.left + (dFirst.time - tMin) * ctx.xScale;

    beginShape();
    vertex(xStart, yBottom);

    if (ctx.useSpline) {
      curveVertex(xStart, yBottom);
      this._drawVertices(ctx, data, tMin, yMin, yBottom, true);
      const xEnd = GSR_CONST.MARGIN.left + (data[ctx.endIdx].time - tMin) * ctx.xScale;
      curveVertex(xEnd, yBottom);
      vertex(xEnd, yBottom);
    } else {
      this._drawVertices(ctx, data, tMin, yMin, yBottom, false);
      const xEnd = GSR_CONST.MARGIN.left + (data[ctx.endIdx].time - tMin) * ctx.xScale;
      vertex(xEnd, yBottom);
    }

    endShape(CLOSE);
  },

  /**
   * Pixel-per-unit scale factors shared by drawPeakMarkers()/drawHotspotMarkers()
   * (and their _computePeakScreenPos() calls) — pulled out since both methods
   * computed byte-identical xScale/yScaleU/yScaleL formulas independently
   * before, with no structural guarantee they'd stay in sync if one changed.
   * @private
   */
  _computeGraphScales(tMin, tMax, yMinU, yMaxU, yTopU, yBottomU, yMinL, yMaxL, yTopL, yBottomL) {
    const tSpan = tMax - tMin;
    const xSpan = (width - GSR_CONST.MARGIN.right) - GSR_CONST.MARGIN.left;
    return {
      xScale:  tSpan > 0 ? (xSpan / tSpan) : 0,
      yScaleU: (yMaxU - yMinU) > 0 ? ((yTopU - yBottomU) / (yMaxU - yMinU)) : 0,
      yScaleL: (yMaxL - yMinL) > 0 ? ((yTopL - yBottomL) / (yMaxL - yMinL)) : 0
    };
  },

  /**
   * True when a peak's onset-through-recovery span falls entirely outside
   * [tMin, tMax] and can be skipped without drawing. Shared visibility check
   * for drawPeakMarkers()/drawHotspotMarkers().
   * @private
   */
  _peakOutOfView(p, tMin, tMax) {
    if (p.onsetTime > tMax) return true;
    if (p.time < tMin && p.onsetTime < tMin &&
        (p.recoveryIndex === -1 || p.recoveryIndex === undefined ||
         !AppState.analyzer.phasic || !AppState.analyzer.phasic[p.recoveryIndex] ||
         AppState.analyzer.phasic[p.recoveryIndex].time < tMin)) {
      return true;
    }
    return false;
  },

  /**
   * Screen-space position of a peak's apex/onset on both panels. Shared by
   * drawPeakMarkers()/drawHotspotMarkers() — both plot the same underlying
   * peak object (a hotspot IS a peak, see drawHotspotMarkers()'s doc comment)
   * at the same coordinates, just with different styling on top.
   * @private
   */
  _computePeakScreenPos(p, tMin, scales, yMinU, yBottomU, yMinL, yBottomL, showLowerMarker, showUpperMarker, markerSeries) {
    const xPeak  = GSR_CONST.MARGIN.left + (p.time - tMin) * scales.xScale;
    const xOnset = GSR_CONST.MARGIN.left + (p.onsetTime - tMin) * scales.xScale;
    // The "upper" marker normally sits on the Filtered curve; in a metric view
    // it sits on whatever series is plotted (markerSeries), at the peak's time —
    // the peak's µS amplitude has no meaning on a /min or z axis.
    const upperSeries = (markerSeries && markerSeries[p.index]) ? markerSeries : AppState.analyzer.filtered;
    let yFilteredPeak = yBottomU + (upperSeries[p.index].val - yMinU) * scales.yScaleU;
    const yPhasicPeak   = showLowerMarker ? yBottomL + (p.value - yMinL) * scales.yScaleL : yFilteredPeak;
    const yPhasicOnset  = showLowerMarker ? yBottomL + (p.onsetValue - yMinL) * scales.yScaleL : yFilteredPeak;
    // Single metric view (Phasic): no Filtered curve is drawn, so collapse the
    // upper marker onto the lower one — its dot/label/connector are suppressed
    // by the showUpperMarker guards below, this just keeps click/hit math sane.
    if (showUpperMarker === false) yFilteredPeak = yPhasicPeak;
    return { xPeak, xOnset, yFilteredPeak, yPhasicPeak, yPhasicOnset };
  },

  /**
   * `showLowerMarker` (default true) controls whether the phasic-scaled
   * lower-graph half of each peak marker (shaded region, onset/peak dots,
   * connecting line) is drawn. Those elements are positioned using yMinL/yMaxL,
   * which is only a phasic scale when the lower graph is actually showing
   * Phasic — pass false when it's showing Peak Density / Phasic AUC / Arousal
   * Index instead, so peaks keep appearing on the upper (Filtered) curve
   * without being mis-plotted against the wrong axis below.
   *
   * Deliberately minor/understated in its resting state — small, visibly
   * quality-colored dots (filled, not invisible) but with no onset marker or
   * connector line until hovered or active. This is the full NS-SCR census
   * (every detected peak, now genuinely one-per-distinguishable-event since
   * the chain-merge consolidation bug was fixed), which on a busy real
   * recording can mean hundreds to low thousands of markers — full-strength
   * styling (shaded region + connector + large solid dot) at that density
   * reads as noise, not signal, so only the dot itself stays always-visible.
   * drawHotspotMarkers() carries the bold, high-contrast styling this method
   * used to have, applied instead to the much smaller, curated
   * memorableEvents subset, so visual "loudness" on the graph now tracks
   * salience rather than raw detection count.
   */
  drawPeakMarkers(tMin, tMax, yMinU, yMaxU, yTopU, yBottomU, yMinL, yMaxL, yTopL, yBottomL, showLowerMarker, showUpperMarker, markerSeries) {
    if (showLowerMarker === undefined) showLowerMarker = true;
    // showUpperMarker (default true) draws the marker on the Filtered/upper
    // curve. Pass false in the single Phasic view, where the lower (phasic)
    // marker is the only one and there is no Filtered curve to sit on.
    // markerSeries (optional) overrides which series the upper marker sits on —
    // used by the Tonic / Peak Density / AUC / Arousal views to drop the marker
    // onto that curve at the peak's time.
    const drawUpper = showUpperMarker !== false;

    // Reset before the guards below so a skipped pass (peaks toggle off) still
    // clears stale targets, and drawHotspotMarkers() appends to a clean list.
    AppState._peakExcludeButtons = [];
    AppState._peakClickTargets = [];

    if (!AppState.showPeaks || !AppState.analyzer.peaks || AppState.analyzer.peaks.length === 0) return;

    const scales = this._computeGraphScales(tMin, tMax, yMinU, yMaxU, yTopU, yBottomU, yMinL, yMaxL, yTopL, yBottomL);

    for (let pIdx = 0; pIdx < AppState.analyzer.peaks.length; pIdx++) {
      const p = AppState.analyzer.peaks[pIdx];

      if (this._peakOutOfView(p, tMin, tMax)) continue;

      const { xPeak, xOnset, yFilteredPeak, yPhasicPeak, yPhasicOnset } =
        this._computePeakScreenPos(p, tMin, scales, yMinU, yBottomU, yMinL, yBottomL, showLowerMarker, showUpperMarker, markerSeries);

      const isActive  = (pIdx === AppState.activePeakIndex);
      const isHovered = (AppState.hoveredIndex >= p.onsetIndex && AppState.hoveredIndex <= p.index);
      const isEmphasized = isActive || isHovered;

      const canvasBg = this.getThemeColor('--canvas-bg', '#ffffff');

      const isExcluded = p.excluded === true;
      const qScore = p.qualityScore !== undefined ? p.qualityScore : 0.5;
      const peakColor = isExcluded ? EXCLUDED_STYLE.color : getQualityColor(qScore);
      const lineClr   = isExcluded ? EXCLUDED_STYLE.lineColor : peakColor;
      const dashPat   = isExcluded ? EXCLUDED_STYLE.dash : NORMAL_DASH;
      const dotWt      = isExcluded ? EXCLUDED_STYLE.dotWeight : 1.2;
      const markerWt   = isExcluded ? EXCLUDED_STYLE.weight : (isEmphasized ? 1.5 : 1);

      // Resting-state dot fill/stroke: a visibly-colored (not fully
      // transparent) small dot so the full peak census reads as present at a
      // glance, while staying clearly lighter-weight than a hotspot (which
      // is solid-filled, larger, and carries a shaded region + connector).
      const restStroke = isExcluded ? color(lineClr) : color(peakColor + 'd0');
      const restFill    = isExcluded ? color(canvasBg) : color(peakColor + '70');

      // Shaded elevated region, onset dot, and connector line: only when
      // hovered/active, same as before — but now the onset dot and line are
      // ALSO skipped entirely in the resting state (previously always drawn)
      // to keep hundreds of resting markers from reading as visual noise.
      if (showLowerMarker && isEmphasized) {
        const fillClr = isExcluded ? color(lineClr + EXCLUDED_STYLE.fillAlpha) : color(peakColor + '4b');
        this._drawPeakShadedRegion(p, tMin, scales, yBottomL, yMinL, fillClr, xOnset, xPeak);

        stroke(isExcluded ? lineClr : this.getThemeColor('--color-phasic', '#008f3c'));
        strokeWeight(dotWt);
        fill(canvasBg);
        circle(xOnset, yPhasicOnset, 6);

        if (drawUpper) {
          stroke(isExcluded ? color(lineClr + EXCLUDED_STYLE.lineAlpha) : color(peakColor + '3c'));
          strokeWeight(1);
          drawingContext.setLineDash(dashPat);
          line(xPeak, yFilteredPeak, xPeak, yPhasicPeak);
          drawingContext.setLineDash([]);
        }
      }

      if (showLowerMarker) {
        // Minor resting dot: small, visibly-colored fill; solid + larger
        // only when hovered/active (exclusion state stays legible via its
        // own gray hollow treatment even at rest).
        stroke(isEmphasized ? (isExcluded ? color(lineClr) : color(peakColor)) : restStroke);
        strokeWeight(markerWt);
        fill(isActive ? (isExcluded ? color(lineClr) : color(peakColor)) : restFill);
        circle(xPeak, yPhasicPeak, isEmphasized ? 7 : 4);
      }

      // Upper-graph marker (on the Filtered curve) — drawn in every view that
      // shows that curve (Signal, Both, and the peak-density/AUC/etc. modes
      // where peaks only appear up top). Skipped in the single Phasic view,
      // whose only curve is the phasic one the lower marker already sits on.
      if (drawUpper) {
        stroke(isEmphasized ? (isExcluded ? color(lineClr) : color(peakColor)) : restStroke);
        strokeWeight(markerWt);
        fill(isActive ? (isExcluded ? color(lineClr) : color(peakColor)) : restFill);
        circle(xPeak, yFilteredPeak, isEmphasized ? 7 : 4);
      }

      if (xPeak >= GSR_CONST.MARGIN.left && xPeak <= width - GSR_CONST.MARGIN.right) {
        AppState._peakClickTargets.push({
          idx: pIdx,
          x: xPeak,
          yPhasic: yPhasicPeak,
          yFiltered: yFilteredPeak,
          r: 10
        });
        if (AppState.viewDuration < 300 || isActive || isHovered) {
          noStroke();
          fill(isExcluded ? color(EXCLUDED_STYLE.color) : peakColor);
          textSize(10);
          textStyle(BOLD);
          textAlign(CENTER, BOTTOM);
          let labelText = p.label || '#' + (pIdx + 1);
          if (labelText.length > 22) {
            labelText = labelText.substring(0, 19) + '...';
          }
          text(labelText, xPeak, yFilteredPeak - 8);
          textStyle(NORMAL);
        }
      }

      // ── On-canvas exclude ✕ / ＋ button (only when scrubbing near) ──
      if (isHovered && xPeak >= GSR_CONST.MARGIN.left && xPeak <= width - GSR_CONST.MARGIN.right) {
        this._drawExcludeButton(xPeak, yBottomU, pIdx, isExcluded);
      }
    }
  },

  /**
   * DOM/CSS overlay for the expanding, fading pulse ring behind a hotspot
   * dot — restores the animation peak markers originally had before they
   * were deliberately made static/minor (see drawPeakMarkers()'s doc
   * comment), applied instead to the much smaller, curated hotspot set.
   *
   * Previously this animated by having draw() itself run continuously at
   * ~60fps (p5's loop() with no matching noLoop() while a track was active)
   * just to repaint the whole canvas every frame for a few pulsing circles.
   * Replaced with real DOM elements using styles.css's own
   * @keyframes pulse-glow (already used by the map's .hotspot-glow-ring) so
   * the animation runs on the compositor for free — the canvas itself goes
   * back to rendering on demand (see tracks.js/events.js, which no longer
   * call loop()). One absolutely-positioned div per ring, repositioned only
   * when drawHotspotMarkers() actually runs (pan/zoom/track-switch/toggle),
   * not every frame.
   */
  _ensurePulseOverlay() {
    if (this._pulseOverlay && this._pulseOverlay.isConnected) return this._pulseOverlay;
    const container = document.getElementById('canvasContainer');
    if (!container) return null;
    const overlay = document.createElement('div');
    overlay.id = 'hotspotPulseOverlay';
    overlay.style.cssText = 'position:absolute; top:0; left:0; width:100%; height:100%; pointer-events:none; overflow:hidden;';
    container.appendChild(overlay);
    this._pulseOverlay = overlay;
    this._pulseRingEls = new Map();
    return overlay;
  },

  /**
   * Create/update the DOM ring for one hotspot pulse, keyed so repeated
   * calls across frames reuse the same element instead of re-creating it.
   * @private
   */
  _syncPulseRing(key, x, y, baseD, hotspotColor) {
    const overlay = this._ensurePulseOverlay();
    if (!overlay) return;
    const d = baseD * 2.33; // ring's natural size ~2.33x the dot, same ratio as the map's 28px ring around a 12px dot
    let el = this._pulseRingEls.get(key);
    if (!el) {
      el = document.createElement('div');
      el.className = 'graph-hotspot-pulse';
      overlay.appendChild(el);
      this._pulseRingEls.set(key, el);
    }
    el.style.width = d + 'px';
    el.style.height = d + 'px';
    el.style.left = (x - d / 2) + 'px';
    el.style.top = (y - d / 2) + 'px';
    el.style.backgroundColor = hotspotColor;
  },

  /**
   * Remove any pulse-ring divs not touched by the current
   * drawHotspotMarkers() pass (e.g. a hotspot that scrolled out of view or
   * belonged to a now-inactive track).
   * @private
   */
  _prunePulseRings(seenKeys) {
    if (!this._pulseRingEls) return;
    for (const [key, el] of this._pulseRingEls) {
      if (!seenKeys.has(key)) {
        el.remove();
        this._pulseRingEls.delete(key);
      }
    }
  },

  /**
   * Remove every pulse-ring div — called whenever there's nothing to show
   * (drawPlaceholder()) so a stale ring from a previous track/view can't be
   * left floating over an empty canvas.
   */
  clearPulseRings() {
    if (!this._pulseRingEls) return;
    for (const el of this._pulseRingEls.values()) el.remove();
    this._pulseRingEls.clear();
  },

  /**
   * Draw "Hotspots" — analyzer.memorableEvents, the curated subset of peaks
   * likely to actually be noticed/remembered (fast, high-amplitude; see
   * _computeSalienceScore()'s doc comment in analyzer.js). Deliberately
   * carries the bold, high-contrast styling drawPeakMarkers() used to apply
   * to every single peak: shaded elevated region, open onset dot, dashed
   * connector line, larger solid dots on both panels. That styling reads
   * fine at hotspot density (a handful to a few dozen per recording) in a
   * way it stopped being appropriate for the full peak census once that
   * census could run into the thousands.
   *
   * memorableEvents entries are the *same objects* as their corresponding
   * entries in analyzer.peaks (a filtered view, not a copy), so clicking a
   * hotspot reuses the normal peak focus/selection machinery by looking up
   * that real index — no separate selection state needed.
   */
  drawHotspotMarkers(tMin, tMax, yMinU, yMaxU, yTopU, yBottomU, yMinL, yMaxL, yTopL, yBottomL, showLowerMarker, showUpperMarker, markerSeries) {
    if (showLowerMarker === undefined) showLowerMarker = true;
    const drawUpper = showUpperMarker !== false; // see drawPeakMarkers()
    if (!AppState.showHotspots || !AppState.analyzer.memorableEvents || AppState.analyzer.memorableEvents.length === 0) {
      this.clearPulseRings();
      return;
    }

    const scales = this._computeGraphScales(tMin, tMax, yMinU, yMaxU, yTopU, yBottomU, yMinL, yMaxL, yTopL, yBottomL);

    const hotspotColor = this.getThemeColor('--color-hotspot', '#ff1744');
    const colorPhasic = this.getThemeColor('--color-phasic', '#008f3c');
    const canvasBg = this.getThemeColor('--canvas-bg', '#ffffff');

    // Pulse-ring positions are synced into DOM elements (see _syncPulseRing())
    // that animate via styles.css's own @keyframes pulse-glow instead of being
    // repainted into the canvas every frame — this set tracks which of those
    // elements are still current so stale ones (hotspot scrolled out of view,
    // track switched) get pruned at the end of this pass.
    const seenPulseKeys = new Set();

    for (const p of AppState.analyzer.memorableEvents) {
      if (this._peakOutOfView(p, tMin, tMax)) continue;

      const { xPeak, xOnset, yFilteredPeak, yPhasicPeak, yPhasicOnset } =
        this._computePeakScreenPos(p, tMin, scales, yMinU, yBottomU, yMinL, yBottomL, showLowerMarker, showUpperMarker, markerSeries);

      const realIdx = AppState.analyzer.peaks.indexOf(p);
      const isActive = (realIdx !== -1 && realIdx === AppState.activePeakIndex);

      if (showLowerMarker) {
        this._drawPeakShadedRegion(p, tMin, scales, yBottomL, yMinL, color(hotspotColor + '4b'), xOnset, xPeak);

        stroke(colorPhasic);
        strokeWeight(1.5);
        fill(canvasBg);
        circle(xOnset, yPhasicOnset, isActive ? 8 : 5);

        if (drawUpper) {
          stroke(color(hotspotColor + '78'));
          strokeWeight(1);
          drawingContext.setLineDash(NORMAL_DASH);
          line(xPeak, yFilteredPeak, xPeak, yPhasicPeak);
          drawingContext.setLineDash([]);
        }

        const lowerKey = realIdx + ':lower';
        this._syncPulseRing(lowerKey, xPeak, yPhasicPeak, isActive ? 9 : 6, hotspotColor);
        seenPulseKeys.add(lowerKey);
        stroke(hotspotColor);
        strokeWeight(2);
        fill(isActive ? color(hotspotColor) : color(canvasBg));
        circle(xPeak, yPhasicPeak, isActive ? 9 : 6);
      }

      if (drawUpper) {
        const upperKey = realIdx + ':upper';
        this._syncPulseRing(upperKey, xPeak, yFilteredPeak, isActive ? 9 : 6, hotspotColor);
        seenPulseKeys.add(upperKey);
        stroke(hotspotColor);
        strokeWeight(2);
        fill(isActive ? color(hotspotColor) : color(canvasBg));
        circle(xPeak, yFilteredPeak, isActive ? 9 : 6);
      }

      if (xPeak >= GSR_CONST.MARGIN.left && xPeak <= width - GSR_CONST.MARGIN.right && realIdx !== -1) {
        AppState._peakClickTargets.push({
          idx: realIdx,
          x: xPeak,
          yPhasic: yPhasicPeak,
          yFiltered: yFilteredPeak,
          r: 10
        });
        noStroke();
        fill(hotspotColor);
        textSize(9);
        textStyle(BOLD);
        textAlign(CENTER, BOTTOM);
        // Every hotspot is, by construction, also a plain peak (memorableEvents
        // is a subset of analyzer.peaks — see this method's doc comment), and
        // drawPeakMarkers() always draws that peak's "#N" number at this same
        // (xPeak, yFilteredPeak - 8) position whenever viewDuration < 300s (the
        // common case at any zoom level tight enough to matter here). Offset
        // further up so the star doesn't land exactly on top of — and get lost
        // in — that number; -20 clears a 10px BOLD label with a few px to
        // spare. Previously both drew at -8, so the star and the peak number
        // stacked into the same few pixels — a hotspot could look completely
        // unlabeled, or an unreadable smudge, even though it was being drawn.
        text('★', xPeak, yFilteredPeak - 20); // small star marks it as a hotspot, not a plain peak
        textStyle(NORMAL);
      }
    }

    this._prunePulseRings(seenPulseKeys);
  },

  /**
   * Draw a small exclude ✕ or re-include ＋ circle on the canvas.
   * Called per-peak from drawPeakMarkers when the scrub line is near.
   */
  _drawExcludeButton(xPeak, yBottomU, peakIdx, isExcluded) {
    const btnX = xPeak;
    const btnY = yBottomU + EXCLUDE_BTN.offsetY;
    const btnR = EXCLUDE_BTN.r;
    const btnColor = isExcluded ? '#008f3c' : '#d10024';

    noStroke();
    fill(color(btnColor + '1a'));
    circle(btnX, btnY, btnR * 2 + 3);

    stroke(btnColor);
    strokeWeight(1);
    noFill();
    circle(btnX, btnY, btnR * 2 + 1);
    noStroke();

    fill(btnColor);
    textSize(8);
    textStyle(BOLD);
    textAlign(CENTER, CENTER);
    text(isExcluded ? '+' : EXCLUDE_BTN.symbol, btnX, btnY);
    textStyle(NORMAL);

    // Store for hit-testing in mousePressed and hover cursor
    AppState._peakExcludeButtons.push({ idx: peakIdx, x: btnX, y: btnY, r: btnR + 4 });
  },

  /**
   * Return the exclude button under a canvas (mx, my), or null. Pure hit-test
   * shared by the click handler and the hover-cursor probe.
   */
  _hitExcludeButton(mx, my) {
    const btns = AppState._peakExcludeButtons;
    if (!btns || btns.length === 0) return null;
    for (const btn of btns) {
      const dx = mx - btn.x;
      const dy = my - btn.y;
      if (dx * dx + dy * dy <= btn.r * btn.r) return btn;
    }
    return null;
  },

  /**
   * Return the peak click-target under a canvas (mx, my), or null. A hit is any
   * of: the upper filtered dot, the lower phasic dot, or the vertical line
   * joining them (within 6px horizontally, between the two dots). Pure hit-test
   * shared by the click handler and the hover-cursor probe.
   */
  _hitPeakTarget(mx, my) {
    const targets = AppState._peakClickTargets;
    if (!targets || targets.length === 0) return null;
    for (const target of targets) {
      const dx = mx - target.x;
      const rSq = target.r * target.r;
      const dyF = my - target.yFiltered;
      const dyP = my - target.yPhasic;
      const isNearLine = Math.abs(dx) <= 6 &&
                         my >= Math.min(target.yFiltered, target.yPhasic) - 6 &&
                         my <= Math.max(target.yFiltered, target.yPhasic) + 6;
      if (dx * dx + dyF * dyF <= rSq || dx * dx + dyP * dyP <= rSq || isNearLine) {
        return target;
      }
    }
    return null;
  },

  /**
   * Check if a canvas (mouseX, mouseY) click hits any exclude button.
   * If so, toggle exclusion for that peak and return true.
   * Called from sketch.js mousePressed before starting any drag.
   */
  checkExcludeHit(mx, my) {
    const btn = this._hitExcludeButton(mx, my);
    if (btn) {
      GSRUI.togglePeakExclusion(btn.idx);
      return true;
    }
    return false;
  },

  /**
   * Check if canvas pointer is hovering over any exclude button without triggering a toggle.
   */
  isOverExclude(mx, my) {
    return this._hitExcludeButton(mx, my) !== null;
  },

  /**
   * Check if a canvas (mouseX, mouseY) click hits any peak dot or line on the graph.
   * If so, focus/highlight the peak across all views and return true.
   */
  checkPeakClick(mx, my) {
    const target = this._hitPeakTarget(mx, my);
    if (target) {
      GSRUI.focusOnPeak(target.idx, 'graph');
      return true;
    }
    return false;
  },

  /**
   * Check if canvas pointer is hovering over any peak target without focusing.
   */
  isOverPeak(mx, my) {
    return this._hitPeakTarget(mx, my) !== null;
  },

  // Hide every surface's scrub cursor and release graph ownership of it. Used
  // by handleScrubber()'s early-return branches. The 3D globe and 2D map both
  // listen on the 'scrub' event (see events.js / globe3d_view.js).
  _clearScrub() {
    AppState.hoveredIndex = -1;
    if (AppState.scrubSource === 'graph') AppState.scrubSource = null;
    AppState.emit('scrub', { clear: true, source: 'graph' });
  },

  handleScrubber(tMin, tMax, yMinU, yMaxU, yBottomU, yMinL, yMaxL, yTopL, yBottomL) {
    // One full-height plot: the time label goes in the top margin. In 'signal'
    // view the scrubber shows a Filtered dot (+ a Phasic dot when that overlay
    // is on); in a metric view it shows the metric's dot.
    const _view = AppState.graphView || 'signal';
    // When the 3D globe owns the cursor (the user is hovering the 3D track),
    // draw the scrubber from AppState.hoveredIndex directly and skip the mouse
    // hit-testing below — otherwise this per-frame pass would immediately wipe
    // the hover the globe just set (the mouse isn't over this canvas).
    const externalHover = AppState.scrubSource === 'globe' && AppState.hoveredIndex >= 0;

    if (!externalHover) {
      // Whatever the reason the canvas isn't reachable — collapsed panel
      // (visibility:hidden), collective view (display:none), the map's
      // fullscreen overlay sitting on top (z-index 9999) — a real hit-test at
      // the cursor's screen position is the one check that stays correct
      // without needing a dedicated AppState flag per hiding mechanism. p5's
      // own mouseX/mouseY and the mouseenter/mouseleave-driven mouseOverCanvas
      // flag are computed from the canvas' own layout box, which can go stale
      // or keep overlapping whatever took its place once the canvas is hidden
      // by CSS rather than actually moved/removed.
      if (!AppState.myCanvas || document.elementFromPoint(winMouseX, winMouseY) !== AppState.myCanvas.elt) {
        this._clearScrub();
        return;
      }

      // Only show scrubber when the mouse is inside the graph's plot area
      if (mouseX < GSR_CONST.MARGIN.left || mouseX > width - GSR_CONST.MARGIN.right ||
          mouseY < GSR_CONST.MARGIN.top || mouseY > yBottomL ||
          AppState.isDragging) {
        this._clearScrub();
        return;
      }
    }

    if (!AppState.analyzer.raw || AppState.analyzer.raw.length === 0 ||
        !AppState.analyzer.filtered || AppState.analyzer.filtered.length === 0 ||
        !AppState.analyzer.tonic || AppState.analyzer.tonic.length === 0 ||
        !AppState.analyzer.phasic || AppState.analyzer.phasic.length === 0) {
      if (!externalHover) this._clearScrub();
      return;
    }

    if (!externalHover) {
      const hoverTime = map(mouseX, GSR_CONST.MARGIN.left, width - GSR_CONST.MARGIN.right, tMin, tMax);
      AppState.hoveredIndex = AppState.analyzer.findClosestIndex(hoverTime);
      if (AppState.hoveredIndex === -1) return;
      AppState.scrubSource = 'graph';
    }

    const dRaw = AppState.analyzer.raw[AppState.hoveredIndex];
    if (!dRaw) return;

    // A graph hover drives the other surfaces' cursors through the 'scrub'
    // event. A globe-owned (external) hover already emitted its own 'scrub',
    // so don't echo it back.
    if (!externalHover) {
      if (dRaw.hasGps && !isNaN(dRaw.lat) && !isNaN(dRaw.lon)) {
        AppState.emit('scrub', { lat: dRaw.lat, lon: dRaw.lon, index: AppState.hoveredIndex, source: 'graph' });
      } else {
        AppState.emit('scrub', { clear: true, source: 'graph' });
      }
    }

    const dFilt   = AppState.analyzer.filtered[AppState.hoveredIndex];
    const dTonic  = AppState.analyzer.tonic[AppState.hoveredIndex];
    const dPhasic = AppState.analyzer.phasic[AppState.hoveredIndex];
    // An external (globe-owned) index can briefly outrun a just-reanalysed
    // series on a track switch — bail rather than throw on the .val reads.
    if (!dFilt || !dTonic || !dPhasic) return;

    // Lower graph may be showing phasic or one of the continuous alternatives
    // (peak density / phasic AUC / arousal index) — track the scrubber dot
    // and tooltip row against whichever series is actually plotted.
    const lowerMode = (GSR_CONST.LOWER_GRAPH_MODES && AppState.lowerGraphMode) || 'phasic';
    const lowerCfg = (GSR_CONST.LOWER_GRAPH_MODES && GSR_CONST.LOWER_GRAPH_MODES[lowerMode]) ||
                     { label: 'Phasic (SCR)', unit: 'μS', decimals: 4, colorVar: '--color-phasic', colorDefault: '#008f3c' };
    const lowerSeries = AppState.analyzer[lowerMode] || AppState.analyzer.phasic;
    const dLower = lowerSeries[AppState.hoveredIndex] || dPhasic;

    const xScrub = map(dRaw.time, tMin, tMax, GSR_CONST.MARGIN.left, width - GSR_CONST.MARGIN.right);

    const scrubberColor = this.getThemeColor('--canvas-scrubber', 'rgba(17, 17, 17, 0.25)');
    const colorFiltered = this.getThemeColor('--color-filtered', '#005bc4');
    const colorLower = this.getThemeColor(lowerCfg.colorVar, lowerCfg.colorDefault);

    stroke(scrubberColor);
    strokeWeight(1);
    line(xScrub, GSR_CONST.MARGIN.top, xScrub, yBottomL);

    // Time label on scrubber — in the top margin above the single plot
    const gapCenter = GSR_CONST.MARGIN.top - 6;
    fill(color(colorFiltered));
    noStroke();
    textSize(10);
    textStyle(BOLD);
    textAlign(CENTER, CENTER);
    text(dRaw.time.toFixed(1) + 's', xScrub, gapCenter);
    textStyle(NORMAL);

    const yU = map(dFilt.val, yMinU, yMaxU, yBottomU, GSR_CONST.MARGIN.top);
    const yL = map(dLower.val, yMinL, yMaxL, yBottomL, yTopL);

    if (_view === 'signal') {
      stroke(colorFiltered);
      fill(colorFiltered);
      circle(xScrub, yU, 6);
      // Phasic dot on the same µS axis, only while that overlay is shown
      if (AppState.showPhasic && dPhasic) {
        const cPhasic = this.getThemeColor('--color-phasic', '#008f3c');
        stroke(cPhasic);
        fill(cPhasic);
        circle(xScrub, map(dPhasic.val, yMinU, yMaxU, yBottomU, GSR_CONST.MARGIN.top), 6);
      }
    } else {
      stroke(colorLower);
      fill(colorLower);
      circle(xScrub, yL, 6);
    }

    // The floating tooltip is anchored to mouseX/mouseY; when the hover is
    // driven from the 3D globe the mouse is off this canvas, so the scrubber
    // line + dots + time label above are the readout and the tooltip is skipped.
    if (externalHover) return;

    // Check if hovered index is near a detected peak — show quality info
    let nearPeakInfo = null;
    if (AppState.analyzer.peaks && AppState.analyzer.peaks.length > 0) {
      const halfSec = Math.round(AppState.analyzer.sampleRate * 0.5);
      for (const pk of AppState.analyzer.peaks) {
        if (Math.abs(AppState.hoveredIndex - pk.index) <= halfSec) {
          nearPeakInfo = pk;
          break;
        }
      }
    }

    // Only attach an extra tooltip row when the lower graph isn't showing
    // plain Phasic — the Phasic row already covers that case below.
    const extraMetric = (lowerMode !== 'phasic') ? {
      label: lowerCfg.label + ':',
      color: colorLower,
      valueStr: dLower.val.toFixed(lowerCfg.decimals) + ' ' + lowerCfg.unit
    } : null;

    GSRRenderer.drawTooltip(dRaw.time, dRaw.val, dFilt.val, dTonic.val, dPhasic.val, nearPeakInfo, extraMetric);
  },

  /**
   * Draw a labeled value row inside the tooltip: left-aligned label, right-aligned value.
   */
  _drawTooltipRow(label, color, valueStr, boxX, boxW, pad, startY, spacing, row) {
    const y = startY + row * spacing;
    textAlign(LEFT, TOP);
    fill(color);
    text(label, boxX + pad, y);
    textAlign(RIGHT, TOP);
    text(valueStr, boxX + boxW - pad, y);
  },

  drawTooltip(time, rawVal, filtVal, tonicVal, phasicVal, nearPeak, extraMetric) {
    const pad = 12;
    const hasPeakInfo = nearPeak && nearPeak.qualityScore !== undefined;
    const extraRows = extraMetric ? 1 : 0;
    // Extra width for peak quality details
    const boxW = hasPeakInfo ? 240 : 200;
    const boxH = (hasPeakInfo ? 200 : 120) + extraRows * 18;

    let boxX = mouseX + 15;
    if (boxX + boxW > width - GSR_CONST.MARGIN.right) {
      boxX = mouseX - boxW - 15;
    }

    let boxY = mouseY - 20;
    boxY = constrain(boxY, GSR_CONST.MARGIN.top, Math.max(GSR_CONST.MARGIN.top, height - GSR_CONST.MARGIN.bottom - boxH));

    const overlayBg = this.getThemeColor('--canvas-overlay-bg', 'rgba(255, 255, 255, 0.95)');
    const axisColor = this.getThemeColor('--canvas-axis', 'rgba(17, 17, 17, 0.15)');
    const textColor = this.getThemeColor('--text-primary', '#111111');
    const textSec = this.getThemeColor('--text-secondary', '#444444');
    const colorFiltered = this.getThemeColor('--color-filtered', '#005bc4');
    const colorTonic = this.getThemeColor('--color-tonic', '#a30091');
    const colorPhasic = this.getThemeColor('--color-phasic', '#008f3c');

    fill(overlayBg);
    stroke(axisColor);
    strokeWeight(1);
    rect(boxX, boxY, boxW, boxH, 4);

    noStroke();
    textAlign(LEFT, TOP);

    fill(textColor);
    textSize(10);
    textStyle(BOLD);
    text('TIME: ' + AppState.analyzer.formatClockTime(time), boxX + pad, boxY + pad);
    textStyle(NORMAL);

    textSize(9.5);
    const startY = boxY + pad + 18;
    const spacing = 18;

    this._drawTooltipRow('Raw:', textSec, rawVal.toFixed(4) + ' \u03bcS', boxX, boxW, pad, startY, spacing, 0);
    this._drawTooltipRow('Filtered:', colorFiltered, filtVal.toFixed(4) + ' \u03bcS', boxX, boxW, pad, startY, spacing, 1);
    this._drawTooltipRow('Tonic (SCL):', colorTonic, tonicVal.toFixed(4) + ' \u03bcS', boxX, boxW, pad, startY, spacing, 2);
    this._drawTooltipRow('Phasic (SCR):', colorPhasic, phasicVal.toFixed(4) + ' \u03bcS', boxX, boxW, pad, startY, spacing, 3);

    // Extra row for the active lower-graph metric when it isn't plain Phasic
    // (peak density / phasic AUC / arousal index).
    if (extraMetric) {
      this._drawTooltipRow(extraMetric.label, extraMetric.color, extraMetric.valueStr, boxX, boxW, pad, startY, spacing, 4);
    }

    // Peak shape quality info (when hovering near a detected peak)
    if (hasPeakInfo) {
      const qScore = nearPeak.qualityScore;
      const qColor = getQualityColor(qScore);
      const { pct: qPct, label: qLabel } = getQualityLabel(qScore);

      const peakY = startY + (4 + extraRows) * spacing + 6;
      stroke(axisColor);
      strokeWeight(0.5);
      line(boxX + pad, peakY - 3, boxX + boxW - pad, peakY - 3);
      noStroke();

      // Quality header + badge on same row
      textSize(9.5);
      fill(textColor);
      textStyle(BOLD);
      textAlign(LEFT, TOP);
      text('Peak Quality', boxX + pad, peakY);
      fill(qColor);
      textAlign(RIGHT, TOP);
      text('\u25CF ' + qPct + '% ' + qLabel, boxX + boxW - pad, peakY);
      textStyle(NORMAL);

      // Details row 1: Skew + SNR
      const detailY = peakY + 16;
      textSize(8.5);
      fill(textSec);
      textAlign(LEFT, TOP);
      text('Skew:', boxX + pad, detailY);
      textAlign(RIGHT, TOP);
      text((nearPeak.skewnessRatio || 0).toFixed(2), boxX + boxW * 0.5 - 4, detailY);

      textAlign(LEFT, TOP);
      text('SNR:', boxX + boxW * 0.5 + 4, detailY);
      textAlign(RIGHT, TOP);
      text((nearPeak.snr || 0).toFixed(1) + 'x', boxX + boxW - pad, detailY);

      // Details row 2: Rise + Slope
      const slopeY = detailY + 15;
      textAlign(LEFT, TOP);
      text('Rise:', boxX + pad, slopeY);
      textAlign(RIGHT, TOP);
      text((nearPeak.riseTime || 0).toFixed(2) + 's', boxX + boxW * 0.5 - 4, slopeY);

      textAlign(LEFT, TOP);
      text('Slope:', boxX + boxW * 0.5 + 4, slopeY);
      textAlign(RIGHT, TOP);
      text((nearPeak.onsetSlope || 0).toFixed(4), boxX + boxW - pad, slopeY);
    }
  },

  drawTimelineOverview(innerWidth, timelineHeight) {
    if (!AppState.analyzer._timelinePoints || AppState.analyzer._timelinePoints.length === 0) return;

    const sidebarBg = this.getThemeColor('--bg-sidebar', '#f5f4f0');
    const axisColor = this.getThemeColor('--canvas-axis', 'rgba(17, 17, 17, 0.15)');
    const textSec = this.getThemeColor('--text-secondary', '#444444');
    const colorPeak = this.getThemeColor('--color-peak', '#d10024');
    const colorFiltered = this.getThemeColor('--color-filtered', '#005bc4');

    fill(sidebarBg);
    stroke(axisColor);
    strokeWeight(1);
    rect(GSR_CONST.MARGIN.left, AppState.yTimelineTop, innerWidth, timelineHeight, 4);

    noFill();
    stroke(axisColor);
    strokeWeight(1.2);

    let minRaw = Infinity;
    let maxRaw = -Infinity;
    if (!AppState.analyzer.rawMinMaxCached) {
      for (let i = 0; i < AppState.analyzer.raw.length; i++) {
        const val = AppState.analyzer.raw[i].val;
        if (val < minRaw) minRaw = val;
        if (val > maxRaw) maxRaw = val;
      }
      AppState.analyzer.rawMinMaxCached = { minVal: minRaw, maxVal: maxRaw };
    } else {
      minRaw = AppState.analyzer.rawMinMaxCached.minVal;
      maxRaw = AppState.analyzer.rawMinMaxCached.maxVal;
    }

    if (minRaw === maxRaw) maxRaw = minRaw + 0.5;

    const xSpan = (width - GSR_CONST.MARGIN.right) - GSR_CONST.MARGIN.left;
    const xScale = AppState.totalDuration > 0 ? (xSpan / AppState.totalDuration) : 0;
    const ySpan = (AppState.yTimelineTop + 3) - (AppState.yTimelineBottom - 3);
    const yScale = (maxRaw - minRaw) > 0 ? (ySpan / (maxRaw - minRaw)) : 0;

    // Use pre-cached timeline points (~300 samples)
    beginShape();
    const tPoints = AppState.analyzer._timelinePoints;
    for (let i = 0; i < tPoints.length; i++) {
      const d = tPoints[i];
      const xt = GSR_CONST.MARGIN.left + d.time * xScale;
      const yt = (AppState.yTimelineBottom - 3) + (d.val - minRaw) * yScale;
      vertex(xt, yt);
    }
    endShape();

    // Use pre-cached peak positions (fraction of total duration)
    if (AppState.showPeaks && AppState.analyzer._timelinePeakPct) {
      fill(color(colorPeak + 'b4')); // ~0.7 opacity
      noStroke();
      const pcts = AppState.analyzer._timelinePeakPct;
      for (let j = 0; j < pcts.length; j++) {
        const xp = GSR_CONST.MARGIN.left + pcts[j] * innerWidth;
        rect(xp - 0.5, AppState.yTimelineTop + 2, 1.5, timelineHeight - 4);
      }
    }

    const xViewStart = GSR_CONST.MARGIN.left + AppState.viewStartTime * xScale;
    const xViewEnd   = GSR_CONST.MARGIN.left + (AppState.viewStartTime + AppState.viewDuration) * xScale;

    fill(color(colorFiltered + '20')); // ~0.12 opacity
    stroke(colorFiltered);
    strokeWeight(1.5);
    rect(xViewStart, AppState.yTimelineTop, xViewEnd - xViewStart, timelineHeight, 2);
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GSRRenderer };
}
if (typeof window !== 'undefined') {
  window.GSRRenderer = GSRRenderer;
}
