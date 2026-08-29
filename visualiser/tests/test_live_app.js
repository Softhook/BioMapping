/**
 * Unit tests for live.html's own logic — LiveState's gap detection,
 * resetSession() (session-boundary cleanup on a fresh BLE connection),
 * the map-visibility toggle, the manual location picker, and the
 * cache-Map area's cache-storage bookkeeping.
 *
 * These target the bugs found and fixed in the live-app critical review
 * (session state leaking across a "New Connection", tile re-downloads on
 * repeat caching, a dead Reconnect button before any connection) rather
 * than re-deriving coverage of things already tested elsewhere:
 * live_binary_parser.js's own decoder tests (test_live_binary_parser.js)
 * cover the wire-format parsing (live.html loads that file directly), and
 * map_colors.js/gps_pipeline.js's own tests cover the subsets live.html
 * copies from them.
 *
 * Uses tests/support/boot_live.js (mirrors boot_app.js's approach for
 * index.html) — see that file's header for the Leaflet/Bluetooth/Cache
 * Storage mocking and why live.html's top-level bindings are reached via
 * `context` rather than `window`.
 *
 * Run: node --test tests/test_live_app.js  (or `npm test` for the whole suite)
 */

const assert = require('assert');
const test = require('node:test');
const vm = require('vm');
const { bootLive } = require('./support/boot_live.js');

function run(context, expr) {
  return vm.runInContext(expr, context);
}

// vm contexts have their own realm (own Array/Object prototypes), so an
// array built inside `context` fails assert.deepStrictEqual against a
// same-looking array built in this file's realm — "same structure but not
// reference-equal". Round-tripping through JSON rebuilds it in THIS
// realm; fine here since every value these tests pull out this way is
// plain booleans/numbers.
function runJSON(context, expr) {
  return JSON.parse(JSON.stringify(vm.runInContext(expr, context)));
}

// One valid 45-byte wire packet (docs/archive/bluetooth_serial_investigation.md
// §5). A compact copy of test_live_binary_parser.js's builder, kept local so
// this file stays self-contained — the wire format is frozen (§5). Returns a
// plain number[] so it crosses into the vm realm without an ArrayBuffer.
function buildPacket({
  timestampMs = 1000, lat = 51.5074, lon = -0.1278, gsrRaw = 1234.5,
  hdop = 1.2, pdop = 1.8, speedKts = 3.4, courseDeg = 270.0,
  sats = 9, fixType = 3, valid = 1,
} = {}) {
  const buf = new Uint8Array(45);
  const view = new DataView(buf.buffer);
  buf[0] = 0x42; buf[1] = 0x4d;
  view.setUint32(2, timestampMs, true);
  view.setFloat64(6, lat, true);
  view.setFloat64(14, lon, true);
  view.setFloat32(22, gsrRaw, true);
  view.setFloat32(26, hdop, true);
  view.setFloat32(30, pdop, true);
  view.setFloat32(34, speedKts, true);
  view.setFloat32(38, courseDeg, true);
  buf[42] = sats; buf[43] = fixType; buf[44] = valid;
  return Array.from(buf);
}

// A fake Web Bluetooth stack: navigator.bluetooth.requestDevice() ->
// device.gatt.connect() -> server.getPrimaryService() -> getCharacteristic()
// -> startNotifications(), plus hooks to fire a 'characteristicvaluechanged'
// notification and a 'gattserverdisconnected' event. Only as faithful as
// GSRLiveBluetoothManager's own call sequence needs — not a real GATT
// implementation.
//
// opts.missingService      — getPrimaryService() always throws (UUID mismatch).
// opts.reconnectFailures   — the first N _subscribe() calls AFTER the initial
//                            connect() throw, to exercise _handleDisconnect()'s
//                            retry loop. getCharacteristic() is the throw point
//                            (getPrimaryService() succeeds), so this doesn't
//                            also trip _logDiscoveredServices().
function makeFakeBle(context, {
  failRequestDevice = false, missingService = false, reconnectFailures = 0,
} = {}) {
  // Build the notification's DataView with the vm context's own typed-array
  // constructors, so `new Uint8Array(e.target.value.buffer)` inside live.html
  // consumes a same-realm ArrayBuffer.
  const bytesToDataView = context.__bytesToDataView || (context.__bytesToDataView =
    vm.runInContext('(bytes => new DataView(Uint8Array.from(bytes).buffer))', context));

  const charHandlers = [];
  const deviceHandlers = {};
  let subscribeCalls = 0;   // getCharacteristic() calls == _subscribe() attempts
  let subscribeGate = null; // when set, the next getCharacteristic() awaits it

  const characteristic = {
    addEventListener(type, fn) { if (type === 'characteristicvaluechanged') charHandlers.push(fn); },
    removeEventListener(type, fn) {
      if (type !== 'characteristicvaluechanged') return;
      const i = charHandlers.indexOf(fn);
      if (i !== -1) charHandlers.splice(i, 1);
    },
    async startNotifications() { return this; },
  };
  const service = {
    async getCharacteristic() {
      subscribeCalls++;
      if (subscribeGate) { const g = subscribeGate; subscribeGate = null; await g; }
      if (subscribeCalls > 1 && subscribeCalls <= 1 + reconnectFailures) {
        throw new Error(`reconnect attempt ${subscribeCalls - 1} failed`);
      }
      return characteristic;
    },
  };
  const server = {
    async getPrimaryService() {
      if (missingService) throw new Error('service not found');
      return service;
    },
    async getPrimaryServices() { return [{ uuid: 'aaaa1111-0000-1000-8000-00805f9b34fb' }]; },
  };
  const device = {
    gatt: { async connect() { return server; } },
    addEventListener(type, fn) { deviceHandlers[type] = fn; },
  };
  return {
    bluetooth: {
      async requestDevice() {
        if (failRequestDevice) throw new Error('user cancelled the device chooser');
        return device;
      },
    },
    fireNotification(byteArray) {
      const value = bytesToDataView(byteArray);
      charHandlers.forEach((fn) => fn({ target: { value } }));
    },
    fireDisconnect() {
      if (deviceHandlers.gattserverdisconnected) deviceHandlers.gattserverdisconnected();
    },
    notificationHandlerCount: () => charHandlers.length,
    subscribeCallCount: () => subscribeCalls,
    // Blocks the NEXT getCharacteristic() until the returned function is
    // called — lets a test hold _handleDisconnect() mid-attempt.
    blockNextSubscribe() {
      let release;
      subscribeGate = new Promise((r) => { release = r; });
      return release;
    },
  };
}

