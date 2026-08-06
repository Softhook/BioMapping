/**
 * Global notice layer for the GSR track visualiser — the single place the app
 * talks to the user about errors, warnings, and decisions.
 *
 * Three levels, all of which create their own DOM and never block page load:
 *   - report() → red toast for errors (also wired to window 'error' and
 *                'unhandledrejection' so uncaught errors can't fail silently).
 *   - warn()   → amber toast for warnings.
 *   - dialog() → a centred modal that asks the user to choose (Promise-based);
 *                the place future pop-ups should go.
 *
 * Loaded first in index.html (before any app file) so it is in place for
 * anything that throws later. It owns its own DOM (toast container / dialog
 * overlay) rather than depending on index.html elements or GSRTrackManager,
 * so there is no load-order coupling to the app UI. All methods no-op
 * gracefully under Node / jsdom-less tests.
 */

class GSRNotices {
  /**
   * Report an error. Logs consistently and, in a DOM environment, shows a
   * red, non-blocking toast.
   * @param {Error|string} err - The error or message to report.
   * @param {string} [context=''] - Where it came from, e.g. 'map_exporter'.
   */
  static report(err, context = '') {
    const label = context ? `[GSRNotices:${context}]` : '[GSRNotices]';
    console.error(label, err);
    GSRNotices._toast('error', context, err);
  }

  /**
   * Report a non-fatal warning. Logs via console.warn and (unless
   * options.toast === false) shows an amber, non-blocking toast.
   * @param {string} message - The warning message.
   * @param {string} [context=''] - Where it came from, e.g. 'unsaved-labels'.
   * @param {{toast?: boolean}} [options={}] - Pass { toast: false } to log
   *   only, e.g. when another UI element is already showing the warning.
   */
  static warn(message, context = '', options = {}) {
    const label = context ? `[GSRNotices:${context}]` : '[GSRNotices]';
    console.warn(label, message);
    if (options.toast !== false) {
      GSRNotices._toast('warn', context, message);
    }
  }

  /**
   * Show a blocking decision dialog. Creates its own overlay + card on the
   * fly, so it works anywhere a document exists — no index.html elements
   * needed. This is the single place future pop-ups should go.
   *
   * @param {{
   *   title?: string,
   *   message?: string,
   *   buttons?: Array<{label: string, value: *, style?: 'primary'|'danger'|'secondary'}>,
   *   dismissLabel?: string|null,
   *   tone?: 'info'|'warn'|'error'
   * }} options
   * @returns {Promise<*|null>} Resolves with the clicked button's value, or
   *   null when dismissed (Escape / overlay click / dismiss button / no DOM).
   */
  static dialog(options = {}) {
    return new Promise((resolve) => {
      if (typeof document === 'undefined' || !document.body) {
        resolve(null);
        return;
      }

      const title = options.title || '';
      const message = options.message || '';
      const buttons = options.buttons || [];
      const tone = options.tone || 'warn';
      const accent = tone === 'error' ? '#b91c1c' : (tone === 'info' ? '#1d4ed8' : '#b45309');

      // Remember what had focus so it can be restored when the dialog closes.
      const previouslyFocused = document.activeElement;

      const overlay = document.createElement('div');
      Object.assign(overlay.style, {
        position: 'fixed', top: '0', right: '0', bottom: '0', left: '0',
        zIndex: '10001', background: 'rgba(0,0,0,.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center'
      });

      const card = document.createElement('div');
      card.setAttribute('role', 'dialog');
      card.setAttribute('aria-modal', 'true');
      Object.assign(card.style, {
        background: '#fff', color: '#111', borderRadius: '10px',
        maxWidth: '440px', width: '90%', padding: '20px 22px',
        boxShadow: '0 12px 40px rgba(0,0,0,.4)',
        font: '14px/1.5 system-ui, sans-serif'
      });

      const titleEl = document.createElement('h3');
      titleEl.id = 'gsr-notice-dialog-title';
      titleEl.textContent = title;
      Object.assign(titleEl.style, { margin: '0 0 8px', color: accent, fontSize: '16px' });
      card.setAttribute('aria-labelledby', titleEl.id);

      const msgEl = document.createElement('p');
      msgEl.textContent = message;
      Object.assign(msgEl.style, { margin: '0 0 18px', color: '#111' });

      const btnRow = document.createElement('div');
      Object.assign(btnRow.style, {
        display: 'flex', gap: '8px', justifyContent: 'flex-end', flexWrap: 'wrap'
      });

      // All focusable controls in the dialog, in DOM order, for the Tab trap.
      const focusables = [];

      const finish = (value) => {
        overlay.remove();
        document.removeEventListener('keydown', onKey);
        if (previouslyFocused && typeof previouslyFocused.focus === 'function' && previouslyFocused.isConnected) {
          previouslyFocused.focus();
        }
        resolve(value);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') { finish(null); return; }
        // Lightweight focus trap: keep Tab cycling inside the dialog.
        if (e.key === 'Tab' && focusables.length > 0) {
          const first = focusables[0];
          const last = focusables[focusables.length - 1];
          const active = document.activeElement;
          if (e.shiftKey) {
            if (active === first) { e.preventDefault(); last.focus(); }
          } else if (active === last) {
            e.preventDefault(); first.focus();
          }
        }
      };

      buttons.forEach((b) => {
        const btn = document.createElement('button');
        btn.textContent = b.label;
        const bg = b.style === 'primary' ? '#1d4ed8'
          : (b.style === 'danger' ? '#b91c1c' : '#6b7280');
        Object.assign(btn.style, {
          background: bg, color: '#fff', border: 'none', borderRadius: '6px',
          padding: '8px 14px', cursor: 'pointer', fontSize: '13px'
        });
        btn.addEventListener('click', () => finish(b.value));
        btnRow.appendChild(btn);
        focusables.push(btn);
      });

      if (options.dismissLabel !== null) {
        const cancel = document.createElement('button');
        cancel.textContent = options.dismissLabel || 'Cancel';
        Object.assign(cancel.style, {
          background: 'transparent', color: '#6b7280', border: '1px solid #d1d5db',
          borderRadius: '6px', padding: '8px 14px', cursor: 'pointer', fontSize: '13px',
          marginRight: 'auto'
        });
        cancel.addEventListener('click', () => finish(null));
        btnRow.appendChild(cancel);
        focusables.push(cancel);
      }

      card.appendChild(titleEl);
      card.appendChild(msgEl);
      card.appendChild(btnRow);
      overlay.appendChild(card);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) finish(null); });
      document.body.appendChild(overlay);
      document.addEventListener('keydown', onKey);
      // Move focus into the dialog so keyboard users are where the action is.
      if (focusables.length > 0) focusables[0].focus();
    });
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
    GSRNotices.report(event.error || event.message, 'window.onerror');
  });
  window.addEventListener('unhandledrejection', (event) => {
    GSRNotices.report(event.reason, 'unhandledrejection');
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GSRNotices };
}
