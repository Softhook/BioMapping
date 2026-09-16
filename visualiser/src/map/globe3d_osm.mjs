/**
 * GSRGlobeManager — 3D OSM building extrusion.
 * Prototype-augment split from globe3d.js: loaded after globe3d.js, adds
 * these methods to GSRGlobeManager.prototype.
 *
 * Orchestration only (fetch/fallback/scene lifecycle around
 * this.buildingsTileset / this.buildingPrimitive) — the actual footprint
 * geometry is built by the pure GSRGlobe3DBuildings module
 * (src/map/globe3d/buildings.js), loaded earlier.

 * Assigned onto GSRGlobeManager.prototype via Object.assign at the file's
 * tail (a plain ESM static import/export, loaded once by app_entry.mjs).
 */

import { OSMEnricher } from '../osm/osm_enrichment.mjs';
import { GSRGlobe3DBuildings } from './globe3d/buildings.mjs';
import { GSRGlobeManager } from './globe3d.mjs';

export const __methods = {
  /**
   * Toggle 3D Buildings: Uses direct OpenStreetMap Overpass vector extrusion (token-free)
   * or falls back to Cesium ion 3D Tiles if configured.
   * @param {boolean} show
   * @param {'monochrome'|'glass'|'dark'|'realistic'} [style='monochrome']
   * @param {Function} [onStatus]
   */
  async toggle3DBuildings(show, style = 'monochrome', onStatus) {
    this.show3DBuildings = show;
    this.buildingStyle = style;
    if (typeof this.onBuildingsChange === 'function') {
      try {
        this.onBuildingsChange(show);
      } catch (_e) {
        /* ignore */
      }
    }

    if (!show) {
      this.clearOsmBuildingEntities();
      if (this.buildingsTileset) this.buildingsTileset.show = false;
      if (onStatus) onStatus('');
      return;
    }

    // 1. Direct OpenStreetMap Overpass extrusion (100% token-free, open data)
    if (this.cachedOsmJson) {
      this.renderOsm3DBuildings(this.cachedOsmJson, style);
      if (onStatus) onStatus('');
      return;
    }

    // Guard against a second toggle landing while the Overpass fetch is still
    // in flight — that raced two primitives (a leak) and two status flickers.
    if (this._buildingsFetching) return;

    if (
      this.currentDrawPoints &&
      this.currentDrawPoints.length > 0 &&
      typeof OSMEnricher !== 'undefined'
    ) {
      this._buildingsFetching = true;
      try {
        if (onStatus) onStatus('Fetching OpenStreetMap 3D buildings…');
        const rawPoints = this.currentDrawPoints.map((p) => ({
          lat: p.lat,
          lon: p.lon,
        }));
        const bbox = OSMEnricher.calculateBBox(rawPoints, 350);
        if (bbox) {
          const osmJson = await OSMEnricher.fetchOSMData(bbox, onStatus);
          // A toggle-off (or teardown) during the await wins — don't draw.
          if (osmJson && this.show3DBuildings && this.viewer) {
            this.cachedOsmJson = osmJson;
            this.renderOsm3DBuildings(osmJson, style);
            if (onStatus) onStatus('');
            return;
          }
        }
      } catch (err) {
        console.warn(
          'Direct Overpass building fetch failed, checking Cesium ion fallback:',
          err,
        );
      } finally {
        this._buildingsFetching = false;
      }
    }

    // A toggle-off (or teardown) while the Overpass fetch was running wins.
    if (!this.show3DBuildings || !this.viewer) {
      if (onStatus) onStatus('');
      return;
    }

    // 2. Fallback to Cesium ion global 3D tiles if token available
    if (!this.buildingsTileset) {
      try {
        if (typeof Cesium.createOsmBuildingsAsync === 'function') {
          this.buildingsTileset = await Cesium.createOsmBuildingsAsync();
        } else {
          this.buildingsTileset =
            await Cesium.Cesium3DTileset.fromIonAssetId(96188);
        }
        this.viewer.scene.primitives.add(this.buildingsTileset);
      } catch (err) {
        if (onStatus) onStatus('');
        this._notifyError(err);
        this.show3DBuildings = false;
        return;
      }
    }

    this.buildingsTileset.show = true;
    this.apply3DBuildingStyle(style);
    this._requestRender();
    if (onStatus) onStatus('');
  },

  /**
   * Extrude raw OpenStreetMap Overpass building footprints into one batched GPU
   * primitive. Geometry build lives in src/map/globe3d/buildings.js; this owns
   * the scene primitive's lifecycle.
   */
  renderOsm3DBuildings(osmJson, style = 'glass') {
    this.clearOsmBuildingEntities();
    if (!this.viewer || typeof GSRGlobe3DBuildings === 'undefined') return;
    const prim = GSRGlobe3DBuildings.buildPrimitive(osmJson, style);
    if (prim) {
      this.buildingPrimitive = prim;
      this.viewer.scene.primitives.add(prim);
    }
  },

  clearOsmBuildingEntities() {
    if (this.buildingPrimitive) {
      this.viewer.scene.primitives.remove(this.buildingPrimitive);
      this.buildingPrimitive = null;
    }
    if (this.osmBuildingEntities && this.osmBuildingEntities.length > 0) {
      this.osmBuildingEntities.forEach((ent) => {
        this.viewer.entities.remove(ent);
      });
      this.osmBuildingEntities = [];
    }
  },

  /**
   * Apply architectural 3D Tile styling
   */
  apply3DBuildingStyle(style) {
    this.buildingStyle = style;

    // Re-render local OSM extruded buildings if active
    if (this.cachedOsmJson) {
      this.renderOsm3DBuildings(this.cachedOsmJson, style);
      this._requestRender();
      return;
    }

    // Otherwise update the Cesium ion 3D-tiles style.
    if (!this.buildingsTileset) return;
    this.buildingsTileset.style = new Cesium.Cesium3DTileStyle({
      color: GSRGlobe3DBuildings.tileStyleExpression(style),
      show: true,
    });
    this._requestRender();
  },
};

Object.assign(GSRGlobeManager.prototype, __methods);
