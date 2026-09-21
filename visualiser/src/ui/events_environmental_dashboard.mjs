// Copyright (c) 2026 Christian Nold
// Licensed under the Bio Mapping Community Licence 1.0.
// See LICENCE.md in the project root for terms.

/**
 * GSREvents — Environmental Analysis dashboard tab controls. Object-augment split from events.js: loaded
 * immediately after events.js, adds these methods to the shared GSREvents
 * object.
 */
import { AppState } from '../core/app_state.mjs';
import { Controllers } from '../core/controllers.mjs';

export const EnvironmentalDashboardEvents = {
  /**
   * Environmental dashboard tab switcher, scope switcher, and metric selects.
   */
  _bindEnvironmentalDashboardControls() {
    // Dashboard Tab Switcher
    const bindEnvTab = (btnId, panelId) => {
      const btn = document.getElementById(btnId);
      if (!btn) return;
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

        // If user switches to Junction Turns tab and tracks are missing OSM geoms,
        // attempt a background ensureOsmGeoms (reuses cache or fetches)
        if (btnId === 'btnEnvTabJunctions' && Controllers.ui?.ensureOsmGeoms) {
          const allActive =
            AppState.viewMode === 'collective'
              ? AppState.collectiveManager?.getActiveTracks?.() || []
              : AppState.analyzer
                ? [{ analyzer: AppState.analyzer }]
                : [];
          const missing = allActive.some(
            (t) => t.analyzer?.isEnriched && !t.analyzer?.osmGeoms?.ways,
          );
          if (missing) {
            Controllers.ui
              .ensureOsmGeoms()
              .then(() => Controllers.ui?.updateEnvironmentalDashboard?.())
              .catch((e) => console.warn('ensureOsmGeoms failed:', e));
          }
        }

        Controllers.ui?.updateEnvironmentalDashboard();
      });
    };
    bindEnvTab('btnEnvTabCorrelation', 'envTabCorrelation');
    bindEnvTab('btnEnvTabScatter', 'envTabScatter');
    bindEnvTab('btnEnvTabRoads', 'envTabRoads');
    bindEnvTab('btnEnvTabJunctions', 'envTabJunctions');

    // Junctions Table Column Sorting
    const juncTable = document.getElementById('junctionsTable');
    if (juncTable) {
      juncTable.querySelectorAll('thead th.sortable').forEach((th) => {
        th.addEventListener('click', () => {
          Controllers.ui?.sortJunctionsTable(th.dataset.sort);
        });
      });
    }

    // Delegate click on dynamically added .btn-fetch-junction-geoms
    const envTabJunctions = document.getElementById('envTabJunctions');
    if (envTabJunctions) {
      envTabJunctions.addEventListener('click', (e) => {
        const fetchBtn = e.target.closest('.btn-fetch-junction-geoms');
        if (fetchBtn && Controllers.ui?.ensureOsmGeoms) {
          fetchBtn.disabled = true;
          fetchBtn.innerHTML =
            '<i class="fa-solid fa-spinner fa-spin"></i> Retrieving Road Geometries…';
          Controllers.ui
            .ensureOsmGeoms()
            .then(() => {
              Controllers.ui?.updateEnvironmentalDashboard();
            })
            .catch((err) => {
              console.warn('ensureOsmGeoms failed:', err);
              Controllers.ui?.updateEnvironmentalDashboard();
            });
        }
      });
    }

    document
      .getElementById('scatterEnvMetric')
      ?.addEventListener('change', () =>
        Controllers.ui?.updateEnvironmentalDashboard(),
      );
    document
      .getElementById('scatterBioMetric')
      ?.addEventListener('change', () =>
        Controllers.ui?.updateEnvironmentalDashboard(),
      );
  },
};