// Replaces the context's setTimeout with one that fires (near-)immediately
// and records the delay it was asked for, so a test can await
// _handleDisconnect()'s whole retry loop in ~no time and still assert the
// real backoff schedule. Returns { delays, restore }.
function recordingTimers(window) {
  const delays = [];
  const real = window.setTimeout;
  window.setTimeout = (fn, ms) => { delays.push(ms); return real(fn, 0); };
  return { delays, restore() { window.setTimeout = real; } };
}

// ==========================================================================
// LiveState.addPacket() — gap detection
// ==========================================================================

test('addPacket: no gap for packets arriving at the expected cadence', () => {
  const { context } = bootLive();
  run(context, "LiveState.addPacket({ timestamp: 0.0, gsrRaw: 1 })");
  run(context, "LiveState.addPacket({ timestamp: 0.3, gsrRaw: 2 })");
  const gaps = runJSON(context, 'LiveState.packets.map(p => !!p.gap)');
  assert.deepStrictEqual(gaps, [false, false]);
  assert.strictEqual(run(context, 'LiveState.gapCount'), 0);
});

test('addPacket: flags a real dropped/disconnected interval as a gap', () => {
  const { context } = bootLive();
  run(context, "LiveState.addPacket({ timestamp: 0.0, gsrRaw: 1 })");
  run(context, "LiveState.addPacket({ timestamp: 5.0, gsrRaw: 2 })"); // way past 2x the 0.3s interval
  const gaps = runJSON(context, 'LiveState.packets.map(p => !!p.gap)');
  assert.deepStrictEqual(gaps, [false, true]);
  assert.strictEqual(run(context, 'LiveState.gapCount'), 1);
});

test('addPacket: regression — a timestamp that resets lower than the previous packet is a gap, not a silently-accepted negative delta', () => {
  // The wire timestamp is device-uptime ms, not wall-clock. Reconnecting to
  // a different (or power-cycled) device restarts that counter near zero,
  // so a plain `delta > threshold` check misses it (a negative delta never
  // exceeds a positive threshold) and would let the map/graph draw a bogus
  // line connecting two unrelated sessions.
  const { context } = bootLive();
  run(context, "LiveState.addPacket({ timestamp: 100.0, gsrRaw: 1 })");
  run(context, "LiveState.addPacket({ timestamp: 0.5, gsrRaw: 2 })"); // device restarted its clock
  const gaps = runJSON(context, 'LiveState.packets.map(p => !!p.gap)');
  assert.deepStrictEqual(gaps, [false, true]);
});

test('addPacket: an exactly-equal timestamp (duplicate delivery) is also treated as a gap, not a divide-by-zero-shaped edge case', () => {
  const { context } = bootLive();
  run(context, "LiveState.addPacket({ timestamp: 1.0, gsrRaw: 1 })");
  run(context, "LiveState.addPacket({ timestamp: 1.0, gsrRaw: 2 })");
  assert.strictEqual(run(context, 'LiveState.packets[1].gap'), true);
});

// ==========================================================================
// resetSession() — the fix for cross-session state leaking into a fresh
// BLE connection (see attemptConnect()'s call site).
// ==========================================================================

test('resetSession: clears accumulated packets/gaps/position/color-range state', () => {
  const { window, context } = bootLive();
  run(context, "LiveState.addPacket({ timestamp: 0.0, gsrRaw: 10 })");
  run(context, "LiveState.addPacket({ timestamp: 5.0, gsrRaw: 20 })"); // creates a gap
  run(context, "liveLastLatLng = [51.5, -0.12]");
  run(context, "gsrMin = 5; gsrMax = 25");
  run(context, "lastPacketTimestamp = 5.0; lastPacketArrivalTime = 123456");

  run(context, 'resetSession()');

  assert.strictEqual(run(context, 'LiveState.packets.length'), 0);
  assert.strictEqual(run(context, 'LiveState.gapCount'), 0);
  assert.strictEqual(run(context, 'liveLastLatLng'), null);
  assert.strictEqual(run(context, 'gsrMin'), Infinity);
  assert.strictEqual(run(context, 'gsrMax'), -Infinity);
  assert.strictEqual(run(context, 'lastPacketTimestamp'), 0);
  assert.strictEqual(run(context, 'lastPacketArrivalTime'), 0);
});

test('resetSession: puts the footer stats and export/phasic buttons back to their pre-connection state', () => {
  const { window, context } = bootLive();
  window.document.getElementById('exportBtn').disabled = false;
  window.document.getElementById('togglePhasicBtn').disabled = false;
  window.document.getElementById('statPackets').textContent = 'Packets: 42';
  window.document.getElementById('statGaps').textContent = 'Gaps: 3';
  window.document.getElementById('statGps').textContent = 'GPS: 3D (9 sat)';
  window.document.getElementById('statLastSeen').textContent = 'Last: 12.3s';

  run(context, 'resetSession()');

  assert.strictEqual(window.document.getElementById('statPackets').textContent, 'Packets: 0');
  assert.strictEqual(window.document.getElementById('statGaps').textContent, 'Gaps: 0');
  assert.strictEqual(window.document.getElementById('statGps').textContent, 'GPS: --');
  assert.strictEqual(window.document.getElementById('statLastSeen').textContent, '--');
  assert.strictEqual(window.document.getElementById('exportBtn').disabled, true);
  assert.strictEqual(window.document.getElementById('togglePhasicBtn').disabled, true);
});

test('attemptConnect: resets session state as soon as a device is requested, so a "New Connection" after a previous session never carries its packets over — even if the new connection attempt itself then fails', async () => {
  const { window, context } = bootLive();
  run(context, "LiveState.addPacket({ timestamp: 0.0, gsrRaw: 1 })");
  run(context, "LiveState.addPacket({ timestamp: 0.3, gsrRaw: 2 })");
  assert.strictEqual(run(context, 'LiveState.packets.length'), 2);

  window.navigator.bluetooth = {
    requestDevice: async () => { throw new Error('user cancelled the device chooser'); },
  };

  await run(context, 'attemptConnect()');

  assert.strictEqual(run(context, 'LiveState.packets.length'), 0);
  assert.match(window.document.getElementById('connectErr').textContent, /cancelled/);
});

