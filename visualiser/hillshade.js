/**
 * Grayscale relief shading (hillshade) for a scalar grid surface, plus the
 * small shared value->ratio and ratio->lightness math the shading needs to
 * consume/produce — kept here rather than duplicated at each call site (see
 * each method's doc for why). Zero hard dependencies: anything another
 * module would normally own (percentile ranking) is taken as an injected
 * function parameter instead of imported, mirroring marching_squares.js.
 *
 * Core algorithm: Horn's method slope/aspect estimate + Lambertian
 * reflectance against a simulated sun — the same one GIS tools use for DEM
 * relief shading — applied here to collective_manager.js's interpolated
 * arousal/phasic/tonic grid, which is already the same shape as a DEM: a
 * regular raster of scalar "height" values.
 */
class Hillshade {
  /**
   * @param {Array<Array<number|null>>} grid  rows x cols, null = masked/no data
   * @param {number} rows
   * @param {number} cols
   * @param {number} cellSizeX  physical spacing between columns (same units as cellSizeY)
   * @param {number} cellSizeY  physical spacing between rows
   * @param {{azimuthDeg?: number, altitudeDeg?: number, zFactor?: number}} [options]
   * @returns {Float32Array} rows*cols shade values in [0, 1] — 0 = fully shadowed,
   *          1 = facing the sun directly. Masked cells are left at 0 (callers
   *          already skip drawing those cells based on the grid itself).
   */
  static compute(grid, rows, cols, cellSizeX, cellSizeY, options) {
    const opts = options || {};
    const azimuthDegTrue = opts.azimuthDeg !== undefined ? opts.azimuthDeg : 315;
    // `aspect` below is computed as atan2(dzdy, -dzdx), which comes out in a
    // raw mathematical angle convention, NOT true compass bearing — a slope
    // whose real downhill direction is compass bearing B evaluates to raw
    // angle (90 - B). Applying that same (90 - x) conversion to the input
    // azimuth here is what makes `azimuthDeg` a genuine true compass bearing
    // for callers (0=N, 90=E, 180=S, 270=W, clockwise), matching what
    // HILLSHADE.azimuthDeg's own comment in constants.js promises. Verified
    // against known-aspect synthetic ramps — see the calibration test in
    // tests/test_hillshade.js. Getting this wrong doesn't break the shading
    // math (slope/contrast are unaffected), it just aims the simulated sun
    // in the wrong screen direction.
    const azimuthRad = ((90 - azimuthDegTrue) * Math.PI) / 180;
    const altitudeRad = ((opts.altitudeDeg !== undefined ? opts.altitudeDeg : 45) * Math.PI) / 180;
    const zFactor = opts.zFactor !== undefined ? opts.zFactor : 1;
    const cx = cellSizeX > 0 ? cellSizeX : 1;
    const cy = cellSizeY > 0 ? cellSizeY : 1;

    const cosAlt = Math.cos(altitudeRad);
    const sinAlt = Math.sin(altitudeRad);
    const shade = new Float32Array(rows * cols);

    // 3x3 Horn's-method neighborhood lookup, hoisted OUTSIDE the per-cell
    // loop (was previously redefined as a fresh closure on every one of the
    // rows*cols iterations — 40,000 throwaway closures at a 200x200 grid).
    // `fallback` is passed explicitly instead of captured, so this closure
    // only needs to close over rows/cols/grid, which don't change per cell.
    // Off-grid or masked neighbors fall back to the cell's own value (flat
    // extrapolation) instead of branching the stencil — matches how DEM
    // hillshade tools treat nodata edges/holes, and keeps corridor-boundary
    // cells from reading a spurious cliff against the surrounding null mask.
    const at = (rr, cc, fallback) => {
      if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) return fallback;
      const vv = grid[rr][cc];
      return (vv === null || vv === undefined || isNaN(vv)) ? fallback : vv;
    };

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const v = grid[r][c];
        if (v === null || v === undefined || isNaN(v)) continue;

        // Compass-named per this codebase's grid convention (collective_manager.js
        // gridLatOf(r) = minLat + r/(rows-1)*(maxLat-minLat)): row increases
        // northward, so row r-1 is the southern neighbor and r+1 the northern one.
        const sw = at(r - 1, c - 1, v), s = at(r - 1, c, v), se = at(r - 1, c + 1, v);
        const w  = at(r, c - 1, v),                            e  = at(r, c + 1, v);
        const nw = at(r + 1, c - 1, v), n = at(r + 1, c, v), ne = at(r + 1, c + 1, v);

        const dzdx = ((se + 2 * e + ne) - (sw + 2 * w + nw)) / (8 * cx);
        const dzdy = ((sw + 2 * s + se) - (nw + 2 * n + ne)) / (8 * cy);

        const slope = Math.atan(zFactor * Math.sqrt(dzdx * dzdx + dzdy * dzdy));
        let aspect = Math.atan2(dzdy, -dzdx);
        if (aspect < 0) aspect += 2 * Math.PI;

