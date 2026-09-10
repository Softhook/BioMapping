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

const assert = require('assert');
const test = require('node:test');
const { bootApp } = require('./support/boot_app.js');

function boot() {
  const { window } = bootApp();
  // boot_app.js stubs p5 but not a raw 2D canvas context; the live view's
  // drawGraph() needs one the moment its map is shown. Minimal no-op stub,
  // same shape boot_live.js installs.
  const noop = () => {};
  window.HTMLCanvasElement.prototype.getContext = () => ({
    setTransform: noop, clearRect: noop, beginPath: noop, closePath: noop,
    moveTo: noop, lineTo: noop, stroke: noop, fill: noop, fillText: noop,
    createLinearGradient: () => ({ addColorStop: noop }),
    save: noop, restore: noop,
    strokeStyle: '', fillStyle: '', lineWidth: 1, font: '', textAlign: '', textBaseline: '',
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
    click: (el) => el.dispatchEvent(new window.Event('click', { bubbles: true })),
  };
}

test('the Live tab exists in the real index.html markup, alongside Single Track and Collective', () => {
  const { btnSingle, btnCollective, btnLive } = boot();
  assert.ok(btnSingle, 'btnSingleView present');
  assert.ok(btnCollective, 'btnCollectiveView present');
  assert.ok(btnLive, 'btnLiveView present');
  assert.match(btnLive.textContent.trim(), /Live/);
});

test('#livePanel starts empty — the live UI is not built until the tab is first opened', () => {
  const { window, livePanel } = boot();
  assert.ok(livePanel, '#livePanel present');
  assert.strictEqual(livePanel.children.length, 0, 'no live DOM yet');
  assert.ok(!window.GSRLiveView._mounted, 'GSRLiveView not mounted on load');
});

test('clicking Live switches viewMode, adds the live-mode class, moves the active tab, and mounts the live UI', () => {
  const { window, layout, btnSingle, btnCollective, btnLive, livePanel, click } = boot();
  assert.strictEqual(window.AppState.viewMode, 'single');

  click(btnLive);

  assert.strictEqual(window.AppState.viewMode, 'live');
  assert.ok(layout.classList.contains('live-mode'), 'layout gains live-mode');
  assert.ok(btnLive.classList.contains('active'), 'Live tab is active');
  assert.ok(!btnSingle.classList.contains('active'), 'Single tab no longer active');
  assert.ok(!btnCollective.classList.contains('active'), 'Collective tab not active');
  assert.ok(window.GSRLiveView._mounted, 'GSRLiveView.mount ran');
  assert.ok(livePanel.classList.contains('live-view'), 'panel tagged .live-view for scoped styles');
  assert.ok(livePanel.querySelector('#statusBadge'), 'the live UI was built into the panel');
});

test('clicking Live twice is a no-op the second time (guarded on viewMode)', () => {
  const { window, layout, btnLive, click } = boot();
  click(btnLive);
  assert.doesNotThrow(() => click(btnLive));
  assert.strictEqual(window.AppState.viewMode, 'live');
  assert.ok(layout.classList.contains('live-mode'));
  assert.ok(btnLive.classList.contains('active'));
});

test('switching Live -> Single tears down live-mode and restores the single view', () => {
  const { window, layout, btnSingle, btnLive, click } = boot();
  click(btnLive);
  click(btnSingle);

  assert.strictEqual(window.AppState.viewMode, 'single');
  assert.ok(!layout.classList.contains('live-mode'), 'live-mode class removed');
  assert.ok(btnSingle.classList.contains('active'));
  assert.ok(!btnLive.classList.contains('active'), 'Live tab deactivated');
});

test('switching Live -> Collective tears down live-mode and enters collective-mode', () => {
  const { window, layout, btnCollective, btnLive, click } = boot();
  click(btnLive);
  click(btnCollective);

  assert.strictEqual(window.AppState.viewMode, 'collective');
  assert.ok(!layout.classList.contains('live-mode'), 'live-mode class removed');
  assert.ok(layout.classList.contains('collective-mode'), 'collective-mode class added');
  assert.ok(!btnLive.classList.contains('active'), 'Live tab deactivated');
});

test('the live UI stays mounted once built — Live -> Collective -> Live does not rebuild it', () => {
  const { window, btnCollective, btnLive, livePanel, click } = boot();
  click(btnLive);
  const badge = livePanel.querySelector('#statusBadge');
  assert.ok(badge, 'built on first open');

  click(btnCollective);
  click(btnLive);

  assert.strictEqual(livePanel.querySelector('#statusBadge'), badge, 'same element — not re-mounted');
  assert.strictEqual(window.AppState.viewMode, 'live');
});

test('the live view keyboard shortcuts only fire while Live is the active view', () => {
  const { window, document, btnSingle, btnLive, livePanel, click } = boot();
  const key = (k) => window.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true }));

  click(btnLive); // mounts + Live is active
  const mapBtn = livePanel.querySelector('#toggleMapBtn');
  const labelWhileLive = mapBtn.textContent;

  click(btnSingle); // Live listeners persist (mount-once), but must now stand down
  key('m');
  assert.strictEqual(mapBtn.textContent, labelWhileLive, '"m" is inert while Single is the active view');

  click(btnLive);
  key('m');
  assert.notStrictEqual(mapBtn.textContent, labelWhileLive, '"m" toggles the map again once Live is active');
});

test('in-app the live panel hides its own fullscreen button — the top-bar Full screen button covers it', () => {
  const { btnLive, livePanel, click } = boot();
  click(btnLive);
  const btn = livePanel.querySelector('#toggleFullscreenBtn');
  assert.ok(btn, 'the button is still in the shared markup');
  assert.strictEqual(btn.hidden, true, 'but hidden in-app (embedded === true)');
});

test('in-app the F key runs only the global fullscreen path, not the live view\'s own', () => {
  const { window, document, btnLive, click } = boot();
  const appContainer = document.querySelector('.app-container');
  let appReqs = 0, docElReqs = 0;
  appContainer.requestFullscreen = () => { appReqs++; return Promise.resolve(); };
  document.documentElement.requestFullscreen = () => { docElReqs++; return Promise.resolve(); };

  click(btnLive);
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'f', bubbles: true }));

  assert.strictEqual(appReqs, 1, 'GSRLayoutManager fullscreened .app-container');
  assert.strictEqual(docElReqs, 0, "the live view's own documentElement fullscreen did not also fire");
});

test('entering Live mode stops the p5 draw loop (noLoop), leaving the canvas idle', () => {
  const { window, btnLive, click } = boot();
  let noLoopCalls = 0;
  const realNoLoop = window.noLoop;
  window.noLoop = (...a) => { noLoopCalls++; return realNoLoop && realNoLoop.apply(window, a); };

  click(btnLive);

  assert.ok(noLoopCalls >= 1, 'noLoop() called on entering Live view');
});
