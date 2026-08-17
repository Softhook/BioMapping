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
 * cover the wire-format parsing that live.html's inline copy mirrors, and
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
