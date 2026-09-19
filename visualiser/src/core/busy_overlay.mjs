// Copyright (c) 2026 Christian Nold
// Licensed under the Bio Mapping Community Licence 1.0.
// See LICENCE.md in the project root for terms.

/**
 * Full-window "busy" spinner overlay for long synchronous work (project
 * import, preset-to-all-tracks, heavy peak detectors such as SparsEDA).
 *
 * The overlay fades in via a CSS animation delay (see .busy-overlay in
 * styles.css), so short jobs never flash it. Both the fade and the spinner
 * rotation are compositor-driven, so they keep animating while the main
 * thread is blocked.
 *
 * Calls nest: the overlay stays up until every begin() has been released.
 */

let depth = 0;
let overlayEl = null;
let labelEl = null;

function ensureOverlay() {
  if (overlayEl) return;
  overlayEl = document.createElement('div');
  overlayEl.className = 'busy-overlay';
  overlayEl.setAttribute('role', 'status');
  overlayEl.setAttribute('aria-live', 'polite');
  overlayEl.hidden = true;
  overlayEl.innerHTML =
    '<div class="busy-overlay-box">' +
    '<div class="busy-overlay-spinner"></div>' +
    '<div class="busy-overlay-label"></div>' +
    '</div>';
  labelEl = overlayEl.querySelector?.('.busy-overlay-label') ?? null;
  document.body?.appendChild(overlayEl);
}

// Two animation frames = the overlay has actually been painted. rAF never
// fires in a hidden tab, so a timeout backstop stops the work being deferred
// until the tab is next visible.
const nextPaint = () =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, 100);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        clearTimeout(timer);
        resolve();
      }),
    );
  });

export const BusyOverlay = {
  /**
   * Show the overlay. Returns a release function (idempotent).
   * @param {string} [label]
   */
  begin(label = 'Working…') {
    if (typeof document?.createElement !== 'function') return () => {};
    ensureOverlay();
    depth++;
    if (labelEl) labelEl.textContent = label;
    if (depth === 1) {
      // Re-trigger the delayed fade-in each time the overlay is shown.
      overlayEl.hidden = false;
      overlayEl.style.animation = 'none';
      void overlayEl.offsetWidth;
      overlayEl.style.animation = '';
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      depth = Math.max(0, depth - 1);
      if (depth === 0) overlayEl.hidden = true;
    };
  },

  /**
   * Show the overlay, let it paint, run fn (sync or async), then hide it.
   * @template T
   * @param {string} label
   * @param {() => T | Promise<T>} fn
   * @returns {Promise<T>}
   */
  async run(label, fn) {
    const release = this.begin(label);
    try {
      if (typeof requestAnimationFrame === 'function') await nextPaint();
      return await fn();
    } finally {
      release();
    }
  },
};
