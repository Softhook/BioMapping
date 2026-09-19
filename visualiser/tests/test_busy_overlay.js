// Copyright (c) 2026 Christian Nold
// Licensed under the Bio Mapping Community Licence 1.0.
// See LICENCE.md in the project root for terms.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

let BusyOverlay;

function makeEl() {
  const el = {
    hidden: false,
    style: {},
    offsetWidth: 0,
    children: [],
    attrs: {},
    setAttribute(k, v) {
      this.attrs[k] = v;
    },
    querySelector() {
      return label;
    },
    appendChild(c) {
      this.children.push(c);
    },
  };
  return el;
}
let label;
let created;

beforeEach(async () => {
  label = { textContent: '' };
  created = [];
  global.document = {
    body: makeEl(),
    createElement() {
      const el = makeEl();
      created.push(el);
      return el;
    },
  };
  // Fresh module state (depth / overlay element) per test.
  BusyOverlay = (
    await import(`../src/core/busy_overlay.mjs?t=${Math.random()}`)
  ).BusyOverlay;
});

test('begin shows the overlay with the label; release hides it', () => {
  const release = BusyOverlay.begin('Doing it…');
  assert.strictEqual(created[0].hidden, false);
  assert.strictEqual(label.textContent, 'Doing it…');
  release();
  assert.strictEqual(created[0].hidden, true);
});

test('nested begins keep the overlay up until every one is released', () => {
  const a = BusyOverlay.begin('a');
  const b = BusyOverlay.begin('b');
  a();
  assert.strictEqual(created[0].hidden, false);
  b();
  assert.strictEqual(created[0].hidden, true);
});

test('release is idempotent and cannot underflow the depth counter', () => {
  const a = BusyOverlay.begin('a');
  a();
  a();
  const b = BusyOverlay.begin('b');
  assert.strictEqual(created[0].hidden, false);
  b();
  assert.strictEqual(created[0].hidden, true);
});

test('run hides the overlay even when the callback throws', async () => {
  await assert.rejects(
    BusyOverlay.run('x', () => {
      throw new Error('boom');
    }),
    /boom/,
  );
  assert.strictEqual(created[0].hidden, true);
});

test('run returns the callback result (sync or async)', async () => {
  assert.strictEqual(await BusyOverlay.run('x', () => 7), 7);
  assert.strictEqual(await BusyOverlay.run('x', async () => 8), 8);
});

test('without a DOM, begin/run are harmless no-ops', async () => {
  global.document = undefined;
  BusyOverlay.begin('x')();
  assert.strictEqual(await BusyOverlay.run('x', () => 1), 1);
});
