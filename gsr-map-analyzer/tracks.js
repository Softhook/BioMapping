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

  handleFileSelect(e) {
    if (e.target.files.length > 0) {
      GSRTrackManager.loadFilesSequentially(Array.from(e.target.files));
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

          // Inherit current slider values so new track starts with the same active settings
          const filterParams = GSRStorage.readGsrSliderValues();
          const gpsFilterParams = GSRStorage.readGpsSliderValues();

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

          if (!AppState.activeTrackId) {
            GSRTrackManager.switchActiveTrack(trackId);
          } else {
            GSRTrackManager.renderTrackList();
          }

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

    listElement.innerHTML = '';

    AppState.collectiveManager.tracks.forEach(track => {
      const isEditing = (track.id === AppState.activeTrackId);

      const li = document.createElement('li');
      li.className = `track-item ${isEditing ? 'active' : ''}`;

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'track-checkbox';
      checkbox.checked = track.enabled;
      checkbox.title = 'Include in Collective Surface';
      checkbox.addEventListener('change', (e) => {
        track.enabled = e.target.checked;
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

      const meta = document.createElement('span');
      name.className = 'track-name';
      meta.className = 'track-meta';
      meta.innerText = `${track.analyzer.raw.length} pts | ${track.analyzer.peaks.length} peaks`;

      details.appendChild(name);
      details.appendChild(meta);

      const actions = document.createElement('div');
      actions.className = 'track-actions';

      const editBtn = document.createElement('button');
      editBtn.className = 'track-action-btn edit-btn';
      editBtn.title = 'Analyze and tweak filters';
      editBtn.innerHTML = '<i class="fa-solid fa-pencil"></i>';
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        GSRTrackManager.switchActiveTrack(track.id);
        if (AppState.viewMode === 'collective') {
          document.getElementById('btnSingleView').click();
        }
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

    document.getElementById('exportCsvBtn').removeAttribute('disabled');
    document.getElementById('exportImageBtn').removeAttribute('disabled');
    document.getElementById('exportMapBtn').removeAttribute('disabled');

    const placeholder = document.getElementById('canvasPlaceholder');
    if (placeholder) placeholder.style.display = 'none';

    GSRTrackManager.renderTrackList();
    loop();
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

    AppState.sliders.medianSize.value = params.medianSize;
    AppState.sliders.lpfWindow.value = params.lpfWindow;
    AppState.sliders.tonicWindow.value = params.tonicWindow;
    AppState.sliders.tonicMethod.value = params.tonicMethod;
    AppState.sliders.peakThreshold.value = params.peakThreshold;
    // Labels are updated by GSREvents.initializeLabels() called from switchActiveTrack
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

    if (p.minSats !== undefined)      S.gpsMinSats.value      = p.minSats;
    if (p.maxSpeed !== undefined)     S.gpsMaxSpeed.value     = p.maxSpeed;
    if (p.hampelWindow !== undefined) S.gpsHampelWindow.value = p.hampelWindow;
    if (p.hampelSigma !== undefined)  S.gpsHampelSigma.value  = p.hampelSigma;
    if (p.dbscanRadius !== undefined) S.gpsDBSCANRadius.value = p.dbscanRadius;
    if (p.dbscanMinPts !== undefined) S.gpsDBSCANMinPts.value = p.dbscanMinPts;
    if (p.kalmanR !== undefined)      S.gpsKalmanR.value      = p.kalmanR;
    if (p.kalmanQ !== undefined)      S.gpsKalmanQ.value      = p.kalmanQ;
    if (p.rdpTolerance !== undefined) S.gpsRDP.value          = p.rdpTolerance;
    if (p.downsample !== undefined)   S.gpsDownsample.value   = p.downsample;
    if (p.trackWeight !== undefined)  S.gpsTrackWeight.value  = p.trackWeight;
    if (p.peakLatency !== undefined)  S.gpsPeakLatency.value  = p.peakLatency;
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
  }
};
