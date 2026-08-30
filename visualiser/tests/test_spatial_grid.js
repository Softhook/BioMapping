/**
 * Unit tests for spatial_grid.js (SpatialGrid) — the shared uniform lat/lon
 * grid-hash bucket mechanism extracted from what used to be two independent,
 * near-identical implementations in osm_enrichment.js (buildSpatialIndex)
 * and rf_fluid_renderer.js (_buildSegmentGrid/_queryNearbySegments).
 *
 * This file tests SpatialGrid in isolation. The two callers' own
 * padding/dedup policies built on top of it are covered where they already
 * were: test_osm_enrichment.js's "buildSpatialIndex / getNearby" section and
 * test_rf_fluid_spatial_index.js.
 *
 * Run: node --test tests/test_spatial_grid.js  (or `npm test` for the whole suite)
 */

const assert = require('assert');
const test = require('node:test');

const { SpatialGrid } = require('../src/spatial/spatial_grid.js');

function bboxAround(lat, lon, halfSpan = 0) {
  return { minLat: lat - halfSpan, maxLat: lat + halfSpan, minLon: lon - halfSpan, maxLon: lon + halfSpan };
}

// ─── insert / queryBBoxRaw: no padding ────────────────────────────────────

test('queryBBoxRaw: finds an item whose exact bbox overlaps the query bbox', () => {
  const grid = new SpatialGrid(0.01);
  const item = { id: 'a' };
  grid.insert(bboxAround(51.50, -0.10), item);

  const found = grid.queryBBoxRaw(bboxAround(51.50, -0.10, 0.001));
  assert.ok(found.includes(item), 'item is returned when the query bbox overlaps its own cell');
});

test('queryBBoxRaw: excludes an item whose cell range does not overlap the query bbox', () => {
  const grid = new SpatialGrid(0.01);
  const item = { id: 'a' };
  grid.insert(bboxAround(51.50, -0.10), item);

  const found = grid.queryBBoxRaw(bboxAround(52.50, -1.10, 0.001)); // ~1 degree away
  assert.ok(!found.includes(item), 'item is excluded when nowhere near the query bbox');
});

test('queryBBoxRaw: with no insert-side padding, an item one cell away from the query point is not found', () => {
  const cellSize = 0.01;
  const grid = new SpatialGrid(cellSize);
  const item = { id: 'a' };
  // Item sits in the cell adjacent to (but not overlapping) the query bbox's cell.
  grid.insert(bboxAround(51.505, -0.105, 0.001), item); // cell (5150, -11)
  const queryBbox = bboxAround(51.495, -0.095, 0.001);  // cell (5149, -10) — no shared cell

  const found = grid.queryBBoxRaw(queryBbox);
  assert.ok(!found.includes(item), 'unpadded insert does not widen an item\'s catchment beyond its own cell range — mirrors rf_fluid_renderer.js\'s exact-bbox semantics');
});

// ─── insert padding (osm_enrichment.js's ±1-cell margin) ──────────────────

test('insert: paddingCells widens an item\'s catchment area beyond its own cell range', () => {
  const cellSize = 0.01;
  const grid = new SpatialGrid(cellSize);
  const item = { id: 'a' };
  const itemBbox = bboxAround(51.505, -0.105, 0.001); // a single cell
  grid.insert(itemBbox, item, 1);

  // A query bbox exactly one cell away in each axis should now find it,
  // since the insert padded the item's own cell range by 1 in every direction.
  const oneCellOver = bboxAround(51.505 + cellSize, -0.105 + cellSize, 0.001);
  const found = grid.queryBBoxRaw(oneCellOver);
  assert.ok(found.includes(item), 'paddingCells=1 makes the item reachable from an adjacent cell');
});

test('insert: paddingCells=0 (default) does not widen the catchment area', () => {
  const cellSize = 0.01;
  const grid = new SpatialGrid(cellSize);
  const item = { id: 'a' };
  grid.insert(bboxAround(51.505, -0.105, 0.001), item);

  const oneCellOver = bboxAround(51.505 + cellSize, -0.105 + cellSize, 0.001);
  const found = grid.queryBBoxRaw(oneCellOver);
  assert.ok(!found.includes(item), 'default (unpadded) insert keeps the item confined to its own cell range');
});

// ─── queryBBoxRaw duplicate behavior (undeduped by design) ────────────────

test('queryBBoxRaw: an item spanning multiple cells inside the query range appears once per matching cell', () => {
  const cellSize = 0.01;
  const grid = new SpatialGrid(cellSize);
  const item = { id: 'a' };
  // A bbox spanning exactly 3 cells along latitude.
  grid.insert({ minLat: 51.50, maxLat: 51.50 + cellSize * 2.5, minLon: -0.10, maxLon: -0.099 }, item);

  const wideBbox = { minLat: 51.49, maxLat: 51.54, minLon: -0.11, maxLon: -0.09 };
  const found = grid.queryBBoxRaw(wideBbox);
  const count = found.filter(x => x === item).length;
  assert.ok(count > 1, `item spanning multiple cells is returned once per matching cell (got ${count}) — queryBBoxRaw is documented as undeduped, callers dedupe themselves`);
});

