// Copyright (c) 2026 Christian Nold
// Licensed under the Bio Mapping Community Licence 1.0.
// See LICENCE.md in the project root for terms.

/**
 * GSRTrackManager — getting recordings into the track library: the file
 * picker, drag & drop, project zips, and the demo track. Object-augment split
 * from tracks.mjs: spread into the shared GSRTrackManager object.
 *
 * Methods reach the rest of the manager through Controllers.trackManager, not
 * `this`: handleFileSelect is passed to addEventListener unbound, so its
 * `this` is the <input>.
 */
import { AppState } from '../core/app_state.mjs';
import { BusyOverlay } from '../core/busy_overlay.mjs';
import { Controllers } from '../core/controllers.mjs';
import { GSRFullscreen } from '../core/fullscreen.mjs';
import { GSRNotices } from '../core/notices.mjs';
import { GSRAnalyzer } from '../signal/analyzer.mjs';

export const TrackLoading = {
  /** Saved before file dialog opens (browser exits fullscreen on dialog open). */
  _browserFsSave: false,

  handleFileSelect(e) {
    const TM = Controllers.trackManager;
    if (e.target.files.length > 0) {
      const wasFs = TM._browserFsSave;
      TM._browserFsSave = false;
      TM.handleIncomingFiles(Array.from(e.target.files));
      if (wasFs) {
        // Chrome blocks programmatic requestFullscreen from change events — show restore pill
        GSRFullscreen.showRestorePill('.app-container');
      }
    }
  },

  /**
   * Single entry point for both the file-browser input and drag & drop —
   * one selector handles everything, same as before the project-export
   * feature existed. A .zip is treated as a previously-exported collective
   * project (see collective_project.js) and replaces the whole track
   * library; anything else is treated as one or more individual GSR CSVs
   * and loaded exactly as always. Mixing a project zip with loose CSVs in
   * one drop isn't a meaningful combination (importing a project already
   * replaces the track list), so if a zip is present it wins and any other
   * files dropped alongside it are ignored.
   */
  handleIncomingFiles(files) {
    const zipFile = files.find((f) => /\.zip$/i.test(f.name));
    if (zipFile) {
      if (files.length > 1) {
        console.warn(
          `Project zip "${zipFile.name}" was selected alongside other files — importing only the project; ignoring the rest.`,
        );
      }
      if (Controllers.collectiveProject) {
        Controllers.collectiveProject.importProject(zipFile);
      }
      if (AppState.fileInput) AppState.fileInput.value = '';
      return;
    }
    Controllers.trackManager.loadFilesSequentially(files);
  },

  loadFilesSequentially(files) {
    let index = 0;
    const releaseBusy = BusyOverlay.begin(
      files.length > 1 ? 'Loading tracks…' : 'Loading track…',
    );
    const loadNext = () => {
      if (index >= files.length) {
        if (AppState.fileInput) AppState.fileInput.value = '';
        releaseBusy();
        return;
      }
      const file = files[index];
      const reader = new FileReader();
      reader.onload = (event) => {
        try {
          Controllers.trackManager._addParsedTrack(
            event.target.result,
            `track_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
            file.name,
          );
        } catch (err) {
          GSRNotices.report(`Error parsing "${file.name}": ${err.message}`);
        }
        index++;
        loadNext();
      };
      reader.onerror = () => {
        GSRNotices.report(`Could not read "${file.name}".`);
        index++;
        loadNext();
      };
      reader.readAsText(file);
    };
    loadNext();
  },

  /**
   * Parse one CSV into a new track, add it to the library and switch to it,
   * so the user sees it immediately. No separate list or collective-map
   * refresh is needed: switchActiveTrack() ends with renderTrackList(), and
   * its GSRUI.runAnalysis() calls updateCollectiveMap() whenever
   * AppState.viewMode isn't 'single'. Throws if the CSV can't be parsed.
   */
  _addParsedTrack(csvText, trackId, trackName) {
    const TM = Controllers.trackManager;
    const analyzer = new GSRAnalyzer();
    analyzer.parseCSV(csvText);
    AppState.collectiveManager.addTrack(
      TM.createTrackObject(
        trackId,
        trackName,
        AppState.getNextTrackColor(),
        analyzer,
      ),
    );
    TM.switchActiveTrack(trackId);
  },

  /**
   * Load the default demo track from fixtures/default_processed.csv.
   */
  loadDefaultTrack() {
    fetch('fixtures/default_processed.csv')
      .then((response) => {
        if (!response.ok)
          throw new Error(`HTTP ${response.status} — could not load demo data`);
        return response.text();
      })
      .then((csvText) => {
        try {
          Controllers.trackManager._addParsedTrack(
            csvText,
            `track_demo_${Date.now()}`,
            'default_processed.csv',
          );
        } catch (err) {
          GSRNotices.report(`Error parsing demo data: ${err.message}`);
        }
      })
      .catch((err) => {
        GSRNotices.report(`Error loading demo data: ${err.message}`);
      });
  },
};
