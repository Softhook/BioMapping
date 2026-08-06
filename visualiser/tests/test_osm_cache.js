/**
 * Regression tests for osm_cache.js (OsmCache) — the IndexedDB-backed cache
 * for Overpass API responses.
 *
 * Only the pure, IndexedDB-free logic is tested here (bbox containment,
 * best-match selection, LRU eviction selection). The actual IndexedDB glue
 * (_openDb/_getAll/_put/_deleteMany) is intentionally not exercised — Node
 * has no IndexedDB implementation, and that plumbing is a thin, standard
 * wrapper around the browser API best verified manually in-app. Every
 * decision OsmCache makes (which entry to reuse, which to evict) is
 * isolated into pure functions specifically so it CAN be tested without a
 * real database — that's what this file covers.
 *
 * Run: node tests/test_osm_cache.js
 */

const vm = require('vm');
const fs = require('fs');

function loadModule(filePath, varName) {
  const src = fs.readFileSync(filePath, 'utf8');
  const wrapped = src.replace(
    new RegExp(`const ${varName}\\s*=`),
    `global.${varName} =`
  );
  vm.runInThisContext(wrapped, { filename: filePath });
}

loadModule(__dirname + '/../osm_cache.js', 'OsmCache');
const OsmCache = global.OsmCache;

// ── Test helpers ────────────────────────────────────────────────────────────
let passed = 0, failed = 0;

function assert(condition, msg) {
  if (condition) { passed++; return; }
  failed++;
  console.error(`  FAIL: ${msg}`);
}

