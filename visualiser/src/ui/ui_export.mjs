/**
 * GSRUI — file export. Object-augment split from ui.js: loaded immediately
 * after ui.js, adds these methods to the shared GSRUI object.
 *
 * Covers the processed-CSV export, the p5.js timeline PNG export, and the
 * active map surface (2D Leaflet or 3D Cesium) PNG export, plus the shared
 * filename-sanitising helper they all use.
 */
import { AppState } from '../core/app_state.mjs';
import { GSRFileSaver } from '../core/file_saver.mjs';
import { GSRGlobe3DView } from '../map/globe3d_view.mjs';
import { GSRMapExporter } from '../map/map_exporter.mjs';
import { GSRStorage } from './storage.mjs';
import { GSRUI } from './ui.mjs';

export const __methods = {
  /**
   * Get a sanitised filename base from the active track name.
   */
  _exportFilenameBase() {
    const track = AppState.activeTrackId
      ? AppState.collectiveManager.getTrack(AppState.activeTrackId)
      : null;
    const name = track ? track.name.replace(/\.[^/.]+$/, '') : 'gsr_analysis';
    // Sanitize for filenames: replace non-alphanumeric chars (except . - _) with underscores
    return name.replace(/[^a-zA-Z0-9._-]/g, '_');
  },

  /**
   * Export processed GSR data as CSV.
   * @param {string} [targetTrackId] - Optional track ID to export, defaults to active track
   * @returns {Promise<boolean>} True if saved, false if cancelled or failed
   */
  async exportCSV(targetTrackId) {
    let track = null;
    let analyzer = AppState.analyzer;
    if (targetTrackId) {
      track = AppState.collectiveManager.getTrack(targetTrackId);
      if (track) analyzer = track.analyzer;
    } else if (AppState.activeTrackId) {
      track = AppState.collectiveManager.getTrack(AppState.activeTrackId);
    }

    if (!analyzer || analyzer.raw.length === 0) return false;
    const params = track
      ? track.filterParams
      : GSRStorage.readGsrSliderValues();
    const gpsParams = track
      ? track.gpsFilterParams
      : GSRStorage.readGpsSliderValues();
    const csvContent = analyzer.exportToCSV(params, gpsParams);
    const nameToSanitize = track
      ? track.name
      : AppState.activeTrackId
        ? (AppState.collectiveManager.getTrack(AppState.activeTrackId) || {})
            .name
        : null;
    const baseName = nameToSanitize
      ? nameToSanitize.replace(/\.[^/.]+$/, '').replace(/[^a-zA-Z0-9._-]/g, '_')
      : GSRUI._exportFilenameBase();
    const saved = await GSRFileSaver.saveFile(
      csvContent,
      baseName + '_processed.csv',
    );
    if (saved !== false) {
      if (track) track.hasUnsavedLabels = false;
      if (
        AppState.activeTrackId &&
        (!targetTrackId || targetTrackId === AppState.activeTrackId)
      ) {
        const activeTrack = AppState.collectiveManager.getTrack(
          AppState.activeTrackId,
        );
        if (activeTrack) activeTrack.hasUnsavedLabels = false;
      }
      return true;
    }
    return false;
  },

  /**
   * Export p5.js canvas as PNG.
   */
  async saveCanvasImage() {
    if (!AppState.myCanvas || AppState.analyzer.raw.length === 0) return;
    const baseName = GSRUI._exportFilenameBase();
    const suggestedName = baseName + '_chart.png';
    const canvasEl =
      document.querySelector('#sketch-container canvas') ||
      (AppState.myCanvas ? AppState.myCanvas.elt : null);
    if (canvasEl && typeof canvasEl.toBlob === 'function') {
      canvasEl.toBlob(async (blob) => {
        if (blob) {
          await GSRFileSaver.saveFile(blob, suggestedName);
        }
      }, 'image/png');
    } else {
      saveCanvas(AppState.myCanvas, baseName + '_chart', 'png');
    }
  },

  /**
   * Export the active map view (2D Leaflet vector rasterisation or 3D Cesium WebGL) as PNG.
   */
  async saveMapImage() {
    if (AppState.analyzer.raw.length === 0) return;

    const btn = document.getElementById('exportMapBtn');
    const originalText = btn ? btn.innerHTML : '';

    if (btn) {
      btn.innerHTML =
        '<i class="fa-solid fa-spinner fa-spin"></i> Generating...';
      btn.setAttribute('disabled', 'true');
    }

    try {
      if (
        typeof GSRGlobe3DView !== 'undefined' &&
        GSRGlobe3DView.isActive &&
        GSRGlobe3DView.manager?.viewer
      ) {
        // 3D Globe Mode (Cesium WebGL canvas capture).
        // Primitives compiled with asynchronous:true (the wall, RF expanse)
        // are uploaded to the GPU asynchronously — they first appear in the
        // frame AFTER render() is called. Wait for scene.postRender so the
        // snapshot always captures fully-rendered geometry.
        const viewer = GSRGlobe3DView.manager.viewer;
        const canvas = viewer.scene.canvas;
        const baseName = GSRUI._exportFilenameBase();
        const mode = AppState.viewMode || 'single';
        const suggestedName = `${baseName}_globe3d_${mode}_export.png`;

        await new Promise((resolve) => {
          const remove = viewer.scene.postRender.addEventListener(() => {
            remove(); // one-shot
            if (typeof canvas.toBlob === 'function') {
              canvas.toBlob(async (blob) => {
                if (blob) await GSRFileSaver.saveFile(blob, suggestedName);
                resolve();
              }, 'image/png');
            } else if (typeof canvas.toDataURL === 'function') {
              GSRFileSaver.saveFile(
                canvas.toDataURL('image/png'),
                suggestedName,
              ).then(resolve);
            } else {
              resolve();
            }
          });
          viewer.render(); // trigger the frame that will compile + upload pending geometry
        });
      } else if (typeof GSRMapExporter !== 'undefined' && AppState.mapManager) {
        // 2D Map Mode (Native vector SVG rendered to PNG)
        await GSRMapExporter.exportToPng(AppState.mapManager);
      }
    } catch (err) {
      console.error('Error generating map PNG:', err);
      alert('Could not export map PNG.');
    } finally {
      if (btn) {
        btn.innerHTML = originalText;
        btn.removeAttribute('disabled');
      }
    }
  },
};

Object.assign(GSRUI, __methods);