test('attemptConnect: leaves existing session data alone when Web Bluetooth is not available at all (nothing was actually attempted)', async () => {
  const { window, context } = bootLive();
  run(context, "LiveState.addPacket({ timestamp: 0.0, gsrRaw: 1 })");
  window.navigator.bluetooth = undefined;

  await run(context, 'attemptConnect()');

  assert.strictEqual(run(context, 'LiveState.packets.length'), 1);
  assert.match(window.document.getElementById('connectErr').textContent, /Web Bluetooth/);
});

// ==========================================================================
// normalizeTileCacheUrl() — subdomain folding so all four CDN subdomains
// (a/b/c/d.basemaps.cartocdn.com) share one cache entry.
// ==========================================================================

test('normalizeTileCacheUrl: folds every tile subdomain to "a"', () => {
  const { context } = bootLive();
  const norm = (u) => run(context, `normalizeTileCacheUrl(${JSON.stringify(u)})`);
  assert.strictEqual(
    norm('https://b.basemaps.cartocdn.com/light_all/15/1000/2000.png'),
    'https://a.basemaps.cartocdn.com/light_all/15/1000/2000.png',
  );
  assert.strictEqual(
    norm('https://d.basemaps.cartocdn.com/light_all/3/4/5.png'),
    'https://a.basemaps.cartocdn.com/light_all/3/4/5.png',
  );
});

test('normalizeTileCacheUrl: an already-"a" URL round-trips unchanged, and an unrelated URL is left alone', () => {
  const { context } = bootLive();
  const norm = (u) => run(context, `normalizeTileCacheUrl(${JSON.stringify(u)})`);
  assert.strictEqual(
    norm('https://a.basemaps.cartocdn.com/light_all/1/2/3.png'),
    'https://a.basemaps.cartocdn.com/light_all/1/2/3.png',
  );
  assert.strictEqual(norm('https://example.com/tile.png'), 'https://example.com/tile.png');
});

// ==========================================================================
// Map visibility toggle — manual, not GPS-driven (see live.html's showMap/
// hideMap/setMapVisible comments for why).
// ==========================================================================

test('toggleMapBtn: shows the map panel, initializes liveMap, and enables Cache Map — all with no BLE connection', () => {
  const { window, context } = bootLive();
  assert.ok(window.document.getElementById('app').classList.contains('no-map'));
  assert.strictEqual(window.document.getElementById('cacheMapBtn').disabled, true);

  window.document.getElementById('toggleMapBtn').click();

  assert.ok(!window.document.getElementById('app').classList.contains('no-map'));
  assert.strictEqual(window.document.getElementById('cacheMapBtn').disabled, false);
  assert.strictEqual(window.document.getElementById('toggleMapBtn').textContent, 'Hide Map (M)');
  assert.ok(run(context, 'liveMap') !== null, 'liveMap should be constructed once shown');
});

test('toggleMapBtn: hides the map again on a second click, without destroying the underlying liveMap instance', () => {
  const { window, context } = bootLive();
  window.document.getElementById('toggleMapBtn').click();
  window.document.getElementById('toggleMapBtn').click();

  assert.ok(window.document.getElementById('app').classList.contains('no-map'));
  assert.strictEqual(window.document.getElementById('toggleMapBtn').textContent, 'Show Map (M)');
  assert.ok(run(context, 'liveMap') !== null, 'hiding is a CSS toggle, not a teardown');
});

// ==========================================================================
// goToLatLon() / the manual location picker — this is what makes pre-trip
// caching possible without any GPS fix at all (device or browser).
// ==========================================================================

test('goToLatLon: rejects out-of-range/non-numeric input without showing or moving the map', () => {
  const { window, context } = bootLive();
  let alerted = null;
  window.alert = (msg) => { alerted = msg; };

  run(context, 'goToLatLon(NaN, 10, 15)');
  assert.ok(alerted, 'NaN latitude should alert instead of silently doing nothing');
  assert.ok(window.document.getElementById('app').classList.contains('no-map'));

  alerted = null;
  run(context, 'goToLatLon(999, 10, 15)'); // out of [-90, 90]
  assert.ok(alerted);
  assert.ok(window.document.getElementById('app').classList.contains('no-map'));
});

test('goToLatLon: valid coordinates show the map (if hidden) and pan/zoom it there', () => {
  const { window, context } = bootLive();
  assert.ok(window.document.getElementById('app').classList.contains('no-map'));

  run(context, 'goToLatLon(48.8566, 2.3522, 15)');

  assert.ok(!window.document.getElementById('app').classList.contains('no-map'));
  const center = run(context, 'liveMap.getCenter()');
  assert.strictEqual(center.lat, 48.8566);
  assert.strictEqual(center.lng, 2.3522);
  assert.strictEqual(run(context, 'liveMap.getZoom()'), 15);
});

test('goToLatLon: reused on an already-visible map just re-pans it, without re-initializing liveMap', () => {
  const { window, context } = bootLive();
  window.document.getElementById('toggleMapBtn').click();
  const firstMap = run(context, 'liveMap');

  run(context, 'goToLatLon(10, 20, 12)');

  assert.strictEqual(run(context, 'liveMap'), firstMap, 'goToLatLon should not create a second map instance');
  assert.strictEqual(run(context, 'liveMap.getZoom()'), 12);
});

// ==========================================================================
// cacheCurrentMapArea() — must skip tiles it already has (the actual bug:
// every click used to re-download the whole view from the network again).
// ==========================================================================

test('cacheCurrentMapArea: downloads tiles for a never-before-cached view', async () => {
  const { window, context } = bootLive();
  run(context, 'goToLatLon(51.5074, -0.1278, 15)');

  let fetchCalls = 0;
  window.fetch = async () => { fetchCalls++; return new window.Response('tile-bytes', { status: 200 }); };

  await run(context, 'cacheCurrentMapArea()');

  assert.ok(fetchCalls > 0, 'a first-time cache pass should hit the network');
});

