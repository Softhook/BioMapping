/**
 * Untrusted input: data from an imported CSV / project zip and browsers that
 * block site storage. Boots the real app (tests/support/boot_app.js).
 */
const assert = require('node:assert');
const test = require('node:test');
const { bootApp } = require('./support/boot_app.js');

const EVIL = '<img src=x onerror="alert(1)">';

test('road profile: a road class from an imported CSV is shown as text, not HTML', async () => {
  const { window, document } = await bootApp();
  window.setup();
  const row = {
    name: EVIL,
    timeSpent: 60,
    effSamples: 10,
    meanPhasic: 0.2,
    stdPhasic: 0.3,
    ciPhasic: 0.2,
    meanTonic: 5,
    ciTonic: 0.1,
    peakRate: 2,
  };
  const other = { ...row, name: 'residential', meanPhasic: 0.1 };
  window.GSRUI.renderRoadProfile([row, other], null);

  const scope = [
    document.querySelector('#roadArousalTable tbody'),
    document.getElementById('roadBarChartContainer'),
    document.getElementById('roadInterpretationText'),
  ];
  for (const el of scope) {
    assert.strictEqual(el.querySelector('img'), null, el.innerHTML);
  }
  assert.ok(scope[0].textContent.includes(EVIL));
});

test('loadActiveTrackParams: a "__proto__" key in imported params does not pollute Object.prototype', async () => {
  const { window } = await bootApp();
  window.setup();
  const params = JSON.parse('{"__proto__": 1, "constructor": 2}');
  window.GSRTrackManager.loadActiveTrackParams({ filterParams: params });
  assert.strictEqual({}.value, undefined);
  assert.strictEqual(Object.value, undefined);
});

test('app boots when the browser blocks localStorage', async () => {
  const { window } = await bootApp();
  const blocked = {
    get() {
      throw new window.DOMException(
        'The operation is insecure.',
        'SecurityError',
      );
    },
    configurable: true,
  };
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(window, 'localStorage', blocked);
  Object.defineProperty(globalThis, 'localStorage', blocked);
  try {
    assert.doesNotThrow(() => window.setup());
    assert.doesNotThrow(() => window.GSRUI.openStreetView(51.5, -0.1, 'x', 0));
  } finally {
    if (saved) Object.defineProperty(globalThis, 'localStorage', saved);
    else delete globalThis.localStorage;
  }
});
