/**
 * GSRGlobeManager — 3D volumetric RF expanse control.
 * Prototype-augment split from globe3d.js: loaded after globe3d.js, adds
 * these methods to GSRGlobeManager.prototype.
 *
 * Orchestration only (toggle state, scene add/remove of this.rfPrimitive) —
 * the actual corridor geometry is built by the pure GSRGlobe3DRf module
 * (src/map/globe3d/rf_expanse.js), loaded earlier.

 * Dual-mode export (like globe3d.js's own tail): under a browser <script> tag
 * or the shared vm context (tests/support/boot_app.js), GSRGlobeManager is a
 * live global and this assigns straight onto its prototype. Under plain
 * CommonJS require() (tests/test_globe3d.js's per-test isolation harness,
 * which requires globe3d.js fresh for each test instead of booting the whole
 * app), module.exports hands back the method object instead so the caller can
 * Object.assign it onto the freshly-required class itself.
 */
import { GSRGlobeManager } from './globe3d.mjs';
import { GSRGlobe3DRf } from './globe3d/rf_expanse.mjs';

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
      mode: this.rfMode, height: this.rfHeight, opacity: this.rfOpacity
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
  }

  };

  Object.assign(GSRGlobeManager.prototype, __methods);