test('cacheCurrentMapArea: regression — re-caching the identical view makes zero network requests, using Cache Storage instead', async () => {
  const { window, context } = bootLive();
  run(context, 'goToLatLon(51.5074, -0.1278, 15)');

  let fetchCalls = 0;
  window.fetch = async () => { fetchCalls++; return new window.Response('tile-bytes', { status: 200 }); };

  await run(context, 'cacheCurrentMapArea()'); // populates the cache
  fetchCalls = 0;
  await run(context, 'cacheCurrentMapArea()'); // same view again

  assert.strictEqual(fetchCalls, 0, 'every tile in this view should already be in Cache Storage');
});

test('cacheCurrentMapArea: a genuinely new area still hits the network even after a previous area was fully cached', async () => {
  const { window, context } = bootLive();
  window.fetch = async () => new window.Response('tile-bytes', { status: 200 });

  run(context, 'goToLatLon(51.5074, -0.1278, 15)'); // London
  await run(context, 'cacheCurrentMapArea()');

  run(context, 'goToLatLon(-33.8688, 151.2093, 15)'); // Sydney — far enough to be disjoint tiles
  let fetchCalls = 0;
  window.fetch = async () => { fetchCalls++; return new window.Response('tile-bytes', { status: 200 }); };
  await run(context, 'cacheCurrentMapArea()');

  assert.ok(fetchCalls > 0, 'a disjoint area should not be considered already-cached');
});

