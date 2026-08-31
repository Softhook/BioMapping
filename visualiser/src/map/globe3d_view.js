/**
 * BioMapping 2.0 — 3D Globe view controller (embedded in index.html).
 * Copyright (c) 2026 Christian Nold
 * Licensed under the Bio Mapping Community Licence 1.0.
 *
 * Owns the lifecycle of the embedded GSRGlobeManager: lazy-loads CesiumJS the
 * first time the 3D surface is opened, mounts one warm viewer, and keeps it
 * paused (render loop off) while the 2D map is showing.
 *
 * The 3D globe is a READ-ONLY view of the 2D state. It never writes back:
 *   - geometry, colour metric and colour range come from GSRMapManager
 *     (_lastDrawPoints / activeColoringMetric / _legendMinVal|_legendMaxVal),
 *     pushed on every 'map:rendered';
 *   - the 3D-only settings card (extrusion, basemap, buildings, RF field,
 *     camera) mutates only this controller's own GSRGlobeManager.
 *
 * One exception: clicking a peak spire opens the peak-label editor and calls
 * GSRUI.updatePeakLabel() — the same path the 2D map's peak popup uses.
 *
 * Cesium is absent in the jsdom smoke harness — every path here degrades to a
 * no-op when window.Cesium / the manager isn't there.
 */

// CesiumJS is vendored under visualiser/vendor/cesium/ (the 1.120 release build)
// so the 3D globe works with no network at all — BioMapping is offline field
// kit. Refresh it with: npm i --no-save cesium@<ver> && cp -R
// node_modules/cesium/Build/Cesium visualiser/vendor/cesium (drop index.*).
const CESIUM_BASE = 'vendor/cesium/';

