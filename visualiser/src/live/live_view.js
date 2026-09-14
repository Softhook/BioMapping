/**
 * GSRLiveView — the live receiver's view controller (shell). Builds its own
 * DOM into a caller-supplied container and wires every button / keyboard
 * shortcut / animation-loop tick, so the same live UI can be the whole of
 * standalone live.html OR a panel inside index.html with no duplicated
 * markup.
 *
 * This file is the SHELL: markup, BLE connection/session lifecycle, and
 * analysis orchestration (feedLiveAnalyzer). The two renderers were split
 * out (2026-09) and load before this file:
 *   live_graph.js             drawGraph + GRAPH_WINDOW_S / LIVE_GRAPH_VIEWS
 *   live_map.js               liveMap / updateLiveMap / markers / tile cache
 *
 * All three files are classic <script>s sharing one global lexical scope, so
 * top-level `const`/`function` bindings declared in one are visible (and,
 * for `let`, assignable) in the others — the same mechanism the sibling
 * modules (LiveState, GSRLiveBluetoothManager, …) already use. Declare each
 * name in exactly one file.
 *
 * Depends on these page-level globals (loaded as classic <script>s before
 * this file — see live.html's <head> and index.html's script list):
 *   GSR_CONST                 src/core/constants.js       (analysis params + view presets)
 *   GsrFilter                 src/signal/gsr_filter.js
 *   GSRAnalyzer               src/signal/analyzer.js      (the graph's analysis engine)
 *   GSRFileSaver              src/core/file_saver.js
 *   GSRLiveBinaryParser       src/live/live_binary_parser.js
 *   LiveState                 src/live/live_state.js
 *   GSRLiveBluetoothManager   src/live/live_bluetooth.js
 *   buildLiveCsv              src/live/live_csv.js
 *
 * Usage:  GSRLiveView.mount(containerEl)   — build + wire once
 * Tests reach the module-level functions/state (drawGraph, liveMap,
 * resetSession, …) through the vm context tests/support/boot_live.js hands
 * back, rather than through this file's one public `GSRLiveView` export.
 */

// Device-class detection — map-primary mobile layout vs graph-primary
// desktop layout (mount() below), AND (via GSRLiveView.isCompactLayout(),
// the same function, not a second check) whether index.html lands its
// initial tab on Live instead of Single Track (src/ui/events.js). 768px
// matches styles.css's one existing mobile breakpoint (the sidebar-drawer
// rule) and the new `@media (max-width: 768px)` rules in this file's own
// "Live Stream (BLE) view" CSS section — kept in sync by comment since a
// media query can't be shared between CSS and JS without a build step.
// `pointer: coarse` keeps a narrowed desktop browser window (fine pointer)
// from reading as mobile — it matters more here than for the sidebar, since
// this flips which of two very different layouts is the default. Checked
// once (at mount, and once at index.html boot), not live-updating, so a
// mid-session resize/rotation never yanks a layout choice the user is
// already in. Supports phones in portrait (<=768px) and landscape (<=500px height).
const LIVE_MOBILE_QUERY = '((max-width: 768px) and (pointer: coarse)), ((max-height: 500px) and (pointer: coarse))';
function isCompactLiveLayout() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' &&
    window.matchMedia(LIVE_MOBILE_QUERY).matches;
}

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
    <div class="btn-group" id="liveMetricGroup" title="Select Live Metric">
      <button type="button" class="btn btn-outline active" data-metric="signal" id="liveMetricSignal">Signal</button>
      <button type="button" class="btn btn-outline" data-metric="tonic" id="liveMetricTonic">Tonic</button>
      <button type="button" class="btn btn-outline" data-metric="phasic" id="liveMetricPhasic">Phasic</button>
    </div>
    <div class="btn-group" id="gsrControls">
      <button class="btn btn-outline active" id="liveBtnTogglePeaks" title="Toggle Peak Markers">Peaks</button>
      <button class="btn btn-outline active" id="liveBtnToggleHotspots" title="Toggle Hotspot Stars">Hotspots</button>
      <button class="btn btn-outline active" id="liveBtnToggleFiltered" style="display: none;">Filtered</button>
      <button class="btn btn-outline active" id="liveBtnToggleTonic" style="display: none;">Tonic</button>
      <button class="btn btn-outline" id="liveBtnTogglePhasic" style="display: none;">Phasic</button>
    </div>
    <select id="liveGraphView" class="select-control" title="Graph view" style="display: none;">
      <option value="signal" selected>Signal</option>
      <option value="tonic">Tonic (SCL)</option>
      <option value="phasic">Phasic (SCR)</option>
    </select>
    <div class="btn-group" id="liveSessionActions">
      <button class="btn btn-outline" id="connectionBtn" style="display: none;">Connect</button>
      <button class="btn btn-outline" id="exportBtn" disabled>Export CSV</button>
      <button class="btn btn-outline" id="toggleMapBtn">Show Map (M)</button>
      <button class="btn btn-outline" id="cacheMapBtn" disabled>Cache Map (C)</button>
      <button class="btn btn-outline live-exit-display-btn" id="liveBtnExitDisplay" style="display: none;"><i class="fa-solid fa-compress"></i> Exit</button>
    </div>
  </header>

  <div id="graphWrap">
    <canvas id="graph"></canvas>
    <span id="graphLabel">GSR (μS) — last 2 min</span>
    <span id="graphValue">--</span>
  </div>

  <div id="liveMap">
    <div class="live-map-controls">
      <button type="button" class="live-map-btn" id="myLocationBtn" title="Center on My Location" aria-label="My Location">
        <i class="fa-solid fa-crosshairs"></i>
      </button>
    </div>
  </div>

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

