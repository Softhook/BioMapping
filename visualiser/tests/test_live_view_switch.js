/**
 * Characterisation tests for the "Live" view tab in the MAIN app (index.html).
 *
 * The Live receiver (live.html) is currently embedded in index.html as an
 * isolated <iframe> that the third header tab (Single Track / Collective /
 * Live) shows. These tests pin that view-switch contract down BEFORE the
 * planned full integration (live.html's logic moving into shared src/live/*
 * modules and a real in-page panel), so the switch behaviour — which tab is
 * active, the .main-layout mode class, lazy frame loading, and clean
 * teardown back to single/collective — is a regression net the integration
 * work has to keep satisfying.
 *
 * Boots the real index.html via tests/support/boot_app.js (same harness as
 * test_app_smoke.js). No track data is needed — the Live tab is independent
 * of the analysed-track pipeline.
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
    frame: document.getElementById('liveFrame'),
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

test('the embedded live frame ships with no src (deferred) and a data-src pointing at live.html', () => {
  const { frame } = boot();
  assert.ok(frame, '#liveFrame present');
  assert.strictEqual(frame.getAttribute('src'), null, 'no src until the tab is first opened');
  assert.strictEqual(frame.getAttribute('data-src'), 'live.html');
});

test('clicking Live switches viewMode, adds the live-mode layout class, and moves the active tab', () => {
  const { window, layout, btnSingle, btnCollective, btnLive, frame, click } = boot();
  assert.strictEqual(window.AppState.viewMode, 'single');

  click(btnLive);

  assert.strictEqual(window.AppState.viewMode, 'live');
  assert.ok(layout.classList.contains('live-mode'), 'layout gains live-mode');
  assert.ok(btnLive.classList.contains('active'), 'Live tab is active');
  assert.ok(!btnSingle.classList.contains('active'), 'Single tab no longer active');
  assert.ok(!btnCollective.classList.contains('active'), 'Collective tab not active');
  assert.ok(frame.src && /live\.html$/.test(frame.src), 'frame src is lazily set on first open');
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

test('the live frame stays loaded once opened — Live -> Collective -> Live does not reset its src', () => {
  const { window, btnCollective, btnLive, frame, click } = boot();
  click(btnLive);
  const srcAfterFirstOpen = frame.src;
  assert.ok(srcAfterFirstOpen, 'src set on first open');

  click(btnCollective);
  click(btnLive);

  assert.strictEqual(frame.src, srcAfterFirstOpen, 'src unchanged — an active BLE session survives a tab round-trip');
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
