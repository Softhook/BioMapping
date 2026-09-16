// Copyright (c) 2026 Christian Nold
// Licensed under the Bio Mapping Community Licence 1.0.
// See LICENCE.md in the project root for terms.

/**
 * GSREvents — GSR filter sliders, alternative-detector toggles, gait filter, graph-view selector. Object-augment split from events.js: loaded
 * immediately after events.js, adds these methods to the shared GSREvents
 * object.
 */
import { AppState } from '../core/app_state.mjs';
import { GSR_SLIDER_DEFS, GSREvents } from './events.mjs';
import { GSRUI } from './ui.mjs';

export const __methods = {
  /**
   * GSR filter sliders, alternative-detector toggles, gait filter, graph-view selector.
   */
  _bindGsrAnalysisControls() {
    const S = AppState.sliders;

    // ── GSR slider bindings ──────────────────────────────────────────────────
    GSR_SLIDER_DEFS.forEach((d) => {
      GSREvents.bindGsrSlider(d.id, d.labelId, d.suffix);
    });

    S.tonicMethod.addEventListener('change', () => {
      GSREvents.updateTonicMethodLayout(false);
      GSRUI.runAnalysis();
    });

    // ── Alternative-detector toggles (Prominence / Deconv / SparsEDA / cvxEDA) ──
    // Mutually exclusive: analyze() only ever runs one detector, so turning one
    // alternative ON forces the others OFF (setting .checked in code does not
    // re-fire 'change', so no loop). Turning all OFF drops back to the default
    // full-scan detector. Each re-runs the full pipeline.
    const detectorToggles = [
      'usePeakProminence',
      'useDeconvolution',
      'useSparsEDA',
      'useCvxEDA',
    ];
    detectorToggles.forEach((id) => {
      if (!S[id]) return;
      S[id].addEventListener('change', () => {
        if (S[id].checked) {
          detectorToggles.forEach((other) => {
            if (other !== id && S[other]) S[other].checked = false;
          });
        }
        GSREvents.syncTonicBaselineControls();
        GSRUI.runAnalysis();
      });
    });
    GSREvents.syncTonicBaselineControls(); // initial state

    // ── Gait filter toggle (Linkwitz-Riley LR4 gait filter) ──
    if (S.useGaitFilter) {
      S.useGaitFilter.addEventListener('change', () => GSRUI.runAnalysis());
    }

    // ── Graph view selector ─────────────────────────────────────────────────
    // Rendering-only setting (no re-analysis needed). One dropdown picks the
    // whole plot: 'signal' or a single derived metric. Choosing a metric view
    // also arms it as lowerGraphMode. The Raw/Filtered/Tonic/Phasic curve
    // toggles are only meaningful in 'signal' view, so hide them otherwise.
    if (S.graphView) {
      GSREvents.applyGraphView();
      S.graphView.addEventListener('change', () => GSREvents.applyGraphView());
    }
  },
};

Object.assign(GSREvents, __methods);
