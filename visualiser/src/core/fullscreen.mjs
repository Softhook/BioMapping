/**
 * GSRFullscreen — cross-browser Fullscreen API wrapper plus "sticky"
 * re-assertion across app background/foreground cycles.
 *
 * Why sticky: mobile browsers drop fullscreen on their own when the OS takes
 * the page over (phone lock, app switch) — the user never asked to leave
 * fullscreen, so the app re-asserts it the moment they return. Browsers
 * reject requestFullscreen() while the page is hidden, so the re-request is
 * deferred to the visibilitychange → visible transition rather than fired
 * inside the fullscreenchange that announced the drop.
 *
 * Contract: `request()` remembers the element it fullscreened (`_target`);
 * `exit()`/`clearTarget()` clear that memory. On visibility return the module
 * re-requests `_target` only while it is still set — i.e. only while the
 * caller still wants that element fullscreen. Callers that tear down their own
 * display-mode chrome on a genuine exit (Esc / F11 / Android back) must clear
 * the target as part of that teardown, so a later lock/unlock can't resurrect
 * a fullscreen the user deliberately left.
 *
 * Loaded before layout_manager.js and live_view.js in BOTH entry points
 * (index.html and live.html); the order is mirrored by SCRIPT_ORDER in
 * tests/support/boot_app.js and LIVE_SCRIPT_ORDER in
 * tests/support/boot_live.js, cross-checked against the real HTML by
 * tests/test_html_wiring.js.
 */
export const GSRFullscreen = {
  _target: null,
  _listeners: new Set(),
  _bound: false,

  /** Whether any element is currently browser-fullscreen. */
  get active() {
    return !!(
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      document.mozFullScreenElement
    );
  },

  /**
   * Enter fullscreen on `el` (defaults to the document root) and remember it
   * as the sticky target. Resolves true when the request succeeded; false
   * when the API is unsupported or was rejected (after one retry without the
   * options bag, which some older engines reject outright). On failure the
   * sticky target is cleared so a lock/unlock can't retry a dead request.
   */
  async request(el, options = { navigationUI: 'hide' }) {
    const target = el || document.documentElement;
    const fn =
      target.requestFullscreen ||
      target.webkitRequestFullscreen ||
      target.mozRequestFullScreen;
    if (!fn) return false;

    this._target = target;
    try {
      await fn.call(target, options);
      return true;
    } catch (_err) {
      try {
        await fn.call(target);
        return true;
      } catch (_err2) {
        if (this._target === target) this._target = null;
        return false;
      }
    }
  },

  /**
   * Leave fullscreen and drop the sticky target. Safe to call when not
   * fullscreen (resolves false).
   */
  async exit() {
    this._target = null;
    const fn =
      document.exitFullscreen ||
      document.webkitExitFullscreen ||
      document.mozCancelFullScreen;
    if (!fn) return false;
    try {
      await fn.call(document);
      return true;
    } catch (_err) {
      return false;
    }
  },

  /**
   * Drop the sticky target WITHOUT leaving browser fullscreen. Used by
   * callers that tear down their own display-mode state while the fullscreen
   * element stays put (panel display mode keeps the overlay browser-fullscreen
   * after its display-mode class is removed).
   */
  clearTarget() {
    this._target = null;
  },

  /** Register a fullscreenchange listener. Returns an unregister function. */
  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  },

  /**
   * Bind the global listeners once. Idempotent — index.html (via
   * GSRLayoutManager.init) and live.html (via GSRLiveView.mount) can both
   * call it safely.
   */
  init() {
    if (this._bound) return;
    this._bound = true;
    document.addEventListener('fullscreenchange', () => this._emit());
    document.addEventListener('webkitfullscreenchange', () => this._emit());
    document.addEventListener('mozfullscreenchange', () => this._emit());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (this._target && !this.active) this.request(this._target);
    });
  },

  _emit() {
    const active = this.active;
    this._listeners.forEach((fn) => {
      fn(active);
    });
  },

  /** Currently showing restore-fullscreen pill (avoid duplicates). */
  _restorePillEl: null,

  /**
   * Show a floating pill that re-enters fullscreen on `selector`'s element
   * when clicked. Needed after a file dialog: the browser leaves fullscreen
   * when the dialog opens, and Chrome blocks a programmatic re-request from
   * the input's change event, so it has to come from a click.
   */
  showRestorePill(selector) {
    if (this._restorePillEl) return; // already showing

    const pill = document.createElement('div');
    pill.style.cssText = `
      position:fixed;top:18px;left:50%;transform:translateX(-50%);z-index:10002;
      background:rgba(0,0,0,0.82);color:#fff;font-family:Inter,sans-serif;font-size:0.82rem;
      font-weight:600;padding:8px 18px;border-radius:22px;cursor:pointer;
      display:flex;align-items:center;gap:8px;box-shadow:0 4px 24px rgba(0,0,0,0.2);
      backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);
    `;
    pill.innerHTML =
      '<i class="fa-solid fa-expand"></i> Restore Fullscreen <span style="opacity:0.55;font-weight:400;">(click here)</span>';

    // Inject a <style> block for the fade-in animation
    if (!document.getElementById('fs-restore-anim')) {
      const s = document.createElement('style');
      s.id = 'fs-restore-anim';
      s.textContent =
        '@keyframes fs-pill-in{from{opacity:0;transform:translateX(-50%) translateY(-12px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}';
      document.head.appendChild(s);
    }
    pill.style.animation = 'fs-pill-in 0.35s ease';

    pill.addEventListener('click', (e) => {
      e.stopPropagation();
      pill.remove();
      this._restorePillEl = null;
      const el = document.querySelector(selector);
      if (el) this.request(el);
    });

    document.body.appendChild(pill);
    this._restorePillEl = pill;

    // Auto-dismiss after 8 s
    setTimeout(() => {
      if (this._restorePillEl === pill) {
        pill.style.opacity = '0';
        pill.style.transition = 'opacity 0.4s ease';
        setTimeout(() => {
          if (pill.parentNode) pill.remove();
          if (this._restorePillEl === pill) this._restorePillEl = null;
        }, 400);
      }
    }, 8000);
  },
};
