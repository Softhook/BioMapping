/**
 * GSRLiveView — the live receiver's view controller. Builds its own DOM
 * into a caller-supplied container and wires every button / keyboard
 * shortcut / animation-loop tick, so the same live UI can be the whole of
 * standalone live.html OR a panel inside index.html with no duplicated
 * markup.
 *
 * Depends on these page-level globals (loaded as classic <script>s before
 * this file — see live.html's <head> and index.html's script list):
 *   GSR_CONST                 src/core/constants.js       (analysis params + view presets)
 *   GsrFilter                 src/signal/gsr_filter.js
 *   GSRAnalyzer               src/signal/analyzer.js      (the graph's analysis engine)
 *   MapColors                 src/map/map_colors.js
 *   GpsPipeline               src/gps/gps_pipeline.js
 *   GSRFileSaver              src/core/file_saver.js
 *   GSRLiveBinaryParser       src/live/live_binary_parser.js
 *   LiveState                 src/live/live_state.js
 *   GSRLiveBluetoothManager   src/live/live_bluetooth.js
 *   buildLiveCsv              src/live/live_csv.js
 *   L.tileLayer.cache, …      src/live/live_tile_cache.js  (after Leaflet)
 *
 * Usage:  GSRLiveView.mount(containerEl)   — build + wire once
 * Tests reach the module-level functions/state (drawGraph, liveMap,
 * resetSession, …) through the vm context, same as the old inline block.
 */

// src/core/constants.js's GPS_DEFAULT.maxHdop (docs/csv_schema.md's "HDOP
// Gate Design" — 2.0 is the post-processing quality filter, distinct from
// the firmware's permissive 5.0 logging gate).
const LIVE_MAX_HDOP = 2.0;

// ==========================================================================
// The live UI markup — single source of truth, injected by mount(). Kept
// byte-for-byte equivalent to the old live.html <body> (only #map became
// #liveMap, to avoid colliding with index.html's analysis map).
// ==========================================================================
const LIVE_VIEW_MARKUP = `
<div id="app" class="no-map">
  <!-- Everything on one wrapping row: the toolbar action strip, the graph
       layer-toggle strip and the view dropdown all live in <header> so they
       sit on a single line when there's room and only break onto a second
       line when there isn't (styles.css .live-view header { flex-wrap: wrap }).
       Both control clusters use the app's .btn-group segmented style.
       The reconnect buttons' inline display:none is spelled with a space
       after the colon so the .btn-group border-collapse selectors (which
       match [style*="display: none"]) treat them as hidden even before
       renderStatus() first runs. Toggle/select ids are prefixed 'live' so
       they never collide with index.html's own #graphView etc. -->
  <header>
    <h1>Bio Mapping — Live</h1>
    <span id="statusBadge" class="badge">Not connected</span>
    <span id="reconnectErr"></span>
    <div class="btn-group">
      <button class="btn btn-outline" id="reconnectBtn" style="display: none;">Reconnect</button>
      <button class="btn btn-outline" id="newConnectionBtn" style="display: none;">New Connection</button>
      <button class="btn btn-outline" id="exportBtn" disabled>Export CSV</button>
      <button class="btn btn-outline" id="toggleMapBtn">Show Map (M)</button>
      <button class="btn btn-outline" id="cacheMapBtn" disabled>Cache Map (C)</button>
    </div>
    <div class="btn-group" id="gsrControls">
      <button class="btn btn-outline active" id="liveBtnToggleRaw">Raw</button>
      <button class="btn btn-outline active" id="liveBtnToggleFiltered">Filtered</button>
      <button class="btn btn-outline active" id="liveBtnToggleTonic">Tonic</button>
      <button class="btn btn-outline" id="liveBtnTogglePhasic">Phasic</button>
      <button class="btn btn-outline active" id="liveBtnTogglePeaks">Peaks</button>
      <button class="btn btn-outline active" id="liveBtnToggleHotspots">Hotspots</button>
    </div>
    <select id="liveGraphView" class="select-control" title="Graph view">
      <option value="signal" selected>Signal</option>
      <option value="tonic">Tonic (SCL)</option>
      <option value="phasic">Phasic (SCR)</option>
    </select>
  </header>

  <div id="graphWrap">
    <canvas id="graph"></canvas>
    <span id="graphLabel">GSR (μS) — last 2 min</span>
    <span id="graphValue">--</span>
  </div>

  <div id="locationBar">
    <input type="number" id="latInput" placeholder="Latitude" step="any" inputmode="decimal">
    <input type="number" id="lonInput" placeholder="Longitude" step="any" inputmode="decimal">
    <button id="goToLocationBtn">Go</button>
    <button id="myLocationBtn">My Location</button>
  </div>

  <div id="liveMap"></div>

  <footer>
    <span class="stat" id="statPackets">Packets: 0</span>
    <span class="stat" id="statGaps">Gaps: 0</span>
    <span class="stat" id="statGps">GPS: --</span>
    <span class="spacer"></span>
    <span class="stat" id="statLastSeen">--</span>
  </footer>
</div>

<div id="connectOverlay">
  <div style="font-size:20px;font-weight:600;">Bio Mapping 2 Live Stream</div>
  <button class="primary" id="connectBtn">Connect via Bluetooth</button>
  <button id="skipConnectBtn">Prepare Map Offline</button>
  <div class="err" id="connectErr"></div>
</div>
`;

// ==========================================================================
// Rolling graph — plain <canvas> 2D, showing the last GRAPH_WINDOW_S seconds
// of the session. Data comes from the shared GSRAnalyzer (see
// feedLiveAnalyzer() above); this file just plots the selected series +
// markers. No zoom/pan/timeline-drag — it's a live rolling window, not the
// main app's interactive track view.
// ==========================================================================
const GRAPH_WINDOW_S = 120;

// Plot inset — room for the left Y-axis value labels and the bottom time
// labels, echoing src/core/constants.js's GSR_CONST.MARGIN (70/35/22/10)
// scaled down for this compact panel.
const GRAPH_MARGIN = { top: 12, right: 12, bottom: 20, left: 58 };

