'use strict';

const assert = require('assert');
const test   = require('node:test');
const fs     = require('fs');
const path   = require('path');
const vm     = require('vm');
const { JSDOM } = require('jsdom');

const { GSRNotices } = require('../src/core/notices.js');

test('GSRNotices.report: logs without throwing in a no-DOM environment', () => {
  // No window/document globals are set here, so _toast() must no-op gracefully.
  assert.doesNotThrow(() => GSRNotices.report(new Error('boom'), 'unit-test'));
  assert.doesNotThrow(() => GSRNotices.report('plain message'));
  assert.doesNotThrow(() => GSRNotices.warn('plain warning'));
});

test('GSRNotices.report: creates a visible, non-blocking toast when a DOM exists', () => {
  // Minimal DOM stub (same approach as test_file_saver.js) — just enough for
  // getElementById/createElement/appendChild/remove used by _toast().
  let bodyChildren = [];
  const makeNode = () => ({
    style: {}, children: [], textContent: '', title: '', id: '',
    remove() { bodyChildren = bodyChildren.filter(n => n !== this); },
    appendChild(c) { this.children.push(c); },
    addEventListener() {},
  });

  global.document = {
    createElement: () => makeNode(),
    getElementById: () => null,
    body: { appendChild(c) { bodyChildren.push(c); } },
  };

  GSRNotices.report(new Error('surfaced'), 'test-context');

  assert.strictEqual(bodyChildren.length, 1, 'a toast container is appended to body');
  const container = bodyChildren[0];
  assert.strictEqual(container.id, 'gsr-error-toasts');
  assert.strictEqual(container.children.length, 1, 'container holds one toast');
  const toast = container.children[0];
  assert.ok(toast.textContent.includes('surfaced'), 'toast shows the error message');
  assert.ok(toast.textContent.includes('test-context'), 'toast shows the reporting context');
  assert.strictEqual(toast.style.background, '#7f1d1d', 'toast uses the error styling');

  delete global.document;
});

test('GSRNotices.report: reuses the existing container instead of stacking new ones', () => {
  let bodyChildren = [];
  const makeNode = () => ({
    style: {}, children: [], textContent: '', title: '', id: '',
    remove() { bodyChildren = bodyChildren.filter(n => n !== this); },
    appendChild(c) { this.children.push(c); },
    addEventListener() {},
  });
  const container = makeNode();
  container.id = 'gsr-error-toasts';

  global.document = {
    createElement: () => makeNode(),
    getElementById: (id) => (id === 'gsr-error-toasts' ? container : null),
    body: { appendChild(c) { bodyChildren.push(c); } },
  };

  GSRNotices.report('first');
  GSRNotices.report('second');

  assert.strictEqual(bodyChildren.length, 0, 'no new container appended — the existing one is reused');
  assert.strictEqual(container.children.length, 2, 'both toasts were added to the shared container');

  delete global.document;
});

test('GSRNotices: window error/unhandledrejection hooks surface uncaught errors', () => {
  // Load notices.js into a fake window so its load-time listener wiring runs,
  // then dispatch an uncaught error through the registered hook and verify a
  // toast appears (the core "don't fail silently" guarantee).
  const listeners = {};
  const fakeWindow = {
    addEventListener: (type, fn) => { listeners[type] = fn; },
  };

  let bodyChildren = [];
  const makeNode = () => ({
    style: {}, children: [], textContent: '', title: '', id: '',
    remove() {}, appendChild(c) { this.children.push(c); }, addEventListener() {},
  });
  const fakeDocument = {
    createElement: () => makeNode(),
    getElementById: () => null,
    body: { appendChild(c) { bodyChildren.push(c); } },
  };

  const src = fs.readFileSync(path.join(__dirname, '../src/core/notices.js'), 'utf8');
  vm.runInNewContext(src, { window: fakeWindow, document: fakeDocument, console, setTimeout });

  assert.strictEqual(typeof listeners.error, 'function', 'window error hook registered');
  assert.strictEqual(typeof listeners.unhandledrejection, 'function', 'unhandledrejection hook registered');

  // Simulate an uncaught error (window 'error' event with .error populated).
  listeners.error({ error: new Error('uncaught boom'), message: 'uncaught boom' });
  assert.strictEqual(bodyChildren.length, 1, 'toast container appears on uncaught error');
  const toast = bodyChildren[0].children[0];
  assert.ok(toast.textContent.includes('uncaught boom'), 'toast surfaces the uncaught error message');
});

