/**
 * BioMapping 2.0 — 3D Volumetric RF Expanse
 * Copyright (c) 2026 Christian Nold
 * Licensed under the Bio Mapping Community Licence 1.0.
 *
 * Builds the street-filling "electromagnetic fluid" — the track resampled to an
 * even pitch and laid with wide, low, overlapping slugs that merge into one
 * continuous glowing corridor, coloured by band intensity. Pure geometry:
 * buildPrimitive() returns one Cesium.Primitive (or null); GSRGlobeManager owns
 * adding/removing it from the scene. Extracted from globe3d.js to keep the core
 * class focused on the arousal wall + camera.
 */

const GSRGlobe3DRf = {
  /**
   * Target along-track spacing between slugs, in metres. The track is
   * resampled to this pitch (by arc length, so walking speed and GPS
   * cadence don't matter), and each slug below is sized wider than it — so
   * consecutive slugs overlap into one continuous fluid corridor rather
   * than a string of separate domes. The 3D analogue of the 2D fluid ribbon.
   */
  SLUG_SPACING_M: 6.0,
  /** Hard cap on slug count — a long track widens the spacing to stay under it. */
  MAX_SLUGS: 400,
  /** Horizontal radius as a multiple of spacing (>1 → neighbours interpenetrate). */
  SLUG_OVERLAP: 1.9,

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
    // Per-band "is there a real signal here" flags — set from the measured
    // dBm spread below. Default true so the synthetic-field path (no radio
    // hardware in the file) is left exactly as it was.
    let active815 = true, active868 = true, active915 = true;

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
      // Squelch, mirroring RFFluidRenderer._calculateRssiStats(): a band
      // only counts as "active" if its peak clears the -90 dBm hardware
      // noise floor AND spans at least 3 dB. Without this the raw min/max
      // stretch below blows 1-2 dB of noise-floor jitter up to full
      // intensity and paints a dead band solid (e.g. 915 MHz on a track
      // with no 915 source) — where the 2D overlay correctly draws
      // nothing. Read the real extremes here, before the degenerate-range
      // fallback on the next lines overwrites them.
      active815 = bandHasActiveSignal(min815, max815);
      active868 = bandHasActiveSignal(min868, max868);
      active915 = bandHasActiveSignal(min915, max915);
      if (!isFinite(min815) || !isFinite(max815) || min815 >= max815) { min815 = -92.0; max815 = -50.0; }
      if (!isFinite(min868) || !isFinite(max868) || min868 >= max868) { min868 = -92.0; max868 = -50.0; }
      if (!isFinite(min915) || !isFinite(max915) || min915 >= max915) { min915 = -92.0; max915 = -50.0; }
      if (!isFinite(minFog) || !isFinite(maxFog) || minFog >= maxFog) { minFog = 0.0; maxFog = 100.0; }
    }

    // A single-band mode over a squelched band has nothing to show — same
    // as the 2D overlay, which renders an empty layer in that case.
    if (hasMeasuredRf) {
      if (mode === '815' && !active815) return null;
      if (mode === '868' && !active868) return null;
      if (mode === '915' && !active915) return null;
    }

    // 2. Resample the track by arc length onto an even pitch, so slugs are
    //    spaced by distance walked rather than by GPS sample index (a pause
    //    would otherwise pile slugs up in one spot and thin them out
    //    elsewhere).
    const cum = [0];
    for (let i = 1; i < rfPoints.length; i++) {
      cum[i] = cum[i - 1] + haversineM(
        rfPoints[i - 1].lat, rfPoints[i - 1].lon, rfPoints[i].lat, rfPoints[i].lon);
    }
    const totalLen = cum[cum.length - 1];

    let spacing = this.SLUG_SPACING_M;
    let count = Math.floor(totalLen / spacing) + 1;
    if (count > this.MAX_SLUGS) { count = this.MAX_SLUGS; spacing = totalLen / (count - 1); }
    if (count < 2) count = Math.min(rfPoints.length, 2);

    const instances = [];
    let seg = 0; // monotonic cursor into cum[]

    for (let k = 0; k < count; k++) {
      const target = Math.min(k * spacing, totalLen);
      while (seg < rfPoints.length - 2 && cum[seg + 1] < target) seg++;
      const segLen = cum[seg + 1] - cum[seg];
      const f = segLen > 0 ? clamp01((target - cum[seg]) / segLen) : 0;
      const p0 = rfPoints[seg];
      const p1 = rfPoints[seg + 1] || p0;

      const lat = p0.lat + (p1.lat - p0.lat) * f;
      const lon = p0.lon + (p1.lon - p0.lon) * f;
      const v815 = lerpRf(p0.r815, p1.r815, f);
      const v868 = lerpRf(p0.r868, p1.r868, f);
      const v915 = lerpRf(p0.r915, p1.r915, f);
      const vFog = lerpRf(p0.fog,  p1.fog,  f);

      const norm815 = hasMeasuredRf ? normDbm(v815, min815, max815, active815) : clamp01(v815 ?? 0);
      const norm868 = hasMeasuredRf ? normDbm(v868, min868, max868, active868) : clamp01(v868 ?? 0);
      const norm915 = hasMeasuredRf ? normDbm(v915, min915, max915, active915) : clamp01(v915 ?? 0);
      const normFog = clamp01(hasMeasuredRf
        ? (((vFog ?? minFog) - minFog) / (maxFog - minFog)) : (vFog ?? 0));

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
        intensity = Math.max(norm815, norm868, norm915);
      } else if (mode === '815') {
        r = 1.0; g = 0.0; b = 0.0;
        intensity = norm815;
      } else if (mode === '868') {
        r = 0.0; g = 1.0; b = 0.0;
        intensity = norm868;
      } else if (mode === '915') {
        r = 0.0; g = 0.0; b = 1.0;
        intensity = norm915;
      } else {
        r = normFog; g = 0.0; b = 1.0 - normFog;
        intensity = Math.max(0.2, normFog);
      }

      // Nothing above the noise floor at this point (RSSI modes only —
      // EM-fog keeps its ambient floor): no slug, matching the 2D overlay.
      if (hasMeasuredRf && mode !== 'fog' && intensity <= 0.0) continue;

      // Wide + low: horizontal radius is a multiple of the spacing so
      // neighbours merge into a sheet; a hot spot swells it further and
      // lifts the volumetric ceiling. Vertical radius stays modest so the
      // fluid hugs the street the way the 2D overlay does.
      const horiz = spacing * this.SLUG_OVERLAP * (0.75 + 0.45 * intensity);
      const vert  = 4.0 + (baseCeiling - 4.0) * intensity;

      try {
        instances.push(new Cesium.GeometryInstance({
          geometry: new Cesium.EllipsoidGeometry({
            radii: new Cesium.Cartesian3(horiz, horiz, vert),
            // Modest tessellation: the slugs blur together, so a smooth
            // 64×64 sphere (Cesium's default) would be wasted triangles.
            stackPartitions: 12,
            slicePartitions: 12,
            vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT
          }),
          modelMatrix: Cesium.Transforms.eastNorthUpToFixedFrame(
            Cesium.Cartesian3.fromDegrees(lon, lat, 0.0)
          ),
          attributes: {
            color: Cesium.ColorGeometryInstanceAttribute.fromColor(
              new Cesium.Color(r, g, b, opacity * (0.34 + 0.5 * intensity)))
          },
          id: `rf-slug-${k}`
        }));
      } catch (err) {
        // Skip a geometry error cleanly.
      }
    }

    if (instances.length === 0) return null;

    return new Cesium.Primitive({
      geometryInstances: instances,
      appearance: new Cesium.PerInstanceColorAppearance({ translucent: true, closed: true }),
      asynchronous: true
    });
  }
};