// The live wire format carries GSR in nanosiemens (firmware
// gsr_sensor_get_raw — docs/csv_schema.md); the rest of the app works in
// microsiemens, and GSRCSVParser divides logged nS by 1000 on import
// (src/signal/csv_parser.js "Auto-detect Units"). Match that here so the
// live readout, its axis and the single-track "Signal" view are one scale.
const NS_TO_US = 1 / 1000;

// ==========================================================================
// GSR analysis for the live view — the same GSRAnalyzer.analyze() pipeline
// the main visualiser runs (Filtered/Tonic/Phasic decomposition, full-scan
// SCR peak detection, hotspots), fed one packet at a time onto a persistent
// buffer. Runs from the packet handler — NOT on the 60fps draw path, which
// just reads the cached series.
//
// The graph only offers the Signal / Tonic / Phasic views (the whole-session
// derived-metric views — Peak Density / AUC / Arousal / Tri — are index.html
// only; a live rolling window is the wrong place for a session-normalised
// score). analyze() still computes them, they're just not plotted here.
//
// analyze() re-walks the WHOLE buffer each call, so its cost grows with the
// session: order 1ms/call in the first minutes, tens of ms an hour in (it is
// linear in row count, not flat). feedLiveAnalyzer() throttles it to at most
// one call per LIVE_ANALYZE_MIN_INTERVAL_MS after a short warmup — the graph
// is a 2-minute rolling window and doesn't need more.
// ==========================================================================

// The app's shipped GSR defaults, no slider UI. Deconvolution and prominence
// stay off: full-scan trough-to-peak is O(n) and the only detector that
// stays real-time safe on a continuously growing buffer.
const LIVE_ANALYZE_PARAMS = (typeof GSR_CONST !== 'undefined' && GSR_CONST.GSR_DEFAULT)
  ? Object.assign({}, GSR_CONST.GSR_DEFAULT, { useDeconvolution: false, usePeakProminence: false, useCvxEDA: false })
  : {
      medianSize: 0, lpfWindow: 0, useGaitFilter: true, tonicMethod: 'lpf', tonicWindow: 45,
      peakThreshold: 0.05, shapeMinSnr: 2.5, minPeakQuality: 0,
      peakDensityWindow: 10, hotspotPercentile: 0.02,
      useDeconvolution: false, usePeakProminence: false, useCvxEDA: false,
    };

// analyze() cost is linear in the number of rows it's handed. feedLiveAnalyzer()
// keeps that flat two ways:
//
//  1. Trailing window (LIVE_ANALYZE_WINDOW_S). Only the last few minutes are
//     analysed — enough for the visible GRAPH_WINDOW_S plus lead-in for
//     decomposeTonicPhasic's zero-phase tonic EMA (tonicWindow 45s, ~4 time
//     constants to settle) and its ±6s local-floor pass. Older rows change
//     nothing that's drawn. The full recording still lives in
//     LiveState.packets — that's what Export CSV serialises.
//
//  2. Wall-clock throttle. Through the first LIVE_ANALYZE_WARMUP_ROWS packets
//     analyse on every one (the graph is still filling); after that, at most
//     one analyze() per LIVE_ANALYZE_MIN_INTERVAL_MS, to keep the per-call
//     window rebuild + GC churn off the packet path. The trace still redraws
//     at 60fps from the last computed series; markers are withheld for the
//     last LIVE_SETTLE_TAIL_S regardless.
//
// `let` on the tunables so tests can retune without feeding thousands of
// packets or waiting on a real clock.
const LIVE_ANALYZE_WINDOW_S = 300;       // trailing slice handed to analyze()
let LIVE_ANALYZE_WARMUP_ROWS = 400;      // ~2 min of session at STREAM_INTERVAL_S
let LIVE_ANALYZE_MIN_INTERVAL_MS = 1500;
let lastLiveAnalyzeAt = 0;               // Date.now() of the last analyze(); reset per session

// Trailing seconds of the analysed buffer whose tonic/phasic/peaks are still
// provisional — decomposeTonicPhasic is zero-phase and has a ±6s look-ahead
// local-floor pass, so the newest samples haven't settled. Matches
// PHASIC_COLOR_LAG_S. Peak / hotspot markers are not drawn inside this tail.
const LIVE_SETTLE_TAIL_S = 8;

// Per-view axis metadata for the Signal / Tonic / Phasic views (the subset
// of index.html's #graphView that makes sense on a live rolling window —
// no session-normalised metric views). `key` is the GSRAnalyzer series
// property; 'signal' has none (it is the multi-layer Raw/Filtered/Tonic view).
const LIVE_GRAPH_VIEWS = {
  signal: { label: 'GSR (μS)',      decimals: 2, unit: ' μS', allowNeg: false },
  tonic:  { key: 'tonic',  label: 'Tonic (SCL)',  decimals: 2, unit: ' μS', allowNeg: false },
  phasic: { key: 'phasic', label: 'Phasic (SCR)', decimals: 3, unit: ' μS', allowNeg: false },
};

// Top-of-panel control state — the six layer toggles + the view dropdown.
// Initial on/off mirrors index.html's #gsrPanel header (Raw/Filtered/Tonic/
// Peaks/Hotspots active, Phasic off).
const liveGsrView = {
  showRaw: true, showFiltered: true, showTonic: true,
  showPhasic: false, showPeaks: true, showHotspots: true,
  graphView: 'signal',
};

// The analyser runs on a TRAILING WINDOW of LiveState.packets, not a
// persistent grown-forever buffer. liveAnalyzerBase is the index in
// LiveState.packets of liveAnalyzer.raw[0], so an analyser-local row / peak
// index `i` maps to packet `liveAnalyzerBase + i` (drawGraph()'s gap lookup
// and the phasic mirror below both rely on that). Reset per session.
let liveAnalyzer = null;
let liveAnalyzerBase = 0;

