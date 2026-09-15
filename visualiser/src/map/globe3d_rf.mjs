/**
 * GSRGlobeManager — 3D volumetric RF expanse control.
 * Prototype-augment split from globe3d.js: loaded after globe3d.js, adds
 * these methods to GSRGlobeManager.prototype.
 *
 * Orchestration only (toggle state, scene add/remove of this.rfPrimitive) —
 * the actual corridor geometry is built by the pure GSRGlobe3DRf module
 * (src/map/globe3d/rf_expanse.js), loaded earlier.

 * Assigned onto GSRGlobeManager.prototype via Object.assign at the file's
 * tail (a plain ESM static import/export, loaded once by app_entry.mjs).
 */

import { GSRGlobe3DRf } from './globe3d/rf_expanse.mjs';
import { GSRGlobeManager } from './globe3d.mjs';

export const __methods = {
  /**
   * Toggle 3D Volumetric RF Expanse (street-filling electromagnetic fluid)
   * @param {boolean} show
   * @param {'triband'|'815'|'868'|'915'|'fog'} [mode='triband']
   * @param {number} [height=25.0]
   * @param {number} [opacity=0.45]
   */
  toggle3DRf(show, mode = 'triband', height = 25.0, opacity = 0.45) {
    this.showRfVolumetric = show;
    this.rfMode = mode;
    this.rfHeight = height;
    this.rfOpacity = opacity;

    this.clearRfEntities();
    if (show && this.currentAnalyzer && this.currentDrawPoints.length > 0) {
      this.render3DRfExpanse(this.currentAnalyzer, this.currentDrawPoints);
    }
    this._requestRender();
  },

  /**
   * Render the 3D Volumetric RF Expanse (glowing semi-dome fluid slugs). The
   * geometry build lives in src/map/globe3d/rf_expanse.js; this owns the scene
   * primitive's lifecycle.
   */
  render3DRfExpanse(analyzer, drawPoints) {
    this.clearRfEntities();
    if (!this.viewer || typeof GSRGlobe3DRf === 'undefined') return;
    const prim = GSRGlobe3DRf.buildPrimitive(analyzer, drawPoints, {
      mode: this.rfMode,
      height: this.rfHeight,
      opacity: this.rfOpacity,
    });
    if (prim) {
      this.rfPrimitive = prim;
      this.viewer.scene.primitives.add(prim);
    }
  },

  clearRfEntities() {
    if (!this.viewer) return;
    if (this.rfPrimitive) {
      this.viewer.scene.primitives.remove(this.rfPrimitive);
      this.rfPrimitive = null;
    }
  },
};

Object.assign(GSRGlobeManager.prototype, __methods);
