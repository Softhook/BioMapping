/**
 * The "Live" view tab in the MAIN app (index.html).
 *
 * The Live receiver is now built straight into #livePanel by
 * GSRLiveView.mount() (src/live/live_view.js) — the same code path
 * standalone live.html uses — the first time the third header tab
 * (Single Track / Collective / Live) is opened, then left mounted so an
 * active BLE session survives a tab round-trip. These tests pin that
 * view-switch contract: which tab is active, the .main-layout mode class,
 * mount-once, and clean teardown back to single/collective.
 *
 * Boots the real index.html via tests/support/boot_app.js. No track data
 * needed — the Live tab is independent of the analysed-track pipeline.
 *
 * Run: node --test tests/test_live_view_switch.js  (or `npm test` for all)
 */

const assert = require('node:assert');
const test = require('node:test');
const { bootApp } = require('./support/boot_app.js');

async function boot(opts) {
  const { window } = await bootApp(opts);
  // boot_app.js stubs p5 but not a raw 2D canvas context; the live view's
  // drawGraph() needs one the moment its map is shown. Minimal no-op stub,
  // same shape boot_live.js installs.
  const noop = () => {};
  window.HTMLCanvasElement.prototype.getContext = () => ({
    setTransform: noop,
    clearRect: noop,
    beginPath: noop,
    closePath: noop,
    moveTo: noop,
    lineTo: noop,
    stroke: noop,
    fill: noop,
    fillText: noop,
    createLinearGradient: () => ({ addColorStop: noop }),
    save: noop,
    restore: noop,
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: '',
    textBaseline: '',
  });
  window.setup();
  const document = window.document;
  return {
    window,
    document,
    layout: document.querySelector('.main-layout'),
    btnSingle: document.getElementById('btnSingleView'),
    btnCollective: document.getElementById('btnCollectiveView'),
    btnLive: document.getElementById('btnLiveView'),
    livePanel: document.getElementById('livePanel'),
    click: (el) =>
      el.dispatchEvent(new window.Event('click', { bubbles: true })),
  };
}

test('the Live tab exists in the real index.html markup, alongside Single Track and Collective', async () => {
  const { btnSingle, btnCollective, btnLive } = await boot();
  assert.ok(btnSingle, 'btnSingleView present');
  assert.ok(btnCollective, 'btnCollectiveView present');
  assert.ok(btnLive, 'btnLiveView present');
  assert.match(btnLive.textContent.trim(), /Live/);
});

test('#livePanel starts empty — the live UI is not built until the tab is first opened', async () => {
  const { window, livePanel } = await boot();
  assert.ok(livePanel, '#livePanel present');
  assert.strictEqual(livePanel.children.length, 0, 'no live DOM yet');
  assert.ok(!window.GSRLiveView._mounted, 'GSRLiveView not mounted on load');
});

// ==========================================================================
// Mobile lands on Live by default (src/ui/events.js's bindViewSwitcher(),
// reusing GSRLiveView.isCompactLayout() — the exact same width+pointer check
// the Live view itself uses for its own map-first default). Desktop is
// unaffected. The tab row stays visible/clickable either way — the escape
// hatch back to Single Track for a misdetected device or a phone user who
// actually wants to browse/load a CSV.
// ==========================================================================

test('a desktop boot (the default matchMedia stub) still lands on Single Track, as today', async () => {
  const { window } = await boot();
  assert.strictEqual(window.AppState.viewMode, 'single');
  assert.ok(!window.GSRLiveView._mounted, 'Live was never auto-entered');
});

test('a compact/coarse-pointer boot lands directly on Live — mounted, activated, and the active tab', async () => {
  const { window, layout, btnSingle, btnLive, livePanel } = await boot({
    compact: true,
  });
  assert.strictEqual(window.AppState.viewMode, 'live');
  assert.ok(layout.classList.contains('live-mode'));
  assert.ok(btnLive.classList.contains('active'));
  assert.ok(!btnSingle.classList.contains('active'));
  assert.ok(
    window.GSRLiveView._mounted,
    'GSRLiveView.mount() ran during boot, not on a later click',
  );
  assert.ok(
    livePanel.querySelector('#statusBadge'),
    'the live UI was actually built into the panel',
  );
});

test('a compact boot still leaves the Single/Collective/Live tab row clickable — one tap back to Single Track', async () => {
  const { window, layout, btnSingle, btnLive, click } = await boot({
    compact: true,
  });
  assert.strictEqual(window.AppState.viewMode, 'live');

  click(btnSingle);

  assert.strictEqual(window.AppState.viewMode, 'single');
  assert.ok(!layout.classList.contains('live-mode'));
  assert.ok(btnSingle.classList.contains('active'));
  assert.ok(!btnLive.classList.contains('active'));
});