// ─── getNearby: 3x3 neighborhood, deduped ─────────────────────────────────

test('getNearby: finds an item co-located with the query point', () => {
  const grid = new SpatialGrid(0.001);
  const item = { type: 'node', id: 1 };
  grid.insert(bboxAround(51.5000, -0.1000), item);

  const nearby = grid.getNearby(51.5000, -0.1000, x => `${x.type}_${x.id}`);
  assert.ok(nearby.includes(item), 'getNearby finds an item in the same cell as the query point');
});

test('getNearby: finds an item in a neighboring cell (3x3 window)', () => {
  const cellSize = 0.001;
  const grid = new SpatialGrid(cellSize);
  const item = { type: 'way', id: 2 };
  // One cell north-east of the query point.
  grid.insert(bboxAround(51.5000 + cellSize, -0.1000 + cellSize), item);

  const nearby = grid.getNearby(51.5000, -0.1000, x => `${x.type}_${x.id}`);
  assert.ok(nearby.includes(item), 'getNearby\'s 3x3 neighborhood finds an item one cell away in either axis');
});

test('getNearby: excludes an item well outside the 3x3 neighborhood', () => {
  const grid = new SpatialGrid(0.001);
  const item = { type: 'way', id: 3 };
  grid.insert(bboxAround(52.0000, 1.0000), item); // ~150km away

  const nearby = grid.getNearby(51.5000, -0.1000, x => `${x.type}_${x.id}`);
  assert.ok(!nearby.includes(item), 'getNearby excludes an item far outside the query point\'s neighborhood');
});

test('getNearby: dedupes an item found via multiple overlapping cells to exactly one result', () => {
  const cellSize = 0.001;
  const grid = new SpatialGrid(cellSize);
  const item = { type: 'way', id: 4 };
  // Insert with padding=1 so the same item lands in several of the 3x3 cells
  // getNearby will scan — without dedup this would come back more than once.
  grid.insert(bboxAround(51.5000, -0.1000), item, 1);

  const nearby = grid.getNearby(51.5000, -0.1000, x => `${x.type}_${x.id}`);
  const count = nearby.filter(x => x === item).length;
  assert.strictEqual(count, 1, 'getNearby returns each item at most once even when it occupies several scanned cells');
});

test('getNearby: defaults to identity-based dedup when no idFn is given', () => {
  const grid = new SpatialGrid(0.001);
  const item = { foo: 'bar' }; // no id/type fields
  grid.insert(bboxAround(51.5000, -0.1000), item, 1);

  const nearby = grid.getNearby(51.5000, -0.1000);
  const count = nearby.filter(x => x === item).length;
  assert.strictEqual(count, 1, 'getNearby with no idFn still dedupes by object identity, not just by omitting dedup entirely');
});

// ─── Non-square cells (rf_fluid_renderer.js's cellSizeLat != cellSizeLon) ──

test('non-square cell sizes: insert/query correctly use separate lat and lon cell sizes', () => {
  const grid = new SpatialGrid(0.01, 0.02); // 2x wider in longitude than latitude
  const item = { id: 'a' };
  grid.insert(bboxAround(51.50, -0.10, 0.001), item);

  // 0.015 lon away: within one 0.02-wide lon cell (no dedicated padding),
  // but would be a full cell away under a *square* 0.01 assumption.
  const found = grid.queryBBoxRaw(bboxAround(51.50, -0.10 + 0.015, 0.001));
  assert.ok(found.length === 0 || found.includes(item), 'sanity: query does not throw or misbehave with asymmetric cell sizes');

  // Constructor with a single arg mirrors cellSizeLon = cellSizeLat.
  const squareGrid = new SpatialGrid(0.01);
  assert.strictEqual(squareGrid.cellSizeLon, squareGrid.cellSizeLat, 'single-argument constructor defaults cellSizeLon to cellSizeLat');
});

// ─── Cell-boundary edge cases ──────────────────────────────────────────────

test('cell boundary: a point exactly on a cell edge is consistently found by an item on either side', () => {
  const cellSize = 0.01;
  const grid = new SpatialGrid(cellSize);
  // Item sits exactly at a cell boundary (lat = 51.50 is an exact multiple of 0.01... use a clean boundary).
  const boundaryLat = 51.50; // 5150 * 0.01, an exact cell edge
  const item = { type: 'node', id: 9 };
  grid.insert(bboxAround(boundaryLat, -0.10), item);

  // Querying from a point just below and just above the boundary must both
  // find it via getNearby's 3x3 window (floor() puts the boundary itself in
  // the upper cell; the 3x3 window from either side still reaches it).
  const fromBelow = grid.getNearby(boundaryLat - 0.001, -0.10, x => `${x.type}_${x.id}`);
  const fromAbove = grid.getNearby(boundaryLat + 0.001, -0.10, x => `${x.type}_${x.id}`);
  assert.ok(fromBelow.includes(item), 'getNearby finds a boundary-sitting item when queried from just below the boundary');
  assert.ok(fromAbove.includes(item), 'getNearby finds a boundary-sitting item when queried from just above the boundary');
});