<!-- Mobile-only floating action button (styles.css hides it entirely on
     desktop) — the map-primary mobile layout's sole way to pick the
     Signal/Tonic/Phasic metric or switch Map <-> Graph: #liveMetricGroup and
     #liveGraphView (which the FAB's metric chips duplicate) and
     #toggleMapBtn (which its Map/Graph chip duplicates) are unconditionally
     hidden on mobile, in both submodes. #gsrControls (Raw/Peaks/Hotspots)
     is NOT one of these — the FAB has no equivalent for those, so mobile
     Graph mode still shows them in the header. #liveFabMenu's contents are
     rebuilt by renderFabMenu(), which keys off the current mapVisible
     state. -->
<div class="live-fab" id="liveFab">
  <button type="button" class="live-fab-toggle" id="liveFabToggle" aria-label="Live view options" aria-expanded="false">
    <i class="fa-solid fa-sliders"></i>
  </button>
  <div class="live-fab-menu" id="liveFabMenu"></div>
</div>
`;

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
  ? Object.assign({}, GSR_CONST.GSR_DEFAULT, { useDeconvolution: false, useSparsEDA: false, usePeakProminence: false, useCvxEDA: false })
  : {
      medianSize: 0, lpfWindow: 0, useGaitFilter: true, tonicMethod: 'lpf', tonicWindow: 45,
      peakThreshold: 0.045, shapeMinSnr: 2.5, minPeakQuality: 0,
      peakDensityWindow: 30, hotspotPercentile: 0.02,
      useDeconvolution: false, useSparsEDA: false, usePeakProminence: false, useCvxEDA: false,
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

// The mobile FAB's metric chips — same three options as #liveGraphView above
// (kept as separate short labels since the FAB chips are much narrower than
// the dropdown's option text). Order matches the dropdown.
const LIVE_FAB_METRICS = [
  { value: 'signal', label: 'Signal' },
  { value: 'tonic', label: 'Tonic' },
  { value: 'phasic', label: 'Phasic' },
];

const LIVE_FAB_TOGGLES = [
  { key: 'showPeaks', id: 'liveBtnTogglePeaks', label: 'Peaks' },
  { key: 'showHotspots', id: 'liveBtnToggleHotspots', label: 'Hotspots' },
];

// Top-of-panel control state — the layer toggles + the view dropdown. Raw is
// intentionally NOT one of the live view's layers (the live graph shows the
// processed signal, not the raw conductance). Phasic starts ON for desktop,
// where it is drawn underneath the filtered signal exactly like the main
// visualiser's Signal view; on the compact (mobile) layout the graph is too
// small to carry the extra trace so it stays off.
const liveGsrView = {
  showFiltered: true, showTonic: true,
  showPhasic: !isCompactLiveLayout(),
  showPeaks: true, showHotspots: true,
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

  // Mirror the window's tonic + phasic values back onto their
  // LiveState.packets entries so the live map's delayed track recolour can
  // pick them up — unconditionally, regardless of which metric is currently
  // selected (liveGsrView.graphView), so switching metric mid-session has
  // settled values ready to use immediately rather than waiting for a fresh
  // analyze() pass under the new metric.
  const tn = A.tonic, ph = A.phasic;
  for (let i = 0; i < ph.length; i++) {
    const pkt = pkts[liveAnalyzerBase + i];
    pkt.phasic = ph[i].val;
    if (tn && tn[i]) pkt.tonic = tn[i].val;
  }
  flushSettledSegments();
  renderLiveMapMarkers();
}

// drawGraph() + its helpers (graphThemeColor / niceStep) and constants
// (GRAPH_WINDOW_S / GRAPH_MARGIN / NS_TO_US / LIVE_GRAPH_VIEWS) live in
// src/live/live_graph.js — loaded before this file, same global lexical
// scope, so they're called here as bare globals.

// The live follow-map (liveMap, updateLiveMap, renderLiveMapMarkers,
// flushSettledSegments/recolorAllTrackSegments, cacheCurrentMapArea, showMap/
// hideMap, LIVE_ZOOM, …) lives in src/live/live_map.js — loaded before this
// file, same global lexical scope, so those names are used here as bare
// globals (resetSession() below clears liveMap's segment queues + markers).

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
let statusBadge, connectionBtn, exportBtn,
    connectOverlay, connectBtn, connectErr, reconnectErr,
    cacheMapBtn, toggleMapBtn,
    liveFabToggle, liveFabMenu;

let needNewConnection = false;
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
    try {
      if (!wakeLock.released) wakeLock.release().catch(() => {});
    } catch (e) {}
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

// Connection orchestration controller: handles Web Bluetooth lifecycle,
// connection button state transitions, and connection action dispatch.
const LiveConnectionController = {
  get needNewConnection() {
    return needNewConnection;
  },
  set needNewConnection(val) {
    needNewConnection = Boolean(val);
  },

  get bleManager() {
    return bleManager;
  },
  set bleManager(mgr) {
    bleManager = mgr;
  },

  render(status) {
    if (!connectionBtn) return;
    if (status === 'disconnected') {
      connectionBtn.style.display = '';
      connectionBtn.disabled = false;
      if (needNewConnection || !bleManager || !bleManager.device) {
        connectionBtn.textContent = (needNewConnection || bleManager) ? 'New Connection' : 'Connect';
      } else {
        connectionBtn.textContent = 'Reconnect';
      }
    } else if (status === 'connected') {
      connectionBtn.style.display = '';
      connectionBtn.disabled = false;
      connectionBtn.textContent = 'Disconnect';
      needNewConnection = false;
    } else if (status === 'connecting' || status === 'reconnecting') {
      connectionBtn.style.display = '';
      connectionBtn.disabled = true;
      connectionBtn.textContent = status === 'reconnecting' ? 'Reconnecting…' : 'Connecting…';
    } else {
      connectionBtn.style.display = 'none';
    }
    if (connectBtn) {
      connectBtn.disabled = (status === 'connecting' || status === 'reconnecting');
    }
  },

  async handleAction() {
    if (reconnectErr) reconnectErr.textContent = '';
    if (connectErr) connectErr.textContent = '';
    if (LiveState.status === 'connected') {
      if (bleManager) bleManager.disconnect();
      LiveState.setStatus('disconnected');
      return;
    }
    // If we already have a device, try lightweight reconnect first to
    // preserve the current walk session and packet buffer.
    if (bleManager && bleManager.device && !needNewConnection) {
      const ok = await bleManager.manualReconnect();
      if (ok) return;
      // Lightweight reconnect failed: the session or bond cannot be resumed
      // as-is (e.g. Flipper BLE restarted). Flip to "New Connection" so the
      // user's next click with a fresh gesture launches the chooser.
      needNewConnection = true;
      if (bleManager) bleManager.abandon();
      renderStatus('disconnected');
      return;
    }
    const forceNewChooser = needNewConnection;
    needNewConnection = false;
    await attemptConnect(forceNewChooser);
  },

  async connect(forceNewChooser = false) {
    if (connectErr) connectErr.textContent = '';
    if (!navigator.bluetooth) {
      if (connectErr) {
        connectErr.textContent = 'Web Bluetooth is not available in this browser (requires Chrome on Android/desktop, or a Web Bluetooth browser like Bluefy on iOS). You can still Prepare Map Offline.';
      }
      return;
    }
    // A previous manager may still have an auto-reconnect loop in flight
    // (mid-backoff wait, or blocked inside its own _subscribe() timeout race)
    // — e.g. the user gave up on the lightweight Reconnect and hit "New
    // Connection" while it was still retrying. abandon() marks it superseded (so its
    // eventual status update is a no-op instead of stomping the fresh
    // connection below) and cancels its own GATT link so it stops competing
    // with this new attempt for the radio. Grab its device reference first —
    // tryResumeDevice() below uses it to silently reacquire the SAME device
    // (no chooser dialog) if the platform still remembers our permission for
    // it, which is exactly the case "New Connection" exists for: the
    // lightweight Reconnect gave up, but the device itself may still be fine.
    // If the user explicitly requested a New Connection after a failed reconnect,
    // skip tryResumeDevice so we don't spend 3.5s retrying a failed peripheral and wedging the radio.
    const previousDevice = (forceNewChooser || needNewConnection) ? null : (bleManager ? bleManager.device : null);
    if (bleManager) bleManager.abandon();
    resetSession();
    needNewConnection = false;
    LiveState.setStatus('connecting');
    // onStatusText fires for both pre-connect issues (shown in the overlay,
    // still visible at this point) and later reconnect failures (overlay
    // already hidden by then) — write to both; whichever is visible is seen.
    bleManager = new GSRLiveBluetoothManager((text) => {
      if (connectErr) connectErr.textContent = text;
      if (reconnectErr) reconnectErr.textContent = text;
    });
    try {
      const resumed = previousDevice && await bleManager.tryResumeDevice(previousDevice);
      if (!resumed) await bleManager.connect();
      if (connectOverlay) connectOverlay.classList.add('hidden');
    } catch (e) {
      LiveState.setStatus('disconnected');
      if (connectErr) connectErr.textContent = (e && e.message) ? e.message : String(e);
    }
  },
};

function renderStatus(status) {
  const labels = {
    connecting: ['Connecting…', ''],
    connected: ['Live', 'live'],
    reconnecting: ['Reconnecting…', 'warn'],
    disconnected: ['Disconnected', 'bad'],
  };
  const [text, cls] = labels[status] || ['Not connected', ''];
  if (statusBadge) {
    statusBadge.textContent = text;
    statusBadge.className = 'badge' + (cls ? ' ' + cls : '');
  }

  const headerBadge = document.getElementById('appHeaderStatusBadge');
  if (headerBadge) {
    headerBadge.textContent = text;
    headerBadge.className = 'badge' + (cls ? ' ' + cls : '');
  }

  LiveConnectionController.render(status);

  if (status !== 'disconnected' && reconnectErr) reconnectErr.textContent = '';
}

// A fresh requestDevice() (initial Connect, or "New Connection" after the
// lightweight Reconnect gave up) may land on a different physical device, or
// the same one power-cycled — either way its device-uptime timestamp starts
// low again, unlike _subscribe()-only reconnects which resume the same
// counter. Carrying the old session's packets/last-position/color-range
// into that would misdraw the graph window and put a bogus connecting line
// on the map (see addPacket()'s gap-detection comment), so start clean.
function resetSession() {
  if (liveMap) {
    for (const { line } of allTrackSegments) {
      if (typeof line.remove === 'function') line.remove();
      else if (typeof liveMap.removeLayer === 'function') liveMap.removeLayer(line);
    }
    if (liveMarker) {
      if (typeof liveMarker.remove === 'function') liveMarker.remove();
      else if (typeof liveMap.removeLayer === 'function') liveMap.removeLayer(liveMarker);
      liveMarker = null;
    }
  }
  LiveState.reset();
  liveLastLatLng = null;
  gsrMin = Infinity;
  gsrMax = -Infinity;
  tonicMin = Infinity;
  tonicMax = -Infinity;
  phasicMax = 0;
  // A pending entry's pkt.tonic/pkt.phasic only ever gets set by a
  // feedLiveAnalyzer() that still has that packet in LiveState.packets —
  // once packets is reset above, any leftover entry from the old session
  // would never settle, wedging flushSettledSegments()'s FIFO on it
  // forever.
  pendingSegments.length = 0;
  allTrackSegments.length = 0;
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
  clearLiveMapMarkers();
  drawGraph();
}

// Connects over Web Bluetooth using the browser's device chooser. We show all
// nearby devices so that custom-named or renamed Flippers can connect.
async function attemptConnect(forceNewChooser = false) {
  return LiveConnectionController.connect(forceNewChooser);
}

// The GSR layer toggles (Filtered/Tonic/Phasic/Peaks/Hotspots) and the view
// dropdown — index.html's #gsrPanel header controls, minus Raw and the
// left-sidebar sliders. Each just flips a liveGsrView flag and redraws;
// analysis itself always runs with the app's shipped GSR_DEFAULT params.
const LIVE_GSR_TOGGLES = [
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
      renderFabMenu();
      drawGraph();
      renderLiveMapMarkers();
    });
  }
  const sel = document.getElementById('liveGraphView');
  if (sel) {
    sel.value = liveGsrView.graphView;
    sel.addEventListener('change', () => setLiveGraphMetric(sel.value));
  }
}

// Sets the ONE shared Signal/Tonic/Phasic metric that drives both the graph
// (drawGraph()'s non-'signal' branch) and the live map's track colour
// (recolorAllTrackSegments() / flushSettledSegments()) — the desktop
// #liveGraphView dropdown and the mobile FAB's metric chips both call this
// same function, so there is exactly one code path regardless of which UI
// drove the change.
function setLiveGraphMetric(metric) {
  if (!LIVE_GRAPH_VIEWS[metric] || liveGsrView.graphView === metric) return;
  liveGsrView.graphView = metric;
  const sel = document.getElementById('liveGraphView');
  if (sel) sel.value = metric;
  const metricBtns = document.querySelectorAll('#liveMetricGroup [data-metric]');
  metricBtns.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.metric === metric);
  });
  renderFabMenu();
  drawGraph();
  recolorAllTrackSegments();
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
  renderFabMenu();
}

// ==========================================================================
// Mobile floating action button — the map-primary mobile layout's sole way
// to change metric or flip Map<->Graph (styles.css hides it entirely on
// desktop, where the header controls above remain the only UI). Its chip
// set is a function of `mapVisible`, not a fixed menu, but it's always the
// three metric chips plus one action chip — only the action chip's
// direction changes: in Map mode (the mobile default) that's a Graph chip;
// in Graph mode (mapVisible false, today's `.no-map` fullscreen graph) it's
// a Map chip instead, since there is only one destination to offer there.
// ==========================================================================
function closeFabMenu() {
  if (!liveFabMenu) return;
  liveFabMenu.classList.remove('open');
  if (liveFabToggle) liveFabToggle.setAttribute('aria-expanded', 'false');
}

function toggleFabMenu() {
  if (!liveFabMenu) return;
  const open = !liveFabMenu.classList.contains('open');
  liveFabMenu.classList.toggle('open', open);
  if (liveFabToggle) liveFabToggle.setAttribute('aria-expanded', String(open));
}

function renderFabMenu() {
  if (!liveFabMenu) return;
  const chips = [];

  // 1. Map / graph
  if (mapVisible) {
    chips.push('<button type="button" class="live-fab-chip live-fab-chip-action" data-action="graph"><i class="fa-solid fa-chart-line"></i> Graph</button>');
  } else {
    chips.push('<button type="button" class="live-fab-chip live-fab-chip-action" data-action="map"><i class="fa-solid fa-map"></i> Map</button>');
  }

  // 2. Raw, peaks, hotspots
  for (const t of LIVE_FAB_TOGGLES) {
    chips.push(`<button type="button" class="live-fab-chip${liveGsrView[t.key] ? ' active' : ''}" data-toggle="${t.key}">${t.label}</button>`);
  }

  // 3. Signal, tonic, phasic
  for (const m of LIVE_FAB_METRICS) {
    chips.push(`<button type="button" class="live-fab-chip${liveGsrView.graphView === m.value ? ' active' : ''}" data-metric="${m.value}">${m.label}</button>`);
  }

  // 4. Full screen
  const isDisplayMode = (typeof document !== 'undefined' && !!document.querySelector('.app-container.live-display-mode')) ||
    (typeof document !== 'undefined' && !!(document.fullscreenElement || document.webkitFullscreenElement));
  if (isDisplayMode) {
    chips.push('<button type="button" class="live-fab-chip live-fab-chip-action" data-action="exit-fullscreen"><i class="fa-solid fa-compress"></i> Exit Full Screen</button>');
  } else {
    chips.push('<button type="button" class="live-fab-chip live-fab-chip-action" data-action="enter-fullscreen"><i class="fa-solid fa-expand"></i> Full Screen</button>');
  }

  liveFabMenu.innerHTML = chips.join('');
}

function bindLiveFab() {
  const fab = document.getElementById('liveFab');
  liveFabToggle = document.getElementById('liveFabToggle');
  liveFabMenu = document.getElementById('liveFabMenu');
  if (!fab || !liveFabToggle || !liveFabMenu) return;

  liveFabToggle.addEventListener('click', toggleFabMenu);

  // Delegated so a fresh renderFabMenu() (its innerHTML is rebuilt on every
  // metric/mode change) never needs its own listener re-bound.
  liveFabMenu.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.dataset.metric) {
      setLiveGraphMetric(btn.dataset.metric);
      closeFabMenu();
    } else if (btn.dataset.toggle) {
      const prop = btn.dataset.toggle;
      liveGsrView[prop] = !liveGsrView[prop];
      const match = LIVE_FAB_TOGGLES.find(t => t.key === prop);
      if (match) {
        const headerBtn = document.getElementById(match.id);
        if (headerBtn) headerBtn.classList.toggle('active', liveGsrView[prop]);
      }
      renderFabMenu();
      drawGraph();
      renderLiveMapMarkers();
    } else if (btn.dataset.action === 'graph') {
      setMapVisible(false);
      closeFabMenu();
    } else if (btn.dataset.action === 'map') {
      setMapVisible(true);
      closeFabMenu();
    } else if (btn.dataset.action === 'enter-fullscreen') {
      if (typeof GSRLayoutManager !== 'undefined' && GSRLayoutManager.enterLiveDisplayMode) {
        GSRLayoutManager.enterLiveDisplayMode();
      } else if (typeof GSRFullscreen !== 'undefined') {
        // Standalone live.html has no GSRLayoutManager — fullscreen the
        // document root directly; GSRFullscreen keeps it sticky across
        // lock/unlock just like the in-app path.
        GSRFullscreen.request(document.documentElement);
      }
      closeFabMenu();
    } else if (btn.dataset.action === 'exit-fullscreen') {
      if (typeof GSRLayoutManager !== 'undefined' && GSRLayoutManager.exitLiveDisplayMode) {
        GSRLayoutManager.exitLiveDisplayMode();
      } else if (typeof GSRFullscreen !== 'undefined') {
        GSRFullscreen.exit();
      }
      closeFabMenu();
    }
  });

  // Keep Full Screen / Exit Full Screen chips synced when browser fullscreen changes
  const handleFsChange = () => renderFabMenu();
  if (typeof GSRFullscreen !== 'undefined') GSRFullscreen.onChange(handleFsChange);

  // Tapping the map (or anywhere else) with the menu open should close it —
  // an open fan-out sitting over the map otherwise blocks map interaction
  // for no reason once the user has looked away from it. Both pointerdown and click
  // are handled so mobile touch (iOS Safari, Android) closes the menu reliably.
  const handleOutsideClose = (e) => {
    if (!fab.contains(e.target)) closeFabMenu();
  };
  document.addEventListener('pointerdown', handleOutsideClose);
  document.addEventListener('click', handleOutsideClose);
}

function goToLatLon(lat, lon, zoom) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    alert('Enter a valid latitude (-90 to 90) and longitude (-180 to 180).');
    return;
  }
  if (!mapVisible) setMapVisible(true);
  if (liveMap && typeof liveMap.setView === 'function') {
    liveMap.setView([lat, lon], zoom);
  }
}

// ==========================================================================
// mount() steps — one group of DOM/event wiring each, called in order by
// mount() below. Same "long method → named private steps" regrouping as
// events.js's setupEventListeners()/_bind*Controls(), kept here as top-level
// functions (not object methods) to match bindLiveGsrControls()/bindLiveFab()
// above, which already used this shape.
// ==========================================================================

function initLiveViewDom(container) {
  // .live-view scopes every rule in styles.css's "Live Stream (BLE) view"
  // section to this subtree — so the live UI's bare header/footer/button
  // selectors never leak into the host page.
  container.classList.add('live-view');
  container.innerHTML = LIVE_VIEW_MARKUP;

  statusBadge      = document.getElementById('statusBadge');
  connectionBtn    = document.getElementById('connectionBtn');
  exportBtn        = document.getElementById('exportBtn');
  connectOverlay   = document.getElementById('connectOverlay');
  connectBtn       = document.getElementById('connectBtn');
  connectErr       = document.getElementById('connectErr');
  reconnectErr     = document.getElementById('reconnectErr');
  cacheMapBtn      = document.getElementById('cacheMapBtn');
  if (cacheMapBtn && isCompactLiveLayout()) {
    cacheMapBtn.textContent = 'Cache Map';
  }
  toggleMapBtn     = document.getElementById('toggleMapBtn');

  if (typeof navigator !== 'undefined' && !navigator.bluetooth && connectErr) {
    connectErr.textContent = 'Note: Web Bluetooth is not available in this browser (requires Chrome on Android/desktop, or a Web Bluetooth browser like Bluefy on iOS). You can still Prepare Map Offline.';
  }
}

function bindLiveStateListeners() {
  // Bind the shared fullscreen/visibility sticky-restore machinery (also
  // bound by GSRLayoutManager.init() in index.html — idempotent). In the
  // standalone page this is the only caller.
  if (typeof GSRFullscreen !== 'undefined') GSRFullscreen.init();

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
}

function bindLiveConnectionControls() {
  connectBtn.addEventListener('click', attemptConnect);

  // Lets the map be shown, panned, and cached before (or without)
  // connecting to a device — the whole reason toggleMapBtn/locationBar
  // aren't gated on a BLE connection or GPS fix.
  document.getElementById('skipConnectBtn').addEventListener('click', () => {
    connectOverlay.classList.add('hidden');
  });

  // Single connection button dealing with connect, reconnect, and new connection
  // as needed.
  connectionBtn.addEventListener('click', () => LiveConnectionController.handleAction());

  exportBtn.addEventListener('click', exportCsv);
}

function bindLiveMapControls() {
  cacheMapBtn.addEventListener('click', cacheCurrentMapArea);

  toggleMapBtn.addEventListener('click', () => setMapVisible(!mapVisible));

  const liveBtnExitDisplay = document.getElementById('liveBtnExitDisplay');
  if (liveBtnExitDisplay) {
    liveBtnExitDisplay.addEventListener('click', () => {
      if (typeof GSRLayoutManager !== 'undefined' && GSRLayoutManager.exitLiveDisplayMode) {
        GSRLayoutManager.exitLiveDisplayMode();
      }
    });
  }

  const metricGroup = document.getElementById('liveMetricGroup');
  if (metricGroup) {
    metricGroup.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-metric]');
      if (btn && btn.dataset.metric) setLiveGraphMetric(btn.dataset.metric);
    });
  }

  const myLocBtn = document.getElementById('myLocationBtn');
  if (myLocBtn) {
    myLocBtn.addEventListener('click', () => {
      // If we have an active GPS packet with valid fix from BLE, center there immediately
      if (LiveState.packets && LiveState.packets.length > 0) {
        const lastPkt = LiveState.packets[LiveState.packets.length - 1];
        if (lastPkt && lastPkt.valid && Number.isFinite(lastPkt.lat) && Number.isFinite(lastPkt.lon)) {
          goToLatLon(lastPkt.lat, lastPkt.lon, LIVE_ZOOM);
          return;
        }
      }
      if (!navigator.geolocation) {
        alert('Geolocation is not available in this browser.');
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          goToLatLon(pos.coords.latitude, pos.coords.longitude, MANUAL_LOCATION_ZOOM);
        },
        (err) => {
          alert('Could not get your location: ' + err.message);
        },
        { enableHighAccuracy: true, timeout: 10000 }
      );
    });
  }
}

function bindLiveKeyboardShortcuts() {
  window.addEventListener('keydown', (e) => {
    // Inside index.html these listeners outlive the Live tab (mount is
    // once, no unmount) — only claim the p/m/c shortcuts while the Live
    // view is actually the one on screen. (There is no live-view fullscreen
    // shortcut: in-app GSRLayoutManager owns F for the whole app; standalone
    // live.html has no self-fullscreen affordance.)
    if (typeof AppState !== 'undefined' && AppState.viewMode !== 'live') return;
    // Don't hijack keys while typing in an input.
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;

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
}

function bindLiveResizeHandling(container) {
  // Invalidate liveMap and redraw graph on resize or orientation change.
  // Also observe the container with ResizeObserver so any container
  // dimension changes (e.g. mobile orientation change, display mode toggle)
  // cleanly trigger re-measurement. For mobile WebKit / iOS Safari, orientation
  // transitions take ~150-300ms to complete and update clientWidth/clientHeight,
  // so delayed invalidations ensure Leaflet and Canvas rescale to final geometry.
  const handleResize = () => {
    if (typeof window !== 'undefined' && typeof window.scrollTo === 'function') {
      window.scrollTo(0, 0);
    }
    if (liveMap && typeof liveMap.invalidateSize === 'function') {
      liveMap.invalidateSize({ pan: false, debounceMoveend: true });
    }
    drawGraph();
  };

  window.addEventListener('resize', handleResize);
  window.addEventListener('orientationchange', () => {
    handleResize();
    setTimeout(handleResize, 100);
    setTimeout(handleResize, 300);
  });
  if (typeof screen !== 'undefined' && screen.orientation && typeof screen.orientation.addEventListener === 'function') {
    screen.orientation.addEventListener('change', () => {
      handleResize();
      setTimeout(handleResize, 100);
      setTimeout(handleResize, 300);
    });
  }

  if (typeof ResizeObserver !== 'undefined' && container) {
    const ro = new ResizeObserver(() => {
      handleResize();
    });
    ro.observe(container);
  }
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

    initLiveViewDom(container);
    bindLiveStateListeners();
    bindLiveConnectionControls();
    bindLiveGsrControls();
    bindLiveFab();
    bindLiveMapControls();
    bindLiveKeyboardShortcuts();
    bindLiveResizeHandling(container);

    updateToggleMapBtn();
    renderFabMenu();

    // Mobile default: map full-screen and primary, nothing else — desktop
    // keeps today's graph-first default (mapVisible starts false). See
    // isCompactLiveLayout()'s doc comment for the detection rule.
    if (isCompactLiveLayout()) setMapVisible(true);

    // Map visibility/init is otherwise a manual toggle (toggleMapBtn / the
    // FAB's Map<->Graph chip), not tied to GPS — see showMap()/hideMap() above.
    renderStatus('disconnected');
  },

  // Called by index.html's view switcher when the Live tab becomes / stops
  // being the visible view. No-ops for standalone live.html, which never
  // calls them (viewActive stays true from load).
  activate() {
    viewActive = true;
    renderStatus(LiveState.status || 'disconnected');
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

  // In-app tab switching pauses the animation loop while keeping the BLE link active
  // so walks continue recording in the background. Explicit teardown (inAppSwitch=false)
  // drops the BLE link as before.
  deactivate(inAppSwitch = false) {
    viewActive = false;
    stopAnimationLoop();
    if (!inAppSwitch) {
      if (bleManager) bleManager.disconnect();
      releaseWakeLock();
      // Fires renderStatus() (Reconnect / New Connection buttons) + a final
      // drawGraph(), now frozen at the last packet — see drawGraph()'s
      // `streaming` gate. A no-op if we were already disconnected.
      if (LiveState.status === 'connected' || LiveState.status === 'reconnecting') {
        LiveState.setStatus('disconnected');
      }
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
    renderFabMenu();
  },

  // Exposed so src/ui/events.js can pick index.html's initial view tab
  // ('live' vs 'single') with the exact same width+pointer check this file
  // uses for its own map-first mobile default — one detection, not two, kept
  // in sync automatically rather than by comment.
  isCompactLayout: isCompactLiveLayout,
  isViewActive: () => viewActive,
  _setBleManagerForTest: (m) => { bleManager = m; },

  // Encapsulated connection controller for state inspection and testing
  connectionController: LiveConnectionController,
};

if (typeof window !== 'undefined') window.GSRLiveView = GSRLiveView;
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GSRLiveView };
}
