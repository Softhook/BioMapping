/**
 * Fullscreen lock/unlock restoration + wake-lock reacquisition.
 *
 * Mobile browsers drop fullscreen on their own when the OS takes the page
 * over (phone lock, app switch) — the user never asked to leave fullscreen,
 * so GSRFullscreen (src/core/fullscreen.js) re-asserts it the moment the page
 * becomes visible again. These tests pin that contract across all three
 * fullscreen surfaces:
 *
 *   1. the in-app Live view's edge-to-edge display mode (GSRLayoutManager),
 *   2. a panel's borderless display mode (map/GSR panel in index.html),
 *   3. the standalone live.html FAB's document-root fullscreen.
 *
 * jsdom implements none of the Fullscreen API (no requestFullscreen, no
 * fullscreenchange), so each test installs a tiny realistic stand-in that
 * flips `document.fullscreenElement` and fires `fullscreenchange` exactly the
 * way a browser would — plus a `drop()` helper that simulates the OS yanking
 * fullscreen away mid-lock.
 */

const test = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const { bootApp } = require('./support/boot_app.js');
const { bootLive } = require('./support/boot_live.js');

/** Minimal 2D context stub — drawGraph() touches it before its early return. */
function installCanvas2D(window) {
  const noop = () => {};
  window.HTMLCanvasElement.prototype.getContext = () => ({
    setTransform: noop,
    clearRect: noop,
    beginPath: noop,
    closePath: noop,
    moveTo: noop,
    lineTo: noop,
    arc: noop,
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
}

/**
 * Install a realistic Fullscreen API stand-in on one element. Returns
 * { active, requests, exits, drop } — `drop()` simulates the OS dropping
 * fullscreen (current element -> none) and fires fullscreenchange.
 */
function installFullscreen(window, targetEl) {
  const doc = window.document;
  let current = null;
  let requests = 0;
  let exits = 0;

  Object.defineProperty(doc, 'fullscreenElement', {
    configurable: true,
    get: () => current,
  });

  targetEl.requestFullscreen = () => {
    requests++;
    current = targetEl;
    doc.dispatchEvent(new window.Event('fullscreenchange'));
    return Promise.resolve();
  };
  doc.exitFullscreen = () => {
    exits++;
    current = null;
    doc.dispatchEvent(new window.Event('fullscreenchange'));
    return Promise.resolve();
  };

  return {
    get active() {
      return current !== null;
    },
    get requests() {
      return requests;
    },
    get exits() {
      return exits;
    },
    drop() {
      current = null;
      doc.dispatchEvent(new window.Event('fullscreenchange'));
    },
  };
}

/** Override jsdom's visibilityState and fire visibilitychange, as a browser does. */
function setVisibility(window, state) {
  Object.defineProperty(window.document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
  window.document.dispatchEvent(new window.Event('visibilitychange'));
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ==========================================================================
// In-app Live view display mode (index.html + GSRLayoutManager).
// ==========================================================================

async function bootInAppLive() {
  const { window } = await bootApp();
  installCanvas2D(window);
  window.setup();
  const document = window.document;
  const appContainer = document.querySelector('.app-container');
  const fs = installFullscreen(window, appContainer);
  const click = (el) =>
    el.dispatchEvent(new window.Event('click', { bubbles: true }));
  click(document.getElementById('btnLiveView'));
  return { window, document, appContainer, fs, click };
}

function pressF(window) {
  window.document.dispatchEvent(
    new window.KeyboardEvent('keydown', { key: 'f', bubbles: true }),
  );
}

test('Live display mode survives a phone lock/unlock — fullscreen is re-asserted on return', async () => {
  const { window, document, appContainer, fs } = await bootInAppLive();

  pressF(window);
  assert.ok(
    appContainer.classList.contains('live-display-mode'),
    'F enters live display mode',
  );
  assert.strictEqual(fs.requests, 1, 'one fullscreen request on entry');
  assert.strictEqual(window.AppState.isDisplayMode, true);

  // Phone lock: page hides, then the OS drops fullscreen (either order).
  setVisibility(window, 'hidden');
  fs.drop();
  assert.ok(
    appContainer.classList.contains('live-display-mode'),
    'chrome is kept while hidden — the user did not ask to leave display mode',
  );

  // Unlock: the sticky restore re-requests fullscreen.
  setVisibility(window, 'visible');
  assert.strictEqual(
    fs.requests,
    2,
    'fullscreen re-asserted on visibility return',
  );
  assert.strictEqual(fs.active, true);

  // Let the deferred teardown timer fire — it must see fullscreen as active
  // again and leave the chrome alone.
  await wait(200);
  assert.ok(
    appContainer.classList.contains('live-display-mode'),
    'display-mode chrome still in place after the deferred teardown window',
  );
  assert.strictEqual(window.AppState.isDisplayMode, true);
  assert.strictEqual(fs.requests, 2, 'no third request');
});

test('a deliberate exit (browser drops fullscreen while visible) tears down display mode and is NOT resurrected by a later lock/unlock', async () => {
  const { window, document, appContainer, fs } = await bootInAppLive();

  pressF(window);
  assert.ok(appContainer.classList.contains('live-display-mode'));

  // Esc / Android back: fullscreen exits while the page stays visible.
  fs.drop();
  await wait(200); // let the deferred teardown decide
  assert.ok(
    !appContainer.classList.contains('live-display-mode'),
    'display-mode chrome removed',
  );
  assert.strictEqual(window.AppState.isDisplayMode, false);

  // A subsequent lock/unlock must NOT bring it back.
  const requestsAfterExit = fs.requests;
  setVisibility(window, 'hidden');
  setVisibility(window, 'visible');
  await wait(50);
  assert.strictEqual(
    fs.requests,
    requestsAfterExit,
    'no fullscreen re-request after a genuine exit',
  );
  assert.ok(!appContainer.classList.contains('live-display-mode'));
});

// ==========================================================================
// Panel display mode (map panel in index.html).
// ==========================================================================

test('panel display mode re-asserts fullscreen after a lock/unlock', async () => {
  const { window } = await bootApp();
  window.setup();
  const doc = window.document;

  doc.getElementById('btnMapFullscreen').click();
  const overlay = doc.getElementById('mapPanel').parentNode;
  assert.ok(
    overlay.classList.contains('panel-fullscreen-overlay'),
    'panel lifted into its overlay',
  );

  const fs = installFullscreen(window, overlay);
  pressF(window); // enter display mode -> browser fullscreen on the overlay
  assert.strictEqual(fs.requests, 1);
  assert.ok(
    overlay.classList.contains('display-mode'),
    'display-mode class applied',
  );
  assert.strictEqual(window.AppState.isDisplayMode, true);

  setVisibility(window, 'hidden');
  fs.drop();
  assert.ok(
    overlay.classList.contains('display-mode'),
    'chrome kept while hidden',
  );

  setVisibility(window, 'visible');
  assert.strictEqual(
    fs.requests,
    2,
    'overlay fullscreen re-asserted on return',
  );
  assert.strictEqual(fs.active, true);

  await wait(200);
  assert.ok(
    overlay.classList.contains('display-mode'),
    'display mode intact after the teardown window',
  );

  // Clean up: exit panel fullscreen.
  doc.getElementById('btnMapFullscreen').click();
  assert.strictEqual(doc.querySelector('.panel-fullscreen-overlay'), null);
});

// ==========================================================================
// Standalone live.html (boot_live.js) — FAB fullscreen fallback.
// ==========================================================================

test('standalone FAB Full Screen is sticky across a lock/unlock', async () => {
  const { window } = await bootLive();
  const fs = installFullscreen(window, window.document.documentElement);

  const enterChip = window.document.querySelector(
    '[data-action="enter-fullscreen"]',
  );
  assert.ok(enterChip, 'FAB renders an enter-fullscreen chip');
  enterChip.dispatchEvent(new window.Event('click', { bubbles: true }));
  assert.strictEqual(
    fs.requests,
    1,
    'FAB chip entered document-root fullscreen',
  );
  assert.strictEqual(fs.active, true);

  setVisibility(window, 'hidden');
  fs.drop();
  setVisibility(window, 'visible');
  assert.strictEqual(
    fs.requests,
    2,
    'standalone fullscreen re-asserted on return',
  );
  assert.strictEqual(fs.active, true);

  // The FAB chip should now read "Exit Full Screen".
  const exitChip = window.document.querySelector(
    '[data-action="exit-fullscreen"]',
  );
  assert.ok(exitChip, 'FAB flips to the exit chip once fullscreen is active');
});

test('standalone FAB Exit Full Screen clears the sticky target', async () => {
  const { window } = await bootLive();
  const fs = installFullscreen(window, window.document.documentElement);

  window.document
    .querySelector('[data-action="enter-fullscreen"]')
    .dispatchEvent(new window.Event('click', { bubbles: true }));
  assert.strictEqual(fs.requests, 1);

  window.document
    .querySelector('[data-action="exit-fullscreen"]')
    .dispatchEvent(new window.Event('click', { bubbles: true }));
  assert.strictEqual(fs.active, false, 'exited fullscreen');

  // A later lock/unlock must not resurrect it.
  setVisibility(window, 'hidden');
  setVisibility(window, 'visible');
  await wait(50);
  assert.strictEqual(fs.requests, 1, 'no re-request after an explicit exit');
});

// ==========================================================================
// File-dialog "Restore Fullscreen" pill (src/ui/tracks.js).
// ==========================================================================

test('the file-dialog "Restore Fullscreen" pill re-enters fullscreen on click', async () => {
  const { window, document } = await bootApp();
  installCanvas2D(window);
  window.setup();
  const appContainer = document.querySelector('.app-container');
  const fs = installFullscreen(window, appContainer);

  window.GSRTrackManager._showRestoreFsPill();
  const pill = [...document.querySelectorAll('div')].find((d) =>
    /Restore Fullscreen/.test(d.textContent),
  );
  assert.ok(pill, 'restore-fullscreen pill is shown');

  pill.dispatchEvent(new window.Event('click', { bubbles: true }));
  assert.strictEqual(
    fs.requests,
    1,
    'pill click re-requests fullscreen on .app-container',
  );
  assert.strictEqual(fs.active, true);
});

// ==========================================================================
// Wake lock — re-acquired when the page comes back visible while connected.
// ==========================================================================

test('screen wake lock is re-acquired on visibility return while connected', async (t) => {
  const { window } = await bootLive();
  let wakeRequests = 0;
  window.navigator.wakeLock = {
    request: async () => {
      wakeRequests++;
      return { released: false, release: async () => {} };
    },
  };

  const run = (expr) => vm.runInThisContext(expr);
  run("LiveState.setStatus('connected')");
  await wait(0);
  assert.strictEqual(
    wakeRequests,
    1,
    'connected status acquires the wake lock once',
  );

  setVisibility(window, 'hidden');
  setVisibility(window, 'visible');
  await wait(0);
  assert.strictEqual(
    wakeRequests,
    2,
    'returning to the foreground re-acquires it',
  );

  t.after(() => {
    try {
      run("LiveState.setStatus('disconnected')");
    } catch {
      /* torn down */
    }
  });
});

test('no wake lock is acquired on visibility return while disconnected', async () => {
  const { window } = await bootLive();
  let wakeRequests = 0;
  window.navigator.wakeLock = {
    request: async () => {
      wakeRequests++;
      return { released: false, release: async () => {} };
    },
  };

  setVisibility(window, 'hidden');
  setVisibility(window, 'visible');
  await wait(0);
  assert.strictEqual(wakeRequests, 0, 'disconnected -> no wake lock request');
});