test('clicking Live switches viewMode, adds the live-mode class, moves the active tab, and mounts the live UI', async () => {
  const {
    window,
    layout,
    btnSingle,
    btnCollective,
    btnLive,
    livePanel,
    click,
  } = await boot();
  assert.strictEqual(window.AppState.viewMode, 'single');

  click(btnLive);

  assert.strictEqual(window.AppState.viewMode, 'live');
  assert.ok(layout.classList.contains('live-mode'), 'layout gains live-mode');
  assert.ok(
    window.document
      .querySelector('.app-container')
      .classList.contains('live-mode'),
    'app-container gains live-mode',
  );
  assert.ok(btnLive.classList.contains('active'), 'Live tab is active');
  assert.ok(
    !btnSingle.classList.contains('active'),
    'Single tab no longer active',
  );
  assert.ok(
    !btnCollective.classList.contains('active'),
    'Collective tab not active',
  );
  assert.ok(window.GSRLiveView._mounted, 'GSRLiveView.mount ran');
  assert.ok(
    livePanel.classList.contains('live-view'),
    'panel tagged .live-view for scoped styles',
  );
  assert.ok(
    livePanel.querySelector('#statusBadge'),
    'the live UI was built into the panel',
  );
});

test('clicking Live twice is a no-op the second time (guarded on viewMode)', async () => {
  const { window, layout, btnLive, click } = await boot();
  click(btnLive);
  assert.doesNotThrow(() => click(btnLive));
  assert.strictEqual(window.AppState.viewMode, 'live');
  assert.ok(layout.classList.contains('live-mode'));
  assert.ok(btnLive.classList.contains('active'));
});

test('switching Live -> Single tears down live-mode and restores the single view', async () => {
  const { window, layout, btnSingle, btnLive, click } = await boot();
  click(btnLive);
  click(btnSingle);

  assert.strictEqual(window.AppState.viewMode, 'single');
  assert.ok(
    !layout.classList.contains('live-mode'),
    'live-mode class removed from layout',
  );
  assert.ok(
    !window.document
      .querySelector('.app-container')
      .classList.contains('live-mode'),
    'live-mode class removed from app-container',
  );
  assert.ok(btnSingle.classList.contains('active'));
  assert.ok(!btnLive.classList.contains('active'), 'Live tab deactivated');
});

test('switching Live -> Collective tears down live-mode and enters collective-mode', async () => {
  const { window, layout, btnCollective, btnLive, click } = await boot();
  click(btnLive);
  click(btnCollective);

  assert.strictEqual(window.AppState.viewMode, 'collective');
  assert.ok(
    !layout.classList.contains('live-mode'),
    'live-mode class removed from layout',
  );
  assert.ok(
    !window.document
      .querySelector('.app-container')
      .classList.contains('live-mode'),
    'live-mode class removed from app-container',
  );
  assert.ok(
    layout.classList.contains('collective-mode'),
    'collective-mode class added',
  );
  assert.ok(!btnLive.classList.contains('active'), 'Live tab deactivated');
});

test('the live UI stays mounted once built — Live -> Collective -> Live does not rebuild it', async () => {
  const { window, btnCollective, btnLive, livePanel, click } = await boot();
  click(btnLive);
  const badge = livePanel.querySelector('#statusBadge');
  assert.ok(badge, 'built on first open');

  click(btnCollective);
  click(btnLive);

  assert.strictEqual(
    livePanel.querySelector('#statusBadge'),
    badge,
    'same element — not re-mounted',
  );
  assert.strictEqual(window.AppState.viewMode, 'live');
});

test('the live view keyboard shortcuts only fire while Live is the active view', async () => {
  const { window, btnSingle, btnLive, livePanel, click } = await boot();
  const key = (k) =>
    window.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: k, bubbles: true }),
    );

  click(btnLive); // mounts + Live is active
  const mapBtn = livePanel.querySelector('#toggleMapBtn');
  const labelWhileLive = mapBtn.textContent;

  click(btnSingle); // Live listeners persist (mount-once), but must now stand down
  key('m');
  assert.strictEqual(
    mapBtn.textContent,
    labelWhileLive,
    '"m" is inert while Single is the active view',
  );

  click(btnLive);
  key('m');
  assert.notStrictEqual(
    mapBtn.textContent,
    labelWhileLive,
    '"m" toggles the map again once Live is active',
  );
});

test('the live panel ships no fullscreen button of its own — the top-bar Full screen button / GSRLayoutManager cover it', async () => {
  const { btnLive, livePanel, click } = await boot();
  click(btnLive);
  assert.strictEqual(livePanel.querySelector('#toggleFullscreenBtn'), null);
});

