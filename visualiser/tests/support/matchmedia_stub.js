/**
 * jsdom implements no `window.matchMedia` at all (calling it throws
 * "is not a function" — confirmed directly). Both boot_app.js (index.html)
 * and boot_live.js (the live view) need one so
 * GSRLiveView.isCompactLayout()'s `matchMedia('(max-width: 768px) and
 * (pointer: coarse)')` check doesn't throw during a test boot. Shared here
 * so neither harness reimplements it — mirrors the existing `ResizeObserver`
 * stub precedent in boot_app.js.
 *
 * This only needs to satisfy a one-time `.matches` read (see
 * src/live/live_view.js's isCompactLiveLayout() — checked once at mount,
 * not live-updating), so addListener/addEventListener are harmless no-ops,
 * never expected to fire.
 */
function installMatchMedia(window, { compact = false } = {}) {
  window.matchMedia = (query) => ({
    matches: compact,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return false; },
  });
}

module.exports = { installMatchMedia };