const GSRGlobe3DView = {

  manager: null,
  isActive: false,
  _initDone: false,
  _cesiumPromise: null,
  els: {},

  // Last track id pushed into the globe. When _pushFromMap sees this change
  // (the user picked a different track in the left library list), it frames the
  // new track instead of leaving the camera where it was.
  _lastTrackId: null,

  // Last scrub lat/lon pushed into the globe, for dedupe (see _onScrub).
  _lastScrubKey: null,

  // ── Init & wiring ──────────────────────────────────────────────────────────

  init() {
    if (GSRGlobe3DView._initDone) return;
    GSRGlobe3DView._initDone = true;

    const $ = (id) => document.getElementById(id);
    const els = GSRGlobe3DView.els = {
      panel:        $('globe3dPanel'),
      container:    $('globe3dContainer'),
      status:       $('globe3dStatus'),
      legend:       $('g3dLegend'),
      // panel-header controls that mirror the 2D map panel
      metric:       $('globe3dColoringMetric'),
      rfModeHeader: $('globe3dRfMode'),
      btnRf:        $('btnGlobe3dRf'),
      btnPeaks:     $('btnGlobe3dPeaks'),
      btnHotspots:  $('btnGlobe3dHotspots'),
      btnLabels:    $('btnGlobe3dLabels'),
      btnClusters:  $('btnGlobe3dClusters'),
      btnZoomIn:    $('btnGlobe3dZoomIn'),
      btnZoomOut:   $('btnGlobe3dZoomOut'),
      btnZoomExtent:$('btnGlobe3dZoomExtent'),
      extrusion:    $('g3dExtrusionScale'),
      extrusionVal: $('g3dExtrusionScaleVal'),
      heightMetric: $('g3dHeightMetric'),
      basemap:      $('g3dBasemap'),
      chkBuildings: $('g3dChkBuildings'),
      buildingRow:  $('g3dBuildingStyleRow'),
      buildingStyle:$('g3dBuildingStyle'),
      chkRf:        $('g3dChkRf'),
      rfRow:        $('g3dRfControlsRow'),
      rfMode:       $('g3dRfMode'),
      rfHeight:     $('g3dRfHeight'),
      rfHeightVal:  $('g3dRfHeightVal'),
      rfOpacity:    $('g3dRfOpacity'),
      rfOpacityVal: $('g3dRfOpacityVal'),
      btnFit:       $('g3dBtnFit'),
      btnOrbit:     $('g3dBtnOrbit'),
      btnPersp3D:   $('g3dBtnPersp3D'),
      btnPerspTop:  $('g3dBtnPerspTop'),
      btnPerspGround: $('g3dBtnPerspGround'),
      btnNorth:     $('g3dBtnNorth')
    };

    GSRGlobe3DView._bindCard(els);
    GSRGlobe3DView._bindHeader(els);

    if (typeof AppState !== 'undefined' && AppState.on) {
      // Trailing debounce — a GSR/GPS slider drag fires 'map:rendered' dozens of
      // times a second and each push tears down and rebuilds the whole 3D wall
      // primitive. Rebuild once, ~0.25s after the user stops moving.
      AppState.on('map:rendered', () => {
        if (!GSRGlobe3DView.isActive) return;
        clearTimeout(GSRGlobe3DView._pushTimer);
        GSRGlobe3DView._pushTimer = setTimeout(() => {
          if (GSRGlobe3DView.isActive) GSRGlobe3DView._pushFromMap();
        }, 250);
      });

      // Graph/map scrub cursor -> 3D globe. The single 'scrub' channel every
      // surface shares (renderer.js emits it on graph hover, events.js relays
      // it to the 2D map). A 'graph'-sourced scrub also drives the follow-cam.
      AppState.on('scrub', (p) => GSRGlobe3DView._onScrub(p));
    }
  },

  // ── Scrub sync (2D graph <-> 3D globe) ────────────────────────────────────

  /**
   * A scrub position arrived on the shared channel. Walk the 3D ground cursor
   * to it (parity with the flat 2D map dot) and, when it came from the graph,
   * keep the camera centred on it. Ignored unless the 3D surface is showing;
   * self-sourced ('globe') scrubs never move the camera.
   */
  _onScrub(p) {
    const mgr = GSRGlobe3DView.manager;
    if (!GSRGlobe3DView.isActive || !mgr) return;

    if (!p || p.clear || isNaN(p.lat) || isNaN(p.lon)) {
      // 'scrub' clears fire on every idle graph redraw — do nothing (and don't
      // schedule a repaint) unless a cursor was actually showing.
      if (GSRGlobe3DView._lastScrubKey === null) return;
      GSRGlobe3DView._lastScrubKey = null;
      mgr.setScrubPosition(NaN, NaN);
      mgr.releaseFollowScrub();
      mgr._requestRender();
      return;
    }

    const key = p.lat.toFixed(6) + ',' + p.lon.toFixed(6);
    if (key === GSRGlobe3DView._lastScrubKey && p.source !== 'graph') return;
    GSRGlobe3DView._lastScrubKey = key;

    mgr.setScrubPosition(p.lat, p.lon);
    if (p.source === 'graph') mgr.followScrub(p.lat, p.lon);
    mgr._wakeRenderLoop();
    mgr._requestRender();
  },

  /**
   * Pointer moved over (or off) the 3D track — the reverse direction. Walk the
   * graph scrubber to that moment via the shared channel; AppState.scrubSource
   * is the ownership token that stops renderer.js's per-frame handleScrubber()
   * from wiping the hover. Single-track scope only (no graph in collective).
   */
  _onScrubHover(idx, ll) {
    if (!GSRGlobe3DView.isActive || typeof AppState === 'undefined') return;
    if (AppState.viewMode !== 'single') return;

    if (idx == null || !ll) {
      if (AppState.scrubSource === 'globe') {
        AppState.scrubSource = null;
        AppState.hoveredIndex = -1;
        AppState.emit('scrub', { clear: true, source: 'globe' });
        if (typeof redraw === 'function') redraw();
      }
      return;
    }

    AppState.scrubSource = 'globe';
    AppState.hoveredIndex = idx;
    AppState.emit('scrub', { lat: ll.lat, lon: ll.lon, index: idx, source: 'globe' });
    if (typeof redraw === 'function') redraw();
  },

  _bindCard(els) {
    const m = () => GSRGlobe3DView.manager;

    if (els.extrusion) {
      els.extrusion.addEventListener('input', (e) => {
        const v = parseFloat(e.target.value);
        if (els.extrusionVal) els.extrusionVal.textContent = v.toFixed(1) + '×';
        if (m()) m().setExtrusionScale(v);
      });
    }
    if (els.heightMetric) {
      els.heightMetric.addEventListener('change', (e) => {
        if (m()) { m().heightMetric = e.target.value; m()._refreshTrack(); }
      });
    }
    if (els.basemap) {
      els.basemap.addEventListener('change', (e) => { if (m()) m().setBasemap(e.target.value); });
    }
    if (els.chkBuildings) {
      els.chkBuildings.addEventListener('change', async (e) => {
        if (els.buildingRow) els.buildingRow.style.display = e.target.checked ? 'block' : 'none';
        if (m()) await m().toggle3DBuildings(e.target.checked, els.buildingStyle ? els.buildingStyle.value : 'glass');
      });
    }
    if (els.buildingStyle) {
      els.buildingStyle.addEventListener('change', (e) => { if (m()) m().apply3DBuildingStyle(e.target.value); });
    }

    // The 3D-settings RF checkbox / band select are just another face of the
    // shared RF switch — route them through the same _setRf / _setRfMode the
    // header button uses (which also drives the 2D map). The height/opacity
    // sliders are 3D-volumetric-only, so they just re-apply the field.
    if (els.chkRf) els.chkRf.addEventListener('change', () => GSRGlobe3DView._setRf(els.chkRf.checked));
    if (els.rfMode) els.rfMode.addEventListener('change', () => GSRGlobe3DView._setRfMode(els.rfMode.value));
    const applyRfParams = () => {
      if (m() && m().showRfVolumetric) {
        m().toggle3DRf(
          true,
          els.rfMode ? els.rfMode.value : 'triband',
          els.rfHeight ? parseFloat(els.rfHeight.value) : 25,
          els.rfOpacity ? parseFloat(els.rfOpacity.value) : 0.45
        );
      }
    };
    if (els.rfHeight) els.rfHeight.addEventListener('input', (e) => {
      if (els.rfHeightVal) els.rfHeightVal.textContent = e.target.value + 'm';
      applyRfParams();
    });
    if (els.rfOpacity) els.rfOpacity.addEventListener('input', (e) => {
      if (els.rfOpacityVal) els.rfOpacityVal.textContent = Math.round(parseFloat(e.target.value) * 100) + '%';
      applyRfParams();
    });

    if (els.btnFit)    els.btnFit.addEventListener('click', () => { if (m()) m().flyToTrack(); });
    if (els.btnOrbit)  els.btnOrbit.addEventListener('click', () => {
      if (m()) els.btnOrbit.classList.toggle('active', m().toggleOrbit());
    });
    if (els.btnPersp3D)     els.btnPersp3D.addEventListener('click', () => { if (m()) m().setViewPerspective('3d'); });
    if (els.btnPerspTop)    els.btnPerspTop.addEventListener('click', () => { if (m()) m().setViewPerspective('top'); });
    if (els.btnPerspGround) els.btnPerspGround.addEventListener('click', () => { if (m()) m().setViewPerspective('ground'); });
    if (els.btnNorth)  els.btnNorth.addEventListener('click', () => { if (m()) m().resetNorth(); });
  },

  /**
   * Peak clicked in 3D — open the EXACT same popup the 2D map uses for a peak
   * marker (built by GSRMapManager._buildPeakPopup: editable label textarea,
   * date/time/quality rows, Street View link, exclude button). Its inputs are
   * already wired to GSRUI.handleLiveLabelInput / updatePeakLabel /
   * togglePeakExclusion, so the label persists and both surfaces update.
   * @param {number} peakIdx    index into AppState.analyzer.peaks
   * @param {{x:number,y:number}} [windowPos]  click position within the canvas
   */
  _editPeakLabel(peakIdx, windowPos) {
    const analyzer = (typeof AppState !== 'undefined') ? AppState.analyzer : null;
    const mm = (typeof AppState !== 'undefined') ? AppState.mapManager : null;
    const peak = analyzer && analyzer.peaks && analyzer.peaks[peakIdx];
    if (!peak || !mm || typeof mm._buildPeakPopup !== 'function') return;

    const coords = (analyzer.getCoordinates && analyzer.getCoordinates(peak.index)) || {};
    const trackId = (AppState.viewMode === 'collective') ? AppState.activeTrackId : undefined;

    const card = mm._buildPeakPopup({
      heading: peak.label || ('Peak #' + (peakIdx + 1)),
      analyzerRef: analyzer,
      peak,
      index: peakIdx,
      lat: coords.lat,
      lon: coords.lon,
      marker: { closePopup: () => GSRGlobe3DView._closePeakPopup() },
      trackId
    });
    GSRGlobe3DView._showPeakPopup(card, windowPos);
  },

  _showPeakPopup(card, windowPos) {
    const container = GSRGlobe3DView.els.container;
    if (!container || !card || !card.nodeType) return; // no real DOM node -> nothing to show
    GSRGlobe3DView._closePeakPopup();

    const pop = document.createElement('div');
    pop.className = 'globe3d-peak-popup';
    pop.id = 'globe3dPeakPopup';

    const close = document.createElement('button');
    close.className = 'globe3d-peak-popup-close';
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.innerHTML = '<i class="fa-solid fa-xmark"></i>';
    close.addEventListener('click', () => GSRGlobe3DView._closePeakPopup());

    pop.appendChild(close);
    pop.appendChild(card);
    container.appendChild(pop);

    // Position near the click, clamped inside the container.
    const cw = container.clientWidth || 400;
    const ch = container.clientHeight || 400;
    const pw = pop.offsetWidth || 280;
    const pht = pop.offsetHeight || 160;
    const x = windowPos ? windowPos.x : cw / 2;
    const y = windowPos ? windowPos.y : ch / 3;
    pop.style.left = Math.max(8, Math.min(x + 12, cw - pw - 8)) + 'px';
    pop.style.top = Math.max(8, Math.min(y + 12, ch - pht - 8)) + 'px';

    const ta = pop.querySelector('textarea');
    if (ta) { ta.focus(); ta.select(); }

    // Dismiss on Escape or a click/drag anywhere outside the popup.
    GSRGlobe3DView._popupDismiss = (e) => {
      if (e.type === 'keydown' && e.key !== 'Escape') return;
      if (e.type !== 'keydown' && pop.contains(e.target)) return;
      GSRGlobe3DView._closePeakPopup();
    };
    setTimeout(() => {
      document.addEventListener('keydown', GSRGlobe3DView._popupDismiss, true);
      document.addEventListener('pointerdown', GSRGlobe3DView._popupDismiss, true);
    }, 0);
  },

  _closePeakPopup() {
    if (GSRGlobe3DView._popupDismiss) {
      document.removeEventListener('keydown', GSRGlobe3DView._popupDismiss, true);
      document.removeEventListener('pointerdown', GSRGlobe3DView._popupDismiss, true);
      GSRGlobe3DView._popupDismiss = null;
    }
    const pop = document.getElementById('globe3dPeakPopup');
    if (pop && pop.parentNode) pop.parentNode.removeChild(pop);
  },

  /**
   * The layer toggles the 3D header shares with the 2D map header. The 2D map
   * button is the single source of truth for each (2D is chief) — a 3D click
   * drives the 2D button, then mirrors the result onto the globe + the 3D
   * button. _syncFromMap() re-reads all of them on every push so the two
   * headers can never drift.
   */
  _SHARED_TOGGLES: [
    { key: 'btnPeaks',    btn2d: 'btnToggleMapPeaks',    flag: 'showPeaks',
      apply: (mgr, on) => mgr.togglePeaks(on, mgr.minPeakQuality || 0) },
    { key: 'btnHotspots', btn2d: 'btnToggleMapHotspots', flag: 'showHotspots',
      apply: (mgr, on) => mgr.toggleHotspots(on) },
    { key: 'btnLabels',   btn2d: 'btnToggleMapLabels',   flag: 'showLabels',
      apply: (mgr, on) => mgr.toggleLabels(on) },
    { key: 'btnClusters', btn2d: 'btnToggleMapClusters', flag: 'showClusters',
      apply: (mgr, on) => mgr.toggleClusters(on) }
  ],

  /**
   * panel-header controls, mirroring the 2D map panel. The metric <select> and
   * every layer toggle are proxies for the 2D map's own controls — a change
   * here drives the 2D map (the source of truth), which is then mirrored onto
   * the globe. See _SHARED_TOGGLES / _syncFromMap.
   */
  _bindHeader(els) {
    const m = () => GSRGlobe3DView.manager;

    if (els.metric) {
      els.metric.addEventListener('change', (e) => {
        const mapSel = document.getElementById('mapColoringMetric');
        if (mapSel && mapSel.value !== e.target.value) {
          mapSel.value = e.target.value;
          mapSel.dispatchEvent(new Event('change'));
        }
      });
    }

    GSRGlobe3DView._SHARED_TOGGLES.forEach((t) => {
      const btn = els[t.key];
      if (!btn) return;
      btn.addEventListener('click', () => {
        GSRGlobe3DView._setSharedToggle(t, !btn.classList.contains('active'));
      });
    });

    // RF shares its on/off + band with the 2D map's "RF" button + #rfFluidMode
    // (the 2D fluid raster and the 3D volumetric field are different renders of
    // the same 3-band data, but one state drives both). The header button and
    // the 3D-settings checkbox are two faces of that one switch.
    if (els.btnRf) {
      els.btnRf.addEventListener('click', () => {
        GSRGlobe3DView._setRf(!els.btnRf.classList.contains('active'));
      });
    }
    if (els.rfModeHeader) {
      els.rfModeHeader.addEventListener('change', (e) => GSRGlobe3DView._setRfMode(e.target.value));
    }

    const zoom = (factor) => {
      const v = m() && m().viewer;
      if (!v) return;
      const h = v.camera.positionCartographic.height;
      const step = Math.max(20, h * 0.35);
      if (factor < 0) v.camera.zoomIn(step); else v.camera.zoomOut(step);
      v.scene.requestRender(); // programmatic camera move needs a nudge in requestRenderMode
    };
    if (els.btnZoomIn)  els.btnZoomIn.addEventListener('click', () => zoom(-1));
    if (els.btnZoomOut) els.btnZoomOut.addEventListener('click', () => zoom(1));
    if (els.btnZoomExtent) els.btnZoomExtent.addEventListener('click', () => { if (m()) m().flyToTrack(); });
  },

  // ── Shared 2D⇄3D toggle state ────────────────────────────────────────────

  /**
   * Flip one shared layer toggle. Drives the 2D map's own button (the source of
   * truth), then mirrors the result onto the globe manager and the 3D header
   * button so the two headers always read the same.
   */
  _setSharedToggle(t, on) {
    const b2 = document.getElementById(t.btn2d);
    if (b2 && b2.classList.contains('active') !== on) b2.click();
    const btn = GSRGlobe3DView.els[t.key];
    if (btn) btn.classList.toggle('active', on);
    const mgr = GSRGlobe3DView.manager;
    if (mgr) t.apply(mgr, on);
  },

  /** RF on/off — shared with the 2D map's "RF" button + the 3D-settings checkbox. */
  _setRf(on) {
    const els = GSRGlobe3DView.els;
    const b2 = document.getElementById('btnToggleRFFluid');
    if (b2 && b2.hasAttribute('disabled')) return; // active track carries no RF data
    if (b2 && b2.classList.contains('active') !== on) b2.click();
    if (els.btnRf) els.btnRf.classList.toggle('active', on);
    if (els.chkRf && els.chkRf.checked !== on) els.chkRf.checked = on;
    if (els.rfRow) els.rfRow.style.display = on ? 'flex' : 'none';
    const mgr = GSRGlobe3DView.manager;
    if (mgr) {
      mgr.toggle3DRf(
        on,
        els.rfMode ? els.rfMode.value : 'triband',
        els.rfHeight ? parseFloat(els.rfHeight.value) : 25,
        els.rfOpacity ? parseFloat(els.rfOpacity.value) : 0.45
      );
    }
  },

  /** RF band — shared with the 2D map's #rfFluidMode. */
  _setRfMode(mode) {
    const els = GSRGlobe3DView.els;
    const m2 = document.getElementById('rfFluidMode');
    if (m2 && m2.value !== mode) { m2.value = mode; m2.dispatchEvent(new Event('change')); }
    if (els.rfModeHeader && els.rfModeHeader.value !== mode) els.rfModeHeader.value = mode;
    if (els.rfMode && els.rfMode.value !== mode) els.rfMode.value = mode;
    const mgr = GSRGlobe3DView.manager;
    if (!mgr) return;
    if (mgr.showRfVolumetric) {
      mgr.toggle3DRf(true, mode,
        els.rfHeight ? parseFloat(els.rfHeight.value) : 25,
        els.rfOpacity ? parseFloat(els.rfOpacity.value) : 0.45);
    } else {
      mgr.rfMode = mode;
    }
  },

  /**
   * Re-read every shared toggle from the 2D map and mirror it onto the 3D
   * header buttons + the globe manager. Runs on each _pushFromMap so opening
   * the 3D view (or any 2D re-render) can't leave the two headers out of step.
   * Sets the manager flags only — the caller's renderData() does the drawing.
   */
  _syncFromMap() {
    const mm = (typeof AppState !== 'undefined') ? AppState.mapManager : null;
    if (!mm) return;
    const els = GSRGlobe3DView.els;
    const mgr = GSRGlobe3DView.manager;

    GSRGlobe3DView._SHARED_TOGGLES.forEach((t) => {
      const on = !!mm[t.flag];
      if (els[t.key]) els[t.key].classList.toggle('active', on);
      if (mgr) {
        if (t.key === 'btnPeaks')    mgr.showPeaks = on;
        if (t.key === 'btnHotspots') mgr.showHotspots = on;
        if (t.key === 'btnLabels')   mgr.showLabels = on;
        if (t.key === 'btnClusters') mgr.showClusters = on;
      }
    });

    const rfBtn2d = document.getElementById('btnToggleRFFluid');
    const rfDisabled = rfBtn2d ? rfBtn2d.hasAttribute('disabled') : false;
    const rfOn = !rfDisabled && (rfBtn2d ? rfBtn2d.classList.contains('active') : !!mm.showRFFluid);
    const rfMode2d = document.getElementById('rfFluidMode');
    const rfMode = rfMode2d ? rfMode2d.value : (mgr ? mgr.rfMode : 'triband');
    if (els.btnRf) {
      els.btnRf.classList.toggle('active', rfOn);
      els.btnRf.toggleAttribute('disabled', rfDisabled);
    }
    if (els.chkRf) {
      if (els.chkRf.checked !== rfOn) els.chkRf.checked = rfOn;
      els.chkRf.toggleAttribute('disabled', rfDisabled);
    }
    if (els.rfRow) els.rfRow.style.display = rfOn ? 'flex' : 'none';
    if (els.rfModeHeader && els.rfModeHeader.value !== rfMode) els.rfModeHeader.value = rfMode;
    if (els.rfMode && els.rfMode.value !== rfMode) els.rfMode.value = rfMode;
    if (mgr) { mgr.showRfVolumetric = rfOn; mgr.rfMode = rfMode; }
  },

  // ── Cesium lazy load ──────────────────────────────────────────────────────

  _ensureCesium() {
    if (typeof window !== 'undefined' && window.Cesium) return Promise.resolve();
    if (GSRGlobe3DView._cesiumPromise) return GSRGlobe3DView._cesiumPromise;

    GSRGlobe3DView._cesiumPromise = new Promise((resolve, reject) => {
      try {
        window.CESIUM_BASE_URL = CESIUM_BASE;
        if (!document.querySelector('link[data-cesium-widgets]')) {
          const link = document.createElement('link');
          link.rel = 'stylesheet';
          link.href = CESIUM_BASE + 'Widgets/widgets.css';
          link.setAttribute('data-cesium-widgets', '1');
          document.head.appendChild(link);
        }
        const s = document.createElement('script');
        s.src = CESIUM_BASE + 'Cesium.js';
        s.async = true;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error('Failed to load CesiumJS'));
        document.head.appendChild(s);
      } catch (e) {
        reject(e);
      }
    });
    return GSRGlobe3DView._cesiumPromise;
  },

  // ── Activate / deactivate ────────────────────────────────────────────────

  async activate() {
    GSRGlobe3DView.isActive = true;

    try {
      await GSRGlobe3DView._ensureCesium();
    } catch (e) {
      GSRGlobe3DView._setStatus('Could not load the 3D globe engine (offline?). The 2D map still works.');
      return;
    }

    if (!GSRGlobe3DView.manager) {
      const mm = (typeof AppState !== 'undefined') ? AppState.mapManager : null;
      GSRGlobe3DView.manager = new GSRGlobeManager('globe3dContainer', {
        keyboardFlight: false,
        doubleClickFly: true,
        requestRenderMode: true, // embedded panel: don't burn frames while idle
        metric: (mm && mm.activeColoringMetric) || 'phasic',
        heightMetric: GSRGlobe3DView.els.heightMetric ? GSRGlobe3DView.els.heightMetric.value : 'phasic',
        extrusionScale: GSRGlobe3DView.els.extrusion ? parseFloat(GSRGlobe3DView.els.extrusion.value) : 8.0
      });
      GSRGlobe3DView.manager.onPeakClick((peakIdx) => GSRGlobe3DView._editPeakLabel(peakIdx));
      GSRGlobe3DView.manager.onScrubHover((idx, ll) => GSRGlobe3DView._onScrubHover(idx, ll));
    } else if (GSRGlobe3DView.manager.viewer) {
      GSRGlobe3DView.manager.viewer.useDefaultRenderLoop = true;
    }

    // The container was display:none until this click, so its box isn't laid
    // out yet — Cesium would come up as a thin strip (only the pole of the
    // globe showing). Wait two frames for layout, THEN resize the viewer and
    // frame the track.
    const raf = (typeof window !== 'undefined' && window.requestAnimationFrame)
      ? window.requestAnimationFrame.bind(window)
      : (fn) => setTimeout(fn, 16);
    raf(() => raf(() => {
      if (!GSRGlobe3DView.isActive) return;
      GSRGlobe3DView.onResize();
      GSRGlobe3DView._pushFromMap({ fly: true });
      // Guarantee at least one paint even when there's no track to push.
      const v = GSRGlobe3DView.manager && GSRGlobe3DView.manager.viewer;
      if (v && v.scene && typeof v.scene.requestRender === 'function') v.scene.requestRender();
    }));
  },

  /**
   * Force one resize+repaint. Only needed at the moments Cesium can't see for
   * itself — the panel going from display:none to visible, and the
   * fullscreen-overlay DOM move. Cesium's own render loop already calls
   * viewer.resize() every tick, so a ResizeObserver here is both redundant and
   * a feedback-loop risk (resize -> layout -> observer -> resize …).
   */
  onResize() {
    const v = GSRGlobe3DView.manager && GSRGlobe3DView.manager.viewer;
    if (!v) return;
    try {
      if (typeof v.resize === 'function') v.resize();
      if (v.scene && typeof v.scene.requestRender === 'function') v.scene.requestRender();
    } catch (e) { /* no-op */ }
  },

  deactivate() {
    GSRGlobe3DView.isActive = false;
    GSRGlobe3DView._closePeakPopup();
    GSRGlobe3DView._lastScrubKey = null;
    const mgr = GSRGlobe3DView.manager;
    if (mgr) {
      mgr.setScrubPosition(NaN, NaN);
      mgr.releaseFollowScrub();
    }
    // Hand cursor ownership back to the graph if the 3D track had it.
    if (typeof AppState !== 'undefined' && AppState.scrubSource === 'globe') {
      AppState.scrubSource = null;
      AppState.hoveredIndex = -1;
      AppState.emit('scrub', { clear: true, source: 'globe' });
      if (typeof redraw === 'function') redraw();
    }
    if (mgr && mgr.viewer) mgr.viewer.useDefaultRenderLoop = false; // keep warm, stop rendering
  },

  // ── Data push (2D → 3D) ──────────────────────────────────────────────────

  _pushFromMap(opts = {}) {
    const mgr = GSRGlobe3DView.manager;
    if (!mgr || typeof AppState === 'undefined') return;
    const mm = AppState.mapManager;
    if (!mm) return;

    // Mirror the 2D map's layer toggles onto the 3D header + manager first, so
    // the state is right whether or not there's a track to draw yet.
    GSRGlobe3DView._syncFromMap();
    if (!AppState.analyzer) return;

    const metric = mm.activeColoringMetric || 'gsr';
    const colorRange = { min: mm._legendMinVal, max: mm._legendMaxVal };
    const gpsParams = (typeof GSRStorage !== 'undefined' && GSRStorage.buildGpsParams)
      ? GSRStorage.buildGpsParams() : {};

    // Reuse the 2D view's exact drawPoints only in single-track scope — in
    // collective scope _lastDrawPoints is a multi-analyzer merge whose origIdx
    // values don't map back to AppState.analyzer's series, so let the globe
    // build its own from the active track instead.
    const single = AppState.viewMode === 'single';
    const drawPoints = single ? (mm._lastDrawPoints || []) : null;

    // Hand the 2D map's already-computed spatial-cluster hulls to the globe so
    // its "Clusters" toggle draws the same blobs (see _renderClusterBlobs).
    const clusterPolygons = [];
    for (const poly of (mm.clusterLayers || [])) {
      if (!poly || typeof poly.getLatLngs !== 'function') continue;
      let latlngs = poly.getLatLngs();
      while (Array.isArray(latlngs) && Array.isArray(latlngs[0])) latlngs = latlngs[0]; // outer ring
      if (!Array.isArray(latlngs) || latlngs.length < 3) continue;
      const o = poly.options || {};
      clusterPolygons.push({
        ring: latlngs.map(ll => [ll.lat, ll.lng]),
        color: o.fillColor || o.color,
        fillOpacity: o.fillOpacity
      });
    }

    // Frame the track when the caller asked (surface first opened) OR when the
    // active track changed since the last push — picking a different track in
    // the left library list should pan the globe to fit it, like the 2D map.
    const trackId = AppState.activeTrackId ?? null;
    const trackChanged = trackId !== null && trackId !== GSRGlobe3DView._lastTrackId;
    GSRGlobe3DView._lastTrackId = trackId;

    mgr.renderData(AppState.analyzer, gpsParams, {
      drawPoints: (drawPoints && drawPoints.length >= 2) ? drawPoints : undefined,
      colorMetric: metric,
      colorRange,
      clusterPolygons,
      isPreview: !(opts.fly || trackChanged)
    });
    GSRGlobe3DView._updateLegend(metric);
  },

  // ── Small UI bits ────────────────────────────────────────────────────────

  _updateLegend(metric) {
    const els = GSRGlobe3DView.els;
    const mm = (typeof AppState !== 'undefined') ? AppState.mapManager : null;

    // Render the exact same legend the 2D map shows — title, gradient/swatches,
    // formatted range, RF sub-legend and all (see GSRMapManager.buildLegendHtml).
    if (els.legend && mm && typeof mm.buildLegendHtml === 'function') {
      els.legend.innerHTML = mm.buildLegendHtml();
    }

    // keep the panel-header metric picker in step with the 2D map
    if (els.metric && metric && els.metric.value !== metric) {
      const has = [...els.metric.options].some((o) => o.value === metric);
      if (has) els.metric.value = metric;
    }
  },

  _setStatus(msg) {
    const el = GSRGlobe3DView.els.status;
    if (!el) return;
    el.textContent = msg || '';
    el.style.display = msg ? 'block' : 'none';
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GSRGlobe3DView };
}
if (typeof window !== 'undefined') {
  window.GSRGlobe3DView = GSRGlobe3DView;
}