function assertEq(actual, expected, msg) {
  if (actual === expected) { passed++; return; }
  failed++;
  console.error(`  FAIL: ${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function assertClose(actual, expected, tolerance, msg) {
  if (Math.abs(actual - expected) <= tolerance) { passed++; return; }
  failed++;
  console.error(`  FAIL: ${msg} — expected ~${expected}, got ${actual} (diff ${Math.abs(actual - expected)})`);
}

function summary() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`${'='.repeat(60)}`);
  if (failed > 0) process.exit(1);
}

const bboxA = { minLat: 51.50, minLon: -0.12, maxLat: 51.51, maxLon: -0.10 }; // outer/broad
const bboxB = { minLat: 51.503, minLon: -0.115, maxLat: 51.507, maxLon: -0.105 }; // inner, fully inside A
const bboxC = { minLat: 51.60, minLon: -0.20, maxLat: 51.61, maxLon: -0.19 }; // disjoint from A

// Overlaps bboxA (shares the lat 51.505–51.51 / lon -0.11–-0.10 corner) but
// extends further north-east — neither bbox contains the other.
const bboxPartial = { minLat: 51.505, minLon: -0.11, maxLat: 51.515, maxLon: -0.09 };
// A second, differently-shaped area that also overlaps bboxPartial (used
// for the multi-entry merge test, alongside bboxA).
const bboxPartial2 = { minLat: 51.495, minLon: -0.115, maxLat: 51.506, maxLon: -0.095 };

// ════════════════════════════════════════════════════════════════════════
//  1. _bboxContains
// ════════════════════════════════════════════════════════════════════════
console.log('\n── OsmCache._bboxContains ──');

assert(OsmCache._bboxContains(bboxA, bboxB), '_bboxContains — inner bbox fully inside outer → true');
assert(!OsmCache._bboxContains(bboxB, bboxA), '_bboxContains — outer bbox does not fit inside inner → false');
assert(!OsmCache._bboxContains(bboxA, bboxC), '_bboxContains — disjoint bboxes → false');
assert(OsmCache._bboxContains(bboxA, bboxA), '_bboxContains — identical bbox contains itself → true');

// Partial overlap (neither bbox contains the other) must NOT count as a hit —
// containment is strict; a request that only partly overlaps a cached area
// is treated as a full miss, not a partial one.
{
  const partial = { minLat: bboxA.minLat + 0.005, minLon: bboxA.minLon + 0.005,
                     maxLat: bboxA.maxLat + 0.005, maxLon: bboxA.maxLon + 0.005 };
  assert(OsmCache._bboxContains(bboxA, bboxA), 'sanity: bboxA overlaps itself'); // baseline
  assert(!OsmCache._bboxContains(bboxA, partial),
    '_bboxContains — bbox that only partially overlaps (not fully inside) → false');
  assert(!OsmCache._bboxContains(partial, bboxA),
    '_bboxContains — partial overlap is not containment in either direction');
}

// Tolerance absorbs tiny floating-point differences from re-computed buffers
{
  const nearlyA = { minLat: bboxA.minLat + 0.0001, minLon: bboxA.minLon + 0.0001,
                     maxLat: bboxA.maxLat - 0.0001, maxLon: bboxA.maxLon - 0.0001 };
  assert(OsmCache._bboxContains(bboxA, nearlyA), '_bboxContains — tiny rounding differences absorbed by tolerance');
}
{
  // Just outside — bigger than the default 0.0005° tolerance
  const justOutside = { minLat: bboxA.minLat - 0.01, minLon: bboxA.minLon, maxLat: bboxA.maxLat, maxLon: bboxA.maxLon };
  assert(!OsmCache._bboxContains(bboxA, justOutside), '_bboxContains — genuinely-outside bbox not absorbed by tolerance');
}

// ════════════════════════════════════════════════════════════════════════
//  2. _pickBestMatch
// ════════════════════════════════════════════════════════════════════════
console.log('\n── OsmCache._pickBestMatch ──');

const now = 1_700_000_000_000;

// 2a. Picks a containing entry
{
  const entries = [
    { bbox: bboxA, queryVersion: 1, fetchedAt: now, data: 'A' },
  ];
  const match = OsmCache._pickBestMatch(entries, bboxB, 1, now);
  assertEq(match && match.data, 'A', '_pickBestMatch — finds containing entry');
}

// 2b. No containing entry → null
{
  const entries = [{ bbox: bboxC, queryVersion: 1, fetchedAt: now, data: 'C' }];
  const match = OsmCache._pickBestMatch(entries, bboxB, 1, now);
  assertEq(match, null, '_pickBestMatch — no containing entry → null');
}

// 2b-2. Partial overlap (new request extends beyond the cached area on one
// side) is a miss, NOT a partial hit — the cache never merges/unions
// entries, so this always triggers a full re-fetch of the *entire*
// requested bbox, which is then stored as a brand-new, separate entry
// alongside the old one (some duplication between the two is expected).
{
  const cached = { bbox: bboxA, queryVersion: 1, fetchedAt: now, data: 'cached-A' };
  const partiallyOverlapping = {
    minLat: bboxA.minLat + 0.005, minLon: bboxA.minLon + 0.005,
    maxLat: bboxA.maxLat + 0.005, maxLon: bboxA.maxLon + 0.005
  };
  const match = OsmCache._pickBestMatch([cached], partiallyOverlapping, 1, now);
  assertEq(match, null, '_pickBestMatch — partially-overlapping request is a miss (no merge/union support)');
}

// 2c. Prefers the tightest-fitting (smallest-area) containing entry
{
  const broad  = { bbox: bboxA, queryVersion: 1, fetchedAt: now, data: 'broad' };
  const tight  = { bbox: bboxB, queryVersion: 1, fetchedAt: now, data: 'tight' };
  // Query for a bbox that both broad and tight (as it happens bboxB itself) contain.
  const match = OsmCache._pickBestMatch([broad, tight], bboxB, 1, now);
  assertEq(match.data, 'tight', '_pickBestMatch — prefers smallest containing entry over broader one');
}

// 2d. Ignores entries from a different query version
{
  const entries = [{ bbox: bboxA, queryVersion: 0, fetchedAt: now, data: 'old-query-shape' }];
  const match = OsmCache._pickBestMatch(entries, bboxB, 1, now);
  assertEq(match, null, '_pickBestMatch — mismatched queryVersion is ignored');
}

// 2e. Ignores expired entries (older than CACHE_TTL_MS)
{
  const stale = { bbox: bboxA, queryVersion: 1, fetchedAt: now - OsmCache.CACHE_TTL_MS - 1000, data: 'stale' };
  const match = OsmCache._pickBestMatch([stale], bboxB, 1, now);
  assertEq(match, null, '_pickBestMatch — expired entry (past TTL) is ignored');
}

// 2f. Entry right at the TTL boundary (not yet expired) is still used
{
  const fresh = { bbox: bboxA, queryVersion: 1, fetchedAt: now - OsmCache.CACHE_TTL_MS + 1000, data: 'fresh' };
  const match = OsmCache._pickBestMatch([fresh], bboxB, 1, now);
  assertEq(match && match.data, 'fresh', '_pickBestMatch — entry just inside TTL is still used');
}

// ════════════════════════════════════════════════════════════════════════
//  3. Merge-on-overlap: _bboxIntersects / _unionBBox / _bboxAreaKm2 /
//     _findOverlapping / _planFetch
// ════════════════════════════════════════════════════════════════════════
console.log('\n── OsmCache: merge-on-overlap helpers ──');

// 3a. _bboxIntersects
assert(OsmCache._bboxIntersects(bboxA, bboxPartial), '_bboxIntersects — partially-overlapping bboxes → true');
assert(OsmCache._bboxIntersects(bboxA, bboxB), '_bboxIntersects — full containment counts as intersecting → true');
assert(OsmCache._bboxIntersects(bboxA, bboxA), '_bboxIntersects — bbox intersects itself → true');
assert(!OsmCache._bboxIntersects(bboxA, bboxC), '_bboxIntersects — disjoint bboxes → false');

// 3b. _unionBBox
{
  const u = OsmCache._unionBBox([bboxA, bboxPartial]);
  assertEq(u.minLat, Math.min(bboxA.minLat, bboxPartial.minLat), '_unionBBox — minLat is the min of inputs');
  assertEq(u.maxLat, Math.max(bboxA.maxLat, bboxPartial.maxLat), '_unionBBox — maxLat is the max of inputs');
  assertEq(u.minLon, Math.min(bboxA.minLon, bboxPartial.minLon), '_unionBBox — minLon is the min of inputs');
  assertEq(u.maxLon, Math.max(bboxA.maxLon, bboxPartial.maxLon), '_unionBBox — maxLon is the max of inputs');
}
{
  const u = OsmCache._unionBBox([bboxA]);
  assertEq(u.minLat, bboxA.minLat, '_unionBBox — single-bbox union equals that bbox (minLat)');
  assertEq(u.maxLon, bboxA.maxLon, '_unionBBox — single-bbox union equals that bbox (maxLon)');
}

// 3c. _bboxAreaKm2 — same known-answer case as OSMEnricher.calculateBBoxAreaKm2
{
  const area = OsmCache._bboxAreaKm2({ minLat: 0, maxLat: 0.01, minLon: 0, maxLon: 0.01 });
  assertClose(area, 1.239, 0.02, '_bboxAreaKm2 ≈ 1.24 km² for 0.01°×0.01° at equator');
}

// 3d. _findOverlapping — finds partial overlaps, excludes disjoint entries
{
  const entries = [
    { id: 1, bbox: bboxA, queryVersion: 1, fetchedAt: now, data: 'A' },
    { id: 2, bbox: bboxC, queryVersion: 1, fetchedAt: now, data: 'C' }, // disjoint from bboxPartial
  ];
  const overlapping = OsmCache._findOverlapping(entries, bboxPartial, 1, now);
  assertEq(overlapping.length, 1, '_findOverlapping — finds exactly the one overlapping entry');
  assertEq(overlapping[0].id, 1, '_findOverlapping — excludes the disjoint entry');
}

// 3e. _findOverlapping — respects query version and TTL, same as _pickBestMatch
{
  const wrongVersion = [{ id: 1, bbox: bboxA, queryVersion: 0, fetchedAt: now, data: 'x' }];
  assertEq(OsmCache._findOverlapping(wrongVersion, bboxPartial, 1, now).length, 0,
    '_findOverlapping — mismatched queryVersion excluded');

  const expired = [{ id: 1, bbox: bboxA, queryVersion: 1, fetchedAt: now - OsmCache.CACHE_TTL_MS - 1000, data: 'x' }];
  assertEq(OsmCache._findOverlapping(expired, bboxPartial, 1, now).length, 0,
    '_findOverlapping — expired entry excluded');
}

// 3f. _planFetch — no overlap → fetch exactly the requested bbox, no merge
{
  const entries = [{ id: 1, bbox: bboxC, queryVersion: 1, fetchedAt: now, data: 'C' }]; // disjoint
  const plan = OsmCache._planFetch(entries, bboxPartial, 1, now);
  assertEq(plan.mergeIds.length, 0, '_planFetch — no overlap → no mergeIds');
  assertEq(plan.fetchBBox, bboxPartial, '_planFetch — no overlap → fetchBBox is the request itself');
}

// 3g. _planFetch — single overlapping entry → union fetch, one id to supersede
{
  const entries = [{ id: 5, bbox: bboxA, queryVersion: 1, fetchedAt: now, data: 'A' }];
  const plan = OsmCache._planFetch(entries, bboxPartial, 1, now);
  const expectedUnion = OsmCache._unionBBox([bboxPartial, bboxA]);
  assertEq(plan.mergeIds.length, 1, '_planFetch — one overlapping entry → one mergeId');
  assertEq(plan.mergeIds[0], 5, '_planFetch — mergeId matches the overlapping entry');
  assertEq(plan.fetchBBox.minLat, expectedUnion.minLat, '_planFetch — fetchBBox union minLat correct');
  assertEq(plan.fetchBBox.maxLat, expectedUnion.maxLat, '_planFetch — fetchBBox union maxLat correct');
  assertEq(plan.fetchBBox.minLon, expectedUnion.minLon, '_planFetch — fetchBBox union minLon correct');
  assertEq(plan.fetchBBox.maxLon, expectedUnion.maxLon, '_planFetch — fetchBBox union maxLon correct');
}

// 3h. _planFetch — multiple overlapping entries all merged into one union fetch
{
  const entries = [
    { id: 1, bbox: bboxA, queryVersion: 1, fetchedAt: now, data: 'A' },
    { id: 9, bbox: bboxPartial2, queryVersion: 1, fetchedAt: now, data: 'P2' },
  ];
  const plan = OsmCache._planFetch(entries, bboxPartial, 1, now);
  const expectedUnion = OsmCache._unionBBox([bboxPartial, bboxA, bboxPartial2]);
  assertEq(plan.mergeIds.slice().sort().join(','), '1,9', '_planFetch — both overlapping entries superseded');
  assertEq(plan.fetchBBox.minLat, expectedUnion.minLat, '_planFetch — multi-entry union minLat correct');
  assertEq(plan.fetchBBox.maxLon, expectedUnion.maxLon, '_planFetch — multi-entry union maxLon correct');
}

// 3i. _planFetch — oversized union skips the merge entirely
{
  // Overlaps bboxPartial on its southern edge but is enormous — union area
  // would blow past MAX_MERGE_AREA_KM2.
  const huge = { minLat: 50.0, minLon: -1.0, maxLat: 51.51, maxLon: 0.0 };
  assert(OsmCache._bboxIntersects(huge, bboxPartial), 'sanity: huge bbox overlaps bboxPartial (not full containment)');
  assert(!OsmCache._bboxContains(huge, bboxPartial), 'sanity: huge bbox does not fully contain bboxPartial');

  const entries = [{ id: 1, bbox: huge, queryVersion: 1, fetchedAt: now, data: 'huge' }];
  const plan = OsmCache._planFetch(entries, bboxPartial, 1, now);
  assertEq(plan.mergeIds.length, 0, '_planFetch — oversized union → merge skipped, no mergeIds');
  assertEq(plan.fetchBBox, bboxPartial, '_planFetch — oversized union → falls back to fetching just the request');
}

// ════════════════════════════════════════════════════════════════════════
//  4. _selectEvictions (LRU eviction selection)
// ════════════════════════════════════════════════════════════════════════
console.log('\n── OsmCache._selectEvictions ──');

// 4a. Under the cap → nothing evicted
{
  const entries = [1, 2, 3].map(id => ({ id, lastAccess: id }));
  const evictions = OsmCache._selectEvictions(entries, 5);
  assertEq(evictions.length, 0, '_selectEvictions — under cap → no evictions');
}

// 4b. Over the cap → evicts the oldest-lastAccess entries first
{
  const entries = [
    { id: 'a', lastAccess: 300 },
    { id: 'b', lastAccess: 100 }, // oldest
    { id: 'c', lastAccess: 200 },
    { id: 'd', lastAccess: 400 },
  ];
  const evictions = OsmCache._selectEvictions(entries, 2);
  const evictedIds = evictions.map(e => e.id).sort();
  assertEq(evictions.length, 2, '_selectEvictions — evicts exactly (count - cap) entries');
  assertEq(evictedIds.join(','), 'b,c', '_selectEvictions — evicts the two least-recently-accessed entries');
}

// 4c. Exactly at the cap → nothing evicted
{
  const entries = [1, 2].map(id => ({ id, lastAccess: id }));
  const evictions = OsmCache._selectEvictions(entries, 2);
  assertEq(evictions.length, 0, '_selectEvictions — exactly at cap → no evictions');
}

// ────────────────────────────────────────────────────────────────────────────
summary();
