/**
 * GSRUI — road-arousal profile table. Object-augment split from ui.js:
 * loaded immediately after ui.js, adds these methods to the shared GSRUI
 * object.
 *
 * Covers the sortable per-road-type arousal table and its rendering, fed by
 * the environmental dashboard's road-profile enrichment data.
 */
import { AppState } from '../core/app_state.mjs';
import { GSRNotices } from '../core/notices.mjs';

// Road classes come from OSM tags or an imported CSV — escape before innerHTML.
const esc = (s) => GSRNotices.escapeHtml(s);

export const RoadProfileUI = {
  /**
   * Sort the Road Arousal table by a column key ('name'|'timeSpent'|'meanPhasic'|'stdPhasic'|'ciPhasic'|'meanTonic'|'ciTonic'|'peakRate').
   */
  sortRoadArousalTable(col) {
    if (!col) return;
    if (AppState.roadSortColumn === col) {
      AppState.roadSortDirection =
        AppState.roadSortDirection === 'asc' ? 'desc' : 'asc';
    } else {
      AppState.roadSortColumn = col;
      AppState.roadSortDirection = col === 'name' ? 'asc' : 'desc';
    }
    const cacheTarget =
      AppState.viewMode === 'single'
        ? AppState.analyzer
        : AppState.collectiveManager;
    if (cacheTarget?._cachedEnvStats) {
      const stats = cacheTarget._cachedEnvStats;
      this.renderRoadProfile(stats.roadProfile, stats.roadComparison);
    }
  },

  /**
   * Update header icons and classes on roadArousalTable according to active sort state.
   */
  updateRoadArousalTableSortHeaders() {
    if (
      typeof document === 'undefined' ||
      typeof document.getElementById !== 'function'
    )
      return;
    const table = document.getElementById('roadArousalTable');
    if (!table || typeof table.querySelectorAll !== 'function') return;
    const ths = table.querySelectorAll('thead th.sortable');
    const curCol = AppState.roadSortColumn || 'meanPhasic';
    const curDir = AppState.roadSortDirection || 'desc';

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
   * Render cached road profile stats to HTML.
   */
  renderRoadProfile(profile, comparison) {
    const roadBody = document.querySelector('#roadArousalTable tbody');
    const roadChart = document.getElementById('roadBarChartContainer');
    if (!roadBody || !roadChart) return;

    roadBody.innerHTML = '';
    roadChart.innerHTML = '';

    const displayProfile = profile.slice();
    if (AppState.roadSortColumn) {
      const col = AppState.roadSortColumn;
      const dir = AppState.roadSortDirection === 'desc' ? -1 : 1;
      displayProfile.sort((a, b) => {
        if (col === 'name') {
          return dir * (a.name || '').localeCompare(b.name || '');
        }
        const valA = a[col] ?? 0;
        const valB = b[col] ?? 0;
        return dir * (valA - valB);
      });
    }

    const maxPhasicVal =
      displayProfile.length > 0
        ? Math.max(...displayProfile.map((p) => p.meanPhasic))
        : 1.0;

    displayProfile.forEach((p) => {
      const fmt = (v) => v.toFixed(3);
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><span style="font-family: monospace; font-size: 0.8rem;">${esc(p.name)}</span></td>
        <td>${p.timeSpent} s <span style="color: var(--text-muted); font-size: 0.78rem;">(~${p.effSamples} eff.)</span></td>
        <td>${fmt(p.meanPhasic)} μS</td>
        <td>${fmt(p.stdPhasic)} μS</td>
        <td>± ${fmt(p.ciPhasic)} μS</td>
        <td>${fmt(p.meanTonic)} μS</td>
        <td>± ${fmt(p.ciTonic)} μS</td>
        <td>${p.peakRate.toFixed(2)}</td>
      `;
      roadBody.appendChild(tr);

      const barRow = document.createElement('div');
      barRow.className = 'road-bar-row';
      const percent =
        maxPhasicVal > 0 ? (p.meanPhasic / maxPhasicVal) * 100 : 0;
      barRow.innerHTML = `
        <div class="road-bar-label" title="${esc(p.name)}">${esc(p.name)}</div>
        <div class="road-bar-track">
          <div class="road-bar-fill" style="width: ${percent}%;"></div>
        </div>
        <div class="road-bar-val">${fmt(p.meanPhasic)} μS</div>
      `;
      roadChart.appendChild(barRow);
    });

    this.updateRoadArousalTableSortHeaders();

    // ── Dynamic interpretation of actual data ───────────────────────────
    const interpretEl = document.getElementById('roadInterpretationText');
    if (interpretEl && profile.length > 0) {
      const sorted = [...profile].sort((a, b) => b.meanPhasic - a.meanPhasic);
      const highest = sorted[0];
      const lowest = sorted[sorted.length - 1];

      // Wide CI relative to the mean = unreliable estimate.
      const unreliable = profile.filter((p) => p.ciPhasic > p.meanPhasic * 0.5);
      const reliable = profile.filter((p) => p.ciPhasic <= p.meanPhasic * 0.3);

      const lines = [];

      // Main comparison
      if (highest !== lowest) {
        // A percentage only means something against a positive baseline: a
        // zero or negative mean (e.g. unclamped cvxEDA phasic) would give
        // "Infinity%" or a nonsense figure, so fall back to the gap in μS.
        const gap =
          lowest.meanPhasic > 0
            ? `${(((highest.meanPhasic - lowest.meanPhasic) / lowest.meanPhasic) * 100).toFixed(0)}% higher`
            : `${(highest.meanPhasic - lowest.meanPhasic).toFixed(3)} μS higher`;
        lines.push(
          `Your strongest arousal was on <strong>${esc(highest.name)}</strong> roads (${highest.meanPhasic.toFixed(3)} μS), ` +
            `which is <strong>${gap}</strong> ` +
            `than ${esc(lowest.name)} roads (${lowest.meanPhasic.toFixed(3)} μS).`,
        );
      }

      // Welch t-test (effective sample sizes) for the highest-vs-lowest gap.
      // This is the widest gap among `nGroups` road classes, picked after
      // seeing the means, so the verdict uses the selection-corrected pAdj
      // (Bonferroni over the k-choose-2 contrasts), with the raw p shown too.
      if (comparison && isFinite(comparison.pAdj)) {
        const fmtP = (v) =>
          v < 0.001 ? 'p &lt; 0.001' : `p = ${v.toFixed(3)}`;
        const selNote =
          comparison.nGroups > 2
            ? ` (widest gap among ${comparison.nGroups} road classes, so corrected for that choice; raw ${fmtP(comparison.p)})`
            : '';
        if (comparison.pAdj < 0.05) {
          lines.push(
            `A Welch <em>t</em>-test says this gap is <strong>statistically reliable</strong> ` +
              `(${fmtP(comparison.pAdj)}, t = ${comparison.t.toFixed(2)}, df ≈ ${comparison.df.toFixed(0)})${selNote} — ` +
              `unlikely to be sampling noise, though this is one walk in one set of places, not a controlled comparison.`,
          );
        } else {
          lines.push(
            `A Welch <em>t</em>-test says this gap is <strong>not statistically reliable</strong> ` +
              `(${fmtP(comparison.pAdj)})${selNote} — it could easily be sampling noise, so treat the ordering with caution.`,
          );
        }
      }

      // Reliability notes
      if (unreliable.length > 0) {
        lines.push(
          `⚠️ <strong>Low confidence:</strong> ${unreliable
            .map(
              (p) =>
                `${esc(p.name)} (~${p.effSamples} independent samples, CI ±${p.ciPhasic.toFixed(3)})`,
            )
            .join(', ')} — treat these numbers as rough estimates.`,
        );
      }
      if (reliable.length > 0) {
        const best = reliable
          .slice()
          .sort((a, b) => b.effSamples - a.effSamples)[0];
        lines.push(
          `✅ <strong>Most reliable:</strong> ${esc(best.name)} roads (~${best.effSamples} independent samples, CI ±${best.ciPhasic.toFixed(3)}) — the most trustworthy comparison point.`,
        );
      }

      // Consistency notes
      const highVar = profile.filter((p) => p.stdPhasic > p.meanPhasic * 0.8);
      const lowVar = profile.filter(
        (p) => p.stdPhasic < p.meanPhasic * 0.3 && p.timeSpent > 30,
      );
      if (highVar.length > 0) {
        lines.push(
          `${highVar
            .map(
              (p) =>
                `<strong>${esc(p.name)}</strong> has high variability (Std Dev ${p.stdPhasic.toFixed(3)} μS) — ` +
                `some parts were very calm, others very reactive.`,
            )
            .join(' ')}`,
        );
      }
      if (lowVar.length > 0) {
        lines.push(
          `${lowVar
            .map(
              (p) =>
                `<strong>${esc(p.name)}</strong> is very consistent (Std Dev ${p.stdPhasic.toFixed(3)} μS) — ` +
                `your arousal stayed steady throughout.`,
            )
            .join(' ')}`,
        );
      }

      interpretEl.innerHTML = lines.join('</p><p style="margin: 4px 0 0 0;">');
    } else if (interpretEl) {
      interpretEl.textContent = 'No road profile data to interpret.';
    }

    if (profile.length === 0) {
      roadBody.innerHTML =
        '<tr><td colspan="8" class="empty-row">No road classes with enough data to profile.</td></tr>';
    }
  },
};
