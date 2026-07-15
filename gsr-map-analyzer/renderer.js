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
  },

  drawGridX(tMin, tMax, yUpperBottom, yLowerBottom) {
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
      line(x, yUpperBottom + GSR_CONST.MARGIN.gap, x, yLowerBottom);

      // Time label in the gap between upper (tonic) and lower (phasic) graphs
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
      text(label, x, yUpperBottom + GSR_CONST.MARGIN.gap / 2);
      stroke(gridColor);
    }

    stroke(axisColor);
    line(GSR_CONST.MARGIN.left, GSR_CONST.MARGIN.top, GSR_CONST.MARGIN.left, yUpperBottom);
    line(GSR_CONST.MARGIN.left, yUpperBottom + GSR_CONST.MARGIN.gap, GSR_CONST.MARGIN.left, yLowerBottom);
    line(GSR_CONST.MARGIN.left, yUpperBottom, width - GSR_CONST.MARGIN.right, yUpperBottom);
    line(GSR_CONST.MARGIN.left, yLowerBottom, width - GSR_CONST.MARGIN.right, yLowerBottom);
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
  drawGridY(yMin, yMax, yBottom, yTop, stepRanges, defaultStep, decimals) {
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
      text(val.toFixed(decimals) + ' \u03bcS', GSR_CONST.MARGIN.left - 8, y);
      stroke(gridColor);
      lastLabelY = y;
    }
  },

  /**
   * Compute common context for curve drawing: clamped indices, step, spline decision, and scale factors.
   */
  _buildCurveContext(data, tMin, tMax, yMin, yMax, yTop, yBottom) {
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

    return { startIdx, endIdx, count, step, useSpline, xScale, yScale };
  },

  /**
   * Draw a line/curve from data points with optional spline smoothing.
   */
  drawSignalCurve(data, tMin, tMax, yMin, yMax, yTop, yBottom, lineColor, lineWt) {
    if (!data || data.length === 0) return;
    const ctx = this._buildCurveContext(data, tMin, tMax, yMin, yMax, yTop, yBottom);
    if (!ctx) return;

    noFill();
    stroke(lineColor);
    strokeWeight(lineWt);

    beginShape();
    if (ctx.useSpline) {
      const dFirst = data[ctx.startIdx];
      const xFirst = GSR_CONST.MARGIN.left + (dFirst.time - tMin) * ctx.xScale;
      const yFirst = yBottom + (dFirst.val - yMin) * ctx.yScale;
      curveVertex(xFirst, yFirst);
      for (let i = ctx.startIdx; i <= ctx.endIdx; i += ctx.step) {
        const d = data[i];
        const x = GSR_CONST.MARGIN.left + (d.time - tMin) * ctx.xScale;
        const y = yBottom + (d.val - yMin) * ctx.yScale;
        curveVertex(x, y);
      }
      const dLast = data[ctx.endIdx];
      const xLast = GSR_CONST.MARGIN.left + (dLast.time - tMin) * ctx.xScale;
      const yLast = yBottom + (dLast.val - yMin) * ctx.yScale;
      curveVertex(xLast, yLast);
    } else {
      for (let i = ctx.startIdx; i <= ctx.endIdx; i += ctx.step) {
        const d = data[i];
        const x = GSR_CONST.MARGIN.left + (d.time - tMin) * ctx.xScale;
        const y = yBottom + (d.val - yMin) * ctx.yScale;
        vertex(x, y);
      }
    }
    endShape();
  },

  /**
   * Draw a filled phasic area from data points, closed to the baseline (yBottom).
   */
  drawPhasicArea(data, tMin, tMax, yMin, yMax, yTop, yBottom) {
    if (!data || data.length === 0) return;
    const ctx = this._buildCurveContext(data, tMin, tMax, yMin, yMax, yTop, yBottom);
    if (!ctx) return;

    noStroke();
    const colorPhasic = this.getThemeColor('--color-phasic', '#008f3c');
    fill(color(colorPhasic + '19'));

    const dFirst = data[ctx.startIdx];
    const xStart = GSR_CONST.MARGIN.left + (dFirst.time - tMin) * ctx.xScale;

    beginShape();
    vertex(xStart, yBottom);

    if (ctx.useSpline) {
      curveVertex(xStart, yBottom);
      for (let i = ctx.startIdx; i <= ctx.endIdx; i += ctx.step) {
        const d = data[i];
        const x = GSR_CONST.MARGIN.left + (d.time - tMin) * ctx.xScale;
        const y = yBottom + (d.val - yMin) * ctx.yScale;
        curveVertex(x, y);
      }
      const xEnd = GSR_CONST.MARGIN.left + (data[ctx.endIdx].time - tMin) * ctx.xScale;
      curveVertex(xEnd, yBottom);
      vertex(xEnd, yBottom);
    } else {
      for (let i = ctx.startIdx; i <= ctx.endIdx; i += ctx.step) {
        const d = data[i];
        const x = GSR_CONST.MARGIN.left + (d.time - tMin) * ctx.xScale;
        const y = yBottom + (d.val - yMin) * ctx.yScale;
        vertex(x, y);
      }
      const xEnd = GSR_CONST.MARGIN.left + (data[ctx.endIdx].time - tMin) * ctx.xScale;
      vertex(xEnd, yBottom);
    }

    endShape(CLOSE);
  },

  drawPeakMarkers(tMin, tMax, yMinU, yMaxU, yTopU, yBottomU, yMinL, yMaxL, yTopL, yBottomL) {
    if (!AppState.showPeaks || !AppState.analyzer.peaks || AppState.analyzer.peaks.length === 0) return;

    // Reset click-target list for on-canvas exclude buttons and peaks
    AppState._peakExcludeButtons = [];
    AppState._peakClickTargets = [];

    const tSpan = tMax - tMin;
    const xSpan = (width - GSR_CONST.MARGIN.right) - GSR_CONST.MARGIN.left;
    const xScale = tSpan > 0 ? (xSpan / tSpan) : 0;

    const yScaleU = (yMaxU - yMinU) > 0 ? ((yTopU - yBottomU) / (yMaxU - yMinU)) : 0;
    const yScaleL = (yMaxL - yMinL) > 0 ? ((yTopL - yBottomL) / (yMaxL - yMinL)) : 0;

    for (let pIdx = 0; pIdx < AppState.analyzer.peaks.length; pIdx++) {
      const p = AppState.analyzer.peaks[pIdx];

      if (p.time < tMin && p.onsetTime < tMin &&
          (p.recoveryIndex === -1 || p.recoveryIndex === undefined ||
           !AppState.analyzer.phasic || !AppState.analyzer.phasic[p.recoveryIndex] ||
           AppState.analyzer.phasic[p.recoveryIndex].time < tMin)) {
        continue;
      }
      if (p.onsetTime > tMax) continue;

      const xPeak  = GSR_CONST.MARGIN.left + (p.time - tMin) * xScale;
      const xOnset = GSR_CONST.MARGIN.left + (p.onsetTime - tMin) * xScale;

      const yFilteredPeak = yBottomU + (AppState.analyzer.filtered[p.index].val - yMinU) * yScaleU;
      const yPhasicPeak   = yBottomL + (p.value - yMinL) * yScaleL;
      const yPhasicOnset  = yBottomL + (p.onsetValue - yMinL) * yScaleL;

      const isActive  = (pIdx === AppState.activePeakIndex);
      const isHovered = (AppState.hoveredIndex >= p.onsetIndex && AppState.hoveredIndex <= p.index);

      const colorPeak = this.getThemeColor('--color-peak', '#d10024');
      const colorPhasic = this.getThemeColor('--color-phasic', '#008f3c');
      const canvasBg = this.getThemeColor('--canvas-bg', '#ffffff');

      const isExcluded = p.excluded === true;
      const qScore = p.qualityScore !== undefined ? p.qualityScore : 0.5;
      const peakColor = isExcluded ? EXCLUDED_STYLE.color : getQualityColor(qScore);
      const lineClr   = isExcluded ? EXCLUDED_STYLE.lineColor : peakColor;
      const dashPat   = isExcluded ? EXCLUDED_STYLE.dash : NORMAL_DASH;
      const dotWt      = isExcluded ? EXCLUDED_STYLE.dotWeight : 1.5;
      const markerWt   = isExcluded ? EXCLUDED_STYLE.weight : 2;

      if (isActive || isHovered) {
        fill(isExcluded ? color(lineClr + EXCLUDED_STYLE.fillAlpha) : color(peakColor + '4b'));
        noStroke();
        beginShape();
        vertex(xOnset, yBottomL);
        for (let i = p.onsetIndex; i <= p.index; i++) {
          const xVal = GSR_CONST.MARGIN.left + (AppState.analyzer.phasic[i].time - tMin) * xScale;
          const yVal = yBottomL + (AppState.analyzer.phasic[i].val - yMinL) * yScaleL;
          vertex(xVal, yVal);
        }
        vertex(xPeak, yBottomL);
        endShape(CLOSE);
      }

      stroke(isExcluded ? lineClr : colorPhasic);
      strokeWeight(dotWt);
      fill(canvasBg);
      circle(xOnset, yPhasicOnset, isActive ? 8 : 5);

      stroke(isExcluded ? color(lineClr + EXCLUDED_STYLE.lineAlpha) : color(peakColor + '3c'));
      strokeWeight(1);
      drawingContext.setLineDash(dashPat);
      line(xPeak, yFilteredPeak, xPeak, yPhasicPeak);
      drawingContext.setLineDash([]);

      stroke(isExcluded ? color(lineClr) : peakColor);
      strokeWeight(markerWt);
      fill(isActive ? (isExcluded ? color(lineClr) : color(peakColor)) : color(canvasBg));
      circle(xPeak, yPhasicPeak, isActive ? 9 : 6);
      circle(xPeak, yFilteredPeak, isActive ? 9 : 6);

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

    // Store for hit-testing in mousePressed
    AppState._peakExcludeButtons.push({ idx: peakIdx, x: btnX, y: btnY, r: btnR + 2 });
  },

  /**
   * Check if a canvas (mouseX, mouseY) click hits any exclude button.
   * If so, toggle exclusion for that peak and return true.
   * Called from sketch.js mousePressed before starting any drag.
   */
  checkExcludeHit(mx, my) {
    const btns = AppState._peakExcludeButtons;
    if (!btns || btns.length === 0) return false;
    for (const btn of btns) {
      const dx = mx - btn.x;
      const dy = my - btn.y;
      if (Math.sqrt(dx * dx + dy * dy) <= btn.r) {
        GSRUI.togglePeakExclusion(btn.idx);
        return true;
      }
    }
    return false;
  },

  /**
   * Check if a canvas (mouseX, mouseY) click hits any peak dot or line on the graph.
   * If so, focus/highlight the peak across all views and return true.
   */
  checkPeakClick(mx, my) {
    const targets = AppState._peakClickTargets;
    if (!targets || targets.length === 0) return false;
    for (const target of targets) {
      // Check hit for upper filtered circle
      const dx1 = mx - target.x;
      const dy1 = my - target.yFiltered;
      const dist1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);

      // Check hit for lower phasic circle
      const dy2 = my - target.yPhasic;
      const dist2 = Math.sqrt(dx1 * dx1 + dy2 * dy2);

      // Check hit for vertical line (within 6px horizontally, and between the circles)
      const isNearLine = Math.abs(mx - target.x) <= 6 &&
                         my >= Math.min(target.yFiltered, target.yPhasic) - 6 &&
                         my <= Math.max(target.yFiltered, target.yPhasic) + 6;

      if (dist1 <= target.r || dist2 <= target.r || isNearLine) {
        GSRUI.focusOnPeak(target.idx, 'graph');
        return true;
      }
    }
    return false;
  },

  handleScrubber(tMin, tMax, yMinU, yMaxU, yBottomU, yMinL, yMaxL, yTopL, yBottomL) {
    // Don't scrub when the map panel is fullscreen (p5 canvas is hidden behind overlay)
    if (AppState.isMapFullscreen) {
      AppState.hoveredIndex = -1;
      if (AppState.mapManager) AppState.mapManager.setScrubPosition(NaN, NaN);
      return;
    }

    // Only show scrubber when the mouse is actually over the canvas and inside the graph area
    if (!AppState.mouseOverCanvas ||
        mouseX < GSR_CONST.MARGIN.left || mouseX > width - GSR_CONST.MARGIN.right ||
        mouseY < GSR_CONST.MARGIN.top || mouseY > yBottomL ||
        AppState.isDragging) {
      AppState.hoveredIndex = -1;
      if (AppState.mapManager) AppState.mapManager.setScrubPosition(NaN, NaN);
      return;
    }

    if (!AppState.analyzer.raw || AppState.analyzer.raw.length === 0 ||
        !AppState.analyzer.filtered || AppState.analyzer.filtered.length === 0 ||
        !AppState.analyzer.tonic || AppState.analyzer.tonic.length === 0 ||
        !AppState.analyzer.phasic || AppState.analyzer.phasic.length === 0) {
      AppState.hoveredIndex = -1;
      if (AppState.mapManager) AppState.mapManager.setScrubPosition(NaN, NaN);
      return;
    }

    const hoverTime = map(mouseX, GSR_CONST.MARGIN.left, width - GSR_CONST.MARGIN.right, tMin, tMax);
    AppState.hoveredIndex = AppState.analyzer.findClosestIndex(hoverTime);
    if (AppState.hoveredIndex === -1) return;

    const dRaw = AppState.analyzer.raw[AppState.hoveredIndex];
    if (!dRaw) return;

    if (dRaw.hasGps && !isNaN(dRaw.lat) && !isNaN(dRaw.lon)) {
      if (AppState.mapManager) AppState.mapManager.setScrubPosition(dRaw.lat, dRaw.lon, true);
    } else {
      if (AppState.mapManager) AppState.mapManager.setScrubPosition(NaN, NaN);
    }

    const dFilt   = AppState.analyzer.filtered[AppState.hoveredIndex];
    const dTonic  = AppState.analyzer.tonic[AppState.hoveredIndex];
    const dPhasic = AppState.analyzer.phasic[AppState.hoveredIndex];

    const xScrub = map(dRaw.time, tMin, tMax, GSR_CONST.MARGIN.left, width - GSR_CONST.MARGIN.right);

    const scrubberColor = this.getThemeColor('--canvas-scrubber', 'rgba(17, 17, 17, 0.25)');
    const colorFiltered = this.getThemeColor('--color-filtered', '#005bc4');
    const colorPhasic = this.getThemeColor('--color-phasic', '#008f3c');

    stroke(scrubberColor);
    strokeWeight(1);
    line(xScrub, GSR_CONST.MARGIN.top, xScrub, yBottomL);

    // Time label on scrubber in the gap between upper and lower graphs
    const gapCenter = (yBottomU + yTopL) / 2;
    fill(color(colorFiltered));
    noStroke();
    textSize(10);
    textStyle(BOLD);
    textAlign(CENTER, CENTER);
    text(dRaw.time.toFixed(1) + 's', xScrub, gapCenter);
    textStyle(NORMAL);

    const yU = map(dFilt.val, yMinU, yMaxU, yBottomU, GSR_CONST.MARGIN.top);
    const yL = map(dPhasic.val, yMinL, yMaxL, yBottomL, yTopL);

    stroke(colorFiltered);
    fill(colorFiltered);
    circle(xScrub, yU, 6);

    stroke(colorPhasic);
    fill(colorPhasic);
    circle(xScrub, yL, 6);

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

    GSRRenderer.drawTooltip(dRaw.time, dRaw.val, dFilt.val, dTonic.val, dPhasic.val, nearPeakInfo);
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

  drawTooltip(time, rawVal, filtVal, tonicVal, phasicVal, nearPeak) {
    const pad = 12;
    const hasPeakInfo = nearPeak && nearPeak.qualityScore !== undefined;
    // Extra width for peak quality details
    const boxW = hasPeakInfo ? 240 : 200;
    const boxH = hasPeakInfo ? 200 : 120;

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

    // Peak shape quality info (when hovering near a detected peak)
    if (hasPeakInfo) {
      const qScore = nearPeak.qualityScore;
      const qColor = getQualityColor(qScore);
      const { pct: qPct, label: qLabel } = getQualityLabel(qScore);

      const peakY = startY + 4 * spacing + 6;
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
