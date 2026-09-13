/**
 * Live map — the live receiver's follow-map (Leaflet). Paints the walker's
 * trail one per-fix segment at a time — drawn only once the active metric's
 * tonic/phasic value has settled (never repainted) — reconciles peak/hotspot
 * markers against the live analyser's sliding window, and handles offline
 * tile caching + map visibility.
 *
 * Split out of src/live/live_view.js (2026-09). The shell (live_view.js)
 * owns the analyser, the view state (liveGsrView), device-class detection
 * (isCompactLiveLayout) and the FAB (closeFabMenu); the graph renderer
 * (live_graph.js) owns drawGraph. This file only reads those, bare, at call
 * time. Top-level bindings (liveMap, updateLiveMap, renderLiveMapMarkers,
 * …) live in the shared global lexical scope — see live_view.js's header —
 * so tests reach them through the vm context tests/support/boot_live.js
 * hands back.
 *
 * Reads (bare globals, resolved at call time):
 *   LiveState                 src/live/live_state.js
 *   MapColors, GpsPipeline, GSRMapMarkers, GSRBasemap   src/map/, src/gps/
 *   latLngToTileCoords, buildTileUrl, normalizeTileCacheUrl   src/live/live_tile_cache.js
 *   liveGsrView, liveAnalyzer, LIVE_SETTLE_TAIL_S,
 *     isCompactLiveLayout, closeFabMenu   src/live/live_view.js (shell)
 *   drawGraph                 src/live/live_graph.js
 */

// src/core/constants.js's GPS_DEFAULT.maxHdop (docs/csv_schema.md's "HDOP
// Gate Design" — 2.0 is the post-processing quality filter, distinct from
// the firmware's permissive 5.0 logging gate).
const LIVE_MAX_HDOP = 2.0;

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
let tonicMin = Infinity, tonicMax = -Infinity;

// Tonic/phasic colouring is DEFERRED: the zero-phase decomposition
// (decomposeTonicPhasic) needs a ±6s look-ahead, so a sample's value isn't
// trustworthy until LIVE_SETTLE_TAIL_S after it arrives. Rather than drawing
// the newest tail in a provisional colour and repainting it later (the
// jarring "pop" this replaces), updateLiveMap() queues each segment and
// flushSettledSegments() draws it — already correctly coloured — once its
// value has settled. A drawn segment never changes colour.
// phasicMin is fixed at 0 (phasic is already clamped >= 0 in
// decomposeTonicPhasic — 0 is a meaningful "at baseline" reference point,
// unlike gsrMin/gsrMax/tonicMin which have no natural floor) so only the
// ceiling needs to track the session's peak.
let phasicMax = 0;

// FIFO of undrawn segments awaiting a settled tonic/phasic value. Each entry
// captures its geometry at arrival time ({ prevLatLng, latlng, pkt }) so a
// mid-queue gap is still broken correctly when the segment is drawn later.
const pendingSegments = [];

// How long a tonic/phasic value needs to settle (decomposeTonicPhasic's ±6s
// local-floor window + margin). A queued segment is drawn once this long has
// passed since its packet arrived.
const PHASIC_COLOR_LAG_S = 8;

// Hard cap on the deferred-segment backlog. flushSettledSegments() runs from
// feedLiveAnalyzer() (every packet through the warmup, then once per
// LIVE_ANALYZE_MIN_INTERVAL_MS), draining each entry once its value has
// settled. If analyse() stalls for a long stretch the queue could grow; past
// the cap the oldest undrawn segment is simply dropped (a short visual gap,
// the same outcome resetSession() and an abrupt end accept).
const PENDING_SEGMENTS_MAX = 1200; // ~6 min at STREAM_INTERVAL_S

// Every segment drawn this session — {pkt, line} pairs, so switching the
// active metric (FAB chip tap / #liveGraphView dropdown change) can
// immediately repaint the WHOLE track via recolorAllTrackSegments(). Grows
// for the life of a session like LiveState.packets already does;
// resetSession() clears it.
const allTrackSegments = [];

