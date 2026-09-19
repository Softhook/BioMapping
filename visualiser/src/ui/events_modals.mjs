// Copyright (c) 2026 Christian Nold
// Licensed under the Bio Mapping Community Licence 1.0.
// See LICENCE.md in the project root for terms.

/**
 * GSREvents — Modal dialog event listeners (Street View modal, API key management).
 */
import { Controllers } from '../core/controllers.mjs';

export const ModalEvents = {
  /**
   * Bind event listeners for the Street View modal dialog and its tabs.
   */
  _bindModalControls() {
    const modal = document.getElementById('streetviewModal');
    const closeBtn = document.getElementById('svModalCloseBtn');
    const tabGoogle = document.getElementById('svTabGoogle');
    const tabMapillary = document.getElementById('svTabMapillary');
    const saveKeyBtn = document.getElementById('svApiKeySaveBtn');

    if (modal) {
      modal.addEventListener('click', (event) => {
        if (event.target === modal) {
          Controllers.ui?.closeStreetViewModal?.(event);
        }
      });
    }

    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        Controllers.ui?.closeStreetViewModal?.();
      });
    }

    if (tabGoogle) {
      tabGoogle.addEventListener('click', () => {
        Controllers.ui?.switchStreetViewTab?.('google');
      });
    }

    if (tabMapillary) {
      tabMapillary.addEventListener('click', () => {
        Controllers.ui?.switchStreetViewTab?.('mapillary');
      });
    }

    if (saveKeyBtn) {
      saveKeyBtn.addEventListener('click', () => {
        Controllers.ui?.saveGoogleMapsKey?.();
      });
    }

    // Keyboard-only escape hatch matching the backdrop's click-to-dismiss
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (modal && modal.style.display !== 'none') {
        Controllers.ui?.closeStreetViewModal?.();
      }
    });
  },
};