// Rebuild the analyser's trailing-window buffer from the newest
// LIVE_ANALYZE_WINDOW_S of LiveState.packets, then re-run the pipeline
// (subject to the wall-clock throttle above) and refresh the map's delayed
// phasic recolour from the same decomposition.
function feedLiveAnalyzer() {
  if (typeof GSRAnalyzer === 'undefined') return; // analysis deps not on the page
  if (!liveAnalyzer) {
    liveAnalyzer = new GSRAnalyzer();
    liveAnalyzer.raw = [];
    liveAnalyzer.sampleRate = 1 / LiveState.STREAM_INTERVAL_S;
  }
  const A = liveAnalyzer;
  const pkts = LiveState.packets;
  if (pkts.length === 0) return;

  // Wall-clock throttle (see LIVE_ANALYZE_MIN_INTERVAL_MS): every packet
  // through the warmup (gated on session length, not window size), then no
  // more than one analyze() per interval.
  if (pkts.length > LIVE_ANALYZE_WARMUP_ROWS &&
      Date.now() - lastLiveAnalyzeAt < LIVE_ANALYZE_MIN_INTERVAL_MS) {
    return;
  }
  lastLiveAnalyzeAt = Date.now();

  // Trailing window: first packet at or after (now - LIVE_ANALYZE_WINDOW_S).
  // Scanned back from the end — it's a bounded number of packets.
  const cutoff = pkts[pkts.length - 1].timestamp - LIVE_ANALYZE_WINDOW_S;
  let w0 = pkts.length;
  while (w0 > 0 && pkts[w0 - 1].timestamp >= cutoff) w0--;
  liveAnalyzerBase = w0;

  // Fresh array each call so GSRAnalyzer._ensureSeriesPool() does a clean
  // rebuild off it — the window is bounded (~LIVE_ANALYZE_WINDOW_S /
  // STREAM_INTERVAL_S rows), so that's a flat ~1ms regardless of walk length.
  const raw = new Array(pkts.length - w0);
  for (let i = w0; i < pkts.length; i++) {
    const p = pkts[i];
    raw[i - w0] = {
      time: p.timestamp,
      val: p.gsrRaw * NS_TO_US,
      lat: p.lat, lon: p.lon, hdop: p.hdop,
      sats: p.sats, fixType: p.fixType, hasGps: !!p.valid,
    };
  }
  A.raw = raw;

  A.analyze(LIVE_ANALYZE_PARAMS, 0);

  // Mirror the window's phasic values back onto their LiveState.packets
  // entries so the live map's delayed track recolour can pick them up.
  const ph = A.phasic;
  for (let i = 0; i < ph.length; i++) pkts[liveAnalyzerBase + i].phasic = ph[i].val;
  recolorPhasicSegments();
}

// Pull the single-track GSR view's own theme tokens (src/render/renderer.js
// reads the same custom properties via getThemeColor) so the two graphs
// stay visually identical. Falls back to the light-theme defaults when no
// stylesheet is in scope (the unit-test jsdom).
function graphThemeColor(name, fallback) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch (e) {
    return fallback;
  }
}

