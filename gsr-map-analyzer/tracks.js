/**
 * Track Library Management — file loading, track CRUD, and active track switching.
 * Extracted from ui.js.
 */

const GSRTrackManager = {
  /**
   * Get all enabled tracks — delegates to GSRCollectiveManager.
   */
  getActiveTracks() {
    return AppState.collectiveManager.getActiveTracks();
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
      GSRTrackManager.loadFilesSequentially(Array.from(e.target.files));
      if (wasFs) {
        // Chrome blocks programmatic requestFullscreen from change events — show restore pill
        this._showRestoreFsPill();
      }
    }
  },

  loadFilesSequentially(files) {
    let index = 0;
    const loadNext = () => {
      if (index >= files.length) {
        AppState.fileInput.value = "";
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

          // Inherit current slider values or use imported ones if parsing a processed CSV
          const filterParams = tempAnalyzer.importedFilterParams || GSRStorage.readGsrSliderValues();
          const gpsFilterParams = tempAnalyzer.importedGpsFilterParams || GSRStorage.readGpsSliderValues();

          const newTrack = {
            id: trackId,
            name: file.name,
            color: trackColor,
            enabled: true,
            analyzer: tempAnalyzer,
            filterParams: filterParams,
            gpsFilterParams: gpsFilterParams
          };

          AppState.collectiveManager.addTrack(newTrack);

          // Always switch to the newly loaded track so the user sees it immediately
          GSRTrackManager.switchActiveTrack(trackId);

          GSRTrackManager.setFileStatus('success', `${AppState.collectiveManager.tracks.length} Tracks Loaded`);

          if (AppState.viewMode === 'collective') {
            GSRUI.updateCollectiveMap();
          }

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

      document.getElementById('exportCsvBtn').setAttribute('disabled', 'true');
      document.getElementById('exportImageBtn').setAttribute('disabled', 'true');
      document.getElementById('exportMapBtn').setAttribute('disabled', 'true');

      if (AppState.mapManager) {
        AppState.mapManager.clearMap();
        AppState.mapManager.clearCollectiveLayers();
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
        if (typeof GSRUI !== 'undefined' && typeof GSRUI.invalidateEnvironmentalCache === 'function') {
          GSRUI.invalidateEnvironmentalCache();
        }
        if (AppState.viewMode === 'collective') GSRUI.updateCollectiveMap();
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
    GSREvents.initializeLabels();
    GSRUI.resetView();
    GSRUI.runAnalysis();
    GSRUI.refreshOsmControls();

    document.getElementById('exportCsvBtn').removeAttribute('disabled');
    document.getElementById('exportImageBtn').removeAttribute('disabled');
    document.getElementById('exportMapBtn').removeAttribute('disabled');

    const placeholder = document.getElementById('canvasPlaceholder');
    if (placeholder) placeholder.style.display = 'none';

    GSRTrackManager.renderTrackList();
    loop();
    requestAnimationFrame(() => windowResized());
  },

  deleteTrack(trackId) {
    // Save current GPS params before switching away
    GSRTrackManager.saveActiveGpsParams();

    AppState.collectiveManager.removeTrack(trackId);

    if (AppState.activeTrackId === trackId) {
      if (AppState.collectiveManager.tracks.length > 0) {
        GSRTrackManager.switchActiveTrack(AppState.collectiveManager.tracks[0].id);
      } else {
        AppState.activeTrackId = null;
        AppState.analyzer = new GSRAnalyzer();
      }
    }

    GSRTrackManager.renderTrackList();

    if (AppState.collectiveManager.tracks.length > 0) {
      GSRTrackManager.setFileStatus('success', `${AppState.collectiveManager.tracks.length} Tracks Loaded`);
    } else {
      GSRTrackManager.setFileStatus('warning', 'No File Loaded');
    }

    if (AppState.viewMode === 'collective') {
      GSRUI.updateCollectiveMap();
    }
  },

  loadActiveTrackParams(track) {
    if (!track || !track.filterParams) return;
    const params = track.filterParams;
    const S = AppState.sliders;

    const gsrKeys = [
      'medianSize', 'lpfWindow', 'tonicWindow', 'tonicMethod', 'peakThreshold', 'dwtLevel',
      'shapeMinRiseTime', 'shapeMaxRiseTime', 'shapeMinHalfRecovery', 'shapeMaxHalfRecovery',
      'shapeMinSnr', 'shapeMaxSkewRatio'
    ];

    for (const key of gsrKeys) {
      if (params[key] !== undefined && S[key]) {
        S[key].value = params[key];
      }
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
    const p = track.gpsFilterParams;
    const S = AppState.sliders;

    const gpsMap = {
      smoothing: 'gpsSmoothing',
      kalmanR: 'gpsKalmanR',
      maxHdop: 'gpsMaxHdop',
      maxSpeed: 'gpsMaxSpeed',
      rdpTolerance: 'gpsRDP',
      downsample: 'gpsDownsample',
      trackWeight: 'gpsTrackWeight',
      peakLatency: 'gpsPeakLatency'
    };

    for (const [paramKey, sliderKey] of Object.entries(gpsMap)) {
      if (p[paramKey] !== undefined && S[sliderKey]) {
        S[sliderKey].value = p[paramKey];
      }
    }
  },

  clearFile() {
    if (AppState.activeTrackId) {
      GSRTrackManager.deleteTrack(AppState.activeTrackId);
    } else {
      AppState.collectiveManager.tracks = [];
      GSRTrackManager.renderTrackList();
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
   * Load the default demo track from default_processed.csv.
   */
  loadDefaultTrack() {
    fetch('../default_processed.csv')
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

          const filterParams = GSRStorage.readGsrSliderValues();
          const gpsFilterParams = GSRStorage.readGpsSliderValues();

          const newTrack = {
            id: trackId,
            name: 'default_processed.csv',
            color: trackColor,
            enabled: true,
            analyzer: tempAnalyzer,
            filterParams: filterParams,
            gpsFilterParams: gpsFilterParams
          };

          AppState.collectiveManager.addTrack(newTrack);

          GSRTrackManager.switchActiveTrack(trackId);
          GSRTrackManager.renderTrackList();

          GSRTrackManager.setFileStatus('success', AppState.collectiveManager.tracks.length + ' Tracks Loaded');

          if (AppState.viewMode === 'collective') {
            GSRUI.updateCollectiveMap();
          }
        } catch (err) {
          alert('Error parsing demo data: ' + err.message);
        }
      })
      .catch(err => {
        alert('Error loading demo data: ' + err.message);
      });
  }
};