test('in-app the F key puts the Live view into edge-to-edge display mode (header hidden + .app-container fullscreen)', async () => {
  const { window, document, btnLive, click } = await boot();
  const appContainer = document.querySelector('.app-container');
  let appReqs = 0,
    docElReqs = 0;
  appContainer.requestFullscreen = () => {
    appReqs++;
    return Promise.resolve();
  };
  document.documentElement.requestFullscreen = () => {
    docElReqs++;
    return Promise.resolve();
  };

  click(btnLive);
  document.dispatchEvent(
    new window.KeyboardEvent('keydown', { key: 'f', bubbles: true }),
  );

  assert.ok(
    appContainer.classList.contains('live-display-mode'),
    'the header-hiding class is applied',
  );
  assert.strictEqual(
    appReqs,
    1,
    'GSRLayoutManager fullscreened .app-container',
  );
  assert.strictEqual(
    docElReqs,
    0,
    "the live view's own documentElement fullscreen did not also fire",
  );

  // F again toggles it back off.
  document.dispatchEvent(
    new window.KeyboardEvent('keydown', { key: 'f', bubbles: true }),
  );
  assert.ok(
    !appContainer.classList.contains('live-display-mode'),
    'F again exits display mode',
  );
});

test('leaving the Live view clears live display mode', async () => {
  const { window, document, btnSingle, btnLive, click } = await boot();
  const appContainer = document.querySelector('.app-container');
  appContainer.requestFullscreen = () => Promise.resolve();
  document.exitFullscreen = () => Promise.resolve();

  click(btnLive);
  document.dispatchEvent(
    new window.KeyboardEvent('keydown', { key: 'f', bubbles: true }),
  );
  assert.ok(appContainer.classList.contains('live-display-mode'));

  click(btnSingle);
  assert.ok(
    !appContainer.classList.contains('live-display-mode'),
    'display mode does not leak into Single view',
  );
});

test('leaving the Live view stands the live controller down (deactivate)', async () => {
  const { window, btnSingle, btnLive, click } = await boot();
  click(btnLive);
  window.GSRLiveView.activate();
  let deactivated = 0;
  let passedInAppSwitch = null;
  const real = window.GSRLiveView.deactivate;
  window.GSRLiveView.deactivate = (...a) => {
    deactivated++;
    passedInAppSwitch = a[0];
    return real.apply(window.GSRLiveView, a);
  };

  click(btnSingle);
  assert.strictEqual(
    deactivated,
    1,
    'the view switcher calls GSRLiveView.deactivate() on the way out',
  );
  assert.strictEqual(
    passedInAppSwitch,
    true,
    'deactivate called with inAppSwitch = true',
  );
});

test('the mobile hamburger toggles the .sidebar-open drawer class and its aria-expanded state', async () => {
  const { document, layout, click } = await boot();
  const toggle = document.getElementById('btnSidebarToggle');
  const backdrop = document.getElementById('sidebarBackdrop');
  assert.ok(toggle, '#btnSidebarToggle present in the markup');
  assert.ok(backdrop, '#sidebarBackdrop present in the markup');
  assert.ok(!layout.classList.contains('sidebar-open'), 'drawer starts closed');

  click(toggle);
  assert.ok(
    layout.classList.contains('sidebar-open'),
    'first tap opens the drawer',
  );
  assert.strictEqual(toggle.getAttribute('aria-expanded'), 'true');

  click(backdrop);
  assert.ok(
    !layout.classList.contains('sidebar-open'),
    'tapping the scrim closes it',
  );
  assert.strictEqual(toggle.getAttribute('aria-expanded'), 'false');
});

test('entering Live hides the mobile hamburger and closes the drawer; leaving restores it', async () => {
  const { document, layout, btnSingle, btnLive, click } = await boot();
  const toggle = document.getElementById('btnSidebarToggle');
  click(toggle); // open the drawer first
  assert.ok(layout.classList.contains('sidebar-open'));

  click(btnLive);
  assert.strictEqual(
    toggle.hidden,
    true,
    'hamburger hidden in Live (sidebar is display:none there)',
  );
  assert.ok(
    !layout.classList.contains('sidebar-open'),
    'drawer force-closed on entering Live',
  );

  click(btnSingle);
  assert.strictEqual(
    toggle.hidden,
    false,
    'hamburger restored when controls are reachable again',
  );
});

test('entering Live mode stops the p5 draw loop (noLoop), leaving the canvas idle', async () => {
  const { window, btnLive, click } = await boot();
  let noLoopCalls = 0;
  const realNoLoop = window.noLoop;
  window.noLoop = (...a) => {
    noLoopCalls++;
    return realNoLoop?.apply(window, a);
  };

  click(btnLive);

  assert.ok(noLoopCalls >= 1, 'noLoop() called on entering Live view');
});

