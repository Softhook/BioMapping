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

const assert = require('node:assert');
const test = require('node:test');
const vm = require('node:vm');
const { bootLive } = require('./support/boot_live.js');

// `context` is accepted (and ignored) throughout this file for historical
// reasons — pre-realm-model-migration, live.html's top-level bindings lived
// in their own separate vm context, reached via `context`. bootLive() now
// shares the one real Node realm with everything else (see boot_app.js's
// header comment for the full rationale), so a not-yet-converted file's
// bindings are just bare identifiers in that shared realm — plain
// vm.runInThisContext(expr) reaches them with no context object needed.
function run(_context, expr) {
  return vm.runInThisContext(expr);
}

// Same-realm now (see run() above), so no cross-realm prototype mismatch —
// this JSON round-trip is kept only because callers still expect a plain,
// assert.deepStrictEqual-friendly value back.
function runJSON(_context, expr) {
  return JSON.parse(JSON.stringify(vm.runInThisContext(expr)));
}

// One valid 45-byte wire packet (docs/archive/bluetooth_serial_investigation.md
// §5). A compact copy of test_live_binary_parser.js's builder, kept local so
// this file stays self-contained — the wire format is frozen (§5). Returns a
// plain number[] so it crosses into the vm realm without an ArrayBuffer.
function buildPacket({
  timestampMs = 1000,
  lat = 51.5074,
  lon = -0.1278,
  gsrRaw = 1234.5,
  hdop = 1.2,
  pdop = 1.8,
  speedKts = 3.4,
  courseDeg = 270.0,
  sats = 9,
  fixType = 3,
  valid = 1,
} = {}) {
  const buf = new Uint8Array(45);
  const view = new DataView(buf.buffer);
  buf[0] = 0x42;
  buf[1] = 0x4d;
  view.setUint32(2, timestampMs, true);
  view.setFloat64(6, lat, true);
  view.setFloat64(14, lon, true);
  view.setFloat32(22, gsrRaw, true);
  view.setFloat32(26, hdop, true);
  view.setFloat32(30, pdop, true);
  view.setFloat32(34, speedKts, true);
  view.setFloat32(38, courseDeg, true);
  buf[42] = sats;
  buf[43] = fixType;
  buf[44] = valid;
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
// opts.watchAdvertisements — 'yes' (default): device.watchAdvertisements()
//                            exists and fireAdvertisement() dispatches
//                            'advertisementreceived' to it, matching the
//                            reconnect-resilience layers in live_bluetooth.js.
//                            'no': the method doesn't exist at all, so
//                            feature-detection falls back to plain timers —
//                            exercises that every layer degrades cleanly on
//                            a platform without it (e.g. iOS/Bluefy).
// opts.getDevices           — 'self' (default): navigator.bluetooth.getDevices()
//                            resolves with [device] (as if the platform still
//                            remembers this exact previously-granted device).
//                            'empty': resolves with [] (nothing remembered).
//                            'no': the method doesn't exist (unsupported
//                            platform) — tryResumeDevice() must fall back.
let fakeDeviceCounter = 0;
let cachedBytesToDataView;
function makeFakeBle(
  _context,
  {
    failRequestDevice = false,
    missingService = false,
    reconnectFailures = 0,
    watchAdvertisements = 'yes',
    getDevices = 'self',
  } = {},
) {
  // Same realm as live.html now (see run()'s comment above), so any
  // Uint8Array/DataView built here already IS what `new
  // Uint8Array(e.target.value.buffer)` inside live.html consumes — cached
  // once at module scope since the expression is realm-invariant, not
  // per-bootLive()-call.
  cachedBytesToDataView ??= vm.runInThisContext(
    '(bytes => new DataView(Uint8Array.from(bytes).buffer))',
  );
  const bytesToDataView = cachedBytesToDataView;

  const charHandlers = [];
  // type -> Set<fn> — a real EventTarget's shape, needed here (unlike the
  // single-handler-per-type shortcut this used to be) because
  // 'advertisementreceived' listeners are added/removed repeatedly across a
  // single reconnect loop's lifetime, alongside the one-time
  // 'gattserverdisconnected' listener from connect()/tryResumeDevice().
  const deviceHandlers = {};
  function onDevice(type, fn) {
    if (!deviceHandlers[type]) deviceHandlers[type] = new Set();
    deviceHandlers[type].add(fn);
  }
  function offDevice(type, fn) {
    if (deviceHandlers[type]) deviceHandlers[type].delete(fn);
  }
  function fireDevice(type) {
    if (deviceHandlers[type])
      [...deviceHandlers[type]].forEach((fn) => {
        fn();
      });
  }
  let subscribeCalls = 0; // getCharacteristic() calls == _subscribe() attempts
  let subscribeGate = null; // when set, the next getCharacteristic() awaits it

  const characteristic = {
    addEventListener(type, fn) {
      if (type === 'characteristicvaluechanged') charHandlers.push(fn);
    },
    removeEventListener(type, fn) {
      if (type !== 'characteristicvaluechanged') return;
      const i = charHandlers.indexOf(fn);
      if (i !== -1) charHandlers.splice(i, 1);
    },
    async startNotifications() {
      return this;
    },
  };
  const service = {
    async getCharacteristic() {
      subscribeCalls++;
      if (subscribeGate) {
        const g = subscribeGate;
        subscribeGate = null;
        await g;
      }
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
    async getPrimaryServices() {
      return [{ uuid: 'aaaa1111-0000-1000-8000-00805f9b34fb' }];
    },
  };
  let disconnectCalls = 0;
  let watchAdvertisementsCalls = 0;
  const device = {
    // Unique per fake stack so tryResumeDevice()'s `d.id === candidateDevice.id`
    // match only succeeds when a test deliberately reuses the SAME fake
    // (simulating "the platform still remembers this exact device") — two
    // independent makeFakeBle() calls (different physical devices, or the
    // "New Connection" picked something else) never accidentally match.
    id: `fake-device-${++fakeDeviceCounter}`,
    gatt: {
      connected: false,
      async connect() {
        this.connected = true;
        return server;
      },
      // Real Web Bluetooth fires 'gattserverdisconnected' as a result of an
      // explicit disconnect() too — reproduce that so the manager's
      // _intentionalClose guard is exercised.
      disconnect() {
        disconnectCalls++;
        this.connected = false;
        fireDevice('gattserverdisconnected');
      },
    },
    addEventListener: onDevice,
    removeEventListener: offDevice,
  };
  if (watchAdvertisements === 'yes') {
    // Real watchAdvertisements() just arms the OS-level scan; events arrive
    // later via 'advertisementreceived' (fireAdvertisement() below), and
    // cancellation is via the AbortSignal, not this promise settling.
    device.watchAdvertisements = async () => {
      watchAdvertisementsCalls++;
    };
  }
  return {
    bluetooth: {
      async requestDevice() {
        if (failRequestDevice)
          throw new Error('user cancelled the device chooser');
        return device;
      },
      ...(getDevices !== 'no'
        ? {
            async getDevices() {
              return getDevices === 'empty' ? [] : [device];
            },
          }
        : {}),
    },
    device,
    gattDisconnectCallCount: () => disconnectCalls,
    watchAdvertisementsCallCount: () => watchAdvertisementsCalls,
    fireNotification(byteArray) {
      const value = bytesToDataView(byteArray);
      charHandlers.forEach((fn) => {
        fn({ target: { value } });
      });
    },
    fireDisconnect() {
      fireDevice('gattserverdisconnected');
    },
    fireAdvertisement() {
      fireDevice('advertisementreceived');
    },
    notificationHandlerCount: () => charHandlers.length,
    advertisementHandlerCount: () =>
      deviceHandlers.advertisementreceived
        ? deviceHandlers.advertisementreceived.size
        : 0,
    subscribeCallCount: () => subscribeCalls,
    // Blocks the NEXT getCharacteristic() until the returned function is
    // called — lets a test hold _handleDisconnect() mid-attempt.
    blockNextSubscribe() {
      let release;
      subscribeGate = new Promise((r) => {
        release = r;
      });
      return release;
    },
  };
}

// Replaces setTimeout with one that fires (near-)immediately and records
// the delay it was asked for, so a test can await _handleDisconnect()'s
// whole retry loop in ~no time and still assert the real backoff schedule.
// Returns { delays, restore }.
//
// Patches `global.setTimeout`, not `window.setTimeout`: live_bluetooth.js's
// bare `setTimeout(...)` calls resolve through the shared realm's `global`
// (see boot_app.js's header comment on the realm-model bridge), which is
// tests/support/realm_bridge.js's own leak-tracking wrapper around the
// REAL native setTimeout, not anything reachable via `window`. `real` here
// IS that wrapper, so delegating to it on every recorded call keeps this
// test's own fired timers covered by the cross-boot leak sweep same as
// everything else — only the requested delay is intercepted.
function recordingTimers(_window) {
  const delays = [];
  const real = global.setTimeout;
  global.setTimeout = (fn, ms) => {
    delays.push(ms);
    return real(fn, 0);
  };
  return {
    delays,
    restore() {
      global.setTimeout = real;
    },
  };
}

// ==========================================================================
// LiveState.addPacket() — gap detection
// ==========================================================================

test('addPacket: no gap for packets arriving at the expected cadence', async () => {
  const { context } = await bootLive();
  run(context, 'LiveState.addPacket({ timestamp: 0.0, gsrRaw: 1 })');
  run(context, 'LiveState.addPacket({ timestamp: 0.3, gsrRaw: 2 })');
  const gaps = runJSON(context, 'LiveState.packets.map(p => !!p.gap)');
  assert.deepStrictEqual(gaps, [false, false]);
  assert.strictEqual(run(context, 'LiveState.gapCount'), 0);
});

test('addPacket: flags a real dropped/disconnected interval as a gap', async () => {
  const { context } = await bootLive();
  run(context, 'LiveState.addPacket({ timestamp: 0.0, gsrRaw: 1 })');
  run(context, 'LiveState.addPacket({ timestamp: 5.0, gsrRaw: 2 })'); // way past 2x the 0.3s interval
  const gaps = runJSON(context, 'LiveState.packets.map(p => !!p.gap)');
  assert.deepStrictEqual(gaps, [false, true]);
  assert.strictEqual(run(context, 'LiveState.gapCount'), 1);
});

test('addPacket: regression — a timestamp that resets lower than the previous packet is a gap, not a silently-accepted negative delta', async () => {
  // The wire timestamp is device-uptime ms, not wall-clock. Reconnecting to
  // a different (or power-cycled) device restarts that counter near zero,
  // so a plain `delta > threshold` check misses it (a negative delta never
  // exceeds a positive threshold) and would let the map/graph draw a bogus
  // line connecting two unrelated sessions.
  const { context } = await bootLive();
  run(context, 'LiveState.addPacket({ timestamp: 100.0, gsrRaw: 1 })');
  run(context, 'LiveState.addPacket({ timestamp: 0.5, gsrRaw: 2 })'); // device restarted its clock
  const gaps = runJSON(context, 'LiveState.packets.map(p => !!p.gap)');
  assert.deepStrictEqual(gaps, [false, true]);
});

test('addPacket: an exactly-equal timestamp (duplicate delivery) is also treated as a gap, not a divide-by-zero-shaped edge case', async () => {
  const { context } = await bootLive();
  run(context, 'LiveState.addPacket({ timestamp: 1.0, gsrRaw: 1 })');
  run(context, 'LiveState.addPacket({ timestamp: 1.0, gsrRaw: 2 })');
  assert.strictEqual(run(context, 'LiveState.packets[1].gap'), true);
});

// ==========================================================================
// resetSession() — the fix for cross-session state leaking into a fresh
// BLE connection (see attemptConnect()'s call site).
// ==========================================================================

test('resetSession: clears accumulated packets/gaps/position/color-range state', async () => {
  const { context } = await bootLive();
  run(context, 'LiveState.addPacket({ timestamp: 0.0, gsrRaw: 10 })');
  run(context, 'LiveState.addPacket({ timestamp: 5.0, gsrRaw: 20 })'); // creates a gap
  run(context, 'liveLastLatLng = [51.5, -0.12]');
  run(context, 'gsrMin = 5; gsrMax = 25');
  run(context, 'lastPacketTimestamp = 5.0; lastPacketArrivalTime = 123456');

  run(context, 'resetSession()');

  assert.strictEqual(run(context, 'LiveState.packets.length'), 0);
  assert.strictEqual(run(context, 'LiveState.gapCount'), 0);
  assert.strictEqual(run(context, 'liveLastLatLng'), null);
  assert.strictEqual(run(context, 'gsrMin'), Infinity);
  assert.strictEqual(run(context, 'gsrMax'), -Infinity);
  assert.strictEqual(run(context, 'lastPacketTimestamp'), 0);
  assert.strictEqual(run(context, 'lastPacketArrivalTime'), 0);
});

test('resetSession: puts the footer stats and export button back to their pre-connection state, and empties the analyser buffer', async () => {
  const { window, context } = await bootLive();
  window.document.getElementById('exportBtn').disabled = false;
  window.document.getElementById('statPackets').textContent = 'Packets: 42';
  window.document.getElementById('statGaps').textContent = 'Gaps: 3';
  window.document.getElementById('statGps').textContent = 'GPS: 3D (9 sat)';
  window.document.getElementById('statLastSeen').textContent = 'Last: 12.3s';
  // Give the analyser a non-empty buffer so we can prove reset drops it.
  run(
    context,
    'LiveState.addPacket({ timestamp: 0.0, gsrRaw: 10, valid: false });' +
      'LiveState.addPacket({ timestamp: 0.3, gsrRaw: 12, valid: false });' +
      'feedLiveAnalyzer();',
  );
  assert.ok(
    run(context, 'liveAnalyzer && liveAnalyzer.raw.length') > 0,
    'analyser has rows before reset',
  );

  run(context, 'resetSession()');

  assert.strictEqual(
    window.document.getElementById('statPackets').textContent,
    'Packets: 0',
  );
  assert.strictEqual(
    window.document.getElementById('statGaps').textContent,
    'Gaps: 0',
  );
  assert.strictEqual(
    window.document.getElementById('statGps').textContent,
    'GPS: --',
  );
  assert.strictEqual(
    window.document.getElementById('statLastSeen').textContent,
    '--',
  );
  assert.strictEqual(
    window.document.getElementById('exportBtn').disabled,
    true,
  );
  assert.strictEqual(run(context, 'liveAnalyzer.raw.length'), 0);
});

test('attemptConnect: resets session state as soon as a device is requested, so a "New Connection" after a previous session never carries its packets over — even if the new connection attempt itself then fails', async () => {
  const { window, context } = await bootLive();
  run(context, 'LiveState.addPacket({ timestamp: 0.0, gsrRaw: 1 })');
  run(context, 'LiveState.addPacket({ timestamp: 0.3, gsrRaw: 2 })');
  assert.strictEqual(run(context, 'LiveState.packets.length'), 2);

  window.navigator.bluetooth = {
    requestDevice: async () => {
      throw new Error('user cancelled the device chooser');
    },
  };

  await run(context, 'attemptConnect()');

  assert.strictEqual(run(context, 'LiveState.packets.length'), 0);
  assert.match(
    window.document.getElementById('connectErr').textContent,
    /cancelled/,
  );
});

test('attemptConnect: leaves existing session data alone when Web Bluetooth is not available at all (nothing was actually attempted)', async () => {
  const { window, context } = await bootLive();
  run(context, 'LiveState.addPacket({ timestamp: 0.0, gsrRaw: 1 })');
  window.navigator.bluetooth = undefined;

  await run(context, 'attemptConnect()');

  assert.strictEqual(run(context, 'LiveState.packets.length'), 1);
  assert.match(
    window.document.getElementById('connectErr').textContent,
    /Web Bluetooth/,
  );
});

// ==========================================================================
// normalizeTileCacheUrl() — subdomain folding so all four CDN subdomains
// (a/b/c/d.basemaps.cartocdn.com) share one cache entry.
// ==========================================================================

test('normalizeTileCacheUrl: folds every tile subdomain to "a"', async () => {
  const { context } = await bootLive();
  const norm = (u) =>
    run(context, `normalizeTileCacheUrl(${JSON.stringify(u)})`);
  assert.strictEqual(
    norm('https://b.basemaps.cartocdn.com/light_all/15/1000/2000.png'),
    'https://a.basemaps.cartocdn.com/light_all/15/1000/2000.png',
  );
  assert.strictEqual(
    norm('https://d.basemaps.cartocdn.com/light_all/3/4/5.png'),
    'https://a.basemaps.cartocdn.com/light_all/3/4/5.png',
  );
});

test('normalizeTileCacheUrl: an already-"a" URL round-trips unchanged, and an unrelated URL is left alone', async () => {
  const { context } = await bootLive();
  const norm = (u) =>
    run(context, `normalizeTileCacheUrl(${JSON.stringify(u)})`);
  assert.strictEqual(
    norm('https://a.basemaps.cartocdn.com/light_all/1/2/3.png'),
    'https://a.basemaps.cartocdn.com/light_all/1/2/3.png',
  );
  assert.strictEqual(
    norm('https://example.com/tile.png'),
    'https://example.com/tile.png',
  );
});

test('normalizeTileCacheUrl: strips the CARTO ?key=… query so a key change does not orphan the tile cache', async () => {
  const { context } = await bootLive();
  const norm = (u) =>
    run(context, `normalizeTileCacheUrl(${JSON.stringify(u)})`);
  assert.strictEqual(
    norm(
      'https://c.basemaps.cartocdn.com/light_all/15/1000/2000.png?key=abc123',
    ),
    'https://a.basemaps.cartocdn.com/light_all/15/1000/2000.png',
  );
  assert.strictEqual(
    norm(
      'https://a.basemaps.cartocdn.com/light_all/15/1000/2000@2x.png?key=xyz',
    ),
    'https://a.basemaps.cartocdn.com/light_all/15/1000/2000@2x.png',
  );
});

// ==========================================================================
// Map visibility toggle — manual, not GPS-driven (see live.html's showMap/
// hideMap/setMapVisible comments for why).
// ==========================================================================

test('toggleMapBtn: shows the map panel, initializes liveMap, and enables Cache Map — all with no BLE connection', async () => {
  const { window, context } = await bootLive();
  assert.ok(window.document.getElementById('app').classList.contains('no-map'));
  assert.strictEqual(
    window.document.getElementById('cacheMapBtn').disabled,
    true,
  );

  window.document.getElementById('toggleMapBtn').click();

  assert.ok(
    !window.document.getElementById('app').classList.contains('no-map'),
  );
  assert.strictEqual(
    window.document.getElementById('cacheMapBtn').disabled,
    false,
  );
  assert.strictEqual(
    window.document.getElementById('toggleMapBtn').textContent,
    'Hide Map (M)',
  );
  assert.ok(
    run(context, 'liveMap') !== null,
    'liveMap should be constructed once shown',
  );
});

test('toggleMapBtn: hides the map again on a second click, without destroying the underlying liveMap instance', async () => {
  const { window, context } = await bootLive();
  window.document.getElementById('toggleMapBtn').click();
  window.document.getElementById('toggleMapBtn').click();

  assert.ok(window.document.getElementById('app').classList.contains('no-map'));
  assert.strictEqual(
    window.document.getElementById('toggleMapBtn').textContent,
    'Show Map (M)',
  );
  assert.ok(
    run(context, 'liveMap') !== null,
    'hiding is a CSS toggle, not a teardown',
  );
});

// ==========================================================================
// Mobile map-first default (isCompactLiveLayout()) — the map is shown
// immediately on a compact/coarse-pointer device, instead of the desktop
// default of starting on the fullscreen graph and requiring a manual
// "Show Map" tap.
// ==========================================================================

test('mount(): desktop (the default matchMedia stub) keeps the graph-first default — map stays hidden until toggled', async () => {
  const { window, context } = await bootLive();
  assert.ok(
    window.document.getElementById('app').classList.contains('no-map'),
    'graph fullscreen by default',
  );
  assert.strictEqual(
    run(context, 'liveMap'),
    null,
    'map not constructed until shown',
  );
});

test('mount(): a compact/coarse-pointer boot defaults to the map shown, not the graph', async () => {
  const { window, context } = await bootLive({ compact: true });
  assert.ok(
    !window.document.getElementById('app').classList.contains('no-map'),
    'map visible by default on mobile',
  );
  assert.ok(
    run(context, 'liveMap') !== null,
    'the map is constructed immediately, not lazily on a user tap',
  );
  assert.strictEqual(
    window.document.getElementById('toggleMapBtn').textContent,
    'Hide Map (M)',
  );
});

test('mount(): Phasic is drawn under the signal on desktop, but stays off on the compact (mobile) layout', async () => {
  await bootLive();
  assert.strictEqual(
    run(null, 'liveGsrView.showPhasic'),
    true,
    'desktop draws phasic under the signal',
  );
  await bootLive({ compact: true });
  assert.strictEqual(
    run(null, 'liveGsrView.showPhasic'),
    false,
    'mobile graph is too small for the phasic overlay',
  );
});

// ==========================================================================
// The mobile floating action button (#liveFab) — CSS (not exercised by
// these DOM-only jsdom tests) is what actually hides it on desktop; what IS
// testable here is that its menu content is always a function of
// `mapVisible`, and that its chips drive the exact same setLiveGraphMetric()/
// setMapVisible() the desktop header controls do.
// ==========================================================================

test('the FAB menu offers ordered chips: Graph, toggles, metrics, and Full Screen while map is showing', async () => {
  const { window } = await bootLive({ compact: true }); // map shown by default
  const menu = window.document.getElementById('liveFabMenu');
  const chips = [...menu.querySelectorAll('button')];
  assert.deepStrictEqual(
    chips.map((b) => b.dataset.metric || b.dataset.action || b.dataset.toggle),
    [
      'graph',
      'showPeaks',
      'showHotspots',
      'signal',
      'tonic',
      'phasic',
      'enter-fullscreen',
    ],
  );
  assert.ok(
    chips[1].classList.contains('active'),
    'Peaks is active by default',
  );
  assert.ok(
    chips[2].classList.contains('active'),
    'Hotspots is active by default',
  );
  assert.ok(
    chips[3].classList.contains('active'),
    '"signal" is the default active metric',
  );
  assert.ok(!chips[4].classList.contains('active'));
  assert.ok(!chips[5].classList.contains('active'));
});

test('the FAB menu offers Map chip instead of Graph once the graph is fullscreen (map hidden)', async () => {
  const { window } = await bootLive(); // desktop default: graph-first, map hidden
  const menu = window.document.getElementById('liveFabMenu');
  const chips = [...menu.querySelectorAll('button')];
  assert.deepStrictEqual(
    chips.map((b) => b.dataset.metric || b.dataset.action || b.dataset.toggle),
    [
      'map',
      'showPeaks',
      'showHotspots',
      'signal',
      'tonic',
      'phasic',
      'enter-fullscreen',
    ],
  );
});

test('tapping a FAB metric chip sets the shared metric (same as the #liveGraphView dropdown) and closes the menu', async () => {
  const { window, context } = await bootLive({ compact: true });
  const toggle = window.document.getElementById('liveFabToggle');
  const menu = window.document.getElementById('liveFabMenu');
  toggle.click();
  assert.ok(menu.classList.contains('open'));

  menu.querySelector('[data-metric="phasic"]').click();

  assert.strictEqual(run(context, 'liveGsrView.graphView'), 'phasic');
  assert.strictEqual(
    window.document.getElementById('liveGraphView').value,
    'phasic',
  );
  assert.ok(!menu.classList.contains('open'), 'menu closes after a chip tap');
  // Re-rendered menu still reflects the map-mode chip set, now highlighting phasic.
  assert.ok(
    menu.querySelector('[data-metric="phasic"]').classList.contains('active'),
  );
});

test("tapping the FAB's Graph chip switches to the fullscreen graph (mapVisible false); tapping Map from there switches back", async () => {
  const { window } = await bootLive({ compact: true }); // starts map-visible
  const app = window.document.getElementById('app');
  const menu = window.document.getElementById('liveFabMenu');

  menu.querySelector('[data-action="graph"]').click();
  assert.ok(
    app.classList.contains('no-map'),
    "Graph chip behaves exactly like today's .no-map fullscreen graph",
  );
  assert.deepStrictEqual(
    [...menu.querySelectorAll('button')].map(
      (b) => b.dataset.metric || b.dataset.action || b.dataset.toggle,
    ),
    [
      'map',
      'showPeaks',
      'showHotspots',
      'signal',
      'tonic',
      'phasic',
      'enter-fullscreen',
    ],
  );

  menu.querySelector('[data-action="map"]').click();
  assert.ok(!app.classList.contains('no-map'));
  assert.deepStrictEqual(
    [...menu.querySelectorAll('button')].map(
      (b) => b.dataset.metric || b.dataset.action || b.dataset.toggle,
    ),
    [
      'graph',
      'showPeaks',
      'showHotspots',
      'signal',
      'tonic',
      'phasic',
      'enter-fullscreen',
    ],
    'back to Graph + 2 toggles + 3 metrics + Full Screen',
  );
});

test('tapping a FAB toggle chip flips the GSR layer on/off and syncs the header toggle', async () => {
  const { window, context } = await bootLive({ compact: true });
  const toggle = window.document.getElementById('liveFabToggle');
  const menu = window.document.getElementById('liveFabMenu');
  toggle.click();

  assert.strictEqual(run(context, 'liveGsrView.showPeaks'), true);
  const peaksChip = menu.querySelector('[data-toggle="showPeaks"]');
  assert.ok(peaksChip.classList.contains('active'));

  peaksChip.click();
  assert.strictEqual(
    run(context, 'liveGsrView.showPeaks'),
    false,
    'showPeaks toggled off',
  );
  const updatedPeaksChip = menu.querySelector('[data-toggle="showPeaks"]');
  assert.ok(
    !updatedPeaksChip.classList.contains('active'),
    'chip lost active class',
  );

  // Desktop header button syncs
  const headerPeaksBtn = window.document.getElementById('liveBtnTogglePeaks');
  assert.ok(
    !headerPeaksBtn.classList.contains('active'),
    'header button in sync',
  );
});

test('tapping anywhere outside the FAB closes an open menu', async () => {
  const { window } = await bootLive({ compact: true });
  const toggle = window.document.getElementById('liveFabToggle');
  const menu = window.document.getElementById('liveFabMenu');
  toggle.click();
  assert.ok(menu.classList.contains('open'));

  window.document
    .getElementById('liveMap')
    .dispatchEvent(new window.Event('click', { bubbles: true }));

  assert.ok(!menu.classList.contains('open'));
});

// ==========================================================================
// Map-track colouring follows the shared Signal/Tonic/Phasic metric
// (setLiveGraphMetric()) instead of always settling on phasic — switching
// metric mid-session immediately recolours the WHOLE track via
// recolorAllTrackSegments(), not just segments drawn after the switch.
// ==========================================================================

test("setLiveGraphMetric: switching to phasic immediately recolours every already-drawn segment from its packet's .phasic value", async () => {
  const { context } = await bootLive();
  run(context, 'showMap()');
  // Packets already carry a .phasic value, standing in for what
  // feedLiveAnalyzer() would normally have mirrored onto them by now.
  run(
    context,
    `
    updateLiveMap({ valid: true, lat: 51.0, lon: 0.0, gsrRaw: 1000, phasic: 0.1, hdop: 1.0, fixType: 3, sats: 8, gap: false });
    updateLiveMap({ valid: true, lat: 51.1, lon: 0.1, gsrRaw: 1200, phasic: 0.1, hdop: 1.0, fixType: 3, sats: 8, gap: false });
    updateLiveMap({ valid: true, lat: 51.2, lon: 0.2, gsrRaw: 1400, phasic: 0.5, hdop: 1.0, fixType: 3, sats: 8, gap: false });
  `,
  );
  assert.strictEqual(
    run(context, 'allTrackSegments.length'),
    2,
    'first fix anchors the view, the next two each draw a segment',
  );

  run(context, "setLiveGraphMetric('phasic')");

  const colors = JSON.parse(
    run(
      context,
      'JSON.stringify(allTrackSegments.map(s => s.line._style.color))',
    ),
  );
  // getColorForValue against the session's phasic range [0, 0.5]: the first
  // segment's packet is 0.1 -> ratio 0.2 -> hue 96; the second is 0.5 ->
  // ratio 1.0 -> hue 0 (matches the hue formula the existing
  // flushSettledSegments test below already pins for this codebase).
  assert.strictEqual(colors[0], 'hsl(96, 90%, 50%)');
  assert.strictEqual(colors[1], 'hsl(0, 90%, 50%)');
});

test("setLiveGraphMetric: switching to tonic immediately recolours every already-drawn segment from its packet's .tonic value", async () => {
  const { context } = await bootLive();
  run(context, 'showMap()');
  run(
    context,
    `
    updateLiveMap({ valid: true, lat: 51.0, lon: 0.0, gsrRaw: 1000, tonic: 1.0, hdop: 1.0, fixType: 3, sats: 8, gap: false });
    updateLiveMap({ valid: true, lat: 51.1, lon: 0.1, gsrRaw: 1200, tonic: 1.0, hdop: 1.0, fixType: 3, sats: 8, gap: false });
    updateLiveMap({ valid: true, lat: 51.2, lon: 0.2, gsrRaw: 1400, tonic: 2.0, hdop: 1.0, fixType: 3, sats: 8, gap: false });
  `,
  );
  assert.strictEqual(run(context, 'allTrackSegments.length'), 2);

  run(context, "setLiveGraphMetric('tonic')");

  const colors = JSON.parse(
    run(
      context,
      'JSON.stringify(allTrackSegments.map(s => s.line._style.color))',
    ),
  );
  assert.strictEqual(colors[0], 'hsl(120, 90%, 50%)');
  assert.strictEqual(colors[1], 'hsl(0, 90%, 50%)');
});

test('setLiveGraphMetric: a repeated/unknown metric is a no-op (no redundant recolour pass, no throw)', async () => {
  const { context } = await bootLive();
  run(context, "setLiveGraphMetric('signal')"); // already the default
  assert.doesNotThrow(() =>
    run(context, "setLiveGraphMetric('not-a-real-metric')"),
  );
  assert.strictEqual(run(context, 'liveGsrView.graphView'), 'signal');
});

test('the #liveGraphView dropdown change event drives the exact same setLiveGraphMetric() the FAB chips call', async () => {
  const { window, context } = await bootLive();
  const sel = window.document.getElementById('liveGraphView');
  sel.value = 'tonic';
  sel.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.strictEqual(run(context, 'liveGsrView.graphView'), 'tonic');
});

// ==========================================================================
// window resize -> liveMap.invalidateSize(). Pre-existing gap: a bare
// window resize never told Leaflet to re-measure (only activate()/
// onDisplayModeChange() did), so the map could render at a stale size after
// a phone rotation or a desktop resize crossing the mobile breakpoint.
// ==========================================================================

test("a window resize invalidates the live map's size (not just activate()/onDisplayModeChange())", async () => {
  const { window, context } = await bootLive();
  run(context, 'showMap()');
  const before = run(context, 'liveMap.calls.invalidateSize');

  window.dispatchEvent(new window.Event('resize'));

  assert.strictEqual(run(context, 'liveMap.calls.invalidateSize'), before + 1);
});

test('an orientationchange event invalidates the live map size immediately and on delayed passes', async () => {
  const { window, context } = await bootLive();
  run(context, 'showMap()');
  const before = run(context, 'liveMap.calls.invalidateSize');

  window.dispatchEvent(new window.Event('orientationchange'));
  assert.ok(
    run(context, 'liveMap.calls.invalidateSize') >= before + 1,
    'synchronous invalidation on orientationchange',
  );

  await new Promise((r) => setTimeout(r, 350));
  assert.ok(
    run(context, 'liveMap.calls.invalidateSize') >= before + 3,
    'delayed invalidation passes run after WebKit orientation transition',
  );
});

test('a screen.orientation change event invalidates the live map size', async () => {
  const { window, context } = await bootLive();
  run(context, 'showMap()');
  const before = run(context, 'liveMap.calls.invalidateSize');

  window.screen.orientation.dispatchEvent(new window.Event('change'));
  assert.ok(
    run(context, 'liveMap.calls.invalidateSize') >= before + 1,
    'invalidation on screen.orientation change',
  );
});

test('connectBtn is disabled during connecting/reconnecting, and enabled on disconnected', async () => {
  const { window, context } = await bootLive();
  const connectBtn = window.document.getElementById('connectBtn');
  assert.strictEqual(connectBtn.disabled, false, 'enabled when disconnected');

  run(context, "LiveState.setStatus('connecting')");
  assert.strictEqual(connectBtn.disabled, true, 'disabled when connecting');

  run(context, "LiveState.setStatus('reconnecting')");
  assert.strictEqual(connectBtn.disabled, true, 'disabled when reconnecting');

  run(context, "LiveState.setStatus('disconnected')");
  assert.strictEqual(
    connectBtn.disabled,
    false,
    're-enabled when disconnected',
  );
});

// ==========================================================================
// goToLatLon() / the manual location picker — this is what makes pre-trip
// caching possible without any GPS fix at all (device or browser).
// ==========================================================================

test('goToLatLon: rejects out-of-range/non-numeric input without showing or moving the map', async () => {
  const { window, context } = await bootLive();
  let alerted = null;
  window.alert = (msg) => {
    alerted = msg;
  };

  run(context, 'goToLatLon(NaN, 10, 15)');
  assert.ok(
    alerted,
    'NaN latitude should alert instead of silently doing nothing',
  );
  assert.ok(window.document.getElementById('app').classList.contains('no-map'));

  alerted = null;
  run(context, 'goToLatLon(999, 10, 15)'); // out of [-90, 90]
  assert.ok(alerted);
  assert.ok(window.document.getElementById('app').classList.contains('no-map'));
});

test('goToLatLon: valid coordinates show the map (if hidden) and pan/zoom it there', async () => {
  const { window, context } = await bootLive();
  assert.ok(window.document.getElementById('app').classList.contains('no-map'));

  run(context, 'goToLatLon(48.8566, 2.3522, 15)');

  assert.ok(
    !window.document.getElementById('app').classList.contains('no-map'),
  );
  const center = run(context, 'liveMap.getCenter()');
  assert.strictEqual(center.lat, 48.8566);
  assert.strictEqual(center.lng, 2.3522);
  assert.strictEqual(run(context, 'liveMap.getZoom()'), 15);
});

test('goToLatLon: reused on an already-visible map just re-pans it, without re-initializing liveMap', async () => {
  const { window, context } = await bootLive();
  window.document.getElementById('toggleMapBtn').click();
  const firstMap = run(context, 'liveMap');

  run(context, 'goToLatLon(10, 20, 12)');

  assert.strictEqual(
    run(context, 'liveMap'),
    firstMap,
    'goToLatLon should not create a second map instance',
  );
  assert.strictEqual(run(context, 'liveMap.getZoom()'), 12);
});

// ==========================================================================
// cacheCurrentMapArea() — must skip tiles it already has (the actual bug:
// every click used to re-download the whole view from the network again).
// ==========================================================================

test('cacheCurrentMapArea: downloads tiles for a never-before-cached view', async () => {
  const { window, context } = await bootLive();
  run(context, 'goToLatLon(51.5074, -0.1278, 15)');

  let fetchCalls = 0;
  window.fetch = async () => {
    fetchCalls++;
    return new window.Response('tile-bytes', { status: 200 });
  };

  await run(context, 'cacheCurrentMapArea()');

  assert.ok(fetchCalls > 0, 'a first-time cache pass should hit the network');
});

test('cacheCurrentMapArea: regression — re-caching the identical view makes zero network requests, using Cache Storage instead', async () => {
  const { window, context } = await bootLive();
  run(context, 'goToLatLon(51.5074, -0.1278, 15)');

  let fetchCalls = 0;
  window.fetch = async () => {
    fetchCalls++;
    return new window.Response('tile-bytes', { status: 200 });
  };

  await run(context, 'cacheCurrentMapArea()'); // populates the cache
  fetchCalls = 0;
  await run(context, 'cacheCurrentMapArea()'); // same view again

  assert.strictEqual(
    fetchCalls,
    0,
    'every tile in this view should already be in Cache Storage',
  );
});

test('cacheCurrentMapArea: a genuinely new area still hits the network even after a previous area was fully cached', async () => {
  const { window, context } = await bootLive();
  window.fetch = async () => new window.Response('tile-bytes', { status: 200 });

  run(context, 'goToLatLon(51.5074, -0.1278, 15)'); // London
  await run(context, 'cacheCurrentMapArea()');

  run(context, 'goToLatLon(-33.8688, 151.2093, 15)'); // Sydney — far enough to be disjoint tiles
  let fetchCalls = 0;
  window.fetch = async () => {
    fetchCalls++;
    return new window.Response('tile-bytes', { status: 200 });
  };
  await run(context, 'cacheCurrentMapArea()');

  assert.ok(
    fetchCalls > 0,
    'a disjoint area should not be considered already-cached',
  );
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
  const { window, context } = await bootLive();
  run(context, 'goToLatLon(51.5074, -0.1278, 15)');

  const requestedUrls = [];
  window.fetch = async (url) => {
    requestedUrls.push(url);
    return new window.Response('tile-bytes', { status: 200 });
  };

  await run(context, 'cacheCurrentMapArea()');

  assert.ok(requestedUrls.length > 0);
  const zoomsRequested = new Set(
    requestedUrls.map((u) => u.match(/light_all\/(\d+)\//)[1]),
  );
  // currentZoom(15) through min(currentZoom+3, 18) == 15,16,17,18 — the bug
  // collapsed every URL's z to whatever the map's "current" zoom was
  // (15), so this would be { '15' } instead of all four levels.
  assert.deepStrictEqual([...zoomsRequested].sort(), ['15', '16', '17', '18']);
});

// ==========================================================================
// ==========================================================================
// renderStatus() — single connection button handles connect, reconnect,
// and disconnect across connection states.
// ==========================================================================

test('renderStatus: connection button shows "Connect" on a fresh load (no device yet), "Reconnect" once attempted', async () => {
  const { window, context } = await bootLive();
  run(context, "renderStatus('disconnected')");

  const btn = window.document.getElementById('connectionBtn');
  assert.strictEqual(
    btn.style.display,
    '',
    'connection button is visible when disconnected',
  );
  assert.strictEqual(
    btn.textContent,
    'Connect',
    'shows "Connect" before any device is connected',
  );

  // stand-in for "attemptConnect() has run at least once" — bleManager is
  // real module-scope state on the converted live_view.mjs; a bare
  // `bleManager = ...` assignment against the shared realm's global no
  // longer reaches it (an ES module's exported `let` binding can't be
  // written from outside), so go through the test hook GSRLiveView already
  // exposes for exactly this.
  run(context, 'GSRLiveView._setBleManagerForTest({ device: {} })');
  run(context, "renderStatus('disconnected')");

  assert.strictEqual(btn.style.display, '', 'still visible');
  assert.strictEqual(
    btn.textContent,
    'Reconnect',
    'shows "Reconnect" once a prior device is known',
  );
});

test('renderStatus: connection button shows "Disconnect" while connected and "Reconnecting…" while reconnecting', async () => {
  const { window, context } = await bootLive();
  const btn = window.document.getElementById('connectionBtn');

  run(context, "renderStatus('connected')");
  assert.strictEqual(btn.textContent, 'Disconnect');
  assert.strictEqual(btn.disabled, false);

  run(context, "renderStatus('reconnecting')");
  assert.strictEqual(btn.textContent, 'Reconnecting…');
  assert.strictEqual(btn.disabled, true);
});

test('connectionBtn click: disconnects while connected, and does reconnect or new connection as needed', async (t) => {
  const { window, context } = await bootLive();
  const ble = makeFakeBle(context);
  window.navigator.bluetooth = ble.bluetooth;
  const btn = window.document.getElementById('connectionBtn');

  // Connect first
  await run(context, 'attemptConnect()');
  stopLoopAfter(t, context);
  assert.strictEqual(run(context, 'LiveState.status'), 'connected');
  assert.strictEqual(btn.textContent, 'Disconnect');

  // Click single button while connected -> disconnects
  btn.click();
  assert.strictEqual(run(context, 'LiveState.status'), 'disconnected');
  assert.strictEqual(btn.textContent, 'Reconnect');

  // Click single button while disconnected -> calls manualReconnect() and resumes
  btn.click();
  await settle(() => run(context, 'LiveState.status') === 'connected');
  assert.strictEqual(run(context, 'LiveState.status'), 'connected');
});

test('connectionBtn click: flips to "New Connection" when manual reconnect fails, and next click triggers fresh connect', async (t) => {
  const { window, context } = await bootLive();
  const bleA = makeFakeBle(context, { reconnectFailures: 99 });
  window.navigator.bluetooth = bleA.bluetooth;
  const btn = window.document.getElementById('connectionBtn');

  // Initial connect to device A
  await run(context, 'attemptConnect()');
  stopLoopAfter(t, context);
  assert.strictEqual(btn.textContent, 'Disconnect');

  // Disconnect device A
  btn.click();
  assert.strictEqual(run(context, 'LiveState.status'), 'disconnected');
  assert.strictEqual(btn.textContent, 'Reconnect');

  // Click "Reconnect" -> manual reconnect fails because device A fails
  btn.click();
  await settle(
    () =>
      run(context, 'LiveState.status') === 'disconnected' &&
      btn.textContent === 'New Connection',
  );

  assert.strictEqual(
    btn.textContent,
    'New Connection',
    'flips to New Connection on reconnect failure',
  );
  assert.match(
    window.document.getElementById('reconnectErr').textContent,
    /Reconnect failed/,
  );

  // Now a new working device B is available
  const bleB = makeFakeBle(context);
  window.navigator.bluetooth = bleB.bluetooth;

  // Next click triggers attemptConnect() for a new connection
  btn.click();
  await settle(() => run(context, 'LiveState.status') === 'connected');
  assert.strictEqual(run(context, 'LiveState.status'), 'connected');
  assert.strictEqual(btn.textContent, 'Disconnect');
});

test('abandon(): immediately aborts in-flight _waitBeforeRetry backoff without waiting or calling _subscribe', async (t) => {
  const { window, context } = await bootLive();
  const bleA = makeFakeBle(context);
  window.navigator.bluetooth = bleA.bluetooth;
  await run(context, 'attemptConnect()');
  stopLoopAfter(t, context);

  // Device drops — _handleDisconnect starts waiting in _waitBeforeRetry(500)
  const loopPromise = run(context, 'bleManager._handleDisconnect()');
  await settle(() => run(context, 'LiveState.status') === 'reconnecting');
  assert.strictEqual(
    bleA.subscribeCallCount(),
    1,
    'only initial connect so far',
  );

  // Abandon mid-wait
  const startTime = Date.now();
  run(context, 'bleManager.abandon()');
  await loopPromise;
  const elapsed = Date.now() - startTime;

  assert.ok(
    elapsed < 200,
    `abandon resolved wait immediately (${elapsed}ms) rather than waiting out delay`,
  );
  assert.strictEqual(
    bleA.subscribeCallCount(),
    1,
    'abandoned manager did not start a fresh _subscribe attempt',
  );
});

// ==========================================================================
// Live-tracking zoom level and delayed phasic recoloring of the track.
// ==========================================================================

test('updateLiveMap: the first GPS fix zooms to LIVE_ZOOM (18), replacing the old fixed 17', async () => {
  const { context } = await bootLive();
  run(context, 'showMap()');
  run(
    context,
    'updateLiveMap({ valid: true, lat: 51.5, lon: -0.12, gsrRaw: 1000, hdop: 1.0, fixType: 3, sats: 8, gap: false })',
  );

  assert.strictEqual(run(context, 'LIVE_ZOOM'), 18);
  assert.strictEqual(run(context, 'liveMap.getZoom()'), 18);
});

test('flushSettledSegments: holds a segment back until its packet is BOTH metric-annotated AND old enough, then draws it once with the settled colour', async () => {
  const { context } = await bootLive();
  // The active metric defaults to 'signal' (raw, no settling needed at all)
  // — switch to 'phasic' so flushSettledSegments() actually queues/settles.
  run(context, "liveGsrView.graphView = 'phasic';");
  run(context, 'showMap();');
  run(
    context,
    `
    LiveState.packets = [{ timestamp: 0 }];
    const __pktA = { timestamp: 0 }; // no .phasic yet
    pendingSegments.push({ prevLatLng: [0, 0], latlng: [1, 1], pkt: __pktA });
  `,
  );

  // Recent (delta < PHASIC_COLOR_LAG_S) and no phasic yet — held back.
  run(
    context,
    'LiveState.packets = [{ timestamp: 0 }, { timestamp: 3 }]; flushSettledSegments();',
  );
  assert.strictEqual(run(context, 'pendingSegments.length'), 1);
  assert.strictEqual(
    run(context, 'liveMap._layers.filter(l => l.latlngs).length'),
    0,
    'nothing drawn yet',
  );

  // Old enough (delta 20 >= 8), still no phasic — held back (the
  // availability check isn't skipped once time alone would allow it through).
  run(
    context,
    'LiveState.packets = [{ timestamp: 0 }, { timestamp: 20 }]; flushSettledSegments();',
  );
  assert.strictEqual(run(context, 'pendingSegments.length'), 1);
  assert.strictEqual(
    run(context, 'liveMap._layers.filter(l => l.latlngs).length'),
    0,
  );

  // Phasic available but too recent (delta 3 < 8) — still held back.
  run(
    context,
    '__pktA.phasic = 42; LiveState.packets = [{ timestamp: 0 }, { timestamp: 3 }]; flushSettledSegments();',
  );
  assert.strictEqual(run(context, 'pendingSegments.length'), 1);

  // Phasic available AND old enough — drawn exactly once, queue drained.
  run(
    context,
    'LiveState.packets = [{ timestamp: 0 }, { timestamp: 20 }]; flushSettledSegments();',
  );
  assert.strictEqual(run(context, 'pendingSegments.length'), 0);
  assert.strictEqual(run(context, 'phasicMax'), 42);
  const segs = runJSON(
    context,
    'liveMap._layers.filter(l => l.latlngs).map(l => l.latlngs)',
  );
  assert.deepStrictEqual(segs, [
    [
      [0, 0],
      [1, 1],
    ],
  ]);
  // getColorForValue(42, 0, 42): ratio 1.0 -> hue 0 -> red end of the scale.
  assert.strictEqual(
    run(context, 'liveMap._layers.find(l => l.latlngs).options.color'),
    'hsl(0, 90%, 50%)',
  );
});

test("resetSession: clears pendingSegments, allTrackSegments and phasicMax, so a stale entry from a prior session (whose pkt.phasic will never be set again) can never wedge the next session's flush queue", async () => {
  const { context } = await bootLive();
  run(
    context,
    `
    pendingSegments.push({ prevLatLng: [0, 0], latlng: [1, 1], pkt: { timestamp: 0 } });
    allTrackSegments.push({ pkt: { timestamp: 0 }, line: L.polyline([[0, 0], [0, 0]], {}) });
    phasicMax = 99;
  `,
  );

  run(context, 'resetSession()');

  assert.strictEqual(run(context, 'pendingSegments.length'), 0);
  assert.strictEqual(run(context, 'allTrackSegments.length'), 0);
  assert.strictEqual(run(context, 'phasicMax'), 0);
});

test('resetSession: removes all track polyline layers and liveMarker from liveMap', async () => {
  const { context } = await bootLive();
  run(context, 'showMap()');
  run(
    context,
    `
    updateLiveMap({ valid: true, lat: 51.0, lon: 0.0, gsrRaw: 1000, hdop: 1.0, fixType: 3, sats: 8, gap: false });
    updateLiveMap({ valid: true, lat: 51.1, lon: 0.1, gsrRaw: 1200, hdop: 1.0, fixType: 3, sats: 8, gap: false });
  `,
  );
  // 1 TileLayer + 1 segment Polyline + 1 CircleMarker = 3 layers on liveMap
  assert.strictEqual(run(context, 'liveMap._layers.length'), 3);
  assert.ok(run(context, 'liveMarker !== null'));

  run(context, 'resetSession()');

  // Only the base TileLayer remains; polyline and marker were removed cleanly
  assert.strictEqual(run(context, 'liveMap._layers.length'), 1);
  assert.strictEqual(run(context, 'liveMarker'), null);
});

test('end-to-end: a walking session draws only settled trail segments; the recent tail stays pending until it settles', async () => {
  const { context } = await bootLive();
  // The active metric defaults to 'signal' — switch to 'phasic' so this
  // exercises the deferred-draw path the test is about.
  run(context, "liveGsrView.graphView = 'phasic';");
  // 50 packets at the real STREAM_INTERVAL_S cadence (0.3s), stepping GSR up
  // partway through so decomposeTonicPhasic has a real, non-trivial phasic
  // response to compute — not just feeding a flat, uninformative signal.
  run(
    context,
    `
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
  `,
  );

  const result = JSON.parse(
    run(
      context,
      `
    JSON.stringify({
      drawnSegments: liveMap._layers.filter(l => l.latlngs).length,
      pendingCount: pendingSegments.length,
      allFinalColoured: liveMap._layers.filter(l => l.latlngs).every(l => typeof l.options.color === 'string'),
      oldestPendingAge: pendingSegments.length > 0
        ? LiveState.packets[LiveState.packets.length - 1].timestamp - pendingSegments[0].pkt.timestamp
        : null,
    })
  `,
    ),
  );

  assert.strictEqual(
    result.drawnSegments + result.pendingCount,
    49,
    '50 packets -> 49 segment slots, split between drawn and still-pending',
  );
  assert.ok(result.drawnSegments > 0, 'settled segments are drawn');
  assert.ok(
    result.pendingCount > 0,
    'the most recent segments are still held back',
  );
  assert.ok(
    result.allFinalColoured,
    'every drawn segment was drawn once with its final colour (never repainted)',
  );
  assert.ok(
    result.oldestPendingAge < 8,
    `the oldest still-pending segment should be within PHASIC_COLOR_LAG_S, got ${result.oldestPendingAge}`,
  );
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
  const { window, context } = await bootLive();
  const ble = makeFakeBle(context);
  window.navigator.bluetooth = ble.bluetooth;

  run(context, 'showMap()'); // updateLiveMap() only draws once liveMap exists
  await run(context, 'attemptConnect()');
  stopLoopAfter(t, context);

  assert.strictEqual(run(context, 'LiveState.status'), 'connected');
  assert.ok(
    window.document
      .getElementById('connectOverlay')
      .classList.contains('hidden'),
    'a successful connect hides the connect overlay',
  );
  assert.strictEqual(
    ble.notificationHandlerCount(),
    1,
    '_subscribe() should register exactly one characteristicvaluechanged listener',
  );

  // First fix: sets the map view and drops the position marker, no segment yet.
  ble.fireNotification(
    buildPacket({
      timestampMs: 300,
      lat: 51.5074,
      lon: -0.1278,
      gsrRaw: 1000,
      sats: 9,
      fixType: 3,
    }),
  );

  assert.strictEqual(run(context, 'LiveState.packets.length'), 1);
  assert.strictEqual(
    window.document.getElementById('statPackets').textContent,
    'Packets: 1',
  );
  assert.strictEqual(
    window.document.getElementById('statGps').textContent,
    'GPS: 3D (9 sat)',
  );
  assert.strictEqual(
    window.document.getElementById('exportBtn').disabled,
    false,
  );
  assert.strictEqual(
    run(context, 'liveMap.getZoom()'),
    18,
    'first fix zooms to LIVE_ZOOM',
  );
  assert.strictEqual(
    run(
      context,
      'liveMap._layers.filter(l => l.options && l.options.radius).length',
    ),
    1,
    'first fix creates the position marker',
  );

  // Second fix a cadence-step later, new position, no gap -> one track segment.
  ble.fireNotification(
    buildPacket({
      timestampMs: 600,
      lat: 51.5076,
      lon: -0.1276,
      gsrRaw: 1200,
      sats: 9,
      fixType: 3,
    }),
  );

  assert.strictEqual(run(context, 'LiveState.packets.length'), 2);
  assert.strictEqual(run(context, 'LiveState.gapCount'), 0);
  assert.strictEqual(
    run(context, 'liveMap._layers.filter(l => l.latlngs).length'),
    1,
    'the second consecutive fix draws exactly one polyline segment',
  );
  assert.strictEqual(
    run(context, 'liveMap._layers.find(l => l.latlngs).options.weight'),
    3,
    'desktop live follow-map polyline uses default weight 3',
  );

  run(context, "drawGraph(); LiveState.setStatus('disconnected')"); // render once, then stop the RAF loop
  // Readout is in µS (raw nS ÷ 1000), matching the single-track view.
  assert.match(
    window.document.getElementById('graphValue').textContent,
    /-?\d+\.\d{2} μS$/,
  );
});

test('updateLiveMap: mobile live layout draws map trace twice as thick (weight 6)', async (t) => {
  const { window, context } = await bootLive({ compact: true });
  const ble = makeFakeBle(context);
  window.navigator.bluetooth = ble.bluetooth;

  await run(context, 'attemptConnect()');
  stopLoopAfter(t, context);

  ble.fireNotification(
    buildPacket({
      timestampMs: 300,
      lat: 51.5074,
      lon: -0.1278,
      gsrRaw: 1000,
      sats: 8,
      fixType: 3,
    }),
  );
  ble.fireNotification(
    buildPacket({
      timestampMs: 600,
      lat: 51.5076,
      lon: -0.1276,
      gsrRaw: 1200,
      sats: 9,
      fixType: 3,
    }),
  );

  const polyline = run(context, 'liveMap._layers.find(l => l.latlngs)');
  assert.ok(polyline, 'polyline created');
  assert.strictEqual(
    polyline.options.weight,
    6,
    'mobile trace is drawn twice as thick (weight 6)',
  );
  run(context, "LiveState.setStatus('disconnected')");
});

test('attemptConnect: an invalid (no-fix) notification still counts as a packet and updates stats, but draws nothing on the map', async (t) => {
  const { window, context } = await bootLive();
  const ble = makeFakeBle(context);
  window.navigator.bluetooth = ble.bluetooth;

  run(context, 'showMap()');
  await run(context, 'attemptConnect()');
  stopLoopAfter(t, context);

  ble.fireNotification(
    buildPacket({
      timestampMs: 300,
      gsrRaw: 800,
      sats: 0,
      fixType: 1,
      valid: 0,
    }),
  );

  assert.strictEqual(run(context, 'LiveState.packets.length'), 1);
  assert.strictEqual(
    window.document.getElementById('statGps').textContent,
    'GPS: No fix',
  );
  assert.strictEqual(
    run(
      context,
      'liveMap._layers.filter(l => (l.options && l.options.radius) || l.latlngs).length',
    ),
    0,
    'a no-fix sample must not place a marker or a segment',
  );

  run(context, "LiveState.setStatus('disconnected')");
});

test('attemptConnect: a service-UUID mismatch fails the connect and surfaces the discovered UUIDs, without marking the session connected', async () => {
  const { window, context } = await bootLive();
  const ble = makeFakeBle(context, { missingService: true });
  window.navigator.bluetooth = ble.bluetooth;

  await run(context, 'attemptConnect()');

  assert.strictEqual(run(context, 'LiveState.status'), 'disconnected');
  assert.ok(
    !window.document
      .getElementById('connectOverlay')
      .classList.contains('hidden'),
    'a failed connect leaves the connect overlay up',
  );
  assert.strictEqual(
    ble.notificationHandlerCount(),
    0,
    'no characteristic was ever subscribed',
  );
  // _logDiscoveredServices() routes the discovery hint through onStatusText,
  // which attemptConnect() mirrors into reconnectErr (connectErr is then
  // overwritten by the thrown error's own message in the catch).
  assert.match(
    window.document.getElementById('reconnectErr').textContent,
    /Service UUID mismatch/,
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
  for (let i = 0; i < tries && !pred(); i++)
    await new Promise((r) => setImmediate(r));
}

// Every test here reaches 'connected'/'reconnecting', which starts live.html's
// requestAnimationFrame loop (jsdom's rAF is a non-unref'd timer) — a failing
// assertion that skips the explicit reset would hang `npm test`. t.after()
// runs regardless, so the loop always stops.
function stopLoopAfter(t, _context) {
  t.after(() => {
    try {
      vm.runInThisContext("LiveState.setStatus('disconnected')");
    } catch {
      /* torn down */
    }
  });
}

test('_handleDisconnect: retries then recovers — status ends "connected", loop stops early on the first successful re-subscribe', async (t) => {
  const { window, context } = await bootLive();
  const ble = makeFakeBle(context, { reconnectFailures: 2 }); // 2 fail, 3rd succeeds
  window.navigator.bluetooth = ble.bluetooth;
  await run(context, 'attemptConnect()');
  stopLoopAfter(t, context);

  const timers = recordingTimers(window);
  await run(context, 'bleManager._handleDisconnect()');
  timers.restore();

  assert.strictEqual(run(context, 'LiveState.status'), 'connected');
  assert.strictEqual(
    run(context, 'bleManager._reconnecting'),
    false,
    'the guard flag must be cleared on success',
  );
  // 1 initial connect + 3 reconnect attempts (fail, fail, succeed).
  assert.strictEqual(ble.subscribeCallCount(), 4);
  // Backoff waited before attempts 1..3 only — no wait after the success.
  // Each _subscribe() also arms (and, since the fake connect() resolves
  // immediately, promptly clears) a BLE_SUBSCRIBE_TIMEOUT_MS watchdog timer —
  // filter those out to isolate the backoff schedule itself.
  const gattTimeout = run(context, 'BLE_SUBSCRIBE_TIMEOUT_MS');
  assert.deepStrictEqual(
    timers.delays.filter((d) => d !== gattTimeout),
    [500, 1000, 2000],
  );
});

test('_handleDisconnect: gives up after exactly 6 attempts, drops to "disconnected", and surfaces the last error via onStatusText', async (t) => {
  const { window, context } = await bootLive();
  const ble = makeFakeBle(context, { reconnectFailures: 99 }); // every reconnect fails
  window.navigator.bluetooth = ble.bluetooth;
  await run(context, 'attemptConnect()');
  stopLoopAfter(t, context);

  run(
    context,
    'globalThis.__statusSeen = []; LiveState.on("status", (s) => globalThis.__statusSeen.push(s))',
  );

  const timers = recordingTimers(window);
  await run(context, 'bleManager._handleDisconnect()');
  timers.restore();

  assert.strictEqual(run(context, 'LiveState.status'), 'disconnected');
  assert.strictEqual(run(context, 'bleManager._reconnecting'), false);
  assert.strictEqual(
    ble.subscribeCallCount(),
    1 + 6,
    'exactly 6 reconnect attempts, then it stops',
  );
  // The cap: 500, 1000, 2000, 4000, then clamped at 8000 — filtering out the
  // per-attempt BLE_SUBSCRIBE_TIMEOUT_MS watchdog timers (see the test above).
  const gattTimeout = run(context, 'BLE_SUBSCRIBE_TIMEOUT_MS');
  assert.deepStrictEqual(
    timers.delays.filter((d) => d !== gattTimeout),
    [500, 1000, 2000, 4000, 8000, 8000],
  );

  const seen = runJSON(context, 'globalThis.__statusSeen');
  assert.deepStrictEqual(
    seen,
    ['reconnecting', 'disconnected'],
    'one reconnecting, then one disconnected — no flicker',
  );
  assert.match(
    window.document.getElementById('reconnectErr').textContent,
    /Auto-reconnect failed: reconnect attempt 6 failed/,
  );
});

// ==========================================================================
// Reconnect resilience — three feature-detected layers added on top of the
// bounded backoff above: an early wake on 'advertisementreceived' during
// each backoff wait, a passive post-exhaustion watch that auto-recovers
// without the user clicking Reconnect, and (further below, alongside the
// "New Connection" tests) a silent same-device resume via getDevices() that
// skips the requestDevice() chooser. Each degrades to today's plain-timer
// behaviour where the underlying API is unsupported — see the last test in
// this block.
// ==========================================================================

test('_waitBeforeRetry: wakes early on advertisementreceived instead of waiting out the full delay', async (t) => {
  const { window, context } = await bootLive();
  const ble = makeFakeBle(context);
  window.navigator.bluetooth = ble.bluetooth;
  await run(context, 'attemptConnect()');
  stopLoopAfter(t, context);

  const start = Date.now();
  // A delay long enough that "it returned quickly" is unambiguous — this
  // test uses the real clock (not recordingTimers) specifically so an early
  // wake and "the timer just fired" are distinguishable.
  const waitPromise = run(context, 'bleManager._waitBeforeRetry(5000)');
  await new Promise((r) => setImmediate(r)); // let the listener attach
  assert.strictEqual(
    ble.advertisementHandlerCount(),
    1,
    'a listener was armed for this wait',
  );
  assert.strictEqual(ble.watchAdvertisementsCallCount(), 1);

  ble.fireAdvertisement();
  await waitPromise;
  const elapsed = Date.now() - start;

  assert.ok(
    elapsed < 1000,
    `expected an early wake well under the 5000ms delay, took ${elapsed}ms`,
  );
  assert.strictEqual(
    ble.advertisementHandlerCount(),
    0,
    'the listener is cleaned up once the wait resolves',
  );
});

test('background watch: after auto-reconnect exhausts, the device reappearing later triggers an automatic reconnect with no user action', async (t) => {
  const { window, context } = await bootLive();
  // Exactly enough failures to exhaust the bounded loop (subscribeCalls
  // 2..7, matching its 6 attempts) — the 8th call, made by the background
  // watch's own reconnect attempt, then succeeds.
  const ble = makeFakeBle(context, { reconnectFailures: 6 });
  window.navigator.bluetooth = ble.bluetooth;
  await run(context, 'attemptConnect()');
  stopLoopAfter(t, context);

  const timers = recordingTimers(window);
  await run(context, 'bleManager._handleDisconnect()');
  timers.restore();
  assert.strictEqual(run(context, 'LiveState.status'), 'disconnected');
  assert.strictEqual(
    ble.advertisementHandlerCount(),
    1,
    'a passive background watch is armed after giving up',
  );

  run(
    context,
    'globalThis.__statusSeen = []; LiveState.on("status", (s) => globalThis.__statusSeen.push(s))',
  );
  ble.fireAdvertisement();
  await settle(() => run(context, 'LiveState.status') === 'connected');

  assert.strictEqual(
    run(context, 'LiveState.status'),
    'connected',
    'the device reappearing reconnected automatically',
  );
  assert.strictEqual(
    ble.advertisementHandlerCount(),
    0,
    'the watch is retired on success',
  );
  assert.deepStrictEqual(runJSON(context, 'globalThis.__statusSeen'), [
    'reconnecting',
    'connected',
  ]);
});

test('background watch: re-arms itself if the triggered reconnect attempt fails, instead of giving up for good', async (t) => {
  const { window, context } = await bootLive();
  const ble = makeFakeBle(context, { reconnectFailures: 99 }); // every attempt fails, including the background one
  window.navigator.bluetooth = ble.bluetooth;
  await run(context, 'attemptConnect()');
  stopLoopAfter(t, context);

  const timers = recordingTimers(window);
  await run(context, 'bleManager._handleDisconnect()');
  timers.restore();
  assert.strictEqual(ble.advertisementHandlerCount(), 1);

  ble.fireAdvertisement();
  await settle(
    () => ble.subscribeCallCount() > 7 && ble.advertisementHandlerCount() === 1,
  );

  assert.strictEqual(
    run(context, 'LiveState.status'),
    'disconnected',
    'the background attempt itself failed, as arranged',
  );
  assert.strictEqual(
    ble.advertisementHandlerCount(),
    1,
    'the watch was re-armed rather than abandoned after one failed attempt',
  );
});

test('background watch: a subsequent intentional disconnect (deactivate) stops it — the user leaving the view must not still auto-reconnect', async (t) => {
  const { window, context } = await bootLive();
  const ble = makeFakeBle(context, { reconnectFailures: 99 });
  window.navigator.bluetooth = ble.bluetooth;
  run(context, 'showMap()');
  await run(context, 'attemptConnect()');
  stopLoopAfter(t, context);

  const timers = recordingTimers(window);
  await run(context, 'bleManager._handleDisconnect()');
  timers.restore();
  assert.strictEqual(ble.advertisementHandlerCount(), 1);

  run(context, 'GSRLiveView.deactivate()');
  assert.strictEqual(
    ble.advertisementHandlerCount(),
    0,
    'deactivate() tears down the passive watch too',
  );

  ble.fireAdvertisement(); // must be a no-op now — nothing is listening
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(
    run(context, 'LiveState.status'),
    'disconnected',
    'no auto-reconnect after the user left the view',
  );
});

test('reconnect resilience degrades gracefully when watchAdvertisements is unsupported (e.g. iOS/Bluefy) — same bounded backoff as before, no background watch', async (t) => {
  const { window, context } = await bootLive();
  const ble = makeFakeBle(context, {
    reconnectFailures: 99,
    watchAdvertisements: 'no',
  });
  window.navigator.bluetooth = ble.bluetooth;
  await run(context, 'attemptConnect()');
  stopLoopAfter(t, context);

  const timers = recordingTimers(window);
  await run(context, 'bleManager._handleDisconnect()');
  timers.restore();

  assert.strictEqual(run(context, 'LiveState.status'), 'disconnected');
  const gattTimeout = run(context, 'BLE_SUBSCRIBE_TIMEOUT_MS');
  assert.deepStrictEqual(
    timers.delays.filter((d) => d !== gattTimeout),
    [500, 1000, 2000, 4000, 8000, 8000],
    'identical plain backoff schedule to a platform with watchAdvertisements — this layer is pure addition, not a behaviour change',
  );
  assert.strictEqual(
    ble.advertisementHandlerCount(),
    0,
    'no background watch armed without watchAdvertisements support',
  );
});

test('_handleDisconnect: a second gattserverdisconnected while a reconnect loop is already running is a no-op (the _reconnecting guard)', async (t) => {
  const { window, context } = await bootLive();
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
  assert.strictEqual(
    ble.subscribeCallCount(),
    2,
    'the first reconnect attempt is in flight',
  );

  // Re-entrant call — must bail immediately on the guard, starting nothing.
  await run(context, 'bleManager._handleDisconnect()');
  assert.strictEqual(
    ble.subscribeCallCount(),
    2,
    'the second call started no new attempt',
  );

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
  const { window, context } = await bootLive();
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
    ble.notificationHandlerCount(),
    1,
    'the reconnect re-subscribes with exactly one listener, not a stack of them',
  );

  ble.fireNotification(
    buildPacket({ timestampMs: 900, gsrRaw: 1111, sats: 8, fixType: 3 }),
  );

  assert.strictEqual(
    run(context, 'LiveState.packets.length'),
    1,
    'a re-subscribe must not leave a stale listener that double-parses every notification',
  );
  assert.strictEqual(
    run(context, 'LiveState.gapCount'),
    0,
    'the duplicate is not a real gap',
  );
});

// Regression tests for the reported "reconnect just hangs" bug:
// BluetoothRemoteGATTServer.connect() / getPrimaryService() /
// getCharacteristic() / startNotifications() have no built-in timeout and
// have been observed on real devices to never settle when the peripheral
// isn't actually reachable or its GATT cache is stale (e.g. right after the
// Flipper's BLE co-processor restart). Without a cap, one hung step blocked
// the whole retry loop forever instead of surfacing "disconnected" + a
// working New Connection. Two variants below: the hang can happen at the
// initial connect, or later during service/characteristic discovery — both
// must be bounded, since _subscribe() now wraps the whole pipeline in one
// timeout rather than just the connect step.
test('_subscribe: a hung gatt.connect() times out instead of blocking the caller forever, and cancels the pending native connect', async (t) => {
  const { window, context } = await bootLive();
  const ble = makeFakeBle(context);
  window.navigator.bluetooth = ble.bluetooth;
  await run(context, 'attemptConnect()');
  stopLoopAfter(t, context);
  assert.strictEqual(ble.gattDisconnectCallCount(), 0);

  // Simulate the real-world hang: gatt.connect() never resolves or rejects.
  run(context, 'bleManager.device.gatt.connect = () => new Promise(() => {})');

  const timers = recordingTimers(window);
  let threw = false;
  try {
    await run(context, 'bleManager._subscribe()');
  } catch (_e) {
    threw = true;
  }
  timers.restore();

  assert.strictEqual(
    threw,
    true,
    'a hung connect() must eventually reject rather than hang the caller forever',
  );
  const timeoutMs = run(context, 'BLE_SUBSCRIBE_TIMEOUT_MS');
  assert.deepStrictEqual(
    timers.delays,
    [timeoutMs],
    'bounded by exactly one BLE_SUBSCRIBE_TIMEOUT_MS watchdog',
  );
  assert.strictEqual(
    ble.gattDisconnectCallCount(),
    1,
    'the pending native connect was cancelled so the adapter/peripheral is freed for the next attempt',
  );
});

test('_subscribe: a hung getPrimaryService() (connect succeeds, discovery never settles) is bounded too, not just the initial connect', async (t) => {
  const { window, context } = await bootLive();
  const ble = makeFakeBle(context);
  window.navigator.bluetooth = ble.bluetooth;
  await run(context, 'attemptConnect()');
  stopLoopAfter(t, context);
  assert.strictEqual(ble.gattDisconnectCallCount(), 0);

  // gatt.connect() itself resolves fine; it's service discovery on the
  // resulting server that never settles — a distinct real-world hang point
  // from the connect-itself-hangs case above.
  run(
    context,
    `
    bleManager.device.gatt.connect = async () => ({
      getPrimaryService: () => new Promise(() => {}),
      getPrimaryServices: () => new Promise(() => {}),
    });
  `,
  );

  const timers = recordingTimers(window);
  let threw = false;
  try {
    await run(context, 'bleManager._subscribe()');
  } catch (_e) {
    threw = true;
  }
  timers.restore();

  assert.strictEqual(
    threw,
    true,
    'a hung getPrimaryService() must eventually reject rather than hang the caller forever',
  );
  const timeoutMs = run(context, 'BLE_SUBSCRIBE_TIMEOUT_MS');
  assert.deepStrictEqual(timers.delays, [timeoutMs]);
  assert.strictEqual(
    ble.gattDisconnectCallCount(),
    1,
    'the GATT link was torn down to cancel the stuck discovery call',
  );
});

// The other half of the same bug: a stuck connect attempt left the radio
// wedged even when the user backed out via "New Connection" or navigating
// away, because disconnect() only cancelled the link when gatt.connected was
// already true — a connect() still in flight hasn't set that flag yet.
test('disconnect: cancels the GATT link even while "connected" is still false (a pending connect attempt)', async (t) => {
  const { window, context } = await bootLive();
  const ble = makeFakeBle(context);
  window.navigator.bluetooth = ble.bluetooth;
  await run(context, 'attemptConnect()');
  stopLoopAfter(t, context);
  assert.strictEqual(ble.gattDisconnectCallCount(), 0);

  run(context, 'bleManager.device.gatt.connected = false'); // pending connect, not yet established

  run(context, 'bleManager.disconnect()');

  assert.strictEqual(
    ble.gattDisconnectCallCount(),
    1,
    'disconnect() must not skip cancelling just because "connected" is still false',
  );
});

// SCENARIO — "New Connection" clicked while the PREVIOUS manager's own
// auto-reconnect loop is still in flight (mid-backoff wait, or blocked
// inside its own _subscribe() timeout race). LiveState.setStatus() is a
// module-level singleton shared by every manager instance, so without
// abandon() marking the old
// one superseded, its loop finishing later — success or exhaustion alike —
// would silently overwrite whatever the brand new connection already set:
// the UI would flip back to "Disconnected" (or, in the success race, briefly
// paper over an actually-failed new connection with a stale "Live") even
// though the new link the user is actually looking at is fine. Confirmed
// this was a real, reproducible bug before abandon() existed — this test
// pins the fixed behavior.
test('attemptConnect ("New Connection"): a stale reconnect loop from a superseded manager must not clobber the new connection\'s status', async (t) => {
  const { window, context } = await bootLive();
  const bleA = makeFakeBle(context, { reconnectFailures: 99 }); // A never recovers on its own
  window.navigator.bluetooth = bleA.bluetooth;
  await run(context, 'attemptConnect()');
  stopLoopAfter(t, context);
  assert.strictEqual(run(context, 'LiveState.status'), 'connected');
  run(context, 'globalThis.__managerA = bleManager');

  const timers = recordingTimers(window);
  // A real link drop on device A — starts A's bounded auto-reconnect loop.
  // Deliberately not awaited: this is exactly how the real
  // 'gattserverdisconnected' listener fires it (fire-and-forget).
  run(context, 'globalThis.__loopA = bleManager._handleDisconnect()');
  await settle(() => run(context, 'LiveState.status') === 'reconnecting');

  // The user gives up on the lightweight Reconnect and does "New Connection"
  // to a working device while A's loop is still mid-backoff in the background.
  const bleB = makeFakeBle(context);
  window.navigator.bluetooth = bleB.bluetooth;
  await run(context, 'attemptConnect()');
  assert.strictEqual(
    run(context, 'LiveState.status'),
    'connected',
    'the fresh connection is live',
  );
  assert.strictEqual(
    run(context, 'globalThis.__managerA._abandoned'),
    true,
    'the old manager was marked superseded',
  );
  assert.strictEqual(
    run(context, 'bleManager === globalThis.__managerA'),
    false,
    'a new manager instance took over',
  );

  // Let A's orphaned loop run to exhaustion.
  await run(context, 'globalThis.__loopA');
  timers.restore();

  assert.strictEqual(
    run(context, 'LiveState.status'),
    'connected',
    "the superseded manager's own eventual give-up must not overwrite the live status of the new connection",
  );
});

// Same hazard, the other direction: A's already-in-flight _subscribe() call
// (started before abandon() ran) happens to succeed AFTER B has taken over
// and B has itself already failed — A reporting "connected" must not paper
// over B's real "disconnected" state. The loop-top _abandoned check (added
// alongside abandon()) stops A from STARTING further attempts once
// superseded, but this covers the narrower case of an attempt already
// committed to when abandonment happens mid-flight.
test('attemptConnect ("New Connection"): a superseded manager\'s already-in-flight reconnect succeeding must not resurrect its status either', async (t) => {
  const { window, context } = await bootLive();
  const bleA = makeFakeBle(context); // A's reconnect attempt will succeed once unblocked
  window.navigator.bluetooth = bleA.bluetooth;
  await run(context, 'attemptConnect()');
  stopLoopAfter(t, context);
  run(context, 'globalThis.__managerA = bleManager');

  const timers = recordingTimers(window);
  const releaseA = bleA.blockNextSubscribe(); // hold A's reconnect mid-attempt, already committed to it
  run(context, 'globalThis.__loopA = bleManager._handleDisconnect()');
  await settle(() => bleA.subscribeCallCount() === 2);

  // "New Connection" supersedes A while its attempt is blocked, then B itself fails.
  const bleB = makeFakeBle(context, { failRequestDevice: true });
  window.navigator.bluetooth = bleB.bluetooth;
  await run(context, 'attemptConnect()');
  assert.strictEqual(
    run(context, 'LiveState.status'),
    'disconnected',
    'B failed to connect at all',
  );

  // Now let A's already-in-flight attempt through — it succeeds, on a
  // manager nobody is looking at anymore.
  releaseA();
  await run(context, 'globalThis.__loopA');
  timers.restore();

  assert.strictEqual(
    run(context, 'LiveState.status'),
    'disconnected',
    'A\'s late success must not resurrect a "connected" status over B\'s real failure',
  );
});

// tryResumeDevice() — the third resilience layer: "New Connection" tries a
// silent same-device resume via navigator.bluetooth.getDevices() before
// falling back to the requestDevice() chooser. This is the direct fix for
// "I click New Connection and don't even see the device in the list" —
// when the platform still remembers the permission grant, there's no list
// to fail to show it in.
test('tryResumeDevice: "New Connection" silently reacquires the same previously-permitted device, skipping the chooser', async (t) => {
  const { window, context } = await bootLive();
  const ble = makeFakeBle(context); // getDevices() defaults to resolving [device] — "platform remembers it"
  window.navigator.bluetooth = ble.bluetooth;
  await run(context, 'attemptConnect()');
  stopLoopAfter(t, context);
  assert.strictEqual(run(context, 'LiveState.status'), 'connected');

  let requestDeviceCalls = 0;
  const realRequestDevice = ble.bluetooth.requestDevice.bind(ble.bluetooth);
  ble.bluetooth.requestDevice = async (...args) => {
    requestDeviceCalls++;
    return realRequestDevice(...args);
  };

  // The user clicks "New Connection" -> Connect again.
  await run(context, 'attemptConnect()');

  assert.strictEqual(
    run(context, 'LiveState.status'),
    'connected',
    'reconnected via tryResumeDevice()',
  );
  assert.strictEqual(
    requestDeviceCalls,
    0,
    'the chooser (requestDevice()) was never invoked',
  );
  assert.strictEqual(
    ble.subscribeCallCount(),
    2,
    'one fresh _subscribe() for the resumed device, not a whole new pairing flow',
  );
});

test('tryResumeDevice: falls back to the normal requestDevice() chooser when getDevices() has no match', async (t) => {
  const { window, context } = await bootLive();
  const bleA = makeFakeBle(context);
  window.navigator.bluetooth = bleA.bluetooth;
  await run(context, 'attemptConnect()');
  stopLoopAfter(t, context);

  // "New Connection" to a DIFFERENT fake stack — its getDevices() has no
  // knowledge of A's device (different fake, different id).
  const bleB = makeFakeBle(context);
  window.navigator.bluetooth = bleB.bluetooth;
  await run(context, 'attemptConnect()');

  assert.strictEqual(
    run(context, 'LiveState.status'),
    'connected',
    'fell through to the chooser and connected to B',
  );
  assert.strictEqual(
    bleB.subscribeCallCount(),
    1,
    'a full fresh connect() (chooser) ran, not a resume',
  );
});

// SCENARIO — unlike the abandon() races above (a superseded manager racing a
// BRAND NEW one), tryResumeDevice() and connect()'s fallback run on the SAME
// manager instance: connect() only replaces bleManager itself, not the
// resume attempt already running inside it. If tryResumeDevice()'s own outer
// 3500ms timeout loses the race to its inner _subscribe() call's 15s one,
// that _subscribe() call keeps running in the background — against the same
// `this.device` the fallback connect() is about to reuse (getDevices()/a
// re-picked chooser selection commonly hand back the identical
// BluetoothDevice for the same physical peripheral). When its own timeout
// eventually fires, its catch used to unconditionally read `this.device` and
// call `.gatt.disconnect()` on it — silently killing the newer, already-
// working connection nobody asked to close, and marking the fallout
// "intentional" (suppressing the auto-reconnect a real drop should get).
test('tryResumeDevice: an orphaned resume attempt that later times out must not disconnect a newer successful connection on the same instance', async (t) => {
  const { window, context } = await bootLive();
  const ble = makeFakeBle(context); // getDevices() resolves [device] by default — a remembered device
  window.navigator.bluetooth = ble.bluetooth;
  await run(context, 'attemptConnect()'); // initial pairing — no previousDevice, no tryResumeDevice() involved
  stopLoopAfter(t, context);
  assert.strictEqual(run(context, 'LiveState.status'), 'connected');

  const timers = recordingTimers(window);

  // Capture the FIRST _subscribe() call's promise across the class (not the
  // current bleManager var — "New Connection" replaces it with a fresh
  // instance before tryResumeDevice() even runs) so the test can await the
  // orphaned attempt's own eventual settlement directly, rather than guess
  // how many ticks its background timer needs.
  run(
    context,
    `
    globalThis.__origSubscribe = GSRLiveBluetoothManager.prototype._subscribe;
    globalThis.__subscribeCalls = 0;
    GSRLiveBluetoothManager.prototype._subscribe = function () {
      globalThis.__subscribeCalls++;
      const p = globalThis.__origSubscribe.call(this);
      if (globalThis.__subscribeCalls === 1) globalThis.__orphanSubscribe = p.catch(() => {});
      return p;
    };
  `,
  );
  // Blocks the NEXT getCharacteristic() call indefinitely — the "New
  // Connection" click's tryResumeDevice() attempt below, which never gets
  // released, so only its own 15s internal timeout (accelerated by
  // recordingTimers) settles it.
  ble.blockNextSubscribe();

  // "New Connection", same remembered device: tryResumeDevice()'s 3500ms
  // outer timeout loses the race to the blocked inner call and returns
  // false, so connect() falls through to a fresh requestDevice() +
  // _subscribe() — which succeeds immediately (the gate only holds the
  // FIRST getCharacteristic() call).
  await run(context, 'attemptConnect()');
  assert.strictEqual(
    run(context, 'LiveState.status'),
    'connected',
    'the fresh fallback connection is live',
  );
  const disconnectsBeforeOrphanSettles = ble.gattDisconnectCallCount();

  // Let the orphaned resume attempt's own 15s timeout fire.
  await run(context, 'globalThis.__orphanSubscribe');
  run(
    context,
    'GSRLiveBluetoothManager.prototype._subscribe = globalThis.__origSubscribe',
  );

  assert.strictEqual(
    ble.gattDisconnectCallCount(),
    disconnectsBeforeOrphanSettles,
    'the orphaned resume attempt must not tear down the newer, live connection when it finally times out',
  );
  assert.strictEqual(
    run(context, 'LiveState.status'),
    'connected',
    'status must still reflect the real, live connection',
  );

  // And the manager must still be armed for a genuine future disconnect — the
  // orphaned attempt must not have left _intentionalClose stuck true, which
  // would silently swallow this real drop instead of auto-reconnecting.
  // Called directly (rather than via ble.fireDisconnect()) so the full retry
  // loop is awaited to completion here, under the still-accelerated timers,
  // instead of left running detached against real backoff delays.
  await run(context, 'bleManager._handleDisconnect()');
  timers.restore();

  assert.strictEqual(
    run(context, 'LiveState.status'),
    'connected',
    'a real subsequent drop must still auto-recover, not be swallowed as "intentional"',
  );
});

test('tryResumeDevice: falls back cleanly when navigator.bluetooth.getDevices is unsupported', async (t) => {
  const { window, context } = await bootLive();
  const ble = makeFakeBle(context, { getDevices: 'no' });
  window.navigator.bluetooth = ble.bluetooth;
  await run(context, 'attemptConnect()');
  stopLoopAfter(t, context);
  assert.strictEqual(run(context, 'LiveState.status'), 'connected');

  await run(context, 'attemptConnect()'); // "New Connection" again, same unsupported-getDevices stack

  assert.strictEqual(
    run(context, 'LiveState.status'),
    'connected',
    'still reconnects via the normal chooser flow',
  );
  assert.strictEqual(
    ble.subscribeCallCount(),
    2,
    'a second full connect() ran (no silent resume attempted)',
  );
});

// ==========================================================================
// exportCsv() — the "Export CSV" button. Must go through GSRFileSaver (the
// same OS "Save location" dialog the rest of the app uses) and hand it a file
// byte-compatible with a firmware-written track: the `# Integrity: crc32 v1`
// marker, biomap_format.c's per-row number formatting, and a `# End …`
// trailer with a real CRC32. buildLiveCsv() itself is covered in depth by
// test_live_csv.js — these pin the wiring.
// ==========================================================================

// Intercepts GSRFileSaver.saveFile(content, name) and records its arguments,
// so a test sees exactly the text/filename the Export button would save
// without jsdom needing showSaveFilePicker or a real <a download>.
function captureCsvExport(context) {
  vm.runInThisContext(
    'GSRFileSaver.saveFile = (content, name) => { globalThis.__savedCsv = { text: content, name }; return Promise.resolve(true); };',
  );
  return {
    get text() {
      return run(
        context,
        'globalThis.__savedCsv && globalThis.__savedCsv.text',
      );
    },
    get name() {
      return run(
        context,
        'globalThis.__savedCsv && globalThis.__savedCsv.name',
      );
    },
  };
}

test('exportCsv: hands GSRFileSaver a .csv name and the full buildLiveCsv text (integrity bracket included)', async () => {
  const { context } = await bootLive();
  const csv = captureCsvExport(context);
  run(context, 'Date.now = () => 1700000123456'); // -> epoch seconds 1700000123

  run(
    context,
    `
    LiveState.packets = [
      { timestamp: 0.30, valid: true,  lat: 51.5074, lon: -0.1278,
        hdop: 1.2, pdop: 1.8, sats: 9, fixType: 3, speedKts: 3.4, courseDeg: 270.0, gsrRaw: 1234.5 },
      { timestamp: 12.60, valid: false, lat: NaN, lon: NaN,
        hdop: 99.9, pdop: 99.9, sats: 0, fixType: 1, speedKts: 0, courseDeg: 0, gsrRaw: 800.0 },
    ];
  `,
  );

  run(context, 'exportCsv()');
  const lines = csv.text.split('\n');

  assert.match(csv.name, /^biomap_live_.*\.csv$/, 'saved with a .csv filename');
  // firmware/modules/sd_logger.c SD_LOGGER_INTEGRITY_LINE is the file's first line.
  assert.strictEqual(lines[0], '# Integrity: crc32 v1');
  assert.strictEqual(lines[1], '# RecordingStartTime:1700000111'); // 1700000123 - floor(12.60)
  assert.strictEqual(lines[2], '# DeviceName:LiveStream');
  assert.strictEqual(
    lines[3],
    'timestamp,lat,lon,hdop,pdop,sats,fix_type,speed_kts,course_deg,gsr_raw,hacc_m',
  );

  // Valid fix: biomap_format_gps_row() "%.2f,%.7f,%.7f,%.1f,%.1f,%d,%d,%.2f,%.1f,%.1f,%.1f"
  // — speed_kts is 2 dp; hacc_m (final field) is empty on the wire.
  assert.strictEqual(
    lines[4],
    '0.30,51.5074000,-0.1278000,1.2,1.8,9,3,3.40,270.0,1234.5,',
  );
  // No-fix sample: firmware's "%.2f,,,,,,,,,%.1f," branch — every GPS column
  // empty, only timestamp + gsr_raw carry a value.
  assert.strictEqual(lines[5], '12.60,,,,,,,,,800.0,');

  // Trailer last, with sd_logger_write_trailer()'s token layout (overflows /
  // flush_fails are a truthful 0 for a card-less live session).
  assert.match(
    csv.text,
    /\n# End rows:2 bytes:\d+ crc32:[0-9a-f]{8} end_time:1700000123 overflows:0 flush_fails:0\n$/,
  );
});

test("exportCsv: RecordingStartTime is wall-clock-now minus the last packet's device uptime, floored", async () => {
  const { context } = await bootLive();
  const csv = captureCsvExport(context);
  run(context, 'Date.now = () => 1_699_999_999_000'); // epoch seconds 1699999999
  run(
    context,
    'LiveState.packets = [{ timestamp: 100.9, valid: false, lat: NaN, lon: NaN, hdop: 99.9, pdop: 99.9, sats: 0, fixType: 0, speedKts: 0, courseDeg: 0, gsrRaw: 1 }]',
  );

  run(context, 'exportCsv()');

  // 1699999999 - floor(100.9) == 1699999899
  assert.match(
    csv.text,
    /^# Integrity: crc32 v1\n# RecordingStartTime:1699999899\n/,
  );
});

test('exportCsv: a session with no packets still produces a valid file (header + zero-row trailer)', async () => {
  const { context } = await bootLive();
  const csv = captureCsvExport(context);
  run(context, 'Date.now = () => 1700000000000');

  run(context, 'exportCsv()');

  assert.match(
    csv.text,
    /^# Integrity: crc32 v1\n# RecordingStartTime:1700000000\n# DeviceName:LiveStream\ntimestamp,lat,lon,hdop,pdop,sats,fix_type,speed_kts,course_deg,gsr_raw,hacc_m\n# End rows:0 bytes:\d+ crc32:[0-9a-f]{8} end_time:1700000000 overflows:0 flush_fails:0\n$/,
  );
});

// ==========================================================================
// updateLiveMap() — GPS quality gating (live.html:861). LIVE_MAX_HDOP is
// 2.0; the firmware applies no HDOP gate, so this filters purely at display
// time. fixType 1 (no fix) is rejected; a gap breaks the drawn trail without
// stopping tracking. Only "first fix zooms" was covered.
// ==========================================================================

const FIX = (over = {}) =>
  JSON.stringify({
    valid: true,
    lat: 51.5074,
    lon: -0.1278,
    gsrRaw: 1000,
    hdop: 1.0,
    pdop: 1.5,
    fixType: 3,
    sats: 9,
    gap: false,
    ...over,
  });
const segLatLngs = (context) =>
  runJSON(
    context,
    'liveMap._layers.filter(l => l.latlngs).map(l => l.latlngs)',
  );

test('updateLiveMap: a fix worse than LIVE_MAX_HDOP (2.0) is dropped — no segment, and it does not advance the trail anchor', async () => {
  const { context } = await bootLive();
  run(context, 'showMap()');

  run(context, `updateLiveMap(${FIX({ lat: 51.0, lon: 0.0 })})`); // 1st good fix: view + marker, no segment
  run(context, `updateLiveMap(${FIX({ lat: 52.0, lon: 1.0, hdop: 5.0 })})`); // rejected

  assert.strictEqual(
    segLatLngs(context).length,
    0,
    'the high-HDOP fix drew nothing',
  );
  assert.deepStrictEqual(
    runJSON(context, 'liveLastLatLng'),
    [51.0, 0.0],
    'trail anchor unmoved by the rejected fix',
  );

  run(context, `updateLiveMap(${FIX({ lat: 51.5, lon: 0.5 })})`); // next good fix
  const segs = segLatLngs(context);
  assert.strictEqual(segs.length, 1);
  assert.deepStrictEqual(
    segs[0],
    [
      [51.0, 0.0],
      [51.5, 0.5],
    ],
    'segment bridges the two GOOD fixes, skipping the rejected one',
  );
});

test('updateLiveMap: fixType gating — 1 (no fix) is rejected, 0 (unknown) and >=2 are accepted', async () => {
  const { context } = await bootLive();
  run(context, 'showMap()');

  run(context, `updateLiveMap(${FIX({ lat: 51.0, lon: 0.0, fixType: 3 })})`); // anchor
  run(context, `updateLiveMap(${FIX({ lat: 51.1, lon: 0.1, fixType: 1 })})`); // rejected
  assert.strictEqual(segLatLngs(context).length, 0);
  assert.deepStrictEqual(runJSON(context, 'liveLastLatLng'), [51.0, 0.0]);

  run(context, `updateLiveMap(${FIX({ lat: 51.2, lon: 0.2, fixType: 0 })})`); // accepted (unknown)
  run(context, `updateLiveMap(${FIX({ lat: 51.3, lon: 0.3, fixType: 2 })})`); // accepted (2D)
  assert.deepStrictEqual(segLatLngs(context), [
    [
      [51.0, 0.0],
      [51.2, 0.2],
    ],
    [
      [51.2, 0.2],
      [51.3, 0.3],
    ],
  ]);
});

test('updateLiveMap: a gap fix breaks the trail — the next segment resumes from the gap point, never bridged across it', async () => {
  const { context } = await bootLive();
  // In tonic/phasic mode segments are queued (not drawn) until settled, so
  // this asserts the QUEUE geometry — where the gap is actually broken.
  run(context, "liveGsrView.graphView = 'phasic';");
  run(context, 'showMap()');

  run(context, `updateLiveMap(${FIX({ lat: 51.0, lon: 0.0 })})`); // anchor
  run(context, `updateLiveMap(${FIX({ lat: 51.1, lon: 0.1 })})`); // queued segment 1
  run(context, `updateLiveMap(${FIX({ lat: 51.2, lon: 0.2, gap: true })})`); // gap: nothing queued

  assert.strictEqual(
    run(context, 'pendingSegments.length'),
    1,
    'only the good segment is queued — the gap queues nothing',
  );
  assert.deepStrictEqual(
    runJSON(context, 'liveLastLatLng'),
    [51.2, 0.2],
    'anchor moves to the gap point',
  );
  assert.strictEqual(
    segLatLngs(context).length,
    0,
    'nothing is drawn until the metric settles',
  );

  run(context, `updateLiveMap(${FIX({ lat: 51.3, lon: 0.3 })})`); // resumes: queued from the gap point
  assert.deepStrictEqual(
    runJSON(context, 'pendingSegments.map(e => [e.prevLatLng, e.latlng])'),
    [
      [
        [51.0, 0.0],
        [51.1, 0.1],
      ],
      [
        [51.2, 0.2],
        [51.3, 0.3],
      ],
    ],
    'segment 2 starts at the gap point — the gap is never bridged',
  );
});

test('updateLiveMap: an invalid / NaN-position sample is a no-op — no marker, no segment, anchor untouched', async () => {
  const { context } = await bootLive();
  run(context, 'showMap()');
  run(context, `updateLiveMap(${FIX({ lat: 51.0, lon: 0.0 })})`); // anchor
  const before = runJSON(context, 'liveLastLatLng');

  run(context, `updateLiveMap(${FIX({ valid: false, lat: 51.9, lon: 0.9 })})`);
  // NaN can't survive JSON.stringify (-> null), so spell this call out so a
  // real NaN reaches updateLiveMap()'s isNaN() guard.
  run(
    context,
    'updateLiveMap({ valid: true, lat: NaN, lon: NaN, gsrRaw: 1000, hdop: 1.0, pdop: 1.5, fixType: 3, sats: 9, gap: false })',
  );

  assert.strictEqual(segLatLngs(context).length, 0);
  assert.deepStrictEqual(runJSON(context, 'liveLastLatLng'), before);
});

// ==========================================================================
// drawGraph() — the rolling GSR canvas. Since the GSRAnalyzer integration it
// is a PURE renderer: it reads liveAnalyzer.filtered/.tonic/.phasic/.peaks/…
// (populated once per packet by feedLiveAnalyzer(), off the draw path) and
// plots the selected #liveGraphView within the last GRAPH_WINDOW_S seconds.
// Covered here:
//  1. drawGraph() itself runs NO analysis — no analyze(), no
//     decomposeTonicPhasic() — so the 60fps loop cost is independent of
//     session length;
//  2. feedLiveAnalyzer() throttles to every 2nd packet past
//     LIVE_ANALYZE_THROTTLE_ROWS so per-packet cost stays flat on a long walk;
//  3. a gap packet lifts the pen in the plotted curve, so the line never
//     bridges a dropout;
//  4. the layer toggles + view dropdown switch the plotted series, the value
//     readout and the label together.
// The canvas 2D context is a fixed no-op stub in boot_live.js; tests that
// need to see what was drawn install their own recording context first.
// ==========================================================================

function recordCanvas(window) {
  const calls = [];
  const rec =
    (name) =>
    (...args) => {
      calls.push({ name, args });
    };
  window.HTMLCanvasElement.prototype.getContext = () => ({
    setTransform: rec('setTransform'),
    clearRect: rec('clearRect'),
    beginPath: rec('beginPath'),
    closePath: rec('closePath'),
    moveTo: rec('moveTo'),
    lineTo: rec('lineTo'),
    arc: rec('arc'),
    stroke: rec('stroke'),
    fill: rec('fill'),
    fillText: rec('fillText'),
    createLinearGradient: () => ({ addColorStop: () => {} }),
    save: () => {},
    restore: () => {},
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: '',
    textBaseline: '',
  });
  return calls;
}

test('drawGraph: runs no analysis on the draw path — analyze() and decomposeTonicPhasic() are never called from a redraw', async () => {
  const { context } = await bootLive();
  run(
    context,
    `
    for (let i = 0; i < 200; i++) {
      LiveState.addPacket({ valid: true, lat: 51.5, lon: -0.12, gsrRaw: 1000 + (i % 40),
        hdop: 1.0, pdop: 1.5, speedKts: 2, courseDeg: 90, sats: 9, fixType: 3, timestamp: i * 0.3 });
    }
  `,
  );
  // Spy AFTER the packet feed, so only draw-path calls are counted.
  run(
    context,
    `
    globalThis.__calls = { analyze: 0, decomp: 0 };
    const __origAnalyze = liveAnalyzer.analyze.bind(liveAnalyzer);
    liveAnalyzer.analyze = (...a) => { globalThis.__calls.analyze++; return __origAnalyze(...a); };
    const __origDecomp = GsrFilter.decomposeTonicPhasic.bind(GsrFilter);
    GsrFilter.decomposeTonicPhasic = (...a) => { globalThis.__calls.decomp++; return __origDecomp(...a); };
  `,
  );

  run(context, 'drawGraph(); drawGraph(); drawGraph();');

  const calls = runJSON(context, 'globalThis.__calls');
  assert.strictEqual(calls.analyze, 0, 'drawGraph() must not run analyze()');
  assert.strictEqual(
    calls.decomp,
    0,
    'drawGraph() must not run decomposeTonicPhasic()',
  );
});

test('feedLiveAnalyzer: analyses every packet through the warmup, then wall-clock-throttles', async () => {
  const { context } = await bootLive();
  // Shrink the warmup so the test stays fast: 20 rows instead of 400.
  run(context, 'GSRLiveView._setLiveAnalyzeTuningForTest(20);');
  run(
    context,
    `
    globalThis.__n = 0;
    var __orig = GSRAnalyzer.prototype.analyze;
    GSRAnalyzer.prototype.analyze = function (...a) { globalThis.__n++; return __orig.apply(this, a); };
    for (let i = 0; i < 60; i++) {
      LiveState.addPacket({ valid: false, gsrRaw: 1000 + (i % 30), timestamp: i * 0.3 });
    }
  `,
  );
  // The 60 packets arrive in one synchronous burst, so Date.now() never
  // advances past LIVE_ANALYZE_MIN_INTERVAL_MS: the first 20 (warmup) each
  // analyse, the remaining 40 are all inside one throttle window → 0 more.
  assert.strictEqual(run(context, 'globalThis.__n'), 20);
});

test('feedLiveAnalyzer: a new analyze() runs once the throttle interval has elapsed', async () => {
  const { context } = await bootLive();
  run(context, 'GSRLiveView._setLiveAnalyzeTuningForTest(5, 1000);');
  run(
    context,
    `
    globalThis.__n = 0;
    var __orig = GSRAnalyzer.prototype.analyze;
    GSRAnalyzer.prototype.analyze = function (...a) { globalThis.__n++; return __orig.apply(this, a); };
    globalThis.__now = 10000;
    globalThis.__realNow = Date.now;
    Date.now = () => globalThis.__now;
    for (let i = 0; i < 5; i++) LiveState.addPacket({ valid: false, gsrRaw: 1000 + i, timestamp: i * 0.3 });
  `,
  );
  assert.strictEqual(
    run(context, 'globalThis.__n'),
    5,
    'warmup: one analyze per packet',
  );

  // Two more packets in the same throttle window → no new analyze.
  run(
    context,
    `
    for (let i = 5; i < 7; i++) LiveState.addPacket({ valid: false, gsrRaw: 1000 + i, timestamp: i * 0.3 });
  `,
  );
  assert.strictEqual(
    run(context, 'globalThis.__n'),
    5,
    'throttled inside the interval',
  );

  // Advance the clock past the interval → the next packet analyses.
  run(
    context,
    `
    globalThis.__now += 1200;
    LiveState.addPacket({ valid: false, gsrRaw: 2000, timestamp: 7 * 0.3 });
    Date.now = globalThis.__realNow;
  `,
  );
  assert.strictEqual(
    run(context, 'globalThis.__n'),
    6,
    'one more analyze after the interval elapsed',
  );
});

test('feedLiveAnalyzer: analyses only a trailing LIVE_ANALYZE_WINDOW_S slice, not the whole session', async () => {
  const { context } = await bootLive();
  run(context, 'GSRLiveView._setLiveAnalyzeTuningForTest(100000);'); // disable the throttle so every feed re-windows
  run(
    context,
    `
    for (let i = 0; i < 1600; i++) {
      LiveState.addPacket({ valid: false, gsrRaw: 1000 + (i % 50), timestamp: i * 0.3 });
    }
  `,
  );
  const winS = run(context, 'LIVE_ANALYZE_WINDOW_S'); // 300
  const rawLen = run(context, 'liveAnalyzer.raw.length');
  const base = run(context, 'liveAnalyzerBase');
  const pktLen = run(context, 'LiveState.packets.length');
  const expectRows = Math.round(winS / 0.3); // ~1000

  assert.strictEqual(
    pktLen,
    1600,
    'every packet is retained in LiveState (Export CSV needs them)',
  );
  assert.ok(
    Math.abs(rawLen - expectRows) <= 2,
    `analyser buffer ~${expectRows} rows, got ${rawLen}`,
  );
  assert.ok(
    rawLen < pktLen,
    'analyser works on a slice, not the whole session',
  );
  assert.ok(
    Math.abs(base - (pktLen - rawLen)) <= 1,
    `liveAnalyzerBase points at raw[0]'s packet, got ${base}`,
  );
  // The pooled series match the windowed buffer, not the session.
  assert.strictEqual(run(context, 'liveAnalyzer.filtered.length'), rawLen);
});

test('drawGraph: a gap still breaks the trace after the analysis window has slid past the session start', async () => {
  const { window, context } = await bootLive();
  const calls = recordCanvas(window);
  run(context, 'GSRLiveView._setLiveAnalyzeTuningForTest(100000);');
  // ~1500 packets (~450s) so the 300s window no longer starts at packet 0;
  // a single +10s discontinuity at i=1450, inside the visible 120s window.
  run(
    context,
    `
    for (let i = 0; i < 1500; i++) {
      const t = i < 1450 ? i * 0.3 : i * 0.3 + 10;
      LiveState.addPacket({ valid: true, lat: 51.5, lon: -0.12, gsrRaw: 1000,
        hdop: 1.0, pdop: 1.5, speedKts: 2, courseDeg: 90, sats: 9, fixType: 3, timestamp: t });
    }
  `,
  );
  assert.ok(
    run(context, 'liveAnalyzerBase') > 0,
    'window has slid past the session start',
  );

  calls.length = 0;
  run(context, 'drawGraph()');

  const names = calls.map((c) => c.name);
  const curveStart = names.lastIndexOf('beginPath');
  const curveEnd = names.indexOf('stroke', curveStart);
  assert.ok(curveStart !== -1 && curveEnd !== -1, 'found the curve draw');
  const moveTos = calls
    .slice(curveStart, curveEnd)
    .filter((c) => c.name === 'moveTo').length;
  // 2 == initial pen-down + one gap-forced pen-up. Would be 1 if the gap
  // lookup used the raw analyser index instead of liveAnalyzerBase + i.
  assert.strictEqual(
    moveTos,
    2,
    'the base offset is applied to the gap lookup',
  );
});

test('drawGraph: regression — a gap packet lifts the pen in the plotted curve, so the line never bridges a dropout', async () => {
  const { window, context } = await bootLive();
  const calls = recordCanvas(window);

  // 30 packets at the 0.3s cadence with a single +10s discontinuity at
  // i=15 — only that one packet crosses 2x the interval, so exactly one gap.
  run(
    context,
    `
    for (let i = 0; i < 30; i++) {
      LiveState.addPacket({ valid: true, lat: 51.5, lon: -0.12, gsrRaw: 1000,
        hdop: 1.0, pdop: 1.5, speedKts: 2, courseDeg: 90, sats: 9, fixType: 3,
        timestamp: i < 15 ? i * 0.3 : i * 0.3 + 10 });
    }
  `,
  );
  assert.strictEqual(
    run(context, 'LiveState.packets.filter(p => p.gap).length'),
    1,
    'exactly one gap packet',
  );

  calls.length = 0;
  run(context, 'drawGraph()');

  // The GSR curve is the final beginPath()...stroke() pair (live.html
  // ~534-546); everything after it is just text. Within it: one initial
  // pen-down (moveTo) plus one more where the gap forces the pen up == 2.
  // Without the `|| visiblePkts[i].gap` branch every point after the first
  // is a lineTo and this would be 1.
  const names = calls.map((c) => c.name);
  const curveStart = names.lastIndexOf('beginPath');
  const curveEnd = names.indexOf('stroke', curveStart);
  assert.ok(curveStart !== -1 && curveEnd !== -1, 'found the curve draw');
  const moveTos = calls
    .slice(curveStart, curveEnd)
    .filter((c) => c.name === 'moveTo').length;
  assert.strictEqual(
    moveTos,
    2,
    'initial pen-down + exactly one gap-forced pen-up',
  );
});

test('GSR controls: the view dropdown offers only Signal / Tonic / Phasic — no session-normalised metric views', async () => {
  const { window, context } = await bootLive();
  const opts = [...window.document.getElementById('liveGraphView').options].map(
    (o) => o.value,
  );
  assert.deepStrictEqual(opts, ['signal', 'tonic', 'phasic']);
  // LIVE_GRAPH_VIEWS is the matching lookup — same three keys, nothing else.
  assert.deepStrictEqual(
    runJSON(context, 'Object.keys(LIVE_GRAPH_VIEWS).sort()'),
    ['phasic', 'signal', 'tonic'],
  );
});

test('GSR controls: the view dropdown switches the plotted series, the value readout and the label together', async () => {
  const { window, context } = await bootLive();

  // A step up partway so tonic/phasic decomposition has a real, non-zero
  // phasic residual to show rather than a flat signal.
  run(
    context,
    `
    for (let i = 0; i < 60; i++) {
      LiveState.addPacket({ valid: true, lat: 51.5, lon: -0.12,
        gsrRaw: i < 20 ? 1000 : 1600,
        hdop: 1.0, pdop: 1.5, speedKts: 2, courseDeg: 90, sats: 9, fixType: 3, timestamp: i * 0.3 });
    }
    drawGraph();
  `,
  );

  // Default 'signal' view — readout is the latest RAW value in µS (1600 nS ÷ 1000).
  assert.strictEqual(run(context, 'liveGsrView.graphView'), 'signal');
  assert.strictEqual(
    window.document.getElementById('graphValue').textContent,
    '1.60 μS',
  );
  assert.match(
    window.document.getElementById('graphLabel').textContent,
    /^GSR \(μS\) —/,
  );

  // Switch to the Phasic (SCR) view via the dropdown.
  const sel = window.document.getElementById('liveGraphView');
  sel.value = 'phasic';
  sel.dispatchEvent(new window.Event('change'));

  assert.strictEqual(run(context, 'liveGsrView.graphView'), 'phasic');
  assert.match(
    window.document.getElementById('graphLabel').textContent,
    /^Phasic \(SCR\) —/,
  );
  // Readout is now the latest phasic value: clamped >= 0 and well under the
  // raw 1.6 µS (the fast residual once tonic has begun catching the step).
  const phasicVal = Number(
    window.document.getElementById('graphValue').textContent.replace(' μS', ''),
  );
  assert.ok(
    Number.isFinite(phasicVal) && phasicVal >= 0 && phasicVal < 1.6,
    `phasic readout is a bounded residual, got ${phasicVal}`,
  );

  // The Phasic layer toggle (and its P shortcut) flips the overlay flag on the
  // 'signal' view without touching the dropdown.
  sel.value = 'signal';
  sel.dispatchEvent(new window.Event('change'));
  assert.strictEqual(
    run(context, 'liveGsrView.showPhasic'),
    true,
    'desktop default: phasic under the signal',
  );
  window.document.getElementById('liveBtnTogglePhasic').click();
  assert.strictEqual(run(context, 'liveGsrView.showPhasic'), false);
  assert.ok(
    !window.document
      .getElementById('liveBtnTogglePhasic')
      .classList.contains('active'),
  );
});

test('drawGraph: the secondary stats line reports Peaks/min from A.peakDensity and Mean SCL from the visible tonic window', async () => {
  const { window, context } = await bootLive();

  // Three step-ups spaced well apart so full-scan detects distinct SCRs
  // (peaks/min > 0) and the tonic (SCL) trace has settled to a non-zero level.
  run(
    context,
    `
    for (let i = 0; i < 90; i++) {
      LiveState.addPacket({ valid: true, lat: 51.5, lon: -0.12,
        gsrRaw: (i % 30 < 3) ? 1800 : 1000,
        hdop: 1.0, pdop: 1.5, speedKts: 2, courseDeg: 90, sats: 9, fixType: 3, timestamp: i * 0.3 });
    }
    drawGraph();
  `,
  );

  const statsText = window.document.getElementById('graphSecondaryStats')
    .textContent;
  assert.match(
    statsText,
    /^Peaks\/min: \d+\.\d · Mean SCL: (--|\d+\.\d{2} μS)$/,
    statsText,
  );

  const peakRate = Number(statsText.match(/Peaks\/min: ([\d.]+)/)[1]);
  assert.ok(
    peakRate > 0,
    `expected a positive NS-SCR rate off repeated step-ups, got ${peakRate}`,
  );

  // Mean SCL matches the tonic series averaged over the same GRAPH_WINDOW_S
  // window drawGraph() itself plots from (t0 = lastT - GRAPH_WINDOW_S).
  const expected = runJSON(
    context,
    `(() => {
      const A = liveAnalyzer;
      const lastT = lastPacketTimestamp;
      const t0 = lastT - GRAPH_WINDOW_S;
      let sum = 0, n = 0;
      for (const pt of A.tonic) if (pt.time >= t0) { sum += pt.val; n++; }
      return n ? sum / n : null;
    })()`,
  );
  const meanScl = Number(statsText.match(/Mean SCL: ([\d.]+)/)[1]);
  assert.ok(expected !== null, 'test setup should have produced a tonic window');
  assert.ok(
    Math.abs(meanScl - expected) < 0.01,
    `Mean SCL readout ${meanScl} should match the recomputed window mean ${expected}`,
  );
});

// ==========================================================================
// Wire-up characterisation (renderStatus / the animation loop / keyboard
// shortcuts / setMapVisible / the geolocation "My Location" button).
//
// These sit at live.html's DOM-binding layer — top-level getElementById
// bindings, window-level keydown/resize/visibilitychange listeners, and the
// requestAnimationFrame loop. That layer is exactly what the planned
// integration into index.html has to restructure (globals -> a
// container-scoped view controller), so pin its observable behaviour now:
// same status labels, same loop start/stop gating, same key handling, same
// map-visibility bookkeeping.
// ==========================================================================

test('renderStatus: maps each connection status to its badge label and modifier class', async () => {
  const { window, context } = await bootLive();
  const badge = window.document.getElementById('statusBadge');

  run(context, "renderStatus('connecting')");
  assert.strictEqual(badge.textContent, 'Connecting…');
  assert.strictEqual(badge.className, 'badge');

  run(context, "renderStatus('connected')");
  assert.strictEqual(badge.textContent, 'Live');
  assert.strictEqual(badge.className, 'badge live');

  run(context, "renderStatus('reconnecting')");
  assert.strictEqual(badge.textContent, 'Reconnecting…');
  assert.strictEqual(badge.className, 'badge warn');

  run(context, "renderStatus('disconnected')");
  assert.strictEqual(badge.textContent, 'Disconnected');
  assert.strictEqual(badge.className, 'badge bad');

  // Unknown / initial state falls back to the neutral "Not connected".
  run(context, "renderStatus('something-else')");
  assert.strictEqual(badge.textContent, 'Not connected');
  assert.strictEqual(badge.className, 'badge');
});

test('renderStatus: also updates #appHeaderStatusBadge when mounted in index.html', async () => {
  const { window, context } = await bootLive();
  const headerBadge = window.document.createElement('span');
  headerBadge.id = 'appHeaderStatusBadge';
  headerBadge.className = 'badge';
  window.document.body.appendChild(headerBadge);

  run(context, "renderStatus('connected')");
  assert.strictEqual(headerBadge.textContent, 'Live');
  assert.strictEqual(headerBadge.className, 'badge live');

  run(context, "renderStatus('disconnected')");
  assert.strictEqual(headerBadge.textContent, 'Disconnected');
  assert.strictEqual(headerBadge.className, 'badge bad');
});

test('the animation loop starts only while connected/reconnecting and stops (with one final redraw) otherwise', async (t) => {
  const { context } = await bootLive();
  stopLoopAfter(t, context);

  assert.strictEqual(run(context, 'animationFrameId'), null, 'idle on load');

  run(context, "LiveState.setStatus('connected')");
  assert.notStrictEqual(
    run(context, 'animationFrameId'),
    null,
    'connected -> loop running',
  );

  run(context, "LiveState.setStatus('disconnected')");
  assert.strictEqual(
    run(context, 'animationFrameId'),
    null,
    'disconnected -> loop stopped',
  );

  run(context, "LiveState.setStatus('reconnecting')");
  assert.notStrictEqual(
    run(context, 'animationFrameId'),
    null,
    'reconnecting also keeps the loop running',
  );

  run(context, "LiveState.setStatus('disconnected')");
  assert.strictEqual(run(context, 'animationFrameId'), null);
});

test('keyboard: "m" toggles the map exactly like the Show/Hide Map button', async () => {
  const { window, context } = await bootLive();
  const fire = (key, target) =>
    (target || window).dispatchEvent(
      new window.KeyboardEvent('keydown', { key, bubbles: true }),
    );

  assert.ok(window.document.getElementById('app').classList.contains('no-map'));

  fire('m');
  assert.ok(
    !window.document.getElementById('app').classList.contains('no-map'),
    'm shows the map',
  );
  assert.strictEqual(run(context, 'mapVisible'), true);
  assert.strictEqual(
    window.document.getElementById('toggleMapBtn').textContent,
    'Hide Map (M)',
  );

  fire('M'); // capital works too
  assert.ok(
    window.document.getElementById('app').classList.contains('no-map'),
    'M hides it again',
  );
  assert.strictEqual(run(context, 'mapVisible'), false);
});

test('keyboard: "p" toggles the Phasic overlay layer via its button', async () => {
  const { window, context } = await bootLive();
  const fire = (key) =>
    window.dispatchEvent(
      new window.KeyboardEvent('keydown', { key, bubbles: true }),
    );

  assert.strictEqual(
    run(context, 'liveGsrView.showPhasic'),
    true,
    'desktop default: phasic under the signal',
  );
  fire('p');
  assert.strictEqual(run(context, 'liveGsrView.showPhasic'), false);
  assert.ok(
    !window.document
      .getElementById('liveBtnTogglePhasic')
      .classList.contains('active'),
  );
  fire('P'); // capital works too
  assert.strictEqual(run(context, 'liveGsrView.showPhasic'), true);
});

test('keyboard: shortcuts are suppressed while the user is typing in an input element', async () => {
  const { window, context } = await bootLive();
  const input = window.document.createElement('input');
  window.document.body.appendChild(input);

  input.dispatchEvent(
    new window.KeyboardEvent('keydown', { key: 'p', bubbles: true }),
  );
  input.dispatchEvent(
    new window.KeyboardEvent('keydown', { key: 'm', bubbles: true }),
  );

  assert.strictEqual(
    run(context, 'liveGsrView.showPhasic'),
    true,
    'typing "p" into an input does not toggle the Phasic layer',
  );
  assert.ok(
    window.document.getElementById('app').classList.contains('no-map'),
    'typing "m" into an input does not toggle the map',
  );
});

test('setMapVisible: keeps mapVisible, the button label, and the #app.no-map class in sync across repeated calls', async () => {
  const { window, context } = await bootLive();
  const app = window.document.getElementById('app');
  const btn = window.document.getElementById('toggleMapBtn');

  run(context, 'setMapVisible(true)');
  assert.strictEqual(run(context, 'mapVisible'), true);
  assert.ok(!app.classList.contains('no-map'));
  assert.strictEqual(btn.textContent, 'Hide Map (M)');
  assert.ok(btn.classList.contains('active'));

  run(context, 'setMapVisible(true)'); // idempotent
  assert.strictEqual(run(context, 'mapVisible'), true);
  assert.ok(!app.classList.contains('no-map'));

  run(context, 'setMapVisible(false)');
  assert.strictEqual(run(context, 'mapVisible'), false);
  assert.ok(app.classList.contains('no-map'));
  assert.strictEqual(btn.textContent, 'Show Map (M)');
  assert.ok(!btn.classList.contains('active'));
});

test('My Location: a successful geolocation fix pans the map there', async () => {
  const { window, context } = await bootLive();
  // boot_live.js stubs getCurrentPosition to succeed at 51.5074 / -0.1278.
  window.document.getElementById('myLocationBtn').click();

  assert.ok(
    !window.document.getElementById('app').classList.contains('no-map'),
    'the map is shown',
  );
  const center = run(context, 'liveMap.getCenter()');
  assert.strictEqual(center.lat, 51.5074);
  assert.strictEqual(center.lng, -0.1278);
});

test('My Location: centers on live walker position when BLE GPS packets exist', async () => {
  const { window, context } = await bootLive();
  run(
    context,
    'LiveState.addPacket({ timestamp: 1.0, gsrRaw: 10, lat: 37.7749, lon: -122.4194, valid: true, fixType: 3, hdop: 1.0 })',
  );

  window.document.getElementById('myLocationBtn').click();
  const center = run(context, 'liveMap.getCenter()');
  assert.strictEqual(center.lat, 37.7749);
  assert.strictEqual(center.lng, -122.4194);
});

test('liveMetricGroup: segmented buttons switch metric and sync with liveGsrView and FAB', async () => {
  const { window, context } = await bootLive();
  const tonicBtn = window.document.getElementById('liveMetricTonic');
  const phasicBtn = window.document.getElementById('liveMetricPhasic');
  const signalBtn = window.document.getElementById('liveMetricSignal');

  tonicBtn.click();
  assert.strictEqual(run(context, 'liveGsrView.graphView'), 'tonic');
  assert.ok(tonicBtn.classList.contains('active'));
  assert.ok(!signalBtn.classList.contains('active'));

  phasicBtn.click();
  assert.strictEqual(run(context, 'liveGsrView.graphView'), 'phasic');
  assert.ok(phasicBtn.classList.contains('active'));
  assert.ok(!tonicBtn.classList.contains('active'));

  signalBtn.click();
  assert.strictEqual(run(context, 'liveGsrView.graphView'), 'signal');
  assert.ok(signalBtn.classList.contains('active'));
});

test('mount: pre-populates connectErr when Web Bluetooth is not supported', async () => {
  const { window } = await bootLive();
  // boot_live has window.navigator.bluetooth = undefined by default
  const errEl = window.document.getElementById('connectErr');
  assert.match(errEl.textContent, /Web Bluetooth/);
  assert.match(errEl.textContent, /Bluefy/);
});

test('My Location: a browser with no geolocation alerts instead of throwing', async () => {
  const { window } = await bootLive();
  let alerted = null;
  window.alert = (m) => {
    alerted = m;
  };
  window.navigator.geolocation = undefined;

  assert.doesNotThrow(() =>
    window.document.getElementById('myLocationBtn').click(),
  );
  assert.match(alerted || '', /[Gg]eolocation/);
});

test('on load the toolbar renders its initial state — map hidden, GSR layer toggles at their defaults, disconnected', async () => {
  const { window, context } = await bootLive();
  assert.strictEqual(
    window.document.getElementById('toggleMapBtn').textContent,
    'Show Map (M)',
  );
  assert.strictEqual(
    window.document.getElementById('statusBadge').textContent,
    'Disconnected',
  );
  // Filtered/Tonic/Peaks/Hotspots start active; Raw is gone from the live
  // view entirely. On desktop Phasic also starts active (drawn underneath the
  // signal, as in the main visualiser); the view dropdown starts on 'signal'.
  for (const id of [
    'liveBtnToggleFiltered',
    'liveBtnToggleTonic',
    'liveBtnTogglePeaks',
    'liveBtnToggleHotspots',
  ]) {
    assert.ok(
      window.document.getElementById(id).classList.contains('active'),
      `${id} starts active`,
    );
  }
  assert.strictEqual(
    window.document.getElementById('liveBtnToggleRaw'),
    null,
    'Raw toggle removed',
  );
  assert.ok(
    window.document
      .getElementById('liveBtnTogglePhasic')
      .classList.contains('active'),
    'Phasic starts active on desktop',
  );
  assert.strictEqual(
    window.document.getElementById('liveGraphView').value,
    'signal',
  );
  assert.strictEqual(run(context, 'liveGsrView.graphView'), 'signal');
});

// ==========================================================================
// GSRLiveView.activate() / deactivate() — the lifecycle hooks index.html's
// view switcher calls when the Live tab gains / loses the screen. Standalone
// live.html never calls them (viewActive stays true from load). deactivate()
// stops the redraw loop AND drops the BLE link (a walk isn't a background
// activity) — but keeps the accumulated packet buffer so Reconnect can
// resume the same session and Export CSV still works.
// ==========================================================================

test('deactivate: stops the redraw loop, clears viewActive, and drops to "disconnected"', async (t) => {
  const { context } = await bootLive();
  stopLoopAfter(t, context);

  assert.strictEqual(
    run(context, 'viewActive'),
    true,
    'active by default (standalone semantics)',
  );

  run(context, "LiveState.setStatus('connected')"); // starts the RAF loop
  assert.notStrictEqual(
    run(context, 'animationFrameId'),
    null,
    'loop running while connected',
  );

  run(context, 'GSRLiveView.deactivate()');
  assert.strictEqual(run(context, 'viewActive'), false);
  assert.strictEqual(
    run(context, 'animationFrameId'),
    null,
    'deactivate stops the loop',
  );
  assert.strictEqual(
    run(context, 'LiveState.status'),
    'disconnected',
    'deactivate drops the link',
  );

  run(context, 'GSRLiveView.activate()');
  assert.strictEqual(run(context, 'viewActive'), true);
  assert.strictEqual(
    run(context, 'animationFrameId'),
    null,
    'activate does not resume a loop for a now-disconnected session',
  );
});

test('deactivate: disconnects the BLE radio but keeps the session buffer (Reconnect can resume it)', async (t) => {
  const { window, context } = await bootLive();
  const ble = makeFakeBle(context);
  window.navigator.bluetooth = ble.bluetooth;
  run(context, 'showMap()');
  await run(context, 'attemptConnect()');
  stopLoopAfter(t, context);

  ble.fireNotification(
    buildPacket({
      timestampMs: 300,
      lat: 51.5074,
      lon: -0.1278,
      gsrRaw: 1000,
      sats: 9,
      fixType: 3,
    }),
  );
  ble.fireNotification(
    buildPacket({
      timestampMs: 600,
      lat: 51.5076,
      lon: -0.1276,
      gsrRaw: 1200,
      sats: 9,
      fixType: 3,
    }),
  );
  assert.strictEqual(run(context, 'LiveState.packets.length'), 2);

  run(context, 'GSRLiveView.deactivate()');

  assert.strictEqual(
    ble.gattDisconnectCallCount(),
    1,
    'the GATT link was closed',
  );
  assert.strictEqual(
    ble.notificationHandlerCount(),
    0,
    'the characteristic listener was removed',
  );
  assert.strictEqual(run(context, 'LiveState.status'), 'disconnected');
  assert.strictEqual(
    run(context, 'LiveState.packets.length'),
    2,
    'the packet buffer is kept',
  );
  assert.strictEqual(
    run(context, 'bleManager') === null,
    false,
    'the manager/device reference is kept for Reconnect',
  );
  assert.strictEqual(
    window.document.getElementById('exportBtn').disabled,
    false,
    'Export CSV stays usable',
  );

  // A further notification off a now-dead link must not accumulate.
  ble.fireNotification(
    buildPacket({
      timestampMs: 900,
      lat: 51.5078,
      lon: -0.1274,
      gsrRaw: 1300,
      sats: 9,
      fixType: 3,
    }),
  );
  assert.strictEqual(
    run(context, 'LiveState.packets.length'),
    2,
    'no packets arrive after disconnect',
  );
});

test('deactivate: the intentional disconnect does not trigger the auto-reconnect backoff', async (t) => {
  const { window, context } = await bootLive();
  const ble = makeFakeBle(context);
  window.navigator.bluetooth = ble.bluetooth;
  await run(context, 'attemptConnect()');
  stopLoopAfter(t, context);
  assert.strictEqual(ble.subscribeCallCount(), 1);

  run(context, 'GSRLiveView.deactivate()'); // fires gattserverdisconnected via gatt.disconnect()
  await new Promise((r) => setImmediate(r));

  assert.strictEqual(
    run(context, 'bleManager._reconnecting'),
    false,
    'no reconnect loop started',
  );
  assert.strictEqual(ble.subscribeCallCount(), 1, 'no re-subscribe attempt');
  assert.strictEqual(run(context, 'LiveState.status'), 'disconnected');
});

test('after an intentional disconnect, Reconnect resumes the same session and re-arms auto-reconnect', async (t) => {
  const { window, context } = await bootLive();
  const ble = makeFakeBle(context);
  window.navigator.bluetooth = ble.bluetooth;
  await run(context, 'attemptConnect()');
  stopLoopAfter(t, context);

  run(context, 'GSRLiveView.deactivate()');
  await new Promise((r) => setImmediate(r));
  // The guard is consumed synchronously by the gattserverdisconnected event
  // that disconnect() itself fires — its job is done by the time we get here.
  assert.strictEqual(run(context, 'bleManager._intentionalClose'), false);
  assert.strictEqual(run(context, 'LiveState.status'), 'disconnected');

  await run(context, 'bleManager.manualReconnect()');
  assert.strictEqual(
    run(context, 'LiveState.status'),
    'connected',
    'the same manager reconnected',
  );

  // A genuine drop now must still auto-recover — the intentional-close path
  // didn't leave the guard stuck.
  const timers = recordingTimers(window);
  await run(context, 'bleManager._handleDisconnect()');
  timers.restore();
  assert.strictEqual(
    run(context, 'LiveState.status'),
    'connected',
    'auto-reconnect ran and recovered',
  );
  assert.ok(ble.subscribeCallCount() >= 3, 'a re-subscribe attempt was made');
});

test('activate: does not start the loop when no session is live', async (t) => {
  const { context } = await bootLive();
  stopLoopAfter(t, context);

  run(context, 'GSRLiveView.deactivate()');
  run(context, 'GSRLiveView.activate()'); // status is still "disconnected"

  assert.strictEqual(
    run(context, 'animationFrameId'),
    null,
    'nothing to animate while disconnected',
  );
});

test('activate: re-measures the Leaflet map (invalidateSize) — it may have been sized while the panel was hidden', async () => {
  const { context } = await bootLive();
  run(context, 'showMap()'); // builds liveMap
  const before = run(context, 'liveMap.calls.invalidateSize');

  run(context, 'GSRLiveView.deactivate()');
  run(context, 'GSRLiveView.activate()');

  assert.ok(
    run(context, 'liveMap.calls.invalidateSize') > before,
    'activate() calls liveMap.invalidateSize()',
  );
});

test('activate: is a safe no-op before any map exists', async () => {
  const { context } = await bootLive();
  assert.strictEqual(run(context, 'liveMap'), null);
  assert.doesNotThrow(() =>
    run(context, 'GSRLiveView.deactivate(); GSRLiveView.activate()'),
  );
});

test('a status change while deactivated arms the loop, but no frame draws until re-activated', async (t) => {
  const { window, context } = await bootLive();
  stopLoopAfter(t, context);
  const calls = recordCanvas(window);

  run(context, 'GSRLiveView.deactivate()');
  calls.length = 0;
  run(context, "LiveState.setStatus('connected')"); // status handler re-arms startAnimationLoop()

  // The RAF callback fires on the next tick; give it a moment.
  return new Promise((resolve) =>
    setTimeout(() => {
      const drewWhileHidden = calls.some(
        (c) => c.name === 'clearRect' || c.name === 'stroke',
      );
      assert.ok(
        !drewWhileHidden,
        'the frame() guard skips drawGraph while viewActive is false',
      );
      resolve();
    }, 30),
  );
});

// ==========================================================================
// drawGraph() styling — the live graph is meant to read like the
// single-track GSR view (src/render/renderer.js): one primary trace in the
// app's --color-filtered blue, or --color-phasic green in phasic-only mode,
// over a faint grid. Capture the stroke state at each stroke() call.
// ==========================================================================

function recordStrokes(window) {
  const strokes = [];
  const ctx = {
    setTransform() {},
    clearRect() {},
    beginPath() {},
    closePath() {},
    moveTo() {},
    lineTo() {},
    arc() {},
    fill() {},
    fillText() {},
    createLinearGradient: () => ({ addColorStop() {} }),
    save() {},
    restore() {},
    stroke() {
      strokes.push({
        strokeStyle: this.strokeStyle,
        lineWidth: this.lineWidth,
      });
    },
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 1,
    lineJoin: '',
    font: '',
    textAlign: '',
    textBaseline: '',
  };
  window.HTMLCanvasElement.prototype.getContext = () => ctx;
  return strokes;
}

test('drawGraph: the primary GSR trace is the app\'s --color-filtered blue at weight 2.2 (single-view "Signal" styling)', async () => {
  const { window, context } = await bootLive();
  const strokes = recordStrokes(window);
  // A monotonic ramp — no SCR peaks, so no peak/hotspot dot strokes; the
  // Filtered layer is the last stroke() (drawn on top of Raw + Tonic).
  run(
    context,
    `
    for (let i = 0; i < 40; i++) LiveState.addPacket({ valid: true, lat: 51.5, lon: -0.12,
      gsrRaw: 1000 + i * 5, hdop: 1, pdop: 1, speedKts: 1, courseDeg: 90, sats: 9, fixType: 3, timestamp: i * 0.3 });
    drawGraph();
  `,
  );

  const trace = strokes[strokes.length - 1];
  assert.strictEqual(
    trace.strokeStyle,
    '#005bc4',
    'trace uses --color-filtered',
  );
  assert.strictEqual(trace.lineWidth, 2.2);
});

test('drawGraph: the Phasic (SCR) view draws its trace in --color-phasic green at weight 2', async () => {
  const { window, context } = await bootLive();
  const strokes = recordStrokes(window);
  run(
    context,
    `
    for (let i = 0; i < 60; i++) LiveState.addPacket({ valid: true, lat: 51.5, lon: -0.12,
      gsrRaw: i < 20 ? 1000 : 1000 + i * 3, hdop: 1, pdop: 1, speedKts: 1, courseDeg: 90, sats: 9, fixType: 3, timestamp: i * 0.3 });
    liveGsrView.graphView = 'phasic';
    drawGraph();
  `,
  );

  const trace = strokes[strokes.length - 1];
  assert.strictEqual(trace.strokeStyle, '#008f3c', 'trace uses --color-phasic');
  assert.strictEqual(trace.lineWidth, 2);
});

test('drawGraph: a hotspot renders as a hollow --color-hotspot ring (weight 2) with a ★, matching the single-track graph', async () => {
  const { window, context } = await bootLive();
  const rec = { strokes: [], texts: [] };
  const ctx = {
    setTransform() {},
    clearRect() {},
    beginPath() {},
    closePath() {},
    moveTo() {},
    lineTo() {},
    arc() {},
    fill() {},
    fillText(t) {
      rec.texts.push(t);
    },
    createLinearGradient: () => ({ addColorStop() {} }),
    save() {},
    restore() {},
    stroke() {
      rec.strokes.push({
        strokeStyle: this.strokeStyle,
        lineWidth: this.lineWidth,
      });
    },
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 1,
    lineJoin: '',
    font: '',
    textAlign: '',
    textBaseline: '',
  };
  window.HTMLCanvasElement.prototype.getContext = () => ctx;

  // A flat baseline then one sharp SCR (rise from ~t6s, slow decay) → one
  // detected peak; HOTSPOT_PERCENTILE's "at least 1" makes that peak a
  // memorable event. It sits well before the 8s unsettled tail.
  run(
    context,
    `
    for (let i = 0; i < 140; i++) {
      const t = i * 0.3;
      let us = 5;
      const d = t - 6;
      if (d > 0) us += 1.2 * Math.exp(-d / 4) * (1 - Math.exp(-d / 0.6));
      LiveState.addPacket({ valid: true, lat: 51.5 + i * 1e-5, lon: -0.12 + i * 1e-5,
        gsrRaw: us * 1000, hdop: 1, pdop: 1, speedKts: 1, courseDeg: 90, sats: 9, fixType: 3, timestamp: t });
    }
    drawGraph();
  `,
  );

  assert.ok(
    run(context, 'liveAnalyzer.memorableEvents.length') > 0,
    'the SCR was picked as a hotspot',
  );
  const ring = rec.strokes.find(
    (s) => s.strokeStyle === '#ff1744' && s.lineWidth === 2,
  );
  assert.ok(ring, 'hotspot ring is stroked in --color-hotspot at weight 2');
  assert.ok(rec.texts.includes('★'), 'hotspot is marked with a ★ glyph');
  // Plain peaks stay the small --color-peak dot — no peak-red ring stroke.
  assert.ok(
    !rec.strokes.some((s) => s.strokeStyle === '#d10024'),
    'plain peaks are filled dots, not stroked rings',
  );
});

test('drawGraph: renders the grid + L-shaped axis before the trace (>= 3 stroke passes)', async () => {
  const { window, context } = await bootLive();
  const strokes = recordStrokes(window);
  run(
    context,
    `
    for (let i = 0; i < 40; i++) LiveState.addPacket({ valid: true, lat: 51.5, lon: -0.12,
      gsrRaw: 1000 + i * 5, hdop: 1, pdop: 1, speedKts: 1, courseDeg: 90, sats: 9, fixType: 3, timestamp: i * 0.3 });
    drawGraph();
  `,
  );
  // Y grid, X grid, axis frame, trace — four separate stroke() passes.
  assert.ok(
    strokes.length >= 4,
    `expected grid+axis+trace passes, got ${strokes.length}`,
  );
});

test('niceStep: yields 1/2/5 x 10^n steps giving roughly five divisions', async () => {
  const { context } = await bootLive();
  const step = (span) => run(context, `niceStep(${span})`);
  assert.strictEqual(step(10), 2); // rough 2  -> 2
  assert.strictEqual(step(50), 10); // rough 10 -> 10
  assert.strictEqual(step(1000), 200); // rough 200 -> 2e2
  assert.strictEqual(step(2500), 500); // rough 500 -> 5e2
  assert.strictEqual(step(9000), 1000); // rough 1800 -> 1e3
  assert.strictEqual(step(0), 1); // degenerate span
  assert.strictEqual(step(-5), 1);
});

// ==========================================================================
// The live view has no self-fullscreen affordance: in-app GSRLayoutManager
// owns the F key / display mode for the whole app (pinned in
// test_live_view_switch.js), and standalone live.html no longer ships a
// toolbar button or an F shortcut of its own.
// ==========================================================================

test('the live view binds no fullscreen control — no #toggleFullscreenBtn, and F does nothing here', async () => {
  const { window } = await bootLive();
  assert.strictEqual(
    window.document.getElementById('toggleFullscreenBtn'),
    null,
    'no fullscreen button',
  );
  let reqs = 0;
  window.document.documentElement.requestFullscreen = () => {
    reqs++;
    return Promise.resolve();
  };
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'f' }));
  assert.strictEqual(reqs, 0, 'F is not wired to fullscreen in the live view');
});

// ==========================================================================
// Recolour backlog cap (PENDING_SEGMENTS_MAX). drawGraph() drains
// pendingSegments, but it is paused while the Live view is off-screen
// in-app — updateLiveMap() must not let the queue (and the Leaflet
// polylines it pins) grow without bound in the meantime.
// ==========================================================================

test('pendingSegments is capped even when drawGraph() never runs to drain it', async () => {
  const { context } = await bootLive();
  // 'signal' (the default) never queues anything at all — switch to a
  // metric that does, so there's a queue to cap in the first place.
  run(context, "liveGsrView.graphView = 'phasic';");
  run(context, 'showMap()');
  // Feed far more consecutive fixes than the cap, never calling drawGraph().
  run(
    context,
    `
    for (let i = 0; i < 3000; i++) {
      updateLiveMap({ valid: true, lat: 51.5 + i * 1e-5, lon: -0.12 + i * 1e-5,
        gsrRaw: 1000 + (i % 50), hdop: 1.0, pdop: 1.5, fixType: 3, sats: 9, gap: false });
    }
  `,
  );
  const queued = run(context, 'pendingSegments.length');
  const cap = run(context, 'PENDING_SEGMENTS_MAX');
  assert.ok(queued <= cap, `queue (${queued}) stays within the cap (${cap})`);
});

test('disconnect(): immediately aborts in-flight retry wait and does not arm passive background watch', async (t) => {
  const { window, context } = await bootLive();
  const ble = makeFakeBle(context, { reconnectFailures: 99 });
  window.navigator.bluetooth = ble.bluetooth;
  await run(context, 'attemptConnect()');
  stopLoopAfter(t, context);

  // Start _handleDisconnect() and let it enter the first backoff wait
  const loop = run(context, 'bleManager._handleDisconnect()');
  await settle(() => ble.advertisementHandlerCount() === 1);

  assert.strictEqual(run(context, 'bleManager._reconnecting'), true);
  assert.strictEqual(
    ble.advertisementHandlerCount(),
    1,
    'wait listener armed during backoff',
  );

  // User explicitly clicks disconnect / calls disconnect()
  run(context, 'bleManager.disconnect()');
  await loop;

  assert.strictEqual(run(context, 'bleManager._userDisconnected'), true);
  assert.strictEqual(run(context, 'bleManager._reconnecting'), false);
  assert.strictEqual(run(context, 'LiveState.status'), 'disconnected');
  assert.strictEqual(
    ble.advertisementHandlerCount(),
    0,
    'passive background watch must not be armed after user disconnect',
  );
});

test('compact mobile layout: sets Cache Map button label without shortcut suffix', async () => {
  const { window } = await bootLive({ compact: true });
  const cacheMapBtn = window.document.getElementById('cacheMapBtn');
  assert.strictEqual(cacheMapBtn.textContent, 'Cache Map');
});

test('orientation change resets window scroll position to (0, 0)', async () => {
  const { window } = await bootLive();
  let scrolledTo = null;
  window.scrollTo = (x, y) => {
    scrolledTo = [x, y];
  };

  window.dispatchEvent(new window.Event('orientationchange'));
  assert.deepStrictEqual(
    scrolledTo,
    [0, 0],
    'orientation change resets scroll drift to origin',
  );
});