// A "1 / 2 / 5 × 10ⁿ" gridline step giving ~5 divisions across `span` — the
// same shape as renderer.js's drawGridY step presets, computed rather than
// table-driven since a live session's GSR (µS) has no fixed range.
function niceStep(span) {
  if (!(span > 0)) return 1;
  const rough = span / 5;
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / mag;
  return (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag;
}

function drawGraph() {
  const canvas = document.getElementById('graph');
  const wrap = document.getElementById('graphWrap');
  const dpr = window.devicePixelRatio || 1;
  const w = wrap.clientWidth, h = wrap.clientHeight;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const A = liveAnalyzer;
  const pkts = LiveState.packets;
  if (!A || !A.raw || A.raw.length === 0) return;

  // Rolling "now" edge — advance between packets for 60fps scrolling while
  // streaming; freeze once disconnected (the user left the Live view, which
  // drops the BLE link but keeps the buffer) so the last two minutes stay
  // visible instead of scrolling off the left edge.
  const streaming = LiveState.status === 'connected' || LiveState.status === 'reconnecting';
  const elapsed = (lastPacketArrivalTime && streaming) ? (Date.now() - lastPacketArrivalTime) / 1000 : 0;
  const lastT = (lastPacketTimestamp || A.raw[A.raw.length - 1].time) + elapsed;
  const t0 = lastT - GRAPH_WINDOW_S;

  const view = liveGsrView.graphView;
  const cfg = LIVE_GRAPH_VIEWS[view] || LIVE_GRAPH_VIEWS.signal;

  // Series to plot, back-to-front. For 'signal' the primary Filtered trace is
  // drawn last (on top of Raw/Tonic/Phasic), matching src/render/sketch.js.
  const layers = [];
  if (view === 'signal') {
    if (liveGsrView.showRaw && A.raw.length)
      layers.push({ data: A.raw, col: graphThemeColor('--color-raw', '#7c7c76') + '8c', w: 1.5 });
    if (liveGsrView.showTonic && A.tonic && A.tonic.length)
      layers.push({ data: A.tonic, col: graphThemeColor('--color-tonic', '#a30091'), w: 2 });
    if (liveGsrView.showPhasic && A.phasic && A.phasic.length)
      layers.push({ data: A.phasic, col: graphThemeColor('--color-phasic', '#008f3c') + 'c8', w: 1.5 });
    if (liveGsrView.showFiltered && A.filtered && A.filtered.length)
      layers.push({ data: A.filtered, col: graphThemeColor('--color-filtered', '#005bc4'), w: 2.2, primary: true });
  } else {
    const series = A[cfg.key];
    if (series && series.length)
      layers.push({
        data: series,
        col: graphThemeColor(view === 'phasic' ? '--color-phasic' : '--color-filtered',
                             view === 'phasic' ? '#008f3c' : '#005bc4'),
        w: 2, primary: true,
      });
  }
  if (layers.length === 0) return;

  // ── Y-range across the visible slice of every drawn layer ────────────────
  let minV = Infinity, maxV = -Infinity;
  for (const L of layers) {
    const d = L.data;
    for (let i = d.length - 1; i >= 0 && d[i].time >= t0; i--) {
      const v = d[i].val;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
  }
  if (!(minV <= maxV)) return;
  const floorSpan = cfg.unit === ' μS' ? 0.2 : Math.max(1e-6, Math.abs(maxV) * 0.02);
  if (maxV - minV < floorSpan) { maxV += floorSpan / 2; minV -= floorSpan / 2; }
  const padV = (maxV - minV) * 0.1;
  minV -= padV; maxV += padV;
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
  const AXIS_FONT = '10px "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

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
  const markerSeries = (view === 'signal')
    ? (A.filtered && A.filtered.length ? A.filtered : A.raw)
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
    ctx.font = '700 11px "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    for (let k = 0; k < list.length; k++) {
      const p = list[k];
      if (p.excluded) continue;
      if (p.time < t0 || p.time > settledBefore) continue;
      const s = markerSeries[p.index];
      if (!s) continue;
      const x = xForT(p.time), y = yForV(s.val);
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
      const x = xForT(d[i].time), y = yForV(d[i].val);
      if (!penDown || gap) { ctx.moveTo(x, y); penDown = true; }
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // ── Readouts. 'signal' shows the latest raw GSR reading; a metric view
  //    shows that metric's latest value. ──────────────────────────────────
  const primary = layers.find(L => L.primary) || layers[layers.length - 1];
  const readVal = (view === 'signal' && pkts.length)
    ? pkts[pkts.length - 1].gsrRaw * NS_TO_US
    : primary.data[primary.data.length - 1].val;
  document.getElementById('graphValue').textContent = readVal.toFixed(cfg.decimals) + cfg.unit;
  document.getElementById('graphLabel').textContent = cfg.label + ' — last 2 min';
}

// ==========================================================================
// Leaflet map wrapper — same CartoDB "light_all" tile layer + init options
// visualiser/map.js's GSRMapManager.initMap() actually uses (map.js:72-89;
// the plan doc's "Dark Matter" reference didn't match the real file —
// checked directly rather than carried over unverified).
// ==========================================================================
let liveMap = null;
let liveLastLatLng = null;
let liveMarker = null;
let gsrMin = Infinity, gsrMax = -Infinity;

// Delayed phasic recoloring for the live track — updateLiveMap() paints a
// new segment immediately from raw GSR (0-latency), then this repaints it
// once its phasic value has settled. phasicMin is fixed at 0 (phasic is
// already clamped >= 0 in decomposeTonicPhasic — 0 is a meaningful "at
// baseline" reference point, unlike gsrMin/gsrMax which have no natural
// floor) so only the ceiling needs to track the session's peak.
let phasicMax = 0;
const pendingPhasicSegments = []; // FIFO of { pkt, line } awaiting a settled pkt.phasic
const PHASIC_COLOR_LAG_S = 8; // matches decomposeTonicPhasic's ±6s local-floor window + margin
// Hard cap on the recolour backlog. recolorPhasicSegments() runs from
// feedLiveAnalyzer() (i.e. only when analyze() actually ran — every packet
// through the warmup, then once per LIVE_ANALYZE_MIN_INTERVAL_MS), and it
// only drains an entry once that packet's phasic value has both been
// computed AND settled (PHASIC_COLOR_LAG_S). If analyse() is being skipped
// for a stretch, or the newest packets haven't settled, the queue keeps
// growing while updateLiveMap() adds a segment per fix. Without a cap the
// queue — and the Leaflet polylines each entry pins — would grow unbounded.
// Past the cap the oldest segment simply keeps its provisional raw-GSR
// colour — the same outcome resetSession() and an abrupt session end accept.
const PENDING_PHASIC_MAX = 1200; // ~6 min at STREAM_INTERVAL_S

// decomposeTonicPhasic() is a zero-phase/batch filter (a backward EMA pass,
// then a ±6s look-ahead "local floor" correction) — a sample's phasic value
// isn't trustworthy the instant feedLiveAnalyzer() first computes it; it
// needs a few seconds of FUTURE packets behind it to stabilize (the same
// reason drawGraph() withholds peak markers inside LIVE_SETTLE_TAIL_S). This
// repaints already-drawn segments once that's true, using the exact
// decomposition the analyser already ran — not a second, cheaper
// approximation. A session that ends abruptly leaves its
// last ~8s of segments in their initial raw-GSR color; resetSession()
// clears this queue so a stale entry from a prior session can never block
// it (pkt.phasic would otherwise never be set again once LiveState.packets
// has moved on, wedging this FIFO forever on that one entry).
function recolorPhasicSegments() {
  const lastPkt = LiveState.packets[LiveState.packets.length - 1];
  if (!lastPkt) return;
  while (pendingPhasicSegments.length > 0) {
    const entry = pendingPhasicSegments[0];
    if (entry.pkt.phasic === undefined) break; // not in drawGraph()'s current window yet
    if (lastPkt.timestamp - entry.pkt.timestamp < PHASIC_COLOR_LAG_S) break; // not settled yet
    phasicMax = Math.max(phasicMax, entry.pkt.phasic);
    entry.line.setStyle({ color: MapColors.getColorForValue(entry.pkt.phasic, 0, phasicMax) });
    pendingPhasicSegments.shift();
  }
}

// Offline tile caching — the L.TileLayer.cache subclass and the
// normalizeTileCacheUrl / buildTileUrl / latLngToTileCoords helpers live in
// src/live/live_tile_cache.js (loaded before this file, after Leaflet).
async function cacheCurrentMapArea() {
  if (!liveMap) return;
  const bounds = liveMap.getBounds();
  const currentZoom = Math.round(liveMap.getZoom());
  const startZoom = Math.min(currentZoom, 18);
  const maxZoom = Math.min(startZoom + 3, 18);

  const cacheMapBtn = document.getElementById('cacheMapBtn');
  const originalText = cacheMapBtn.textContent;
  cacheMapBtn.disabled = true;
  cacheMapBtn.textContent = 'Caching...';

  let tileLayerInstance = null;
  liveMap.eachLayer((layer) => {
    if (layer instanceof L.TileLayer) {
      tileLayerInstance = layer;
    }
  });

  if (!tileLayerInstance) {
    cacheMapBtn.disabled = false;
    cacheMapBtn.textContent = originalText;
    return;
  }

  const tileUrls = [];

  for (let z = startZoom; z <= maxZoom; z++) {
    const minTile = latLngToTileCoords(bounds.getNorthWest(), z);
    const maxTile = latLngToTileCoords(bounds.getSouthEast(), z);

    const numTiles = Math.pow(2, z);
    const minX = Math.max(0, Math.min(numTiles - 1, minTile.x));
    const maxX = Math.max(0, Math.min(numTiles - 1, maxTile.x));
    const minY = Math.max(0, Math.min(numTiles - 1, Math.min(minTile.y, maxTile.y)));
    const maxY = Math.max(0, Math.min(numTiles - 1, Math.max(minTile.y, maxTile.y)));

    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        const url = buildTileUrl(tileLayerInstance._url, x, y, z);
        const cacheUrl = normalizeTileCacheUrl(url);
        tileUrls.push({ url, cacheUrl });
      }
    }
  }

  const totalTiles = tileUrls.length;
  if (totalTiles === 0) {
    cacheMapBtn.disabled = false;
    cacheMapBtn.textContent = originalText;
    alert('No tiles to cache in the current view.');
    return;
  }

  if (totalTiles > 300) {
    if (!confirm(`Caching the current view at zoom levels ${currentZoom} to ${maxZoom} will download ${totalTiles} tiles. Proceed?`)) {
      cacheMapBtn.disabled = false;
      cacheMapBtn.textContent = originalText;
      return;
    }
  }

  let newlyDownloaded = 0, alreadyCached = 0;
  try {
    const cache = await caches.open('leaflet-map-tiles');

    const batchSize = 10;
    for (let i = 0; i < tileUrls.length; i += batchSize) {
      const batch = tileUrls.slice(i, i + batchSize);
      await Promise.all(batch.map(async (tile) => {
        try {
          // Re-caching an already-cached area is a real, expected flow (the
          // location picker exists precisely so this can be run ahead of a
          // trip) — skip tiles already on disk instead of re-downloading
          // the whole view every time.
          if (await cache.match(tile.cacheUrl)) {
            alreadyCached++;
            return;
          }
          const response = await fetch(tile.url);
          if (response.ok) {
            await cache.put(tile.cacheUrl, response);
            newlyDownloaded++;
          }
        } catch (err) {
          console.warn('Failed to cache tile:', tile.url, err);
        }
      }));
      cacheMapBtn.textContent = `Caching (${Math.round(((newlyDownloaded + alreadyCached) / totalTiles) * 100)}%)`;
    }

    cacheMapBtn.textContent = 'Cached!';
    setTimeout(() => {
      cacheMapBtn.disabled = false;
      cacheMapBtn.textContent = originalText;
    }, 2000);

    alert(`Map area ready offline: ${newlyDownloaded + alreadyCached} of ${totalTiles} tiles (${newlyDownloaded} downloaded, ${alreadyCached} already cached).`);
  } catch (err) {
    console.error('Map caching failed:', err);
    alert('Failed to cache map area: ' + err.message);
    cacheMapBtn.disabled = false;
    cacheMapBtn.textContent = originalText;
  }
}

