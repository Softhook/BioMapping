/**
 * Regression coverage for the DOM/CSS hotspot pulse-ring overlay
 * (docs/visualizer_rendering_perf_routes.md §2.5) that replaced the old
 * per-frame canvas-painted pulse. GSRRenderer._syncPulseRing()/
 * _prunePulseRings()/clearPulseRings() are the only thing standing between
 * "renders on demand" and "silently piles up orphaned DOM nodes forever" —
 * this doesn't need a real browser/CSS engine to catch that class of bug,
 * just real DOM structure, which jsdom (via bootApp()) provides faithfully.
 * Actual CSS animation behavior (does it visually pulse) was verified
 * separately against a live browser, not here — jsdom doesn't run a real
 * CSS engine, so animation-name/keyframe assertions would be meaningless.
 *
 * Run: node --test tests/test_hotspot_pulse_overlay.js
 */
const assert = require('assert');
const test = require('node:test');
const { bootApp } = require('./support/boot_app.js');

test('_syncPulseRing creates a positioned div under #canvasContainer, keyed for reuse', () => {
  const { window, document } = bootApp();
  const { GSRRenderer } = window;

  GSRRenderer._syncPulseRing('0:upper', 100, 50, 6, '#ff1744');

  const overlay = document.getElementById('hotspotPulseOverlay');
  assert.ok(overlay, 'overlay div was created');
  assert.strictEqual(overlay.parentElement.id, 'canvasContainer');

  const rings = overlay.querySelectorAll('.graph-hotspot-pulse');
  assert.strictEqual(rings.length, 1);
  const ring = rings[0];
  const d = 6 * 2.33;
  assert.strictEqual(ring.style.width, d + 'px');
  assert.strictEqual(ring.style.height, d + 'px');
  assert.strictEqual(ring.style.left, (100 - d / 2) + 'px');
  assert.strictEqual(ring.style.top, (50 - d / 2) + 'px');
});

test('_syncPulseRing called again with the same key reuses the element (repositions, does not duplicate)', () => {
  const { window, document } = bootApp();
  const { GSRRenderer } = window;

  GSRRenderer._syncPulseRing('0:upper', 100, 50, 6, '#ff1744');
  const overlay = document.getElementById('hotspotPulseOverlay');
  const firstEl = overlay.querySelector('.graph-hotspot-pulse');

  GSRRenderer._syncPulseRing('0:upper', 120, 80, 6, '#ff1744');

  const rings = overlay.querySelectorAll('.graph-hotspot-pulse');
  assert.strictEqual(rings.length, 1, 'still exactly one ring — the same key must not create a second element');
  assert.strictEqual(rings[0], firstEl, 'the same DOM node was reused, not replaced (this is what keeps the CSS animation timeline uninterrupted)');
  const d = 6 * 2.33;
  assert.strictEqual(rings[0].style.left, (120 - d / 2) + 'px', 'position was updated on the reused element');
});

test('a distinct key creates a distinct element alongside the first', () => {
  const { window, document } = bootApp();
  const { GSRRenderer } = window;

  GSRRenderer._syncPulseRing('0:upper', 100, 50, 6, '#ff1744');
  GSRRenderer._syncPulseRing('0:lower', 100, 200, 6, '#ff1744');

  const overlay = document.getElementById('hotspotPulseOverlay');
  assert.strictEqual(overlay.querySelectorAll('.graph-hotspot-pulse').length, 2);
});

test('_prunePulseRings removes only the keys not in the current seen set', () => {
  const { window, document } = bootApp();
  const { GSRRenderer } = window;

  GSRRenderer._syncPulseRing('0:upper', 100, 50, 6, '#ff1744');
  GSRRenderer._syncPulseRing('1:upper', 200, 50, 6, '#ff1744');
  GSRRenderer._syncPulseRing('2:upper', 300, 50, 6, '#ff1744');

  GSRRenderer._prunePulseRings(new Set(['0:upper', '2:upper']));

  const overlay = document.getElementById('hotspotPulseOverlay');
  const rings = overlay.querySelectorAll('.graph-hotspot-pulse');
  assert.strictEqual(rings.length, 2, 'the untouched key (1:upper) was pruned, the other two survive');
  assert.strictEqual(GSRRenderer._pulseRingEls.has('1:upper'), false, 'the internal key map was also cleaned up, not just the DOM');
  assert.strictEqual(GSRRenderer._pulseRingEls.has('0:upper'), true);
  assert.strictEqual(GSRRenderer._pulseRingEls.has('2:upper'), true);
});

test('clearPulseRings removes every ring and empties the tracking map', () => {
  const { window, document } = bootApp();
  const { GSRRenderer } = window;

  GSRRenderer._syncPulseRing('0:upper', 100, 50, 6, '#ff1744');
  GSRRenderer._syncPulseRing('0:lower', 100, 200, 6, '#ff1744');

  GSRRenderer.clearPulseRings();

  const overlay = document.getElementById('hotspotPulseOverlay');
  assert.strictEqual(overlay.querySelectorAll('.graph-hotspot-pulse').length, 0);
  assert.strictEqual(GSRRenderer._pulseRingEls.size, 0);
});

test('drawPlaceholder() clears any leftover pulse rings — the "nothing to show" path can\'t leave stale rings floating over it', () => {
  const { window, document } = bootApp();
  const { GSRRenderer } = window;

  GSRRenderer._syncPulseRing('0:upper', 100, 50, 6, '#ff1744');
  const overlay = document.getElementById('hotspotPulseOverlay');
  assert.strictEqual(overlay.querySelectorAll('.graph-hotspot-pulse').length, 1, 'sanity check: the ring exists before drawPlaceholder()');

  GSRRenderer.drawPlaceholder();

  assert.strictEqual(overlay.querySelectorAll('.graph-hotspot-pulse').length, 0);
});

test('drawHotspotMarkers() clears pulse rings when showHotspots is off, even if memorableEvents is non-empty (stale state from before the toggle)', () => {
  const { window, document } = bootApp();
  const { GSRRenderer, AppState } = window;

  // Seed a ring directly (simulating one left over from before the toggle),
  // matching real usage — a real drawHotspotMarkers() call is what created it.
  GSRRenderer._syncPulseRing('0:upper', 100, 50, 6, '#ff1744');
  const overlay = document.getElementById('hotspotPulseOverlay');
  assert.strictEqual(overlay.querySelectorAll('.graph-hotspot-pulse').length, 1);

  AppState.showHotspots = false;
  AppState.analyzer = { memorableEvents: [{ index: 0, onsetIndex: 0, time: 0 }], peaks: [] };
  GSRRenderer.drawHotspotMarkers(0, 10, 0, 1, 0, 100, 0, 1, 100, 200, true);

  assert.strictEqual(overlay.querySelectorAll('.graph-hotspot-pulse').length, 0, 'toggling hotspots off must not leave a stale pulsing ring on screen');
});