        const hs = cosAlt * Math.cos(slope) + sinAlt * Math.sin(slope) * Math.cos(azimuthRad - aspect);
        shade[r * cols + c] = hs > 0 ? hs : 0;
      }
    }
    return shade;
  }

  /**
   * Canonical single-cell "raw value -> [0,1] display ratio" formula:
   * percentile rank when a sorted reference distribution is available,
   * linear min/max otherwise. This is the SAME ratio a caller's color fill
   * uses (see map.js renderContours()'s comment on why percentile rank, not
   * linear value, is the right basis for both color AND the hillshade
   * "height" field: shading a different function of the data than the one
   * being colored/contoured means the relief doesn't track what's drawn).
   * Extracted so it exists in exactly one place — this file previously had
   * four independent hand-copies of this formula across map.js and
   * map_exporter.js, including one the exporter computed and then never
   * used (see buildRatioGrid's callers).
   *
   * @param {number} v
   * @param {number} minVal
   * @param {number} maxVal
   * @param {number[]} [sortedVals]  ascending; enables percentile ranking when length > 1
   * @param {(v:number, sorted:number[]) => number} [rankFn]  e.g. StatsMath.percentileRank
   * @returns {number} ratio in [0, 1]
   */
  static valueRatio(v, minVal, maxVal, sortedVals, rankFn) {
    if (sortedVals && sortedVals.length > 1 && typeof rankFn === 'function') {
      return rankFn(v, sortedVals);
    }
    const valRange = maxVal - minVal;
    return valRange > 1e-9 ? (v - minVal) / valRange : 0.5;
  }

  /**
   * valueRatio() applied over an entire grid, preserving null/NaN cells as
   * null (masked/no-data — same convention the source grid uses).
   *
   * @param {Array<Array<number|null>>} grid
   * @param {number} rows
   * @param {number} cols
   * @param {{minVal:number, maxVal:number, sortedVals?:number[], rankFn?: Function}} config
   * @returns {(number|null)[][]}
   */
  static buildRatioGrid(grid, rows, cols, config) {
    const { minVal, maxVal, sortedVals, rankFn } = config;
    return grid.map(row => row.map(v =>
      (v === null || v === undefined || isNaN(v)) ? null : Hillshade.valueRatio(v, minVal, maxVal, sortedVals, rankFn)
    ));
  }

  /**
   * Turns a raw value grid into a shaded relief in one call: builds the
   * ratio grid (buildRatioGrid) and hillshades it directly — the ratio grid
   * IS the height field, scaled via compute()'s zFactor rather than by
   * pre-multiplying a separate array (mathematically identical: scaling
   * every height by a constant k before computing slope/aspect is the same
   * as computing slope/aspect unscaled and passing zFactor=k, since slope's
   * magnitude scales linearly with k and aspect — a ratio of the same two
   * scaled quantities — is unchanged by it). That equivalence is what lets
   * this skip building the extra full-grid "heightGrid" array the previous
   * version allocated for no numeric difference.
   *
   * Convenience wrapper for callers that unconditionally want both — see
   * map.js renderContours()'s hillshadeStrength>0 branch. A caller that only
   * sometimes needs the shade pass (map_exporter.js, gated on
   * hillshadeStrength) should call buildRatioGrid() and compute() directly
   * instead, so the ratio grid isn't paid for twice when combined with a
   * caller-side conditional.
   *
   * @param {Array<Array<number|null>>} grid
   * @param {number} rows
   * @param {number} cols
   * @param {{minVal:number, maxVal:number, sortedVals?:number[], rankFn?: Function,
   *          exaggeration:number, azimuthDeg:number, altitudeDeg:number}} config
   * @returns {{ratioGrid: (number|null)[][], shade: Float32Array}}
   */
  static shadeValueGrid(grid, rows, cols, config) {
    const { minVal, maxVal, sortedVals, rankFn, exaggeration, azimuthDeg, altitudeDeg } = config;
    const ratioGrid = Hillshade.buildRatioGrid(grid, rows, cols, { minVal, maxVal, sortedVals, rankFn });
    const shade = Hillshade.compute(ratioGrid, rows, cols, 1, 1, { azimuthDeg, altitudeDeg, zFactor: exaggeration });
    return { ratioGrid, shade };
  }

  /**
   * Canonical "how hillshadeStrength blends toward the flat baseline"
   * formula — previously duplicated verbatim in map.js and map_exporter.js.
   * strength=0 returns baseLightness exactly (matches the flat, unshaded
   * fill precisely, not an approximation); strength=1 returns the full
   * shaded lightness.
   *
   * @param {number} shade  from compute(), in [0, 1]
   * @param {number} strength  in [0, 1]
   * @param {number} minLightness  HSL lightness % for shade=0
   * @param {number} maxLightness  HSL lightness % for shade=1
   * @param {number} [baseLightness=50]  the unshaded fill's own lightness
   * @returns {number} HSL lightness %
   */
  static blendLightness(shade, strength, minLightness, maxLightness, baseLightness = 50) {
    const shadedLightness = minLightness + shade * (maxLightness - minLightness);
    return baseLightness + strength * (shadedLightness - baseLightness);
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Hillshade };
}
if (typeof window !== 'undefined') {
  window.Hillshade = Hillshade;
}
