/**
 * BioMapping 2.0 — 3D Volumetric RF Expanse
 * Copyright (c) 2026 Christian Nold
 * Licensed under the Bio Mapping Community Licence 1.0.
 *
 * Builds the street-filling "electromagnetic fluid" — a batch of glowing
 * semi-dome slugs along the track, coloured by band intensity. Pure geometry:
 * buildPrimitive() returns one Cesium.Primitive (or null); GSRGlobeManager owns
 * adding/removing it from the scene. Extracted from globe3d.js to keep the core
 * class focused on the arousal wall + camera.
 */

const GSRGlobe3DRf = {
  /** How many slugs to lay down along the track, regardless of point count. */
  SLUG_COUNT: 50,

  /**
   * @param {object} analyzer    analysed track (needs .raw with rssi_* / em_fog)
   * @param {Array}  drawPoints   display points ({lat, lon, origIdx})
   * @param {object} [opts]
   * @param {'triband'|'815'|'868'|'915'|'fog'} [opts.mode='triband']
   * @param {number} [opts.height=25]    volumetric ceiling in metres
   * @param {number} [opts.opacity=0.45]
   * @returns {object|null} a Cesium.Primitive, or null if there's nothing to draw
   */
  buildPrimitive(analyzer, drawPoints, opts = {}) {
    if (typeof Cesium === 'undefined') return null;
    if (!analyzer || !drawPoints || drawPoints.length === 0) return null;
    const raw = analyzer.raw || [];
    if (raw.length === 0) return null;

    const mode = opts.mode || 'triband';
    const baseCeiling = opts.height || 25.0;
    const opacity = opts.opacity || 0.45;

    // 1. Gather points that have GPS + inspect RSSI / EM-fog data.
    const rfPoints = [];
    let min815 = Infinity, max815 = -Infinity;
    let min868 = Infinity, max868 = -Infinity;
    let min915 = Infinity, max915 = -Infinity;
    let minFog = Infinity, maxFog = -Infinity;

    for (let i = 0; i < drawPoints.length; i++) {
      const pt = drawPoints[i];
      if (!pt || isNaN(pt.lat) || isNaN(pt.lon)) continue;

      const rawRow = raw[pt.origIdx] || {};
      const r815 = rawRow.rssi_815 ?? rawRow.r815 ?? rawRow.r_815;
      const r868 = rawRow.rssi_868 ?? rawRow.r868 ?? rawRow.r_868;
      const r915 = rawRow.rssi_915 ?? rawRow.r915 ?? rawRow.r_915;
      const fog  = rawRow.em_fog ?? rawRow.emFog ?? rawRow.fog;

      const has815 = (r815 !== undefined && !isNaN(r815));
      const has868 = (r868 !== undefined && !isNaN(r868));
      const has915 = (r915 !== undefined && !isNaN(r915));
      const hasFog = (fog !== undefined && !isNaN(fog));

      if (has815) { if (r815 < min815) min815 = r815; if (r815 > max815) max815 = r815; }
      if (has868) { if (r868 < min868) min868 = r868; if (r868 > max868) max868 = r868; }
      if (has915) { if (r915 < min915) min915 = r915; if (r915 > max915) max915 = r915; }
      if (hasFog) { if (fog < minFog) minFog = fog; if (fog > maxFog) maxFog = fog; }

      rfPoints.push({
        lat: pt.lat, lon: pt.lon, origIdx: pt.origIdx,
        r815: has815 ? r815 : null,
        r868: has868 ? r868 : null,
        r915: has915 ? r915 : null,
        fog: hasFog ? fog : null,
        hasRf: (has815 || has868 || has915 || hasFog)
      });
    }

    if (rfPoints.length === 0) return null;

    const hasMeasuredRf = rfPoints.some((p) => p.hasRf);

    // No hardware radio chips in this dataset -> synthesise an ambient field.
    if (!hasMeasuredRf) {
      min815 = 0; max815 = 1; min868 = 0; max868 = 1;
      min915 = 0; max915 = 1; minFog = 0; maxFog = 1;
      for (let i = 0; i < rfPoints.length; i++) {
        const frac = i / Math.max(1, rfPoints.length - 1);
        rfPoints[i].r815 = 0.35 + 0.65 * Math.sin(frac * Math.PI * 4);
        rfPoints[i].r868 = 0.35 + 0.65 * Math.sin(frac * Math.PI * 3 + 1.2);
        rfPoints[i].r915 = 0.35 + 0.65 * Math.cos(frac * Math.PI * 5 + 0.5);
        rfPoints[i].fog  = 0.3 + 0.7 * Math.sin(frac * Math.PI * 2);
      }
    } else {
      if (!isFinite(min815) || !isFinite(max815) || min815 >= max815) { min815 = -92.0; max815 = -50.0; }
      if (!isFinite(min868) || !isFinite(max868) || min868 >= max868) { min868 = -92.0; max868 = -50.0; }
      if (!isFinite(min915) || !isFinite(max915) || min915 >= max915) { min915 = -92.0; max915 = -50.0; }
      if (!isFinite(minFog) || !isFinite(maxFog) || minFog >= maxFog) { minFog = 0.0; maxFog = 100.0; }
    }

    const instances = [];
    const sampleStep = Math.max(1, Math.floor(rfPoints.length / this.SLUG_COUNT));

    for (let i = 0; i < rfPoints.length; i += sampleStep) {
      const pt = rfPoints[i];

      const norm815 = clamp01(hasMeasuredRf ? ((pt.r815 - min815) / (max815 - min815)) : pt.r815);
      const norm868 = clamp01(hasMeasuredRf ? ((pt.r868 - min868) / (max868 - min868)) : pt.r868);
      const norm915 = clamp01(hasMeasuredRf ? ((pt.r915 - min915) / (max915 - min915)) : pt.r915);
      const normFog = clamp01(hasMeasuredRf ? ((pt.fog - minFog) / (maxFog - minFog)) : pt.fog);

      // Colour channels match the 2D RF fluid overlay exactly
      // (RFFluidRenderer.redraw()): 815 MHz = pure red, 868 MHz = pure green,
      // 915 MHz = pure blue, tri-band = additive RGB, EM-fog = red<->blue by
      // fog level. Visibility of a weak slug comes from the `intensity`-scaled
      // alpha below (the 3D analogue of the 2D alpha ramp), not from tinting
      // the colour, so the same data reads as the same hue on both surfaces.
      let r = 0, g = 0, b = 0, intensity = 0;
      if (mode === 'triband') {
        r = norm815;
        g = norm868;
        b = norm915;
        intensity = Math.max(norm815, norm868, norm915, 0.25);
      } else if (mode === '815') {
        r = 1.0; g = 0.0; b = 0.0;
        intensity = Math.max(0.2, norm815);
      } else if (mode === '868') {
        r = 0.0; g = 1.0; b = 0.0;
        intensity = Math.max(0.2, norm868);
      } else if (mode === '915') {
        r = 0.0; g = 0.0; b = 1.0;
        intensity = Math.max(0.2, norm915);
      } else {
        r = normFog; g = 0.0; b = 1.0 - normFog;
        intensity = Math.max(0.2, normFog);
      }

      const domeRadius = 24.0 + 32.0 * intensity;
      const domeHeight = 8.0 + (baseCeiling - 8.0) * intensity;

      try {
        instances.push(new Cesium.GeometryInstance({
          geometry: new Cesium.EllipsoidGeometry({
            radii: new Cesium.Cartesian3(domeRadius, domeRadius, domeHeight),
            vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT
          }),
          modelMatrix: Cesium.Transforms.eastNorthUpToFixedFrame(
            Cesium.Cartesian3.fromDegrees(pt.lon, pt.lat, 0.0)
          ),
          attributes: {
            color: Cesium.ColorGeometryInstanceAttribute.fromColor(
              new Cesium.Color(r, g, b, opacity * (0.45 + 0.55 * intensity)))
          },
          id: `rf-slug-${i}`
        }));
      } catch (err) {
        // Skip a geometry error cleanly.
      }
    }

    if (instances.length === 0) return null;

    return new Cesium.Primitive({
      geometryInstances: instances,
      appearance: new Cesium.PerInstanceColorAppearance({ translucent: true, closed: true }),
      asynchronous: false
    });
  }
};

function clamp01(v) { return Math.max(0.0, Math.min(1.0, v)); }

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GSRGlobe3DRf };
}
if (typeof window !== 'undefined') {
  window.GSRGlobe3DRf = GSRGlobe3DRf;
}
