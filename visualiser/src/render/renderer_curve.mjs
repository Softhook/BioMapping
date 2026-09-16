/**
 * GSRRenderer — signal curve, phasic area fill, and response-dynamics
 * overlay drawing.
 * Object-augment split from renderer.js: loaded after renderer.js, adds
 * these methods to the shared GSRRenderer object.
 *
 * _buildCurveContext is the shared per-frame viewport/step/spline context
 * every draw*Curve/Area method reads; it has no dependency on any other
 * augment file, only the app-wide globals GSR_CONST/AppState/width.

 * Assigned onto GSRRenderer via Object.assign at the file's tail (a plain ESM
 * static import/export, loaded once by app_entry.mjs).
 */
import { AppState } from '../core/app_state.mjs';
import { GSR_CONST } from '../core/constants.mjs';
import { ResponseDynamics } from '../signal/response_dynamics.mjs';
import { GSRRenderer } from './renderer.mjs';

export const __methods = {
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
  _buildCurveContext(
    data,
    tMin,
    tMax,
    yMin,
    yMax,
    yTop,
    yBottom,
    forceIndices,
  ) {
    const startIdx = Math.max(0, AppState.analyzer.findClosestIndex(tMin) - 1);
    const endIdx = Math.min(
      data.length - 1,
      AppState.analyzer.findClosestIndex(tMax) + 1,
    );
    const count = endIdx - startIdx + 1;
    if (count <= 0) return null;

    const step = Math.max(1, Math.ceil(count / GSR_CONST.DRAW_MAX_VERTICES));
    const useSpline = count < GSR_CONST.SPLINE_THRESHOLD;

    const tSpan = tMax - tMin;
    const xSpan = width - GSR_CONST.MARGIN.right - GSR_CONST.MARGIN.left;
    const yScale = yMax - yMin > 0 ? (yTop - yBottom) / (yMax - yMin) : 0;
    const xScale = tSpan > 0 ? xSpan / tSpan : 0;

    // Build the actual index sequence to draw: the uniform stride, plus any
    // forced indices merged in and de-duplicated, kept in ascending order.
    // Skipped entirely (falls back to the plain stride below) when no forced
    // indices are given or none fall in the visible range, so curves drawn
    // without peaks (raw/tonic/etc.) do exactly the same work as before.
    let indices = null;
    if (forceIndices && forceIndices.length > 0 && step > 1) {
      const forced = [];
      for (let i = 0; i < forceIndices.length; i++) {
        const idx = forceIndices[i];
        if (idx >= startIdx && idx <= endIdx) forced.push(idx);
      }
      if (forced.length > 0) {
        forced.sort((a, b) => a - b);
        const result = [];
        let s = startIdx;
        let f = 0;
        while (s <= endIdx && f < forced.length) {
          const fVal = forced[f];
          if (s < fVal) {
            result.push(s);
            s += step;
          } else if (s === fVal) {
            result.push(s);
            s += step;
            f++;
          } else {
            if (result.length === 0 || result[result.length - 1] !== fVal) {
              result.push(fVal);
            }
            f++;
          }
        }
        while (s <= endIdx) {
          result.push(s);
          s += step;
        }
        while (f < forced.length) {
          const fVal = forced[f];
          if (result.length === 0 || result[result.length - 1] !== fVal) {
            result.push(fVal);
          }
          f++;
        }
        if (result[result.length - 1] !== endIdx) {
          result.push(endIdx);
        }
        indices = result;
      }
    }

    return {
      startIdx,
      endIdx,
      count,
      step,
      useSpline,
      xScale,
      yScale,
      indices,
    };
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

  _drawPeakShadedRegion(
    p,
    tMin,
    scales,
    yBottomL,
    yMinL,
    fillColor,
    xOnset,
    xPeak,
  ) {
    fill(fillColor);
    noStroke();
    beginShape();
    vertex(xOnset, yBottomL);
    for (let i = p.onsetIndex; i <= p.index; i++) {
      const xVal =
        GSR_CONST.MARGIN.left +
        (AppState.analyzer.phasic[i].time - tMin) * scales.xScale;
      const yVal =
        yBottomL + (AppState.analyzer.phasic[i].val - yMinL) * scales.yScaleL;
      vertex(xVal, yVal);
    }
    vertex(xPeak, yBottomL);
    endShape(CLOSE);
  },

  /**
   * Draw a line/curve from data points with optional spline smoothing.
   * @param {Array<number>} [forceIndices] - See _buildCurveContext().
   */
  drawSignalCurve(
    data,
    tMin,
    tMax,
    yMin,
    yMax,
    yTop,
    yBottom,
    lineColor,
    lineWt,
    forceIndices,
  ) {
    if (!data || data.length === 0) return;
    const ctx = this._buildCurveContext(
      data,
      tMin,
      tMax,
      yMin,
      yMax,
      yTop,
      yBottom,
      forceIndices,
    );
    if (!ctx) return;
    const _drawIndices = ctx.indices || null;

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
  drawPhasicArea(
    data,
    tMin,
    tMax,
    yMin,
    yMax,
    yTop,
    yBottom,
    fillColorHex,
    forceIndices,
  ) {
    if (!data || data.length === 0) return;
    const ctx = this._buildCurveContext(
      data,
      tMin,
      tMax,
      yMin,
      yMax,
      yTop,
      yBottom,
      forceIndices,
    );
    if (!ctx) return;
    const _drawIndices = ctx.indices || null;

    noStroke();
    const fillHex =
      fillColorHex || this.getThemeColor('--color-phasic', '#008f3c');
    fill(color(`${fillHex}19`));

    const dFirst = data[ctx.startIdx];
    const xStart = GSR_CONST.MARGIN.left + (dFirst.time - tMin) * ctx.xScale;

    beginShape();
    vertex(xStart, yBottom);

    if (ctx.useSpline) {
      curveVertex(xStart, yBottom);
      this._drawVertices(ctx, data, tMin, yMin, yBottom, true);
      const xEnd =
        GSR_CONST.MARGIN.left + (data[ctx.endIdx].time - tMin) * ctx.xScale;
      curveVertex(xEnd, yBottom);
      vertex(xEnd, yBottom);
    } else {
      this._drawVertices(ctx, data, tMin, yMin, yBottom, false);
      const xEnd =
        GSR_CONST.MARGIN.left + (data[ctx.endIdx].time - tMin) * ctx.xScale;
      vertex(xEnd, yBottom);
    }

    endShape(CLOSE);
  },

  /**
   * Draw the Phasic curve with segments and filled area colored by Response Dynamics speed.
   * Height represents Phasic amplitude (μS).
   * Resting baseline intervals are drawn in a soft, muted baseline color.
   * Active response intervals are filled and stroked in their respective speed colors (Red, Orange, Green, Blue, Purple).
   *
   * @param {Array<{time: number, val: number}>} phasicData
   * @param {Array<{time: number, val: number}>} dynData
   * @param {number} tMin
   * @param {number} tMax
   * @param {number} yMin
   * @param {number} yMax
   * @param {number} yTop
   * @param {number} yBottom
   * @param {Array<number>} [forceIndices]
   */
  drawResponseDynamicsPhasic(
    phasicData,
    dynData,
    tMin,
    tMax,
    yMin,
    yMax,
    yTop,
    yBottom,
    forceIndices,
  ) {
    if (!phasicData || phasicData.length === 0) return;
    const ctx = this._buildCurveContext(
      phasicData,
      tMin,
      tMax,
      yMin,
      yMax,
      yTop,
      yBottom,
      forceIndices,
    );
    if (!ctx) return;

    const basePhasicHex = this.getThemeColor('--color-phasic', '#008f3c');
    const RD = ResponseDynamics;

    // Collect rendered points with speed bucket
    const pts = [];
    const drawIndices = ctx.indices || null;
    if (drawIndices) {
      for (let k = 0; k < drawIndices.length; k++) {
        const i = drawIndices[k];
        const d = phasicData[i];
        const dynVal = dynData?.[i] ? dynData[i].val : 0;
        const bucket = RD ? RD.getBucketIndex(dynVal) : dynVal <= 0 ? 0 : 3;
        const x = GSR_CONST.MARGIN.left + (d.time - tMin) * ctx.xScale;
        const y = yBottom + (d.val - yMin) * ctx.yScale;
        pts.push({ x, y, bucket });
      }
    } else {
      for (let i = ctx.startIdx; i <= ctx.endIdx; i += ctx.step) {
        const d = phasicData[i];
        const dynVal = dynData?.[i] ? dynData[i].val : 0;
        const bucket = RD ? RD.getBucketIndex(dynVal) : dynVal <= 0 ? 0 : 3;
        const x = GSR_CONST.MARGIN.left + (d.time - tMin) * ctx.xScale;
        const y = yBottom + (d.val - yMin) * ctx.yScale;
        pts.push({ x, y, bucket });
      }
    }
    if (pts.length < 2) return;

    // Group into contiguous runs
    const runs = [];
    let currentRun = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i];
      if (p.bucket === currentRun[0].bucket) {
        currentRun.push(p);
      } else {
        // Overlap boundary point for continuous connections
        currentRun.push(p);
        runs.push(currentRun);
        currentRun = [p];
      }
    }
    if (currentRun.length > 0) runs.push(currentRun);

    // Pass 1: Draw filled areas
    noStroke();
    for (let r = 0; r < runs.length; r++) {
      const run = runs[r];
      if (run.length < 2) continue;
      const b = run[0].bucket;
      if (b === 0) {
        // Resting baseline area wash (subtle 5% opacity)
        fill(color(`${basePhasicHex}0d`));
      } else {
        const bandColor = RD ? RD.BANDS[b - 1].color : '#10b981';
        fill(color(`${bandColor}30`)); // translucent speed color wash for active peak
      }
      beginShape();
      vertex(run[0].x, yBottom);
      for (let j = 0; j < run.length; j++) vertex(run[j].x, run[j].y);
      vertex(run[run.length - 1].x, yBottom);
      endShape(CLOSE);
    }

    // Pass 2: Draw strokes
    noFill();
    for (let r = 0; r < runs.length; r++) {
      const run = runs[r];
      if (run.length < 2) continue;
      const b = run[0].bucket;
      if (b === 0) {
        stroke(color(`${basePhasicHex}70`));
        strokeWeight(1.5);
      } else {
        const bandColor = RD ? RD.BANDS[b - 1].color : '#10b981';
        stroke(bandColor);
        strokeWeight(2.5);
      }
      beginShape();
      for (let j = 0; j < run.length; j++) vertex(run[j].x, run[j].y);
      endShape();
    }
  },
};

Object.assign(GSRRenderer, __methods);
