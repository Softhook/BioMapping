/**
 * Grayscale relief shading (hillshade) for a scalar grid surface.
 * Same algorithm GIS tools use for DEM relief shading — Horn's method
 * slope/aspect estimate + Lambertian reflectance against a simulated sun —
 * applied here to collective_manager.js's interpolated arousal/phasic/tonic
 * grid, which is already the same shape as a DEM: a regular raster of
 * scalar "height" values. Pure algorithm, zero dependencies — mirrors
 * marching_squares.js.
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

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const v = grid[r][c];
        if (v === null || v === undefined || isNaN(v)) continue;

        // 3x3 Horn's-method neighborhood. Off-grid or masked neighbors fall
        // back to this cell's own value (flat extrapolation) instead of
        // branching the stencil — matches how DEM hillshade tools treat
        // nodata edges/holes, and keeps corridor-boundary cells from reading
        // a spurious cliff against the surrounding null mask.
        const at = (rr, cc) => {
          if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) return v;
          const vv = grid[rr][cc];
          return (vv === null || vv === undefined || isNaN(vv)) ? v : vv;
        };

        // Compass-named per this codebase's grid convention (collective_manager.js
        // gridLatOf(r) = minLat + r/(rows-1)*(maxLat-minLat)): row increases
        // northward, so row r-1 is the southern neighbor and r+1 the northern one.
        const sw = at(r - 1, c - 1), s = at(r - 1, c), se = at(r - 1, c + 1);
        const w  = at(r, c - 1),                        e  = at(r, c + 1);
        const nw = at(r + 1, c - 1), n = at(r + 1, c), ne = at(r + 1, c + 1);

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
   * Turns a raw value grid into a shaded relief, using the SAME percentile-rank
   * (or linear, when rank isn't available) ratio a caller's color fill uses as
   * the "height" field — not the raw value. Shading a different function of
   * the data than the one being colored/contoured means the relief doesn't
   * track what's actually drawn (see map.js renderContours()'s comment for
   * the full rationale). Shared by map.js (live raster surface) and
   * map_exporter.js (SVG vector mesh export) so both draw the identical
   * relief instead of two hand-rolled copies of this math drifting apart.
   *
   * @param {Array<Array<number|null>>} grid
   * @param {number} rows
   * @param {number} cols
   * @param {{minVal:number, maxVal:number, sortedVals?:number[], rankFn?: (v:number, sorted:number[]) => number,
   *          exaggeration:number, azimuthDeg:number, altitudeDeg:number}} config
   * @returns {{ratioGrid: (number|null)[][], shade: Float32Array}}
   */
  static shadeValueGrid(grid, rows, cols, config) {
    const { minVal, maxVal, sortedVals, rankFn, exaggeration, azimuthDeg, altitudeDeg } = config;
    const valRange = maxVal - minVal;
    const rangeEpsilon = 1e-9;
    const useRank = sortedVals && sortedVals.length > 1 && typeof rankFn === 'function';

    const ratioGrid = grid.map(row => row.map(v => {
      if (v === null || v === undefined || isNaN(v)) return null;
      if (useRank) return rankFn(v, sortedVals);
      return valRange > rangeEpsilon ? (v - minVal) / valRange : 0.5;
    }));

    const heightGrid = ratioGrid.map(row => row.map(r => r === null ? null : r * exaggeration));
    const shade = Hillshade.compute(heightGrid, rows, cols, 1, 1, { azimuthDeg, altitudeDeg });
    return { ratioGrid, shade };
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Hillshade };
}
if (typeof window !== 'undefined') {
  window.Hillshade = Hillshade;
}