test('cacheCurrentMapArea: regression — every zoom level in the pre-fetch range gets a URL whose z actually matches its x/y (not stamped with the current on-screen zoom)', async () => {
  // Real Leaflet's TileLayer.getTileUrl(coords) ignores coords.z and
  // substitutes the layer's own current on-screen zoom instead — invisible
  // during normal panning (Leaflet only ever requests tiles at the zoom
  // it's displaying), but cacheCurrentMapArea() deliberately requests
  // zoom levels ABOVE the current one to pre-fetch detail for offline
  // zooming-in. Going through getTileUrl() there mismatches z against x/y,
  // producing out-of-range tile requests the CDN 400s — which a browser
  // reports as a CORS failure, since error responses carry no CORS
  // headers, masking the real cause. This asserts every requested URL's
  // {z} matches the zoom loop iteration that produced its x/y.
  const { window, context } = bootLive();
  run(context, 'goToLatLon(51.5074, -0.1278, 15)');

  const requestedUrls = [];
  window.fetch = async (url) => { requestedUrls.push(url); return new window.Response('tile-bytes', { status: 200 }); };

  await run(context, 'cacheCurrentMapArea()');

  assert.ok(requestedUrls.length > 0);
  const zoomsRequested = new Set(requestedUrls.map((u) => u.match(/light_all\/(\d+)\//)[1]));
  // currentZoom(15) through min(currentZoom+3, 18) == 15,16,17,18 — the bug
  // collapsed every URL's z to whatever the map's "current" zoom was
  // (15), so this would be { '15' } instead of all four levels.
  assert.deepStrictEqual([...zoomsRequested].sort(), ['15', '16', '17', '18']);
});

// ==========================================================================
// renderStatus() — Reconnect shouldn't appear before a connection was ever
// attempted (manualReconnect() is a no-op without a prior device); New
// Connection should, since it's the escape hatch back to the connect
// overlay after "Prepare Map Offline".
// ==========================================================================

test('renderStatus: Reconnect stays hidden on a fresh load (no device ever requested), New Connection does not', () => {
  const { window, context } = bootLive();
  run(context, "renderStatus('disconnected')");

  assert.strictEqual(window.document.getElementById('reconnectBtn').style.display, 'none');
  assert.strictEqual(window.document.getElementById('newConnectionBtn').style.display, '');
});

test('renderStatus: Reconnect appears once a connection has actually been attempted', () => {
  const { window, context } = bootLive();
  run(context, 'bleManager = {}'); // stand-in for "attemptConnect() has run at least once"
  run(context, "renderStatus('disconnected')");

  assert.strictEqual(window.document.getElementById('reconnectBtn').style.display, '');
});

// ==========================================================================
// Live-tracking zoom level and delayed phasic recoloring of the track.
// ==========================================================================

test('updateLiveMap: the first GPS fix zooms to LIVE_ZOOM (18), replacing the old fixed 17', () => {
  const { context } = bootLive();
  run(context, 'showMap()');
  run(context, "updateLiveMap({ valid: true, lat: 51.5, lon: -0.12, gsrRaw: 1000, hdop: 1.0, fixType: 3, sats: 8, gap: false })");

  assert.strictEqual(run(context, 'LIVE_ZOOM'), 18);
  assert.strictEqual(run(context, 'liveMap.getZoom()'), 18);
});

test('recolorPhasicSegments: holds a segment back until its packet is BOTH phasic-annotated AND old enough, then repaints exactly once with the phasic-based color', () => {
  const { context } = bootLive();
  run(context, `
    LiveState.packets = [{ timestamp: 0 }];
    const __pktA = { timestamp: 0 }; // no .phasic yet
    const __lineA = L.polyline([[0, 0], [0, 0]], { color: 'raw-gsr-color' });
    pendingPhasicSegments.push({ pkt: __pktA, line: __lineA });
  `);

  // Recent (delta < PHASIC_COLOR_LAG_S) and no phasic yet — held back.
  run(context, 'LiveState.packets = [{ timestamp: 0 }, { timestamp: 3 }]; recolorPhasicSegments();');
  assert.strictEqual(run(context, 'pendingPhasicSegments.length'), 1);
  assert.strictEqual(run(context, '__lineA._style'), undefined);

  // Old enough now (delta 20 >= 8), but still no phasic value — still held
  // back (proves the phasic-availability check isn't skipped once time
  // alone would allow it through).
  run(context, 'LiveState.packets = [{ timestamp: 0 }, { timestamp: 20 }]; recolorPhasicSegments();');
  assert.strictEqual(run(context, 'pendingPhasicSegments.length'), 1);
  assert.strictEqual(run(context, '__lineA._style'), undefined);

  // Phasic is available now, but back to too-recent (delta 3 < 8) — still
  // held back (the mirror image of the previous check: proves the time
  // check isn't skipped once phasic alone would allow it through).
  run(context, '__pktA.phasic = 42; LiveState.packets = [{ timestamp: 0 }, { timestamp: 3 }]; recolorPhasicSegments();');
  assert.strictEqual(run(context, 'pendingPhasicSegments.length'), 1);
  assert.strictEqual(run(context, '__lineA._style'), undefined);

  // Phasic now available AND old enough — repaints and clears the queue.
  run(context, 'LiveState.packets = [{ timestamp: 0 }, { timestamp: 20 }]; recolorPhasicSegments();');
  assert.strictEqual(run(context, 'pendingPhasicSegments.length'), 0);
  assert.strictEqual(run(context, 'phasicMax'), 42);
  const style = JSON.parse(run(context, 'JSON.stringify(__lineA._style)'));
  // getColorForValue(42, 0, 42): ratio 1.0 -> hue 0 -> red end of the scale.
  assert.strictEqual(style.color, 'hsl(0, 90%, 50%)');
});

test('resetSession: clears pendingPhasicSegments and phasicMax, so a stale entry from a prior session (whose pkt.phasic will never be set again) can never wedge the next session\'s recolor queue', () => {
  const { context } = bootLive();
  run(context, `
    pendingPhasicSegments.push({ pkt: { timestamp: 0 }, line: L.polyline([[0, 0], [0, 0]], {}) });
    phasicMax = 99;
  `);

  run(context, 'resetSession()');

  assert.strictEqual(run(context, 'pendingPhasicSegments.length'), 0);
  assert.strictEqual(run(context, 'phasicMax'), 0);
});

test('end-to-end: a walking session progressively repaints its older track segments with phasic color while its most recent segments stay provisional', () => {
  const { context } = bootLive();
  // 50 packets at the real STREAM_INTERVAL_S cadence (0.3s), stepping GSR up
  // partway through so decomposeTonicPhasic has a real, non-trivial phasic
  // response to compute — not just feeding a flat, uninformative signal.
  run(context, `
    showMap();
    for (let i = 0; i < 50; i++) {
      LiveState.addPacket({
        valid: true,
        lat: 51.5074 + i * 0.00002,
        lon: -0.1278 + i * 0.00002,
        gsrRaw: i < 10 ? 1000 : 1400,
        hdop: 1.0, pdop: 1.5, speedKts: 2, courseDeg: 90, sats: 9, fixType: 3,
        timestamp: i * 0.3,
      });
      drawGraph(); // stands in for the real animation loop's per-frame call
    }
  `);

  const result = JSON.parse(run(context, `
    JSON.stringify({
      totalSegments: liveMap._layers.filter(l => l.latlngs).length,
      repaintedCount: liveMap._layers.filter(l => l.latlngs && l._style !== undefined).length,
      pendingCount: pendingPhasicSegments.length,
      oldestPendingAge: pendingPhasicSegments.length > 0
        ? LiveState.packets[LiveState.packets.length - 1].timestamp - pendingPhasicSegments[0].pkt.timestamp
        : null,
    })
  `));

  assert.strictEqual(result.totalSegments, 49, '50 packets -> 49 segments (the first fix only sets the view, no segment)');
  assert.ok(result.repaintedCount > 0, 'some early segments should have settled and repainted by now');
  assert.ok(result.pendingCount > 0, 'the most recent segments should still be waiting out the lag');
  assert.strictEqual(result.repaintedCount + result.pendingCount, result.totalSegments);
  assert.ok(result.oldestPendingAge < 8, `the oldest still-pending segment should be within PHASIC_COLOR_LAG_S, got ${result.oldestPendingAge}`);
});

// ==========================================================================
// End-to-end BLE receive path: a Web Bluetooth notification -> the binary
// parser -> LiveState.addPacket -> footer stats + live map. The parser
// (test_live_binary_parser.js) and LiveState (above) are each covered in
// isolation; nothing else exercises the join — GSRLiveBluetoothManager
// ._subscribe() wiring the characteristic's 'characteristicvaluechanged'
// event through to a drawn map segment.
// ==========================================================================

test('attemptConnect: a real BLE notification flows through the parser to LiveState, the footer, and the live map', async (t) => {
  const { window, context } = bootLive();
  const ble = makeFakeBle(context);
  window.navigator.bluetooth = ble.bluetooth;

  run(context, 'showMap()'); // updateLiveMap() only draws once liveMap exists
  await run(context, 'attemptConnect()');
  stopLoopAfter(t, context);

  assert.strictEqual(run(context, 'LiveState.status'), 'connected');
  assert.ok(
    window.document.getElementById('connectOverlay').classList.contains('hidden'),
    'a successful connect hides the connect overlay',
  );
  assert.strictEqual(
    ble.notificationHandlerCount(), 1,
    '_subscribe() should register exactly one characteristicvaluechanged listener',
  );

  // First fix: sets the map view and drops the position marker, no segment yet.
  ble.fireNotification(buildPacket({ timestampMs: 300, lat: 51.5074, lon: -0.1278, gsrRaw: 1000, sats: 9, fixType: 3 }));

  assert.strictEqual(run(context, 'LiveState.packets.length'), 1);
  assert.strictEqual(window.document.getElementById('statPackets').textContent, 'Packets: 1');
  assert.strictEqual(window.document.getElementById('statGps').textContent, 'GPS: 3D (9 sat)');
  assert.strictEqual(window.document.getElementById('exportBtn').disabled, false);
  assert.strictEqual(run(context, 'liveMap.getZoom()'), 18, 'first fix zooms to LIVE_ZOOM');
  assert.strictEqual(
    run(context, 'liveMap._layers.filter(l => l.options && l.options.radius).length'), 1,
    'first fix creates the position marker',
  );

  // Second fix a cadence-step later, new position, no gap -> one track segment.
  ble.fireNotification(buildPacket({ timestampMs: 600, lat: 51.5076, lon: -0.1276, gsrRaw: 1200, sats: 9, fixType: 3 }));

  assert.strictEqual(run(context, 'LiveState.packets.length'), 2);
  assert.strictEqual(run(context, 'LiveState.gapCount'), 0);
  assert.strictEqual(
    run(context, 'liveMap._layers.filter(l => l.latlngs).length'), 1,
    'the second consecutive fix draws exactly one polyline segment',
  );

  run(context, "drawGraph(); LiveState.setStatus('disconnected')"); // render once, then stop the RAF loop
  assert.match(window.document.getElementById('graphValue').textContent, /-?\d+ nS$/);
});

test('attemptConnect: an invalid (no-fix) notification still counts as a packet and updates stats, but draws nothing on the map', async (t) => {
  const { window, context } = bootLive();
  const ble = makeFakeBle(context);
  window.navigator.bluetooth = ble.bluetooth;

  run(context, 'showMap()');
  await run(context, 'attemptConnect()');
  stopLoopAfter(t, context);

  ble.fireNotification(buildPacket({ timestampMs: 300, gsrRaw: 800, sats: 0, fixType: 1, valid: 0 }));

  assert.strictEqual(run(context, 'LiveState.packets.length'), 1);
  assert.strictEqual(window.document.getElementById('statGps').textContent, 'GPS: No fix');
  assert.strictEqual(
    run(context, 'liveMap._layers.filter(l => (l.options && l.options.radius) || l.latlngs).length'), 0,
    'a no-fix sample must not place a marker or a segment',
  );

  run(context, "LiveState.setStatus('disconnected')");
});

test('attemptConnect: a service-UUID mismatch fails the connect and surfaces the discovered UUIDs, without marking the session connected', async () => {
  const { window, context } = bootLive();
  const ble = makeFakeBle(context, { missingService: true });
  window.navigator.bluetooth = ble.bluetooth;

  await run(context, 'attemptConnect()');

  assert.strictEqual(run(context, 'LiveState.status'), 'disconnected');
  assert.ok(
    !window.document.getElementById('connectOverlay').classList.contains('hidden'),
    'a failed connect leaves the connect overlay up',
  );
  assert.strictEqual(ble.notificationHandlerCount(), 0, 'no characteristic was ever subscribed');
  // _logDiscoveredServices() routes the discovery hint through onStatusText,
  // which attemptConnect() mirrors into reconnectErr (connectErr is then
  // overwritten by the thrown error's own message in the catch).
  assert.match(
    window.document.getElementById('reconnectErr').textContent, /Service UUID mismatch/,
  );
});

// ==========================================================================
// GSRLiveBluetoothManager._handleDisconnect() — the bounded auto-reconnect
// loop behind a 'gattserverdisconnected' event (live.html ~L332). Its own
// doc comment says an unbounded retry loop is "a documented way to make
// requestDevice() itself stop responding afterward", so the attempt cap,
// the backoff schedule, and the _reconnecting re-entrancy guard are all
// load-bearing — and none of it was covered.
// ==========================================================================

// Yields the event loop until `pred()` is true (or `tries` runs out) — for
// stepping through _handleDisconnect()'s awaits, which span a macrotask (the
// recordingTimers setTimeout) plus several microtasks per attempt.
async function settle(pred, tries = 200) {
  for (let i = 0; i < tries && !pred(); i++) await new Promise((r) => setImmediate(r));
}

// Every test here reaches 'connected'/'reconnecting', which starts live.html's
// requestAnimationFrame loop (jsdom's rAF is a non-unref'd timer) — a failing
// assertion that skips the explicit reset would hang `npm test`. t.after()
// runs regardless, so the loop always stops.
function stopLoopAfter(t, context) {
  t.after(() => { try { vm.runInContext("LiveState.setStatus('disconnected')", context); } catch { /* torn down */ } });
}

test('_handleDisconnect: retries then recovers — status ends "connected", loop stops early on the first successful re-subscribe', async (t) => {
  const { window, context } = bootLive();
  const ble = makeFakeBle(context, { reconnectFailures: 2 }); // 2 fail, 3rd succeeds
  window.navigator.bluetooth = ble.bluetooth;
  await run(context, 'attemptConnect()');
  stopLoopAfter(t, context);

  const timers = recordingTimers(window);
  await run(context, 'bleManager._handleDisconnect()');
  timers.restore();

  assert.strictEqual(run(context, 'LiveState.status'), 'connected');
  assert.strictEqual(run(context, 'bleManager._reconnecting'), false, 'the guard flag must be cleared on success');
  // 1 initial connect + 3 reconnect attempts (fail, fail, succeed).
  assert.strictEqual(ble.subscribeCallCount(), 4);
  // Backoff waited before attempts 1..3 only — no wait after the success.
  assert.deepStrictEqual(timers.delays, [500, 1000, 2000]);
});

test('_handleDisconnect: gives up after exactly 6 attempts, drops to "disconnected", and surfaces the last error via onStatusText', async (t) => {
  const { window, context } = bootLive();
  const ble = makeFakeBle(context, { reconnectFailures: 99 }); // every reconnect fails
  window.navigator.bluetooth = ble.bluetooth;
  await run(context, 'attemptConnect()');
  stopLoopAfter(t, context);

  run(context, 'globalThis.__statusSeen = []; LiveState.on("status", (s) => globalThis.__statusSeen.push(s))');

  const timers = recordingTimers(window);
  await run(context, 'bleManager._handleDisconnect()');
  timers.restore();

  assert.strictEqual(run(context, 'LiveState.status'), 'disconnected');
  assert.strictEqual(run(context, 'bleManager._reconnecting'), false);
  assert.strictEqual(ble.subscribeCallCount(), 1 + 6, 'exactly 6 reconnect attempts, then it stops');
  // The cap: 500, 1000, 2000, 4000, then clamped at 8000.
  assert.deepStrictEqual(timers.delays, [500, 1000, 2000, 4000, 8000, 8000]);

  const seen = runJSON(context, 'globalThis.__statusSeen');
  assert.deepStrictEqual(seen, ['reconnecting', 'disconnected'], 'one reconnecting, then one disconnected — no flicker');
  assert.match(
    window.document.getElementById('reconnectErr').textContent, /Auto-reconnect failed: reconnect attempt 6 failed/,
  );
});

test('_handleDisconnect: a second gattserverdisconnected while a reconnect loop is already running is a no-op (the _reconnecting guard)', async (t) => {
  const { window, context } = bootLive();
  const ble = makeFakeBle(context);
  window.navigator.bluetooth = ble.bluetooth;
  await run(context, 'attemptConnect()');
  stopLoopAfter(t, context);
  assert.strictEqual(ble.subscribeCallCount(), 1);

  const timers = recordingTimers(window);
  const releaseSubscribe = ble.blockNextSubscribe(); // hold the first reconnect mid-attempt

  const firstLoop = run(context, 'bleManager._handleDisconnect()'); // don't await yet
  await settle(() => ble.subscribeCallCount() === 2); // wait until it's blocked in getCharacteristic()

  assert.strictEqual(run(context, 'bleManager._reconnecting'), true);
  assert.strictEqual(run(context, 'LiveState.status'), 'reconnecting');
  assert.strictEqual(ble.subscribeCallCount(), 2, 'the first reconnect attempt is in flight');

  // Re-entrant call — must bail immediately on the guard, starting nothing.
  await run(context, 'bleManager._handleDisconnect()');
  assert.strictEqual(ble.subscribeCallCount(), 2, 'the second call started no new attempt');

  releaseSubscribe();
  await firstLoop;
  timers.restore();

  assert.strictEqual(run(context, 'LiveState.status'), 'connected');
  assert.strictEqual(run(context, 'bleManager._reconnecting'), false);
});

// Regression test: _subscribe() used to add a fresh
// 'characteristicvaluechanged' closure on every call — and it's called again
// on each auto-reconnect (live.html:340) / manualReconnect (live.html:359),
// with no removeEventListener. Chrome's Web Bluetooth returns the SAME
// characteristic object across a disconnect/reconnect on the same
// BluetoothDevice, so the stale listener stayed live: after one auto-
// reconnect every notification was parsed twice (three times after two, …).
// Duplicated packets carry an identical device-uptime timestamp, so
// addPacket() also flagged each as a gap (timestamp <= prev), inflating
// gapCount and drawing spurious breaks. Fixed by binding the handler once in
// the constructor and remove-then-add'ing it in _subscribe().
test('_handleDisconnect: after a successful auto-reconnect, one BLE notification yields exactly one packet', async (t) => {
  const { window, context } = bootLive();
  const ble = makeFakeBle(context, { reconnectFailures: 1 });
  window.navigator.bluetooth = ble.bluetooth;
  run(context, 'showMap()');
  await run(context, 'attemptConnect()');
  stopLoopAfter(t, context);

  const timers = recordingTimers(window);
  await run(context, 'bleManager._handleDisconnect()');
  timers.restore();
  assert.strictEqual(run(context, 'LiveState.status'), 'connected');
  assert.strictEqual(
    ble.notificationHandlerCount(), 1,
    'the reconnect re-subscribes with exactly one listener, not a stack of them',
  );

  ble.fireNotification(buildPacket({ timestampMs: 900, gsrRaw: 1111, sats: 8, fixType: 3 }));

  assert.strictEqual(
    run(context, 'LiveState.packets.length'), 1,
    'a re-subscribe must not leave a stale listener that double-parses every notification',
  );
  assert.strictEqual(run(context, 'LiveState.gapCount'), 0, 'the duplicate is not a real gap');
});

// ==========================================================================
// exportCsv() — the "Export CSV" button. Must emit docs/csv_schema.md's
// canonical 11-column GPS+GSR schema with the two mandatory metadata lines,
// and use the sentinel-correct empty string (not "NaN") for lat/lon on a
// no-fix sample. Nothing covered this.
// ==========================================================================

// Captures the text exportCsv() hands to `new Blob([...])` and stops the
// synthetic <a> click from reaching jsdom's unimplemented navigation.
function captureCsvExport(window) {
  const box = { text: null };
  window.Blob = class { constructor(parts) { box.text = parts.join(''); } };
  window.HTMLAnchorElement.prototype.click = () => {};
  return box;
}

test('exportCsv: emits the canonical 11-column schema, both metadata lines, and sentinel-correct rows', () => {
  const { window, context } = bootLive();
  const csv = captureCsvExport(window);
  run(context, 'Date.now = () => 1700000123456'); // -> epoch seconds 1700000123

  run(context, `
    LiveState.packets = [
      { timestamp: 0.30, valid: true,  lat: 51.5074, lon: -0.1278,
        hdop: 1.2, pdop: 1.8, sats: 9, fixType: 3, speedKts: 3.4, courseDeg: 270.0, gsrRaw: 1234.5 },
      { timestamp: 12.60, valid: false, lat: NaN, lon: NaN,
        hdop: 99.9, pdop: 99.9, sats: 0, fixType: 1, speedKts: 0, courseDeg: 0, gsrRaw: 800.0 },
    ];
  `);

  run(context, 'exportCsv()');
  const lines = csv.text.split('\n');

  // docs/csv_schema.md §"Column Definitions" — GPS+GSR is exactly these 11.
  assert.strictEqual(lines[0], '# RecordingStartTime:1700000111'); // 1700000123 - floor(12.60)
  assert.strictEqual(lines[1], '# DeviceName:LiveStream');
  assert.strictEqual(lines[2], 'timestamp,lat,lon,hdop,pdop,sats,fix_type,speed_kts,course_deg,gsr_raw,hacc_m');

  // Valid fix: lat/lon to 7dp, DOP/speed/course/gsr to 1dp, sats+fix as ints,
  // hacc_m always the trailing empty field (the wire packet never carries it).
  assert.strictEqual(lines[3], '0.30,51.5074000,-0.1278000,1.2,1.8,9,3,3.4,270.0,1234.5,');
  // No-fix sample: lat AND lon are the empty string, never "NaN"; every other
  // column still present (docs/csv_schema.md §"GPS Column Sentinel Behaviour").
  assert.strictEqual(lines[4], '12.60,,,99.9,99.9,0,1,0.0,0.0,800.0,');

  // Trailing newline, and every data row carries exactly 11 fields (10 commas).
  assert.strictEqual(lines[5], '');
  for (const row of [lines[3], lines[4]]) {
    assert.strictEqual(row.split(',').length, 11, `row has 11 fields: ${row}`);
  }
});

test('exportCsv: RecordingStartTime is wall-clock-now minus the last packet\'s device uptime, floored', () => {
  const { window, context } = bootLive();
  const csv = captureCsvExport(window);
  run(context, 'Date.now = () => 1_699_999_999_000'); // epoch seconds 1699999999
  run(context, 'LiveState.packets = [{ timestamp: 100.9, valid: false, lat: NaN, lon: NaN, hdop: 99.9, pdop: 99.9, sats: 0, fixType: 0, speedKts: 0, courseDeg: 0, gsrRaw: 1 }]');

  run(context, 'exportCsv()');

  // 1699999999 - floor(100.9) == 1699999899
  assert.match(csv.text, /^# RecordingStartTime:1699999899\n/);
});

test('exportCsv: a session with no packets still produces just the header (no throw, no rows)', () => {
  const { window, context } = bootLive();
  const csv = captureCsvExport(window);
  run(context, 'Date.now = () => 1700000000000');

  run(context, 'exportCsv()');

  assert.strictEqual(
    csv.text,
    '# RecordingStartTime:1700000000\n# DeviceName:LiveStream\n'
    + 'timestamp,lat,lon,hdop,pdop,sats,fix_type,speed_kts,course_deg,gsr_raw,hacc_m\n',
  );
});

// ==========================================================================
// updateLiveMap() — GPS quality gating (live.html:861). LIVE_MAX_HDOP is
// 2.0; the firmware applies no HDOP gate, so this filters purely at display
// time. fixType 1 (no fix) is rejected; a gap breaks the drawn trail without
// stopping tracking. Only "first fix zooms" was covered.
// ==========================================================================

const FIX = (over = {}) => JSON.stringify({
  valid: true, lat: 51.5074, lon: -0.1278, gsrRaw: 1000,
  hdop: 1.0, pdop: 1.5, fixType: 3, sats: 9, gap: false, ...over,
});
const segLatLngs = (context) =>
  runJSON(context, 'liveMap._layers.filter(l => l.latlngs).map(l => l.latlngs)');

test('updateLiveMap: a fix worse than LIVE_MAX_HDOP (2.0) is dropped — no segment, and it does not advance the trail anchor', () => {
  const { context } = bootLive();
  run(context, 'showMap()');

  run(context, `updateLiveMap(${FIX({ lat: 51.0, lon: 0.0 })})`);       // 1st good fix: view + marker, no segment
  run(context, `updateLiveMap(${FIX({ lat: 52.0, lon: 1.0, hdop: 5.0 })})`); // rejected

  assert.strictEqual(segLatLngs(context).length, 0, 'the high-HDOP fix drew nothing');
  assert.deepStrictEqual(runJSON(context, 'liveLastLatLng'), [51.0, 0.0], 'trail anchor unmoved by the rejected fix');

  run(context, `updateLiveMap(${FIX({ lat: 51.5, lon: 0.5 })})`);       // next good fix
  const segs = segLatLngs(context);
  assert.strictEqual(segs.length, 1);
  assert.deepStrictEqual(segs[0], [[51.0, 0.0], [51.5, 0.5]], 'segment bridges the two GOOD fixes, skipping the rejected one');
});

test('updateLiveMap: fixType gating — 1 (no fix) is rejected, 0 (unknown) and >=2 are accepted', () => {
  const { context } = bootLive();
  run(context, 'showMap()');

  run(context, `updateLiveMap(${FIX({ lat: 51.0, lon: 0.0, fixType: 3 })})`); // anchor
  run(context, `updateLiveMap(${FIX({ lat: 51.1, lon: 0.1, fixType: 1 })})`); // rejected
  assert.strictEqual(segLatLngs(context).length, 0);
  assert.deepStrictEqual(runJSON(context, 'liveLastLatLng'), [51.0, 0.0]);

  run(context, `updateLiveMap(${FIX({ lat: 51.2, lon: 0.2, fixType: 0 })})`); // accepted (unknown)
  run(context, `updateLiveMap(${FIX({ lat: 51.3, lon: 0.3, fixType: 2 })})`); // accepted (2D)
  assert.deepStrictEqual(segLatLngs(context), [
    [[51.0, 0.0], [51.2, 0.2]],
    [[51.2, 0.2], [51.3, 0.3]],
  ]);
});

test('updateLiveMap: a gap fix breaks the drawn trail (no segment, nothing queued for recolor) but tracking resumes after it', () => {
  const { context } = bootLive();
  run(context, 'showMap()');

  run(context, `updateLiveMap(${FIX({ lat: 51.0, lon: 0.0 })})`);            // anchor
  run(context, `updateLiveMap(${FIX({ lat: 51.1, lon: 0.1 })})`);            // segment 1
  run(context, `updateLiveMap(${FIX({ lat: 51.2, lon: 0.2, gap: true })})`); // gap: draw nothing

  assert.strictEqual(segLatLngs(context).length, 1, 'the gap interval itself gets no line');
  assert.strictEqual(run(context, 'pendingPhasicSegments.length'), 1, 'nothing new queued for phasic recolor across the gap');
  assert.deepStrictEqual(runJSON(context, 'liveLastLatLng'), [51.2, 0.2], 'but the anchor moves to the gap point');

  run(context, `updateLiveMap(${FIX({ lat: 51.3, lon: 0.3 })})`);            // resumes
  assert.deepStrictEqual(
    segLatLngs(context).at(-1), [[51.2, 0.2], [51.3, 0.3]],
    'tracking picks up from the gap point, not bridged across the gap',
  );
});

test('updateLiveMap: an invalid / NaN-position sample is a no-op — no marker, no segment, anchor untouched', () => {
  const { context } = bootLive();
  run(context, 'showMap()');
  run(context, `updateLiveMap(${FIX({ lat: 51.0, lon: 0.0 })})`); // anchor
  const before = runJSON(context, 'liveLastLatLng');

  run(context, `updateLiveMap(${FIX({ valid: false, lat: 51.9, lon: 0.9 })})`);
  // NaN can't survive JSON.stringify (-> null), so spell this call out so a
  // real NaN reaches updateLiveMap()'s isNaN() guard.
  run(context, 'updateLiveMap({ valid: true, lat: NaN, lon: NaN, gsrRaw: 1000, hdop: 1.0, pdop: 1.5, fixType: 3, sats: 9, gap: false })');

  assert.strictEqual(segLatLngs(context).length, 0);
  assert.deepStrictEqual(runJSON(context, 'liveLastLatLng'), before);
});