function initLiveMap() {
  liveMap = L.map('liveMap', {
    zoomControl: true,
    scrollWheelZoom: true,
    preferCanvas: true,
    zoomSnap: 0.25,
    zoomDelta: 0.25,
    maxZoom: 22
  }).setView([0, 0], 2);
  if (liveMap.attributionControl) {
    liveMap.attributionControl.setPrefix(false);
  }
  // CARTO now requires a (free) key on its raster basemaps — without one the
  // tiles load but carry an "API key required" watermark. Key from
  // config.local.js (window.BIOMAP_CONFIG) or localStorage; see
  // config.local.example.js. localStorage access can throw on file:// with
  // site data disabled — live.html is opened that way, so guard it.
  let cartoKey = (window.BIOMAP_CONFIG && window.BIOMAP_CONFIG.cartoApiKey) || '';
  if (!cartoKey) {
    try { cartoKey = localStorage.getItem('bioMappingCartoApiKey') || ''; } catch (e) { /* no-op */ }
  }
  const cartoUrl = 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png' +
    (cartoKey ? '?key=' + encodeURIComponent(cartoKey) : '');
  L.tileLayer.cache(cartoUrl, {
    maxZoom: 22,
    maxNativeZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a>',
  }).addTo(liveMap);

  // Enable the Cache Map button
  document.getElementById('cacheMapBtn').disabled = false;
}

// Map visibility is a manual toggle (toggleMapBtn / showMap / hideMap below),
// not something GPS packets turn on — so an area can be panned to and cached
// before there's any GPS reception at all.
function showMap() {
  document.getElementById('app').classList.remove('no-map');
  if (!liveMap) {
    initLiveMap();
  } else {
    liveMap.invalidateSize();
  }
  drawGraph();
}

function hideMap() {
  document.getElementById('app').classList.add('no-map');
  drawGraph();
}

// Meters/pixel at this zoom is small enough that a ~2min stretch of a
// typical walking pace (packets every STREAM_INTERVAL_S, ~0.3-0.4m apart)
// fills a comfortable chunk of a phone screen while the per-segment color
// stays legible — zoom 17's wider view diluted color detail across a much
// longer, less relevant stretch of the walk.
const LIVE_ZOOM = 18;

// Recentre the follow-map on the walker at most this often. panTo() with
// animation re-renders every track polyline on every frame of the tween, so
// firing it per packet (~3/s) against a session-long pile of segments was a
// near-continuous full-layer redraw. The walker's dot still moves every
// packet (liveMarker.setLatLng below) — only the map's recentre lags, by at
// most this interval, which at walking pace is a few metres of drift.
const LIVE_PAN_MIN_INTERVAL_MS = 900;
let lastLivePanAt = 0;

