/**
 * Proves the ES-module migration's chosen test-harness technique
 * (jsdom-global + dynamic import(), see boot_pilot.js) against the pilot
 * files in this directory, before it's applied to the real 93-file app.
 * Not part of the real suite — run directly: node tests/manual/esm_migration/pilot/test_pilot.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { bootPilot } = require('./boot_pilot.js');

test('pure leaf module (GeoUtils) imports and computes correctly', async () => {
  const { mod } = await bootPilot();
  const d = mod.GeoUtils.distanceMeters(0, 0, 0, 1);
  assert.ok(
    Math.abs(d - 111320) < 50,
    `expected ~111320m for 1 degree of longitude at the equator, got ${d}`,
  );
});

test('core file resolves bare `document` via the jsdom-global bridge', async () => {
  const { mod, document } = await bootPilot({ cacheBust: 'a' });
  mod.NoticeCore.show('hello');
  assert.equal(document.getElementById('notice').textContent, 'hello');
});

test('core file composes its augment module (Object.assign + `this`)', async () => {
  const { mod, document } = await bootPilot({ cacheBust: 'b' });
  assert.equal(
    typeof mod.NoticeCore.showUrgent,
    'function',
    'augment method should be composed onto the core object',
  );
  mod.NoticeCore.showUrgent('fire');
  assert.equal(document.getElementById('notice').textContent, 'URGENT: fire');
});

test('cache-busted import() of the SPECIFIC target module gives a fresh instance, replacing require.cache deletion', async () => {
  // Busting only the entry (not the module actually under test) does NOT
  // isolate it — Node's loader still caches notice_core.mjs by its own
  // plain (non-busted) specifier the first time anything reaches it, shared
  // across every entry variant. Confirmed by this failing before the fix
  // below when busting `entry.mjs` instead of `notice_core.mjs` directly.
  const first = await bootPilot({
    cacheBust: 'first',
    entry: 'notice_core.mjs',
  });
  first.mod.NoticeCore.__marker = 'seen';

  const second = await bootPilot({
    cacheBust: 'second',
    entry: 'notice_core.mjs',
  });
  assert.equal(
    second.mod.NoticeCore.__marker,
    undefined,
    'a fresh cache-busted import must not see state mutated on a previous import',
  );
});
