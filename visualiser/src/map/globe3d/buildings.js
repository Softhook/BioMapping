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
  /** Per-style fill colour for the extruded OSM footprints. */
  fillColor(style) {
    switch (style) {
      case 'dark':       return Cesium.Color.fromCssColorString('#242833');
      case 'monochrome': return Cesium.Color.fromCssColorString('#e4e7ee');
      case 'glass':      return Cesium.Color.fromCssColorString('#00d4ff').withAlpha(0.35);
      default:           return Cesium.Color.fromCssColorString('#cfc4b4'); // realistic
    }
  },

  /** Cesium3DTileStyle colour expression for the ion-tiles fallback path. */
  tileStyleExpression(style) {
    switch (style) {
      case 'dark':       return "color('#1c202a', 1.0)";
      case 'monochrome': return "color('#f0f2f6', 1.0)";
      case 'glass':      return "color('rgba(52, 100, 138, 0.45)')";
      default:           return "color('#d6cdc0', 1.0)"; // realistic
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
   * @returns {object|null} a batched Cesium.Primitive, or null if no footprints
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

    const fillColor = this.fillColor(style);
    const isTranslucent = (style === 'glass');
    const instances = [];

    for (let i = 0; i < buildingWays.length; i++) {
      const way = buildingWays[i];
      const degreesArray = [];
      for (const pt of way.coordinates) degreesArray.push(pt.lon, pt.lat);

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
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GSRGlobe3DBuildings };
}
if (typeof window !== 'undefined') {
  window.GSRGlobe3DBuildings = GSRGlobe3DBuildings;
}
