// Copyright (c) 2026 Christian Nold
// Licensed under the Bio Mapping Community Licence 1.0.
// See LICENCE.md in the project root for terms.

/**
 * GSRTrackManager — the sidebar track list: drawing each row, the integrity
 * icon, and renaming. Object-augment split from tracks.mjs: spread into the
 * shared GSRTrackManager object; reaches the rest of it through
 * Controllers.trackManager.
 */
import { AppState } from '../core/app_state.mjs';
import { Controllers } from '../core/controllers.mjs';
import { GSRGlobe3DView } from '../map/globe3d_view.mjs';
import { GSRRenderer } from '../render/renderer.mjs';
import { GSRAnalyzer } from '../signal/analyzer.mjs';
import { GSRTrackQualityPopup } from './track_quality_popup.mjs';

export const TrackList = {
  /**
   * Small status icon for the CSV integrity bracket (see docs/csv_schema.md
   * and GSRCSVParser._verifyIntegrity). Returns null for files that carry no
   * integrity data at all, so pre-integrity tracks show nothing rather than
   * a scary marker.
   */
  _buildIntegrityMark(track) {
    const info = track.analyzer?.integrity;
    if (!info || info.status === 'none') return null;

    const SPEC = {
      verified: { icon: 'fa-circle-check', label: 'Integrity verified' },
      incomplete: {
        icon: 'fa-triangle-exclamation',
        label: 'Recording did not end cleanly',
      },
      corrupt: { icon: 'fa-circle-xmark', label: 'Integrity check failed' },
    };
    const spec = SPEC[info.status];
    if (!spec) return null;

    const mark = document.createElement('span');
    mark.className = `track-integrity track-integrity-${info.status}`;
    mark.innerHTML = `<i class="fa-solid ${spec.icon}"></i>`;
    mark.title = info.detail ? `${spec.label} — ${info.detail}` : spec.label;
    return mark;
  },

  renderTrackList() {
    const TM = Controllers.trackManager;
    const container = document.getElementById('trackListContainer');
    const listElement = document.getElementById('trackList');
    const dropZone = AppState.dropZone;

    if (AppState.collectiveManager.tracks.length === 0) {
      noLoop();
      container.style.display = 'none';
      dropZone.style.display = 'flex';
      dropZone.classList.remove('compact');

      AppState.analyzer = new GSRAnalyzer();
      AppState.activeTrackId = null;

      Controllers.ui.updatePeaksTable();
      Controllers.ui.updateStatsPanel();
      Controllers.ui.updateDeconvTruncationWarning();

      TM.EXPORT_BUTTON_IDS.forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.setAttribute('disabled', 'true');
      });

      if (AppState.mapManager) {
        AppState.mapManager.clearAll();
      }
      if (GSRGlobe3DView?.manager) {
        GSRGlobe3DView.manager.clearAll();
        if (GSRGlobe3DView.els.legend) GSRGlobe3DView.els.legend.innerHTML = '';
      }
      // Nothing is loaded — clearMap() no longer drops the OSM overlay, so
      // reset the toggle and clear it explicitly.
      if (Controllers.ui?.syncOsmOverlay) {
        Controllers.ui._osmOverlayOn = false;
        Controllers.ui.syncOsmOverlay();
      }

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

    // Collective view has no selected track: every walk keeps its own
    // settings, and clicking one only zooms the map to it. activeTrackId
    // still records the walk Single view shows.
    const collective = AppState.viewMode === 'collective';

    AppState.collectiveManager.tracks.forEach((track) => {
      const isEditing = !collective && track.id === AppState.activeTrackId;

      const li = document.createElement('li');
      li.className = `track-item ${isEditing ? 'active' : ''}`;
      li.dataset.trackId = track.id;

      li.addEventListener('mouseenter', () => {
        if (!AppState._renamingTrackId) {
          GSRTrackQualityPopup.show(track, li);
        }
      });
      li.addEventListener('mouseleave', () => {
        GSRTrackQualityPopup.hide();
      });

      const badge = document.createElement('span');
      badge.className = 'track-color-badge';
      badge.style.backgroundColor = track.color;

      const details = document.createElement('div');
      details.className = 'track-details';
      details.title = collective
        ? 'Click to zoom the map to this walk'
        : 'Click to analyse and tweak';
      details.addEventListener('click', () => {
        if (AppState.viewMode === 'collective') {
          TM.zoomToTrack(track.id);
        } else {
          TM.switchActiveTrack(track.id);
        }
      });

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
          TM.finishRenameTrack(track.id, nameInput.value.trim() || track.name);
        } else if (e.key === 'Escape') {
          TM.cancelRenameTrack();
        }
        e.stopPropagation();
      });
      nameInput.addEventListener('blur', () => {
        TM.finishRenameTrack(track.id, nameInput.value.trim() || track.name);
      });

      const meta = document.createElement('span');
      meta.className = 'track-meta';
      const a = track.analyzer;
      const hasClock = a.recordingStartTime && a.recordingStartTime >= 86400;
      meta.innerText = hasClock
        ? `${GSRTrackQualityPopup.formatDateUK(a.recordingStartTime)}, ${a.formatTimeOnly(0)}`
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
        TM.startRenameTrack(track.id);
      });

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'track-action-btn delete-btn';
      deleteBtn.title = 'Remove track';
      deleteBtn.innerHTML = '<i class="fa-solid fa-trash-can"></i>';
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        TM.deleteTrack(track.id);
      });

      actions.appendChild(editBtn);
      actions.appendChild(deleteBtn);

      li.appendChild(badge);
      li.appendChild(details);
      const integrityMark = TM._buildIntegrityMark(track);
      if (integrityMark) li.appendChild(integrityMark);
      li.appendChild(actions);

      listElement.appendChild(li);
    });
  },

  /**
   * Start renaming a track — replace the name span with an input field.
   */
  startRenameTrack(trackId) {
    const TM = Controllers.trackManager;
    GSRTrackQualityPopup.hide();
    // Cancel any existing rename first
    if (AppState._renamingTrackId) {
      TM.cancelRenameTrack();
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
    const TM = Controllers.trackManager;
    if (AppState._renamingTrackId !== trackId) return;
    AppState._renamingTrackId = null;

    const track = AppState.collectiveManager.getTrack(trackId);
    if (!track) return;

    track.name = newName;
    TM.renderTrackList();
  },

  /**
   * Cancel renaming — restore the name span without saving.
   */
  cancelRenameTrack() {
    const TM = Controllers.trackManager;
    if (!AppState._renamingTrackId) return;
    AppState._renamingTrackId = null;
    TM.renderTrackList();
  },
};
