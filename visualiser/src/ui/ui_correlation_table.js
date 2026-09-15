/**
 * GSRUI — environmental correlation table. Object-augment split from ui.js:
 * loaded immediately after ui.js, adds these methods to the shared GSRUI
 * object.
 *
 * Covers the shared regression-scatter canvas drawer (also used by
 * ui_road_profile.js), the scatter-plot env-variable dropdown sync, and the
 * sortable correlation-matrix table (walk-level meta-analysis results).
 */
(function () {
const __methods = {

  /**
   * Paint a scatter of (x, y) points with an OLS trend line and an R² badge
   * onto `canvas`. Pure drawing — caller supplies the fitted m, c, r2.
   *
   * Axes are clipped to the 2nd–98th percentile of each variable so a handful
   * of arousal spikes can't flatten the whole cloud; out-of-range points are
   * drawn clamped to the frame edge. Point opacity and radius scale down as
   * the sample grows, so a dense collective-mode cloud shows a density
   * gradient instead of a solid blob. When X is binary the OLS line (which is
   * just a difference of two means dressed up as a slope) is replaced by a
   * box-and-whisker per group.
   */
  drawRegressionScatter(canvas, xVals, yVals, m, c, r2, xLabel, yLabel, isBinaryX = false) {
    if (!canvas || typeof canvas.getContext !== 'function') return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const width = canvas.width;
    const height = canvas.height;

    const css = (typeof window !== 'undefined' && window.getComputedStyle)
      ? window.getComputedStyle(document.documentElement) : null;
    const themeColor = (name, fallback) => {
      const v = css ? css.getPropertyValue(name).trim() : '';
      return v || fallback;
    };
    const bg     = themeColor('--canvas-bg', '#ffffff');
    const axisC  = themeColor('--text-primary', '#111111');
    const textC  = themeColor('--canvas-text', '#444444');
    const trendC = themeColor('--primary-color', '#0055cc');

    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);

    if (xVals.length === 0) {
      ctx.fillStyle = textC;
      ctx.font = '12px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No data available', width / 2, height / 2);
      return;
    }

    const padL = 40;
    const padR = 15;
    const padT = 15;
    const padB = 30;

    // Robust axis bounds: clip to the 2nd–98th percentile (binary X keeps its
    // true 0..1 range). Points outside are clamped to the frame when plotted.
    const ySorted = [...yVals].sort((a, b) => a - b);
    let minX, maxX;
    if (isBinaryX) {
      minX = -0.5; maxX = 1.5;
    } else {
      const xSorted = [...xVals].sort((a, b) => a - b);
      minX = GSRUI._percentileSorted(xSorted, 0.02);
      maxX = GSRUI._percentileSorted(xSorted, 0.98);
    }
    let minY = GSRUI._percentileSorted(ySorted, 0.02);
    let maxY = GSRUI._percentileSorted(ySorted, 0.98);

    if (maxX <= minX) maxX = minX + 1;
    if (maxY <= minY) maxY = minY + 1;

    const rangeX = maxX - minX;
    const rangeY = maxY - minY;

    // Draw axis frame
    ctx.strokeStyle = axisC;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(padL, padT);
    ctx.lineTo(padL, height - padB);
    ctx.lineTo(width - padR, height - padB);
    ctx.stroke();

    const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
    const plotL = padL, plotR = width - padR, plotT = padT, plotBt = height - padB;
    const mapX = (x) => clamp(padL + ((x - minX) / rangeX) * (plotR - plotL), plotL, plotR);
    const mapY = (y) => clamp(plotBt - ((y - minY) / rangeY) * (plotBt - plotT), plotT, plotBt);

    // Density-aware point style: with tens of thousands of samples a solid
    // fill hides all structure, so fade and shrink as n grows.
    const n = xVals.length;
    const alpha = Math.max(0.04, Math.min(0.6, 35 / Math.sqrt(n)));
    const radius = n > 8000 ? 1.4 : (n > 2000 ? 1.9 : 2.5);
    const jitterAmp = isBinaryX ? 0.16 : 0;

    ctx.fillStyle = `rgba(255, 123, 0, ${alpha.toFixed(3)})`;
    for (let i = 0; i < n; i++) {
      // Deterministic per-point jitter (index hash) so binary columns don't
      // shimmer when the plot is redrawn on resize / tab switch.
      const jit = jitterAmp ? (((i * 2654435761) % 1000) / 1000 - 0.5) * 2 * jitterAmp : 0;
      const cx = mapX(xVals[i] + jit);
      const cy = mapY(yVals[i]);
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, 2 * Math.PI);
      ctx.fill();
    }

    if (isBinaryX) {
      // Box-and-whisker per group (median, IQR box, 10–90th-pct whiskers).
      const boxHalf = Math.min(26, (mapX(1) - mapX(0)) * 0.28);
      for (const g of [0, 1]) {
        const col = [];
        for (let i = 0; i < n; i++) if (xVals[i] === g) col.push(yVals[i]);
        if (col.length < 3) continue;
        col.sort((a, b) => a - b);
        const q1 = GSRUI._percentileSorted(col, 0.25);
        const md = GSRUI._percentileSorted(col, 0.50);
        const q3 = GSRUI._percentileSorted(col, 0.75);
        const w1 = GSRUI._percentileSorted(col, 0.10);
        const w2 = GSRUI._percentileSorted(col, 0.90);
        const cx = mapX(g);
        ctx.strokeStyle = trendC;
        ctx.fillStyle = 'rgba(0, 85, 204, 0.10)';
        ctx.lineWidth = 1.5;
        ctx.fillRect(cx - boxHalf, mapY(q3), boxHalf * 2, mapY(q1) - mapY(q3));
        ctx.strokeRect(cx - boxHalf, mapY(q3), boxHalf * 2, mapY(q1) - mapY(q3));
        ctx.beginPath();                              // median
        ctx.moveTo(cx - boxHalf, mapY(md)); ctx.lineTo(cx + boxHalf, mapY(md));
        ctx.moveTo(cx, mapY(q3)); ctx.lineTo(cx, mapY(w2));   // whiskers
        ctx.moveTo(cx, mapY(q1)); ctx.lineTo(cx, mapY(w1));
        ctx.moveTo(cx - boxHalf * 0.5, mapY(w2)); ctx.lineTo(cx + boxHalf * 0.5, mapY(w2));
        ctx.moveTo(cx - boxHalf * 0.5, mapY(w1)); ctx.lineTo(cx + boxHalf * 0.5, mapY(w1));
        ctx.stroke();
      }
    } else {
      // OLS trendline across the visible X range (clipped to the frame in Y)
      ctx.strokeStyle = trendC;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(mapX(minX), mapY(m * minX + c));
      ctx.lineTo(mapX(maxX), mapY(m * maxX + c));
      ctx.stroke();
    }

    // Text labels
    ctx.fillStyle = textC;
    ctx.font = '9px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(xLabel, padL + (width - padL - padR)/2, height - 6);

    ctx.save();
    ctx.translate(10, padT + (height - padT - padB)/2);
    ctx.rotate(-Math.PI/2);
    ctx.fillText(yLabel, 0, 0);
    ctx.restore();

    ctx.fillStyle = textC;
    ctx.font = '8px Inter, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(isBinaryX ? 'no' : minX.toFixed(1), padL, height - padB + 10);
    ctx.textAlign = 'right';
    ctx.fillText(isBinaryX ? 'yes' : maxX.toFixed(1), width - padR, height - padB + 10);

    ctx.textAlign = 'right';
    ctx.fillText(minY.toFixed(2), padL - 5, height - padB);
    ctx.fillText(maxY.toFixed(2), padL - 5, padT + 5);

    // Fit badge in top-right corner: R² for a continuous X, |r| for a binary
    // one (there R² is just the squared point-biserial correlation).
    ctx.font = 'bold 10px Inter, sans-serif';
    ctx.textAlign = 'right';
    const badgeText = isBinaryX
      ? 'r = ' + (Math.sign(m) * Math.sqrt(Math.max(0, Math.min(1, r2)))).toFixed(3)
      : 'R² = ' + r2.toFixed(3);
    const bw = ctx.measureText(badgeText).width;
    ctx.fillStyle = 'rgba(0, 85, 204, 0.08)';
    ctx.fillRect(width - padR - bw - 10, padT + 2, bw + 14, 18);
    ctx.strokeStyle = 'rgba(0, 85, 204, 0.25)';
    ctx.lineWidth = 1;
    ctx.strokeRect(width - padR - bw - 10, padT + 2, bw + 14, 18);
    ctx.fillStyle = trendC;
    ctx.textAlign = 'right';
    ctx.fillText(badgeText, width - padR - 3, padT + 15);
  },

  /**
   * Rebuild the #scatterEnvMetric <option> list from GSR_CONST.OSM_METRICS
   * (continuous + binary) plus NDVI, EM Fog and Walking Speed when present, keeping
   * it in step with the correlation-matrix feature set. Preserves the current
   * selection when still valid; no-ops when the option set is unchanged.
   */
  syncScatterEnvOptions(hasEmFog, hasSpeed = false, hasNdvi = false) {
    const sel = document.getElementById('scatterEnvMetric');
    if (!sel) return;
    const opts = GSR_CONST.OSM_METRICS
      .filter(m => m.kind === 'continuous' || m.kind === 'binary')
      .map(m => ({ value: m.field, label: m.unit ? `${m.label} (${m.unit})` : m.label }));
    if (hasNdvi) {
      opts.push({ value: 'ndvi_50m', label: 'NDVI (50m Buffer)' });
      opts.push({ value: 'ndvi', label: 'Point NDVI' });
    }
    if (hasEmFog) opts.push({ value: 'em_fog', label: 'EM Fog Index (0-100)' });
    if (hasSpeed) opts.push({ value: 'speed', label: 'Walking Speed (m/s)' });

    const signature = opts.map(o => o.value).join(',');
    if (sel.dataset && sel.dataset.optionSig === signature) return; // already current
    const prev = sel.value;
    sel.innerHTML = opts.map(o => `<option value="${o.value}">${o.label}</option>`).join('');
    sel.value = opts.some(o => o.value === prev) ? prev : opts[0].value;
    if (sel.dataset) sel.dataset.optionSig = signature;
  },

  /**
   * Effect-size band for a correlation coefficient — the primary cue in the
   * correlation table, since with a large n a negligible r can still be
   * "significant". Thresholds |r| .10 / .20 / .30 follow Gignac & Szodorai
   * (2016) for individual-differences research.
   * negligible <.10 · small .10–.20 · moderate .20–.30 · strong ≥.30.
   */
  correlationBand(r) {
    const a = Math.abs(r);
    if (!(a >= 0.10)) return { key: 'negligible', label: 'negligible' };
    if (a < 0.20) return { key: 'small', label: 'small' };
    if (a < 0.30) return { key: 'moderate', label: 'moderate' };
    return { key: 'strong', label: 'strong' };
  },

  /**
   * Sort the Correlation Matrix table by a column key ('name'|'rPhasic'|'rTonic'|'rPeaks'|'qPhasic'|'qTonic'|'qPeaks'|'interpretation').
   */
  sortCorrelationTable(col) {
    if (!col) return;
    if (AppState.corrSortColumn === col) {
      AppState.corrSortDirection = (AppState.corrSortDirection === 'asc') ? 'desc' : 'asc';
    } else {
      AppState.corrSortColumn = col;
      AppState.corrSortDirection = (col === 'rPhasic' || col === 'rTonic' || col === 'rPeaks') ? 'desc' : 'asc';
    }
    const cacheTarget = (AppState.viewMode === 'single') ? AppState.analyzer : AppState.collectiveManager;
    if (cacheTarget && cacheTarget._cachedEnvStats) {
      const stats = cacheTarget._cachedEnvStats;
      const allActive = (AppState.viewMode === 'single')
        ? (AppState.analyzer ? [{ id: AppState.activeTrackId, analyzer: AppState.analyzer }] : [])
        : (AppState.collectiveManager ? AppState.collectiveManager.getActiveTracks() : []);
      this.renderCorrelationTable(stats.correlationMatrix, stats.trackCount, allActive.length);
    }
  },

  /**
   * Update header icons and classes on correlationTable according to active sort state.
   */
  updateCorrelationTableSortHeaders() {
    if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return;
    const table = document.getElementById('correlationTable');
    if (!table || typeof table.querySelectorAll !== 'function') return;
    const ths = table.querySelectorAll('thead th.sortable');
    const curCol = AppState.corrSortColumn;
    const curDir = AppState.corrSortDirection || 'asc';

    ths.forEach(th => {
      const col = th.dataset.sort;
      const icon = th.querySelector('.sort-icon');
      if (col === curCol) {
        th.classList.remove('sort-asc', 'sort-desc');
        th.classList.add(curDir === 'desc' ? 'sort-desc' : 'sort-asc');
        if (icon) {
          icon.className = 'fa-solid ' + (curDir === 'desc' ? 'fa-sort-down' : 'fa-sort-up') + ' sort-icon';
        }
      } else {
        th.classList.remove('sort-asc', 'sort-desc');
        if (icon) {
          icon.className = 'fa-solid fa-sort sort-icon';
        }
      }
    });
  },

  /**
   * Render the cached correlation matrix to HTML. Effect-size band leads;
   * significance (or, with too few walks, effect size alone) only qualifies it.
   */
  renderCorrelationTable(matrix, enrichedWalks, totalWalks) {
    const tbody = document.querySelector('#correlationTable tbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    const used = enrichedWalks || (matrix.length ? matrix[0].featureWalks : 1);
    const loaded = totalWalks || used;
    // A cell's method is per channel; 'meta'/'single' carry a real verdict,
    // 'metaProvisional'/'fewWalks' are effect-size-only.
    const isTested = (m) => m === 'meta' || m === 'single';

    const noteEl = document.getElementById('correlationMethodNote');
    if (noteEl) {
      const anyMeta = matrix.some(r => r.mPhasic === 'meta' || r.mTonic === 'meta' || r.mPeaks === 'meta');
      // How many of the used walks each varying factor actually varied in.
      const ks = matrix.filter(r => r.hasVariance)
        .map(r => Math.max(r.kPhasic || 0, r.kTonic || 0, r.kPeaks || 0));
      const kLo = ks.length ? Math.min(...ks) : 0;
      const kHi = ks.length ? Math.max(...ks) : 0;
      const kRange = kLo === kHi ? `${kHi}` : `${kLo}–${kHi}`;

      const notEnriched = loaded > used
        ? `<strong>${used} of your ${loaded} walks are OSM-enriched</strong> — the analysis uses those ${used}; enrich the rest from the OSM panel to include them. `
        : '';

      if (used === 1) {
        noteEl.innerHTML = notEnriched + 'Single walk: <em>r</em> and <em>q</em> come from one recording, corrected for serial autocorrelation. Add walks to test whether an effect replicates.';
      } else if (anyMeta) {
        noteEl.innerHTML = notEnriched +
          `<strong>${used} walks analysed.</strong> <em>q</em> tests whether an effect is <strong>consistent across walks</strong> ` +
          `(random-effects meta-analysis — per-walk <em>r</em> weighted by its effective sample size, DerSimonian–Laird heterogeneity). <em>r</em> is the typical per-walk value. ` +
          `A "<em>k / ${used}</em>" tag means the factor varied enough to correlate in only <em>k</em> of the ${used} — need 5 for a verdict. ` +
          `A "<em>· mixed</em>" tag (hover any chip for the exact I² %) means the walks actively <strong>disagree</strong> in size or direction — a small pooled <em>r</em> there isn't the same finding as walks that quietly agree there's nothing.`;
      } else {
        noteEl.innerHTML = notEnriched +
          `<strong>${used} walks analysed</strong>, but each factor varied enough to correlate in only <strong>${kRange} of ${used}</strong> ` +
          `(the "<em>k / ${used}</em>" tag) — need 5 for a consistency test, so no <em>q</em> yet. <em>r</em> is the typical per-walk value. ` +
          `A walk only counts toward a factor if that factor changes during it — short walks, and walks that stay in one kind of place, don't.`;
      }
    }

    const formatP = (p) => {
      if (p < 0.001) return '<0.001';
      if (p < 0.01) return p.toFixed(4);
      return p.toFixed(3);
    };

    const cap = (s) => s[0].toUpperCase() + s.slice(1);
    const dirWord = (r) => (r > 0 ? 'higher' : 'lower');

    // Leads with the effect-size word so a reliable-but-tiny correlation
    // reads as "negligible", not as a finding.
    const getInterpretation = (row) => {
      if (!row.hasVariance) return 'Not enough variation to measure — this factor barely changes along the route';
      const chans = [
        { q: row.qPhasic, p: row.pPhasic, r: row.rPhasic, m: row.mPhasic, k: row.kPhasic, i2: row.i2Phasic, name: 'momentary arousal' },
        { q: row.qPeaks,  p: row.pPeaks,  r: row.rPeaks,  m: row.mPeaks,  k: row.kPeaks,  i2: row.i2Peaks,  name: 'arousal-response rate' },
        { q: row.qTonic,  p: row.pTonic,  r: row.rTonic,  m: row.mTonic,  k: row.kTonic,  i2: row.i2Tonic,  name: 'baseline arousal' },
      ];
      const byEffect = (a, b) => Math.abs(b.r) - Math.abs(a.r);

      const sig = chans.filter(c => isTested(c.m) && typeof c.q === 'number' && isFinite(c.q) && c.q < 0.05).sort(byEffect);
      if (sig.length > 0) {
        const top = sig[0];
        const band = GSRUI.correlationBand(top.r);
        if (band.key === 'negligible') return `Reliable but negligible (r ≈ ${top.r.toFixed(2)}) — detectable, too small to matter`;
        const how = top.m === 'meta' ? `consistent across your ${top.k} walks` : 'statistically reliable';
        return `${cap(band.label)} link to ${dirWord(top.r)} ${top.name} (r = ${top.r.toFixed(2)}), ${how}`;
      }

      const best = chans.slice().sort(byEffect)[0];
      const bestBand = GSRUI.correlationBand(best.r);
      if (bestBand.key === 'negligible') {
        // A negligible *pooled* effect can hide real per-walk effects that
        // just don't agree in size/direction — high I² means "walks
        // disagree", not "nothing happening in any of them". Check every
        // channel, not just the largest-|r| one: heterogeneity and effect
        // size are independent, so the channel worth flagging may not be
        // the one with the biggest (still-negligible) pooled r.
        const heterogeneous = chans
          .filter(c => (c.m === 'meta' || c.m === 'metaProvisional') && typeof c.i2 === 'number' && isFinite(c.i2) && c.i2 >= 50)
          .sort((a, b) => b.i2 - a.i2)[0];
        if (heterogeneous) {
          return `Inconsistent across walks (I² = ${Math.round(heterogeneous.i2)}% for ${heterogeneous.name}) — effects vary too much in size or direction to average into one signal; not necessarily "no effect" in any single walk`;
        }
        return 'No link to arousal — effect sizes are negligible';
      }

      let speedNote = '';
      if (row.hasVariance && typeof row.rTonicSpeedAdj === 'number' && isFinite(row.rTonicSpeedAdj)) {
        const rawBand = GSRUI.correlationBand(row.rTonic);
        const adjBand = GSRUI.correlationBand(row.rTonicSpeedAdj);
        if (rawBand.key !== 'negligible' && adjBand.key === 'negligible') {
          speedNote = ' (tonic link becomes negligible after controlling for walking speed)';
        }
      }

      if (best.m === 'meta') {
        // Raw meta p < .05 but q ≥ .05 → real-looking, just doesn't clear the
        // multiple-comparison bar. Worth flagging as suggestive, not "nothing".
        const rawSig = typeof best.p === 'number' && isFinite(best.p) && best.p < 0.05;
        if (rawSig) {
          return `Suggestive ${bestBand.label} link to ${dirWord(best.r)} ${best.name} ` +
                 `(r = ${best.r.toFixed(2)}, p = ${formatP(best.p)} before correction) — doesn't survive correction for testing every factor; more walks may confirm${speedNote}`;
        }
        return `Apparent ${bestBand.label} link to ${dirWord(best.r)} ${best.name} (r = ${best.r.toFixed(2)}) — inconsistent across the ${best.k} walks it varied in${speedNote}`;
      }
      if (best.m === 'metaProvisional' || best.m === 'fewWalks') {
        return `${cap(bestBand.label)} link to ${dirWord(best.r)} ${best.name} (r = ${best.r.toFixed(2)}) — but this factor varied in only ${best.k} of ${used} walks; need 5 to test consistency${speedNote}`;
      }
      return `Apparent ${bestBand.label} link to ${dirWord(best.r)} ${best.name} (r = ${best.r.toFixed(2)}) — not statistically reliable from this data${speedNote}`;
    };

    let displayMatrix = matrix.slice();
    if (AppState.corrSortColumn) {
      const col = AppState.corrSortColumn;
      const dir = (AppState.corrSortDirection === 'desc') ? -1 : 1;
      displayMatrix.sort((a, b) => {
        if (col === 'name') {
          return dir * (a.name || '').localeCompare(b.name || '');
        } else if (col === 'interpretation') {
          const interpA = getInterpretation(a) || '';
          const interpB = getInterpretation(b) || '';
          return dir * interpA.localeCompare(interpB);
        } else {
          const valA = a[col];
          const valB = b[col];
          const hasA = (typeof valA === 'number' && !isNaN(valA));
          const hasB = (typeof valB === 'number' && !isNaN(valB));
          if (!hasA && !hasB) return 0;
          if (!hasA) return 1;
          if (!hasB) return -1;
          return dir * (valA - valB);
        }
      });
    }

    displayMatrix.forEach(row => {
      const tr = document.createElement('tr');
      // r cell = number (coloured by direction) + a chip: "no variation" for a
      // constant factor; else the effect-size band, tagged with the verdict
      // ("· n.s." when tested and q ≥ .05) or, when there aren't enough walks
      // to test, "· k/N" (varied in k of the N analysed walks).
      // If speedAdjR is provided (Tonic channel), shows the walking-speed-adjusted
      // partial correlation beneath it.
      const cell = (r, q, m, k, i2, speedAdjR) => {
        const dir = Math.abs(r) < 0.10 ? 'dir-none' : (r >= 0 ? 'dir-pos' : 'dir-neg');
        let chip;
        if (!row.hasVariance) {
          chip = '<span class="mag-chip mag-negligible mag-ns">no variation</span>';
        } else {
          const band = GSRUI.correlationBand(r);
          let tag = '';
          if (isTested(m)) {
            const isSig = typeof q === 'number' && isFinite(q) && q < 0.05;
            tag = isSig ? '' : ' · n.s.';
          } else {
            tag = ` · ${k}/${used}`;
          }
          // I² = share of across-walk variation that's real disagreement
          // between walks rather than each walk's own sampling noise
          // (Higgins & Thompson 2002). Only meaningful once a meta-analysis
          // actually ran (k >= 3). Flagged inline at I² >= 50% ("walks
          // substantially disagree"); always in the tooltip when available,
          // so a small pooled r can be told apart from a genuinely
          // consistent null.
          const hasHet = (m === 'meta' || m === 'metaProvisional') && typeof i2 === 'number' && isFinite(i2);
          const hetTag = (hasHet && i2 >= 50) ? ' · mixed' : '';
          const hetTitle = hasHet
            ? ` title="Between-walk consistency (I²): ${Math.round(i2)}% — ${i2 < 30 ? 'walks broadly agree' : i2 < 50 ? 'some disagreement between walks' : 'walks disagree substantially in size or direction'}"`
            : '';
          const muted = (tag || hetTag) ? ' mag-ns' : '';
          chip = `<span class="mag-chip mag-${band.key}${muted}"${hetTitle}>${band.label}${tag}${hetTag}</span>`;
        }
        let speedInfo = '';
        if (row.hasVariance && typeof speedAdjR === 'number' && isFinite(speedAdjR) && Math.abs(speedAdjR - r) >= 0.02) {
          const adjBand = GSRUI.correlationBand(speedAdjR);
          const moved = adjBand.key !== GSRUI.correlationBand(r).key;
          const style = moved ? 'color: #e67e22; font-weight: 500;' : 'color: var(--text-muted);';
          speedInfo = `<div class="corr-speed-adj" style="font-size: 0.72rem; ${style} margin-top: 2px;" title="Partial correlation controlling for walking speed (m/s)">spd-adj: ${speedAdjR.toFixed(2)} (${adjBand.label})</div>`;
        }
        return `<td class="corr-cell"><div class="corr-val-stack"><span class="corr-num ${dir}">${r.toFixed(3)}</span>${chip}${speedInfo}</div></td>`;
      };
      const qCell = (q, m) => (row.hasVariance && isTested(m) && typeof q === 'number' && isFinite(q)) ? formatP(q) : '—';
      tr.innerHTML = `
        <td><strong>${row.name}</strong></td>
        ${cell(row.rPhasic, row.qPhasic, row.mPhasic, row.kPhasic, row.i2Phasic)}
        ${cell(row.rTonic, row.qTonic, row.mTonic, row.kTonic, row.i2Tonic, row.rTonicSpeedAdj)}
        ${cell(row.rPeaks, row.qPeaks, row.mPeaks, row.kPeaks, row.i2Peaks)}
        <td>${qCell(row.qPhasic, row.mPhasic)}</td>
        <td>${qCell(row.qTonic, row.mTonic)}</td>
        <td>${qCell(row.qPeaks, row.mPeaks)}</td>
        <td>${getInterpretation(row)}</td>
      `;
      tbody.appendChild(tr);
    });

    this.updateCorrelationTableSortHeaders();
  },

  /**
   * Resize the canvas to its CSS box and draw the regression scatter plot
   * for the currently selected environmental factor vs arousal metric.
   */
  drawRegressionScatterPlot(allData) {
    const canvas = document.getElementById('regressionCanvas');
    if (!canvas) return;

    // Rescale drawing buffer to match CSS size pixel-for-pixel
    if (canvas.clientWidth > 0 && canvas.clientHeight > 0) {
      canvas.width = canvas.clientWidth;
      canvas.height = canvas.clientHeight;
    }

    const scatterXMetric = document.getElementById('scatterEnvMetric').value;
    const scatterYMetric = document.getElementById('scatterBioMetric').value;

    const xVals = [];
    const yVals = [];
    
    // Resolve data source: direct arg, single-track cache, or collective cache
    let dataSrc = allData;
    if (!dataSrc) {
      const cacheTarget = (AppState.viewMode === 'single') ? AppState.analyzer : AppState.collectiveManager;
      if (cacheTarget && cacheTarget._cachedEnvStats) {
        dataSrc = cacheTarget._cachedEnvStats.allData;
      } else {
        dataSrc = [];
      }
    }
    const isBinaryX = GSR_CONST.OSM_METRICS.some(m => m.field === scatterXMetric && m.kind === 'binary');
    const yIsTonic = scatterYMetric !== 'phasic';
    dataSrc.forEach(d => {
      // Tonic uses the longer-lag environment, phasic the shorter-lag one —
      // same split as the correlation table.
      const src = (yIsTonic && d.tonicEnv) ? d.tonicEnv : d;
      let x = src[scatterXMetric];
      if (isBinaryX) x = (x === true || x === 1) ? 1 : (x === false || x === 0) ? 0 : NaN;
      const y = yIsTonic ? d.tonic : d.phasic;
      // 999.0 is the "no feature within radius" sentinel — not a distance.
      if (x !== null && x !== undefined && !isNaN(x) && x !== 999.0 && y !== null && y !== undefined && !isNaN(y)) {
        xVals.push(x);
        yVals.push(y);
      }
    });

    const { m, c, r2 } = StatsMath.calculateLinearRegression(xVals, yVals);

    // Axis labels from GSR_CONST.OSM_METRICS (continuous + binary, unit in
    // parens where present) plus EM Fog.
    const xLabels = {};
    GSR_CONST.OSM_METRICS
      .filter(m => m.kind === 'continuous' || m.kind === 'binary')
      .forEach(m => { xLabels[m.field] = m.unit ? `${m.label} (${m.unit})` : m.label; });
    xLabels['em_fog'] = 'EM Fog Index (0-100)';
    xLabels['speed'] = 'Walking Speed (m/s)';
    xLabels['ndvi_50m'] = 'NDVI (50m Buffer)';
    xLabels['ndvi'] = 'Point NDVI';
    
    const yLabels = {
      'phasic': 'Phasic (momentary arousal)',
      'tonic': 'Tonic (baseline arousal)'
    };

    GSRUI.drawRegressionScatter(canvas, xVals, yVals, m, c, r2, xLabels[scatterXMetric], yLabels[scatterYMetric], isBinaryX);
  },

};

if (typeof module !== 'undefined' && module.exports) {
  Object.assign(global, require('./ui.js'));
  module.exports = __methods;
} else {
  Object.assign(GSRUI, __methods);
}
})();