test('GSRNotices: benign ResizeObserver loop diagnostic does not spawn a red toast', () => {
  // Regression for: "223 notices ... [GSRNotices:window.onerror] ResizeObserver
  // loop completed with undelivered notifications." Browsers fire this harmless
  // diagnostic through window.onerror when a ResizeObserver callback resizes an
  // observed element in the same frame (Leaflet invalidateSize / p5
  // resizeCanvas are classic triggers). Surfacing it as a red error toast was
  // pure noise — a resize burst can emit hundreds. Known-benign diagnostics
  // must be swallowed by the onerror hook, while real errors still toast.
  const listeners = {};
  const fakeWindow = {
    addEventListener: (type, fn) => { listeners[type] = fn; },
  };

  let bodyChildren = [];
  const makeNode = () => ({
    style: {}, children: [], textContent: '', title: '', id: '',
    remove() {}, appendChild(c) { this.children.push(c); }, addEventListener() {},
  });
  const fakeDocument = {
    createElement: () => makeNode(),
    getElementById: () => null,
    body: { appendChild(c) { bodyChildren.push(c); } },
  };

  const src = fs.readFileSync(path.join(__dirname, '../src/core/notices.js'), 'utf8');
  vm.runInNewContext(src, { window: fakeWindow, document: fakeDocument, console, setTimeout });

  // Fire the benign diagnostic exactly as browsers do (message on the event,
  // no error object).
  listeners.error({ error: undefined, message: 'ResizeObserver loop completed with undelivered notifications.' });
  assert.strictEqual(bodyChildren.length, 0, 'benign ResizeObserver diagnostic must not create a toast');

  // Sanity: a real error on the same hook still toasts — the filter is narrow.
  listeners.error({ error: new Error('real boom'), message: 'real boom' });
  assert.strictEqual(bodyChildren.length, 1, 'a real error still toasts after the benign one was swallowed');
});

test('GSRNotices.warn: shows an amber toast (not the red error toast)', () => {
  let bodyChildren = [];
  const makeNode = () => ({
    style: {}, children: [], textContent: '', title: '', id: '',
    remove() {}, appendChild(c) { this.children.push(c); }, addEventListener() {},
  });
  global.document = {
    createElement: () => makeNode(),
    getElementById: () => null,
    body: { appendChild(c) { bodyChildren.push(c); } },
  };

  GSRNotices.warn('careful now', 'warn-ctx');

  assert.strictEqual(bodyChildren.length, 1, 'toast container appended');
  const toast = bodyChildren[0].children[0];
  assert.ok(toast.textContent.includes('careful now'), 'toast shows the warning message');
  assert.ok(toast.textContent.includes('warn-ctx'), 'toast shows the warning context');
  assert.strictEqual(toast.style.background, '#92400e', 'warning uses amber styling, distinct from the red error toast');

  delete global.document;
});

test('GSRNotices.warn: { toast: false } logs only and creates no toast', () => {
  let bodyChildren = [];
  global.document = {
    createElement: () => ({ style: {}, children: [], textContent: '', title: '', id: '',
      remove() {}, appendChild(c) { this.children.push(c); }, addEventListener() {} }),
    getElementById: () => null,
    body: { appendChild(c) { bodyChildren.push(c); } },
  };

  GSRNotices.warn('log only, no toast', 'ctx', { toast: false });

  assert.strictEqual(bodyChildren.length, 0, 'no toast created when toast:false (e.g. a modal already shows the warning)');
  delete global.document;
});

// ── dialog: generic decision modal ───────────────────────────────────────────

test('GSRNotices.dialog: resolves null when there is no DOM', async () => {
  delete global.document;
  const action = await GSRNotices.dialog({
    title: 'T', message: 'M', buttons: [{ label: 'OK', value: 'ok' }],
  });
  assert.strictEqual(action, null);
});

