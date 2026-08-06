'use strict';

const assert = require('assert');
const test   = require('node:test');
const fs     = require('fs');
const path   = require('path');
const vm     = require('vm');

const { GSRErrors } = require('../error_handler.js');

test('GSRErrors.report: logs without throwing in a no-DOM environment', () => {
  // No window/document globals are set here, so _toast() must no-op gracefully.
  assert.doesNotThrow(() => GSRErrors.report(new Error('boom'), 'unit-test'));
  assert.doesNotThrow(() => GSRErrors.report('plain message'));
});

test('GSRErrors.report: creates a visible, non-blocking toast when a DOM exists', () => {
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

  GSRErrors.report(new Error('surfaced'), 'test-context');

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

test('GSRErrors.report: reuses the existing container instead of stacking new ones', () => {
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

  GSRErrors.report('first');
  GSRErrors.report('second');

  assert.strictEqual(bodyChildren.length, 0, 'no new container appended — the existing one is reused');
  assert.strictEqual(container.children.length, 2, 'both toasts were added to the shared container');

  delete global.document;
});

test('GSRErrors: window error/unhandledrejection hooks surface uncaught errors', () => {
  // Load error_handler.js into a fake window so its load-time listener wiring
  // runs, then dispatch an uncaught error through the registered hook and
  // verify a toast appears (the core "don't fail silently" guarantee).
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

  const src = fs.readFileSync(path.join(__dirname, '../error_handler.js'), 'utf8');
  vm.runInNewContext(src, { window: fakeWindow, document: fakeDocument, console, setTimeout });

  assert.strictEqual(typeof listeners.error, 'function', 'window error hook registered');
  assert.strictEqual(typeof listeners.unhandledrejection, 'function', 'unhandledrejection hook registered');

  // Simulate an uncaught error (window 'error' event with .error populated).
  listeners.error({ error: new Error('uncaught boom'), message: 'uncaught boom' });
  assert.strictEqual(bodyChildren.length, 1, 'toast container appears on uncaught error');
  const toast = bodyChildren[0].children[0];
  assert.ok(toast.textContent.includes('uncaught boom'), 'toast surfaces the uncaught error message');
});
