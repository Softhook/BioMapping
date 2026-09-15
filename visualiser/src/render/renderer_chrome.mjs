/**
 * GSRRenderer — static graph chrome: the X/Y grid, the hover tooltip, and
 * the bottom timeline-overview strip.
 * Object-augment split from renderer.js: loaded after renderer.js, adds
 * these methods to the shared GSRRenderer object.
 *
 * Reads the module-level getQualityColor()/getQualityLabel() from
 * renderer.js's own header — see the dual-mode note below for how that stays
 * resolvable under plain require().
 *
 * Assigned onto GSRRenderer via Object.assign at the file's tail (a plain ESM
 * static import/export, loaded once by app_entry.mjs).
 * entire export surface onto `global` rather than naming individual identifiers
 * — renderer.js's module.exports is the single source of truth for what's
 * available bare; a name missing there is a bug in renderer.js's exports, not
 * something to patch around here.
 */
import { AppState } from '../core/app_state.mjs';
import { GSR_CONST } from '../core/constants.mjs';
import { GSRRenderer, getQualityColor, getQualityLabel } from './renderer.mjs';

export const __methods = {
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

    const gridColor = this.getThemeColor(
      '--canvas-grid',
      'rgba(17, 17, 17, 0.06)',
    );
    const textColor = this.getThemeColor('--canvas-text', '#444444');
    const axisColor = this.getThemeColor(
      '--canvas-axis',
      'rgba(17, 17, 17, 0.15)',
    );

    // ── Pass 1: all vertical grid lines (one stroke() call for the whole pass) ──
    stroke(gridColor);
    strokeWeight(1);
    for (let t = firstGridTime; t <= tMax; t += step) {
      if (t < tMin) continue;
      const x = map(
        t,
        tMin,
        tMax,
        GSR_CONST.MARGIN.left,
        width - GSR_CONST.MARGIN.right,
      );
      line(x, GSR_CONST.MARGIN.top, x, yUpperBottom);
      if (!singleGraph)
        line(x, yUpperBottom + GSR_CONST.MARGIN.gap, x, yLowerBottom);
    }

    // ── Pass 2: all time labels (noStroke set once, fill set once) ──────────
    noStroke();
    fill(textColor);
    textAlign(CENTER, CENTER);
    textSize(10);
    for (let t = firstGridTime; t <= tMax; t += step) {
      if (t < tMin) continue;
      const x = map(
        t,
        tMin,
        tMax,
        GSR_CONST.MARGIN.left,
        width - GSR_CONST.MARGIN.right,
      );

      let label = `${t.toFixed(t % 1 !== 0 ? 1 : 0)}s`;
      if (t >= 3600) {
        const h = Math.floor(t / 3600);
        const m = Math.floor((t % 3600) / 60);
        const s = Math.floor(t % 60);
        label = `${h}:${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
      } else if (t >= 60) {
        const m = Math.floor(t / 60);
        const s = Math.floor(t % 60);
        label = `${m}:${s < 10 ? '0' : ''}${s}`;
      }
      text(
        label,
        x,
        singleGraph
          ? yUpperBottom + 10
          : yUpperBottom + GSR_CONST.MARGIN.gap / 2,
      );
    }

    stroke(axisColor);
    line(
      GSR_CONST.MARGIN.left,
      GSR_CONST.MARGIN.top,
      GSR_CONST.MARGIN.left,
      yUpperBottom,
    );
    line(
      GSR_CONST.MARGIN.left,
      yUpperBottom,
      width - GSR_CONST.MARGIN.right,
      yUpperBottom,
    );
    if (!singleGraph) {
      line(
        GSR_CONST.MARGIN.left,
        yUpperBottom + GSR_CONST.MARGIN.gap,
        GSR_CONST.MARGIN.left,
        yLowerBottom,
      );
      line(
        GSR_CONST.MARGIN.left,
        yLowerBottom,
        width - GSR_CONST.MARGIN.right,
        yLowerBottom,
      );
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
  drawGridY(
    yMin,
    yMax,
    yBottom,
    yTop,
    stepRanges,
    defaultStep,
    decimals,
    unitSuffix,
  ) {
    const unit = unitSuffix !== undefined ? unitSuffix : ' \u03bcS';
    const span = yMax - yMin;
    let step = defaultStep;
    for (const [threshold, s] of stepRanges) {
      if (span < threshold) {
        step = s;
        break;
      }
    }

    const firstGridVal = Math.floor(yMin / step) * step;

    const gridColor = this.getThemeColor(
      '--canvas-grid',
      'rgba(17, 17, 17, 0.06)',
    );
    const textColor = this.getThemeColor('--canvas-text', '#444444');

    const labelHeight = 14;

    // Two passes over the same tick range so p5 stroke/fill state is set once
    // per pass instead of toggled per-tick — no per-frame array buffering.

    // ── Pass 1: horizontal grid lines ────────────────────────────────────
    stroke(gridColor);
    for (let val = firstGridVal; val <= yMax; val += step) {
      if (val < yMin) continue;
      const y = map(val, yMin, yMax, yBottom, yTop);
      line(GSR_CONST.MARGIN.left, y, width - GSR_CONST.MARGIN.right, y);
    }

    // ── Pass 2: Y-axis labels, thinned so they never crowd ───────────────
    noStroke();
    fill(textColor);
    textAlign(RIGHT, CENTER);
    textSize(10);
    let lastLabelY = null;
    for (let val = firstGridVal; val <= yMax; val += step) {
      if (val < yMin) continue;
      const y = map(val, yMin, yMax, yBottom, yTop);
      if (lastLabelY !== null && Math.abs(y - lastLabelY) < labelHeight)
        continue;
      text(val.toFixed(decimals) + unit, GSR_CONST.MARGIN.left - 8, y);
      lastLabelY = y;
    }
  },

  /**
   * Draw a labelled value row inside the tooltip: left-aligned label, right-aligned value.
   */
  _drawTooltipRow(
    label,
    color,
    valueStr,
    boxX,
    boxW,
    pad,
    startY,
    spacing,
    row,
  ) {
    const y = startY + row * spacing;
    textAlign(LEFT, TOP);
    fill(color);
    text(label, boxX + pad, y);
    textAlign(RIGHT, TOP);
    text(valueStr, boxX + boxW - pad, y);
  },

  drawTooltip(time, rawVal, filtVal, tonicVal, phasicVal, nearPeak, extraRows) {
    const pad = 12;
    const hasPeakInfo = nearPeak && nearPeak.qualityScore !== undefined;
    const rows = extraRows || [];

    // Dynamically calculate box width from content so text never overlaps
    textSize(9.5);
    const measureW = (s) =>
      typeof textWidth === 'function' ? textWidth(s) : (s ? s.length : 0) * 6.5;
    let maxContentW = 0;
    const allRows = [
      ['Raw:', `${rawVal.toFixed(4)} \u03bcS`],
      ['Filtered:', `${filtVal.toFixed(4)} \u03bcS`],
      ['Tonic (SCL):', `${tonicVal.toFixed(4)} \u03bcS`],
      ['Phasic (SCR):', `${phasicVal.toFixed(4)} \u03bcS`],
    ];
    for (const r of rows) {
      if (r) allRows.push([r.label || '', r.valueStr || '']);
    }
    for (const [lbl, val] of allRows) {
      const rowW = measureW(lbl) + measureW(val) + 16;
      if (rowW > maxContentW) maxContentW = rowW;
    }
    const minW = hasPeakInfo ? 240 : 200;
    const boxW = Math.max(minW, Math.ceil(maxContentW + pad * 2));
    const hasSpeed = hasPeakInfo && !!nearPeak.speedLabel;
    const boxH =
      (hasPeakInfo ? (hasSpeed ? 216 : 200) : 120) + rows.length * 18;

    let boxX = mouseX + 15;
    if (boxX + boxW > width - GSR_CONST.MARGIN.right) {
      boxX = mouseX - boxW - 15;
    }

    let boxY = mouseY - 20;
    boxY = constrain(
      boxY,
      GSR_CONST.MARGIN.top,
      Math.max(GSR_CONST.MARGIN.top, height - GSR_CONST.MARGIN.bottom - boxH),
    );

    const overlayBg = this.getThemeColor(
      '--canvas-overlay-bg',
      'rgba(255, 255, 255, 0.95)',
    );
    const axisColor = this.getThemeColor(
      '--canvas-axis',
      'rgba(17, 17, 17, 0.15)',
    );
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
    text(
      `TIME: ${AppState.analyzer.formatClockTime(time)}`,
      boxX + pad,
      boxY + pad,
    );
    textStyle(NORMAL);

    textSize(9.5);
    const startY = boxY + pad + 18;
    const spacing = 18;

    let rowIdx = 0;
    this._drawTooltipRow(
      'Raw:',
      textSec,
      `${rawVal.toFixed(4)} \u03bcS`,
      boxX,
      boxW,
      pad,
      startY,
      spacing,
      rowIdx++,
    );
    this._drawTooltipRow(
      'Filtered:',
      colorFiltered,
      `${filtVal.toFixed(4)} \u03bcS`,
      boxX,
      boxW,
      pad,
      startY,
      spacing,
      rowIdx++,
    );
    this._drawTooltipRow(
      'Tonic (SCL):',
      colorTonic,
      `${tonicVal.toFixed(4)} \u03bcS`,
      boxX,
      boxW,
      pad,
      startY,
      spacing,
      rowIdx++,
    );
    this._drawTooltipRow(
      'Phasic (SCR):',
      colorPhasic,
      `${phasicVal.toFixed(4)} \u03bcS`,
      boxX,
      boxW,
      pad,
      startY,
      spacing,
      rowIdx++,
    );

    // One row per active extra metric/overlay (lower-graph metric, OSM
    // context, NDVI, EM Fog, ...) — see the extraRows build-up at the call
    // site for what can land here.
    for (const row of rows) {
      this._drawTooltipRow(
        row.label,
        row.color,
        row.valueStr,
        boxX,
        boxW,
        pad,
        startY,
        spacing,
        rowIdx++,
      );
    }

    // Peak shape quality info (when hovering near a detected peak)
    if (hasPeakInfo) {
      const qScore = nearPeak.qualityScore;
      const qColor = getQualityColor(qScore);
      const { pct: qPct, label: qLabel } = getQualityLabel(qScore);

      const peakY = startY + rowIdx * spacing + 6;
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
      text(`\u25CF ${qPct}% ${qLabel}`, boxX + boxW - pad, peakY);
      textStyle(NORMAL);

      // Details row 1: Skew + SNR
      const detailY = peakY + 16;
      textSize(8.5);
      fill(textSec);
      textAlign(LEFT, TOP);
      text('Skew:', boxX + pad, detailY);
      textAlign(RIGHT, TOP);
      text(
        (nearPeak.skewnessRatio || 0).toFixed(2),
        boxX + boxW * 0.5 - 4,
        detailY,
      );

      textAlign(LEFT, TOP);
      text('SNR:', boxX + boxW * 0.5 + 4, detailY);
      textAlign(RIGHT, TOP);
      text(`${(nearPeak.snr || 0).toFixed(1)}x`, boxX + boxW - pad, detailY);

      // Details row 2: Rise + Slope
      const slopeY = detailY + 15;
      textAlign(LEFT, TOP);
      text('Rise:', boxX + pad, slopeY);
      textAlign(RIGHT, TOP);
      text(
        `${(nearPeak.riseTime || 0).toFixed(2)}s`,
        boxX + boxW * 0.5 - 4,
        slopeY,
      );

      textAlign(LEFT, TOP);
      text('Slope:', boxX + boxW * 0.5 + 4, slopeY);
      textAlign(RIGHT, TOP);
      text((nearPeak.onsetSlope || 0).toFixed(4), boxX + boxW - pad, slopeY);

      if (nearPeak.speedLabel) {
        const speedY = slopeY + 15;
        textAlign(LEFT, TOP);
        text('Speed:', boxX + pad, speedY);
        textAlign(RIGHT, TOP);
        text(
          `${nearPeak.speedLabel} (${nearPeak.scaleFactor || 1}x)`,
          boxX + boxW - pad,
          speedY,
        );
      }
    }
  },

  drawTimelineOverview(innerWidth, timelineHeight) {
    if (
      !AppState.analyzer._timelinePoints ||
      AppState.analyzer._timelinePoints.length === 0
    )
      return;

    const sidebarBg = this.getThemeColor('--bg-sidebar', '#f5f4f0');
    const axisColor = this.getThemeColor(
      '--canvas-axis',
      'rgba(17, 17, 17, 0.15)',
    );
    const textSec = this.getThemeColor('--text-secondary', '#444444');
    const colorPeak = this.getThemeColor('--color-peak', '#d10024');
    const colorFiltered = this.getThemeColor('--color-filtered', '#005bc4');

    fill(sidebarBg);
    stroke(axisColor);
    strokeWeight(1);
    rect(
      GSR_CONST.MARGIN.left,
      AppState.yTimelineTop,
      innerWidth,
      timelineHeight,
      4,
    );

    noFill();
    stroke(axisColor);
    strokeWeight(1.2);

    let minRaw = Infinity;
    let maxRaw = -Infinity;
    const globalRaw = AppState.analyzer?._rawGlobalRange;
    if (
      globalRaw &&
      globalRaw.min !== undefined &&
      globalRaw.max !== undefined
    ) {
      minRaw = globalRaw.min;
      maxRaw = globalRaw.max;
    } else if (AppState.analyzer?.rawMinMaxCached) {
      minRaw = AppState.analyzer.rawMinMaxCached.minVal;
      maxRaw = AppState.analyzer.rawMinMaxCached.maxVal;
    } else if (AppState.analyzer?.raw) {
      for (let i = 0; i < AppState.analyzer.raw.length; i++) {
        const val = AppState.analyzer.raw[i].val;
        if (val < minRaw) minRaw = val;
        if (val > maxRaw) maxRaw = val;
      }
      AppState.analyzer.rawMinMaxCached = { minVal: minRaw, maxVal: maxRaw };
    }

    if (minRaw === maxRaw) maxRaw = minRaw + 0.5;

    const xSpan = width - GSR_CONST.MARGIN.right - GSR_CONST.MARGIN.left;
    const xScale =
      AppState.totalDuration > 0 ? xSpan / AppState.totalDuration : 0;
    const ySpan = AppState.yTimelineTop + 3 - (AppState.yTimelineBottom - 3);
    const yScale = maxRaw - minRaw > 0 ? ySpan / (maxRaw - minRaw) : 0;

    // Use pre-cached timeline points (~300 samples)
    beginShape();
    const tPoints = AppState.analyzer._timelinePoints;
    for (let i = 0; i < tPoints.length; i++) {
      const d = tPoints[i];
      const xt = GSR_CONST.MARGIN.left + d.time * xScale;
      const yt = AppState.yTimelineBottom - 3 + (d.val - minRaw) * yScale;
      vertex(xt, yt);
    }
    endShape();

    // Use pre-cached peak positions (fraction of total duration)
    if (AppState.showPeaks && AppState.analyzer._timelinePeakPct) {
      fill(color(`${colorPeak}b4`)); // ~0.7 opacity
      noStroke();
      const pcts = AppState.analyzer._timelinePeakPct;
      for (let j = 0; j < pcts.length; j++) {
        const xp = GSR_CONST.MARGIN.left + pcts[j] * innerWidth;
        rect(xp - 0.5, AppState.yTimelineTop + 2, 1.5, timelineHeight - 4);
      }
    }

    const xViewStart = GSR_CONST.MARGIN.left + AppState.viewStartTime * xScale;
    const xViewEnd =
      GSR_CONST.MARGIN.left +
      (AppState.viewStartTime + AppState.viewDuration) * xScale;

    fill(color(`${colorFiltered}20`)); // ~0.12 opacity
    stroke(colorFiltered);
    strokeWeight(1.5);
    rect(
      xViewStart,
      AppState.yTimelineTop,
      xViewEnd - xViewStart,
      timelineHeight,
      2,
    );
  },
};

Object.assign(GSRRenderer, __methods);
