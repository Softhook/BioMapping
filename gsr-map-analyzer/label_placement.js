/**
 * GSR Label Manager — Cartographic Label Placement & HTML Icon Building.
 * Extracted from map.js to separate Leaflet rendering from layout computations.
 */

class GSRLabelManager {
  /**
   * Estimate pixel width of label text at font-size 10px (Inter proportionals).
   */
  static textWidth(t) {
    let w = 0;
    for (const ch of t) {
      if (ch >= 'A' && ch <= 'Z') w += 7.5;
      else if (ch >= 'a' && ch <= 'z') w += 5.5;
      else if (ch >= '0' && ch <= '9') w += 5.5;
      else if (ch === ' ' || ch === '.' || ch === ',') w += 3;
      else if (ch === 'i' || ch === 'l' || ch === 'I') w += 4;
      else if (ch === 'm' || ch === 'w' || ch === 'W' || ch === 'M') w += 8.5;
      else w += 5;
    }
    return Math.ceil(Math.min(w + 8, 160)); // 8px padding, sane cap
  }

  /**
   * Compute 360° label positions using simulated annealing — the standard
   * cartographic approach for point-feature label placement.
   *
   * @param {Array} peaksWithCoords — array of { idx, px, py, text }
   * @returns {Map<number, { box: object, dir: string }>} map from peakIndex to positioned candidate
   */
  static computeLabelPositions(peaksWithCoords) {
    if (peaksWithCoords.length === 0) return new Map();

    const H = 18;       // label box height (px)
    const BASE = 3, STEP = 4, TIERS = 3;  // gaps: 3, 7, 11 px
    const OVERLAP_PENALTY = 100;
    const DIST_FACTOR = 1.0;

    const overlap = (a, b) => a.left < b.right && a.right > b.left &&
                              a.top < b.bottom && a.bottom > b.top;

    // ── Build candidate sets (per-label width) ────────────────────────────
    const items = peaksWithCoords.map(p => {
      const W = p.text ? GSRLabelManager.textWidth(p.text) : 120;
      p.tw = W; // cache for later use
      const halfW = W / 2;
      const gens = [
        ['S',  (px, py, g) => px - halfW,      (px, py, g) => py + g       ],
        ['N',  (px, py, g) => px - halfW,      (px, py, g) => py - H - g   ],
        ['E',  (px, py, g) => px + g,          (px, py, g) => py - H / 2   ],
        ['W',  (px, py, g) => px - W - g,      (px, py, g) => py - H / 2   ],
        ['SE', (px, py, g) => px + g,          (px, py, g) => py + g       ],
        ['SW', (px, py, g) => px - W - g,      (px, py, g) => py + g       ],
        ['NE', (px, py, g) => px + g,          (px, py, g) => py - H - g   ],
        ['NW', (px, py, g) => px - W - g,      (px, py, g) => py - H - g   ],
      ];

      const candidates = [];
      for (let tier = 0; tier < TIERS; tier++) {
        const gap = BASE + tier * STEP;
        for (const [dir, lf, tf] of gens) {
          const left = lf(p.px, p.py, gap);
          const top  = tf(p.px, p.py, gap);
          const box = { left, top, right: left + W, bottom: top + H };
          const dist = Math.hypot((left + halfW) - p.px, (top + H / 2) - p.py);
          candidates.push({ dir, box, dist });
        }
      }
      candidates.sort((a, b) => a.dist - b.dist);
      return { idx: p.idx, px: p.px, py: p.py, candidates };
    });

    // ── Initialise via fast greedy pass ───────────────────────────────────
    const state = [];          // [{ item, candIdx, cand }]
    const placed = [];
    const unplaced = new Set(items.map((_, i) => i));

    while (unplaced.size > 0) {
      let bestI = -1, bestC = null, bestD = Infinity;
      for (const i of unplaced) {
        for (const c of items[i].candidates) {
          if (!placed.some(p => overlap(c.box, p))) {
            if (c.dist < bestD) { bestD = c.dist; bestI = i; bestC = c; }
            break;
          }
        }
      }
      if (bestI < 0) break;
      const idx = items[bestI].candidates.indexOf(bestC);
      state.push({ item: items[bestI], candIdx: idx, cand: bestC });
      placed.push(bestC.box);
      unplaced.delete(bestI);
    }
    // Any remaining items get their first candidate (will be penalised)
    for (const i of unplaced) {
      state.push({ item: items[i], candIdx: 0, cand: items[i].candidates[0] });
    }

    // ── Simulated annealing ───────────────────────────────────────────────
    const N = state.length;
    let boxes = state.map(s => s.cand.box);

    const ITERS = Math.max(300, N * 30);
    let T = 50;

    for (let k = 0; k < ITERS; k++) {
      const si = Math.floor(Math.random() * N);
      const st = state[si];
      const oldIdx = st.candIdx;
      const old = st.cand;
      const oldBox = boxes[si];
      let oldOverlapCount = 0;
      for (let j = 0; j < N; j++) {
        if (j !== si && overlap(oldBox, boxes[j])) {
          oldOverlapCount++;
        }
      }
      const oldScore = st.cand.dist * DIST_FACTOR + oldOverlapCount * OVERLAP_PENALTY;

      // Pick a random different candidate
      const newIdx = (st.candIdx + 1 + Math.floor(Math.random() * (st.item.candidates.length - 1)))
                     % st.item.candidates.length;
      const cand = st.item.candidates[newIdx];
      boxes[si] = cand.box;

      let newOverlapCount = 0;
      for (let j = 0; j < N; j++) {
        if (j !== si && overlap(cand.box, boxes[j])) {
          newOverlapCount++;
        }
      }
      const newScorePart = cand.dist * DIST_FACTOR + newOverlapCount * OVERLAP_PENALTY;

      const delta = newScorePart - oldScore;

      if (delta < 0 || Math.random() < Math.exp(-delta / T)) {
        // Accept
        st.candIdx = newIdx;
        st.cand = cand;
      } else {
        // Reject
        boxes[si] = oldBox;
      }

      T *= 0.995;
      if (T < 0.01) T = 50; // reheat if stuck
    }

    // ── Build result: greedy pack to keep max labels ──────────────────────
    const resultBoxes = [];
    const results = new Map();
    const ranked = [...state].sort((a, b) => a.cand.dist - b.cand.dist);

    for (const st of ranked) {
      if (!resultBoxes.some(p => overlap(st.cand.box, p))) {
        resultBoxes.push(st.cand.box);
        results.set(st.item.idx, st.cand);
      }
    }
    return results;
  }

