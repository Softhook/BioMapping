/**
 * BioMapping 2.0 — 3D Globe view controller (embedded in index.html).
 * Copyright (c) 2026 Christian Nold
 * Licensed under the Bio Mapping Community Licence 1.0.
 *
 * Leaflet and Cesium are equivalent render engines swapped inside the one
 * #mapPanel (GSREvents.setSurface toggles #map ⇄ #globe3dContainer). This
 * controller owns the Cesium half: it lazy-loads CesiumJS the first time the 3D
 * surface is opened, mounts one warm GSRGlobeManager, and keeps it paused
 * (render loop off) while the 2D map is showing.
 *
 * The 3D globe is a READ-ONLY view of the 2D state. It never writes back:
 *   - geometry, colour metric and colour range come from GSRMapManager
 *     (_lastDrawPoints / activeColoringMetric / _legendMinVal|_legendMaxVal),
 *     pushed on every 'map:rendered';
 *   - the single map-panel header (zoom / RF + band / Peaks / Hotspots /
 *     Labels / Clusters / metric / the OSM button, which toggles 3D buildings
 *     here) is the 2D map's; events.js dispatches it via applyToggle /
 *     applyRfMode / applyBuildings / zoom / fitTrack while 3D is mounted;
 *   - the 3D-only settings sub-section (#mapDisplay3DGroup: wall-height scale,
 *     basemap, building style, RF ceiling/opacity, camera) mutates only this
 *     controller's manager.
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
    // Only the 3D globe's own surface + its 3D-only settings sub-section
    // (#mapDisplay3DGroup). The shared header controls (zoom / RF + band /
    // Peaks / Hotspots / Labels / Clusters / metric / the OSM button, which
    // toggles 3D buildings while the globe is mounted) are the 2D map's —
    // src/ui/events.js dispatches them here via applyToggle / applyRfMode /
    // applyBuildings / zoom.
    const els = GSRGlobe3DView.els = {
      container:    $('globe3dContainer'),
      status:       $('globe3dStatus'),
      legend:       $('g3dLegend'),
      // 3D-only settings sub-section widgets (#mapDisplay3DGroup)
      extrusion:    $('g3dExtrusionScale'),
      extrusionVal: $('g3dExtrusionScaleVal'),
      basemap:      $('g3dBasemap'),
      buildingStyle:$('g3dBuildingStyle'),
      rfRow:        $('g3dRfControlsRow'),
      rfHeight:     $('g3dRfHeight'),
      rfHeightVal:  $('g3dRfHeightVal'),
      rfOpacity:    $('g3dRfOpacity'),
      rfOpacityVal: $('g3dRfOpacityVal'),
      btnOrbit:     $('g3dBtnOrbit'),
      btnTour:      $('g3dBtnTour'),
      btnPersp3D:   $('g3dBtnPersp3D'),
      btnPerspTop:  $('g3dBtnPerspTop'),
      btnPerspGround: $('g3dBtnPerspGround'),
      btnNorth:     $('g3dBtnNorth')
    };

    GSRGlobe3DView._bindCard(els);

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
   * True unless the map/globe panel is in its own panel-fullscreen overlay —
   * which hides the GSR graph (and the 2D map). Browser fullscreen keeps them
   * visible, so it doesn't count.
   */
  _graphVisible() {
    const c = GSRGlobe3DView.els.container;
    return !(c && typeof c.closest === 'function' && c.closest('.panel-fullscreen-overlay'));
  },

  /**
   * Panel fullscreen entered / exited (wired from GSRLayoutManager). Entering
   * hides the GSR graph, so drop any globe-driven scrub cursor and hand the
   * graph scrubber back — reverse-hover scrubbing resumes on exit.
   */
  onPanelFullscreenChange(on) {
    if (!on) return;
    const mgr = GSRGlobe3DView.manager;
    if (mgr) {
      mgr.setScrubPosition(NaN, NaN);
      mgr.releaseFollowScrub();
      if (mgr._requestRender) mgr._requestRender();
    }
    GSRGlobe3DView._lastScrubKey = null;
    if (typeof AppState !== 'undefined' && AppState.scrubSource === 'globe') {
      AppState.scrubSource = null;
      AppState.hoveredIndex = -1;
      AppState.emit('scrub', { clear: true, source: 'globe' });
      if (typeof redraw === 'function') redraw();
    }
  },

  /**
   * Pointer moved over (or off) the 3D track — the reverse direction. Walk the
   * graph scrubber to that moment via the shared channel; AppState.scrubSource
   * is the ownership token that stops renderer.js's per-frame handleScrubber()
   * from wiping the hover. Single-track scope only (no graph in collective).
   * No-op while the panel is fullscreen — the graph (and its blue ground
   * cursor) isn't on screen, so there's nothing to scrub.
   */
  _onScrubHover(idx, ll) {
    if (!GSRGlobe3DView.isActive || typeof AppState === 'undefined') return;
    if (AppState.viewMode !== 'single') return;
    if (!GSRGlobe3DView._graphVisible()) return;

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
    if (els.basemap) {
      els.basemap.addEventListener('change', (e) => { if (m()) m().setBasemap(e.target.value); });
    }
    // Buildings on/off is the map header's OSM button (see applyBuildings); this
    // just restyles whatever is showing.
    if (els.buildingStyle) {
      els.buildingStyle.addEventListener('change', (e) => { if (m()) m().apply3DBuildingStyle(e.target.value); });
    }

    // The RF ceiling-height / cloud-opacity sliders are 3D-volumetric-only (on/
    // off + band are the map header's RF button + #rfFluidMode). They just
    // re-apply the field with the current header band.
    const applyRfParams = () => {
      if (m() && m().showRfVolumetric) {
        m().toggle3DRf(
          true,
          GSRGlobe3DView._headerRfMode(),
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

    if (els.btnOrbit)  els.btnOrbit.addEventListener('click', () => {
      if (m()) {
        const isOrbiting = m().toggleOrbit();
        els.btnOrbit.classList.toggle('active', isOrbiting);
        if (isOrbiting) GSRGlobe3DView._updateTourBtn(false);
      }
    });
    if (els.btnTour) {
      els.btnTour.addEventListener('click', () => {
        if (m()) {
          const isTouring = m().toggleTour();
          GSRGlobe3DView._updateTourBtn(isTouring);
          if (isTouring && els.btnOrbit) els.btnOrbit.classList.remove('active');
        }
      });
    }
    if (els.btnPersp3D)     els.btnPersp3D.addEventListener('click', () => {
      if (m()) { m().setViewPerspective('3d'); GSRGlobe3DView._updateTourBtn(false); }
    });
    if (els.btnPerspTop)    els.btnPerspTop.addEventListener('click', () => {
      if (m()) { m().setViewPerspective('top'); GSRGlobe3DView._updateTourBtn(false); }
    });
    if (els.btnPerspGround) els.btnPerspGround.addEventListener('click', () => {
      if (m()) { m().setViewPerspective('ground'); GSRGlobe3DView._updateTourBtn(false); }
    });
    if (els.btnNorth)  els.btnNorth.addEventListener('click', () => { if (m()) m().resetNorth(); });
  },

  _updateTourBtn(isTouring) {
    const btn = GSRGlobe3DView.els.btnTour;
    if (!btn) return;
    btn.classList.toggle('active', !!isTouring);
    btn.innerHTML = isTouring
      ? '<i class="fa-solid fa-pause"></i> Pause'
      : '<i class="fa-solid fa-route"></i> Tour';
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

  // ── Shared header controls, dispatched from the 2D map (src/ui/events.js) ──
  //
  // There is one map-panel header now; Leaflet and Cesium are swapped inside
  // the panel. The header's zoom / RF + band / Peaks / Hotspots / Labels /
  // Clusters / metric controls (and the OSM button) belong to the 2D map (still
  // "chief"). events.js drives the 2D map + button state, then calls the
  // methods below to mirror the result onto the globe whenever it is mounted.

  /** The map header's RF band (#rfFluidMode) — the single band source now. */
  _headerRfMode() {
    const sel = document.getElementById('rfFluidMode');
    return (sel && sel.value) || (GSRGlobe3DView.manager && GSRGlobe3DView.manager.rfMode) || 'triband';
  },

  _rfHeight() {
    const s = GSRGlobe3DView.els.rfHeight;
    return s ? parseFloat(s.value) : 25;
  },

  _rfOpacity() {
    const s = GSRGlobe3DView.els.rfOpacity;
    return s ? parseFloat(s.value) : 0.45;
  },

  /**
   * A shared layer toggle was flipped. events.js has already driven the 2D map
   * and the button's .active class; mirror it onto the globe. No-op unless the
   * 3D surface is mounted.
   * @param {'peaks'|'hotspots'|'labels'|'clusters'|'rf'} name
   * @param {boolean} on
   */
  applyToggle(name, on) {
    const mgr = GSRGlobe3DView.manager;
    if (!GSRGlobe3DView.isActive || !mgr) return;
    const els = GSRGlobe3DView.els;
    switch (name) {
      case 'peaks':    mgr.togglePeaks(on, mgr.minPeakQuality || 0); break;
      case 'hotspots': mgr.toggleHotspots(on); break;
      case 'labels':   mgr.toggleLabels(on); break;
      case 'clusters': mgr.toggleClusters(on); break;
      case 'rf':
        if (els.rfRow) els.rfRow.style.display = on ? 'flex' : 'none';
        mgr.toggle3DRf(on, GSRGlobe3DView._headerRfMode(),
          GSRGlobe3DView._rfHeight(), GSRGlobe3DView._rfOpacity());
        break;
    }
  },

  /**
   * The map header's RF band (#rfFluidMode) changed — re-apply the volumetric
   * field if it is showing, else just remember the band on the manager.
   */
  applyRfMode(mode) {
    const mgr = GSRGlobe3DView.manager;
    if (!GSRGlobe3DView.isActive || !mgr) return;
    if (mgr.showRfVolumetric) {
      mgr.toggle3DRf(true, mode, GSRGlobe3DView._rfHeight(), GSRGlobe3DView._rfOpacity());
    } else {
      mgr.rfMode = mode;
    }
  },

  /**
   * The active coloring metric changed in the map panel header.
   * Forward to the globe manager and refresh legend.
   */
  applyColorMetric(metric) {
    const mgr = GSRGlobe3DView.manager;
    if (!GSRGlobe3DView.isActive || !mgr) return;
    mgr.setColoringMetric(metric);
    GSRGlobe3DView._updateLegend();
  },

  /**
   * The map header's OSM button was clicked while the 3D globe is mounted — it
   * toggles the extruded OSM buildings (the 3D equivalent of the 2D OSM vector
   * shapes). Style comes from the #g3dBuildingStyle select.
   *
   * The OSM data is the SAME as the 2D "Spatial Data" enrichment: resolved via
   * _resolveOsmJson() (reuse analyzer.osmJson → shared OsmCache → one Overpass
   * fetch that is then stored back), so a 2D enrich and a 3D buildings toggle
   * never double-download, and either one makes the 2D OSM shapes button live.
   */
  applyBuildings(on) {
    const mgr = GSRGlobe3DView.manager;
    if (!GSRGlobe3DView.isActive || !mgr) return;
    const style = (GSRGlobe3DView.els.buildingStyle && GSRGlobe3DView.els.buildingStyle.value) || 'monochrome';

    if (!on) { mgr.toggle3DBuildings(false, style); return; }

    Promise.resolve(GSRGlobe3DView._resolveOsmJson()).then((osmJson) => {
      if (!GSRGlobe3DView.isActive || !GSRGlobe3DView.manager) return;
      if (osmJson) GSRGlobe3DView.manager.cachedOsmJson = osmJson;
      return GSRGlobe3DView.manager.toggle3DBuildings(true, style, (m) => GSRGlobe3DView._setStatus(m));
    }).then(() => {
      // The fetch may have populated analyzer.osmGeoms — let the 2D map's OSM
      // shapes button pick that up.
      if (typeof GSRUI !== 'undefined' && GSRUI.refreshOsmControls) GSRUI.refreshOsmControls();
    }).catch((e) => {
      console.warn('3D buildings OSM fetch failed:', e);
      GSRGlobe3DView._setStatus('');
    });
  },

  /**
   * The bbox buffer (metres) the 2D "Spatial Data" enrichment uses —
   * max(#osmRadius, #gpsSnapRadius) + 50 (see GSRUI.enrichTrack). Matching it
   * exactly is what makes OsmCache's contains-match hit both ways: whichever of
   * the 2D enrich / 3D buildings toggle runs first, the other reuses its cache.
   */
  _osmBboxBufferM() {
    const num = (id, dflt) => {
      const v = parseInt((document.getElementById(id) || {}).value, 10);
      return Number.isFinite(v) ? v : dflt;
    };
    return Math.max(num('osmRadius', 50), num('gpsSnapRadius', 25)) + 50;
  },

  /**
   * Resolve the Overpass JSON for the active track's area, sharing every layer
   * of the 2D enrichment's cache:
   *   1. analyzer.osmJson (already in memory from a 2D enrich or a prior toggle)
   *   2. OsmCache.getForBBox (the persistent cross-session cache)
   *   3. one Overpass fetch via OsmCache.planFetch, then OsmCache.store
   * On a fresh fetch it also stashes analyzer.osmJson and reconstructs
   * analyzer.osmGeoms (geometry only — no per-point metadata / no isEnriched),
   * which is all the 2D OSM vector-shapes button needs.
   * @returns {Promise<Object|null>}
   */
  async _resolveOsmJson() {
    const analyzer = (typeof AppState !== 'undefined') ? AppState.analyzer : null;
    if (!analyzer || !analyzer.raw || analyzer.raw.length === 0) return null;
    if (typeof OSMEnricher === 'undefined') return analyzer.osmJson || null;

    let osmJson = analyzer.osmJson || null;
    if (!osmJson && typeof OsmCache !== 'undefined') {
      const bbox = OSMEnricher.calculateBBox(analyzer.raw, GSRGlobe3DView._osmBboxBufferM());
      if (bbox) {
        osmJson = await OsmCache.getForBBox(bbox);
        if (!osmJson) {
          const plan = await OsmCache.planFetch(bbox);
          osmJson = await OSMEnricher.fetchOSMData(plan.fetchBBox, (m) => GSRGlobe3DView._setStatus(m));
          if (osmJson) OsmCache.store(plan.fetchBBox, osmJson, plan.mergeIds);
        }
      }
      if (osmJson) analyzer.osmJson = osmJson; // shared with GSRUI.enrichTrack's in-memory reuse
    }

    // Reconstruct geometry whenever we have json but no geoms (a cache load or a
    // fresh fetch) — this is all the 2D OSM vector-shapes button needs.
    if (osmJson && !analyzer.osmGeoms && typeof OSMEnricher.reconstructGeometries === 'function') {
      analyzer.osmGeoms = OSMEnricher.reconstructGeometries(osmJson);
    }
    return osmJson;
  },

  /** Header zoom in/out (dir < 0 zooms in). Drives the Cesium camera. */
  zoom(dir) {
    const v = GSRGlobe3DView.manager && GSRGlobe3DView.manager.viewer;
    if (!v) return;
    const h = v.camera.positionCartographic.height;
    const step = Math.max(20, h * 0.35);
    if (dir < 0) v.camera.zoomIn(step); else v.camera.zoomOut(step);
    v.scene.requestRender(); // programmatic camera move needs a nudge in requestRenderMode
  },

  /** Header "zoom to extent" — frame the whole track. */
  fitTrack() {
    if (GSRGlobe3DView.manager) GSRGlobe3DView.manager.flyToTrack();
  },

  // ── Mirror 2D toggle state onto the globe ────────────────────────────────

  /**
   * Re-read the 2D map's layer-toggle + RF state and mirror it onto the globe
   * manager (and the 3D-only RF widgets). Runs at the top of every _pushFromMap
   * so opening the 3D surface — or any 2D re-render — starts from the same
   * state. Sets manager flags only; the caller's renderData() does the drawing.
   */
  _mirrorToggleState() {
    const mm = (typeof AppState !== 'undefined') ? AppState.mapManager : null;
    if (!mm) return;
    const els = GSRGlobe3DView.els;
    const mgr = GSRGlobe3DView.manager;

    if (mgr) {
      mgr.showPeaks    = !!mm.showPeaks;
      mgr.showHotspots = !!mm.showHotspots;
      mgr.showLabels   = !!mm.showLabels;
      mgr.showClusters = !!mm.showClusters;
    }

    const rfBtn2d = document.getElementById('btnToggleRFFluid');
    const rfDisabled = rfBtn2d ? rfBtn2d.hasAttribute('disabled') : false;
    const rfOn = !rfDisabled && (rfBtn2d ? rfBtn2d.classList.contains('active') : !!mm.showRFFluid);
    const rfMode2d = document.getElementById('rfFluidMode');
    const rfMode = rfMode2d ? rfMode2d.value : (mgr ? mgr.rfMode : 'triband');
    if (els.rfRow) els.rfRow.style.display = rfOn ? 'flex' : 'none';
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
        // Render continuously while the 3D surface is showing — render-on-demand
        // added a cold first frame on grab that read as sticky. deactivate()
        // parks the viewer (useDefaultRenderLoop=false) the moment 2D is shown,
        // so this only costs frames while you're actually looking at the globe.
        requestRenderMode: false,
        metric: (mm && mm.activeColoringMetric) || 'phasic',
        heightMetric: 'phasic', // fixed — the wall auto-uses a magnitude colour metric, else phasic
        extrusionScale: GSRGlobe3DView.els.extrusion ? parseFloat(GSRGlobe3DView.els.extrusion.value) : 8.0
      });
      GSRGlobe3DView.manager.onPeakClick((peakIdx) => GSRGlobe3DView._editPeakLabel(peakIdx));
      GSRGlobe3DView.manager.onScrubHover((idx, ll) => GSRGlobe3DView._onScrubHover(idx, ll));
      GSRGlobe3DView.manager.onTourStep((stepIdx, totalSteps, wp) => {
        if (wp) {
          GSRGlobe3DView._updateTourBtn(true);
          if (typeof AppState !== 'undefined') {
            AppState.hoveredIndex = wp.origIdx;
            AppState.emit('scrub', { lat: wp.lat, lon: wp.lon, index: wp.origIdx, source: 'globe' });
            if (typeof redraw === 'function') redraw();
          }
        } else {
          GSRGlobe3DView._updateTourBtn(false);
        }
      });
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
      // Carry the shared OSM-layer toggle onto the globe: if the map header's
      // OSM button is on, show the 3D buildings (reusing the shared cache).
      const osmBtn = document.getElementById('btnToggleOsmShapes');
      const mgr = GSRGlobe3DView.manager;
      if (osmBtn && osmBtn.classList.contains('active') && !(mgr && mgr.show3DBuildings)) {
        GSRGlobe3DView.applyBuildings(true);
      }
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
      if (typeof mgr.stopTour === 'function') mgr.stopTour();
      mgr.setScrubPosition(NaN, NaN);
      mgr.releaseFollowScrub();
    }
    GSRGlobe3DView._updateTourBtn(false);
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

    // Mirror the 2D map's layer toggles onto the globe manager first, so the
    // state is right whether or not there's a track to draw yet.
    GSRGlobe3DView._mirrorToggleState();
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
    GSRGlobe3DView._updateLegend();
  },

  // ── Small UI bits ────────────────────────────────────────────────────────

  _updateLegend() {
    const els = GSRGlobe3DView.els;
    const mm = (typeof AppState !== 'undefined') ? AppState.mapManager : null;

    // Render the exact same legend the 2D map shows — title, gradient/swatches,
    // formatted range, RF sub-legend and all (see GSRMapManager.buildLegendHtml).
    if (els.legend && mm && typeof mm.buildLegendHtml === 'function') {
      els.legend.innerHTML = mm.buildLegendHtml();
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