function updateLiveMap(pkt) {
  if (!pkt.valid || isNaN(pkt.lat) || isNaN(pkt.lon)) return;
  const gated = GpsPipeline.applyFixTypeGate(
    GpsPipeline.applyHdopGate([pkt], LIVE_MAX_HDOP), 2);
  if (gated.length === 0) return;

  const latlng = [pkt.lat, pkt.lon];

  if (liveMap) {
    gsrMin = Math.min(gsrMin, pkt.gsrRaw);
    gsrMax = Math.max(gsrMax, pkt.gsrRaw);
    const color = MapColors.getColorForValue(pkt.gsrRaw, gsrMin, gsrMax);

    if (!liveLastLatLng) {
      liveMap.setView(latlng, LIVE_ZOOM);
    } else if (pkt.gap) {
      // §8 "Show the gap, don't paper over it" — a real time gap (dropped/
      // disconnected interval) breaks the trail rather than drawing a
      // straight line across whatever distance was covered during it.
    } else {
      // Per-segment coloring: one short polyline per new point, colored
      // provisionally from that point's raw GSR value for instant feedback
      // — recolorPhasicSegments() (called from feedLiveAnalyzer()) repaints
      // it with the more meaningful phasic value once that's settled.
      const line = L.polyline([liveLastLatLng, latlng], { color, weight: 3 }).addTo(liveMap);
      pendingPhasicSegments.push({ pkt, line });
      if (pendingPhasicSegments.length > PENDING_PHASIC_MAX) pendingPhasicSegments.shift();
    }

    if (!liveMarker) {
      liveMarker = L.circleMarker(latlng, { radius: 6, color: '#fff', weight: 2, fillColor: color, fillOpacity: 1 }).addTo(liveMap);
    } else {
      liveMarker.setLatLng(latlng);
      liveMarker.setStyle({ fillColor: color });
    }
    const nowMs = Date.now();
    if (nowMs - lastLivePanAt >= LIVE_PAN_MIN_INTERVAL_MS) {
      lastLivePanAt = nowMs;
      liveMap.panTo(latlng, { animate: true, duration: 0.3 });
    }
  }
  liveLastLatLng = latlng;
}

