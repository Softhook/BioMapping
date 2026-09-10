/**
 * GSRLiveView — the live receiver's view controller. Builds its own DOM
 * into a caller-supplied container and wires every button / keyboard
 * shortcut / animation-loop tick, so the same live UI can be the whole of
 * standalone live.html OR a panel inside index.html with no duplicated
 * markup.
 *
 * Depends on these page-level globals (loaded as classic <script>s before
 * this file — see live.html's <head> and index.html's script list):
 *   GsrFilter                 src/signal/gsr_filter.js
 *   MapColors                 src/map/map_colors.js
 *   GpsPipeline               src/gps/gps_pipeline.js
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
  <header>
    <h1>Bio Mapping — Live</h1>
    <span id="statusBadge" class="badge">Not connected</span>
    <button id="reconnectBtn" style="display:none;">Reconnect</button>
    <button id="newConnectionBtn" style="display:none;">New Connection</button>
    <button id="exportBtn" disabled>Export CSV</button>
    <button id="togglePhasicBtn" disabled>Show Phasic (P)</button>
    <button id="toggleMapBtn">Show Map (M)</button>
    <button id="cacheMapBtn" disabled>Cache Map (C)</button>
    <button id="toggleFullscreenBtn">Fullscreen (F)</button>
    <span id="reconnectErr"></span>
  </header>

  <div id="graphWrap">
    <canvas id="graph"></canvas>
    <span id="graphLabel">GSR (nS) — last 2 min</span>
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
// Rolling graph — plain <canvas> 2D, redrawn only on each packet arrival
// (docs/archive/bluetooth_serial_investigation.md §8 — matches the desktop app's
// noLoop()+manual-redraw() convention rather than a continuous animation
// loop; there's no zoom/pan/timeline-drag here, just "show the last N
// seconds of a growing session").
// ==========================================================================
const GRAPH_WINDOW_S = 120;
const GRAPH_EMA_ALPHA = 0.25;
// Extra history included in the smoothing pass beyond the visible window,
// so the EMA isn't starting cold right at the window's left edge (a zero-
// phase filter needs some run-up on both sides to be accurate near its
// boundaries). Bounds the smoothing pass to a fixed size regardless of
// total session length — re-running EMA over the WHOLE accumulated buffer
// on every ~300ms redraw (the original approach here) made per-packet
// cost grow linearly across a long walk instead of staying flat; a full
// ~90-minute session at this cadence is ~18,000 packets by the end.
const GRAPH_PAD_S = 30;

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

  const pkts = LiveState.packets;
  if (pkts.length === 0) return;

  // Smooth time progression between packets to enable 60fps graph scrolling
  const elapsed = lastPacketArrivalTime ? (Date.now() - lastPacketArrivalTime) / 1000 : 0;
  const lastT = (lastPacketTimestamp || pkts[pkts.length - 1].timestamp) + elapsed;
  const t0 = lastT - GRAPH_WINDOW_S;
  const padT0 = t0 - GRAPH_PAD_S;

  // Bound the smoothing pass to [padT0, lastT] — visible window plus
  // warm-up padding — not the whole accumulated session (see GRAPH_PAD_S).
  let padStartIdx = pkts.length - 1;
  while (padStartIdx > 0 && pkts[padStartIdx - 1].timestamp >= padT0) padStartIdx--;
  const paddedPkts = pkts.slice(padStartIdx);
  const paddedSmoothed = GsrFilter.applyZeroPhaseEMA(paddedPkts.map(p => p.gsrRaw), GRAPH_EMA_ALPHA);

  // Compute Tonic/Phasic baseline dynamically using a slow EMA (approx 45s window equivalent)
  const sampleRate = 1.0 / LiveState.STREAM_INTERVAL_S;
  const decomp = GsrFilter.decomposeTonicPhasic(paddedSmoothed, sampleRate, { tonicMethod: 'lpf', tonicWindow: 45 });
  const paddedTonic = decomp.tonic;
  const paddedPhasic = decomp.phasic;

  // Byproduct of this same recompute: stash each packet's current phasic
  // estimate on the packet object itself, and let the live map's delayed
  // track recoloring pick up any that have now settled — see
  // recolorPhasicSegments()'s doc comment for why "settled" isn't
  // "just computed". Reuses this exact decomposition instead of running a
  // second one just for the map.
  for (let i = 0; i < paddedPkts.length; i++) {
    paddedPkts[i].phasic = paddedPhasic[i];
  }
  recolorPhasicSegments();

  let startIdx = paddedPkts.length - 1;
  while (startIdx > 0 && paddedPkts[startIdx - 1].timestamp >= t0) startIdx--;

  const visible = (LiveState.showPhasicOnly ? paddedPhasic : paddedSmoothed).slice(startIdx);
  const visiblePkts = paddedPkts.slice(startIdx);
  if (visible.length === 0) return;

  let minV = Math.min(...visible), maxV = Math.max(...visible);
  if (maxV - minV < 1) { maxV += 0.5; minV -= 0.5; }
  const pad = (maxV - minV) * 0.1;
  minV -= pad; maxV += pad;

  const xForT = (t) => ((t - t0) / GRAPH_WINDOW_S) * w;
  const yForV = (v) => 8 + (1 - (v - minV) / (maxV - minV)) * (h - 28);

  // Draw subtle horizontal grid lines
  ctx.strokeStyle = 'rgba(124, 136, 148, 0.05)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let fraction of [0.25, 0.5, 0.75]) {
    const y = 8 + fraction * (h - 28);
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
  }
  ctx.stroke();

  // Draw subtle vertical grid lines (time increments relative to present time)
  ctx.strokeStyle = 'rgba(124, 136, 148, 0.06)';
  ctx.lineWidth = 1;
  ctx.beginPath();

  const step = 20; // 20s increments are clean and readable for a 120s window

  ctx.fillStyle = '#7c8894';
  ctx.font = '9px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (let offset = 0; offset <= GRAPH_WINDOW_S; offset += step) {
    const x = w - (offset / GRAPH_WINDOW_S) * w;
    if (x > 15 && x < w - 15) {
      // Draw grid line
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h - 20);

      // Draw label relative to now (e.g. -20s, -40s...)
      const label = offset === 0 ? 'now' : `-${offset}s`;
      ctx.fillText(label, x, h - 10);
    }
  }
  ctx.stroke();

  const colorCurve = LiveState.showPhasicOnly ? '#ff9f00' : '#00e5a0';
  const colorFillStart = LiveState.showPhasicOnly ? 'rgba(255, 159, 0, 0.15)' : 'rgba(0, 229, 160, 0.12)';
  const colorFillEnd = LiveState.showPhasicOnly ? 'rgba(255, 159, 0, 0.0)' : 'rgba(0, 229, 160, 0.0)';

  // Draw area under the curve with a subtle gradient
  if (visiblePkts.length > 0) {
    const grad = ctx.createLinearGradient(0, 8, 0, h - 20);
    grad.addColorStop(0, colorFillStart);
    grad.addColorStop(1, colorFillEnd);
    ctx.fillStyle = grad;

    let segmentStartIdx = 0;
    for (let i = 0; i <= visiblePkts.length; i++) {
      const isGap = i === visiblePkts.length || (i > 0 && visiblePkts[i].gap);
      if (isGap) {
        if (i > segmentStartIdx) {
          ctx.beginPath();
          ctx.moveTo(xForT(visiblePkts[segmentStartIdx].timestamp), yForV(visible[segmentStartIdx]));
          for (let j = segmentStartIdx + 1; j < i; j++) {
            ctx.lineTo(xForT(visiblePkts[j].timestamp), yForV(visible[j]));
          }
          ctx.lineTo(xForT(visiblePkts[i - 1].timestamp), h - 20);
          ctx.lineTo(xForT(visiblePkts[segmentStartIdx].timestamp), h - 20);
          ctx.closePath();
          ctx.fill();
        }
        segmentStartIdx = i;
      }
    }
  }

  // Draw GSR curve
  ctx.strokeStyle = colorCurve;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  let penDown = false;
  for (let i = 0; i < visiblePkts.length; i++) {
    const x = xForT(visiblePkts[i].timestamp);
    const y = yForV(visible[i]);
    if (!penDown || visiblePkts[i].gap) {
      ctx.moveTo(x, y);
      penDown = true;
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.stroke();

  const lastSmoothed = paddedSmoothed[paddedSmoothed.length - 1];
  const lastTonic = paddedTonic[paddedTonic.length - 1];
  const lastPhasic = Math.max(0, lastSmoothed - lastTonic);

  document.getElementById('graphValue').textContent =
    (LiveState.showPhasicOnly ? lastPhasic : pkts[pkts.length - 1].gsrRaw).toFixed(0) + ' nS';

  document.getElementById('graphLabel').textContent =
    LiveState.showPhasicOnly ? 'GSR (nS, Phasic) — last 2 min' : 'GSR (nS) — last 2 min';
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

// decomposeTonicPhasic() is a zero-phase/batch filter (a backward EMA pass,
// then a ±6s look-ahead "local floor" correction) — a sample's phasic value
// isn't trustworthy the instant drawGraph() first computes it; it needs a
// few seconds of FUTURE packets behind it to stabilize (see GRAPH_PAD_S's
// comment for the same "zero-phase needs run-up" idea, applied here to
// look-ahead instead). This repaints already-drawn segments once that's
// true, using the exact decomposition drawGraph() already runs — not a
// second, cheaper approximation. A session that ends abruptly leaves its
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
      // — recolorPhasicSegments() (called from drawGraph()) repaints it
      // with the more meaningful phasic value once that's settled.
      const line = L.polyline([liveLastLatLng, latlng], { color, weight: 3 }).addTo(liveMap);
      pendingPhasicSegments.push({ pkt, line });
    }

    if (!liveMarker) {
      liveMarker = L.circleMarker(latlng, { radius: 6, color: '#fff', weight: 2, fillColor: color, fillOpacity: 1 }).addTo(liveMap);
    } else {
      liveMarker.setLatLng(latlng);
      liveMarker.setStyle({ fillColor: color });
    }
    liveMap.panTo(latlng, { animate: true, duration: 0.3 });
  }
  liveLastLatLng = latlng;
}

// ==========================================================================
// CSV export. buildLiveCsv() (src/live/live_csv.js) does the schema
// serialisation (docs/csv_schema.md's canonical 11-column GPS+GSR schema);
// this keeps only the Blob + object-URL download — the same primitive
// visualiser/file_saver.js uses for its own fallback path
// (file_saver.js:96-106), not the full GSRFileSaver object (its
// File-System-Access-API picker isn't needed for a single-purpose button).
// ==========================================================================
function exportCsv() {
  const blob = new Blob([buildLiveCsv(LiveState.packets, Date.now())], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `biomap_live_${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ==========================================================================
// Wire-up state — element refs and session bookkeeping, assigned by mount().
// ==========================================================================
let statusBadge, reconnectBtn, newConnectionBtn, exportBtn, togglePhasicBtn,
    connectOverlay, connectBtn, connectErr, reconnectErr,
    cacheMapBtn, toggleMapBtn, toggleFullscreenBtn, latInput, lonInput;

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
  document.getElementById('statPackets').textContent = 'Packets: 0';
  document.getElementById('statGaps').textContent = 'Gaps: 0';
  document.getElementById('statGps').textContent = 'GPS: --';
  document.getElementById('statLastSeen').textContent = '--';
  exportBtn.disabled = true;
  togglePhasicBtn.disabled = true;
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

function updateTogglePhasicBtn() {
  if (LiveState.showPhasicOnly) {
    togglePhasicBtn.textContent = 'Show Full GSR (P)';
    togglePhasicBtn.classList.add('active');
  } else {
    togglePhasicBtn.textContent = 'Show Phasic (P)';
    togglePhasicBtn.classList.remove('active');
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

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch((err) => {
      console.warn('Fullscreen request failed:', err);
    });
  } else {
    if (document.exitFullscreen) {
      document.exitFullscreen();
    }
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

    // .live-view scopes every rule in styles.css's "Live Stream (BLE) view"
    // section to this subtree — so the live UI's bare header/footer/button
    // selectors never leak into the host page.
    container.classList.add('live-view');
    container.innerHTML = LIVE_VIEW_MARKUP;

    statusBadge      = document.getElementById('statusBadge');
    reconnectBtn     = document.getElementById('reconnectBtn');
    newConnectionBtn = document.getElementById('newConnectionBtn');
    exportBtn        = document.getElementById('exportBtn');
    togglePhasicBtn  = document.getElementById('togglePhasicBtn');
    connectOverlay   = document.getElementById('connectOverlay');
    connectBtn       = document.getElementById('connectBtn');
    connectErr       = document.getElementById('connectErr');
    reconnectErr     = document.getElementById('reconnectErr');
    cacheMapBtn      = document.getElementById('cacheMapBtn');
    toggleMapBtn     = document.getElementById('toggleMapBtn');
    toggleFullscreenBtn = document.getElementById('toggleFullscreenBtn');
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
      togglePhasicBtn.disabled = false;
      updateLiveMap(pkt);
    });

    connectBtn.addEventListener('click', () => {
      attemptConnect();
      if (document.documentElement.requestFullscreen) {
        document.documentElement.requestFullscreen().catch(() => {});
      }
    });

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

    togglePhasicBtn.addEventListener('click', () => {
      LiveState.showPhasicOnly = !LiveState.showPhasicOnly;
      updateTogglePhasicBtn();
      drawGraph();
    });

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

    toggleFullscreenBtn.addEventListener('click', toggleFullscreen);

    document.addEventListener('fullscreenchange', () => {
      if (document.fullscreenElement) {
        toggleFullscreenBtn.textContent = 'Exit Fullscreen (F)';
        toggleFullscreenBtn.classList.add('active');
      } else {
        toggleFullscreenBtn.textContent = 'Fullscreen (F)';
        toggleFullscreenBtn.classList.remove('active');
      }
    });

    window.addEventListener('keydown', (e) => {
      // Inside index.html these listeners outlive the Live tab (mount is
      // once, no unmount) — only claim the p/m/c/f shortcuts while the Live
      // view is actually the one on screen, so f in particular doesn't also
      // fire here on top of the main app's own fullscreen key. Standalone
      // live.html has no AppState, so the shortcuts are always live there.
      if (typeof AppState !== 'undefined' && AppState.viewMode !== 'live') return;
      // Don't hijack keys while the user is typing coordinates.
      if (e.target === latInput || e.target === lonInput) return;

      if ((e.key === 'p' || e.key === 'P') && !togglePhasicBtn.disabled) {
        LiveState.showPhasicOnly = !LiveState.showPhasicOnly;
        updateTogglePhasicBtn();
        drawGraph();
      }
      if (e.key === 'm' || e.key === 'M') {
        toggleMapBtn.click();
      }
      if ((e.key === 'c' || e.key === 'C') && !cacheMapBtn.disabled) {
        cacheCurrentMapArea();
      }
      if (e.key === 'f' || e.key === 'F') {
        toggleFullscreen();
      }
    });

    window.addEventListener('resize', drawGraph);

    updateTogglePhasicBtn();
    updateToggleMapBtn();

    // Map visibility/init is a manual toggle (toggleMapBtn), not tied to GPS —
    // see showMap()/hideMap() above.
    renderStatus('disconnected');
  },

  // Called by index.html's view switcher when the Live tab becomes / stops
  // being the visible view. No-ops for standalone live.html, which never
  // calls them (viewActive stays true from load). deactivate() only pauses
  // the redraw loop — nothing is torn down, so activate() just resumes.
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

  deactivate() {
    viewActive = false;
    stopAnimationLoop();
  },
};

if (typeof window !== 'undefined') window.GSRLiveView = GSRLiveView;
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GSRLiveView };
}
