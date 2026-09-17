/**
 * GSRRenderer — peak markers (+ pulse-ring animation) and memorable-event
 * hotspot markers.
 * Object-augment split from renderer.js: loaded after renderer.js, adds
 * these methods to the shared GSRRenderer object.
 *
 * Reads the module-level getQualityColor()/EXCLUDED_STYLE/NORMAL_DASH from
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
import { ResponseDynamics } from '../signal/response_dynamics.mjs';
import {
  EXCLUDED_STYLE,
  GSRRenderer,
  getQualityColor,
  NORMAL_DASH,
} from './renderer.mjs';

export const __methods = {
  /**
   * Pixel-per-unit scale factors shared by drawPeakMarkers()/drawHotspotMarkers()
   * (and their _computePeakScreenPos() calls) — pulled out since both methods
   * computed byte-identical xScale/yScaleU/yScaleL formulas independently
   * before, with no structural guarantee they'd stay in sync if one changed.
   * @private
   */
  _computeGraphScales(
    tMin,
    tMax,
    yMinU,
    yMaxU,
    yTopU,
    yBottomU,
    yMinL,
    yMaxL,
    yTopL,
    yBottomL,
  ) {
    const tSpan = tMax - tMin;
    const xSpan = width - GSR_CONST.MARGIN.right - GSR_CONST.MARGIN.left;
    return {
      xScale: tSpan > 0 ? xSpan / tSpan : 0,
      yScaleU: yMaxU - yMinU > 0 ? (yTopU - yBottomU) / (yMaxU - yMinU) : 0,
      yScaleL: yMaxL - yMinL > 0 ? (yTopL - yBottomL) / (yMaxL - yMinL) : 0,
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
    if (
      p.time < tMin &&
      p.onsetTime < tMin &&
      (p.recoveryIndex === -1 ||
        p.recoveryIndex === undefined ||
        !AppState.analyzer.phasic ||
        !AppState.analyzer.phasic[p.recoveryIndex] ||
        AppState.analyzer.phasic[p.recoveryIndex].time < tMin)
    ) {
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
  _computePeakScreenPos(
    p,
    tMin,
    scales,
    yMinU,
    yBottomU,
    yMinL,
    yBottomL,
    showLowerMarker,
    showUpperMarker,
    markerSeries,
  ) {
    const xPeak = GSR_CONST.MARGIN.left + (p.time - tMin) * scales.xScale;
    const xOnset = GSR_CONST.MARGIN.left + (p.onsetTime - tMin) * scales.xScale;
    // The "upper" marker normally sits on the Filtered curve; in a metric view
    // it sits on whatever series is plotted (markerSeries), at the peak's time —
    // the peak's µS amplitude has no meaning on a /min or z axis.
    const upperSeries = markerSeries?.[p.index]
      ? markerSeries
      : AppState.analyzer.filtered;
    let yFilteredPeak =
      yBottomU + (upperSeries[p.index].val - yMinU) * scales.yScaleU;
    const yPhasicPeak = showLowerMarker
      ? yBottomL + (p.value - yMinL) * scales.yScaleL
      : yFilteredPeak;
    const yPhasicOnset = showLowerMarker
      ? yBottomL + (p.onsetValue - yMinL) * scales.yScaleL
      : yFilteredPeak;
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
   * quality-coloured dots (filled, not invisible) but with no onset marker or
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
  drawPeakMarkers(
    tMin,
    tMax,
    yMinU,
    yMaxU,
    yTopU,
    yBottomU,
    yMinL,
    yMaxL,
    yTopL,
    yBottomL,
    showLowerMarker,
    showUpperMarker,
    markerSeries,
  ) {
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

    if (
      !AppState.showPeaks ||
      !AppState.analyzer.peaks ||
      AppState.analyzer.peaks.length === 0
    )
      return;

    const scales = this._computeGraphScales(
      tMin,
      tMax,
      yMinU,
      yMaxU,
      yTopU,
      yBottomU,
      yMinL,
      yMaxL,
      yTopL,
      yBottomL,
    );

    for (let pIdx = 0; pIdx < AppState.analyzer.peaks.length; pIdx++) {
      const p = AppState.analyzer.peaks[pIdx];

      if (this._peakOutOfView(p, tMin, tMax)) continue;

      const { xPeak, xOnset, yFilteredPeak, yPhasicPeak, yPhasicOnset } =
        this._computePeakScreenPos(
          p,
          tMin,
          scales,
          yMinU,
          yBottomU,
          yMinL,
          yBottomL,
          showLowerMarker,
          showUpperMarker,
          markerSeries,
        );

      const isActive = pIdx === AppState.activePeakIndex;
      const isHovered =
        AppState.hoveredIndex >= p.onsetIndex &&
        AppState.hoveredIndex <= p.index;
      const isEmphasized = isActive || isHovered;

      const canvasBg = this.getThemeColor('--canvas-bg', '#ffffff');

      const isExcluded = p.excluded === true;
      const qScore = p.qualityScore !== undefined ? p.qualityScore : 0.5;
      let peakColor = isExcluded
        ? EXCLUDED_STYLE.color
        : getQualityColor(qScore);
      if (
        !isExcluded &&
        (AppState.graphView === 'responseDynamics' ||
          AppState.lowerGraphMode === 'responseDynamics') &&
        p.speedLabel
      ) {
        const RD =
          typeof ResponseDynamics !== 'undefined' ? ResponseDynamics : null;
        peakColor = RD
          ? RD.getSpeedColor(p.speedLabel)
          : GSR_CONST.SPARSEDA_SPEED_COLORS
            ? GSR_CONST.SPARSEDA_SPEED_COLORS[p.speedLabel]
            : peakColor;
      }
      const lineClr = isExcluded ? EXCLUDED_STYLE.lineColor : peakColor;
      const dashPat = isExcluded ? EXCLUDED_STYLE.dash : NORMAL_DASH;
      const dotWt = isExcluded ? EXCLUDED_STYLE.dotWeight : 1.2;
      const markerWt = isExcluded
        ? EXCLUDED_STYLE.weight
        : isEmphasized
          ? 1.5
          : 1;

      // Resting-state dot fill/stroke: a visibly-coloured (not fully
      // transparent) small dot so the full peak census reads as present at a
      // glance, while staying clearly lighter-weight than a hotspot (which
      // is solid-filled, larger, and carries a shaded region + connector).
      const restStroke = isExcluded ? color(lineClr) : color(`${peakColor}d0`);
      const restFill = isExcluded ? color(canvasBg) : color(`${peakColor}70`);

      // Shaded elevated region, onset dot, and connector line: only when
      // hovered/active, same as before — but now the onset dot and line are
      // ALSO skipped entirely in the resting state (previously always drawn)
      // to keep hundreds of resting markers from reading as visual noise.
      if (showLowerMarker && isEmphasized) {
        const fillClr = isExcluded
          ? color(lineClr + EXCLUDED_STYLE.fillAlpha)
          : color(`${peakColor}4b`);
        this._drawPeakShadedRegion(
          p,
          tMin,
          scales,
          yBottomL,
          yMinL,
          fillClr,
          xOnset,
          xPeak,
        );

        stroke(
          isExcluded
            ? lineClr
            : this.getThemeColor('--color-phasic', '#008f3c'),
        );
        strokeWeight(dotWt);
        fill(canvasBg);
        circle(xOnset, yPhasicOnset, 6);

        if (drawUpper) {
          stroke(
            isExcluded
              ? color(lineClr + EXCLUDED_STYLE.lineAlpha)
              : color(`${peakColor}3c`),
          );
          strokeWeight(1);
          drawingContext.setLineDash(dashPat);
          line(xPeak, yFilteredPeak, xPeak, yPhasicPeak);
          drawingContext.setLineDash([]);
        }
      }

      if (showLowerMarker) {
        // Minor resting dot: small, visibly-coloured fill; solid + larger
        // only when hovered/active (exclusion state stays legible via its
        // own grey hollow treatment even at rest).
        stroke(
          isEmphasized
            ? isExcluded
              ? color(lineClr)
              : color(peakColor)
            : restStroke,
        );
        strokeWeight(markerWt);
        fill(
          isActive
            ? isExcluded
              ? color(lineClr)
              : color(peakColor)
            : restFill,
        );
        circle(xPeak, yPhasicPeak, isEmphasized ? 7 : 4);
      }

      // Upper-graph marker (on the Filtered curve) — drawn in every view that
      // shows that curve (Signal, Both, and the peak-density/AUC/etc. modes
      // where peaks only appear up top). Skipped in the single Phasic view,
      // whose only curve is the phasic one the lower marker already sits on.
      if (drawUpper) {
        stroke(
          isEmphasized
            ? isExcluded
              ? color(lineClr)
              : color(peakColor)
            : restStroke,
        );
        strokeWeight(markerWt);
        fill(
          isActive
            ? isExcluded
              ? color(lineClr)
              : color(peakColor)
            : restFill,
        );
        circle(xPeak, yFilteredPeak, isEmphasized ? 7 : 4);
      }

      if (
        xPeak >= GSR_CONST.MARGIN.left &&
        xPeak <= width - GSR_CONST.MARGIN.right
      ) {
        AppState._peakClickTargets.push({
          idx: pIdx,
          x: xPeak,
          yPhasic: yPhasicPeak,
          yFiltered: yFilteredPeak,
          r: 10,
        });
        if (AppState.viewDuration < 300 || isActive || isHovered) {
          noStroke();
          fill(isExcluded ? color(EXCLUDED_STYLE.color) : peakColor);
          textSize(10);
          textStyle(BOLD);
          textAlign(CENTER, BOTTOM);
          let labelText = p.label || `#${pIdx + 1}`;
          if (labelText.length > 22) {
            labelText = `${labelText.substring(0, 19)}...`;
          }
          text(labelText, xPeak, yFilteredPeak - 8);
          textStyle(NORMAL);
        }
      }

      // ── On-canvas exclude ✕ / ＋ button (only when scrubbing near) ──
      if (
        isHovered &&
        xPeak >= GSR_CONST.MARGIN.left &&
        xPeak <= width - GSR_CONST.MARGIN.right
      ) {
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
    if (this._pulseOverlay?.isConnected) return this._pulseOverlay;
    const container = document.getElementById('canvasContainer');
    if (!container) return null;
    const overlay = document.createElement('div');
    overlay.id = 'hotspotPulseOverlay';
    overlay.style.cssText =
      'position:absolute; top:0; left:0; width:100%; height:100%; pointer-events:none; overflow:hidden;';
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
    el.style.width = `${d}px`;
    el.style.height = `${d}px`;
    el.style.left = `${x - d / 2}px`;
    el.style.top = `${y - d / 2}px`;
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
   * peak object → its index in analyzer.peaks, memoised on the analyzer.
   *
   * Rebuilt only when the peaks array *reference* changes. analyzer.peaks is
   * always reassigned wholesale on a re-analysis and never spliced/sorted/
   * emptied in place (see analyzer.js), so identity is a sound cache key. Lets
   * drawHotspotMarkers() resolve memorableEvents entries — which are direct
   * peak object references — without a per-frame O(n) indexOf scan.
   */
  _peakIndexByObject(analyzer) {
    if (
      analyzer._peakIndexMap &&
      analyzer._peakIndexMapRef === analyzer.peaks
    ) {
      return analyzer._peakIndexMap;
    }
    const map = new Map();
    const peaks = analyzer.peaks;
    for (let i = 0; i < peaks.length; i++) map.set(peaks[i], i);
    analyzer._peakIndexMap = map;
    analyzer._peakIndexMapRef = peaks;
    return map;
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
  drawHotspotMarkers(
    tMin,
    tMax,
    yMinU,
    yMaxU,
    yTopU,
    yBottomU,
    yMinL,
    yMaxL,
    yTopL,
    yBottomL,
    showLowerMarker,
    showUpperMarker,
    markerSeries,
  ) {
    if (showLowerMarker === undefined) showLowerMarker = true;
    const drawUpper = showUpperMarker !== false; // see drawPeakMarkers()
    if (
      !AppState.showHotspots ||
      !AppState.analyzer.memorableEvents ||
      AppState.analyzer.memorableEvents.length === 0
    ) {
      this.clearPulseRings();
      return;
    }

    const scales = this._computeGraphScales(
      tMin,
      tMax,
      yMinU,
      yMaxU,
      yTopU,
      yBottomU,
      yMinL,
      yMaxL,
      yTopL,
      yBottomL,
    );

    const hotspotColor = this.getThemeColor('--color-hotspot', '#ff1744');
    const colorPhasic = this.getThemeColor('--color-phasic', '#008f3c');
    const canvasBg = this.getThemeColor('--canvas-bg', '#ffffff');

    // Pulse-ring positions are synced into DOM elements (see _syncPulseRing())
    // that animate via styles.css's own @keyframes pulse-glow instead of being
    // repainted into the canvas every frame — this set tracks which of those
    // elements are still current so stale ones (hotspot scrolled out of view,
    // track switched) get pruned at the end of this pass.
    const seenPulseKeys = new Set();

    // peak object → peaks[] index, so the per-hotspot realIdx lookup below is
    // O(1) instead of a per-frame indexOf scan (see _peakIndexByObject()).
    const peakIndexMap = this._peakIndexByObject(AppState.analyzer);

    for (const p of AppState.analyzer.memorableEvents) {
      if (this._peakOutOfView(p, tMin, tMax)) continue;
      // Excluded peaks fall back to drawPeakMarkers()'s own excluded styling
      // (dimmed, dashed) instead of also glowing as a hotspot star — a
      // hotspot IS a peak (memorableEvents is a subset of analyzer.peaks), so
      // excluding it must stop it reading as curated/important here too.
      if (p.excluded) continue;

      const { xPeak, xOnset, yFilteredPeak, yPhasicPeak, yPhasicOnset } =
        this._computePeakScreenPos(
          p,
          tMin,
          scales,
          yMinU,
          yBottomU,
          yMinL,
          yBottomL,
          showLowerMarker,
          showUpperMarker,
          markerSeries,
        );

      const realIdx = peakIndexMap.has(p) ? peakIndexMap.get(p) : -1;
      const isActive = realIdx !== -1 && realIdx === AppState.activePeakIndex;

      if (showLowerMarker) {
        this._drawPeakShadedRegion(
          p,
          tMin,
          scales,
          yBottomL,
          yMinL,
          color(`${hotspotColor}4b`),
          xOnset,
          xPeak,
        );

        stroke(colorPhasic);
        strokeWeight(1.5);
        fill(canvasBg);
        circle(xOnset, yPhasicOnset, isActive ? 8 : 5);

        if (drawUpper) {
          stroke(color(`${hotspotColor}78`));
          strokeWeight(1);
          drawingContext.setLineDash(NORMAL_DASH);
          line(xPeak, yFilteredPeak, xPeak, yPhasicPeak);
          drawingContext.setLineDash([]);
        }

        const lowerKey = `${realIdx}:lower`;
        this._syncPulseRing(
          lowerKey,
          xPeak,
          yPhasicPeak,
          isActive ? 9 : 6,
          hotspotColor,
        );
        seenPulseKeys.add(lowerKey);
        stroke(hotspotColor);
        strokeWeight(2);
        fill(isActive ? color(hotspotColor) : color(canvasBg));
        circle(xPeak, yPhasicPeak, isActive ? 9 : 6);
      }

      if (drawUpper) {
        const upperKey = `${realIdx}:upper`;
        this._syncPulseRing(
          upperKey,
          xPeak,
          yFilteredPeak,
          isActive ? 9 : 6,
          hotspotColor,
        );
        seenPulseKeys.add(upperKey);
        stroke(hotspotColor);
        strokeWeight(2);
        fill(isActive ? color(hotspotColor) : color(canvasBg));
        circle(xPeak, yFilteredPeak, isActive ? 9 : 6);
      }

      if (
        xPeak >= GSR_CONST.MARGIN.left &&
        xPeak <= width - GSR_CONST.MARGIN.right &&
        realIdx !== -1
      ) {
        AppState._peakClickTargets.push({
          idx: realIdx,
          x: xPeak,
          yPhasic: yPhasicPeak,
          yFiltered: yFilteredPeak,
          r: 10,
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
        // unlabelled, or an unreadable smudge, even though it was being drawn.
        text('★', xPeak, yFilteredPeak - 20); // small star marks it as a hotspot, not a plain peak
        textStyle(NORMAL);
      }
    }

    this._prunePulseRings(seenPulseKeys);
  },
};

Object.assign(GSRRenderer, __methods);