// ==========================================================================
// CSV export. buildLiveCsv() (src/live/live_csv.js) does the schema
// serialisation (docs/csv_schema.md's canonical 11-column GPS+GSR schema +
// the firmware's integrity bracket); GSRFileSaver.saveFile() (src/core/
// file_saver.js) puts up the same OS "Save location" dialog the rest of the
// app's exports use, with the plain-download fallback when the File System
// Access API isn't available.
// ==========================================================================
function exportCsv() {
  const name = `biomap_live_${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
  return GSRFileSaver.saveFile(buildLiveCsv(LiveState.packets, Date.now()), name);
}

// ==========================================================================
// Wire-up state — element refs and session bookkeeping, assigned by mount().
// ==========================================================================
let statusBadge, reconnectBtn, newConnectionBtn, exportBtn,
    connectOverlay, connectBtn, connectErr, reconnectErr,
    cacheMapBtn, toggleMapBtn, latInput, lonInput;

let bleManager = null;
let lastPacketTimestamp = 0;
let lastPacketArrivalTime = 0;
let animationFrameId = null;
let wakeLock = null;
let mapVisible = false;
// Whether the live view is the one on screen. Always true for standalone
// live.html; index.html's view switcher flips it via activate()/deactivate()
// so the redraw loop doesn't run against a hidden panel.
let viewActive = true;

const MANUAL_LOCATION_ZOOM = 15;

async function requestWakeLock() {
  if ('wakeLock' in navigator) {
    try {
      if (wakeLock && !wakeLock.released) {
        await wakeLock.release();
      }
      wakeLock = await navigator.wakeLock.request('screen');
    } catch (err) {
      console.warn('Could not acquire screen wake lock:', err);
    }
  }
}

function releaseWakeLock() {
  if (wakeLock !== null) {
    wakeLock.release();
    wakeLock = null;
  }
}

function startAnimationLoop() {
  if (animationFrameId) return;
  function frame() {
    if (viewActive && (LiveState.status === 'connected' || LiveState.status === 'reconnecting')) {
      drawGraph();
    }
    animationFrameId = requestAnimationFrame(frame);
  }
  animationFrameId = requestAnimationFrame(frame);
}

function stopAnimationLoop() {
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
}

function renderStatus(status) {
  const labels = {
    connecting: ['Connecting…', ''],
    connected: ['Live', 'live'],
    reconnecting: ['Reconnecting…', 'warn'],
    disconnected: ['Disconnected', 'bad'],
  };
  const [text, cls] = labels[status] || ['Not connected', ''];
  statusBadge.textContent = text;
  statusBadge.className = 'badge' + (cls ? ' ' + cls : '');
  // manualReconnect() is a no-op without a prior device reference, so don't
  // show it before a connection has ever been attempted (e.g. right after
  // "Prepare Map Offline" skips the connect overlay). "New Connection"
  // stays available regardless — it's the escape hatch back to the connect
  // overlay for exactly that case, as well as the one that actually works
  // after the Flipper exits/re-enters Live Stream mode — see
  // GSRLiveBluetoothManager's _handleDisconnect() doc comment for why the
  // lightweight Reconnect button alone can't be trusted to cover that case.
  reconnectBtn.style.display = (status === 'disconnected' && bleManager) ? '' : 'none';
  newConnectionBtn.style.display = status === 'disconnected' ? '' : 'none';
  if (status !== 'disconnected') reconnectErr.textContent = '';
}

// A fresh requestDevice() (initial Connect, or "New Connection" after the
// lightweight Reconnect gave up) may land on a different physical device, or
// the same one power-cycled — either way its device-uptime timestamp starts
// low again, unlike _subscribe()-only reconnects which resume the same
// counter. Carrying the old session's packets/last-position/color-range
// into that would misdraw the graph window and put a bogus connecting line
// on the map (see addPacket()'s gap-detection comment), so start clean.
function resetSession() {
  LiveState.packets = [];
  LiveState.gapCount = 0;
  liveLastLatLng = null;
  gsrMin = Infinity;
  gsrMax = -Infinity;
  phasicMax = 0;
  // A pending entry's pkt.phasic only ever gets set by a drawGraph() that
  // still has that packet in LiveState.packets — once packets is reset
  // above, any leftover entry from the old session would never settle,
  // wedging recolorPhasicSegments()'s FIFO on it forever.
  pendingPhasicSegments.length = 0;
  lastPacketTimestamp = 0;
  lastPacketArrivalTime = 0;
  // Drop the analyser's trailing-window buffer too, and its base offset.
  if (liveAnalyzer) liveAnalyzer.raw = [];
  liveAnalyzerBase = 0;
  lastLiveAnalyzeAt = 0;
  lastLivePanAt = 0;
  document.getElementById('statPackets').textContent = 'Packets: 0';
  document.getElementById('statGaps').textContent = 'Gaps: 0';
  document.getElementById('statGps').textContent = 'GPS: --';
  document.getElementById('statLastSeen').textContent = '--';
  exportBtn.disabled = true;
  drawGraph();
}

// Connects over Web Bluetooth using the browser's device chooser. We show all
// nearby devices so that custom-named or renamed Flippers can connect.
async function attemptConnect() {
  connectErr.textContent = '';
  if (!navigator.bluetooth) {
    connectErr.textContent = 'Web Bluetooth is not available in this browser (needs desktop Chrome/Edge or Android Chrome/Edge — not Safari, even on macOS).';
    return;
  }
  resetSession();
  LiveState.setStatus('connecting');
  // onStatusText fires for both pre-connect issues (shown in the overlay,
  // still visible at this point) and later reconnect failures (overlay
  // already hidden by then) — write to both; whichever is visible is seen.
  bleManager = new GSRLiveBluetoothManager((text) => {
    connectErr.textContent = text;
    reconnectErr.textContent = text;
  });
  try {
    await bleManager.connect();
    connectOverlay.classList.add('hidden');
  } catch (e) {
    LiveState.setStatus('disconnected');
    connectErr.textContent = (e && e.message) ? e.message : String(e);
  }
}

// The six GSR layer toggles (Raw/Filtered/Tonic/Phasic/Peaks/Hotspots) and
// the view dropdown — index.html's #gsrPanel header controls, minus the
// left-sidebar sliders. Each just flips a liveGsrView flag and redraws;
// analysis itself always runs with the app's shipped GSR_DEFAULT params.
const LIVE_GSR_TOGGLES = [
  ['liveBtnToggleRaw', 'showRaw'],
  ['liveBtnToggleFiltered', 'showFiltered'],
  ['liveBtnToggleTonic', 'showTonic'],
  ['liveBtnTogglePhasic', 'showPhasic'],
  ['liveBtnTogglePeaks', 'showPeaks'],
  ['liveBtnToggleHotspots', 'showHotspots'],
];

function bindLiveGsrControls() {
  for (const [id, key] of LIVE_GSR_TOGGLES) {
    const btn = document.getElementById(id);
    if (!btn) continue;
    btn.classList.toggle('active', !!liveGsrView[key]);
    btn.addEventListener('click', () => {
      liveGsrView[key] = !liveGsrView[key];
      btn.classList.toggle('active', liveGsrView[key]);
      drawGraph();
    });
  }
  const sel = document.getElementById('liveGraphView');
  if (sel) {
    sel.value = liveGsrView.graphView;
    sel.addEventListener('change', () => {
      liveGsrView.graphView = sel.value;
      drawGraph();
    });
  }
}

function updateToggleMapBtn() {
  toggleMapBtn.textContent = mapVisible ? 'Hide Map (M)' : 'Show Map (M)';
  toggleMapBtn.classList.toggle('active', mapVisible);
}

// Single place that changes map visibility, so `mapVisible` (used to skip
// re-showing an already-visible map) and the toggle button's own label/state
// can't drift apart the way they could when each caller (the toggle click,
// and both branches of goToLatLon below) flipped them separately.
function setMapVisible(visible) {
  mapVisible = visible;
  if (visible) showMap(); else hideMap();
  updateToggleMapBtn();
}

function goToLatLon(lat, lon, zoom) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    alert('Enter a valid latitude (-90 to 90) and longitude (-180 to 180).');
    return;
  }
  if (!mapVisible) setMapVisible(true);
  liveMap.setView([lat, lon], zoom);
}

// ==========================================================================
// GSRLiveView — build the DOM into `container` and bind everything. Call
// once. Idempotent (a second call is a no-op).
// ==========================================================================
const GSRLiveView = {
  _mounted: false,

  mount(container) {
    if (this._mounted) return;
    this._mounted = true;

    // .live-view scopes every rule in styles.css's "Live Stream (BLE) view"
    // section to this subtree — so the live UI's bare header/footer/button
    // selectors never leak into the host page.
    container.classList.add('live-view');
    container.innerHTML = LIVE_VIEW_MARKUP;

    statusBadge      = document.getElementById('statusBadge');
    reconnectBtn     = document.getElementById('reconnectBtn');
    newConnectionBtn = document.getElementById('newConnectionBtn');
    exportBtn        = document.getElementById('exportBtn');
    connectOverlay   = document.getElementById('connectOverlay');
    connectBtn       = document.getElementById('connectBtn');
    connectErr       = document.getElementById('connectErr');
    reconnectErr     = document.getElementById('reconnectErr');
    cacheMapBtn      = document.getElementById('cacheMapBtn');
    toggleMapBtn     = document.getElementById('toggleMapBtn');
    latInput         = document.getElementById('latInput');
    lonInput         = document.getElementById('lonInput');

    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState === 'visible') {
        if (LiveState.status === 'connected' || LiveState.status === 'reconnecting') {
          await requestWakeLock();
        }
      }
    });

    LiveState.on('status', (status) => {
      renderStatus(status);
      if (status === 'connected' || status === 'reconnecting') {
        startAnimationLoop();
        requestWakeLock();
      } else {
        stopAnimationLoop();
        drawGraph();
        releaseWakeLock();
      }
    });
    LiveState.on('packet', (pkt) => {
      document.getElementById('statPackets').textContent = `Packets: ${LiveState.packets.length}`;
      document.getElementById('statGaps').textContent = `Gaps: ${LiveState.gapCount}`;
      document.getElementById('statGps').textContent = pkt.valid
        ? `GPS: ${pkt.fixType === 3 ? '3D' : pkt.fixType === 2 ? '2D' : 'fix'} (${pkt.sats} sat)`
        : 'GPS: No fix';
      document.getElementById('statLastSeen').textContent = `Last: ${pkt.timestamp.toFixed(1)}s`;

      lastPacketTimestamp = pkt.timestamp;
      lastPacketArrivalTime = Date.now();

      exportBtn.disabled = false;
      updateLiveMap(pkt);
      // Grow the analyser buffer + re-run the pipeline (off the 60fps draw
      // path). drawGraph() then reads .filtered/.tonic/.phasic/.peaks/… on
      // the next animation frame.
      feedLiveAnalyzer();
    });

    connectBtn.addEventListener('click', attemptConnect);

    // Lets the map be shown, panned, and cached before (or without)
    // connecting to a device — the whole reason toggleMapBtn/locationBar
    // aren't gated on a BLE connection or GPS fix.
    document.getElementById('skipConnectBtn').addEventListener('click', () => {
      connectOverlay.classList.add('hidden');
    });

    reconnectBtn.addEventListener('click', () => {
      if (bleManager) bleManager.manualReconnect();
    });

    // Escape hatch when the lightweight Reconnect keeps failing — goes back
    // through a fresh requestDevice() instead of reusing a possibly-stale
    // BluetoothDevice reference (see _handleDisconnect()'s doc comment).
    newConnectionBtn.addEventListener('click', () => {
      reconnectErr.textContent = '';
      connectErr.textContent = '';
      connectOverlay.classList.remove('hidden');
    });

    exportBtn.addEventListener('click', exportCsv);

    bindLiveGsrControls();

    cacheMapBtn.addEventListener('click', cacheCurrentMapArea);

    toggleMapBtn.addEventListener('click', () => setMapVisible(!mapVisible));

    document.getElementById('goToLocationBtn').addEventListener('click', () => {
      goToLatLon(parseFloat(latInput.value), parseFloat(lonInput.value), MANUAL_LOCATION_ZOOM);
    });

    document.getElementById('myLocationBtn').addEventListener('click', () => {
      if (!navigator.geolocation) {
        alert('Geolocation is not available in this browser.');
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          latInput.value = pos.coords.latitude;
          lonInput.value = pos.coords.longitude;
          goToLatLon(pos.coords.latitude, pos.coords.longitude, MANUAL_LOCATION_ZOOM);
        },
        (err) => {
          alert('Could not get your location: ' + err.message);
        },
        { enableHighAccuracy: true, timeout: 10000 }
      );
    });

    window.addEventListener('keydown', (e) => {
      // Inside index.html these listeners outlive the Live tab (mount is
      // once, no unmount) — only claim the p/m/c shortcuts while the Live
      // view is actually the one on screen. (There is no live-view fullscreen
      // shortcut: in-app GSRLayoutManager owns F for the whole app; standalone
      // live.html has no self-fullscreen affordance.)
      if (typeof AppState !== 'undefined' && AppState.viewMode !== 'live') return;
      // Don't hijack keys while the user is typing coordinates.
      if (e.target === latInput || e.target === lonInput) return;

      if (e.key === 'p' || e.key === 'P') {
        const b = document.getElementById('liveBtnTogglePhasic');
        if (b) b.click();
      }
      if (e.key === 'm' || e.key === 'M') {
        toggleMapBtn.click();
      }
      if ((e.key === 'c' || e.key === 'C') && !cacheMapBtn.disabled) {
        cacheCurrentMapArea();
      }
    });

    window.addEventListener('resize', drawGraph);

    updateToggleMapBtn();

    // Map visibility/init is a manual toggle (toggleMapBtn), not tied to GPS —
    // see showMap()/hideMap() above.
    renderStatus('disconnected');
  },

  // Called by index.html's view switcher when the Live tab becomes / stops
  // being the visible view. No-ops for standalone live.html, which never
  // calls them (viewActive stays true from load).
  activate() {
    viewActive = true;
    // The Leaflet map may have been created / last sized while #livePanel was
    // display:none; re-measure now that it's visible, then redraw the graph
    // at its real dimensions.
    if (liveMap && typeof liveMap.invalidateSize === 'function') {
      liveMap.invalidateSize();
    }
    drawGraph();
    if (LiveState.status === 'connected' || LiveState.status === 'reconnecting') {
      startAnimationLoop();
    }
  },

  // Leaving the Live view drops the BLE link — a walk isn't a background
  // activity, and holding the radio + screen wake lock open on an unseen
  // panel (while updateLiveMap() keeps drawing segments off the live feed
  // and pendingPhasicSegments grows) is just waste. The accumulated packets,
  // the drawn track and the Export button are all kept: renderStatus() then
  // shows "Reconnect" (resume this same session via the retained device
  // reference) alongside "New Connection" (a fresh requestDevice(), which
  // resets). Nothing else is torn down, so a later activate() just resumes.
  deactivate() {
    viewActive = false;
    stopAnimationLoop();
    if (bleManager) bleManager.disconnect();
    releaseWakeLock();
    // Fires renderStatus() (Reconnect / New Connection buttons) + a final
    // drawGraph(), now frozen at the last packet — see drawGraph()'s
    // `streaming` gate. A no-op if we were already disconnected.
    if (LiveState.status === 'connected' || LiveState.status === 'reconnecting') {
      LiveState.setStatus('disconnected');
    }
  },

  // The in-app F-key "display mode" (GSRLayoutManager) hides the app header
  // and goes edge-to-edge; the live Leaflet map isn't under any
  // ResizeObserver, so it must be told to re-measure. drawGraph() picks up
  // the graph canvas's new size on the same pass.
  onDisplayModeChange() {
    if (liveMap && typeof liveMap.invalidateSize === 'function') {
      liveMap.invalidateSize();
    }
    drawGraph();
  },
};

if (typeof window !== 'undefined') window.GSRLiveView = GSRLiveView;
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GSRLiveView };
}