function clamp01(v) { return Math.max(0.0, Math.min(1.0, v)); }

/** Great-circle distance in metres between two lat/lon points. */
function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * Linear-interpolate an RF reading across a resampled segment. A null (band
 * absent at an endpoint) falls back to the other endpoint; both null -> null,
 * so the band simply contributes nothing at that slug.
 */
function lerpRf(x, y, f) {
  const xn = (x === null || x === undefined || isNaN(x));
  const yn = (y === null || y === undefined || isNaN(y));
  if (xn && yn) return null;
  if (xn) return y;
  if (yn) return x;
  return x + (y - x) * f;
}

/**
 * Mirrors RFFluidRenderer._calculateRssiStats()'s active-signal test: the
 * band peak must clear the -90 dBm hardware noise floor AND the band must
 * span at least 3 dB. `mn`/`mx` are the raw per-band RSSI extremes in dBm.
 */
function bandHasActiveSignal(mn, mx) {
  return isFinite(mn) && isFinite(mx) && (mx > -90.0) && ((mx - mn) >= 3.0);
}

/**
 * Mirrors RFFluidRenderer._normDbm(): 0 for an inactive band or any sample
 * at/below the local threshold (the greater of -90 dBm and floor + 3 dB);
 * a gamma-boosted 0..1 ramp from there up to the band peak. Keeps the 3D
 * expanse and the 2D overlay squelching identical data identically.
 */
function normDbm(val, mn, mx, active) {
  if (val === null || val === undefined || isNaN(val) || !active) return 0.0;
  const threshold = Math.max(-90.0, mn + 3.0);
  if (val <= threshold) return 0.0;
  const activeRange = Math.max(5.0, mx - threshold);
  const norm = clamp01((val - threshold) / activeRange);
  return clamp01(Math.pow(norm, 0.75) * 1.15);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GSRGlobe3DRf };
}
if (typeof window !== 'undefined') {
  window.GSRGlobe3DRf = GSRGlobe3DRf;
}
