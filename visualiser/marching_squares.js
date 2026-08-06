/**
 * Marching Squares Algorithm for Isolines Extraction.
 * Extracted from analyzer.js — pure spatial algorithm, zero dependencies
 * on GSR analysis or map rendering.
 */

class MarchingSquares {
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
          case 5:  lines.push([getT(), getR()]); lines.push([getB(), getL()]); break;
          case 6:  lines.push([getT(), getB()]); break;
          case 7:  lines.push([getT(), getL()]); break;
          case 8:  lines.push([getL(), getT()]); break;
          case 9:  lines.push([getB(), getT()]); break;
          case 10: lines.push([getL(), getB()]); lines.push([getT(), getR()]); break;
          case 11: lines.push([getR(), getT()]); break;
          case 12: lines.push([getL(), getR()]); break;
          case 13: lines.push([getB(), getR()]); break;
          case 14: lines.push([getL(), getB()]); break;
        }
      }
    }

    return lines;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { MarchingSquares };
}
if (typeof window !== 'undefined') {
  window.MarchingSquares = MarchingSquares;
}
