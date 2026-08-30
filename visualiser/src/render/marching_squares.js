/**
 * Marching Squares Algorithm for Isolines Extraction.
 * Extracted from analyzer.js — pure spatial algorithm, zero dependencies
 * on GSR analysis or map rendering.
 */

class MarchingSquares {
  /**
   * Saddle disambiguation: mean of a cell's valid (non-null) corner values,
   * used to decide which way the two segments connect for the ambiguous
   * cellIndex 5 / 10 cases. Returns 0 when every corner is masked.
   */
  static _saddleMean(vNW, vNE, vSE, vSW, okNW, okNE, okSE, okSW) {
    let sum = 0, count = 0;
    if (okNW) { sum += vNW; count++; }
    if (okNE) { sum += vNE; count++; }
    if (okSE) { sum += vSE; count++; }
    if (okSW) { sum += vSW; count++; }
    return count > 0 ? sum / count : 0;
  }

  /**
   * Run marching squares on a 2D grid to extract contour line segments.
   *
   * @param {number[][]} grid  — 2D array [rows][cols] of values (or null for masked cells)
   * @param {number} rows
   * @param {number} cols
   * @param {{minLat:number, minLon:number, maxLat:number, maxLon:number}} bounds
   * @param {number} isolevel  — threshold value for the contour line
   * @returns {Array<Array<{lat:number, lon:number}>>} array of 2-point segments
   */
  static getContourLines(grid, rows, cols, bounds, isolevel) {
    const lines = [];
    const minLat = bounds.minLat;
    const maxLat = bounds.maxLat;
    const minLon = bounds.minLon;
    const maxLon = bounds.maxLon;

    const getLatLng = (r, c) => {
      const lat = minLat + (r / (rows - 1)) * (maxLat - minLat);
      const lon = minLon + (c / (cols - 1)) * (maxLon - minLon);
      return { lat, lon };
    };

    // Linear interpolation on cell edges for precision positioning
    const interpolate = (r1, c1, r2, c2) => {
      const v1 = grid[r1][c1];
      const v2 = grid[r2][c2];
      const p1 = getLatLng(r1, c1);
      const p2 = getLatLng(r2, c2);

      const isVal1 = v1 !== null && !isNaN(v1);
      const isVal2 = v2 !== null && !isNaN(v2);

      if (!isVal1 && !isVal2) return p1;
      if (!isVal1 || !isVal2) return { lat: (p1.lat + p2.lat) / 2, lon: (p1.lon + p2.lon) / 2 };
      if (Math.abs(v1 - v2) < 1e-9) return p1;

      const t = Math.max(0, Math.min(1, (isolevel - v1) / (v2 - v1)));
      return {
        lat: p1.lat + t * (p2.lat - p1.lat),
        lon: p1.lon + t * (p2.lon - p1.lon)
      };
    };

    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        // Corner values
        const vNW = grid[r][c];         // Top-left (NW)
        const vNE = grid[r][c + 1];     // Top-right (NE)
        const vSE = grid[r + 1][c + 1]; // Bottom-right (SE)
        const vSW = grid[r + 1][c];     // Bottom-left (SW)

        const nwVal = vNW !== null && !isNaN(vNW);
        const neVal = vNE !== null && !isNaN(vNE);
        const seVal = vSE !== null && !isNaN(vSE);
        const swVal = vSW !== null && !isNaN(vSW);

        // Skip only if all 4 corners are null/NaN (completely outside mask)
        if (!nwVal && !neVal && !seVal && !swVal) {
          continue;
        }

        // 4-bit index: NW (bit 3), NE (bit 2), SE (bit 1), SW (bit 0)
        let cellIndex = 0;
        if (nwVal && vNW >= isolevel) cellIndex |= 8;
        if (neVal && vNE >= isolevel) cellIndex |= 4;
        if (seVal && vSE >= isolevel) cellIndex |= 2;
        if (swVal && vSW >= isolevel) cellIndex |= 1;

        if (cellIndex === 0 || cellIndex === 15) continue;

        let pT = null; // Top edge intersection
        let pR = null; // Right edge intersection
        let pB = null; // Bottom edge intersection
        let pL = null; // Left edge intersection

        // Lazy calculations
        const getT = () => pT || (pT = interpolate(r, c, r, c + 1));
        const getR = () => pR || (pR = interpolate(r, c + 1, r + 1, c + 1));
        const getB = () => pB || (pB = interpolate(r + 1, c, r + 1, c + 1));
        const getL = () => pL || (pL = interpolate(r, c, r + 1, c));

        switch (cellIndex) {
          case 1:  lines.push([getB(), getL()]); break;
          case 2:  lines.push([getR(), getB()]); break;
          case 3:  lines.push([getR(), getL()]); break;
          case 4:  lines.push([getT(), getR()]); break;
          case 5: {
            const vCenter = MarchingSquares._saddleMean(vNW, vNE, vSE, vSW, nwVal, neVal, seVal, swVal);
            if (vCenter >= isolevel) {
              lines.push([getT(), getL()]);
              lines.push([getB(), getR()]);
            } else {
              lines.push([getT(), getR()]);
              lines.push([getB(), getL()]);
            }
            break;
          }
          case 6:  lines.push([getT(), getB()]); break;
          case 7:  lines.push([getT(), getL()]); break;
          case 8:  lines.push([getL(), getT()]); break;
          case 9:  lines.push([getB(), getT()]); break;
          case 10: {
            const vCenter = MarchingSquares._saddleMean(vNW, vNE, vSE, vSW, nwVal, neVal, seVal, swVal);
            if (vCenter >= isolevel) {
              lines.push([getL(), getT()]);
              lines.push([getB(), getR()]);
            } else {
              lines.push([getL(), getB()]);
              lines.push([getT(), getR()]);
            }
            break;
          }
          case 11: lines.push([getR(), getT()]); break;
          case 12: lines.push([getL(), getR()]); break;
          case 13: lines.push([getB(), getR()]); break;
          case 14: lines.push([getL(), getB()]); break;
        }
      }
    }

    return lines;
  }

  /**
   * §C perf fix (2026-08-07): single-pass multi-isolevel contour extraction.
   *
   * Replaces K separate getContourLines() calls (each traversing the full
   * (rows-1)×(cols-1) grid) with one traversal that emits segments for all
   * K isolevels simultaneously.
   *
   * Improvements over the per-level API:
   *  1. Grid traversed once instead of K times — O(R×C) vs O(K×R×C).
   *  2. Pre-computed latGrid/lonGrid Float64Arrays replace per-call getLatLng()
   *     arithmetic (which also allocated a {lat,lon} object on every edge).
   *  3. Per-cell [cellMin, cellMax] pruning: levels outside [min,max] skip the
   *     interpolation work for that cell entirely.
   *
   * @param {number[][]} grid     — 2D array [rows][cols] (null = masked)
   * @param {number}     rows
   * @param {number}     cols
   * @param {{minLat,minLon,maxLat,maxLon}} bounds
   * @param {number[]}   levels   — sorted ascending (caller's responsibility)
   * @returns {Map<number, Array<Array<{lat,lon}>>>}  level → segment array
   */
  static getContourLinesMulti(grid, rows, cols, bounds, levels) {
    if (!levels || levels.length === 0) return new Map();

    // Pre-compute coordinate lookup arrays (replaces per-call getLatLng() math
    // + object allocation on every interpolated edge point).
    const latGrid = new Float64Array(rows);
    const lonGrid = new Float64Array(cols);
    const latSpan = bounds.maxLat - bounds.minLat;
    const lonSpan = bounds.maxLon - bounds.minLon;
    const rowsM1 = rows - 1;
    const colsM1 = cols - 1;
    for (let r = 0; r < rows; r++) latGrid[r] = bounds.minLat + (r / rowsM1) * latSpan;
    for (let c = 0; c < cols; c++) lonGrid[c] = bounds.minLon + (c / colsM1) * lonSpan;

    // Result map: one segment-array per level (only levels with ≥1 segment stored).
    const result = new Map();
    for (const lv of levels) result.set(lv, []);

    for (let r = 0; r < rowsM1; r++) {
      for (let c = 0; c < colsM1; c++) {
        const vNW = grid[r][c];
        const vNE = grid[r][c + 1];
        const vSE = grid[r + 1][c + 1];
        const vSW = grid[r + 1][c];

        const okNW = vNW !== null && !isNaN(vNW);
        const okNE = vNE !== null && !isNaN(vNE);
        const okSE = vSE !== null && !isNaN(vSE);
        const okSW = vSW !== null && !isNaN(vSW);

        if (!okNW && !okNE && !okSE && !okSW) continue; // fully masked

        // Cell value range for level pruning.
        let cellMin = Infinity, cellMax = -Infinity;
        let hasNull = !okNW || !okNE || !okSE || !okSW;
        if (okNW) { if (vNW < cellMin) cellMin = vNW; if (vNW > cellMax) cellMax = vNW; }
        if (okNE) { if (vNE < cellMin) cellMin = vNE; if (vNE > cellMax) cellMax = vNE; }
        if (okSE) { if (vSE < cellMin) cellMin = vSE; if (vSE > cellMax) cellMax = vSE; }
        if (okSW) { if (vSW < cellMin) cellMin = vSW; if (vSW > cellMax) cellMax = vSW; }

        // Corner coordinates (looked up once per cell, shared across all levels).
        const latR = latGrid[r];   const latR1 = latGrid[r + 1];
        const lonC = lonGrid[c];   const lonC1 = lonGrid[c + 1];

        // Inline interpolation helper — returns [lat, lon] using precomputed
        // corner coords and the current isolevel, with null/NaN boundary handling.
        // Named closures avoided to keep the per-cell allocation cost low.
        // Points are emitted as {lat,lon} objects only when a segment is actually
        // pushed (lazy, same as the original getContourLines lazy getT/getR/etc).
        function interp(lat1, lon1, v1, ok1, lat2, lon2, v2, ok2, isolevel) {
          if (!ok1 && !ok2) return { lat: lat1, lon: lon1 };
          if (!ok1 || !ok2) return { lat: (lat1 + lat2) / 2, lon: (lon1 + lon2) / 2 };
          if (Math.abs(v1 - v2) < 1e-9) return { lat: lat1, lon: lon1 };
          const t = Math.max(0, Math.min(1, (isolevel - v1) / (v2 - v1)));
          return { lat: lat1 + t * (lat2 - lat1), lon: lon1 + t * (lon2 - lon1) };
        }

        for (const isolevel of levels) {
          // Skip levels that cannot cross this cell.
          // If the cell has null corners, they act as values < isolevel (setting bit to 0).
          // Therefore, if isolevel < cellMin, the cell still has a boundary crossing between
          // the null corner (value < isolevel) and the non-null corners (values >= isolevel).
          // We can only prune isolevel < cellMin when there are NO null corners (hasNull === false).
          if (isolevel > cellMax || (!hasNull && isolevel < cellMin)) continue;
          // Also skip all-below / all-above cells (same as cellIndex 0 or 15).
          const bNW = okNW && vNW >= isolevel;
          const bNE = okNE && vNE >= isolevel;
          const bSE = okSE && vSE >= isolevel;
          const bSW = okSW && vSW >= isolevel;
          const cellIndex = (bNW ? 8 : 0) | (bNE ? 4 : 0) | (bSE ? 2 : 0) | (bSW ? 1 : 0);
          if (cellIndex === 0 || cellIndex === 15) continue;

          // Lazy edge intersection points (computed only for edges actually needed).
          let pT = null, pR = null, pB = null, pL = null;
          const getT = () => pT || (pT = interp(latR,  lonC,  vNW, okNW, latR,  lonC1, vNE, okNE, isolevel));
          const getR = () => pR || (pR = interp(latR,  lonC1, vNE, okNE, latR1, lonC1, vSE, okSE, isolevel));
          const getB = () => pB || (pB = interp(latR1, lonC,  vSW, okSW, latR1, lonC1, vSE, okSE, isolevel));
          const getL = () => pL || (pL = interp(latR,  lonC,  vNW, okNW, latR1, lonC,  vSW, okSW, isolevel));

          const segs = result.get(isolevel);
          switch (cellIndex) {
            case 1:  segs.push([getB(), getL()]); break;
            case 2:  segs.push([getR(), getB()]); break;
            case 3:  segs.push([getR(), getL()]); break;
            case 4:  segs.push([getT(), getR()]); break;
            case 5: {
              const vCenter = MarchingSquares._saddleMean(vNW, vNE, vSE, vSW, okNW, okNE, okSE, okSW);
              if (vCenter >= isolevel) {
                segs.push([getT(), getL()]);
                segs.push([getB(), getR()]);
              } else {
                segs.push([getT(), getR()]);
                segs.push([getB(), getL()]);
              }
              break;
            }
            case 6:  segs.push([getT(), getB()]); break;
            case 7:  segs.push([getT(), getL()]); break;
            case 8:  segs.push([getL(), getT()]); break;
            case 9:  segs.push([getB(), getT()]); break;
            case 10: {
              const vCenter = MarchingSquares._saddleMean(vNW, vNE, vSE, vSW, okNW, okNE, okSE, okSW);
              if (vCenter >= isolevel) {
                segs.push([getL(), getT()]);
                segs.push([getB(), getR()]);
              } else {
                segs.push([getL(), getB()]);
                segs.push([getT(), getR()]);
              }
              break;
            }
            case 11: segs.push([getR(), getT()]); break;
            case 12: segs.push([getL(), getR()]); break;
            case 13: segs.push([getB(), getR()]); break;
            case 14: segs.push([getL(), getB()]); break;
          }
        }
      }
    }

    return result;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { MarchingSquares };
}
if (typeof window !== 'undefined') {
  window.MarchingSquares = MarchingSquares;
}
