/**
 * BioMapping 2.0 — 3D OSM buildings
 * Copyright (c) 2026 Christian Nold
 * Licensed under the Bio Mapping Community Licence 1.0.
 *
 * Extrudes raw OpenStreetMap Overpass building footprints into one batched GPU
 * primitive (token-free — no Cesium ion account). Pure geometry:
 * buildPrimitive() returns a Cesium.Primitive (or null); GSRGlobeManager owns
 * the fetch orchestration, the ion-tiles fallback, and the scene lifecycle.
 */

const GSRGlobe3DBuildings = {
  /** Per-style default fill colour for extruded OSM footprints. */
  fillColor(style) {
    switch (style) {
      case 'dark':       return Cesium.Color.fromCssColorString('#242833');
      case 'monochrome': return Cesium.Color.fromCssColorString('#e4e7ee');
      case 'glass':      return Cesium.Color.fromCssColorString('#00d4ff').withAlpha(0.35);
      default:           return Cesium.Color.fromCssColorString('#ded7cb'); // realistic wall base
    }
  },

  /** Facade wall colour for realistic style based on building metadata. */
  wallColorFor(tags) {
    if (tags && (tags['building:colour'] || tags['building:color'])) {
      try {
        const c = Cesium.Color.fromCssColorString(tags['building:colour'] || tags['building:color']);
        if (c) return c;
      } catch (e) { /* ignore invalid CSS color */ }
    }
    const bType = tags && tags.building;
    if (bType === 'commercial' || bType === 'office' || bType === 'retail' || bType === 'civic' || bType === 'public') {
      return Cesium.Color.fromCssColorString('#d6dbe0'); // cool modern limestone/concrete
    }
    if (bType === 'residential' || bType === 'house' || bType === 'terrace' || bType === 'apartments' || bType === 'detached' || bType === 'semi') {
      return Cesium.Color.fromCssColorString('#dfd6c8'); // warm stucco/stone
    }
    if (bType === 'industrial' || bType === 'warehouse' || bType === 'garage' || bType === 'shed') {
      return Cesium.Color.fromCssColorString('#d0c9bd'); // muted industrial tone
    }
    return Cesium.Color.fromCssColorString('#ded7cb'); // default warm architectural limestone
  },

  /** Roof cap colour for realistic style based on building metadata. */
  roofColorFor(tags) {
    if (tags && (tags['roof:colour'] || tags['roof:color'])) {
      try {
        const c = Cesium.Color.fromCssColorString(tags['roof:colour'] || tags['roof:color']);
        if (c) return c;
      } catch (e) { /* ignore invalid CSS color */ }
    }
    const bType = tags && tags.building;
    // Residential / living -> warm terracotta clay cap
    if (bType === 'residential' || bType === 'house' || bType === 'terrace' || bType === 'apartments' || bType === 'detached' || bType === 'semi' || bType === 'cottage') {
      return Cesium.Color.fromCssColorString('#a35242');
    }
    // Commercial / civic / institutional -> dark zinc / slate charcoal cap
    if (bType === 'commercial' || bType === 'office' || bType === 'retail' || bType === 'civic' || bType === 'public' || bType === 'school' || bType === 'university' || bType === 'hotel') {
      return Cesium.Color.fromCssColorString('#373d47');
    }
    // Utility / industrial / shed / garage -> weathered dark graphite / bronze
    if (bType === 'industrial' || bType === 'warehouse' || bType === 'garage' || bType === 'shed') {
      return Cesium.Color.fromCssColorString('#48443e');
    }
    // Default building cap -> dark architectural matte cap
    return Cesium.Color.fromCssColorString('#46423d');
  },

  /** Roof edge outline colour for crisp silhouette definition. */
  outlineColorFor(style) {
    switch (style) {
      case 'dark':       return Cesium.Color.fromCssColorString('#101216').withAlpha(0.8);
      case 'monochrome': return Cesium.Color.fromCssColorString('#9ba1ac').withAlpha(0.6);
      case 'glass':      return Cesium.Color.fromCssColorString('#00ffff').withAlpha(0.7);
      default:           return Cesium.Color.fromCssColorString('#262320').withAlpha(0.75); // realistic dark edge
    }
  },

  /** Cesium3DTileStyle colour expression for the ion-tiles fallback path. */
  tileStyleExpression(style) {
    switch (style) {
      case 'dark':       return "color('#1c202a', 1.0)";
      case 'monochrome': return "color('#f0f2f6', 1.0)";
      case 'glass':      return "color('rgba(52, 100, 138, 0.45)')";
      default:           return "Boolean(${building} === 'residential' || ${building} === 'house' || ${building} === 'apartments') ? color('#b56958') : Boolean(${building} === 'commercial' || ${building} === 'office' || ${building} === 'retail') ? color('#8d9ba8') : Boolean(${height} > 25) ? color('#b0bac6') : color('#ded7cb')";
    }
  },

  /** Rough building height (m) from OSM tags, with sensible per-type defaults. */
  heightFor(tags) {
    if (tags.height) {
      const h = parseFloat(tags.height);
      if (!isNaN(h) && h > 0) return h;
    }
    if (tags['building:levels']) {
      const lvls = parseFloat(tags['building:levels']);
      if (!isNaN(lvls) && lvls > 0) return lvls * 3.5;
    }
    if (tags.building === 'commercial' || tags.building === 'apartments' || tags.building === 'office') return 16.0;
    if (tags.building === 'shed' || tags.building === 'garage') return 4.0;
    return 9.0; // ~3 storeys
  },

  /**
   * @param {object} osmJson  raw Overpass response ({ elements: [...] })
   * @param {'glass'|'dark'|'monochrome'|'realistic'} [style='glass']
   * @returns {object|null} a batched Cesium.Primitive or Cesium.PrimitiveCollection, or null if no footprints
   */
  buildPrimitive(osmJson, style = 'glass') {
    if (typeof Cesium === 'undefined' || !osmJson || !osmJson.elements) return null;

    const nodeMap = new Map();
    for (const el of osmJson.elements) {
      if (el.type === 'node') nodeMap.set(el.id, { lat: el.lat, lon: el.lon });
    }

    const buildingWays = [];
    for (const el of osmJson.elements) {
      if (el.type === 'way' && el.tags && el.tags.building) {
        const coords = [];
        for (const nid of el.nodes) {
          const pt = nodeMap.get(nid);
          if (pt) coords.push(pt);
        }
        if (coords.length >= 3) { el.coordinates = coords; buildingWays.push(el); }
      }
    }
    if (buildingWays.length === 0) return null;

    const isRealistic = (style === 'realistic');
    const isTranslucent = (style === 'glass');

    // For monochrome, dark, and glass: single batched primitive of extruded footprints (preserving white/glass)
    if (!isRealistic) {
      const fillColor = this.fillColor(style);
      const instances = [];

      for (let i = 0; i < buildingWays.length; i++) {
        const way = buildingWays[i];
        const coords = way.coordinates;
        const cleanCoords = coords.slice();
        if (cleanCoords.length > 3) {
          const first = cleanCoords[0];
          const last = cleanCoords[cleanCoords.length - 1];
          if (Math.abs(first.lat - last.lat) < 1e-9 && Math.abs(first.lon - last.lon) < 1e-9) {
            cleanCoords.pop();
          }
        }
        const degreesArray = [];
        for (const pt of cleanCoords) degreesArray.push(pt.lon, pt.lat);

        try {
          instances.push(new Cesium.GeometryInstance({
            geometry: new Cesium.PolygonGeometry({
              polygonHierarchy: new Cesium.PolygonHierarchy(
                Cesium.Cartesian3.fromDegreesArray(degreesArray)
              ),
              height: 0.0,
              extrudedHeight: this.heightFor(way.tags),
              vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT
            }),
            attributes: {
              color: Cesium.ColorGeometryInstanceAttribute.fromColor(fillColor)
            },
            id: `osm-building-${i}`
          }));
        } catch (err) {
          // Skip an invalid / degenerate polygon cleanly.
        }
      }
      if (instances.length === 0) return null;

      return new Cesium.Primitive({
        geometryInstances: instances,
        appearance: new Cesium.PerInstanceColorAppearance({ translucent: isTranslucent, closed: true }),
        asynchronous: true
      });
    }

    // Realistic procedural architectural style (Option B):
    // 1. Solid extruded facade walls & body (PolygonGeometry extruded - 100% solid on all sides)
    // 2. Contrasting roof top caps (PolygonGeometry with terracotta/slate roof tone)
    // 3. Roof edge outline silhouettes (PolygonOutlineGeometry)
    const surfaceInstances = [];
    const outlineInstances = [];
    const outlineColor = this.outlineColorFor('realistic');

    for (let i = 0; i < buildingWays.length; i++) {
      const way = buildingWays[i];
      const coords = way.coordinates;
      const height = this.heightFor(way.tags);
      const wallColor = this.wallColorFor(way.tags);
      const roofColor = this.roofColorFor(way.tags);

      // Clean polygon vertices: remove trailing duplicate if present
      const cleanCoords = coords.slice();
      if (cleanCoords.length > 3) {
        const first = cleanCoords[0];
        const last = cleanCoords[cleanCoords.length - 1];
        if (Math.abs(first.lat - last.lat) < 1e-9 && Math.abs(first.lon - last.lon) < 1e-9) {
          cleanCoords.pop();
        }
      }

      const degreesArray = [];
      for (const pt of cleanCoords) degreesArray.push(pt.lon, pt.lat);

      // 1. Fully solid, closed extruded building body (same rock-solid geometry as monochrome white model)
      try {
        surfaceInstances.push(new Cesium.GeometryInstance({
          geometry: new Cesium.PolygonGeometry({
            polygonHierarchy: new Cesium.PolygonHierarchy(
              Cesium.Cartesian3.fromDegreesArray(degreesArray)
            ),
            height: 0.0,
            extrudedHeight: height,
            vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT
          }),
          attributes: {
            color: Cesium.ColorGeometryInstanceAttribute.fromColor(wallColor)
          },
          id: `osm-building-body-${i}`
        }));
      } catch (err) {
        // Skip body if geometry fails
      }

      // 2. Contrasting roof top cap sitting cleanly on top (offset by 5cm to prevent coplanar z-fighting)
      try {
        surfaceInstances.push(new Cesium.GeometryInstance({
          geometry: new Cesium.PolygonGeometry({
            polygonHierarchy: new Cesium.PolygonHierarchy(
              Cesium.Cartesian3.fromDegreesArray(degreesArray)
            ),
            height: height + 0.05,
            vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT
          }),
          attributes: {
            color: Cesium.ColorGeometryInstanceAttribute.fromColor(roofColor)
          },
          id: `osm-building-roof-${i}`
        }));
      } catch (err) {
        // Skip roof if geometry fails
      }

      // 3. Roof edge outline silhouette (offset by 8cm)
      try {
        if (typeof Cesium.PolygonOutlineGeometry === 'function') {
          outlineInstances.push(new Cesium.GeometryInstance({
            geometry: new Cesium.PolygonOutlineGeometry({
              polygonHierarchy: new Cesium.PolygonHierarchy(
                Cesium.Cartesian3.fromDegreesArray(degreesArray)
              ),
              height: height + 0.08
            }),
            attributes: {
              color: Cesium.ColorGeometryInstanceAttribute.fromColor(outlineColor)
            },
            id: `osm-building-outline-${i}`
          }));
        }
      } catch (err) {
        // Skip outline if geometry fails
      }
    }

    if (surfaceInstances.length === 0) return null;

    const surfacePrimitive = new Cesium.Primitive({
      geometryInstances: surfaceInstances,
      appearance: new Cesium.PerInstanceColorAppearance({ closed: true, translucent: false }),
      asynchronous: true
    });

    if (outlineInstances.length > 0 && typeof Cesium.PrimitiveCollection === 'function') {
      const outlinePrimitive = new Cesium.Primitive({
        geometryInstances: outlineInstances,
        appearance: new Cesium.PerInstanceColorAppearance({ flat: true, translucent: true }),
        asynchronous: true
      });
      const collection = new Cesium.PrimitiveCollection();
      collection.add(surfacePrimitive);
      collection.add(outlinePrimitive);
      return collection;
    }

    return surfacePrimitive;
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GSRGlobe3DBuildings };
}
if (typeof window !== 'undefined') {
  window.GSRGlobe3DBuildings = GSRGlobe3DBuildings;
}