test('header status badge exists and updates with connection status in live mode', async () => {
  const { window, document, btnLive, click } = await boot();
  const headerBadge = document.getElementById('appHeaderStatusBadge');
  assert.ok(headerBadge, '#appHeaderStatusBadge present in header-left');

  click(btnLive);
  const appContainer = document.querySelector('.app-container');
  assert.ok(
    appContainer.classList.contains('live-mode'),
    'app-container has live-mode',
  );

  // Verify status update in live view updates both badges
  window.LiveState.setStatus('connected');
  assert.strictEqual(headerBadge.textContent, 'Live');
  assert.ok(headerBadge.classList.contains('live'));

  window.LiveState.setStatus('disconnected');
  assert.strictEqual(headerBadge.textContent, 'Disconnected');
  assert.ok(headerBadge.classList.contains('bad'));
});

test('clicking #btnFullscreen in live mode toggles live-display-mode edge-to-edge', async () => {
  const { document, btnLive, click } = await boot();
  const appContainer = document.querySelector('.app-container');
  appContainer.requestFullscreen = () => Promise.resolve();
  document.exitFullscreen = () => Promise.resolve();

  click(btnLive);
  const btnFs = document.getElementById('btnFullscreen');
  assert.ok(btnFs, '#btnFullscreen exists');

  // Clicking fullscreen in live mode enters live-display-mode
  click(btnFs);
  assert.ok(
    appContainer.classList.contains('live-display-mode'),
    'enters live-display-mode on click',
  );
  assert.ok(btnFs.classList.contains('is-fullscreen'));

  // Clicking fullscreen again exits live-display-mode
  click(btnFs);
  assert.ok(
    !appContainer.classList.contains('live-display-mode'),
    'exits live-display-mode on click',
  );
  assert.ok(!btnFs.classList.contains('is-fullscreen'));
});

test('in live-display-mode, FAB menu offers Exit Full Screen chip and toolbar offers Exit button', async () => {
  const { document, btnLive, click } = await boot();
  const appContainer = document.querySelector('.app-container');
  appContainer.requestFullscreen = () => Promise.resolve();
  document.exitFullscreen = () => Promise.resolve();

  click(btnLive);
  const btnFs = document.getElementById('btnFullscreen');
  click(btnFs);
  assert.ok(appContainer.classList.contains('live-display-mode'));

  // Check FAB menu has exit chip
  const fabMenu = document.getElementById('liveFabMenu');
  assert.ok(fabMenu, 'liveFabMenu exists');
  const exitChip = fabMenu.querySelector('[data-action="exit-fullscreen"]');
  assert.ok(exitChip, 'FAB menu has exit-fullscreen chip');

  // Clicking the FAB exit chip exits display mode
  click(exitChip);
  assert.ok(
    !appContainer.classList.contains('live-display-mode'),
    'clicking exit chip exits display mode',
  );

  // Enter again and test toolbar exit button
  click(btnFs);
  assert.ok(appContainer.classList.contains('live-display-mode'));
  const toolbarExitBtn = document.getElementById('liveBtnExitDisplay');
  assert.ok(toolbarExitBtn, '#liveBtnExitDisplay exists');
  click(toolbarExitBtn);
  assert.ok(
    !appContainer.classList.contains('live-display-mode'),
    'clicking toolbar exit button exits display mode',
  );
});

test('GSRLiveView.deactivate(true) pauses canvas loop without dropping BLE connection or changing status to disconnected', async () => {
  const { window, btnLive, click } = await boot();
  click(btnLive);
  window.LiveState.setStatus('connected');

  let disconnectCalled = false;
  const mockBleManager = {
    disconnect: () => {
      disconnectCalled = true;
    },
    device: { id: 'mock-123' },
  };
  window.GSRLiveView._setBleManagerForTest?.(mockBleManager);

  window.GSRLiveView.deactivate(true);

  assert.strictEqual(
    disconnectCalled,
    false,
    'BLE disconnect was not called on in-app switch',
  );
  assert.strictEqual(
    window.LiveState.status,
    'connected',
    'status remains connected during in-app switch',
  );
  assert.strictEqual(
    window.GSRLiveView.isViewActive(),
    false,
    'viewActive is false',
  );
});

test('GSRLiveView.deactivate(false) fully disconnects BLE and sets status to disconnected', async () => {
  const { window, btnLive, click } = await boot();
  click(btnLive);
  window.LiveState.setStatus('connected');

  let _disconnectCalled = false;
  const mockBleManager = {
    disconnect: () => {
      _disconnectCalled = true;
    },
    device: { id: 'mock-123' },
  };
  window.GSRLiveView._setBleManagerForTest?.(mockBleManager);

  window.GSRLiveView.deactivate(false);

  assert.strictEqual(
    window.LiveState.status,
    'disconnected',
    'status set to disconnected on full exit',
  );
  assert.strictEqual(
    window.GSRLiveView.isViewActive(),
    false,
    'viewActive is false',
  );
});
