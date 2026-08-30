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

// jsDelivr's npm mirror — far faster and better-cached than cesium.com's own
// download server (which was most of the "black screen for ages" on first open).
const CESIUM_VERSION = '1.120';
const CESIUM_BASE = `https://cdn.jsdelivr.net/npm/cesium@${CESIUM_VERSION}/Build/Cesium/`;

const METRIC_LABELS = {
  gsr: 'GSR Arousal', phasic: 'Phasic Arousal (SCR)', tonic: 'Tonic Baseline (SCL)',
  peakDensity: 'Peak Density', phasicAUC: 'Phasic AUC', arousalIndex: 'Arousal Index',
  em_fog: 'EM Fog Index', hdopQuality: 'GPS Accuracy (HDOP)', roadClass: 'Road Class',
  distMajorRoad: 'Dist to Road', inPark: 'In Park', greenPct: 'Green Space',
  buildingDensity: 'Building Density', distWater: 'Dist to Water',
  treeDensity: 'Tree Density', amenityCount: 'Amenity Count'
};

const GSRGlobe3DView = {

  manager: null,
  isActive: false,
  _initDone: false,
  _cesiumPromise: null,
  els: {},

  // ── Init & wiring ──────────────────────────────────────────────────────────

  init() {
    if (GSRGlobe3DView._initDone) return;
    GSRGlobe3DView._initDone = true;

    const $ = (id) => document.getElementById(id);
    const els = GSRGlobe3DView.els = {
      panel:        $('globe3dPanel'),
      container:    $('globe3dContainer'),
      status:       $('globe3dStatus'),
      legendTitle:  $('g3dLegendTitle'),
      legendMin:    $('g3dLegendMin'),
      legendMax:    $('g3dLegendMax'),
      // panel-header controls that mirror the 2D map panel
      metric:       $('globe3dColoringMetric'),
      btnPeaks:     $('btnGlobe3dPeaks'),
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
      btnNorth:     $('g3dBtnNorth'),
      btnSnapshot:  $('g3dBtnSnapshot'),
      btnCzml:      $('g3dBtnCzml'),
      btnKml:       $('g3dBtnKml')
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
    }
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

    const updateRf = () => {
      if (!els.chkRf) return;
      if (els.rfRow) els.rfRow.style.display = els.chkRf.checked ? 'flex' : 'none';
      if (m()) {
        m().toggle3DRf(
          els.chkRf.checked,
          els.rfMode ? els.rfMode.value : 'triband',
          els.rfHeight ? parseFloat(els.rfHeight.value) : 25,
          els.rfOpacity ? parseFloat(els.rfOpacity.value) : 0.45
        );
      }
    };
    if (els.chkRf) els.chkRf.addEventListener('change', updateRf);
    if (els.rfMode) els.rfMode.addEventListener('change', updateRf);
    if (els.rfHeight) els.rfHeight.addEventListener('input', (e) => {
      if (els.rfHeightVal) els.rfHeightVal.textContent = e.target.value + 'm';
      updateRf();
    });
    if (els.rfOpacity) els.rfOpacity.addEventListener('input', (e) => {
      if (els.rfOpacityVal) els.rfOpacityVal.textContent = Math.round(parseFloat(e.target.value) * 100) + '%';
      updateRf();
    });

    if (els.btnFit)    els.btnFit.addEventListener('click', () => { if (m()) m().flyToTrack(); });
    if (els.btnOrbit)  els.btnOrbit.addEventListener('click', () => {
      if (m()) els.btnOrbit.classList.toggle('active', m().toggleOrbit());
    });
    if (els.btnPersp3D)     els.btnPersp3D.addEventListener('click', () => { if (m()) m().setViewPerspective('3d'); });
    if (els.btnPerspTop)    els.btnPerspTop.addEventListener('click', () => { if (m()) m().setViewPerspective('top'); });
    if (els.btnPerspGround) els.btnPerspGround.addEventListener('click', () => { if (m()) m().setViewPerspective('ground'); });
    if (els.btnNorth)  els.btnNorth.addEventListener('click', () => { if (m()) m().resetNorth(); });
    if (els.btnSnapshot) els.btnSnapshot.addEventListener('click', () => { if (m()) m().exportSnapshot('biomapping_3d_snapshot.png'); });
    if (els.btnCzml)  els.btnCzml.addEventListener('click', () => { if (m()) m().exportCzml('biomapping_track_3d.czml'); });
    if (els.btnKml)   els.btnKml.addEventListener('click', () => { if (m()) m().exportKml('biomapping_track_3d.kml'); });
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
   * panel-header controls, mirroring the 2D map panel. The metric <select> is a
   * proxy for #mapColoringMetric — changing it drives the 2D map, which
   * re-renders and pushes the new metric/range back into the globe (2D stays
   * the source of truth). The others act straight on the viewer.
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

    if (els.btnPeaks) {
      els.btnPeaks.addEventListener('click', () => {
        const on = !els.btnPeaks.classList.contains('active');
        els.btnPeaks.classList.toggle('active', on);
        if (m()) m().togglePeaks(on, m().minPeakQuality || 0);
      });
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
    GSRGlobe3DView._setStatus('Loading 3D engine…');

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
      GSRGlobe3DView._watchImageryLoad();
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
   * Keep a "Loading map imagery…" status up until the globe's tile queue first
   * drains (or a hard 10s cap), so the initial blank/low-res globe reads as
   * "working" rather than "broken".
   */
  _watchImageryLoad() {
    const v = GSRGlobe3DView.manager && GSRGlobe3DView.manager.viewer;
    const globe = v && v.scene && v.scene.globe;
    if (!globe || !globe.tileLoadProgressEvent) { GSRGlobe3DView._setStatus(''); return; }

    GSRGlobe3DView._setStatus('Loading map imagery…');
    let done = false;
    let remove = null;
    const finish = () => {
      if (done) return;
      done = true;
      GSRGlobe3DView._setStatus('');
      if (typeof remove === 'function') remove();
    };
    remove = globe.tileLoadProgressEvent.addEventListener((remaining) => {
      if (remaining === 0) finish();
    });
    setTimeout(finish, 10000);
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
    const mgr = GSRGlobe3DView.manager;
    if (mgr && mgr.viewer) mgr.viewer.useDefaultRenderLoop = false; // keep warm, stop rendering
  },

  // ── Data push (2D → 3D) ──────────────────────────────────────────────────

  _pushFromMap(opts = {}) {
    const mgr = GSRGlobe3DView.manager;
    if (!mgr || typeof AppState === 'undefined' || !AppState.analyzer) return;
    const mm = AppState.mapManager;
    if (!mm) return;

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

    mgr.renderData(AppState.analyzer, gpsParams, {
      drawPoints: (drawPoints && drawPoints.length >= 2) ? drawPoints : undefined,
      colorMetric: metric,
      colorRange,
      isPreview: !opts.fly
    });
    GSRGlobe3DView._updateLegend(metric, colorRange);
  },

  // ── Small UI bits ────────────────────────────────────────────────────────

  _updateLegend(metric, range) {
    const els = GSRGlobe3DView.els;
    if (els.legendTitle) els.legendTitle.textContent = METRIC_LABELS[metric] || metric;
    if (els.legendMin && range && isFinite(range.min)) els.legendMin.textContent = (+range.min).toPrecision(3);
    if (els.legendMax && range && isFinite(range.max)) els.legendMax.textContent = (+range.max).toPrecision(3);
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
