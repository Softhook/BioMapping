/**
 * Collective Map Project Export/Import.
 *
 * Bundles every loaded track into a single re-importable .zip so a
 * multi-track collective-map session can be closed and resumed later —
 * "Save Project" / "Open Project" for the collective view.
 *
 * Deliberately reuses the existing single-track "processed CSV" round-trip
 * (GSRAnalyzer.exportToCSV() / parseCSV()) rather than inventing a new data
 * format: each track's CSV already embeds its own filter params, GPS filter
 * params, peak labels, and peak exclusions as comment-header metadata, and
 * parseCSV() already knows how to read all of that back out losslessly (see
 * analyzer.js). This module only adds what that per-track format can't carry:
 * a manifest.json listing which CSV belongs to which track (name/color/
 * enabled/order) plus the collective-only view state (peak latency, cluster
 * and contour sliders, map layer toggles) that isn't part of any one track.
 *
 * Zip format:
 *   manifest.json          — see _buildManifest()
 *   01_<track-name>.csv    — one processed CSV per track, in export order
 *   02_<track-name>.csv
 *   ...
 */
import { AppState } from '../core/app_state.mjs';
import { BusyOverlay } from '../core/busy_overlay.mjs';
import { GSR_CONST } from '../core/constants.mjs';
import { Controllers } from '../core/controllers.mjs';
import { GSRFileSaver } from '../core/file_saver.mjs';
import { GSRNotices } from '../core/notices.mjs';
import { GSRAnalyzer } from '../signal/analyzer.mjs';
import { GSRStorage } from '../ui/storage.mjs';

