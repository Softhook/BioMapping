/**
 * Track Library Management — file loading, track CRUD, and active track switching.
 * Extracted from ui.js.
 */

const GSRTrackManager = {
  /**
   * Buttons that only make sense once at least one track is loaded — kept in
   * one place so renderTrackList()'s empty-state branch and
   * switchActiveTrack() can't drift apart when a button gets added/removed.
   */
  EXPORT_BUTTON_IDS: ['exportCsvBtn', 'exportImageBtn', 'exportMapBtn', 'exportSvgBtn', 'exportCzmlBtn', 'exportKmlBtn', 'exportProjectBtn'],

  /**
   * Get all enabled tracks — delegates to GSRCollectiveManager.
   */
  getActiveTracks() {
    return AppState.collectiveManager.getActiveTracks();
  },

  createTrackObject(trackId, trackName, trackColor, analyzer) {
    const filterParams = analyzer.importedFilterParams || JSON.parse(JSON.stringify(GSR_CONST.GSR_DEFAULT));
    const gpsFilterParams = analyzer.importedGpsFilterParams || JSON.parse(JSON.stringify(GSR_CONST.GPS_DEFAULT));

    return {
      id: trackId,
      name: trackName,
      color: trackColor,
      enabled: true,
      analyzer: analyzer,
      filterParams: filterParams,
      gpsFilterParams: gpsFilterParams,
      settingsSource: analyzer.importedFilterParams ? 'imported' : 'standard',
      // Phase 1 (slice 1): the track's single Leaflet rendering handle — an
      // L.layerGroup() owning this track's path/peak/hotspot layers. Lazily
      // created by GSRMapManager._getTrackLayerGroup() on first render; null
      // when the track owns nothing on the map. Removing the track = removing
      // this group from the map.
      layerGroup: null,
      // Phase 1 (slice 3): the full registry of this track's render layers
      // (visible + hidden) so visibility toggles can restore hidden ones. The
      // layerGroup only holds the currently-visible layers. Populated by
      // GSRMapManager._registerTrackLayer().
      _ownedLayers: []
    };
  },

  /** Saved before file dialog opens (browser exits fullscreen on dialog open). */
  _browserFsSave: false,
  /** Currently showing restore-fullscreen pill (avoid duplicates). */
  _restorePillEl: null,

  /** Show a floating pill that restores fullscreen on click (Chrome blocks programmatic FS after file dialog). */
  _showRestoreFsPill() {
    if (this._restorePillEl) return; // already showing

    const pill = document.createElement('div');
    pill.style.cssText = `
      position:fixed;top:18px;left:50%;transform:translateX(-50%);z-index:10002;
      background:rgba(0,0,0,0.82);color:#fff;font-family:Inter,sans-serif;font-size:0.82rem;
      font-weight:600;padding:8px 18px;border-radius:22px;cursor:pointer;
      display:flex;align-items:center;gap:8px;box-shadow:0 4px 24px rgba(0,0,0,0.2);
      backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);
    `;
    pill.innerHTML = '<i class="fa-solid fa-expand"></i> Restore Fullscreen <span style="opacity:0.55;font-weight:400;">(click here)</span>';

    // Inject a <style> block for the fade-in animation
    if (!document.getElementById('fs-restore-anim')) {
      const s = document.createElement('style');
      s.id = 'fs-restore-anim';
      s.textContent = '@keyframes fs-pill-in{from{opacity:0;transform:translateX(-50%) translateY(-12px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}';
      document.head.appendChild(s);
    }
    pill.style.animation = 'fs-pill-in 0.35s ease';

    pill.addEventListener('click', (e) => {
      e.stopPropagation();
      pill.remove();
      this._restorePillEl = null;
      const el = document.querySelector('.app-container');
      if (el) Fullscreen.request(el);
    });

    document.body.appendChild(pill);
    this._restorePillEl = pill;

    // Auto-dismiss after 8 s
    setTimeout(() => {
      if (this._restorePillEl === pill) {
        pill.style.opacity = '0';
        pill.style.transition = 'opacity 0.4s ease';
        setTimeout(() => {
          if (pill.parentNode) pill.remove();
          if (this._restorePillEl === pill) this._restorePillEl = null;
        }, 400);
      }
    }, 8000);
  },

  handleFileSelect(e) {
    if (e.target.files.length > 0) {
      const wasFs = this._browserFsSave;
      this._browserFsSave = false;
      GSRTrackManager.handleIncomingFiles(Array.from(e.target.files));
      if (wasFs) {
        // Chrome blocks programmatic requestFullscreen from change events — show restore pill
        this._showRestoreFsPill();
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
    const zipFile = files.find(f => /\.zip$/i.test(f.name));
    if (zipFile) {
      if (files.length > 1) {
        console.warn(`Project zip "${zipFile.name}" was selected alongside other files — importing only the project; ignoring the rest.`);
      }
      if (typeof GSRCollectiveProject !== 'undefined') {
        GSRCollectiveProject.importProject(zipFile);
      }
      if (AppState.fileInput) AppState.fileInput.value = '';
      return;
    }
    GSRTrackManager.loadFilesSequentially(files);
  },

  loadFilesSequentially(files) {
    let index = 0;
    const loadNext = () => {
      if (index >= files.length) {
        if (AppState.fileInput) AppState.fileInput.value = "";
        return;
      }
      const file = files[index];
      const reader = new FileReader();
      reader.onload = (event) => {
        try {
          const text = event.target.result;

          const tempAnalyzer = new GSRAnalyzer();
          tempAnalyzer.parseCSV(text);

          const trackId = 'track_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
          const trackColor = AppState.getNextTrackColor();

          const newTrack = GSRTrackManager.createTrackObject(trackId, file.name, trackColor, tempAnalyzer);

          AppState.collectiveManager.addTrack(newTrack);

          // Always switch to the newly loaded track so the user sees it immediately.
          // No separate "refresh the collective map" call needed here: switchActiveTrack()
          // -> GSRUI.runAnalysis() already calls updateCollectiveMap() whenever
          // AppState.viewMode isn't 'single' (ui.js).
          GSRTrackManager.switchActiveTrack(trackId);

          GSRTrackManager.setFileStatus('success', `${AppState.collectiveManager.tracks.length} Tracks Loaded`);

          index++;
          loadNext();
        } catch (err) {
          alert(`Error parsing "${file.name}": ` + err.message);
          index++;
          loadNext();
        }
      };
      reader.readAsText(file);
    };
    loadNext();
  },

  /**
   * Small status icon for the CSV integrity bracket (see docs/csv_schema.md
   * and GSRCSVParser._verifyIntegrity). Returns null for files that carry no
   * integrity data at all, so pre-integrity tracks show nothing rather than
   * a scary marker.
   */
  _buildIntegrityMark(track) {
    const info = track.analyzer && track.analyzer.integrity;
    if (!info || info.status === 'none') return null;

    const SPEC = {
      verified:   { icon: 'fa-circle-check',         label: 'Integrity verified' },
      incomplete: { icon: 'fa-triangle-exclamation', label: 'Recording did not end cleanly' },
      corrupt:    { icon: 'fa-circle-xmark',         label: 'Integrity check failed' },
    };
    const spec = SPEC[info.status];
    if (!spec) return null;

    const mark = document.createElement('span');
    mark.className = 'track-integrity track-integrity-' + info.status;
    mark.innerHTML = `<i class="fa-solid ${spec.icon}"></i>`;
    mark.title = info.detail ? `${spec.label} — ${info.detail}` : spec.label;
    return mark;
  },

  renderTrackList() {
    const container   = document.getElementById('trackListContainer');
    const listElement = document.getElementById('trackList');
    const dropZone    = AppState.dropZone;

    if (AppState.collectiveManager.tracks.length === 0) {
      noLoop();
      container.style.display = 'none';
      dropZone.style.display = 'flex';
      dropZone.classList.remove('compact');

      AppState.analyzer = new GSRAnalyzer();
      AppState.activeTrackId = null;

      GSRUI.updatePeaksTable();
      GSRUI.updateStatsPanel();
      GSRUI.updateDeconvTruncationWarning();

      GSRTrackManager.EXPORT_BUTTON_IDS.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.setAttribute('disabled', 'true');
      });

      if (AppState.mapManager) {
        AppState.mapManager.clearAll();
      }
      if (typeof GSRGlobe3DView !== 'undefined' && GSRGlobe3DView.manager) {
        GSRGlobe3DView.manager.clearAll();
        if (GSRGlobe3DView.els.legend) GSRGlobe3DView.els.legend.innerHTML = '';
      }

      GSRTrackManager.setFileStatus('warning', 'No File Loaded');

      const placeholder = document.getElementById('canvasPlaceholder');
      if (placeholder) placeholder.style.display = 'flex';
      noLoop();
      GSRRenderer.drawPlaceholder();
      return;
    }

    container.style.display = 'block';
    dropZone.style.display = 'flex';
    dropZone.classList.add('compact');

    // Track which track is currently being renamed (null if none)
    AppState._renamingTrackId = null;

    listElement.innerHTML = '';

    AppState.collectiveManager.tracks.forEach(track => {
      const isEditing = (track.id === AppState.activeTrackId);

      const li = document.createElement('li');
      li.className = `track-item ${isEditing ? 'active' : ''}`;
      li.dataset.trackId = track.id;

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'track-checkbox';
      checkbox.checked = track.enabled;
      checkbox.title = 'Include in Collective Surface';
      checkbox.addEventListener('change', (e) => {
        track.enabled = e.target.checked;
        if (AppState.viewMode === 'collective') {
          GSRUI.updateCollectiveMap();
          GSRUI.refreshOsmControls();
        }
      });

      const badge = document.createElement('span');
      badge.className = 'track-color-badge';
      badge.style.backgroundColor = track.color;

      const details = document.createElement('div');
      details.className = 'track-details';
      details.title = 'Click to analyze and tweak';
      details.addEventListener('click', () => GSRTrackManager.switchActiveTrack(track.id));

      const name = document.createElement('span');
      name.className = 'track-name';
      name.innerText = track.name;

      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.className = 'track-name-input';
      nameInput.value = track.name;
      nameInput.style.display = 'none';
      nameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          GSRTrackManager.finishRenameTrack(track.id, nameInput.value.trim() || track.name);
        } else if (e.key === 'Escape') {
          GSRTrackManager.cancelRenameTrack();
        }
        e.stopPropagation();
      });
      nameInput.addEventListener('blur', () => {
        GSRTrackManager.finishRenameTrack(track.id, nameInput.value.trim() || track.name);
      });

      const meta = document.createElement('span');
      meta.className = 'track-meta';
      const a = track.analyzer;
      const hasClock = a.recordingStartTime && a.recordingStartTime >= 86400;
      meta.innerText = hasClock
        ? a.formatDateShort(0) + ' ' + a.formatTimeOnly(0)
        : '';

      details.appendChild(name);
      details.appendChild(nameInput);
      details.appendChild(meta);

      const actions = document.createElement('div');
      actions.className = 'track-actions';

      const editBtn = document.createElement('button');
      editBtn.className = 'track-action-btn edit-btn';
      editBtn.title = 'Rename track';
      editBtn.innerHTML = '<i class="fa-solid fa-pencil"></i>';
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        GSRTrackManager.startRenameTrack(track.id);
      });

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'track-action-btn delete-btn';
      deleteBtn.title = 'Remove track';
      deleteBtn.innerHTML = '<i class="fa-solid fa-trash-can"></i>';
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        GSRTrackManager.deleteTrack(track.id);
      });

      actions.appendChild(editBtn);
      actions.appendChild(deleteBtn);

      li.appendChild(checkbox);
      li.appendChild(badge);
      li.appendChild(details);
      const integrityMark = GSRTrackManager._buildIntegrityMark(track);
      if (integrityMark) li.appendChild(integrityMark);
      li.appendChild(actions);

      listElement.appendChild(li);
    });
  },

  switchActiveTrack(trackId) {
    AppState.activeTrackId = trackId;
    const track = AppState.collectiveManager.getTrack(trackId);
    if (!track) return;

    AppState.analyzer = track.analyzer;
    AppState.analyzer.rawMinMaxCached = null; // invalidate timeline cache
    AppState.totalDuration = (AppState.analyzer.raw.length > 0 &&
      AppState.analyzer.raw[AppState.analyzer.raw.length - 1] &&
      AppState.analyzer.raw[0])
      ? (AppState.analyzer.raw[AppState.analyzer.raw.length - 1].time - AppState.analyzer.raw[0].time)
      : 0;

    GSRTrackManager.loadActiveTrackParams(track);
    GSRTrackManager.loadActiveGpsParams(track);
    // Refresh the shape-slider show/hide state for the new track's detector
    // (deconvolution / prominence / trough) — loadActiveTrackParams only
    // writes the values, not the disabled/visible state.
    if (typeof GSREvents.updateDeconvolutionUIState === 'function') {
      GSREvents.updateDeconvolutionUIState();
    }
    GSREvents.initializeLabels();
    GSRUI.resetView();
    GSRUI.runAnalysis();
    GSRUI.refreshOsmControls();

    GSRTrackManager.EXPORT_BUTTON_IDS.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.removeAttribute('disabled');
    });

    const placeholder = document.getElementById('canvasPlaceholder');
    if (placeholder) placeholder.style.display = 'none';

    GSRTrackManager.renderTrackList();
    // No loop() here — the canvas renders on demand via the redraw() calls
    // already made above/below (resetView(), runAnalysis(), windowResized()'s
    // resizeCanvas()); see docs/archive/visualizer_rendering_perf_routes.md §2.5 for
    // why continuous looping was removed.
    requestAnimationFrame(() => windowResized());
  },

  /**
   * Wipe the entire track library back to a fresh-session state — every track,
   * the active-track pointer, and the map's rendered layers. Used by
   * GSRCollectiveProject.importProject() to clear the deck before restoring
   * tracks from a project zip; unlike deleteTrack() in a loop, this skips the
   * per-track teardown work (switching active track, re-analyzing, etc.)
   * since the caller is about to rebuild everything from scratch anyway.
   */
  clearAllTracks() {
    AppState.collectiveManager.tracks = [];
    AppState.activeTrackId = null;
    AppState.analyzer = new GSRAnalyzer();
    AppState.trackColorIndex = 0; // restart the color palette, matching a fresh page load

    if (AppState.mapManager) {
      AppState.mapManager.clearAll();
    }
  },

  deleteTrack(trackId) {
    const track = AppState.collectiveManager.getTrack(trackId);
    if (!track) return;

    const performDelete = () => {
      // Save current GPS params before switching away
      GSRTrackManager.saveActiveGpsParams();

      // Phase 1 (slice 1): removal = map.removeLayer(track.layerGroup). Do this
      // before removing the track from the manager so the switch-active-track /
      // clearAll paths below never leave an orphaned group behind. Slice 2: also
      // forget the group from the map manager's rendered-set.
      if (AppState.mapManager && AppState.mapManager.map && track.layerGroup) {
        if (AppState.mapManager.map.hasLayer(track.layerGroup)) {
          AppState.mapManager.map.removeLayer(track.layerGroup);
        }
        track.layerGroup = null;
        if (typeof AppState.mapManager._forgetTrackGroup === 'function') {
          AppState.mapManager._forgetTrackGroup(trackId);
        }
      }

      AppState.collectiveManager.removeTrack(trackId);

      if (AppState.activeTrackId === trackId) {
        if (AppState.collectiveManager.tracks.length > 0) {
          GSRTrackManager.switchActiveTrack(AppState.collectiveManager.tracks[0].id);
        } else {
          AppState.activeTrackId = null;
          AppState.analyzer = new GSRAnalyzer();
        }
      }

      if (AppState.collectiveManager.tracks.length > 0) {
        GSRTrackManager.setFileStatus('success', `${AppState.collectiveManager.tracks.length} Tracks Loaded`);
      } else {
        GSRTrackManager.setFileStatus('warning', 'No File Loaded');
      }

      // Phase 3 pilot (docs/archive/visualizer_architecture_refactor_plan.md): notify
      // interested modules instead of calling them directly by name.
      // GSRTrackManager (renderTrackList), GSRMapManager (clearAll when the
      // library goes empty), and GSRUI (updateCollectiveMap in collective
      // view) each subscribe to 'trackRemoved' independently — see the
      // AppState.on(...) registrations in sketch.js's setup().
      AppState.emit('trackRemoved', trackId);
    };

    if (track.hasUnsavedLabels) {
      GSRUI.showUnsavedLabelsModal(track.name, trackId, performDelete);
    } else {
      performDelete();
    }
  },

  loadActiveTrackParams(track) {
    if (!track || !track.filterParams) return;
    const params = track.filterParams;
    const S = AppState.sliders;
    const isDeconvOn = !!params.useDeconvolution;

    for (const key of Object.keys(params)) {
      if (S[key]) {
        if (isDeconvOn && key.startsWith('shape') && key !== 'shapeMinSnr') {
          S[key].dataset.customValue = params[key];
        } else {
          delete S[key].dataset.customValue;
          S[key].value = params[key];
        }
      }
    }

    if (S.useDeconvolution && params.useDeconvolution !== undefined) {
      S.useDeconvolution.checked = !!params.useDeconvolution;
    }
    if (S.usePeakProminence && params.usePeakProminence !== undefined) {
      S.usePeakProminence.checked = !!params.usePeakProminence;
    }
    // Mutually exclusive detectors — prominence wins if a stored config has both.
    if (S.usePeakProminence && S.usePeakProminence.checked && S.useDeconvolution) {
      S.useDeconvolution.checked = false;
    }
  },

  saveActiveTrackParams() {
    if (!AppState.activeTrackId) return;
    const track = AppState.collectiveManager.getTrack(AppState.activeTrackId);
    if (!track) return;

    track.filterParams = GSRStorage.readGsrSliderValues();
  },

  saveActiveGpsParams() {
    if (!AppState.activeTrackId) return;
    const track = AppState.collectiveManager.getTrack(AppState.activeTrackId);
    if (!track) return;

    track.gpsFilterParams = GSRStorage.readGpsSliderValues();
  },

  loadActiveGpsParams(track) {
    if (!track || !track.gpsFilterParams) return;
    if (typeof GSRStorage !== 'undefined' && typeof GSRStorage.writeGpsSliderValues === 'function') {
      GSRStorage.writeGpsSliderValues(track.gpsFilterParams);
      return;
    }
    const p = track.gpsFilterParams;
    const S = AppState.sliders;
    if (!S) return;

    const gpsMap = {
      smoothing: 'gpsSmoothing',
      kalmanR: 'gpsKalmanR',
      maxHdop: 'gpsMaxHdop',
      maxSpeed: 'gpsMaxSpeed',
      rdpTolerance: 'gpsRDP',
      downsample: 'gpsDownsample',
      trackWeight: 'gpsTrackWeight',
      peakLatency: 'gpsPeakLatency',
      clusterProximity: 'clusterProximity',
      clusterBoundaryRadius: 'clusterBoundaryRadius'
    };

    for (const [key, val] of Object.entries(p)) {
      if (val === undefined) continue;
      const sliderKey = gpsMap[key] || ('gps' + key.charAt(0).toUpperCase() + key.slice(1));
      const slider = S[sliderKey] || S[key];
      if (slider) {
        slider.value = val;
      }
    }
  },

  /**
   * Update the file status indicator in the header.
   */
  setFileStatus(type, text) {
    const el = document.getElementById('fileStatus');
    if (!el) return;
    el.querySelector('.status-dot').className = `status-dot ${type}`;
    el.querySelector('.status-text').innerText = text;
  },

  /**
   * Start renaming a track — replace the name span with an input field.
   */
  startRenameTrack(trackId) {
    // Cancel any existing rename first
    if (AppState._renamingTrackId) {
      GSRTrackManager.cancelRenameTrack();
    }

    const track = AppState.collectiveManager.getTrack(trackId);
    if (!track) return;

    AppState._renamingTrackId = trackId;

    const item = document.querySelector(`li[data-track-id="${trackId}"]`);
    if (!item) return;

    const nameSpan = item.querySelector('.track-name');
    const nameInput = item.querySelector('.track-name-input');
    if (!nameSpan || !nameInput) return;

    nameSpan.style.display = 'none';
    nameInput.style.display = '';
    nameInput.value = track.name;
    nameInput.focus();
    nameInput.select();
  },

  /**
   * Finish renaming — save the new name and re-render the track list.
   */
  finishRenameTrack(trackId, newName) {
    if (AppState._renamingTrackId !== trackId) return;
    AppState._renamingTrackId = null;

    const track = AppState.collectiveManager.getTrack(trackId);
    if (!track) return;

    track.name = newName;
    GSRTrackManager.renderTrackList();
  },

  /**
   * Cancel renaming — restore the name span without saving.
   */
  cancelRenameTrack() {
    if (!AppState._renamingTrackId) return;
    AppState._renamingTrackId = null;
    GSRTrackManager.renderTrackList();
  },

  /**
   * Load the default demo track from fixtures/default_processed.csv.
   */
  loadDefaultTrack() {
    fetch('fixtures/default_processed.csv')
      .then(response => {
        if (!response.ok) throw new Error('HTTP ' + response.status + ' — could not load demo data');
        return response.text();
      })
      .then(csvText => {
        try {
          const tempAnalyzer = new GSRAnalyzer();
          tempAnalyzer.parseCSV(csvText);

          const trackId = 'track_demo_' + Date.now();
          const trackColor = AppState.getNextTrackColor();

          const newTrack = GSRTrackManager.createTrackObject(trackId, 'default_processed.csv', trackColor, tempAnalyzer);

          AppState.collectiveManager.addTrack(newTrack);

          // switchActiveTrack() already ends by calling renderTrackList() itself, and
          // (via GSRUI.runAnalysis()) updateCollectiveMap() whenever AppState.viewMode
          // isn't 'single' — no separate calls needed here (see loadFilesSequentially above).
          GSRTrackManager.switchActiveTrack(trackId);

          GSRTrackManager.setFileStatus('success', AppState.collectiveManager.tracks.length + ' Tracks Loaded');
        } catch (err) {
          alert('Error parsing demo data: ' + err.message);
        }
      })
      .catch(err => {
        alert('Error loading demo data: ' + err.message);
      });
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GSRTrackManager };
}
if (typeof window !== 'undefined') {
  window.GSRTrackManager = GSRTrackManager;
}