// Draws each queued segment whose tonic/phasic value has settled, in FIFO
// order, with the active metric's final colour. Reads liveGsrView.graphView
// on every call, so a mid-session metric switch is honoured by future draws
// with no extra bookkeeping — recolorAllTrackSegments() (below) handles the
// immediate repaint of segments already on the map when the switch happens.
// 'signal' (raw) needs no settling at all, so any queued segment (left over
// from a tonic/phasic stretch) is drawn immediately.
function flushSettledSegments() {
  const metric = liveGsrView.graphView;
  const lastPkt = LiveState.packets[LiveState.packets.length - 1];
  if (!lastPkt) return;
  const weight = isCompactLiveLayout() ? LIVE_TRACK_WEIGHT_MOBILE : LIVE_TRACK_WEIGHT_DESKTOP;
  while (pendingSegments.length > 0) {
    const e = pendingSegments[0];
    const val = metric === 'signal' ? e.pkt.gsrRaw : e.pkt[metric];
    if (metric !== 'signal') {
      if (val === undefined) break; // not computed yet (outside the analyse window)
      if (lastPkt.timestamp - e.pkt.timestamp < PHASIC_COLOR_LAG_S) break; // not settled yet
    }
    let color;
    if (metric === 'tonic') {
      tonicMin = Math.min(tonicMin, val);
      tonicMax = Math.max(tonicMax, val);
      color = MapColors.getColorForValue(val, tonicMin, tonicMax);
    } else if (metric === 'phasic') {
      phasicMax = Math.max(phasicMax, val);
      color = MapColors.getColorForValue(val, 0, phasicMax);
    } else {
      color = MapColors.getColorForValue(val, gsrMin, gsrMax);
    }
    const line = L.polyline([e.prevLatLng, e.latlng], { color, weight }).addTo(liveMap);
    allTrackSegments.push({ pkt: e.pkt, line });
    pendingSegments.shift();
  }
}

