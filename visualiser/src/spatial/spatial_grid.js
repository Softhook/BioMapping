/**
 * Shared uniform lat/lon grid hash for spatial "what's near this point/bbox"
 * lookups. Buckets bbox-shaped items by which grid cell(s) they overlap, so
 * a query only has to look at the handful of cells it touches instead of
 * scanning every item.
 *
 * Extracted from two independent, near-identical implementations that used
 * to live in osm_enrichment.js (buildSpatialIndex) and rf_fluid_renderer.js
 * (_buildSegmentGrid/_queryNearbySegments) — same Map-of-buckets/floor-
 * division-cell-key mechanics, duplicated. Each caller keeps its own
 * padding/dedup policy on top (osm_enrichment.js pads inserts by one cell
 * and dedupes a point query's 3x3 neighborhood by `${type}_${id}`;
 * rf_fluid_renderer.js inserts unpadded and dedupes an explicit-bbox query
 * by a per-item query-id stamp) — those policies are preserved as thin
 * wrappers around this shared bucket mechanism, not folded together, since
 * they're genuinely different correctness requirements per caller.
 */
class SpatialGrid {
  constructor(cellSizeLat, cellSizeLon) {
    this.grid = new Map();
    this.cellSizeLat = cellSizeLat;
    this.cellSizeLon = (cellSizeLon !== undefined && cellSizeLon !== null) ? cellSizeLon : cellSizeLat;
  }

  _key(row, col) {
    return row + ',' + col;
  }

  _cellRange(bbox) {
    return {
      rowMin: Math.floor(bbox.minLat / this.cellSizeLat),
      rowMax: Math.floor(bbox.maxLat / this.cellSizeLat),
      colMin: Math.floor(bbox.minLon / this.cellSizeLon),
      colMax: Math.floor(bbox.maxLon / this.cellSizeLon)
    };
  }

  /**
   * Insert `item` into every cell `bbox` spans, optionally padded by
   * `paddingCells` extra cells in every direction (default 0 — exact
   * footprint only). Padding widens an item's catchment area beyond its
   * literal bbox; use it when the query side doesn't already apply an
   * equivalent margin of its own.
   */
  insert(bbox, item, paddingCells = 0) {
    const r = this._cellRange(bbox);
    for (let row = r.rowMin - paddingCells; row <= r.rowMax + paddingCells; row++) {
      for (let col = r.colMin - paddingCells; col <= r.colMax + paddingCells; col++) {
        const key = this._key(row, col);
        let bucket = this.grid.get(key);
        if (!bucket) { bucket = []; this.grid.set(key, bucket); }
        bucket.push(item);
      }
    }
  }

  /**
   * Every item whose cell range overlaps `bbox`. No padding, no dedup — an
   * item inserted into several cells that all fall inside the query range
   * appears once per such cell. Correct as a "no false negatives" candidate
   * set (any item overlapping bbox shares at least one grid cell with it);
   * callers needing an exact match or exactly-once results filter/dedupe
   * the result themselves.
   */
  queryBBoxRaw(bbox) {
    const r = this._cellRange(bbox);
    const out = [];
    for (let row = r.rowMin; row <= r.rowMax; row++) {
      for (let col = r.colMin; col <= r.colMax; col++) {
        const bucket = this.grid.get(this._key(row, col));
        if (bucket) for (let i = 0; i < bucket.length; i++) out.push(bucket[i]);
      }
    }
    return out;
  }

  /**
   * 3x3 neighborhood of cells around the cell containing (lat, lon),
   * deduped by `idFn(item)` (defaults to identity — dedup by reference).
   */
  getNearby(lat, lon, idFn) {
    const cx = Math.floor(lon / this.cellSizeLon);
    const cy = Math.floor(lat / this.cellSizeLat);
    const dedupe = idFn || (item => item);
    const result = [];
    const seen = new Set();
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = this.grid.get(this._key(cy + dy, cx + dx));
        if (!bucket) continue;
        for (const item of bucket) {
          const key = dedupe(item);
          if (!seen.has(key)) { seen.add(key); result.push(item); }
        }
      }
    }
    return result;
  }

  /**
   * Compute the bounding [rMin, rMax, cMin, cMax] row/column grid window for a point
   * (lat, lon) and search radius in meters across a uniform grid.
   *
   * @param {number} lat - Point latitude.
   * @param {number} lon - Point longitude.
   * @param {number} meters - Search radius in meters.
   * @param {{minLat: number, maxLat: number, minLon: number, maxLon: number}} bounds - Grid bounding box.
   * @param {number} rows - Number of grid rows.
   * @param {number} cols - Number of grid columns.
   * @param {number} [degToMeterLat=111320] - Meters per degree latitude.
   * @param {number} [degToMeterLon] - Meters per degree longitude at representative latitude.
   * @returns {{rMin: number, rMax: number, cMin: number, cMax: number, rRadius: number, cRadius: number, centerRow: number, centerCol: number}}
   */
  static computeCellWindow(lat, lon, meters, bounds, rows, cols, degToMeterLat = 111320.0, degToMeterLon = null) {
    const lonScale = (degToMeterLon !== null && degToMeterLon !== undefined)
      ? degToMeterLon
      : degToMeterLat * Math.cos(lat * Math.PI / 180);
    const latStep = rows > 1 ? (bounds.maxLat - bounds.minLat) / (rows - 1) : 0;
    const lonStep = cols > 1 ? (bounds.maxLon - bounds.minLon) / (cols - 1) : 0;
    const rRadius = latStep > 0 ? Math.max(1, Math.ceil((meters / degToMeterLat) / latStep)) : rows;
    const cRadius = lonStep > 0 ? Math.max(1, Math.ceil((meters / lonScale) / lonStep)) : cols;
    const centerRow = latStep > 0 ? Math.round((lat - bounds.minLat) / latStep) : 0;
    const centerCol = lonStep > 0 ? Math.round((lon - bounds.minLon) / lonStep) : 0;
    return {
      rMin: Math.max(0, centerRow - rRadius),
      rMax: Math.min(rows - 1, centerRow + rRadius),
      cMin: Math.max(0, centerCol - cRadius),
      cMax: Math.min(cols - 1, centerCol + cRadius),
      rRadius,
      cRadius,
      centerRow,
      centerCol
    };
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SpatialGrid };
}
if (typeof window !== 'undefined') {
  window.SpatialGrid = SpatialGrid;
}
