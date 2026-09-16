// Copyright (c) 2026 Christian Nold
// Licensed under the Bio Mapping Community Licence 1.0.
// See LICENCE.md in the project root for terms.

/**
 * GSREvents — Environmental Analysis dashboard tab controls. Object-augment split from events.js: loaded
 * immediately after events.js, adds these methods to the shared GSREvents
 * object.
 */
import { GSREvents } from './events.mjs';
import { GSRUI } from './ui.mjs';

export const __methods = {
  /**
   * Environmental dashboard tab switcher and scatter-plot metric selects.
   */
  _bindEnvironmentalDashboardControls() {
    // Dashboard Tab Switcher
    const bindEnvTab = (btnId, panelId) => {
      const btn = document.getElementById(btnId);
      btn.addEventListener('click', () => {
        document.querySelectorAll('#envTabSwitcher .view-tab').forEach((b) => {
          b.classList.remove('active');
        });
        document.querySelectorAll('.env-tab-content').forEach((p) => {
          p.style.display = 'none';
          p.classList.remove('active');
        });
        btn.classList.add('active');
        const pEl = document.getElementById(panelId);
        if (pEl) {
          pEl.style.display = 'flex';
          pEl.classList.add('active');
        }
        GSRUI.updateEnvironmentalDashboard();
      });
    };
    bindEnvTab('btnEnvTabCorrelation', 'envTabCorrelation');
    bindEnvTab('btnEnvTabScatter', 'envTabScatter');
    bindEnvTab('btnEnvTabRoads', 'envTabRoads');

    document
      .getElementById('scatterEnvMetric')
      .addEventListener('change', () => GSRUI.updateEnvironmentalDashboard());
    document
      .getElementById('scatterBioMetric')
      .addEventListener('change', () => GSRUI.updateEnvironmentalDashboard());
  },
};

Object.assign(GSREvents, __methods);