// Immediate full repaint of the WHOLE session's track, run once whenever the
// active metric changes (FAB chip tap / #liveGraphView dropdown change) —
// see setLiveGraphMetric(). Without this, switching metric would only ever
// affect segments drawn AFTER the switch; a walk already a few minutes in
// would stay in the old metric's colours until re-recorded. Recomputes the
// running min/max from every value that's already settled before painting
// (two passes) so every segment in this one repaint is coloured against the
// same range — a single running-max update mid-loop would make early
// segments and late segments in the same pass use different scales. A
// segment whose target metric hasn't been computed yet keeps its current
// colour; the undrawn queue is flushed (for signal) or left to settle (for
// tonic/phasic).
function recolorAllTrackSegments() {
  const metric = liveGsrView.graphView;
  if (metric === 'signal') {
    for (const { pkt, line } of allTrackSegments) {
      line.setStyle({ color: MapColors.getColorForValue(pkt.gsrRaw, gsrMin, gsrMax) });
    }
    // Any segments deferred during a tonic/phasic stretch are final for
    // signal immediately — draw them so the trail catches up to the dot.
    flushSettledSegments();
    return;
  }
  let lo = metric === 'tonic' ? tonicMin : 0;
  let hi = metric === 'tonic' ? tonicMax : phasicMax;
  for (const { pkt } of allTrackSegments) {
    const v = pkt[metric];
    if (v === undefined) continue;
    if (metric === 'tonic' && v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (metric === 'tonic') { tonicMin = lo; tonicMax = hi; } else { phasicMax = hi; }
  for (const { pkt, line } of allTrackSegments) {
    const v = pkt[metric];
    if (v === undefined) continue;
    line.setStyle({ color: MapColors.getColorForValue(v, lo, hi) });
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
  const originalText = isCompactLiveLayout() ? 'Cache Map' : cacheMapBtn.textContent;
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
  // CARTO basemap URL + key resolution shared via GSRBasemap
  // (src/map/basemap.js) — same source of truth as map.js / globe3d.js.
  L.tileLayer.cache(
    GSRBasemap.cartoTileUrl('light_all'),
    GSRBasemap.tileOptions()
  ).addTo(liveMap);

  // Enable the Cache Map button
  document.getElementById('cacheMapBtn').disabled = false;

  if (typeof liveMap.on === 'function') {
    liveMap.on('click dragstart', closeFabMenu);
  }
}

// ==========================================================================
// Peak / hotspot markers on the live follow-map — the SAME Leaflet icons and
// latency-aware placement the main visualiser's map uses (GSRMapMarkers in
// src/map/map_markers.js), so the live map and the analysis map can't drift
// apart visually: peaks are small dots, hotspots (memorableEvents) are stars.
//
// Unlike the main map (one render per analysed track), the live analyser
// re-runs on a sliding window, so markers are reconciled incrementally: a Map
// keyed by peak.time keeps existing markers (no flicker on every analyze())
// and only adds/removes the delta as the window slides. Markers in the
// unsettled tail (LIVE_SETTLE_TAIL_S) are withheld, matching the graph's own
// peak-marker suppression.
// ==========================================================================
const liveMapPeakMarkers = new Map();
const liveMapHotspotMarkers = new Map();

function _removeLiveMapMarker(marker) {
  if (!marker) return;
  if (typeof marker.remove === 'function') marker.remove();
  else if (liveMap && typeof liveMap.removeLayer === 'function') liveMap.removeLayer(marker);
}

function clearLiveMapMarkers() {
  liveMapPeakMarkers.forEach(_removeLiveMapMarker);
  liveMapHotspotMarkers.forEach(_removeLiveMapMarker);
  liveMapPeakMarkers.clear();
  liveMapHotspotMarkers.clear();
}

// Reconcile one marker layer (peaks or hotspots) against the wanted set.
function _syncLiveMapMarkerSet(markerMap, peaks, iconBuilder) {
  const A = liveAnalyzer;
  if (!A || !liveMap) return;
  const lastPkt = LiveState.packets[LiveState.packets.length - 1];
  const settledBefore = lastPkt ? lastPkt.timestamp - LIVE_SETTLE_TAIL_S : Infinity;

  const wanted = new Map();
  if (peaks) {
    for (const peak of peaks) {
      if (peak.excluded || peak.time > settledBefore) continue;
      wanted.set(peak.time, peak);
    }
  }

  // Drop markers whose peak left the window / was excluded / fell back into
  // the unsettled tail.
  for (const [key, marker] of markerMap) {
    if (!wanted.has(key)) {
      _removeLiveMapMarker(marker);
      markerMap.delete(key);
    }
  }
  // Add the new ones (skip any without GPS — a live packet can lack a fix).
  for (const [key, peak] of wanted) {
    if (markerMap.has(key)) continue;
    const coords = A.getCoordinates(GSRMapMarkers.resolveLatencyIndex(A, peak, 0));
    if (!coords) continue;
    const marker = L.marker([coords.lat, coords.lon], { icon: iconBuilder(L) });
    marker.addTo(liveMap);
    markerMap.set(key, marker);
  }
}

function renderLiveMapMarkers() {
  if (!liveMap || typeof GSRMapMarkers === 'undefined') return;
  if (!liveAnalyzer || !liveAnalyzer.raw || liveAnalyzer.raw.length === 0) {
    clearLiveMapMarkers();
    return;
  }
  _syncLiveMapMarkerSet(
    liveMapPeakMarkers,
    liveGsrView.showPeaks ? liveAnalyzer.peaks : null,
    GSRMapMarkers.buildPeakIcon
  );
  _syncLiveMapMarkerSet(
    liveMapHotspotMarkers,
    liveGsrView.showHotspots ? liveAnalyzer.memorableEvents : null,
    GSRMapMarkers.buildHotspotIcon
  );
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
  renderLiveMapMarkers();
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

// Polyline stroke width on the live follow-map. Mobile screens (coarse pointer /
// phone viewports) draw twice as thick (6px vs desktop's 3px) for outdoor
// readability on high-DPI displays.
const LIVE_TRACK_WEIGHT_DESKTOP = 3;
const LIVE_TRACK_WEIGHT_MOBILE = 6;

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
    // Raw GSR range is tracked regardless of metric — 'signal' colouring (the
    // no-delay default) needs it immediately, and a mid-session switch back
    // to signal recolours the whole trail against it.
    gsrMin = Math.min(gsrMin, pkt.gsrRaw);
    gsrMax = Math.max(gsrMax, pkt.gsrRaw);

    if (!liveLastLatLng) {
      liveMap.setView(latlng, LIVE_ZOOM);
    }

    const metric = liveGsrView.graphView;
    if (metric === 'signal') {
      // Raw GSR is final the instant a fix arrives — draw the segment now.
      if (liveLastLatLng && !pkt.gap) {
        const weight = isCompactLiveLayout() ? LIVE_TRACK_WEIGHT_MOBILE : LIVE_TRACK_WEIGHT_DESKTOP;
        const line = L.polyline([liveLastLatLng, latlng],
          { color: MapColors.getColorForValue(pkt.gsrRaw, gsrMin, gsrMax), weight }).addTo(liveMap);
        allTrackSegments.push({ pkt, line });
      }
    } else if (liveLastLatLng && !pkt.gap) {
      // Tonic/phasic aren't trustworthy until settled — queue the segment
      // (geometry captured now) for flushSettledSegments() to draw once its
      // value has settled. A gap fix queues nothing (it only advances the
      // anchor), so the trail breaks there rather than bridging the gap.
      pendingSegments.push({ prevLatLng: liveLastLatLng, latlng, pkt });
      if (pendingSegments.length > PENDING_SEGMENTS_MAX) pendingSegments.shift();
    }

    // "You are here" marker — fixed neutral styling, independent of the
    // active metric, so the dot never implies a data value (the trail is the
    // data; the dot is just you).
    if (!liveMarker) {
      liveMarker = L.circleMarker(latlng, {
        radius: 7, color: '#1d7ff2', weight: 3, fillColor: '#ffffff', fillOpacity: 1
      }).addTo(liveMap);
    } else {
      liveMarker.setLatLng(latlng);
    }

    const nowMs = Date.now();
    if (nowMs - lastLivePanAt >= LIVE_PAN_MIN_INTERVAL_MS) {
      lastLivePanAt = nowMs;
      liveMap.panTo(latlng, { animate: true, duration: 0.3 });
    }
  }
  liveLastLatLng = latlng;
}