test('GSRNotices.dialog: resolves with the clicked button value and removes the overlay', async () => {
  const dom = new JSDOM('<!doctype html><body></body>');
  global.document = dom.window.document;
  try {
    const p = GSRNotices.dialog({
      title: 'Unsaved Labels',
      message: 'You have unsaved peak labels.',
      buttons: [
        { label: 'Export CSV', value: 'export', style: 'primary' },
        { label: 'Lose Labels', value: 'lose', style: 'danger' },
      ],
      dismissLabel: 'Cancel',
      tone: 'warn',
    });

    const buttons = dom.window.document.querySelectorAll('button');
    assert.strictEqual(buttons.length, 3, 'two action buttons plus a Cancel button');
    assert.ok(dom.window.document.body.textContent.includes('Unsaved Labels'), 'dialog title rendered');
    assert.ok(dom.window.document.body.textContent.includes('unsaved peak labels'), 'dialog message rendered');

    buttons[0].click(); // Export CSV
    const action = await p;
    assert.strictEqual(action, 'export', 'resolves with the clicked button value');
    assert.strictEqual(dom.window.document.querySelectorAll('body *').length, 0, 'overlay is removed after choosing');
  } finally {
    delete global.document;
    dom.window.close();
  }
});

test('GSRNotices.dialog: resolves null on the dismiss (Cancel) button', async () => {
  const dom = new JSDOM('<!doctype html><body></body>');
  global.document = dom.window.document;
  try {
    const p = GSRNotices.dialog({
      title: 'T', message: 'M',
      buttons: [{ label: 'Go', value: 'go' }],
      dismissLabel: 'Cancel',
    });
    const cancel = [...dom.window.document.querySelectorAll('button')].find(b => b.textContent === 'Cancel');
    assert.ok(cancel, 'Cancel button exists');
    cancel.click();
    assert.strictEqual(await p, null, 'dismiss resolves null');
  } finally {
    delete global.document;
    dom.window.close();
  }
});

test('GSRNotices.dialog: resolves null on Escape', async () => {
  const dom = new JSDOM('<!doctype html><body></body>');
  global.document = dom.window.document;
  try {
    const p = GSRNotices.dialog({ title: 'T', message: 'M' });
    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' }));
    assert.strictEqual(await p, null, 'Escape dismisses with null');
  } finally {
    delete global.document;
    dom.window.close();
  }
});

test('GSRNotices.dialog: resolves null on overlay (outside) click', async () => {
  const dom = new JSDOM('<!doctype html><body></body>');
  global.document = dom.window.document;
  try {
    const p = GSRNotices.dialog({ title: 'T', message: 'M' });
    const overlay = dom.window.document.body.firstElementChild;
    overlay.click(); // event target is the overlay itself -> dismiss
    assert.strictEqual(await p, null, 'clicking outside the card dismisses with null');
  } finally {
    delete global.document;
    dom.window.close();
  }
});

test('GSRNotices.dialog: is announced as a dialog and moves focus to its first button', async () => {
  const dom = new JSDOM('<!doctype html><body></body>');
  global.document = dom.window.document;
  try {
    const p = GSRNotices.dialog({
      title: 'Replace Tracks', message: 'Continue?',
      buttons: [{ label: 'Import', value: 'import' }],
      dismissLabel: 'Cancel',
    });
    const card = dom.window.document.querySelector('[role="dialog"]');
    assert.ok(card, 'card is exposed as a dialog role');
    assert.strictEqual(card.getAttribute('aria-modal'), 'true');
    assert.ok(card.getAttribute('aria-labelledby'), 'dialog is labelled by its title');
    const titleEl = dom.window.document.getElementById(card.getAttribute('aria-labelledby'));
    assert.ok(titleEl && titleEl.textContent === 'Replace Tracks', 'aria-labelledby points at the title');
    const firstButton = dom.window.document.querySelector('[role="dialog"] button');
    assert.strictEqual(dom.window.document.activeElement, firstButton, 'focus moves into the dialog, on the first button');
    firstButton.click();
    await p;
  } finally {
    delete global.document;
    dom.window.close();
  }
});

test('GSRNotices.dialog: restores focus to the trigger when it closes', async () => {
  const dom = new JSDOM('<!doctype html><body><button id="trigger">Open</button></body>');
  global.document = dom.window.document;
  try {
    const trigger = dom.window.document.getElementById('trigger');
    trigger.focus();
    assert.strictEqual(dom.window.document.activeElement, trigger, 'setup: trigger has focus');

    const p = GSRNotices.dialog({ title: 'T', message: 'M', buttons: [{ label: 'OK', value: 'ok' }] });
    // Focus moved into the dialog first...
    assert.notStrictEqual(dom.window.document.activeElement, trigger, 'focus leaves the trigger while the dialog is open');
    // ...and returns after choosing.
    dom.window.document.querySelector('[role="dialog"] button').click();
    await p;
    assert.strictEqual(dom.window.document.activeElement, trigger, 'focus is restored to the trigger');
  } finally {
    delete global.document;
    dom.window.close();
  }
});
