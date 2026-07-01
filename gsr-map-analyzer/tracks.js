/**
 * Track Library Management — file loading, track CRUD, and active track switching.
 * Extracted from ui.js.
 */

function handleFileSelect(e) {
  if (e.target.files.length > 0) {
    loadFilesSequentially(Array.from(e.target.files));
  }
}

function loadFilesSequentially(files) {
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
        const S = AppState.sliders;
        const filterParams = {
          medianSize:    parseFloat(S.medianSize.value),
          lpfWindow:     parseFloat(S.lpfWindow.value),
          tonicMethod:   S.tonicMethod.value,
          tonicWindow:   parseInt(S.tonicWindow.value),
          peakThreshold: parseFloat(S.peakThreshold.value)
        };
        const gpsFilterParams = readGpsSliderValues();

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
          switchActiveTrack(trackId);
        } else {
          renderTrackList();
        }

        setFileStatus('success', `${AppState.collectiveManager.tracks.length} Tracks Loaded`);

        if (AppState.viewMode === 'collective') {
          updateCollectiveMap();
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
}

function renderTrackList() {
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

    document.getElementById('exportCsvBtn').setAttribute('disabled', 'true');
    document.getElementById('exportImageBtn').setAttribute('disabled', 'true');
    document.getElementById('exportMapBtn').setAttribute('disabled', 'true');

    if (AppState.mapManager) {
      AppState.mapManager.clearMap();
      AppState.mapManager.clearCollectiveLayers();
    }

    setFileStatus('warning', 'No File Loaded');

    const placeholder = document.getElementById('canvasPlaceholder');
    if (placeholder) placeholder.style.display = 'flex';
    noLoop();
    drawPlaceholder();
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
      if (AppState.viewMode === 'collective') updateCollectiveMap();
    });

    const badge = document.createElement('span');
    badge.className = 'track-color-badge';
    badge.style.backgroundColor = track.color;

    const details = document.createElement('div');
    details.className = 'track-details';
    details.title = 'Click to analyze and tweak';
    details.addEventListener('click', () => switchActiveTrack(track.id));

    const name = document.createElement('span');
    name.className = 'track-name';
    name.innerText = track.name;

    const meta = document.createElement('span');
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
      switchActiveTrack(track.id);
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
      deleteTrack(track.id);
    });

    actions.appendChild(editBtn);
    actions.appendChild(deleteBtn);

    li.appendChild(checkbox);
    li.appendChild(badge);
    li.appendChild(details);
    li.appendChild(actions);

    listElement.appendChild(li);
  });
}

function switchActiveTrack(trackId) {
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

  loadActiveTrackParams(track);
  loadActiveGpsParams(track);
  initializeLabels();
  resetView();
  runAnalysis();

  document.getElementById('exportCsvBtn').removeAttribute('disabled');
  document.getElementById('exportImageBtn').removeAttribute('disabled');
  document.getElementById('exportMapBtn').removeAttribute('disabled');

  const placeholder = document.getElementById('canvasPlaceholder');
  if (placeholder) placeholder.style.display = 'none';

  renderTrackList();
  loop();
}

function deleteTrack(trackId) {
  // Save current GPS params before switching away
  saveActiveGpsParams();

  AppState.collectiveManager.removeTrack(trackId);

  if (AppState.activeTrackId === trackId) {
    if (AppState.collectiveManager.tracks.length > 0) {
      switchActiveTrack(AppState.collectiveManager.tracks[0].id);
    } else {
      AppState.activeTrackId = null;
      AppState.analyzer = new GSRAnalyzer();
    }
  }

  renderTrackList();

  if (AppState.collectiveManager.tracks.length > 0) {
    setFileStatus('success', `${AppState.collectiveManager.tracks.length} Tracks Loaded`);
  } else {
    setFileStatus('warning', 'No File Loaded');
  }

  if (AppState.viewMode === 'collective') {
    updateCollectiveMap();
  }
}

function loadActiveTrackParams(track) {
  if (!track || !track.filterParams) return;
  const params = track.filterParams;

  AppState.sliders.medianSize.value = params.medianSize;
  AppState.sliders.lpfWindow.value = params.lpfWindow;
  AppState.sliders.tonicWindow.value = params.tonicWindow;
  AppState.sliders.tonicMethod.value = params.tonicMethod;
  AppState.sliders.peakThreshold.value = params.peakThreshold;
  // Labels are updated by initializeLabels() called from switchActiveTrack
}

function saveActiveTrackParams() {
  if (!AppState.activeTrackId) return;
  const track = AppState.collectiveManager.getTrack(AppState.activeTrackId);
  if (!track) return;

  const S = AppState.sliders;
  track.filterParams = {
    medianSize:    parseFloat(S.medianSize.value),
    lpfWindow:     parseFloat(S.lpfWindow.value),
    tonicMethod:   S.tonicMethod.value,
    tonicWindow:   parseInt(S.tonicWindow.value),
    peakThreshold: parseFloat(S.peakThreshold.value)
  };
}

function saveActiveGpsParams() {
  if (!AppState.activeTrackId) return;
  const track = AppState.collectiveManager.getTrack(AppState.activeTrackId);
  if (!track) return;

  track.gpsFilterParams = readGpsSliderValues();
}

function loadActiveGpsParams(track) {
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
  if (p.minDist !== undefined)      S.gpsMinDist.value      = p.minDist;
  if (p.downsample !== undefined)   S.gpsDownsample.value   = p.downsample;
  if (p.trackWeight !== undefined)  S.gpsTrackWeight.value  = p.trackWeight;
}

function clearFile() {
  if (AppState.activeTrackId) {
    deleteTrack(AppState.activeTrackId);
  } else {
    AppState.collectiveManager.tracks = [];
    renderTrackList();
  }
}

/**
 * Update the file status indicator in the header.
 */
function setFileStatus(type, text) {
  const el = document.getElementById('fileStatus');
  if (!el) return;
  el.querySelector('.status-dot').className = `status-dot ${type}`;
  el.querySelector('.status-text').innerText = text;
}
