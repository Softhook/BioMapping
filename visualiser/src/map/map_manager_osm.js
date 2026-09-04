/**
 * GSRMapManager — OSM vector geometry overlays (parks, water, buildings).
 * Prototype-augment split from map.js: loaded immediately after map.js, adds
 * these methods to GSRMapManager.prototype.
 *
 * `drawOsmShapes(geoms)` groups same-style features into at most three
 * multi-ring L.polygon layers (park / water / building) and tracks them in
 * this.osmLayers; `clearOsmShapes()` removes them. It also feeds the current
 * draw points + geoms to this.rfFluidRenderer.
 *
 * Depends on the globals L and AppState (resolved at call time) and on
 * this._getOrBuildDrawPoints (map_manager_process.js).
 */
Object.assign(GSRMapManager.prototype, {

  /**
   * Draw OSM vector geometry overlays (parks, water, buildings) on the map.
   * Accepts pre-built geoms (from analyzer.osmGeoms) to avoid redundant
   * geometry reconstruction.
   */
  drawOsmShapes(geoms) {
    this.clearOsmShapes();
    if (!geoms || !geoms.ways || !this.map) return;

    let points = this._lastDrawPoints || [];
    if ((!points || points.length === 0) && typeof AppState !== 'undefined' && AppState.viewMode === 'collective' && AppState.collectiveManager) {
      const activeTracks = AppState.collectiveManager.getActiveTracks();
      const combinedPoints = [];
      activeTracks.forEach(t => {
        const p = t.gpsFilterParams || {};
        const { drawPoints } = this._getOrBuildDrawPoints(t.id, t.analyzer, p);
        if (drawPoints) combinedPoints.push(...drawPoints);
      });
      if (combinedPoints.length > 0) {
        points = combinedPoints;
        this._lastDrawPoints = combinedPoints;
      }
    }

    if (this.rfFluidRenderer) {
      this.rfFluidRenderer.setData(points, geoms);
    }

    this.osmLayers = [];

    // Group same-style shapes into a single ring array per category, instead
    // of one Leaflet Path layer per feature. Areas with dense OSM building
    // coverage can hand back thousands of ways/relations; each one used to
    // become its own L.polygon (own layer registration, own onAdd/_project
    // pass, own entry in the map's layer table). Rings within a category
    // never overlap each other (they're distinct real-world buildings/parks/
    // water bodies), so a single multi-ring L.polygon per category renders
    // pixel-identical output — canvas/SVG fill and stroke both treat each
    // disjoint ring independently regardless of winding — while cutting the
    // layer count from N features down to at most 3 (park/water/building).
    const ringsByCategory = { park: [], water: [], building: [] };
    const STYLES = {
      park:     { color: '#2d6a4f', fillColor: '#52b788', fillOpacity: 0.15, weight: 1 },
      water:    { color: '#0077b6', fillColor: '#90e0ef', fillOpacity: 0.25, weight: 1 },
      building: { color: '#4a4e69', fillColor: '#9a8c98', fillOpacity: 0.1,  weight: 1 }
    };

    geoms.ways.concat(geoms.relations).forEach(geom => {
      const tags = geom.tags;
      if (!tags) return;

      // Same green / water classification the enrichment metrics use, so the
      // drawn overlay can never disagree with green_pct / in_park / dist_water.
      // A wetland satisfies both predicates (blue AND green); the overlay can
      // only paint one colour, and green wins here.
      const isPark = OSMEnricher.isGreenSpace(geom);
      const isWater = OSMEnricher.isWaterSpace(geom);
      const isBuilding = !!tags.building;

      const category = isPark ? 'park' : (isWater ? 'water' : (isBuilding ? 'building' : null));
      if (!category) return;

      const rings = ringsByCategory[category];
      if (geom.type === 'way' && geom.coordinates.length > 2) {
        rings.push(geom.coordinates.map(pt => [pt.lat, pt.lon]));
      } else if (geom.type === 'relation' && geom.outerWays) {
        geom.outerWays.forEach(way => {
          rings.push(way.coordinates.map(pt => [pt.lat, pt.lon]));
        });
      }
    });

    for (const category of Object.keys(ringsByCategory)) {
      const rings = ringsByCategory[category];
      if (rings.length === 0) continue;
      const poly = L.polygon(rings, STYLES[category]).addTo(this.map);
      this.osmLayers.push(poly);
    }
  },

  clearOsmShapes() {
    if (this.osmLayers) {
      this.osmLayers.forEach(layer => this.map.removeLayer(layer));
    }
    this.osmLayers = [];
  }

});
