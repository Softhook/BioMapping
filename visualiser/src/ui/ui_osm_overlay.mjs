/**
 * GSRUI — OSM overlay display. Object-augment split from ui.js: loaded
 * immediately after ui.js, adds these methods to the shared GSRUI object.
 *
 * The map-panel header's "OSM" button is one shared toggle rendered two ways
 * (2D Leaflet polygons, 3D Cesium extruded buildings). setOsmOverlay() is the
 * button handler (records intent, fetches on demand); syncOsmOverlay() is the
 * synchronous, never-fetches reconciler called on every real state change
 * (surface switch, track switch, enrichment). See the file-local comment
 * above _osmOverlayOn for the full contract. Depends on ui_enrichment.js's
 * ensureOsmGeoms() for the on-demand fetch.
 */
import { AppState } from '../core/app_state.mjs';
import { GSRGlobe3DView } from '../map/globe3d_view.mjs';
import { GSRUI } from './ui.mjs';

export const __methods = {

  /**
   * OSM ways/relations to draw as map overlays for whichever tracks are
   * currently active: a single analyzer's osmGeoms in single-track mode,
   * or the union — de-duplicated by OSM element id — of every active
   * track's osmGeoms in collective mode. Two tracks enriched at
   * different times can have their own osmGeoms with only partial or no
   * overlap; without merging them, toggling "OSM Layers" in collective
   * mode would only ever draw whichever single analyzer AppState.analyzer
   * happened to reference, not the combined coverage the user actually
   * retrieved. OSM element ids are globally stable, so de-duping by id
   * across tracks is safe (same id always means the same geometry).
   */
  getCombinedOsmGeoms() {
    if (AppState.viewMode !== 'collective') {
      return (AppState.analyzer && AppState.analyzer.osmGeoms) ? AppState.analyzer.osmGeoms : null;
    }

    if (!AppState.collectiveManager) return null;
    const tracks = AppState.collectiveManager.getActiveTracks()
      .filter(t => t.analyzer && t.analyzer.osmGeoms);
    if (tracks.length === 0) return null;
    if (tracks.length === 1) return tracks[0].analyzer.osmGeoms;

    const wayMap = new Map();
    const relationMap = new Map();
    for (const t of tracks) {
      const g = t.analyzer.osmGeoms;
      if (g.ways)      for (const w of g.ways)      wayMap.set(w.id, w);
      if (g.relations) for (const r of g.relations) relationMap.set(r.id, r);
    }
    return { ways: Array.from(wayMap.values()), relations: Array.from(relationMap.values()) };
  },

  /* ==========================================================================
     OSM overlay — the single control point.

     The map-panel header's "OSM" button is one shared toggle with ONE meaning
     ("show OpenStreetMap building / park / water context"), rendered two ways:
     L.polygon vector shapes on the 2D Leaflet map, extruded buildings on the
     3D Cesium globe. Its on/off intent lives in GSRUI._osmOverlayOn; the
     button's `.active` class is only a visual mirror of it.

     Two entry points, deliberately split:

       setOsmOverlay(on)  — async, the header button's handler ONLY. Records the
                            intent, then (turning on, 2D, no geometry cached)
                            fetches it once via ensureOsmGeoms. Ends by calling
                            syncOsmOverlay.

       syncOsmOverlay()   — synchronous, never fetches, never throws. Reconciles
                            the button + renders/clears on whichever surface is
                            mounted RIGHT NOW, from geometry already in memory.
                            Called on every real change: GSREvents.setSurface,
                            GSRGlobe3DView.activate, refreshOsmControls (track
                            switch / enrichment), the "no tracks" reset.

     It is NOT called from the render loop: clearMap() deliberately leaves the
     OSM layer alone (it is area-scoped, not path-scoped), so a GSR/GPS slider
     re-render never disturbs it and needs no redraw. Because syncOsmOverlay
     re-reads AppState.surfaceView every call, switching 2D⇄3D mid-fetch can't
     leave the overlay on the wrong surface. Nothing else may call drawOsmShapes
     / clearOsmShapes / GSRGlobe3DView.applyBuildings for the toggle.
     ========================================================================== */

  _osmOverlayOn: false,
  _osmFetching: false,

  /**
   * Reconcile the OSM overlay with the CURRENT intent (GSRUI._osmOverlayOn) and
   * the CURRENT render surface, using only geometry already in memory. Pure
   * reconcile — synchronous, no network, swallows its own errors so it is safe
   * to call fire-and-forget from any sync path.
   */
  syncOsmOverlay() {
    try {
      const on = GSRUI._osmOverlayOn;
      const mm = AppState.mapManager;
      const g3d = (typeof GSRGlobe3DView !== 'undefined') ? GSRGlobe3DView : null;

      const btn = document.getElementById('btnToggleOsmShapes');
      if (btn && btn.classList) btn.classList[on ? 'add' : 'remove']('active');

      if (AppState.surfaceView === 'globe') {
        if (mm) mm.clearOsmShapes(); // the 2D layer must not linger under the globe
        // Drive the extruded buildings on a state change — applyBuildings runs
        // its own async resolve; _rebuildLayers re-asserts them after a teardown.
        // Also rebuild when the active track's OSM json has been replaced (a 2D
        // re-enrich / radius change while the globe is mounted) so the buildings
        // don't keep an area's stale coverage.
        const mgr = g3d && g3d.manager;
        const shown = !!(mgr && mgr.show3DBuildings);
        const staleJson = !!(on && shown && mgr && AppState.analyzer &&
          AppState.analyzer.osmJson && mgr.cachedOsmJson &&
          mgr.cachedOsmJson !== AppState.analyzer.osmJson);
        if (g3d && (shown !== on || staleJson)) g3d.applyBuildings(on);
        return;
      }

      if (!mm) return;
      const geoms = on ? GSRUI.getCombinedOsmGeoms() : null;
      if (geoms) mm.drawOsmShapes(geoms); // drawOsmShapes clears first — safe to repeat
      else mm.clearOsmShapes();
    } catch (e) {
      console.warn('syncOsmOverlay failed:', e);
    }
  },

  /**
   * The header OSM button's handler. Sets the on/off intent and reconciles; on
   * a 2D turn-on with nothing cached, fetches the geometry once (shared
   * OsmCache, see ensureOsmGeoms) with button spinner + progress, then
   * reconciles again. The globe path needs no fetch here — applyBuildings()
   * resolves the same cache itself.
   *
   * @param {boolean} on
   */
  async setOsmOverlay(on) {
    on = !!on;
    GSRUI._osmOverlayOn = on;

    // Outer guard: this is invoked fire-and-forget from a DOM click handler, so
    // nothing below may surface as an unhandled rejection.
    try {
      GSRUI.syncOsmOverlay();

      if (!on) return;
      if (AppState.surfaceView === 'globe') return; // applyBuildings self-resolves
      if (GSRUI.getCombinedOsmGeoms()) return;      // syncOsmOverlay already drew it
      if (GSRUI._osmFetching) return;               // a fetch is already running

      GSRUI._osmFetching = true;
      const btn = document.getElementById('btnToggleOsmShapes');
      const label = btn ? btn.innerHTML : '';
      if (btn) btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
      GSRUI.setSpatialProgress(true, 'Retrieving OpenStreetMap shapes…', 15, '#ff7b00');

      let res;
      try {
        res = await GSRUI.ensureOsmGeoms((msg) => GSRUI.setSpatialProgress(true, msg, 55, '#ff7b00'));
      } catch (e) {
        console.warn('OSM overlay fetch failed:', e);
        res = { ok: false };
      } finally {
        GSRUI._osmFetching = false;
        if (btn) btn.innerHTML = label;
      }

      // The user toggled the overlay back off (or it was turned off elsewhere)
      // while the fetch was in flight — honour that, don't force it back on.
      if (!GSRUI._osmOverlayOn) return;

      if (!res || !res.ok) {
        GSRUI._osmOverlayOn = false;
        GSRUI.syncOsmOverlay();
        const msg = res && res.reason === 'no-gps'
          ? 'No GPS fixes in this track — no OpenStreetMap shapes to fetch.'
          : (res && res.tooBig ? 'Track area too large (> 12 km²) to fetch OpenStreetMap shapes.'
                               : 'Could not retrieve OpenStreetMap data.');
        GSRUI.setSpatialProgress(true, msg, 100, 'var(--danger)');
        setTimeout(() => GSRUI.setSpatialProgress(false), 6000);
        return;
      }

      GSRUI.setSpatialProgress(true, res.fetched ? 'OpenStreetMap shapes fetched.' : 'OpenStreetMap shapes loaded from cache.', 100, '#2d6a4f');
      setTimeout(() => GSRUI.setSpatialProgress(false), 3000);

      // Unlock the OSM colour-metric options / env dashboard that key off geoms;
      // refreshOsmControls ends by calling syncOsmOverlay, which draws.
      GSRUI.refreshOsmControls();
    } catch (e) {
      GSRUI._osmFetching = false;
      console.warn('setOsmOverlay failed:', e);
    }
  },

  /**
   * Helper to refresh UI elements based on track enrichment state.
   */
  refreshOsmControls() {
    const analyzers = (AppState.viewMode === 'single')
      ? (AppState.analyzer ? [AppState.analyzer] : [])
      : AppState.collectiveManager.getActiveTracks().map(t => t.analyzer).filter(Boolean);

    // Full enrichment (per-point spatial metadata) is what gates the OSM colour
    // metrics + the environmental dashboard below. The OSM overlay itself only
    // needs reconstructed geometry (analyzer.osmGeoms), fetched on demand — it
    // is driven entirely by GSRUI.setOsmOverlay / syncOsmOverlay, not isEnriched.
    const enriched = analyzers.filter(a => a.isEnriched);
    const isEnriched = enriched.length > 0;

    GSRUI.updateSpatialDataIndicator();

    const select = document.getElementById('mapColoringMetric');
    const envPanel = document.getElementById('environmentalPanel');

    // Re-render the shared OSM overlay for the now-active track(s) / surface.
    // syncOsmOverlay is a pure synchronous reconcile — no fetch, no throw — so
    // this is safe on every track switch / enrichment. See GSRUI.setOsmOverlay.
    GSRUI.syncOsmOverlay();

    if (isEnriched) {
      document.querySelectorAll('.osm-option').forEach(opt => opt.removeAttribute('disabled'));
      envPanel.style.display = 'block';

      const firstEnriched = enriched.find(a => a.enrichmentRadius);
      const rad = firstEnriched ? firstEnriched.enrichmentRadius : null;
      if (rad) {
        document.getElementById('osmRadius').value = rad;
        document.getElementById('valOsmRadius').innerText = rad + ' m';
      }

      GSRUI.updateEnvironmentalDashboard();
    } else {
      document.querySelectorAll('.osm-option').forEach(opt => opt.setAttribute('disabled', 'true'));
      // Only fall back to GSR if the current metric is an OSM-only one that just
      // became unavailable — don't clobber a plain choice like Phasic.
      const cur = select && select.selectedOptions && select.selectedOptions[0];
      if (cur && cur.classList.contains('osm-option')) {
        select.value = 'gsr';
        if (AppState.mapManager) AppState.mapManager.activeColoringMetric = 'gsr';
      }
      envPanel.style.display = 'none';
    }
  },

};

Object.assign(GSRUI, __methods);
