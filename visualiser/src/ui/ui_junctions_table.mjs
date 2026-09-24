/**
 * GSRUI — junction turn-vs-straight contrast table & visual cards.
 * Object-augment split composed into GSRUI in ui.mjs.
 */
import { AppState } from '../core/app_state.mjs';
import { JunctionResponse } from '../gps/junction_response.mjs';

const WINDOW = `${JunctionResponse.WINDOW_S} s`;
const neutralBand = (metric) => (metric === 'peakRate' ? 0.5 : 0.02);
const fmtP = (v) => {
  if (!Number.isFinite(v)) return '—';
  return v < 0.001 ? '< 0.001' : v.toFixed(3);
};

export const JunctionsTableUI = {
  /**
   * Sort the Junctions contrast table by column key.
   */
  sortJunctionsTable(col) {
    if (!col) return;
    if (AppState.junctionSortColumn === col) {
      AppState.junctionSortDirection =
        AppState.junctionSortDirection === 'asc' ? 'desc' : 'asc';
    } else {
      AppState.junctionSortColumn = col;
      AppState.junctionSortDirection =
        col === 'phase' || col === 'metric' || col === 'pVal' ? 'asc' : 'desc';
    }
    const cacheTarget =
      AppState.viewMode === 'single'
        ? AppState.analyzer
        : AppState.collectiveManager;
    if (cacheTarget?._cachedEnvStats?.junctionStats) {
      this.renderJunctionsTable(cacheTarget._cachedEnvStats.junctionStats);
    }
  },

  /**
   * Update header icons and classes on junctionsTable according to active sort state.
   */
  updateJunctionsTableSortHeaders() {
    if (
      typeof document === 'undefined' ||
      typeof document.getElementById !== 'function'
    )
      return;
    const table = document.getElementById('junctionsTable');
    if (!table || typeof table.querySelectorAll !== 'function') return;
    const ths = table.querySelectorAll('thead th.sortable');
    const curCol = AppState.junctionSortColumn;
    const curDir = AppState.junctionSortDirection || 'asc';

    ths.forEach((th) => {
      const col = th.dataset.sort;
      const icon = th.querySelector('.sort-icon');
      if (col === curCol) {
        th.classList.remove('sort-asc', 'sort-desc');
        th.classList.add(curDir === 'desc' ? 'sort-desc' : 'sort-asc');
        if (icon) {
          icon.className =
            'fa-solid ' +
            (curDir === 'desc' ? 'fa-sort-down' : 'fa-sort-up') +
            ' sort-icon';
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
   * Overview box: arousal near ANY junction (turn, straight, U-turn or unclear)
   * vs on plain road. Fed by JunctionResponse.compareJunctionVsRoad.
   *
   * @param {{passages:Array, overview:Array}} junctionStats
   */
  renderJunctionOverview(junctionStats) {
    if (typeof document === 'undefined') return;
    const box = document.getElementById('junctionOverviewBox');
    if (!box) return;
    box.innerHTML = '';
    box.style.display = 'none';
    const rows = junctionStats?.overview || [];
    if (rows.length === 0) return;

    const fmt = (v, d) => (Number.isFinite(v) ? v.toFixed(d) : '—');
    const labels = {
      meanPhasic: { name: 'Arousal level (phasic)', unit: ' μS', digits: 3 },
      peakRate: { name: 'Peaks per minute', unit: ' /min', digits: 2 },
      change: {
        name: 'Change across the spot (after − before)',
        unit: ' μS',
        digits: 3,
      },
    };

    const supported = rows.filter((r) => r.verdict === 'supported');
    const suggestive = rows
      .filter((r) => r.verdict === 'suggestive')
      .sort((a, b) => a.p - b.p);
    const first = rows[0];

    // The test needs at least two of each, from walks that have both. Say so
    // plainly instead of showing an empty table and a meaningless p = 1.
    if (first.nJunction < 2 || first.nRoad < 2) {
      const resp = junctionStats?.responses || [];
      const availRoad = resp.filter((r) => r.decision === 'control').length;
      const availJunction = resp.length - availRoad;
      const why =
        availRoad === 0
          ? 'No plain-road spot was found: one has to be on a straight stretch at least 30&nbsp;m from any junction, and this walk has none (short walk, or junctions close together).'
          : availJunction === 0
            ? 'No junction passage has enough clean GSR either side of it.'
            : 'There are too few of one kind, in walks that have both, to compare.';
      box.innerHTML = `
        <div class="junction-insight-headline">
          <i class="fa-solid fa-ban"></i> Can't compare junctions with plain road here
        </div>
        <p class="junction-insight-text">
          ${why} Usable so far: ${availJunction} junction passage(s) and ${availRoad} plain-road spot(s).
        </p>`;
      box.style.display = 'block';
      return;
    }
    const lowPower = Math.min(first.nJunction, first.nRoad) < 30;

    let icon = 'fa-equals';
    let headline =
      'No detectable difference in arousal between junctions and plain road';
    if (supported.length) {
      const r = [...supported].sort((a, b) => a.q - b.q)[0];
      icon = r.diff > 0 ? 'fa-arrow-trend-up' : 'fa-arrow-trend-down';
      headline = `Arousal differs between junctions and plain road in ${supported.length} of ${rows.length} measures`;
    } else if (suggestive.length) {
      icon = 'fa-circle-question';
      const r = suggestive[0];
      headline = `No robust difference — one weak hint: ${labels[r.metric].name.toLowerCase()} is ${r.diff > 0 ? 'higher' : 'lower'} near junctions (p=${fmtP(r.p)}, but q=${fmtP(r.q)} after correcting for ${rows.length} tests)`;
    }
    const powerNote =
      lowPower && !supported.length
        ? ' <strong>This sample is small, so a null here is not evidence of no effect.</strong>'
        : '';

    const body = rows
      .map((r) => {
        const l = labels[r.metric];
        const badge =
          r.verdict === 'none' || Math.abs(r.diff) <= neutralBand(r.metric)
            ? 'neutral'
            : r.diff > 0
              ? 'higher'
              : 'lower';
        const sign = r.diff > 0 ? '+' : '';
        const chip =
          r.verdict === 'supported'
            ? `<span class="mag-chip mag-strong">Supported (q=${fmtP(r.q)})</span>`
            : r.verdict === 'suggestive'
              ? `<span class="mag-chip mag-moderate" title="Uncorrected p&lt;0.05 but q&gt;=0.05 after adjusting for all tests">Weak hint only (p=${fmtP(r.p)}, q=${fmtP(r.q)})</span>`
              : `<span class="mag-chip mag-negligible">n.s. (p=${fmtP(r.p)}, q=${fmtP(r.q)})</span>`;
        return `<tr>
          <td>${l.name}</td>
          <td>${fmt(r.meanJunction, l.digits)}${l.unit}</td>
          <td>${fmt(r.meanRoad, l.digits)}${l.unit}</td>
          <td><span class="junction-diff-badge ${badge}">${Number.isFinite(r.diff) ? `${sign}${r.diff.toFixed(l.digits)}${l.unit}` : '—'}</span></td>
          <td>${chip}</td>
        </tr>`;
      })
      .join('');

    box.innerHTML = `
      <div class="junction-insight-headline">
        <i class="fa-solid ${icon}"></i> ${headline}
      </div>
      <p class="junction-insight-text">
        Near a junction vs a plain stretch of road at least 30&nbsp;m from one — whether the walker turned, went straight or doubled back doesn't matter here. Based on ${first.nJunction} junction passages vs ${first.nRoad} plain-road spots across ${first.nTracks || 1} walk(s); ±${JunctionResponse.WINDOW_S}&nbsp;s around each, each walk adjusted for its own average level.${powerNote}
      </p>
      <div class="table-container" style="margin-top: 8px;">
        <table class="peaks-table">
          <thead><tr>
            <th>Measure</th><th>Near a junction</th><th>Plain road</th><th>Difference</th><th>Evidence (q = corrected)</th>
          </tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>`;
    box.style.display = 'block';
  },

  /**
   * Render cached junction stats to HTML (headline banner, 3 moment cards, and detailed table).
   *
   * @param {{passages:Array, responses:Array, comparison:Array}} junctionStats
   */
  renderJunctionsTable(junctionStats) {
    if (typeof document === 'undefined') return;

    const tbody = document.querySelector('#junctionsTable tbody');
    const summaryContainer = document.getElementById('junctionSummaryRow');
    const bannerContainer = document.getElementById('junctionInsightBanner');
    const cardsContainer = document.getElementById('junctionCardsGrid');
    if (!tbody) return;

    this.renderJunctionOverview(junctionStats);
    tbody.innerHTML = '';
    if (cardsContainer) cardsContainer.innerHTML = '';
    if (bannerContainer) {
      bannerContainer.innerHTML = '';
      bannerContainer.style.display = 'none';
    }

    const passages = junctionStats?.passages || [];
    const comparison = junctionStats?.comparison || [];

    // Summary counts
    const nTurn = passages.filter((p) => p.decision === 'turn').length;
    const nStraight = passages.filter((p) => p.decision === 'straight').length;
    const nControl = passages.filter((p) => p.decision === 'control').length;
    const nReverse = passages.filter((p) => p.decision === 'reverse').length;
    const nAmbiguous = passages.filter(
      (p) => p.decision === 'ambiguous',
    ).length;

    // Paired junctions: count distinct keys with at least one turn and one straight response
    const byKey = new Map();
    (junctionStats?.responses || []).forEach((r) => {
      if (r.decision === 'turn' || r.decision === 'straight') {
        if (!byKey.has(r.key)) byKey.set(r.key, new Set());
        byKey.get(r.key).add(r.decision);
      }
    });
    // Confident passages that lost their window to clipping / too little GSR.
    const respKey = (r) =>
      r.trackId != null
        ? `${r.trackId}@${r.key}@${r.time}`
        : `${r.key}@${r.time}`;
    const haveResponse = new Set((junctionStats?.responses || []).map(respKey));
    const lost = (dec) =>
      passages.filter(
        (p) => p.decision === dec && !haveResponse.has(respKey(p)),
      ).length;
    const nDroppedTurn = lost('turn');
    const nDroppedStraight = lost('straight');
    const nDroppedControl = lost('control');
    // Turns cluster in dense areas, so they can lose far more windows than
    // straights — which biases who is left to compare.
    const keptFrac = (n, dropped) => (n ? (n - dropped) / n : 1);
    const skewedLoss =
      Math.abs(
        keptFrac(nTurn, nDroppedTurn) - keptFrac(nStraight, nDroppedStraight),
      ) > 0.2;
    let nPaired = 0;
    for (const decs of byKey.values()) {
      if (decs.has('turn') && decs.has('straight')) nPaired++;
    }

    if (summaryContainer) {
      summaryContainer.innerHTML = `
        <span><strong>Passages:</strong> ${passages.length} total</span>
        <span class="junction-stat-chip turn" title="Turn angle ≥ 40°"><i class="fa-solid fa-arrow-turn-up"></i> ${nTurn} Turns</span>
        <span class="junction-stat-chip straight" title="Turn angle ≤ 25°"><i class="fa-solid fa-arrow-up"></i> ${nStraight} Straight</span>
        <span class="junction-stat-chip control" title="Mid-block straight road segments ≥ 30 m from any junction"><i class="fa-solid fa-road"></i> ${nControl} Control</span>
        <span class="junction-stat-chip reverse" title="Turn angle ≥ 135° (U-turns)"><i class="fa-solid fa-rotate-left"></i> ${nReverse} Reverse</span>
        <span class="junction-stat-chip ambiguous" title="Angle 25°–40° or snapped vs raw GPS disagree"><i class="fa-solid fa-circle-question"></i> ${nAmbiguous} Ambiguous</span>
        <span class="junction-stat-chip" style="background: rgba(0,85,204,0.1); color: #0055cc; font-weight: 600;" title="Junctions visited multiple times with both turn and straight choices"><i class="fa-solid fa-code-compare"></i> ${nPaired} Paired Junctions</span>
        <span class="junction-stat-chip ambiguous" title="Windows are trimmed at the midpoint to a neighbouring junction so no sample is counted twice; a passage is left out when that leaves less than 5 s (a junction under ~10 s away), when its traversal takes over 20 s, or when it has too little GSR. Reverse and ambiguous passages are never compared."><i class="fa-solid fa-filter"></i> no clean window: ${nDroppedTurn} of ${nTurn} turns, ${nDroppedStraight} of ${nStraight} straights, ${nDroppedControl} of ${nControl} controls · ${nReverse + nAmbiguous} reverse/ambiguous not compared</span>
        ${skewedLoss ? '<span class="junction-stat-chip reverse" title="One class lost many more windows than the other (usually turns, which sit in dense areas), so the passages compared may not be representative."><i class="fa-solid fa-triangle-exclamation"></i> Uneven loss of turns vs straights — comparison may be biased</span>' : ''}
        ${
          junctionStats?.tracksNeedingGeoms > 0
            ? `<button class="junction-stat-chip btn-fetch-junction-geoms" style="background: rgba(255,123,0,0.12); color: #c45d00; border: 1px solid rgba(255,123,0,0.4); cursor: pointer;" title="Retrieve OpenStreetMap road network geometry to snap and detect junctions on ${junctionStats.tracksNeedingGeoms} walk(s)"><i class="fa-solid fa-wand-magic-sparkles"></i> ${junctionStats.tracksNeedingGeoms} walk(s) need road geometries — click to retrieve</button>`
            : ''
        }
      `;
    }

    if (comparison.length === 0) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td colspan="8" style="text-align: center; color: var(--text-muted); padding: 24px;">
          ${
            passages.length === 0
              ? junctionStats?.tracksNeedingGeoms > 0
                ? `<span>${junctionStats.tracksNeedingGeoms} walk(s) have spatial metrics but need OpenStreetMap road geometries to detect junctions.</span><br>
                   <button class="btn-primary btn-fetch-junction-geoms" style="margin-top: 12px; padding: 6px 14px; font-size: 0.85rem; cursor: pointer;">
                     <i class="fa-solid fa-wand-magic-sparkles"></i> Retrieve Road Geometries & Detect Junctions (${junctionStats.tracksNeedingGeoms} Walks)
                   </button>`
                : 'No junction passages detected. Ensure tracks are enriched with OpenStreetMap road data and road snapping is enabled.'
              : `Passages detected, but insufficient clean ${WINDOW} non-overlapping GSR windows around junctions for comparison.`
          }
        </td>
      `;
      tbody.appendChild(tr);
      this.updateJunctionsTableSortHeaders();
      return;
    }

    // ── Helper formatters ──────────────────────────────────────────────────
    const fmt = (v, digits = 3) =>
      Number.isFinite(v) ? v.toFixed(digits) : '—';
    // A percentage is only meaningful when the difference is backed by the
    // statistics and the baseline is a level well away from zero (never for a
    // change row, whose baseline can be negative).
    const safePct = (r, diff, base, verdict = r?.verdict) =>
      r.phase !== 'delta' &&
      verdict !== 'none' &&
      Number.isFinite(base) &&
      Math.abs(base) > neutralBand(r.metric) * 5
        ? (diff / Math.abs(base)) * 100
        : null;
    const unitOf = (metric) => (metric === 'peakRate' ? ' /min' : ' μS');
    const fmtDiff = (diff, pct, metric) => {
      if (!Number.isFinite(diff)) return '—';
      const cleanDiff =
        Math.abs(diff) < (metric === 'peakRate' ? 0.005 : 0.0005) ? 0 : diff;
      const sign = cleanDiff > 0 ? '+' : '';
      const unit = unitOf(metric);
      const digits = metric === 'peakRate' ? 2 : 3;
      const diffStr = `${sign}${cleanDiff.toFixed(digits)}${unit}`;
      if (pct != null && Number.isFinite(pct)) {
        const cleanPct = Math.abs(pct) < 0.5 ? 0 : pct;
        const pctSign = cleanPct > 0 ? '+' : '';
        return `${diffStr} (${pctSign}${cleanPct.toFixed(0)}%)`;
      }
      return diffStr;
    };

    // ── 1. Headline verdict ────────────────────────────────────────────────
    // Decided on the BH-corrected q across every test, never on one chosen row
    // or an uncorrected p.
    const phaseLabels = {
      before: `Before (${WINDOW})`,
      after: `After (${WINDOW})`,
      delta: 'Change (after − before)',
    };
    const metricLabels = {
      peakRate: 'Peak Rate (/min)',
      meanPhasic: 'Arousal Spikes (Phasic)',
      meanTonic: 'Baseline Tension (Tonic)',
    };
    if (bannerContainer) {
      const byQ = (a, b) => a.q - b.q;
      const supported = comparison
        .filter((r) => r.verdict === 'supported')
        .sort(byQ);
      const suggestive = comparison
        .filter((r) => r.verdict === 'suggestive')
        .sort((a, b) => a.p - b.p);
      const first = comparison[0];
      const nT = first.nTurn;
      const nS = first.nStraight;
      const lowPower = nPaired < 15 || Math.min(nT, nS) < 30;
      let icon = 'fa-equals';
      let headline =
        'No detectable difference between turning and going straight';
      let detail = '';
      const describe = (r) =>
        `${metricLabels[r.metric] || r.metric}, ${(phaseLabels[r.phase] || r.phase).toLowerCase()}: turn ${fmt(r.meanTurn, r.metric === 'peakRate' ? 2 : 3)} vs straight ${fmt(r.meanStraight, r.metric === 'peakRate' ? 2 : 3)}${unitOf(r.metric)} (${r.test} test, p=${fmtP(r.p)}, q=${fmtP(r.q)})`;
      if (supported.length) {
        const r = supported[0];
        icon = r.diff > 0 ? 'fa-arrow-trend-up' : 'fa-arrow-trend-down';
        headline = `Turns and straights differ in ${supported.length} of ${comparison.length} measures`;
        detail = `Strongest: ${describe(r)}. This is an association; it doesn't show that turning caused it.`;
      } else if (suggestive.length) {
        icon = 'fa-circle-question';
        headline = 'No robust difference — one or more weak hints only';
        detail = `Best hint: ${describe(suggestive[0])}. It doesn't survive correcting for ${comparison.length} tests, so treat it as a hypothesis to check with more walks.`;
      }

      const powerNote =
        lowPower && !supported.length
          ? ' <strong>This sample is small, so a null here is not evidence of no effect.</strong>'
          : '';

      bannerContainer.innerHTML = `
        <div class="junction-insight-headline">
          <i class="fa-solid ${icon}"></i> ${headline}
        </div>
        <p class="junction-insight-text">
          ${detail ? `${detail}<br>` : ''}Based on ${nT} turns vs ${nS} straights across ${first.nTracks || 1} walk(s); ${nPaired} junction(s) had both.${powerNote}
        </p>
      `;
      bannerContainer.style.display = 'block';
    }

    // ── 2. The 3 Moment Cards ──────────────────────────────────────────────
    if (cardsContainer) {
      const appPhasic = comparison.find(
        (r) => r.phase === 'before' && r.metric === 'meanPhasic',
      );
      const consPhasic = comparison.find(
        (r) => r.phase === 'after' && r.metric === 'meanPhasic',
      );
      const deltaPhasic = comparison.find(
        (r) => r.phase === 'delta' && r.metric === 'meanPhasic',
      );

      const renderCard = (title, sub, r) => {
        if (!r) return '';
        const tVal = r.meanTurn ?? 0;
        const sVal = r.meanStraight ?? 0;
        const cVal = r.meanControl;
        const hasControl = Number.isFinite(cVal);
        // A class with no usable windows has a NaN mean: no bar, not a NaN width.
        const mag = (v) => (Number.isFinite(v) ? Math.abs(v) : 0);
        const maxVal = Math.max(mag(tVal), mag(sVal), mag(cVal), 0.001);
        const tPct = Math.min(100, (mag(tVal) / maxVal) * 100);
        const sPct = Math.min(100, (mag(sVal) / maxVal) * 100);
        const cPct = Math.min(100, (mag(cVal) / maxVal) * 100);

        const diff = Number.isFinite(r.diff) ? r.diff : tVal - sVal;
        const pctDiff = safePct(r, diff, sVal);
        // Only colour a difference the statistics back up.
        const band = neutralBand(r.metric);
        const badgeClass =
          r.verdict === 'none'
            ? 'neutral'
            : diff > band
              ? 'higher'
              : diff < -band
                ? 'lower'
                : 'neutral';
        const badgeText = fmtDiff(diff, pctDiff, r.metric);
        const evidence = `${r.test} test, p=${fmtP(r.p)}, q=${fmtP(r.q)}`;
        const fmtCardVal = (v) => {
          if (!Number.isFinite(v)) return '—';
          const clean = Math.abs(v) < 0.0005 ? 0 : v;
          const sign = r.phase === 'delta' && clean > 0 ? '+' : '';
          return `${sign}${clean.toFixed(3)}`;
        };
        return `
          <div class="junction-moment-card">
            <div class="junction-moment-header">
              <span class="junction-moment-title">${title}</span>
              <span class="junction-diff-badge ${badgeClass}">${badgeText}</span>
            </div>
            <span class="junction-moment-sub">${sub} · ${evidence}</span>
            <div class="junction-moment-values">
              <div class="junction-value-row">
                <span style="font-weight:600; min-width:65px;"><i class="fa-solid fa-arrow-turn-up" style="color:#c82333;"></i> Turn:</span>
                <div class="junction-bar-track">
                  <div class="junction-bar-fill turn" style="width: ${tPct}%;"></div>
                </div>
                <span style="font-family:monospace; min-width:55px; text-align:right;">${fmtCardVal(tVal)} μS</span>
              </div>
              <div class="junction-value-row">
                <span style="font-weight:600; min-width:65px;"><i class="fa-solid fa-arrow-up" style="color:#218838;"></i> Straight:</span>
                <div class="junction-bar-track">
                  <div class="junction-bar-fill straight" style="width: ${sPct}%;"></div>
                </div>
                <span style="font-family:monospace; min-width:55px; text-align:right;">${fmtCardVal(sVal)} μS</span>
              </div>
              ${
                hasControl
                  ? `
              <div class="junction-value-row">
                <span style="font-weight:600; min-width:65px;"><i class="fa-solid fa-road" style="color:#007bff;"></i> Control:</span>
                <div class="junction-bar-track">
                  <div class="junction-bar-fill control" style="width: ${cPct}%;"></div>
                </div>
                <span style="font-family:monospace; min-width:55px; text-align:right;">${fmtCardVal(cVal)} μS</span>
              </div>`
                  : ''
              }
            </div>
          </div>
        `;
      };

      cardsContainer.innerHTML = [
        renderCard(
          `1. Before (${WINDOW})`,
          'Level just before the junction',
          appPhasic,
        ),
        renderCard(
          `2. After (${WINDOW})`,
          'Level just after the junction',
          consPhasic,
        ),
        renderCard(
          '3. Change (After − Before)',
          'How much the level moved across the junction',
          deltaPhasic,
        ),
      ].join('');
    }

    // ── 3. Detailed Results Table ──────────────────────────────────────────
    const rows = [...comparison];
    if (AppState.junctionSortColumn) {
      const col = AppState.junctionSortColumn;
      const dir = AppState.junctionSortDirection === 'desc' ? -1 : 1;
      const toNum = (v) =>
        Number.isFinite(v) ? v : dir === 1 ? Infinity : -Infinity;
      rows.sort((a, b) => {
        if (col === 'phase' || col === 'metric') {
          return dir * (a[col] || '').localeCompare(b[col] || '');
        }
        if (col === 'diff') {
          return dir * (toNum(a.diff) - toNum(b.diff));
        }
        if (col === 'diffJunction') {
          return dir * (toNum(a.diffJunction) - toNum(b.diffJunction));
        }
        if (col === 'pVal') {
          const diffQ = toNum(a.q) - toNum(b.q);
          if (diffQ !== 0) return dir * diffQ;
          return dir * (toNum(a.p) - toNum(b.p));
        }
        return dir * (toNum(a[col]) - toNum(b[col]));
      });
    }

    rows.forEach((r) => {
      const tr = document.createElement('tr');
      const diff = Number.isFinite(r.diff)
        ? r.diff
        : (r.meanTurn ?? 0) - (r.meanStraight ?? 0);
      const pct = safePct(r, diff, r.meanStraight);

      const diffJunc = r.diffJunction;
      const pctJunc = safePct(r, diffJunc, r.meanControl, r.verdictJunction);
      const badgeClassJunc =
        r.verdictJunction === 'none' || !Number.isFinite(diffJunc)
          ? 'neutral'
          : diffJunc > neutralBand(r.metric)
            ? 'higher'
            : diffJunc < -neutralBand(r.metric)
              ? 'lower'
              : 'neutral';
      const diffJuncFormatted = Number.isFinite(diffJunc)
        ? fmtDiff(diffJunc, pctJunc, r.metric)
        : '—';

      // Verdict rests on the BH-corrected q across all rows, not the raw p.
      // Paired (within-junction) is used only with enough paired junctions;
      // otherwise the pooled permutation test on per-walk-adjusted values.
      const testNote =
        r.test === 'paired'
          ? `Turn vs Straight: Within-junction paired permutation test (k=${r.pairedN} junctions)`
          : `Turn vs Straight: Pooled permutation test (n=${r.nTurnUsed ?? r.nTurn} vs ${r.nStraightUsed ?? r.nStraight}, ${r.nTracks || 1} walk(s), levels adjusted per walk). Passages within a walk are correlated, so treat as indicative`;
      const testNoteJunc = `Pooled permutation test vs open road (n=${r.nStraightJuncUsed ?? r.nStraightUsed ?? r.nStraight} straight vs ${r.nControlUsed ?? r.nControl ?? 0} control, levels adjusted per walk)`;
      const juncEvidenceTitle = `Junction vs Open Road: ${testNoteJunc}; p=${fmtP(r.pJunction)}, q=${fmtP(r.qJunction)}`;
      const badgeClass =
        r.verdict === 'none'
          ? 'neutral'
          : diff > neutralBand(r.metric)
            ? 'higher'
            : diff < -neutralBand(r.metric)
              ? 'lower'
              : 'neutral';
      const diffFormatted = fmtDiff(diff, pct, r.metric);

      const verdictChip =
        r.verdict === 'supported'
          ? `<span class="mag-chip mag-strong" title="${testNote}">Supported (q=${fmtP(r.q)})</span>`
          : r.verdict === 'suggestive'
            ? `<span class="mag-chip mag-moderate" title="${testNote}. Uncorrected p&lt;0.05 but q&gt;=0.05 after adjusting for all tests">Weak hint only (p=${fmtP(r.p)}, q=${fmtP(r.q)})</span>`
            : `<span class="mag-chip mag-negligible" title="${testNote}">n.s. (p=${fmtP(r.p)}, q=${fmtP(r.q)})</span>`;

      const digits = r.metric === 'peakRate' ? 2 : 3;
      const unit = r.metric === 'peakRate' ? ' /min' : ' μS';

      tr.innerHTML = `
        <td><strong>${phaseLabels[r.phase] || r.phase}</strong></td>
        <td>${metricLabels[r.metric] || r.metric}</td>
        <td><span class="junction-turn-val"><i class="fa-solid fa-arrow-turn-up"></i> ${fmt(r.meanTurn, digits)}${unit}</span> <span style="font-size:0.75rem; color:var(--text-muted);">(n=${r.nTurnUsed ?? r.nTurn})</span></td>
        <td><span class="junction-straight-val"><i class="fa-solid fa-arrow-up"></i> ${fmt(r.meanStraight, digits)}${unit}</span> <span style="font-size:0.75rem; color:var(--text-muted);">(n=${r.nStraightUsed ?? r.nStraight})</span></td>
        <td><span class="junction-control-val"><i class="fa-solid fa-road"></i> ${fmt(r.meanControl, digits)}${unit}</span> <span style="font-size:0.75rem; color:var(--text-muted);">(n=${r.nControlUsed ?? r.nControl ?? 0})</span></td>
        <td><span class="junction-diff-badge ${badgeClass}">${diffFormatted}</span></td>
        <td><span class="junction-diff-badge ${badgeClassJunc}" title="${juncEvidenceTitle}">${diffJuncFormatted}</span></td>
        <td>${verdictChip}</td>
      `;
      tbody.appendChild(tr);
    });

    this.updateJunctionsTableSortHeaders();
  },
};
