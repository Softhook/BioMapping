/**
 * Graphics Rendering & Drawing Utilities (p5.js Canvas View).
 * All shared state accessed through AppState.
 */

const GSRRenderer = {
  drawPlaceholder() {
    background(9, 13, 22);
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

    stroke(255, 255, 255, 12);
    strokeWeight(1);
    textAlign(CENTER, CENTER);
    textSize(10);

    for (let t = firstGridTime; t <= tMax; t += step) {
      if (t < tMin) continue;
      const x = map(t, tMin, tMax, GSR_CONST.MARGIN.left, width - GSR_CONST.MARGIN.right);
      line(x, GSR_CONST.MARGIN.top, x, yUpperBottom);
      line(x, yUpperBottom + GSR_CONST.MARGIN.gap, x, yLowerBottom);

      // Time label in the gap between upper (tonic) and lower (phasic) graphs
      fill(148, 163, 184);
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
      stroke(255, 255, 255, 12);
    }

    stroke(255, 255, 255, 25);
    line(GSR_CONST.MARGIN.left, GSR_CONST.MARGIN.top, GSR_CONST.MARGIN.left, yUpperBottom);
    line(GSR_CONST.MARGIN.left, yUpperBottom + GSR_CONST.MARGIN.gap, GSR_CONST.MARGIN.left, yLowerBottom);
    line(GSR_CONST.MARGIN.left, yUpperBottom, width - GSR_CONST.MARGIN.right, yUpperBottom);
    line(GSR_CONST.MARGIN.left, yLowerBottom, width - GSR_CONST.MARGIN.right, yLowerBottom);
  },

  drawGridYUpper(yMin, yMax, yBottom, heightVal) {
    const span = yMax - yMin;
    let step = 0.5;
    if (span < 0.2) step = 0.02;
    else if (span < 1.0) step = 0.1;
    else if (span < 3.0) step = 0.5;
    else if (span < 10) step = 1.0;
    else step = 2.0;

    const firstGridVal = Math.floor(yMin / step) * step;

    stroke(255, 255, 255, 12);
    textAlign(RIGHT, CENTER);
    textSize(10);

    for (let val = firstGridVal; val <= yMax; val += step) {
      if (val < yMin) continue;
      const y = map(val, yMin, yMax, yBottom, GSR_CONST.MARGIN.top);
      line(GSR_CONST.MARGIN.left, y, width - GSR_CONST.MARGIN.right, y);

      noStroke();
      fill(148, 163, 184);
      text(val.toFixed(2) + ' \u03bcS', GSR_CONST.MARGIN.left - 8, y);
      stroke(255, 255, 255, 12);
    }
  },

  drawGridYLower(yMin, yMax, yBottom, heightVal) {
    const span = yMax - yMin;
    let step = 0.05;
    if (span < 0.05) step = 0.005;
    else if (span < 0.15) step = 0.01;
    else if (span < 0.5) step = 0.05;
    else if (span < 1.5) step = 0.1;
    else step = 0.5;

    const firstGridVal = Math.floor(yMin / step) * step;

    stroke(255, 255, 255, 12);
    textAlign(RIGHT, CENTER);
    textSize(10);

    for (let val = firstGridVal; val <= yMax; val += step) {
      if (val < yMin) continue;
      const y = map(val, yMin, yMax, yBottom, yBottom - heightVal);
      line(GSR_CONST.MARGIN.left, y, width - GSR_CONST.MARGIN.right, y);

      noStroke();
      fill(148, 163, 184);
      text(val.toFixed(3) + ' \u03bcS', GSR_CONST.MARGIN.left - 8, y);
      stroke(255, 255, 255, 12);
    }
  },

  drawSignalCurve(data, tMin, tMax, yMin, yMax, yTop, yBottom, lineColor, lineWt) {
    if (!data || data.length === 0) return;
    noFill();
    stroke(lineColor);
    strokeWeight(lineWt);

    const startIdx = Math.max(0, AppState.analyzer.findClosestIndex(tMin) - 1);
    const endIdx   = Math.min(data.length - 1, AppState.analyzer.findClosestIndex(tMax) + 1);
    const count = endIdx - startIdx + 1;
    if (count <= 0) return;

    const step = Math.max(1, Math.ceil(count / GSR_CONST.DRAW_MAX_VERTICES));
    const useSpline = count < GSR_CONST.SPLINE_THRESHOLD;

    beginShape();

    if (useSpline) {
      const dFirst = data[startIdx];
      const xFirst = map(dFirst.time, tMin, tMax, GSR_CONST.MARGIN.left, width - GSR_CONST.MARGIN.right);
      const yFirst = map(dFirst.val, yMin, yMax, yBottom, yTop);
      curveVertex(xFirst, yFirst);

      for (let i = startIdx; i <= endIdx; i += step) {
        const d = data[i];
        const x = map(d.time, tMin, tMax, GSR_CONST.MARGIN.left, width - GSR_CONST.MARGIN.right);
        const y = map(d.val, yMin, yMax, yBottom, yTop);
        curveVertex(x, y);
      }

      const dLast = data[endIdx];
      const xLast = map(dLast.time, tMin, tMax, GSR_CONST.MARGIN.left, width - GSR_CONST.MARGIN.right);
      const yLast = map(dLast.val, yMin, yMax, yBottom, yTop);
      curveVertex(xLast, yLast);
    } else {
      for (let i = startIdx; i <= endIdx; i += step) {
        const d = data[i];
        const x = map(d.time, tMin, tMax, GSR_CONST.MARGIN.left, width - GSR_CONST.MARGIN.right);
        const y = map(d.val, yMin, yMax, yBottom, yTop);
        vertex(x, y);
      }
    }

    endShape();
  },

  drawPhasicArea(data, tMin, tMax, yMin, yMax, yTop, yBottom) {
    if (!data || data.length === 0) return;
    const startIdx = Math.max(0, AppState.analyzer.findClosestIndex(tMin) - 1);
    const endIdx   = Math.min(data.length - 1, AppState.analyzer.findClosestIndex(tMax) + 1);
    const count = endIdx - startIdx + 1;
    if (count <= 0) return;

    noStroke();
    fill(16, 185, 129, 25);

    const step = Math.max(1, Math.ceil(count / GSR_CONST.DRAW_MAX_VERTICES));
    const useSpline = count < GSR_CONST.SPLINE_THRESHOLD;

    beginShape();

    const dFirst = data[startIdx];
    const xStart = map(dFirst.time, tMin, tMax, GSR_CONST.MARGIN.left, width - GSR_CONST.MARGIN.right);
    vertex(xStart, yBottom);

    if (useSpline) {
      curveVertex(xStart, yBottom);

      for (let i = startIdx; i <= endIdx; i += step) {
        const d = data[i];
        const x = map(d.time, tMin, tMax, GSR_CONST.MARGIN.left, width - GSR_CONST.MARGIN.right);
        const y = map(d.val, yMin, yMax, yBottom, yTop);
        curveVertex(x, y);
      }

      const dLast = data[endIdx];
      const xEnd = map(dLast.time, tMin, tMax, GSR_CONST.MARGIN.left, width - GSR_CONST.MARGIN.right);
      curveVertex(xEnd, yBottom);
      vertex(xEnd, yBottom);
    } else {
      for (let i = startIdx; i <= endIdx; i += step) {
        const d = data[i];
        const x = map(d.time, tMin, tMax, GSR_CONST.MARGIN.left, width - GSR_CONST.MARGIN.right);
        const y = map(d.val, yMin, yMax, yBottom, yTop);
        vertex(x, y);
      }
      const dLast = data[endIdx];
      const xEnd = map(dLast.time, tMin, tMax, GSR_CONST.MARGIN.left, width - GSR_CONST.MARGIN.right);
      vertex(xEnd, yBottom);
    }

    endShape();
  },

  drawPeakMarkers(tMin, tMax, yMinU, yMaxU, yTopU, yBottomU, yMinL, yMaxL, yTopL, yBottomL) {
    if (!AppState.showPeaks || !AppState.analyzer.peaks || AppState.analyzer.peaks.length === 0) return;
    for (let pIdx = 0; pIdx < AppState.analyzer.peaks.length; pIdx++) {
      const p = AppState.analyzer.peaks[pIdx];

      if (p.time < tMin && p.onsetTime < tMin &&
          (p.recoveryIndex === -1 || p.recoveryIndex === undefined ||
           !AppState.analyzer.phasic || !AppState.analyzer.phasic[p.recoveryIndex] ||
           AppState.analyzer.phasic[p.recoveryIndex].time < tMin)) {
        continue;
      }
      if (p.onsetTime > tMax) continue;

      const xPeak  = map(p.time, tMin, tMax, GSR_CONST.MARGIN.left, width - GSR_CONST.MARGIN.right);
      const xOnset = map(p.onsetTime, tMin, tMax, GSR_CONST.MARGIN.left, width - GSR_CONST.MARGIN.right);

      const yFilteredPeak = map(AppState.analyzer.filtered[p.index].val, yMinU, yMaxU, yBottomU, yTopU);
      const yPhasicPeak   = map(p.value, yMinL, yMaxL, yBottomL, yTopL);
      const yPhasicOnset  = map(p.onsetValue, yMinL, yMaxL, yBottomL, yTopL);

      const isActive  = (pIdx === AppState.activePeakIndex);
      const isHovered = (AppState.hoveredIndex >= p.onsetIndex && AppState.hoveredIndex <= p.index);

      if (isActive || isHovered) {
        fill(244, 63, 94, 75);
        noStroke();
        beginShape();
        vertex(xOnset, yBottomL);
        for (let i = p.onsetIndex; i <= p.index; i++) {
          const xVal = map(AppState.analyzer.phasic[i].time, tMin, tMax, GSR_CONST.MARGIN.left, width - GSR_CONST.MARGIN.right);
          const yVal = map(AppState.analyzer.phasic[i].val, yMinL, yMaxL, yBottomL, yTopL);
          vertex(xVal, yVal);
        }
        vertex(xPeak, yBottomL);
        endShape(CLOSE);
      }

      stroke(16, 185, 129);
      strokeWeight(1.5);
      fill(9, 13, 22);
      circle(xOnset, yPhasicOnset, isActive ? 8 : 5);

      stroke(244, 63, 94, 60);
      strokeWeight(1);
      drawingContext.setLineDash([3, 3]);
      line(xPeak, yFilteredPeak, xPeak, yPhasicPeak);
      drawingContext.setLineDash([]);

      stroke(244, 63, 94);
      strokeWeight(2);
      fill(isActive ? color(244, 63, 94) : color(9, 13, 22));
      circle(xPeak, yPhasicPeak, isActive ? 9 : 6);
      circle(xPeak, yFilteredPeak, isActive ? 9 : 6);

      if (xPeak >= GSR_CONST.MARGIN.left && xPeak <= width - GSR_CONST.MARGIN.right) {
        if (AppState.viewDuration < 300 || isActive || isHovered) {
          noStroke();
          fill(244, 63, 94);
          textSize(10);
          textStyle(BOLD);
          textAlign(CENTER, BOTTOM);
          const labelText = p.label || '#' + (pIdx + 1);
          text(labelText, xPeak, yFilteredPeak - 8);
          textStyle(NORMAL);
        }
      }
    }
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

    stroke(255, 255, 255, 50);
    strokeWeight(1);
    line(xScrub, GSR_CONST.MARGIN.top, xScrub, yBottomL);

    // Time label on scrubber in the gap between upper and lower graphs
    const gapCenter = (yBottomU + yTopL) / 2;
    fill(14, 165, 233, 220);
    noStroke();
    textSize(10);
    textStyle(BOLD);
    textAlign(CENTER, CENTER);
    text(dRaw.time.toFixed(1) + 's', xScrub, gapCenter);
    textStyle(NORMAL);

    const yU = map(dFilt.val, yMinU, yMaxU, yBottomU, GSR_CONST.MARGIN.top);
    const yL = map(dPhasic.val, yMinL, yMaxL, yBottomL, yTopL);

    stroke(14, 165, 233);
    fill(14, 165, 233);
    circle(xScrub, yU, 6);

    stroke(16, 185, 129);
    fill(16, 185, 129);
    circle(xScrub, yL, 6);

    GSRRenderer.drawTooltip(dRaw.time, dRaw.val, dFilt.val, dTonic.val, dPhasic.val);
  },

  drawTooltip(time, rawVal, filtVal, tonicVal, phasicVal) {
    const pad = 12;
    const boxW = 190;
    const boxH = 120;

    let boxX = mouseX + 15;
    if (boxX + boxW > width - GSR_CONST.MARGIN.right) {
      boxX = mouseX - boxW - 15;
    }

    let boxY = mouseY - 40;
    boxY = constrain(boxY, GSR_CONST.MARGIN.top, height - GSR_CONST.MARGIN.bottom - boxH);

    fill(22, 33, 54, 235);
    stroke(255, 255, 255, 15);
    strokeWeight(1);
    rect(boxX, boxY, boxW, boxH, 8);

    noStroke();
    textAlign(LEFT, TOP);

    fill(255, 255, 255);
    textSize(10);
    textStyle(BOLD);
    text('TIME: ' + time.toFixed(2) + ' s', boxX + pad, boxY + pad);
    textStyle(NORMAL);

    textSize(9.5);
    const startY = boxY + pad + 18;
    const spacing = 18;

    fill(148, 163, 184);
    text('Raw:', boxX + pad, startY);
    textAlign(RIGHT, TOP);
    text(rawVal.toFixed(4) + ' \u03bcS', boxX + boxW - pad, startY);

    textAlign(LEFT, TOP);
    fill(14, 165, 233);
    text('Filtered:', boxX + pad, startY + spacing);
    textAlign(RIGHT, TOP);
    text(filtVal.toFixed(4) + ' \u03bcS', boxX + boxW - pad, startY + spacing);

    textAlign(LEFT, TOP);
    fill(217, 70, 239);
    text('Tonic (SCL):', boxX + pad, startY + 2 * spacing);
    textAlign(RIGHT, TOP);
    text(tonicVal.toFixed(4) + ' \u03bcS', boxX + boxW - pad, startY + 2 * spacing);

    textAlign(LEFT, TOP);
    fill(16, 185, 129);
    text('Phasic (SCR):', boxX + pad, startY + 3 * spacing);
    textAlign(RIGHT, TOP);
    text(phasicVal.toFixed(4) + ' \u03bcS', boxX + boxW - pad, startY + 3 * spacing);
  }
};