  /**
   * Build a Leaflet divIcon that renders both the peak dot and its label,
   * positioned via 360° collision avoidance.
   * @param {number} px - Dot center X (pixel)
   * @param {number} py - Dot center Y (pixel)
   * @param {string} labelText - Label text
   * @param {object} dirResult - Direction result with bounding box
   * @param {object} [opts] - Optional styling overrides
   * @param {number} [opts.dotSize=24] - Dot visual diameter
   * @param {string} [opts.wrapperClass='stress-peak-icon-wrapper'] - Container CSS class
   * @param {string} [opts.dotClass='peak-dot'] - Dot CSS class
   * @param {string} [opts.dotExtraStyle=''] - Extra inline styles for the dot
   * @param {boolean} [opts.showGlow=true] - Whether to show the glow ring
   * @param {string} [opts.labelFontSize='10px'] - Label font size
   * @param {string} [opts.labelFontWeight='600'] - Label font weight
   * @param {string} [opts.labelExtraStyle=''] - Extra inline styles for the label
   */
  static buildLabelledIcon(px, py, labelText, dirResult, opts = {}) {
    const {
      dotSize = 24,
      wrapperClass = 'stress-peak-icon-wrapper',
      dotClass = 'peak-dot',
      dotExtraStyle = '',
      showGlow = true,
      labelFontSize = '10px',
      labelFontWeight = '600',
      labelExtraStyle = ''
    } = opts;

    const H = 18;
    const box = dirResult.box;
    const W = box.right - box.left;
    const DS = dotSize;

    const dotL = px - DS / 2, dotR = px + DS / 2;
    const dotT = py - DS / 2, dotB = py + DS / 2;
    const cLeft   = Math.min(dotL, box.left);
    const cRight  = Math.max(dotR, box.right);
    const cTop    = Math.min(dotT, box.top);
    const cBottom = Math.max(dotB, box.bottom);
    const cW = cRight - cLeft;
    const cH = cBottom - cTop;
    const dotCx = px - cLeft, dotCy = py - cTop;
    const labelL = box.left - cLeft, labelT = box.top - cTop;

    const escapedLabel = labelText.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    const html = [
      '<div class="', wrapperClass, '" style="position:relative;width:', cW, 'px;height:', cH, 'px;">',
        showGlow ? '<div class="peak-glow-ring" style="position:absolute;top:' + (dotCy - 12) + 'px;left:' + (dotCx - 12) + 'px;"></div>' : '',
        '<div class="', dotClass, '" style="position:absolute;top:', (dotCy - 5), 'px;left:', (dotCx - 5), 'px;width:10px;height:10px;', dotExtraStyle, '"></div>',
        '<div class="peak-map-label" style="position:absolute;top:', labelT, 'px;left:', labelL, 'px;width:', W, 'px;text-align:center;font-size:', labelFontSize, ';font-weight:', labelFontWeight, ';', labelExtraStyle, '">', escapedLabel, '</div>',
      '</div>'
    ].join('');

    return L.divIcon({
      className: '',
      html,
      iconSize: [cW, cH],
      iconAnchor: [px - cLeft, py - cTop]
    });
  }

  /**
   * Build a Leaflet divIcon for collective (multi-track) mode with track-colored dots.
   */
  static buildCollectiveLabelledIcon(px, py, labelText, dirResult, trackColor) {
    return GSRLabelManager.buildLabelledIcon(px, py, labelText, dirResult, {
      dotSize: 12,
      wrapperClass: '',
      dotClass: 'collective-peak-dot',
      showGlow: false,
      dotExtraStyle: 'border-radius:50%;background:' + trackColor + ';box-shadow:0 1px 3px rgba(0,0,0,0.15);border:1.5px solid #fff;',
      labelFontSize: '9px',
      labelFontWeight: '700',
      labelExtraStyle: 'color:#111111;text-shadow:0 0 3px #ffffff,0 0 5px #ffffff,0 0 8px #ffffff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none;line-height:1.2;'
    });
  }
}