export const GSRCollectiveProject = {
  MANIFEST_VERSION: 1,

  // Map toggle buttons whose on/off state is collective-view-only chrome —
  // captured/restored verbatim so a re-imported project looks the same as
  // when it was saved. See events.js bindMapControls() for where these
  // buttons are wired up originally.
  VIEW_TOGGLE_BUTTONS: {
    btnToggleMapPeaks: 'togglePeaks',
    btnToggleMapHotspots: 'toggleHotspots',
    btnToggleMapLabels: 'toggleLabels',
    btnToggleMapClusters: 'toggleClusters',
    btnToggleMapIsolines: 'toggleIsolines',
    btnToggleMapSurface: 'toggleSurface',
    btnToggleMapTracks: 'toggleTracks',
  },

  // Collective view's own Arousal Places settings (AppState.collectivePlaces),
  // saved under manifest.settings.sliders. Each walk keeps its own separate
  // Places settings and peak latency in its gpsFilterParams (its own CSV).
  COLLECTIVE_SLIDER_KEYS: GSRStorage.PLACE_KEYS,
  CONTOUR_KEYS: [
    'gridResolution',
    'contourCount',
    'isolationRadius',
    'idwExponent',
    'peakPreservation',
    'coverageWeighting',
    'topoSource',
    'showShadedSurface',
    'normalizeZScore',
    'surfaceOpacity',
    'hillshadeStrength',
  ],

  /** Same sanitization as GSRUI._exportFilenameBase(), applied per-track instead of to the active track only. */
  _sanitizeName(name) {
    return (name || 'track')
      .replace(/\.[^/.]+$/, '')
      .replace(/[^a-zA-Z0-9._-]/g, '_');
  },

  _pickValues(controls, keys) {
    const out = {};
    if (!controls) return out;
    keys.forEach((key) => {
      const el = controls[key];
      if (!el) return;
      if (el.tagName === 'BUTTON') {
        out[key] = el.classList.contains('active');
      } else {
        out[key] = el.type === 'checkbox' ? el.checked : el.value;
      }
    });
    return out;
  },

  _applyValues(controls, values) {
    if (!controls || !values) return;
    Object.entries(values).forEach(([key, val]) => {
      const el = controls[key];
      if (!el || val === undefined) return;
      if (el.tagName === 'BUTTON') {
        el.classList.toggle('active', !!val);
      } else if (el.type === 'checkbox') {
        el.checked = !!val;
      } else {
        el.value = val;
      }
    });
  },

  /**
   * The saved slider values that are still collective settings
   * (COLLECTIVE_SLIDER_KEYS). Older projects also saved gpsPeakLatency,
   * which is now per walk and must not override the open walk's own.
   */
  _collectiveSliderValues(saved) {
    const out = {};
    for (const key of this.COLLECTIVE_SLIDER_KEYS) {
      if (saved && key in saved) out[key] = saved[key];
    }
    return out;
  },

  _buildManifest(manifestTracks) {
    const activeIndex = AppState.collectiveManager.tracks.findIndex(
      (t) => t.id === AppState.activeTrackId,
    );

    const viewToggles = {};
    Object.keys(this.VIEW_TOGGLE_BUTTONS).forEach((id) => {
      const el = document.getElementById(id);
      if (el) viewToggles[id] = el.classList.contains('active');
    });

    return {
      version: this.MANIFEST_VERSION,
      exportedAt: new Date().toISOString(),
      viewMode: AppState.viewMode,
      activeTrackIndex: activeIndex,
      tracks: manifestTracks,
      settings: {
        // Collective view's own Places settings, not the sliders (which show
        // the open walk's in Single view).
        sliders: this._collectiveSliderValues(AppState.collectivePlaces),
        contour: this._pickValues(AppState.contourControls, this.CONTOUR_KEYS),
      },
      viewToggles,
    };
  },

  async exportProject() {
    if (typeof JSZip === 'undefined') {
      alert(
        'Zip support failed to load (check your internet connection) — cannot export a project bundle right now.',
      );
      return;
    }

    const tracks = AppState.collectiveManager.tracks;
    if (tracks.length === 0) {
      alert('No tracks loaded to export.');
      return;
    }

    const btn = document.getElementById('exportProjectBtn');
    const originalHtml = btn ? btn.innerHTML : null;
    if (btn) {
      btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Zipping...';
      btn.setAttribute('disabled', 'true');
    }

    try {
      // Flush the currently active track's live slider values into its track
      // object first, so the export reflects any unsaved tweaks — mirrors
      // what switchActiveTrack()/view-mode toggling already do before
      // re-analyzing. Inside the try so a failure here still restores the
      // button instead of leaving it stuck on "Zipping...".
      Controllers.trackManager.saveActiveTrackParams();
      Controllers.trackManager.saveActiveGpsParams();

      const zip = new JSZip();
      const manifestTracks = [];

      tracks.forEach((track, i) => {
        // Defensive: a track that's disabled or was never switched to may
        // never have had analyze() run on it, in which case
        // filtered/tonic/phasic are still empty and exportToCSV() would
        // silently return "". Backfill using its own saved params so every
        // track round-trips regardless of which one happens to be active.
        if (!track.analyzer.filtered || track.analyzer.filtered.length === 0) {
          try {
            const pl = track.gpsFilterParams?.peakLatency || 0;
            track.analyzer.analyze(track.filterParams, pl);
          } catch (e) {
            console.warn(
              `Could not analyze track "${track.name}" for export:`,
              e,
            );
          }
        }

        const csvText =
          track.analyzer.exportToCSV(
            track.filterParams,
            track.gpsFilterParams,
          ) || '';
        const filename = `${String(i + 1).padStart(2, '0')}_${this._sanitizeName(track.name)}.csv`;
        zip.file(filename, csvText);

        manifestTracks.push({
          id: track.id,
          name: track.name,
          color: track.color,
          enabled: track.enabled,
          file: filename,
        });
      });

      const manifest = this._buildManifest(manifestTracks);
      zip.file('manifest.json', JSON.stringify(manifest, null, 2));

      const blob = await zip.generateAsync({ type: 'blob' });
      const stamp = new Date().toISOString().slice(0, 10);
      const suggestedName = `biomapping_project_${stamp}.zip`;
      const saved = await GSRFileSaver.saveFile(blob, suggestedName);
      if (saved !== false) {
        AppState.collectiveManager.tracks.forEach((t) => {
          t.hasUnsavedLabels = false;
        });
      }
    } catch (err) {
      console.error('Project export failed:', err);
      alert(`Error exporting project: ${err.message}`);
    } finally {
      if (btn) {
        btn.innerHTML = originalHtml;
        btn.removeAttribute('disabled');
      }
    }
  },

  async importProject(file) {
    if (typeof JSZip === 'undefined') {
      alert(
        'Zip support failed to load (check your internet connection) — cannot import a project bundle right now.',
      );
      return;
    }
    if (!file) return;

    if (AppState.collectiveManager.tracks.length > 0) {
      // Ask via the shared notices layer (decision dialog).
      const choice = await GSRNotices.dialog({
        title: 'Replace Loaded Tracks',
        message:
          'Importing this project will replace all currently loaded tracks. Continue?',
        buttons: [{ label: 'Import', value: 'import', style: 'primary' }],
        dismissLabel: 'Cancel',
        tone: 'warn',
      });
      if (choice !== 'import') return;
    }

    // Tracks whether clearAllTracks() has already run — once true, the catch
    // block below must refresh the track-list UI no matter how import fails,
    // since AppState no longer matches whatever the DOM was last showing.
    let clearedExisting = false;

    const releaseBusy = BusyOverlay.begin('Importing project…');
    try {
      const zip = await JSZip.loadAsync(file);
      const manifestEntry = zip.file('manifest.json');
      if (!manifestEntry)
        throw new Error('Not a valid project file — manifest.json is missing.');

      const manifest = JSON.parse(await manifestEntry.async('string'));
      if (
        !manifest.tracks ||
        !Array.isArray(manifest.tracks) ||
        manifest.tracks.length === 0
      ) {
        throw new Error('Not a valid project file — manifest has no tracks.');
      }

      // Once we get past manifest validation we're committed to replacing the
      // session — clearedExisting flags that for the catch block below, so a
      // failure partway through still leaves the UI reflecting reality
      // (whatever tracks did load, or a clean empty state) instead of the
      // stale pre-import track list.
      Controllers.trackManager.clearAllTracks();
      clearedExisting = true;

      let newActiveId = null;
      const failedTracks = [];
      for (let i = 0; i < manifest.tracks.length; i++) {
        const entry = manifest.tracks[i];
        try {
          const csvEntry = entry.file ? zip.file(entry.file) : null;
          if (!csvEntry) throw new Error(`missing CSV "${entry.file}" in zip`);
          const csvText = await csvEntry.async('string');

          const analyzer = new GSRAnalyzer();
          analyzer.parseCSV(csvText); // restores filterParams/gpsFilterParams/labels/exclusions from the CSV's own embedded headers

          const filterParams =
            analyzer.importedFilterParams ||
            JSON.parse(JSON.stringify(GSR_CONST.GSR_DEFAULT));
          const gpsFilterParams =
            analyzer.importedGpsFilterParams ||
            JSON.parse(JSON.stringify(GSR_CONST.GPS_DEFAULT));
          analyzer.analyze(filterParams, gpsFilterParams.peakLatency || 0); // repopulate filtered/tonic/phasic/peaks so the track is ready to render immediately

          const trackId = `track_${Date.now()}_${Math.floor(Math.random() * 1000)}_${i}`;
          const newTrack = {
            id: trackId,
            name: entry.name || entry.file,
            color: entry.color || AppState.getNextTrackColor(),
            enabled: entry.enabled !== false,
            analyzer,
            filterParams,
            gpsFilterParams,
          };
          AppState.collectiveManager.addTrack(newTrack);
          if (i === manifest.activeTrackIndex) newActiveId = trackId;
        } catch (trackErr) {
          // One bad track (corrupt CSV, missing file) shouldn't sink the
          // whole batch — skip it and keep going, same policy
          // loadFilesSequentially() already uses for ordinary CSV drops.
          console.warn(
            `Skipping track "${entry.name || entry.file}" — failed to load:`,
            trackErr,
          );
          failedTracks.push(entry.name || entry.file || `track #${i + 1}`);
        }
      }

      if (AppState.collectiveManager.tracks.length === 0) {
        throw new Error('No tracks could be recovered from this project file.');
      }

      if (failedTracks.length > 0) {
        alert(
          `Imported with ${failedTracks.length} track(s) skipped (could not be read):\n` +
            failedTracks.join('\n'),
        );
      }

      // Make a track active first — this loads *that track's own* GSR/GPS
      // sliders and re-analyses, exactly like opening any track normally
      // would. In Collective view every track is analysed with its own
      // settings, so no track takes on the active one's.
      Controllers.trackManager.switchActiveTrack(
        newActiveId || AppState.collectiveManager.tracks[0].id,
      );

      // Restore Collective view's own settings: its Places settings (kept
      // apart from every walk's — see _collectiveSliderValues) and the
      // contour sliders. The Places sliders show them once the view is
      // Collective; contour applies *after* switchActiveTrack().
      if (manifest.settings) {
        for (const [key, val] of Object.entries(
          this._collectiveSliderValues(manifest.settings.sliders),
        )) {
          const n = Number(val);
          if (Number.isFinite(n)) AppState.collectivePlaces[key] = n;
        }
        this._applyValues(AppState.contourControls, manifest.settings.contour);
        // _applyValues() sets el.value directly, which does NOT fire an
        // 'input' event — so the on-screen text labels (e.g. "40 x 40" next
        // to Grid Resolution) and filter-off dim states never got the
        // memo, even though the slider thumb itself (native browser
        // behavior, always reflects the live .value) was already showing
        // the real restored value. Same fix storage.js's applyPreset()
        // already applies via syncSliderValueDisplays() after doing the
        // exact same direct .value assignment.
        if (
          Controllers.events &&
          typeof Controllers.events.initializeLabels === 'function'
        ) {
          Controllers.events.initializeLabels();
        }
      }
      // Even with no saved Places settings: clearAllTracks() reset them, and
      // the sliders must not keep showing the previous project's.
      if (AppState.viewMode === 'collective') {
        GSRStorage.showCollectivePlaces();
        Controllers.events?.initializeLabels?.();
      }

      const targetMode =
        manifest.tracks && manifest.tracks.length > 1
          ? 'collective'
          : manifest.viewMode === 'collective'
            ? 'collective'
            : 'single';
      if (AppState.viewMode !== targetMode) {
        const toggleBtn = document.getElementById(
          targetMode === 'collective' ? 'btnCollectiveView' : 'btnSingleView',
        );
        if (toggleBtn) toggleBtn.click();
      }

      if (manifest.viewToggles && AppState.mapManager) {
        Object.entries(manifest.viewToggles).forEach(([btnId, active]) => {
          const el = document.getElementById(btnId);
          const toggleMethod = this.VIEW_TOGGLE_BUTTONS[btnId];
          if (!el || !toggleMethod) return;
          el.classList.toggle('active', !!active);
          if (typeof AppState.mapManager[toggleMethod] === 'function') {
            AppState.mapManager[toggleMethod](!!active);
          }
        });
      }

      Controllers.trackManager.renderTrackList();

      if (AppState.viewMode === 'collective') {
        Controllers.ui.updateCollectiveMap();
      }
      if (typeof Controllers.ui?.refreshOsmControls === 'function') {
        Controllers.ui.refreshOsmControls();
      }
      if (typeof Controllers.ui?.updateEnvironmentalDashboard === 'function') {
        Controllers.ui.updateEnvironmentalDashboard();
      }
    } catch (err) {
      console.error('Project import failed:', err);
      alert(`Error importing project: ${err.message}`);

      if (clearedExisting) {
        // The old track list is already gone from AppState — make sure the
        // DOM agrees, whether that means showing whatever partial set of
        // tracks did load or falling back to the normal empty-library view.
        Controllers.trackManager.renderTrackList();
      }
    } finally {
      releaseBusy();
    }
  },
};

Controllers.collectiveProject = GSRCollectiveProject;
