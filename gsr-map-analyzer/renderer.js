/**
 * Graphics Rendering & Drawing Utilities (p5.js Canvas View).
 * All shared state accessed through AppState.
 */

var M = AppState.margin;  // shorthand

function drawPlaceholder() {
  background(9, 13, 22, 0);
}

function drawGridX(tMin, tMax, yUpperBottom, yLowerBottom) {
  var innerWidth = width - M.left - M.right;
  var span = tMax - tMin;
  var step = 10;
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

  var firstGridTime = Math.floor(tMin / step) * step;

  stroke(255, 255, 255, 12);
  strokeWeight(1);
  textAlign(CENTER, TOP);
  textSize(10);

  for (var t = firstGridTime; t <= tMax; t += step) {
    if (t < tMin) continue;
    var x = map(t, tMin, tMax, M.left, width - M.right);
    line(x, M.top, x, yUpperBottom);
    line(x, yUpperBottom + M.gap, x, yLowerBottom);

    fill(148, 163, 184);
    noStroke();

    var label = t.toFixed(t % 1 !== 0 ? 1 : 0) + 's';
    if (t >= 3600) {
      var h = Math.floor(t / 3600);
      var m = Math.floor((t % 3600) / 60);
      var s = Math.floor(t % 60);
      label = h + ':' + (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
    } else if (t >= 60) {
      var m = Math.floor(t / 60);
      var s = Math.floor(t % 60);
      label = m + ':' + (s < 10 ? '0' : '') + s;
    }
    text(label, x, yLowerBottom + 6);
    stroke(255, 255, 255, 12);
  }

  stroke(255, 255, 255, 25);
  line(M.left, M.top, M.left, yUpperBottom);
  line(M.left, yUpperBottom + M.gap, M.left, yLowerBottom);
  line(M.left, yUpperBottom, width - M.right, yUpperBottom);
  line(M.left, yLowerBottom, width - M.right, yLowerBottom);
}

function drawGridYUpper(yMin, yMax, yBottom, heightVal) {
  var span = yMax - yMin;
  var step = 0.5;
  if (span < 0.2) step = 0.02;
  else if (span < 1.0) step = 0.1;
  else if (span < 3.0) step = 0.5;
  else if (span < 10) step = 1.0;
  else step = 2.0;

  var firstGridVal = Math.floor(yMin / step) * step;

  stroke(255, 255, 255, 12);
  textAlign(RIGHT, CENTER);
  textSize(10);

  for (var val = firstGridVal; val <= yMax; val += step) {
    if (val < yMin) continue;
    var y = map(val, yMin, yMax, yBottom, M.top);
    line(M.left, y, width - M.right, y);

    noStroke();
    fill(148, 163, 184);
    text(val.toFixed(2) + ' \u03bcS', M.left - 8, y);
    stroke(255, 255, 255, 12);
  }
}

function drawGridYLower(yMin, yMax, yBottom, heightVal) {
  var span = yMax - yMin;
  var step = 0.05;
  if (span < 0.05) step = 0.005;
  else if (span < 0.15) step = 0.01;
  else if (span < 0.5) step = 0.05;
  else if (span < 1.5) step = 0.1;
  else step = 0.5;

  var firstGridVal = Math.floor(yMin / step) * step;

  stroke(255, 255, 255, 12);
  textAlign(RIGHT, CENTER);
  textSize(10);

  for (var val = firstGridVal; val <= yMax; val += step) {
    if (val < yMin) continue;
    var y = map(val, yMin, yMax, yBottom, yBottom - heightVal);
    line(M.left, y, width - M.right, y);

    noStroke();
    fill(148, 163, 184);
    text(val.toFixed(3) + ' \u03bcS', M.left - 8, y);
    stroke(255, 255, 255, 12);
  }
}

function drawSignalCurve(data, tMin, tMax, yMin, yMax, yTop, yBottom, lineColor, lineWt) {
  if (!data || data.length === 0) return;
  noFill();
  stroke(lineColor);
  strokeWeight(lineWt);

  var startIdx = Math.max(0, findClosestIndex(tMin) - 1);
  var endIdx   = Math.min(data.length - 1, findClosestIndex(tMax) + 1);
  var count = endIdx - startIdx + 1;
  if (count <= 0) return;

  var maxVertices = 1500;
  var step = Math.max(1, Math.ceil(count / maxVertices));
  var useSpline = count < 600;

  beginShape();

  if (useSpline) {
    var dFirst = data[startIdx];
    var xFirst = map(dFirst.time, tMin, tMax, M.left, width - M.right);
    var yFirst = map(dFirst.val, yMin, yMax, yBottom, yTop);
    curveVertex(xFirst, yFirst);

    for (var i = startIdx; i <= endIdx; i += step) {
      var d = data[i];
      var x = map(d.time, tMin, tMax, M.left, width - M.right);
      var y = map(d.val, yMin, yMax, yBottom, yTop);
      curveVertex(x, y);
    }

    var dLast = data[endIdx];
    var xLast = map(dLast.time, tMin, tMax, M.left, width - M.right);
    var yLast = map(dLast.val, yMin, yMax, yBottom, yTop);
    curveVertex(xLast, yLast);
  } else {
    for (var i = startIdx; i <= endIdx; i += step) {
      var d = data[i];
      var x = map(d.time, tMin, tMax, M.left, width - M.right);
      var y = map(d.val, yMin, yMax, yBottom, yTop);
      vertex(x, y);
    }
  }

  endShape();
}

function drawPhasicArea(data, tMin, tMax, yMin, yMax, yTop, yBottom) {
  if (!data || data.length === 0) return;
  var startIdx = Math.max(0, findClosestIndex(tMin) - 1);
  var endIdx   = Math.min(data.length - 1, findClosestIndex(tMax) + 1);
  var count = endIdx - startIdx + 1;
  if (count <= 0) return;

  noStroke();
  fill(16, 185, 129, 25);

  var maxVertices = 1500;
  var step = Math.max(1, Math.ceil(count / maxVertices));
  var useSpline = count < 600;

  beginShape();

  var dFirst = data[startIdx];
  var xStart = map(dFirst.time, tMin, tMax, M.left, width - M.right);
  vertex(xStart, yBottom);

  if (useSpline) {
    curveVertex(xStart, yBottom);

    for (var i = startIdx; i <= endIdx; i += step) {
      var d = data[i];
      var x = map(d.time, tMin, tMax, M.left, width - M.right);
      var y = map(d.val, yMin, yMax, yBottom, yTop);
      curveVertex(x, y);
    }

    var dLast = data[endIdx];
    var xEnd = map(dLast.time, tMin, tMax, M.left, width - M.right);
    curveVertex(xEnd, yBottom);
    vertex(xEnd, yBottom);
  } else {
    for (var i = startIdx; i <= endIdx; i += step) {
      var d = data[i];
      var x = map(d.time, tMin, tMax, M.left, width - M.right);
      var y = map(d.val, yMin, yMax, yBottom, yTop);
      vertex(x, y);
    }
    var dLast = data[endIdx];
    var xEnd = map(dLast.time, tMin, tMax, M.left, width - M.right);
    vertex(xEnd, yBottom);
  }

  endShape();
}

function drawPeakMarkers(tMin, tMax, yMinU, yMaxU, yTopU, yBottomU, yMinL, yMaxL, yTopL, yBottomL) {
  if (!AppState.showPeaks || !AppState.analyzer.peaks || AppState.analyzer.peaks.length === 0) return;
  for (var pIdx = 0; pIdx < AppState.analyzer.peaks.length; pIdx++) {
    var p = AppState.analyzer.peaks[pIdx];

    if (p.time < tMin && p.onsetTime < tMin &&
        (p.recoveryIndex === -1 || p.recoveryIndex === undefined ||
         !AppState.analyzer.phasic || !AppState.analyzer.phasic[p.recoveryIndex] ||
         AppState.analyzer.phasic[p.recoveryIndex].time < tMin)) {
      continue;
    }
    if (p.onsetTime > tMax) continue;

    var xPeak  = map(p.time, tMin, tMax, M.left, width - M.right);
    var xOnset = map(p.onsetTime, tMin, tMax, M.left, width - M.right);

    var yFilteredPeak = map(AppState.analyzer.filtered[p.index].val, yMinU, yMaxU, yBottomU, yTopU);
    var yPhasicPeak   = map(p.value, yMinL, yMaxL, yBottomL, yTopL);
    var yPhasicOnset  = map(p.onsetValue, yMinL, yMaxL, yBottomL, yTopL);

    var isActive  = (pIdx === AppState.activePeakIndex);
    var isHovered = (AppState.hoveredIndex >= p.onsetIndex && AppState.hoveredIndex <= p.index);

    if (isActive || isHovered) {
      fill(244, 63, 94, 75);
      noStroke();
      beginShape();
      vertex(xOnset, yBottomL);
      for (var i = p.onsetIndex; i <= p.index; i++) {
        var xVal = map(AppState.analyzer.phasic[i].time, tMin, tMax, M.left, width - M.right);
        var yVal = map(AppState.analyzer.phasic[i].val, yMinL, yMaxL, yBottomL, yTopL);
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

    if (xPeak >= M.left && xPeak <= width - M.right) {
      if (AppState.viewDuration < 300 || isActive || isHovered) {
        noStroke();
        fill(244, 63, 94);
        textSize(10);
        textStyle(BOLD);
        textAlign(CENTER, BOTTOM);
        text('#' + (pIdx + 1), xPeak, yFilteredPeak - 8);
        textStyle(NORMAL);
      }
    }
  }
}

function handleScrubber(tMin, tMax, yMinU, yMaxU, yBottomU, yMinL, yMaxL, yTopL, yBottomL) {
  if (mouseX < M.left || mouseX > width - M.right || AppState.isDragging) {
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

  var hoverTime = map(mouseX, M.left, width - M.right, tMin, tMax);
  AppState.hoveredIndex = findClosestIndex(hoverTime);
  if (AppState.hoveredIndex === -1) return;

  var dRaw = AppState.analyzer.raw[AppState.hoveredIndex];
  if (!dRaw) return;

  if (dRaw.hasGps && !isNaN(dRaw.lat) && !isNaN(dRaw.lon)) {
    if (AppState.mapManager) AppState.mapManager.setScrubPosition(dRaw.lat, dRaw.lon, true);
  } else {
    if (AppState.mapManager) AppState.mapManager.setScrubPosition(NaN, NaN);
  }

  var dFilt   = AppState.analyzer.filtered[AppState.hoveredIndex];
  var dTonic  = AppState.analyzer.tonic[AppState.hoveredIndex];
  var dPhasic = AppState.analyzer.phasic[AppState.hoveredIndex];

  var xScrub = map(dRaw.time, tMin, tMax, M.left, width - M.right);

  stroke(255, 255, 255, 50);
  strokeWeight(1);
  line(xScrub, M.top, xScrub, yBottomL);

  var yU = map(dFilt.val, yMinU, yMaxU, yBottomU, M.top);
  var yL = map(dPhasic.val, yMinL, yMaxL, yBottomL, yTopL);

  stroke(14, 165, 233);
  fill(14, 165, 233);
  circle(xScrub, yU, 6);

  stroke(16, 185, 129);
  fill(16, 185, 129);
  circle(xScrub, yL, 6);

  drawTooltip(dRaw.time, dRaw.val, dFilt.val, dTonic.val, dPhasic.val);
}

function drawTooltip(time, rawVal, filtVal, tonicVal, phasicVal) {
  var pad = 12;
  var boxW = 190;
  var boxH = 120;

  var boxX = mouseX + 15;
  if (boxX + boxW > width - M.right) {
    boxX = mouseX - boxW - 15;
  }

  var boxY = mouseY - 40;
  boxY = constrain(boxY, M.top, height - M.bottom - boxH);

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
  var startY = boxY + pad + 18;
  var spacing = 18;

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
