// Copyright (c) 2026 Christian Nold
// Licensed under the Bio Mapping Community Licence 1.0.
// See LICENCE.md in the project root for terms.

/**
 * GSREvents — CSV/GPX/preset export+import controls, drag-and-drop file loading, and the 3D KML/CZML track export. Object-augment split from events.js: loaded
 * immediately after events.js, adds these methods to the shared GSREvents
 * object.
 */
import { AppState } from '../core/app_state.mjs';
import { Controllers } from '../core/controllers.mjs';
import { GSRNotices } from '../core/notices.mjs';
import { GSRGlobe3DExport } from '../map/globe3d/exporters.mjs';
import { GSRMapExporter } from '../map/map_exporter.mjs';
import { GSRCollectiveProject } from '../spatial/collective_project.mjs';
import { GSRTrackManager } from './tracks.mjs';

export const FileExportEvents = {
  /**
   * File upload / drag-drop, the demo-track loader, and every export button (CSV, PNG, map PNG/SVG, CZML/KML, project bundle).
   */
  _bindFileAndExportControls() {
    // ── File Upload Handlers ──────────────────────────────────────────────────
    // Save browser fullscreen state before the file dialog opens (browser exits fullscreen)
    AppState.fileInput.addEventListener('click', () => {
      GSRTrackManager._browserFsSave = AppState.isBrowserFullscreen;
    });
    AppState.fileInput.addEventListener(
      'change',
      GSRTrackManager.handleFileSelect,
    );

    AppState.dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      AppState.dropZone.classList.add('dragover');
    });
    AppState.dropZone.addEventListener('dragleave', () => {
      AppState.dropZone.classList.remove('dragover');
    });
    AppState.dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      AppState.dropZone.classList.remove('dragover');
      // Dragging doesn't exit fullscreen, no save needed
      if (e.dataTransfer.files.length > 0) {
        GSRTrackManager.handleIncomingFiles(Array.from(e.dataTransfer.files));
      }
    });
    AppState.dropZone.addEventListener('click', (e) => {
      if (!e.target.closest('label') && e.target !== AppState.fileInput) {
        // Save browser fullscreen state before the file dialog opens
        GSRTrackManager._browserFsSave = AppState.isBrowserFullscreen;
        AppState.fileInput.click();
      }
    });

    // ── Export Buttons ────────────────────────────────────────────────────────
    document
      .getElementById('exportCsvBtn')
      .addEventListener('click', () => Controllers.ui?.exportCSV());
    document
      .getElementById('exportImageBtn')
      .addEventListener('click', () => Controllers.ui?.saveCanvasImage());
    document
      .getElementById('exportMapBtn')
      .addEventListener('click', () => Controllers.ui?.saveMapImage());
    document
      .getElementById('exportSvgBtn')
      .addEventListener('click', async () => {
        if (AppState.mapManager)
          await GSRMapExporter.exportToSvg(AppState.mapManager);
      });
    document
      .getElementById('exportCzmlBtn')
      .addEventListener('click', () => FileExportEvents.export3DTrack('czml'));
    document
      .getElementById('exportKmlBtn')
      .addEventListener('click', () => FileExportEvents.export3DTrack('kml'));
    document
      .getElementById('exportProjectBtn')
      .addEventListener('click', () => {
        GSRCollectiveProject.exportProject();
      });

    // ── Demo Loader ──────────────────────────────────────────────────────────
    document
      .getElementById('loadDemoBtn')
      .addEventListener('click', GSRTrackManager.loadDefaultTrack);
  },
  /**
   * Export the active single track as the 3D extruded arousal ribbon (CZML or
   * KML), driven from the main Export Options panel — no live 3D viewer needed.
   * Uses the exact display points the 2D map drew (single-track scope only:
   * collective's merged drawPoints carry cross-analyzer indices), the map's
   * active colour metric, and the 3D extrusion slider's value.
   * @param {'czml'|'kml'} kind
   */
  export3DTrack(kind) {
    const analyzer = AppState.analyzer;
    const mm = AppState.mapManager;
    const drawPoints =
      AppState.viewMode !== 'collective' && mm ? mm._lastDrawPoints : null;
    if (!analyzer || !drawPoints || drawPoints.length < 2) {
      const msg =
        'Load a single track with GPS data before exporting the 3D track.';
      if (typeof GSRNotices !== 'undefined') GSRNotices.warn(msg, 'export3d');
      else console.warn('[export3d]', msg);
      return;
    }
    const extEl = document.getElementById('g3dExtrusionScale');
    const opts = {
      metric: mm?.activeColoringMetric || 'phasic',
      extrusionScale: extEl ? parseFloat(extEl.value) : undefined,
    };
    const baseName =
      typeof Controllers.ui?._exportFilenameBase === 'function'
        ? Controllers.ui._exportFilenameBase()
        : 'biomapping_track';
    if (kind === 'kml') {
      GSRGlobe3DExport.download(
        GSRGlobe3DExport.buildKml(analyzer, drawPoints, opts),
        `${baseName}_3d.kml`,
        'application/vnd.google-earth.kml+xml',
      );
    } else {
      GSRGlobe3DExport.download(
        GSRGlobe3DExport.buildCzml(analyzer, drawPoints, opts),
        `${baseName}_3d.czml`,
        'application/json',
      );
    }
  },
};
