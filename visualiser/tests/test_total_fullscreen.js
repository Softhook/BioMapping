const test = require('node:test');
const assert = require('node:assert');
const { bootApp } = require('./support/boot_app.js');

test('no small icon in panel headers', () => {
  const { window } = bootApp();
  window.setup();
  const doc = window.document;

  assert.strictEqual(doc.getElementById('btnMapTotalFullscreen'), null);
  assert.strictEqual(doc.getElementById('btnGsrTotalFullscreen'), null);
  assert.strictEqual(doc.querySelector('.total-fullscreen-btn'), null);
});

test('GSRLayoutManager programmatic display mode API', () => {
  const { window } = bootApp();
  window.setup();
  const doc = window.document;
  const lm = window.GSRLayoutManager;

  // With no panel fullscreen, enterDisplayMode is a safe no-op
  assert.strictEqual(lm.isDisplayMode, false);
  lm.enterDisplayMode();
  assert.strictEqual(lm.isDisplayMode, false);

  // Enter panel fullscreen on map
  const mapFsBtn = doc.getElementById('btnMapFullscreen');
  mapFsBtn.click();
  const overlay = doc.getElementById('mapPanel').parentNode;
  assert.strictEqual(overlay.classList.contains('panel-fullscreen-overlay'), true);

  // Enter display mode via API
  lm.enterDisplayMode();
  assert.strictEqual(lm.isDisplayMode, true);
  assert.strictEqual(window.AppState.isDisplayMode, true);
  assert.strictEqual(window.AppState.isTotalFullscreen, true);
  assert.strictEqual(overlay.classList.contains('display-mode'), true);
  assert.strictEqual(overlay.classList.contains('total-fullscreen'), true);

  // Exit display mode via API
  lm.exitDisplayMode();
  assert.strictEqual(lm.isDisplayMode, false);
  assert.strictEqual(window.AppState.isDisplayMode, false);
  assert.strictEqual(overlay.classList.contains('display-mode'), false);

  // Toggle display mode via API
  lm.toggleDisplayMode();
  assert.strictEqual(lm.isDisplayMode, true);
  lm.toggleDisplayMode();
  assert.strictEqual(lm.isDisplayMode, false);

  // Clean up
  mapFsBtn.click();
});

test('pressing F while in panel fullscreen toggles display mode', () => {
  const { window } = bootApp();
  window.setup();
  const doc = window.document;

  const mapFsBtn = doc.getElementById('btnMapFullscreen');
  mapFsBtn.click();
  const overlay = doc.getElementById('mapPanel').parentNode;
  assert.strictEqual(overlay.classList.contains('panel-fullscreen-overlay'), true);
  assert.strictEqual(overlay.classList.contains('display-mode'), false);
  assert.strictEqual(window.AppState.isDisplayMode, false);

  // Press 'f' -> enters display mode
  const evtF = new window.KeyboardEvent('keydown', { key: 'f', bubbles: true });
  doc.dispatchEvent(evtF);

  assert.strictEqual(overlay.classList.contains('display-mode'), true);
  assert.strictEqual(overlay.classList.contains('total-fullscreen'), true);
  assert.strictEqual(window.AppState.isDisplayMode, true);

  // Press 'f' again -> exits display mode back to normal fullscreen
  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'f', bubbles: true }));
  assert.strictEqual(overlay.classList.contains('display-mode'), false);
  assert.strictEqual(window.AppState.isDisplayMode, false);
  assert.strictEqual(doc.getElementById('mapPanel').parentNode, overlay, 'still in panel fullscreen overlay');

  // Also verify uppercase 'F'
  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'F', bubbles: true }));
  assert.strictEqual(overlay.classList.contains('display-mode'), true);
  assert.strictEqual(window.AppState.isDisplayMode, true);

  // Clean up
  mapFsBtn.click();
  assert.strictEqual(doc.querySelector('.panel-fullscreen-overlay'), null);
});

test('pressing Escape in display mode exits display mode first, then exits fullscreen on next Escape', () => {
  const { window } = bootApp();
  window.setup();
  const doc = window.document;

  const mapFsBtn = doc.getElementById('btnMapFullscreen');
  mapFsBtn.click();
  const overlay = doc.getElementById('mapPanel').parentNode;

  // Enter display mode via 'f'
  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'f', bubbles: true }));
  assert.strictEqual(overlay.classList.contains('display-mode'), true);

  // First Escape -> exits display mode, overlay remains
  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.strictEqual(overlay.classList.contains('display-mode'), false);
  assert.strictEqual(window.AppState.isDisplayMode, false);
  assert.strictEqual(doc.getElementById('mapPanel').parentNode, overlay, 'overlay still active');

  // Second Escape -> exits panel fullscreen completely
  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.strictEqual(doc.querySelector('.panel-fullscreen-overlay'), null, 'overlay removed');
});

test('GSR panel display mode toggles via F and cleans up on exit', () => {
  const { window } = bootApp();
  window.setup();
  const doc = window.document;

  const gsrFsBtn = doc.getElementById('btnGsrFullscreen');
  gsrFsBtn.click();
  const overlay = doc.getElementById('gsrPanel').parentNode;
  assert.strictEqual(overlay.classList.contains('panel-fullscreen-overlay'), true);

  // Press 'f'
  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'f', bubbles: true }));
  assert.strictEqual(overlay.classList.contains('display-mode'), true);
  assert.strictEqual(window.AppState.isDisplayMode, true);

  // Exiting panel fullscreen resets display mode state
  gsrFsBtn.click();
  assert.strictEqual(window.AppState.isDisplayMode, false);
  assert.strictEqual(doc.querySelector('.panel-fullscreen-overlay'), null);
});
