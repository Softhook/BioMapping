/**
 * Live graph — the live receiver's rolling GSR graph (plain <canvas> 2D).
 * Shows the last GRAPH_WINDOW_S of the session from the shared live
 * GSRAnalyzer, plotting the selected Signal / Tonic / Phasic series plus
 * peak/hotspot markers. No zoom/pan/timeline-drag — a live rolling window,
 * not the main app's interactive track view.
 *
 * Split out of src/live/live_view.js (2026-09). The shell (live_view.js)
 * owns the analyser, the view state (liveGsrView) and the packet clock;
 * this file only reads them. Top-level bindings (GRAPH_WINDOW_S,
 * LIVE_GRAPH_VIEWS, drawGraph, …) live in the shared global lexical scope —
 * see live_view.js's header — so tests reach them through the vm context
 * tests/support/boot_live.js hands back.
 *
 * Reads (bare globals, resolved at call time):
 *   LiveState                 src/live/live_state.js
 *   liveGsrView, liveAnalyzer, liveAnalyzerBase,
 *     lastPacketArrivalTime, lastPacketTimestamp,
 *     LIVE_SETTLE_TAIL_S      src/live/live_view.js (shell)
 */

// ==========================================================================
// Rolling graph — plain <canvas> 2D, showing the last GRAPH_WINDOW_S seconds
// of the session. Data comes from the shared GSRAnalyzer (see
// feedLiveAnalyzer() above); this file just plots the selected series +
// markers. No zoom/pan/timeline-drag — it's a live rolling window, not the
// main app's interactive track view.
// ==========================================================================
import { LiveState } from './live_state.mjs';
import {
  LIVE_SETTLE_TAIL_S,
  lastPacketArrivalTime,
  lastPacketTimestamp,
  liveAnalyzer,
  liveAnalyzerBase,
  liveGsrView,
} from './live_view.mjs';

export const GRAPH_WINDOW_S = 120;

// Plot inset — room for the left Y-axis value labels and the bottom time
// labels, echoing src/core/constants.js's GSR_CONST.MARGIN (70/35/22/10)
// scaled down for this compact panel.
export const GRAPH_MARGIN = { top: 12, right: 12, bottom: 20, left: 58 };

// The live wire format carries GSR in nanosiemens (firmware
// gsr_sensor_get_raw — docs/csv_schema.md); the rest of the app works in
// microsiemens, and GSRCSVParser divides logged nS by 1000 on import
// (src/signal/csv_parser.js "Auto-detect Units"). Match that here so the
// live readout, its axis and the single-track "Signal" view are one scale.
export const NS_TO_US = 1 / 1000;

// Per-view axis metadata for the Signal / Tonic / Phasic views (the subset
// of index.html's #graphView that makes sense on a live rolling window —
// no session-normalised metric views). `key` is the GSRAnalyzer series
// property; 'signal' has none (it is the multi-layer Raw/Filtered/Tonic view).
export const LIVE_GRAPH_VIEWS = {
  signal: { label: 'GSR (μS)', decimals: 2, unit: ' μS', allowNeg: false },
  tonic: {
    key: 'tonic',
    label: 'Tonic (SCL)',
    decimals: 2,
    unit: ' μS',
    allowNeg: false,
  },
  phasic: {
    key: 'phasic',
    label: 'Phasic (SCR)',
    decimals: 3,
    unit: ' μS',
    allowNeg: false,
  },
};

// Pull the single-track GSR view's own theme tokens (src/render/renderer.js
// reads the same custom properties via getThemeColor) so the two graphs
// stay visually identical. Falls back to the light-theme defaults when no
// stylesheet is in scope (the unit-test jsdom).
export function graphThemeColor(name, fallback) {
  try {
    const v = getComputedStyle(document.documentElement)
      .getPropertyValue(name)
      .trim();
    return v || fallback;
  } catch (e) {
    return fallback;
  }
}

