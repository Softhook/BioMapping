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

test('entering Live mode stops the p5 draw loop (noLoop), leaving the canvas idle', () => {
  const { window, btnLive, click } = boot();
  let noLoopCalls = 0;
  const realNoLoop = window.noLoop;
  window.noLoop = (...a) => { noLoopCalls++; return realNoLoop && realNoLoop.apply(window, a); };

  click(btnLive);

  assert.ok(noLoopCalls >= 1, 'noLoop() called on entering Live view');
});
