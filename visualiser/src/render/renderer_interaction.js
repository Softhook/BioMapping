/**
 * GSRRenderer — click/hit-testing (peak targets, the exclude button) and
 * graph-scrub hover handling.
 * Object-augment split from renderer.js: loaded after renderer.js, adds
 * these methods to the shared GSRRenderer object.
 *
 * Reads the module-level EXCLUDE_BTN constant from renderer.js's own header
 * — see the dual-mode note below for how that stays resolvable under plain
 * require().
 *
 * Dual-mode export (like renderer.js's own tail): under a browser <script>
 * tag or the shared vm context (tests/support/boot_app.js), GSRRenderer is a
 * live global and this assigns straight onto it. Under plain CommonJS
 * require() (several dedicated band/curve test files require renderer.js
 * directly instead of booting the whole app), module.exports hands back the
 * method object instead so the caller can Object.assign it onto the
 * freshly-required object itself. The require-branch below copies renderer.js's
 * entire export surface onto `global` rather than naming individual identifiers
 * — renderer.js's module.exports is the single source of truth for what's
 * available bare; a name missing there is a bug in renderer.js's exports, not
 * something to patch around here.
 */
(function () {
  const __methods = {

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
    let lowerCfg = (GSR_CONST.LOWER_GRAPH_MODES && GSR_CONST.LOWER_GRAPH_MODES[lowerMode]) ||
                     { label: 'Phasic (SCR)', unit: 'μS', decimals: 4, colorVar: '--color-phasic', colorDefault: '#008f3c' };
    // Matching pursuit's driver and cvxEDA's driver are different physical
    // quantities (µS vs µS/s — see GSR_CONST.DRIVER_UNIT_BY_ALGORITHM's
    // comment); pick the tooltip's unit/decimals by whichever detector
    // actually produced the currently-plotted series.
    if (lowerMode === 'phasicDriver' && GSR_CONST.DRIVER_UNIT_BY_ALGORITHM) {
      const driverCfg = GSR_CONST.DRIVER_UNIT_BY_ALGORITHM[AppState.analyzer._driverAlgorithm] ||
        GSR_CONST.DRIVER_UNIT_BY_ALGORITHM.matching_pursuit;
      lowerCfg = { ...lowerCfg, unit: driverCfg.unit, decimals: driverCfg.decimals };
    }
    const lowerSeries = (lowerMode === 'responseDynamics')
      ? AppState.analyzer.phasic
      : (AppState.analyzer[lowerMode] || AppState.analyzer.phasic);
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
    // 'Phasic AUC' becomes 'Phasic AUC (ISCR)' when the series integrated the
    // deconvolved driver (see analyzer.computePhasicAUC).
    const lowerLabel = (lowerMode === 'responseDynamics')
      ? 'Dynamics:'
      : (lowerCfg.label + (lowerMode === 'phasicAUC' && AppState.analyzer.phasicAUCIsISCR ? ' (ISCR)' : '') + ':');
    const textSec = this.getThemeColor('--text-secondary', '#444444');
    let extraValStr = dLower.val.toFixed(lowerCfg.decimals) + ' ' + lowerCfg.unit;
    let extraColor = colorLower;
    if (lowerMode === 'responseDynamics') {
      const dynSeries = AppState.analyzer.responseDynamics || [];
      const dDyn = dynSeries[AppState.hoveredIndex];
      const dynVal = dDyn ? dDyn.val : 0;
      const RD = (typeof ResponseDynamics !== 'undefined') ? ResponseDynamics : null;
      if (RD) {
        const tip = RD.formatTooltip(dynVal, textSec);
        extraValStr = tip.valueStr;
        extraColor = tip.color;
      } else if (dynVal <= 0) {
        extraValStr = 'Resting';
        extraColor = textSec;
      } else {
        extraValStr = `${dynVal.toFixed(2)}x`;
      }
    }
    const extraMetric = (lowerMode !== 'phasic') ? {
      label: lowerLabel,
      color: extraColor,
      valueStr: extraValStr
    } : null;

    // Extra tooltip rows for whichever background-band overlays are on —
    // one {label, color, valueStr} entry each, in display order. Drawing a
    // new overlay's row is just pushing another entry here; drawTooltip()
    // itself doesn't need to know how many there are or what they mean.
    const extraRows = [];
    if (extraMetric) extraRows.push(extraMetric);
    if (AppState.showOsmContext && dRaw) {
      const osmClass = this._classifyOsmContext(dRaw);
      if (osmClass) extraRows.push({ label: 'Context:', color: osmClass.color, valueStr: osmClass.label });
    }
    if (AppState.showNdviContext && dRaw) {
      const ndvi = this._ndviColorAt(AppState.analyzer, dRaw);
      if (ndvi) extraRows.push({ label: 'NDVI:', color: ndvi.color, valueStr: ndvi.value.toFixed(2) });
    }
    if (AppState.showEmFogContext && dRaw) {
      const emFog = this._emFogColorAt(AppState.analyzer, dRaw);
      if (emFog) extraRows.push({ label: 'EM Fog:', color: emFog.color, valueStr: emFog.value.toFixed(1) });
    }

    this.drawTooltip(dRaw.time, dRaw.val, dFilt.val, dTonic.val, dPhasic.val, nearPeakInfo, extraRows);
  },

  };

  if (typeof module !== 'undefined' && module.exports) {
    // ES-module migration: renderer.js gets a temporary .mjs extension when
    // converted (convert_file.js --write), deleting the .js — same
    // resolution rule as boot_app.js's resolveFile().
    const rendererPath = require('fs').existsSync(require('path').join(__dirname, 'renderer.mjs'))
      ? './renderer.mjs' : './renderer.js';
    Object.assign(global, require(rendererPath));
    module.exports = __methods;
  } else {
    Object.assign(GSRRenderer, __methods);
  }
})();
