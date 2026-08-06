/**
 * Global error safety net for the GSR track visualiser.
 *
 * Surfaces uncaught errors (window 'error' / 'unhandledrejection') and
 * GSRErrors.report() calls as a visible, non-blocking toast instead of
 * failing silently. Purely additive — no existing behavior changes.
 *
 * Loaded first in index.html (before any app file) so it is in place for
 * anything that throws later. It owns its own toast container rather than
 * reusing GSRTrackManager.setFileStatus() so there is no load-order coupling
 * to the app UI.
 *
 * report() is safe to call from any module in any environment: it always
 * logs via console.error and only touches the DOM when one exists (it no-ops
 * gracefully under Node / jsdom-less tests).
 */

class GSRErrors {
  /**
   * Report an error. Logs consistently and, in a DOM environment, shows a
   * non-blocking toast.
   * @param {Error|string} err - The error or message to report.
   * @param {string} [context=''] - Where it came from, e.g. 'map_exporter'.
   */
  static report(err, context = '') {
    const label = context ? `[GSRErrors:${context}]` : '[GSRErrors]';
    console.error(label, err);
    GSRErrors._toast('error', context, err);
  }

  /**
   * Report a non-fatal warning. Logs via console.warn and (unless
   * options.toast === false) shows an amber, non-blocking toast — the same
   * notification layer as report(), but for warnings rather than errors.
   * @param {string} message - The warning message.
   * @param {string} [context=''] - Where it came from, e.g. 'unsaved-labels'.
   * @param {{toast?: boolean}} [options={}] - Pass { toast: false } to log
   *   only, e.g. when another UI element is already showing the warning.
   */
  static warn(message, context = '', options = {}) {
    const label = context ? `[GSRErrors:${context}]` : '[GSRErrors]';
    console.warn(label, message);
    if (options.toast !== false) {
      GSRErrors._toast('warn', context, message);
    }
  }

  /**
   * Append a non-blocking toast for a notice. No-op when there is no DOM.
   * @param {'error'|'warn'} level - Controls the toast styling.
   * @param {string} context - Source of the notice.
   * @param {Error|string} err - Error, warning message, or string.
   * @private
   */
  static _toast(level, context, err) {
    if (typeof document === 'undefined' || !document.body) return;

    const msg = err && err.message ? err.message : String(err);
    const isWarn = level === 'warn';

    let container = document.getElementById('gsr-error-toasts');
    if (!container) {
      container = document.createElement('div');
      container.id = 'gsr-error-toasts';
      Object.assign(container.style, {
        position: 'fixed',
        top: '12px',
        right: '12px',
        zIndex: '10000',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        maxWidth: '380px'
      });
      document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    Object.assign(toast.style, {
      background: isWarn ? '#92400e' : '#7f1d1d',
      color: '#fff',
      padding: '8px 12px',
      borderRadius: '6px',
      font: '12px/1.4 system-ui, sans-serif',
      boxShadow: '0 2px 8px rgba(0,0,0,.35)',
      cursor: 'pointer'
    });
    toast.textContent = (context ? context + ': ' : '') + msg;
    toast.title = 'Click to dismiss';
    toast.addEventListener('click', () => toast.remove());
    container.appendChild(toast);

    // Auto-dismiss after 8s; cap the stack so a burst can't flood the screen.
    setTimeout(() => toast.remove(), 8000);
    while (container.children.length > 5) container.firstChild.remove();
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('error', (event) => {
    GSRErrors.report(event.error || event.message, 'window.onerror');
  });
  window.addEventListener('unhandledrejection', (event) => {
    GSRErrors.report(event.reason, 'unhandledrejection');
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GSRErrors };
}