// A "1 / 2 / 5 × 10ⁿ" gridline step giving ~5 divisions across `span` — the
// same shape as renderer.js's drawGridY step presets, computed rather than
// table-driven since a live session's GSR (µS) has no fixed range.
export function niceStep(span) {
  if (!(span > 0)) return 1;
  const rough = span / 5;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const norm = rough / mag;
  return (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag;
}

export function drawGraph() {
  const canvas = document.getElementById('graph');
  const wrap = document.getElementById('graphWrap');
  const dpr = window.devicePixelRatio || 1;
  const w = wrap.clientWidth,
    h = wrap.clientHeight;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const A = liveAnalyzer;
  const pkts = LiveState.packets;
  if (!A || !A.raw || A.raw.length === 0) return;

  // Rolling "now" edge — advance between packets for 60fps scrolling while
  // streaming; freeze once disconnected (the user left the Live view, which
  // drops the BLE link but keeps the buffer) so the last two minutes stay
  // visible instead of scrolling off the left edge.
  const streaming =
    LiveState.status === 'connected' || LiveState.status === 'reconnecting';
  const elapsed =
    lastPacketArrivalTime && streaming
      ? (Date.now() - lastPacketArrivalTime) / 1000
      : 0;
  const lastT = (lastPacketTimestamp || A.raw[A.raw.length - 1].time) + elapsed;
  const t0 = lastT - GRAPH_WINDOW_S;

  const view = liveGsrView.graphView;
  const cfg = LIVE_GRAPH_VIEWS[view] || LIVE_GRAPH_VIEWS.signal;

  // Series to plot, back-to-front. For 'signal' the primary Filtered trace is
  // drawn last (on top of Raw/Tonic/Phasic), matching src/render/sketch.js.
  const layers = [];
  if (view === 'signal') {
    if (liveGsrView.showTonic && A.tonic && A.tonic.length)
      layers.push({
        data: A.tonic,
        col: graphThemeColor('--color-tonic', '#a30091'),
        w: 2,
      });
    if (liveGsrView.showPhasic && A.phasic && A.phasic.length)
      layers.push({
        data: A.phasic,
        col: graphThemeColor('--color-phasic', '#008f3c') + 'c8',
        w: 1.5,
      });
    if (liveGsrView.showFiltered && A.filtered && A.filtered.length)
      layers.push({
        data: A.filtered,
        col: graphThemeColor('--color-filtered', '#005bc4'),
        w: 2.2,
        primary: true,
      });
  } else {
    const series = A[cfg.key];
    if (series && series.length)
      layers.push({
        data: series,
        col: graphThemeColor(
          view === 'phasic' ? '--color-phasic' : '--color-filtered',
          view === 'phasic' ? '#008f3c' : '#005bc4',
        ),
        w: 2,
        primary: true,
      });
  }
  if (layers.length === 0) return;

  // ── Y-range across the visible slice of every drawn layer ────────────────
  let minV = Infinity,
    maxV = -Infinity;
  for (const L of layers) {
    const d = L.data;
    for (let i = d.length - 1; i >= 0 && d[i].time >= t0; i--) {
      const v = d[i].val;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
  }
  if (!(minV <= maxV)) return;
  const floorSpan =
    cfg.unit === ' μS' ? 0.2 : Math.max(1e-6, Math.abs(maxV) * 0.02);
  if (maxV - minV < floorSpan) {
    maxV += floorSpan / 2;
    minV -= floorSpan / 2;
  }
  const padV = (maxV - minV) * 0.1;
  minV -= padV;
  maxV += padV;
  if (!cfg.allowNeg && minV < 0) minV = 0;

  // ── Plot region (matches the single-track GSR view) ─────────────────────
  const plotL = GRAPH_MARGIN.left;
  const plotR = w - GRAPH_MARGIN.right;
  const plotT = GRAPH_MARGIN.top;
  const plotB = h - GRAPH_MARGIN.bottom;
  const plotW = Math.max(1, plotR - plotL);
  const plotH = Math.max(1, plotB - plotT);

  const gridCol = graphThemeColor('--canvas-grid', 'rgba(17, 17, 17, 0.06)');
  const axisCol = graphThemeColor('--canvas-axis', 'rgba(17, 17, 17, 0.15)');
  const textCol = graphThemeColor('--canvas-text', '#444444');
  const AXIS_FONT =
    '10px "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

  const xForT = (t) => plotL + ((t - t0) / GRAPH_WINDOW_S) * plotW;
  const yForV = (v) => plotT + (1 - (v - minV) / (maxV - minV)) * plotH;

  // ── Y grid + right-aligned value labels (mirrors renderer.drawGridY) ────
  const yStep = niceStep(maxV - minV);
  const yStart = Math.ceil(minV / yStep) * yStep;
  ctx.strokeStyle = gridCol;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let v = yStart; v <= maxV; v += yStep) {
    const y = Math.round(yForV(v)) + 0.5;
    ctx.moveTo(plotL, y);
    ctx.lineTo(plotR, y);
  }
  ctx.stroke();
  ctx.fillStyle = textCol;
  ctx.font = AXIS_FONT;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  let lastLabelY = null;
  for (let v = yStart; v <= maxV; v += yStep) {
    const y = yForV(v);
    if (lastLabelY !== null && Math.abs(y - lastLabelY) < 14) continue; // thin so labels never crowd
    ctx.fillText(v.toFixed(cfg.decimals) + cfg.unit, plotL - 8, y);
    lastLabelY = y;
  }

  // ── X grid + rolling time labels ("now", "-20s", …) ────────────────────
  ctx.strokeStyle = gridCol;
  ctx.beginPath();
  for (let offset = 0; offset <= GRAPH_WINDOW_S; offset += 20) {
    const x = Math.round(plotR - (offset / GRAPH_WINDOW_S) * plotW) + 0.5;
    ctx.moveTo(x, plotT);
    ctx.lineTo(x, plotB);
  }
  ctx.stroke();
  ctx.fillStyle = textCol;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let offset = 0; offset <= GRAPH_WINDOW_S; offset += 20) {
    const x = plotR - (offset / GRAPH_WINDOW_S) * plotW;
    if (x < plotL + 4 || x > plotR - 4) continue;
    ctx.fillText(offset === 0 ? 'now' : `-${offset}s`, x, plotB + 5);
  }

  // ── Axis frame: left + bottom, like the single view's L-shaped axis ────
  ctx.strokeStyle = axisCol;
  ctx.beginPath();
  ctx.moveTo(plotL + 0.5, plotT);
  ctx.lineTo(plotL + 0.5, plotB + 0.5);
  ctx.lineTo(plotR, plotB + 0.5);
  ctx.stroke();

  // ── Peak + hotspot markers. Drawn BEFORE the traces so the primary GSR
  //    curve stays the final beginPath…stroke pair (test_live_app.js's gap
  //    regression keys off names.lastIndexOf('beginPath')). Nothing is drawn
  //    inside the unsettled tail — decomposeTonicPhasic's zero-phase +
  //    ±6s look-ahead means the newest peaks aren't trustworthy yet
  //    (LIVE_SETTLE_TAIL_S, same idea as the map's PHASIC_COLOR_LAG_S).
  //
  //    Styling mirrors the single-track GSR graph (src/render/renderer.js's
  //    drawPeakMarkers / drawHotspotMarkers): a plain peak is a small filled
  //    --color-peak dot; a hotspot is a larger hollow --color-hotspot ring
  //    (a hotspot IS a peak, just the curated memorableEvents subset) with a
  //    ★ above it. The renderer's hover-only shaded region / onset dot /
  //    connector and its DOM pulse-ring aren't carried over — this is a
  //    non-interactive rolling window, not the zoomable track view. ─────────
  const markerSeries =
    view === 'signal'
      ? A.filtered && A.filtered.length
        ? A.filtered
        : A.raw
      : layers[0].data;
  const settledBefore = lastT - LIVE_SETTLE_TAIL_S;
  const peakCol = graphThemeColor('--color-peak', '#d10024');
  const hotspotCol = graphThemeColor('--color-hotspot', '#ff1744');
  const canvasBg = graphThemeColor('--canvas-bg', '#ffffff');
  const drawPeakDot = (list) => {
    if (!list) return;
    ctx.fillStyle = peakCol;
    for (let k = 0; k < list.length; k++) {
      const p = list[k];
      if (p.excluded) continue;
      if (p.time < t0 || p.time > settledBefore) continue;
      const s = markerSeries[p.index];
      if (!s) continue;
      ctx.beginPath();
      ctx.arc(xForT(p.time), yForV(s.val), 3.2, 0, Math.PI * 2);
      ctx.fill();
    }
  };
  const drawHotspot = (list) => {
    if (!list) return;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.font =
      '700 11px "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    for (let k = 0; k < list.length; k++) {
      const p = list[k];
      if (p.excluded) continue;
      if (p.time < t0 || p.time > settledBefore) continue;
      const s = markerSeries[p.index];
      if (!s) continue;
      const x = xForT(p.time),
        y = yForV(s.val);
      ctx.beginPath();
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.fillStyle = canvasBg;
      ctx.fill();
      ctx.strokeStyle = hotspotCol;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = hotspotCol;
      ctx.fillText('★', x, y - 11);
    }
  };
  // Peaks first so a hotspot's bolder ring + star sit on top where they overlap.
  if (liveGsrView.showPeaks) drawPeakDot(A.peaks);
  if (liveGsrView.showHotspots) drawHotspot(A.memorableEvents);

  // ── Traces. gap flag comes from the matching LiveState.packets entry —
  //    analyser row i is packet liveAnalyzerBase + i (trailing window). ────
  for (const L of layers) {
    ctx.strokeStyle = L.col;
    ctx.lineWidth = L.w;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    const d = L.data;
    let s = d.length - 1;
    while (s > 0 && d[s - 1].time >= t0) s--;
    let penDown = false;
    for (let i = s; i < d.length; i++) {
      const gp = pkts[liveAnalyzerBase + i];
      const gap = gp && gp.gap;
      const x = xForT(d[i].time),
        y = yForV(d[i].val);
      if (!penDown || gap) {
        ctx.moveTo(x, y);
        penDown = true;
      } else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // ── Readouts. 'signal' shows the latest raw GSR reading; a metric view
  //    shows that metric's latest value. ──────────────────────────────────
  const primary = layers.find((L) => L.primary) || layers[layers.length - 1];
  const readVal =
    view === 'signal' && pkts.length
      ? pkts[pkts.length - 1].gsrRaw * NS_TO_US
      : primary.data[primary.data.length - 1].val;
  document.getElementById('graphValue').textContent =
    readVal.toFixed(cfg.decimals) + cfg.unit;
  document.getElementById('graphLabel').textContent =
    cfg.label + ' — last 2 min';
}
