/**
 * Regression test suite for the OSM environmental enrichment system:
 *   osm_enrichment.js (OSMEnricher) and map_match.js (MapMatcher).
 *
 * Neither module previously had any automated test coverage — this suite
 * exercises the pure spatial-math and pipeline-orchestration pieces of
 * both. Network access (OverpassClient.fetchOSMData) is never exercised
 * here; only local, offline computation is tested.
 *
 * Run: node tests/test_osm_enrichment.js
 */

// ── Bootstrap: emulate browser global scope ────────────────────────────────
// Same pattern as test_refactor.js: modules hang off `window` in the
// browser, so we load them via vm.runInThisContext and rewrite their
// top-level `const Name = ...` into `global.Name = ...`.

const vm = require('vm');
const fs = require('fs');

function loadModule(filePath, varName) {
  const src = fs.readFileSync(filePath, 'utf8');
  const wrapped = src.replace(
    new RegExp(`class ${varName}\\s*{`),
    `global.${varName} = class ${varName} {`
  ).replace(
    new RegExp(`const ${varName}\\s*=`),
    `global.${varName} =`
  );
  vm.runInThisContext(wrapped, { filename: filePath });
}

// Load order: GeoUtils and SpatialGrid first (osm_enrichment's
// buildSpatialIndex depends on SpatialGrid), then MapMatcher (osm_enrichment's
// HMM-snap path depends on it), then OSMEnricher itself. OverpassClient is
// deliberately NOT loaded — nothing in this suite calls
// OSMEnricher.fetchOSMData(), so it's never dereferenced.
loadModule(__dirname + '/../src/gps/geo_utils.js',      'GeoUtils');
loadModule(__dirname + '/../src/spatial/spatial_grid.js',   'SpatialGrid');
loadModule(__dirname + '/../src/gps/map_match.js',      'MapMatcher');
loadModule(__dirname + '/../src/osm/osm_enrichment.js', 'OSMEnricher');

const GeoUtils     = global.GeoUtils;
const MapMatcher   = global.MapMatcher;
const OSMEnricher  = global.OSMEnricher;

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

// ════════════════════════════════════════════════════════════════════════
//  1. OSMEnricher — bounding box & coordinate validation
// ════════════════════════════════════════════════════════════════════════
console.log('\n── OSMEnricher: bbox & coordinate validation ──');

// 1a. _isValidCoord — valid point
assert(OSMEnricher._isValidCoord(51.5, -0.1), '_isValidCoord valid point → true');

// 1b. _isValidCoord — null/undefined
assert(!OSMEnricher._isValidCoord(null, -0.1), '_isValidCoord null lat → false');
assert(!OSMEnricher._isValidCoord(51.5, undefined), '_isValidCoord undefined lon → false');

// 1c. _isValidCoord — NaN
assert(!OSMEnricher._isValidCoord(NaN, -0.1), '_isValidCoord NaN lat → false');

// 1d. _isValidCoord — (0,0) GPS-startup sentinel
assert(!OSMEnricher._isValidCoord(0, 0), '_isValidCoord (0,0) sentinel → false');
assert(!OSMEnricher._isValidCoord(0.0001, 0.0001), '_isValidCoord near-(0,0) → false');

// 1e. _isValidCoord — out of range
assert(!OSMEnricher._isValidCoord(100, 0), '_isValidCoord lat>90 → false');
assert(!OSMEnricher._isValidCoord(51.5, -200), '_isValidCoord lon<-180 → false');

// 1f. calculateBBox — filters invalid points, adds buffer
{
  const pts = [
    { lat: 51.500, lon: -0.100 },
    { lat: 51.510, lon: -0.090 },
    { lat: 0, lon: 0 }, // sentinel — must be excluded
  ];
  const bbox = OSMEnricher.calculateBBox(pts, 100);
  assert(bbox !== null, 'calculateBBox returns a bbox when valid points exist');
  // Buffer ≈ 100 m / 111320 m-per-degree ≈ 0.000898°
  const latBuf = 100 / 111320;
  assertClose(bbox.minLat, 51.500 - latBuf, 1e-6, 'calculateBBox minLat has buffer applied');
  assertClose(bbox.maxLat, 51.510 + latBuf, 1e-6, 'calculateBBox maxLat has buffer applied');
  assert(bbox.minLon < -0.100 && bbox.maxLon > -0.090, 'calculateBBox lon buffer applied');
}

// 1g. calculateBBox — all points invalid → null
assertEq(OSMEnricher.calculateBBox([{ lat: 0, lon: 0 }], 100), null, 'calculateBBox all-invalid → null');
assertEq(OSMEnricher.calculateBBox([], 100), null, 'calculateBBox empty → null');

// 1h. calculateBBoxAreaKm2 — known small bbox near the equator (cos≈1)
{
  const bbox = { minLat: 0, maxLat: 0.01, minLon: 0, maxLon: 0.01 };
  const area = OSMEnricher.calculateBBoxAreaKm2(bbox);
  // 0.01° ≈ 1.1132 km on a side at the equator → area ≈ 1.239 km²
  assertClose(area, 1.239, 0.02, 'calculateBBoxAreaKm2 ≈ 1.24 km² for 0.01°×0.01° at equator');
}

// ════════════════════════════════════════════════════════════════════════
//  2. OSMEnricher — geometry reconstruction
// ════════════════════════════════════════════════════════════════════════
console.log('\n── OSMEnricher: reconstructGeometries ──');

// 2a. Ways resolve node references into coordinates; tagged nodes become points
{
  const osmJson = {
    elements: [
      { type: 'node', id: 1, lat: 51.5000, lon: -0.1000 },
      { type: 'node', id: 2, lat: 51.5010, lon: -0.1000 },
      { type: 'node', id: 3, lat: 51.5000, lon: -0.1003, tags: { amenity: 'cafe' } },
      { type: 'way', id: 100, nodes: [1, 2], tags: { highway: 'residential' } },
    ]
  };
  const geoms = OSMEnricher.reconstructGeometries(osmJson);
  assertEq(geoms.ways.length, 1, 'reconstructGeometries — one way resolved');
  assertEq(geoms.ways[0].coordinates.length, 2, 'reconstructGeometries — way coordinates resolved from node refs');
  assertEq(geoms.points.length, 1, 'reconstructGeometries — one tagged node → point');
  assertEq(geoms.nodeMap.size, 3, 'reconstructGeometries — all nodes indexed');
  assertEq(geoms.relations.length, 0, 'reconstructGeometries — no relations');
}

// 2b. Relations resolve member ways into outerWays/innerWays
{
  const osmJson = {
    elements: [
      { type: 'node', id: 20, lat: 51.5020, lon: -0.1030 },
      { type: 'node', id: 21, lat: 51.5020, lon: -0.1010 },
      { type: 'node', id: 22, lat: 51.5030, lon: -0.1010 },
      { type: 'node', id: 23, lat: 51.5030, lon: -0.1030 },
      { type: 'way', id: 210, nodes: [20, 21, 22, 23, 20] },
      { type: 'relation', id: 300, tags: { leisure: 'park' },
        members: [{ type: 'way', ref: 210, role: 'outer' }] },
    ]
  };
  const geoms = OSMEnricher.reconstructGeometries(osmJson);
  assertEq(geoms.relations.length, 1, 'reconstructGeometries — one relation resolved');
  assertEq(geoms.relations[0].outerWays.length, 1, 'reconstructGeometries — outer way attached');
  assertEq(geoms.relations[0].outerWays[0].coordinates.length, 5, 'reconstructGeometries — outer way ring has 5 coords');
  assertEq(geoms.relations[0].innerWays.length, 0, 'reconstructGeometries — no inner ways (no hole)');
}

// 2c. Repeated calls with the SAME osmJson reference return the identical
// (===) geoms object instead of rebuilding — the cache collective-mode
// enrichment relies on when several tracks share one fetched osmJson.
{
  const osmJson = {
    elements: [
      { type: 'node', id: 1, lat: 51.5000, lon: -0.1000 },
      { type: 'node', id: 2, lat: 51.5010, lon: -0.1000 },
      { type: 'way', id: 100, nodes: [1, 2], tags: { highway: 'residential' } },
    ]
  };
  const first  = OSMEnricher.reconstructGeometries(osmJson);
  const second = OSMEnricher.reconstructGeometries(osmJson);
  assert(first === second, 'reconstructGeometries — same osmJson reference returns the cached (===) geoms object, not a fresh rebuild');

  const otherOsmJson = { elements: osmJson.elements.slice() }; // same content, different object identity
  const third = OSMEnricher.reconstructGeometries(otherOsmJson);
  assert(third !== first, 'reconstructGeometries — a different osmJson object (even with identical content) is rebuilt fresh, not cache-hit by content');
}

// 2d. Multipolygon relation with a hole: role:'inner' members resolve into
// innerWays, role:'outer' (and anything else) into outerWays.
{
  const osmJson = {
    elements: [
      { type: 'node', id: 40, lat: 51.500, lon: -0.100 },
      { type: 'node', id: 41, lat: 51.500, lon: -0.090 },
      { type: 'node', id: 42, lat: 51.510, lon: -0.090 },
      { type: 'node', id: 43, lat: 51.510, lon: -0.100 },
      { type: 'node', id: 50, lat: 51.503, lon: -0.097 },
      { type: 'node', id: 51, lat: 51.503, lon: -0.093 },
      { type: 'node', id: 52, lat: 51.507, lon: -0.093 },
      { type: 'node', id: 53, lat: 51.507, lon: -0.097 },
      { type: 'way', id: 400, nodes: [40, 41, 42, 43, 40] },   // outer ring
      { type: 'way', id: 401, nodes: [50, 51, 52, 53, 50] },   // inner ring (hole)
      { type: 'relation', id: 500, tags: { leisure: 'park' }, members: [
        { type: 'way', ref: 400, role: 'outer' },
        { type: 'way', ref: 401, role: 'inner' },
      ] },
    ]
  };
  const geoms = OSMEnricher.reconstructGeometries(osmJson);
  assertEq(geoms.relations[0].outerWays.length, 1, 'reconstructGeometries — outer member → outerWays');
  assertEq(geoms.relations[0].innerWays.length, 1, 'reconstructGeometries — inner member → innerWays (hole)');
  assertEq(geoms.relations[0].innerWays[0].coordinates.length, 5, 'reconstructGeometries — inner ring geometry resolved');
}

// ════════════════════════════════════════════════════════════════════════
//  3. OSMEnricher — spatial hash index
// ════════════════════════════════════════════════════════════════════════
console.log('\n── OSMEnricher: buildSpatialIndex / getNearby ──');

{
  const nearNode  = { type: 'node', id: 1, lat: 51.5000, lon: -0.1000, tags: { amenity: 'cafe' } };
  const nearWay   = { type: 'way', id: 2, tags: { highway: 'residential' },
                       coordinates: [{ lat: 51.5001, lon: -0.1001 }, { lat: 51.5002, lon: -0.1002 }] };
  const farWay    = { type: 'way', id: 3, tags: { highway: 'residential' },
                       coordinates: [{ lat: 52.0000, lon: 1.0000 }, { lat: 52.0001, lon: 1.0001 }] };

  const index = OSMEnricher.buildSpatialIndex({ points: [nearNode], ways: [nearWay, farWay], relations: [] });
  const nearby = index.getNearby(51.5000, -0.1000);

  assert(nearby.some(g => g.id === 1 && g.type === 'node'), 'getNearby includes the co-located node');
  assert(nearby.some(g => g.id === 2), 'getNearby includes a way in the same/neighbouring cell');
  assert(!nearby.some(g => g.id === 3), 'getNearby excludes a way ~150 km away');

  // De-duplication: querying twice near the same geometry shouldn't double-list it.
  const ids = nearby.map(g => `${g.type}_${g.id}`);
  assertEq(new Set(ids).size, ids.length, 'getNearby returns each geometry at most once');
}

// 3b. Repeated calls with the SAME geoms reference return the identical
// (===) index instead of rebuilding — mirrors reconstructGeometries's own
// cache (2c above), and matters for the same reason: multiple tracks sharing
// one osmJson resolve to the same cached geoms, so they should also resolve
// to the same cached spatial index rather than each re-walking every point/
// way/relation to rebuild it.
{
  const geoms = { points: [], ways: [{ type: 'way', id: 1, coordinates: [{ lat: 51.5, lon: -0.1 }, { lat: 51.51, lon: -0.1 }] }], relations: [] };
  const first  = OSMEnricher.buildSpatialIndex(geoms);
  const second = OSMEnricher.buildSpatialIndex(geoms);
  assert(first === second, 'buildSpatialIndex — same geoms reference returns the cached (===) index object, not a fresh rebuild');

  const otherGeoms = { points: [], ways: geoms.ways.slice(), relations: [] }; // same content, different object identity
  const third = OSMEnricher.buildSpatialIndex(otherGeoms);
  assert(third !== first, 'buildSpatialIndex — a different geoms object (even with identical content) is rebuilt fresh, not cache-hit by content');
}

// ════════════════════════════════════════════════════════════════════════
//  4. OSMEnricher — evaluation-point selection & thinning
// ════════════════════════════════════════════════════════════════════════
console.log('\n── OSMEnricher: _selectEvaluationPoints / _thinPoints ──');

// 4a. Selects points at ≥1s spacing, always includes the final point
{
  const times = [0, 0.3, 0.6, 0.9, 1.2, 1.5, 3.0, 3.05, 5.0];
  const raw = times.map(t => ({ time: t }));
  const gpsIndices = times.map((_, i) => ({ idx: i, lat: 0, lon: 0 }));
  const points = OSMEnricher._selectEvaluationPoints(raw, gpsIndices);
  const idxs = points.map(p => p.idx);
  assertEq(idxs.length, 4, '_selectEvaluationPoints keeps 4 of 9 points at ≥1s spacing');
  assert(idxs[idxs.length - 1] === 8, '_selectEvaluationPoints always includes the last GPS fix');
}

// 4b. Final point force-included even if it violates the 1s gate
{
  const times = [0, 0.2, 0.4];
  const raw = times.map(t => ({ time: t }));
  const gpsIndices = times.map((_, i) => ({ idx: i, lat: 0, lon: 0 }));
  const points = OSMEnricher._selectEvaluationPoints(raw, gpsIndices);
  assertEq(points.length, 2, '_selectEvaluationPoints force-includes last point → 2 points');
  assertEq(points[1].idx, 2, '_selectEvaluationPoints last point is idx 2');
}

// 4c. _thinPoints — spatially thins to a minimum distance, keeps first & last
{
  // ~1 m of latitude per step (111320 m per degree)
  const stepDeg = 1 / 111320;
  const points = [];
  for (let i = 0; i < 5; i++) points.push({ idx: i, lat: i * stepDeg, lon: 0 });
  const kept = OSMEnricher._thinPoints(points, 3); // min 3 m spacing
  const idxs = kept.map(p => p.idx);
  assertEq(idxs[0], 0, '_thinPoints keeps first point');
  assertEq(idxs[idxs.length - 1], 4, '_thinPoints always keeps last point');
  assert(idxs.length < points.length, '_thinPoints reduces point count when spacing < minDist');
}

// 4d. _thinPoints — passthrough for <3 points
{
  const points = [{ idx: 0, lat: 0, lon: 0 }, { idx: 1, lat: 1, lon: 1 }];
  const kept = OSMEnricher._thinPoints(points, 3);
  assert(kept === points, '_thinPoints passes through unchanged when input has <3 points');
}

// ════════════════════════════════════════════════════════════════════════
//  5. OSMEnricher — _evaluatePosition (per-point environmental metrics)
// ════════════════════════════════════════════════════════════════════════
console.log('\n── OSMEnricher: _evaluatePosition ──');

// 4b. Green-space sampling grid: the outer ring must reach the *full* search
// radius, not 2/3 of it (SAMPLING_RINGS / POINTS_PER_RING were off by one so
// the nominal outer ring produced zero points and coverage stopped at ~33 m
// of a 50 m radius).
{
  const grid = global._buildSamplingGrid(51.5, -0.1, 50);
  let maxD = 0;
  for (const p of grid) {
    maxD = Math.max(maxD, GeoUtils.haversineMeters(51.5, -0.1, p.lat, p.lon));
  }
  assert(grid.length === 25, `_buildSamplingGrid — 1 centre + 8 + 16 = 25 points (got ${grid.length})`);
  assertClose(maxD, 50, 2, `_buildSamplingGrid — outer ring reaches the full radius (max dist ${maxD.toFixed(1)} m, expected ~50)`);
}

const roadGeom = {
  type: 'way', id: 'road', tags: { highway: 'motorway' },
  coordinates: [{ lat: 51.5000, lon: -0.1000 }, { lat: 51.5010, lon: -0.1000 }]
};
const buildingGeom = {
  type: 'way', id: 'bldg', tags: { building: 'yes' },
  coordinates: [
    { lat: 51.5001, lon: -0.1010 }, { lat: 51.5001, lon: -0.1008 },
    { lat: 51.5003, lon: -0.1008 }, { lat: 51.5003, lon: -0.1010 }
  ]
};
const waterGeom = {
  type: 'way', id: 'water', tags: { natural: 'water' },
  coordinates: [{ lat: 51.4990, lon: -0.1050 }, { lat: 51.4995, lon: -0.1050 }]
};
const treeGeom = { type: 'node', id: 'tree', tags: { natural: 'tree' }, lat: 51.5001, lon: -0.1001 };
const cafeGeom = { type: 'node', id: 'cafe', tags: { amenity: 'cafe' }, lat: 51.5000, lon: -0.1003 };
const parkGeom = {
  type: 'way', id: 'park', tags: { leisure: 'park' },
  coordinates: [
    { lat: 51.5020, lon: -0.1030 }, { lat: 51.5020, lon: -0.1010 },
    { lat: 51.5030, lon: -0.1010 }, { lat: 51.5030, lon: -0.1030 }
  ]
};
const allGeoms = [roadGeom, buildingGeom, waterGeom, treeGeom, cafeGeom, parkGeom];

// 5a. Point well inside the park: inPark=1, greenSpacePct=100 (sampling radius
//     50 m is small relative to the ~55-70 m margin to every park edge)
{
  const m = OSMEnricher._evaluatePosition(51.5025, -0.1020, allGeoms, 50);
  assertEq(m.inPark, 1, '_evaluatePosition — point inside park → inPark=1');
  assertEq(m.greenSpacePct, 100, '_evaluatePosition — sampling grid fully inside park → 100%');
  assertEq(m.roadClass, 'motorway', '_evaluatePosition — nearest (only) road classified correctly');

  const expectedRoadDist = GeoUtils.distanceToSegmentMeters(
    51.5025, -0.1020, roadGeom.coordinates[0].lat, roadGeom.coordinates[0].lon,
    roadGeom.coordinates[1].lat, roadGeom.coordinates[1].lon);
  assertClose(m.distMajorRoad, expectedRoadDist, 0.5, '_evaluatePosition — distMajorRoad matches distanceToSegment');

  const expectedWaterDist = GeoUtils.distanceToSegmentMeters(
    51.5025, -0.1020, waterGeom.coordinates[0].lat, waterGeom.coordinates[0].lon,
    waterGeom.coordinates[1].lat, waterGeom.coordinates[1].lon);
  assertClose(m.distWater, expectedWaterDist, 0.5, '_evaluatePosition — distWater matches distanceToSegment');

  // Building/tree/amenity are all >250 m away — well outside the 50 m radius.
  assertEq(m.buildingDensity, 0, '_evaluatePosition — distant building not counted within 50 m radius');
  assertEq(m.treeDensity, 0, '_evaluatePosition — distant tree not counted within 50 m radius');
  assertEq(m.amenityCount, 0, '_evaluatePosition — distant amenity not counted within 50 m radius');
}

// 5b. Point outside the park → inPark=0, greenSpacePct=0
{
  const m = OSMEnricher._evaluatePosition(51.4000, -0.2000, allGeoms, 50);
  assertEq(m.inPark, 0, '_evaluatePosition — point outside park → inPark=0');
  assertEq(m.greenSpacePct, 0, '_evaluatePosition — sampling grid entirely outside park → 0%');
}

// 5c. Querying on/at each feature (distance ≈ 0) counts it — exactly once,
//     since allGeoms holds a single building / tree / amenity.
{
  const mBuilding = OSMEnricher._evaluatePosition(51.5002, -0.1009, allGeoms, 50); // on the footprint
  assertEq(mBuilding.buildingDensity, 1, '_evaluatePosition — the one building is counted (once) when the query point is on it');

  const mTree = OSMEnricher._evaluatePosition(treeGeom.lat, treeGeom.lon, allGeoms, 50);
  assertEq(mTree.treeDensity, 1, '_evaluatePosition — the one tree is counted (once) at its own coordinate');

  const mCafe = OSMEnricher._evaluatePosition(cafeGeom.lat, cafeGeom.lon, allGeoms, 50);
  assertEq(mCafe.amenityCount, 1, '_evaluatePosition — the one amenity is counted (once) at its own coordinate');
}

// 5e. A close motor-traffic road (<=25 m) takes the road-class label over a
//     closer footway; a road further off does not relabel where you are; a
//     footway alone still shows.
{
  const footway = {
    type: 'way', id: 'fw', tags: { highway: 'footway' },
    coordinates: [{ lat: 51.49990, lon: -0.09996 }, { lat: 51.50010, lon: -0.09996 }]  // ~4 m E
  };
  const closeRes = {                                                                    // ~13 m E
    type: 'way', id: 'res', tags: { highway: 'residential' },
    coordinates: [{ lat: 51.49990, lon: -0.09988 }, { lat: 51.50010, lon: -0.09988 }]
  };
  const near = OSMEnricher._evaluatePosition(51.5000, -0.1000, [footway, closeRes], 50);
  assertEq(near.roadClass, 'residential',
    '_evaluatePosition — a close (<=25 m) vehicular road wins the class label over a nearer footway');

  const footOnly = OSMEnricher._evaluatePosition(51.5000, -0.1000, [footway], 50);
  assertEq(footOnly.roadClass, 'footway',
    '_evaluatePosition — footway still labelled when it is the only highway in range');

  const midRes = {                                                                      // ~28 m E
    type: 'way', id: 'res2', tags: { highway: 'residential' },
    coordinates: [{ lat: 51.49990, lon: -0.09975 }, { lat: 51.50010, lon: -0.09975 }]
  };
  const mid = OSMEnricher._evaluatePosition(51.5000, -0.1000, [footway, midRes], 50);
  assertEq(mid.roadClass, 'footway',
    '_evaluatePosition — a vehicular road >25 m off does not relabel a location on a footway');
}

// 5f. Non-road `highway=*` values (point features, lifecycle tags) are ignored
//     for road classification — the unfiltered `way["highway"]` query pulls
//     them in but they must not win the class label or seed a Roads Profile row.
{
  const construction = {
    type: 'way', id: 'con', tags: { highway: 'construction' },
    coordinates: [{ lat: 51.49995, lon: -0.10000 }, { lat: 51.50005, lon: -0.10000 }]  // ~0 m
  };
  const platform = {
    type: 'way', id: 'plat', tags: { highway: 'platform' },
    coordinates: [{ lat: 51.49995, lon: -0.09999 }, { lat: 51.50005, lon: -0.09999 }]  // ~1 m
  };
  const onlyJunk = OSMEnricher._evaluatePosition(51.5000, -0.1000, [construction, platform], 50);
  assertEq(onlyJunk.roadClass, 'none',
    '_evaluatePosition — construction / platform highways do not become the road class');

  const residential = {
    type: 'way', id: 'res3', tags: { highway: 'residential' },
    coordinates: [{ lat: 51.49990, lon: -0.09980 }, { lat: 51.50010, lon: -0.09980 }]  // ~14 m
  };
  const mix = OSMEnricher._evaluatePosition(51.5000, -0.1000, [construction, residential], 50);
  assertEq(mix.roadClass, 'residential',
    '_evaluatePosition — a real road wins even when a closer highway is a lifecycle/non-road tag');
}

// 5g. Buildings are counted by nearest footprint edge (not centroid) and
//     multipolygon `relation["building"]` footprints count too.
{
  const bigBldg = {
    type: 'way', id: 'big', tags: { building: 'commercial' },
    coordinates: [
      { lat: 51.50010, lon: -0.10000 },   // near edge ~11 m N of the query point
      { lat: 51.50010, lon: -0.09800 },   // footprint extends ~140 m east
      { lat: 51.50200, lon: -0.09800 },
      { lat: 51.50200, lon: -0.10000 },
      { lat: 51.50010, lon: -0.10000 }
    ]
  };
  const mBig = OSMEnricher._evaluatePosition(51.5000, -0.1000, [bigBldg], 50);
  assertEq(mBig.buildingDensity, 1,
    '_evaluatePosition — large building counted by its near edge though its centroid is >50 m away');

  const bldgRelation = {
    type: 'relation', id: 'br1', tags: { building: 'yes' },
    outerWays: [{ coordinates: [
      { lat: 51.50005, lon: -0.10005 }, { lat: 51.50005, lon: -0.09995 },
      { lat: 51.50015, lon: -0.09995 }, { lat: 51.50015, lon: -0.10005 },
      { lat: 51.50005, lon: -0.10005 }
    ] }]
  };
  const mRel = OSMEnricher._evaluatePosition(51.5000, -0.1000, [bldgRelation], 50);
  assertEq(mRel.buildingDensity, 1,
    '_evaluatePosition — a multipolygon relation building is counted');

  const farRel = {
    type: 'relation', id: 'br2', tags: { building: 'yes' },
    outerWays: [{ coordinates: [
      { lat: 51.50300, lon: -0.10300 }, { lat: 51.50300, lon: -0.10290 },
      { lat: 51.50310, lon: -0.10290 }, { lat: 51.50310, lon: -0.10300 },
      { lat: 51.50300, lon: -0.10300 }
    ] }]
  };
  const mFarRel = OSMEnricher._evaluatePosition(51.5000, -0.1000, [farRel], 50);
  assertEq(mFarRel.buildingDensity, 0,
    '_evaluatePosition — a relation building well outside the radius is not counted');
}

// 5h. Roads nearby but none of them a major road → the nearest way still sets
//     roadClass, but distMajorRoad stays at the 999 "none" sentinel.
{
  const residential = {
    type: 'way', id: 'r-only', tags: { highway: 'residential' },
    coordinates: [{ lat: 51.49990, lon: -0.10000 }, { lat: 51.50010, lon: -0.10000 }]
  };
  const m = OSMEnricher._evaluatePosition(51.5000, -0.10010, [residential], 50);
  assertEq(m.roadClass, 'residential',
    '_evaluatePosition — nearest non-major road still classifies the location');
  assertEq(m.distMajorRoad, 999,
    '_evaluatePosition — no motorway/trunk/primary/secondary nearby → distMajorRoad sentinel 999');
}

// 5i. Water distance is also computed for multipolygon `relation` water bodies
//     (a lake mapped as natural=water on a relation), not just `way` water.
{
  const lakeRelation = {
    type: 'relation', id: 'lake', tags: { natural: 'water' },
    outerWays: [{ coordinates: [
      { lat: 51.50030, lon: -0.10030 }, { lat: 51.50030, lon: -0.09970 },
      { lat: 51.50070, lon: -0.09970 }, { lat: 51.50070, lon: -0.10030 },
      { lat: 51.50030, lon: -0.10030 }
    ] }]
  };
  const m = OSMEnricher._evaluatePosition(51.5000, -0.1000, [lakeRelation], 80);
  const nearestEdge = GeoUtils.distanceToSegmentMeters(
    51.5000, -0.1000, 51.50030, -0.10030, 51.50030, -0.09970);
  assert(m.distWater < 999,
    '_evaluatePosition — a relation water body produces a real distance, not the sentinel');
  assertClose(m.distWater, nearestEdge, 1.5,
    '_evaluatePosition — relation water distance matches the nearest outer-ring edge');
}

// 5j. Amenity count spans shops (any `shop=*`), bus stops (`highway=bus_stop`),
//     and way-mapped amenities (counted at their centroid); an `amenity=*`
//     value not in AMENITY_TYPES does not count.
{
  const shopNode  = { type: 'node', id: 's1', tags: { shop: 'bakery' },       lat: 51.50010, lon: -0.1000 };
  const busStop   = { type: 'node', id: 'b1', tags: { highway: 'bus_stop' },  lat: 51.50000, lon: -0.10015 };
  const benchNode = { type: 'node', id: 'x1', tags: { amenity: 'bench' },     lat: 51.50005, lon: -0.1000 };
  const cafeWay   = {
    type: 'way', id: 'w1', tags: { amenity: 'cafe' },
    coordinates: [
      { lat: 51.49995, lon: -0.09990 }, { lat: 51.49995, lon: -0.09985 },
      { lat: 51.50005, lon: -0.09985 }, { lat: 51.50005, lon: -0.09990 }
    ]
  };
  const m = OSMEnricher._evaluatePosition(51.5000, -0.1000, [shopNode, busStop, benchNode, cafeWay], 50);
  assertEq(m.amenityCount, 3,
    '_evaluatePosition — shop + bus stop + way-mapped cafe counted; amenity=bench (not in AMENITY_TYPES) excluded');
}

// 5k. Green space is recognised via `landuse` and `natural` tags too (not only
//     `leisure`), and a multipolygon relation's inner ring (a hole) is excluded
//     from the "in park" test.
{
  const forestWay = {
    type: 'way', id: 'forest', tags: { landuse: 'forest' },
    coordinates: [
      { lat: 51.49990, lon: -0.10010 }, { lat: 51.49990, lon: -0.09990 },
      { lat: 51.50010, lon: -0.09990 }, { lat: 51.50010, lon: -0.10010 },
      { lat: 51.49990, lon: -0.10010 }
    ]
  };
  assertEq(OSMEnricher._evaluatePosition(51.5000, -0.1000, [forestWay], 20).inPark, 1,
    '_evaluatePosition — landuse=forest counts as green space');

  const heathWay = {
    type: 'way', id: 'heath', tags: { natural: 'heath' },
    coordinates: forestWay.coordinates.map(c => ({ ...c }))
  };
  assertEq(OSMEnricher._evaluatePosition(51.5000, -0.1000, [heathWay], 20).inPark, 1,
    '_evaluatePosition — natural=heath counts as green space');

  const parkWithHole = {
    type: 'relation', id: 'ph', tags: { leisure: 'park' },
    outerWays: [{ coordinates: [
      { lat: 51.4990, lon: -0.1010 }, { lat: 51.4990, lon: -0.0990 },
      { lat: 51.5010, lon: -0.0990 }, { lat: 51.5010, lon: -0.1010 },
      { lat: 51.4990, lon: -0.1010 }
    ] }],
    innerWays: [{ coordinates: [
      { lat: 51.4998, lon: -0.1002 }, { lat: 51.4998, lon: -0.0998 },
      { lat: 51.5002, lon: -0.0998 }, { lat: 51.5002, lon: -0.1002 },
      { lat: 51.4998, lon: -0.1002 }
    ] }]
  };
  assertEq(OSMEnricher._evaluatePosition(51.5000, -0.1000, [parkWithHole], 20).inPark, 0,
    '_evaluatePosition — a point inside the relation\'s inner ring (hole) is NOT in the park');
  assertEq(OSMEnricher._evaluatePosition(51.5006, -0.1000, [parkWithHole], 20).inPark, 1,
    '_evaluatePosition — inside the outer ring but outside the hole → in the park');
}

// 5l. natural=wetland is BOTH blue and green: it counts toward dist_water AND
//     toward in_park / green_pct from the one feature. leisure=playground is
//     NOT green (rubber surfacing + steel, not vegetated nature).
{
  const wetlandWay = {
    type: 'way', id: 'marsh', tags: { natural: 'wetland' },
    coordinates: [
      { lat: 51.4995, lon: -0.1005 }, { lat: 51.4995, lon: -0.0995 },
      { lat: 51.5005, lon: -0.0995 }, { lat: 51.5005, lon: -0.1005 },
      { lat: 51.4995, lon: -0.1005 }
    ]
  };
  assert(OSMEnricher.isGreenSpace(wetlandWay), 'isGreenSpace(natural=wetland) → true');
  assert(OSMEnricher.isWaterSpace(wetlandWay), 'isWaterSpace(natural=wetland) → true (still blue)');

  const m = OSMEnricher._evaluatePosition(51.5000, -0.1000, [wetlandWay], 20);
  assertEq(m.inPark, 1, '_evaluatePosition — inside a wetland → in_park = 1 (wetland is green)');
  assertEq(m.greenSpacePct, 100, '_evaluatePosition — sampling grid inside the wetland → 100% green');
  assertEq(m.distGreen, 0, '_evaluatePosition — standing in the wetland → dist_green = 0');
  const expWater = GeoUtils.distanceToSegmentMeters(51.5000, -0.1000, 51.4995, -0.0995, 51.5005, -0.0995);
  assert(m.distWater < 999, '_evaluatePosition — the same wetland also produces a real dist_water (still blue)');
  assertClose(m.distWater, expWater, 0.5, '_evaluatePosition — wetland dist_water is the distance to its nearest edge');

  const playgroundWay = {
    type: 'way', id: 'pg', tags: { leisure: 'playground' },
    coordinates: [
      { lat: 51.4998, lon: -0.1002 }, { lat: 51.4998, lon: -0.0998 },
      { lat: 51.5002, lon: -0.0998 }, { lat: 51.5002, lon: -0.1002 },
      { lat: 51.4998, lon: -0.1002 }
    ]
  };
  assert(!OSMEnricher.isGreenSpace(playgroundWay), 'isGreenSpace(leisure=playground) → false');
  const mp = OSMEnricher._evaluatePosition(51.5000, -0.1000, [playgroundWay], 15);
  assertEq(mp.inPark, 0, '_evaluatePosition — standing on a playground → in_park = 0 (not green space)');
  assertEq(mp.greenSpacePct, 0, '_evaluatePosition — playground contributes 0% green coverage');
  assertEq(mp.distGreen, 999, '_evaluatePosition — a playground is not green, so it does not set dist_green');
}

// 5m. osm_dist_green — the "you can see the park from here" channel: 0 inside a
//     green space, the edge distance when outside it, and for a green space
//     with a hole, the distance to the *nearest* boundary (inner hole edge
//     included), not the far outer ring.
{
  const park = {
    type: 'way', id: 'park5m', tags: { leisure: 'park' },
    coordinates: [
      { lat: 51.5010, lon: -0.1010 }, { lat: 51.5010, lon: -0.0990 },
      { lat: 51.5030, lon: -0.0990 }, { lat: 51.5030, lon: -0.1010 },
      { lat: 51.5010, lon: -0.1010 }
    ]
  };
  // A point ~55 m south of the park's southern edge (lat 51.5010).
  const outside = OSMEnricher._evaluatePosition(51.5005, -0.1000, [park], 50);
  assertEq(outside.inPark, 0, '_evaluatePosition — point is outside the park');
  const expEdge = GeoUtils.distanceToSegmentMeters(51.5005, -0.1000, 51.5010, -0.1010, 51.5010, -0.0990);
  assertClose(outside.distGreen, expEdge, 0.5,
    '_evaluatePosition — dist_green outside a park is the distance to its nearest edge');
  assert(outside.distGreen > 0 && outside.distGreen < 999,
    '_evaluatePosition — a nearby-but-not-entered park gives a real dist_green, not 0 and not the sentinel');

  // Inside the same park → 0.
  assertEq(OSMEnricher._evaluatePosition(51.5020, -0.1000, [park], 30).distGreen, 0,
    '_evaluatePosition — inside the park → dist_green = 0');

  // No green anywhere in range → sentinel.
  assertEq(OSMEnricher._evaluatePosition(51.5005, -0.1000, [], 50).distGreen, 999,
    '_evaluatePosition — no green space in range → dist_green sentinel 999');

  // Green space with a hole: standing in the hole is NOT in the park, and the
  // nearest green boundary is the inner (hole) ring, not the distant outer ring.
  const parkWithHole = {
    type: 'relation', id: 'phole', tags: { leisure: 'park' },
    outerWays: [{ coordinates: [
      { lat: 51.4980, lon: -0.1040 }, { lat: 51.4980, lon: -0.0960 },
      { lat: 51.5020, lon: -0.0960 }, { lat: 51.5020, lon: -0.1040 },
      { lat: 51.4980, lon: -0.1040 }
    ] }],
    innerWays: [{ coordinates: [
      { lat: 51.4998, lon: -0.1004 }, { lat: 51.4998, lon: -0.0996 },
      { lat: 51.5002, lon: -0.0996 }, { lat: 51.5002, lon: -0.1004 },
      { lat: 51.4998, lon: -0.1004 }
    ] }]
  };
  const inHole = OSMEnricher._evaluatePosition(51.5000, -0.1000, [parkWithHole], 40);
  assertEq(inHole.inPark, 0, '_evaluatePosition — a point inside the hole is not in the park');
  const expInner = GeoUtils.distanceToSegmentMeters(51.5000, -0.1000, 51.5002, -0.0996, 51.5002, -0.1004);
  assertClose(inHole.distGreen, expInner, 1.0,
    '_evaluatePosition — dist_green from inside a hole is the distance to the inner (hole) ring, not the far outer ring');
  assert(inHole.distGreen < 60,
    '_evaluatePosition — the hole edge (~22 m) is much nearer than the outer ring (~220 m)');
}

// 5n. osm_canopy_pct_50m — "am I under / among trees", the other half of
//     perceived green: wood/forest polygons, plus a ~10 m buffer around
//     natural=tree_row ways and natural=tree nodes. Independent of green_pct
//     (a grass park has green_pct high, canopy_pct 0).
{
  // A wood polygon big enough to contain the whole 20 m sampling grid.
  const wood = {
    type: 'way', id: 'wood5n', tags: { natural: 'wood' },
    coordinates: [
      { lat: 51.4990, lon: -0.1010 }, { lat: 51.4990, lon: -0.0990 },
      { lat: 51.5010, lon: -0.0990 }, { lat: 51.5010, lon: -0.1010 },
      { lat: 51.4990, lon: -0.1010 }
    ]
  };
  assertEq(OSMEnricher._evaluatePosition(51.5000, -0.1000, [wood], 20).canopyPct, 100,
    '_evaluatePosition — sampling grid inside a natural=wood polygon → canopy 100%');

  const forest = { ...wood, id: 'forest5n', tags: { landuse: 'forest' } };
  assertEq(OSMEnricher._evaluatePosition(51.5000, -0.1000, [forest], 20).canopyPct, 100,
    '_evaluatePosition — landuse=forest polygon counts as canopy too');

  // A grass park — green, but no trees.
  const grassPark = { ...wood, id: 'grass5n', tags: { leisure: 'park' } };
  const gp = OSMEnricher._evaluatePosition(51.5000, -0.1000, [grassPark], 20);
  assertEq(gp.greenSpacePct, 100, '_evaluatePosition — grass park is green');
  assertEq(gp.canopyPct, 0, '_evaluatePosition — grass park has no canopy (canopy_pct decoupled from green_pct)');

  // A tree_row way ~2 m from the query point: the centre + nearby grid points
  // fall inside its ~10 m buffer, so canopy is > 0 but < 100.
  const treeRow = {
    type: 'way', id: 'row5n', tags: { natural: 'tree_row' },
    coordinates: [{ lat: 51.49990, lon: -0.09997 }, { lat: 51.50010, lon: -0.09997 }]  // ~2 m east, N-S
  };
  const rowM = OSMEnricher._evaluatePosition(51.5000, -0.1000, [treeRow], 20);
  assert(rowM.canopyPct > 0 && rowM.canopyPct < 100,
    `_evaluatePosition — a nearby tree_row gives partial canopy (got ${rowM.canopyPct}%)`);

  // Same tree_row moved ~40 m away → outside every sample point's 10 m buffer.
  const farRow = {
    type: 'way', id: 'farrow5n', tags: { natural: 'tree_row' },
    coordinates: [{ lat: 51.49990, lon: -0.09943 }, { lat: 51.50010, lon: -0.09943 }]
  };
  assertEq(OSMEnricher._evaluatePosition(51.5000, -0.1000, [farRow], 20).canopyPct, 0,
    '_evaluatePosition — a tree_row well beyond the crown buffer contributes no canopy');

  // A single natural=tree node ~3 m away → the centre sample point is under it.
  const treeNode = { type: 'node', id: 'tree5n', tags: { natural: 'tree' }, lat: 51.50003, lon: -0.1000 };
  assert(OSMEnricher._evaluatePosition(51.5000, -0.1000, [treeNode], 20).canopyPct > 0,
    '_evaluatePosition — a natural=tree node within the crown buffer adds canopy');

  assertEq(OSMEnricher._evaluatePosition(51.5000, -0.1000, [], 20).canopyPct, 0,
    '_evaluatePosition — no canopy features → canopy_pct 0');
}

// 5d. No nearby geometries at all → sentinel distances, zero counts
{
  const m = OSMEnricher._evaluatePosition(0, 0, [], 50);
  assertEq(m.roadClass, 'none', '_evaluatePosition — no roads → roadClass "none"');
  assertEq(m.distMajorRoad, 999, '_evaluatePosition — no major road → sentinel 999');
  assertEq(m.distWater, 999, '_evaluatePosition — no water → sentinel 999');
  assertEq(m.inPark, 0, '_evaluatePosition — no parks → inPark=0');
  assertEq(m.greenSpacePct, 0, '_evaluatePosition — no parks → greenSpacePct=0');
  assertEq(m.canopyPct, 0, '_evaluatePosition — no trees → canopyPct=0');
  assertEq(m.distGreen, 999, '_evaluatePosition — no green space → dist_green sentinel 999');
  assertEq(m.buildingDensity, 0, '_evaluatePosition — no buildings → 0');
  assertEq(m.treeDensity, 0, '_evaluatePosition — no trees → 0');
  assertEq(m.amenityCount, 0, '_evaluatePosition — no amenities → 0');
}

// ════════════════════════════════════════════════════════════════════════
//  6. OSMEnricher — _projectToTimeline (interpolation back to full rate)
// ════════════════════════════════════════════════════════════════════════
console.log('\n── OSMEnricher: _projectToTimeline ──');

{
  const computedMetrics = [
    { idx: 0,  metrics: { roadClass: 'residential', inPark: 0, distMajorRoad: 100, greenSpacePct: 0, distGreen: 40, canopyPct: 0,
                           buildingDensity: 1, distWater: 200, treeDensity: 0, amenityCount: 0 } },
    { idx: 10, metrics: { roadClass: 'primary', inPark: 1, distMajorRoad: 0, greenSpacePct: 100, distGreen: 0, canopyPct: 80,
                           buildingDensity: 5, distWater: 0, treeDensity: 3, amenityCount: 2 } },
  ];
  const raw = Array.from({ length: 11 }, () => ({}));
  OSMEnricher._projectToTimeline(raw, computedMetrics);

  assertClose(raw[5].osm_dist_green, 20, 1e-9, '_projectToTimeline — dist_green lerps like the other distance fields (40 → 0 at the midpoint)');
  assertClose(raw[5].osm_canopy_pct_50m, 40, 1e-9, '_projectToTimeline — canopy_pct lerps like green_pct (0 → 80 at the midpoint)');
  assertEq(raw[0].osm_road_class, 'residential', '_projectToTimeline — first anchor exact');
  assertEq(raw[10].osm_road_class, 'primary', '_projectToTimeline — last anchor exact');
  assertClose(raw[0].osm_dist_major_road, 100, 1e-9, '_projectToTimeline — first anchor continuous value exact');
  assertClose(raw[10].osm_dist_major_road, 0, 1e-9, '_projectToTimeline — last anchor continuous value exact');

  // Midpoint: truly continuous values (distance, green %) linearly interpolated;
  // categorical + discrete-count fields step at t>=0.5.
  assertClose(raw[5].osm_dist_major_road, 50, 1e-9, '_projectToTimeline — midpoint lerp of continuous distance');
  assertClose(raw[5].osm_green_pct_50m, 50, 1e-9, '_projectToTimeline — midpoint lerp of green %');
  assertEq(raw[5].osm_road_class, 'primary', '_projectToTimeline — categorical switches at t>=0.5');
  assertEq(raw[4].osm_road_class, 'residential', '_projectToTimeline — categorical stays prev value at t<0.5');
  // Discrete counts step (no fractional buildings/trees/amenities).
  assertEq(raw[4].osm_building_density_50m, 1, '_projectToTimeline — count field holds prev value at t<0.5');
  assertEq(raw[5].osm_building_density_50m, 5, '_projectToTimeline — count field steps to next at t>=0.5');
  assertEq(raw[4].osm_tree_density_50m, 0, '_projectToTimeline — tree count steps, not lerps (t<0.5)');
  assertEq(raw[6].osm_tree_density_50m, 3, '_projectToTimeline — tree count steps, not lerps (t>=0.5)');
  assertEq(raw[4].osm_amenity_count_50m, 0, '_projectToTimeline — amenity count steps, not lerps (t<0.5)');
  assertEq(raw[6].osm_amenity_count_50m, 2, '_projectToTimeline — amenity count steps, not lerps (t>=0.5)');
}

// 6a-sentinel. Distance fields must NOT lerp across the SENTINEL_DIST marker
// ("no feature within radius" = 999) — a lerp would manufacture bogus
// mid-range distances. When exactly one endpoint is the sentinel, hold the
// *real* endpoint's value across the whole segment (stepping to the sentinel
// at the midpoint would silently drop half the transition from every consumer
// that filters === 999). Both endpoints sentinel → sentinel. Green % still lerps.
{
  const computedMetrics = [
    { idx: 0,  metrics: { roadClass: 'residential', inPark: 0, distMajorRoad: 999, greenSpacePct: 0, distGreen: 999, canopyPct: 0,
                           buildingDensity: 1, distWater: 999, treeDensity: 0, amenityCount: 0 } },
    { idx: 10, metrics: { roadClass: 'primary', inPark: 1, distMajorRoad: 8, greenSpacePct: 100, distGreen: 15, canopyPct: 50,
                           buildingDensity: 5, distWater: 12, treeDensity: 3, amenityCount: 2 } },
  ];
  const raw = Array.from({ length: 11 }, () => ({}));
  OSMEnricher._projectToTimeline(raw, computedMetrics);

  assertClose(raw[3].osm_dist_green, 15, 1e-9, '_projectToTimeline — dist_green: real endpoint held past a sentinel (t<0.5)');
  assertClose(raw[7].osm_dist_green, 15, 1e-9, '_projectToTimeline — dist_green: real endpoint held past a sentinel (t>=0.5)');
  assertClose(raw[3].osm_dist_major_road, 8, 1e-9, '_projectToTimeline — sentinel prev endpoint: real value held across the segment (t<0.5)');
  assertClose(raw[7].osm_dist_major_road, 8, 1e-9, '_projectToTimeline — sentinel prev endpoint: real value held across the segment (t>=0.5)');
  assertClose(raw[3].osm_dist_water,      12, 1e-9, '_projectToTimeline — water dist: real value held past a sentinel endpoint (t<0.5)');
  assertClose(raw[7].osm_dist_water,      12, 1e-9, '_projectToTimeline — water dist: real value held past a sentinel endpoint (t>=0.5)');
  assertClose(raw[5].osm_green_pct_50m,   50,  1e-9, '_projectToTimeline — green % still lerps normally alongside a sentinel distance');
}

// 6a-sentinel-both. Both endpoints sentinel → the whole segment is sentinel.
{
  const computedMetrics = [
    { idx: 0,  metrics: { roadClass: 'none', inPark: 0, distMajorRoad: 999, greenSpacePct: 0, distGreen: 999, canopyPct: 0,
                           buildingDensity: 0, distWater: 999, treeDensity: 0, amenityCount: 0 } },
    { idx: 10, metrics: { roadClass: 'none', inPark: 0, distMajorRoad: 999, greenSpacePct: 0, distGreen: 999, canopyPct: 0,
                           buildingDensity: 0, distWater: 999, treeDensity: 0, amenityCount: 0 } },
  ];
  const raw = Array.from({ length: 11 }, () => ({}));
  OSMEnricher._projectToTimeline(raw, computedMetrics);
  assertClose(raw[5].osm_dist_major_road, 999, 1e-9, '_projectToTimeline — both endpoints sentinel → segment stays sentinel');
  assertClose(raw[5].osm_dist_water,      999, 1e-9, '_projectToTimeline — both endpoints sentinel (water) → segment stays sentinel');
  assertClose(raw[5].osm_dist_green,      999, 1e-9, '_projectToTimeline — both endpoints sentinel (green) → segment stays sentinel');
}

// 6b. Single evaluation point → broadcast to entire timeline
{
  const computedMetrics = [
    { idx: 1, metrics: { roadClass: 'path', inPark: 1, distMajorRoad: 5, greenSpacePct: 80, distGreen: 0, canopyPct: 65,
                          buildingDensity: 2, distWater: 10, treeDensity: 1, amenityCount: 1 } }
  ];
  const raw = Array.from({ length: 3 }, () => ({}));
  OSMEnricher._projectToTimeline(raw, computedMetrics);
  for (let i = 0; i < 3; i++) {
    assertEq(raw[i].osm_road_class, 'path', `_projectToTimeline — single-eval broadcast row ${i}`);
    assertClose(raw[i].osm_dist_major_road, 5, 1e-9, `_projectToTimeline — single-eval broadcast continuous row ${i}`);
    assertEq(raw[i].osm_dist_green, 0, `_projectToTimeline — single-eval broadcast dist_green row ${i}`);
    assertEq(raw[i].osm_canopy_pct_50m, 65, `_projectToTimeline — single-eval broadcast canopy_pct row ${i}`);
  }
}

// ════════════════════════════════════════════════════════════════════════
//  7. OSMEnricher — enrichTrack (end-to-end, non-snap path)
// ════════════════════════════════════════════════════════════════════════
console.log('\n── OSMEnricher: enrichTrack (integration, no snapping) ──');

{
  const osmJson = {
    elements: [
      { type: 'node', id: 1, lat: 51.5000, lon: -0.1000 },
      { type: 'node', id: 2, lat: 51.5010, lon: -0.1000 },
      { type: 'way', id: 100, nodes: [1, 2], tags: { highway: 'residential' } },
    ]
  };

  const raw = [];
  for (let i = 0; i < 5; i++) {
    raw.push({ time: i, lat: 51.5000 + i * 0.0001, lon: -0.1000 });
  }
  const analyzer = {
    raw,
    getCoordinates(i, preferRaw) {
      const r = this.raw[i];
      return (preferRaw && !isNaN(r.lat) && !isNaN(r.lon)) ? { lat: r.lat, lon: r.lon } : null;
    }
  };

  OSMEnricher.enrichTrack(analyzer, osmJson, 50);

  assert(analyzer.isEnriched === true, 'enrichTrack sets analyzer.isEnriched');
  assertEq(analyzer.enrichmentRadius, 50, 'enrichTrack records the search radius used');
  assertEq(analyzer._dataVersion, 1, 'enrichTrack bumps _dataVersion so self-validating caches (e.g. GSRUI env dashboard) recompute');
  assert(analyzer.osmGeoms && analyzer.osmGeoms.ways.length === 1, 'enrichTrack caches reconstructed geometries');
  for (let i = 0; i < raw.length; i++) {
    assertEq(raw[i].osm_road_class, 'residential', `enrichTrack — row ${i} classified as residential road`);
  }
  // Every osm_* column is populated end-to-end, not just road class — a
  // regression that dropped a field from _projectToTimeline would leave it
  // undefined on every row and only this catches it.
  for (const f of ['osm_dist_major_road', 'osm_in_park', 'osm_green_pct_50m', 'osm_dist_green', 'osm_canopy_pct_50m',
                   'osm_building_density_50m', 'osm_dist_water',
                   'osm_tree_density_50m', 'osm_amenity_count_50m']) {
    assert(raw.every(r => typeof r[f] === 'number' && !Number.isNaN(r[f])),
      `enrichTrack — every row has a defined numeric ${f}`);
  }
  // The fixture has only a residential road — no major road, water, park or
  // buildings — so those resolve to their sentinels / zero.
  assertEq(raw[2].osm_dist_major_road, 999, 'enrichTrack — residential-only fixture → distMajorRoad sentinel 999');
  assertEq(raw[2].osm_dist_water, 999, 'enrichTrack — no water in fixture → distWater sentinel 999');
  assertEq(raw[2].osm_in_park, 0, 'enrichTrack — no park in fixture → inPark 0');
  assertEq(raw[2].osm_dist_green, 999, 'enrichTrack — no green space in fixture → distGreen sentinel 999');
  assertEq(raw[2].osm_canopy_pct_50m, 0, 'enrichTrack — no trees in fixture → canopy_pct 0');
  assertEq(raw[2].osm_building_density_50m, 0, 'enrichTrack — no buildings in fixture → building density 0');
}

// 7b. enrichTrack throws a clear error when the track has no valid GPS
{
  const analyzer = {
    raw: [{ time: 0, lat: NaN, lon: NaN }],
    getCoordinates() { return null; }
  };
  let threw = false;
  try {
    OSMEnricher.enrichTrack(analyzer, { elements: [] }, 50);
  } catch (err) {
    threw = true;
    assert(/valid GPS/.test(err.message), 'enrichTrack error message mentions missing GPS');
  }
  assert(threw, 'enrichTrack throws when no valid GPS coordinates exist');
}

// 7c. Two tracks enriched against the SAME shared osmJson reference (the
// collective-mode case: ui.js fetches one osmJson for a union bbox and
// enriches every active track against it) end up with === identical
// analyzer.osmGeoms — reconstructGeometries() isn't redone per track.
{
  const osmJson = {
    elements: [
      { type: 'node', id: 1, lat: 51.5000, lon: -0.1000 },
      { type: 'node', id: 2, lat: 51.5010, lon: -0.1000 },
      { type: 'way', id: 100, nodes: [1, 2], tags: { highway: 'residential' } },
    ]
  };
  function makeAnalyzer() {
    const raw = [];
    for (let i = 0; i < 3; i++) raw.push({ time: i, lat: 51.5000 + i * 0.0001, lon: -0.1000 });
    return {
      raw,
      getCoordinates(i, preferRaw) {
        const r = this.raw[i];
        return (preferRaw && !isNaN(r.lat) && !isNaN(r.lon)) ? { lat: r.lat, lon: r.lon } : null;
      }
    };
  }
  const analyzerA = makeAnalyzer();
  const analyzerB = makeAnalyzer();
  OSMEnricher.enrichTrack(analyzerA, osmJson, 50);
  OSMEnricher.enrichTrack(analyzerB, osmJson, 50);
  assert(analyzerA.osmGeoms === analyzerB.osmGeoms, 'enrichTrack — two tracks sharing the same osmJson reference end up with the identical (===) osmGeoms object');
}

// 7d. enrichTrack with snapParams.enabled runs the HMM-Viterbi snap branch:
// it populates analyzer.snappedGps for the full timeline AND still stamps the
// osm_* fields; a subsequent non-snap run clears snappedGps back to null.
{
  const osmJson = {
    elements: [
      { type: 'node', id: 1, lat: 51.5000, lon: -0.1000 },
      { type: 'node', id: 2, lat: 51.5010, lon: -0.1000 },
      { type: 'node', id: 3, lat: 51.5020, lon: -0.1000 },
      { type: 'way', id: 100, nodes: [1, 2, 3], tags: { highway: 'residential' } },
    ]
  };
  const raw = [];
  const offset = 3 / 111320; // ~3 m east of the N-S road
  for (let i = 0; i < 8; i++) {
    raw.push({ time: i, lat: 51.5000 + i * 0.00025, lon: -0.1000 + offset });
  }
  const analyzer = {
    raw,
    getCoordinates(i) {
      const r = this.raw[i];
      return { lat: r.lat, lon: r.lon };
    }
  };

  OSMEnricher.enrichTrack(analyzer, osmJson, 50, { enabled: true, radiusOut: 40 });

  assert(analyzer.isEnriched === true, 'enrichTrack (snap) — sets isEnriched');
  assert(Array.isArray(analyzer.snappedGps) && analyzer.snappedGps.length === raw.length,
    'enrichTrack (snap) — snappedGps populated across the whole raw timeline');
  const validSnaps = analyzer.snappedGps.filter(s => s && !isNaN(s.lat) && !isNaN(s.lon));
  assert(validSnaps.length === raw.length,
    'enrichTrack (snap) — every row got a real snapped coordinate (gap-fill covers the whole timeline)');
  // The raw track runs ~3 m EAST of an exactly-N-S road at lon -0.1000, so a
  // correct snap must pull every blended position WEST (toward the road) —
  // strictly between the road and the raw fix. A garbage/no-op snap would not.
  for (let i = 0; i < raw.length; i++) {
    const s = analyzer.snappedGps[i];
    assert(s.lon < raw[i].lon && s.lon >= -0.1000 - 1e-9,
      `enrichTrack (snap) — row ${i} pulled toward the road (snapped lon ${s.lon} between road -0.1000 and raw ${raw[i].lon})`);
  }
  for (let i = 0; i < raw.length; i++) {
    assertEq(raw[i].osm_road_class, 'residential', `enrichTrack (snap) — row ${i} still stamped with the road class`);
  }

  OSMEnricher.enrichTrack(analyzer, osmJson, 50); // no snapParams
  assertEq(analyzer.snappedGps, null, 'enrichTrack (no snap) — clears any stale snappedGps to null');
}

// ════════════════════════════════════════════════════════════════════════
//  8. OSMEnricher — _projectToWay / _interpolateSnappedGps (road-snap gap fill)
// ════════════════════════════════════════════════════════════════════════
console.log('\n── OSMEnricher: _projectToWay / _interpolateSnappedGps ──');

// A two-point way (straight N-S segment) and an L-shaped 3-point way, shared
// across the cases below.
const STRAIGHT_WAY = [{ lat: 51.5000, lon: -0.1000 }, { lat: 51.5010, lon: -0.1000 }];
const L_SHAPED_WAY = [
  { lat: 51.5000, lon: -0.1000 },
  { lat: 51.5010, lon: -0.1000 },
  { lat: 51.5010, lon: -0.0980 }
];
// A second straight N-S way, parallel to STRAIGHT_WAY but 0.0020° further west
// — used for the dual-way-blend cases below.
const PARALLEL_WAY = [{ lat: 51.5000, lon: -0.1020 }, { lat: 51.5010, lon: -0.1020 }];

// 8a. _projectToWay — single-segment way matches GeoUtils.projectPointToSegment directly
{
  const expected = GeoUtils.projectPointToSegment(51.5005, -0.0995, 51.5000, -0.1000, 51.5010, -0.1000);
  const got = OSMEnricher._projectToWay(51.5005, -0.0995, STRAIGHT_WAY);
  assertClose(got.dist, expected.distance, 1e-9, '_projectToWay — single segment, distance matches GeoUtils directly');
  assertClose(got.snapLat, expected.lat, 1e-9, '_projectToWay — single segment, snapLat matches GeoUtils directly');
  assertClose(got.snapLon, expected.lon, 1e-9, '_projectToWay — single segment, snapLon matches GeoUtils directly');
}

// 8b. _projectToWay — multi-segment way picks the minimum-distance segment, not just segment 0
{
  const testLat = 51.5010, testLon = -0.0990; // sits on the L's second (E-W) leg
  const proj0 = GeoUtils.projectPointToSegment(testLat, testLon, L_SHAPED_WAY[0].lat, L_SHAPED_WAY[0].lon, L_SHAPED_WAY[1].lat, L_SHAPED_WAY[1].lon);
  const proj1 = GeoUtils.projectPointToSegment(testLat, testLon, L_SHAPED_WAY[1].lat, L_SHAPED_WAY[1].lon, L_SHAPED_WAY[2].lat, L_SHAPED_WAY[2].lon);
  assert(proj1.distance < proj0.distance, 'Sanity: fixture point is genuinely closer to the second leg than the first');

  const got = OSMEnricher._projectToWay(testLat, testLon, L_SHAPED_WAY);
  assertClose(got.dist, proj1.distance, 1e-9, '_projectToWay — multi-segment way picks the closer (second) segment, not segment 0');
  assertClose(got.snapLat, proj1.lat, 1e-9, '_projectToWay — multi-segment way returns the closer segment\'s snapLat');
  assertClose(got.snapLon, proj1.lon, 1e-9, '_projectToWay — multi-segment way returns the closer segment\'s snapLon');
}

function wayMapFor(...ways) {
  const idsAndCoords = ways; // [{id, coordinates}, ...]
  return { ways: idsAndCoords.map(w => ({ id: w.id, coordinates: w.coordinates })) };
}

// 8c. _interpolateSnappedGps — no valid entries at all is a no-op
{
  const sg = [{ lat: NaN, lon: NaN }, { lat: NaN, lon: NaN }, { lat: NaN, lon: NaN }];
  const analyzer = { snappedGps: sg, osmGeoms: { ways: [] } };
  const raw = [{ time: 0 }, { time: 1 }, { time: 2 }];
  OSMEnricher._interpolateSnappedGps(analyzer, raw);
  assert(sg.every(s => isNaN(s.lat) && isNaN(s.lon)), '_interpolateSnappedGps — all-NaN snappedGps stays untouched (no valid anchor to fill from)');
}

// 8d. _interpolateSnappedGps — fills every index before the first valid one with
// a distinct copy of that first valid entry's values.
{
  const anchor = { lat: 51.5005, lon: -0.1000, roadLat: 51.5005, roadLon: -0.1000, alpha: 0.8, dist: 2, wayId: 100 };
  const sg = [{ lat: NaN, lon: NaN }, { lat: NaN, lon: NaN }, anchor];
  const analyzer = { snappedGps: sg, osmGeoms: { ways: [] } };
  const raw = [{ time: 0 }, { time: 1 }, { time: 2 }];
  OSMEnricher._interpolateSnappedGps(analyzer, raw);
  assertEq(sg[0].lat, anchor.lat, '_interpolateSnappedGps — fill-before-first copies the first valid entry\'s lat');
  assertEq(sg[1].wayId, anchor.wayId, '_interpolateSnappedGps — fill-before-first copies the first valid entry\'s wayId');
  assert(sg[0] !== anchor && sg[1] !== anchor && sg[0] !== sg[1], '_interpolateSnappedGps — fill-before-first gives each earlier index its own object, not a shared reference');
}

// 8e. _interpolateSnappedGps — fills every index from the last valid one onward
// (including re-copying the last valid entry itself into a fresh object).
{
  const anchor = { lat: 51.5001, lon: -0.1000, roadLat: 51.5001, roadLon: -0.1000, alpha: 0.5, dist: 1, wayId: 100 };
  const sg = [anchor, { lat: NaN, lon: NaN }, { lat: NaN, lon: NaN }];
  const originalAnchorRef = sg[0];
  const analyzer = { snappedGps: sg, osmGeoms: { ways: [] } };
  const raw = [{ time: 0 }, { time: 1 }, { time: 2 }];
  OSMEnricher._interpolateSnappedGps(analyzer, raw);
  assertEq(sg[1].lat, anchor.lat, '_interpolateSnappedGps — fill-after-last copies the last valid entry\'s lat forward');
  assertEq(sg[2].wayId, anchor.wayId, '_interpolateSnappedGps — fill-after-last copies the last valid entry\'s wayId forward');
  assertEq(sg[0].lat, anchor.lat, '_interpolateSnappedGps — the last valid entry itself keeps its own values after the fill-forward pass');
  assert(sg[0] !== originalAnchorRef, '_interpolateSnappedGps — the last valid entry is reassigned to a fresh object, not left as the original reference');
}

// 8f. _interpolateSnappedGps — a >30s time gap between two valid anchors fills
// the gap with bare {lat: NaN, lon: NaN}, not the full snap-result shape.
{
  const a = { lat: 51.5000, lon: -0.1000, roadLat: 51.5000, roadLon: -0.1000, alpha: 0.5, dist: 1, wayId: 100 };
  const b = { lat: 51.5010, lon: -0.1000, roadLat: 51.5010, roadLon: -0.1000, alpha: 0.5, dist: 1, wayId: 100 };
  const sg = [a, { lat: NaN, lon: NaN }, b];
  const analyzer = { snappedGps: sg, osmGeoms: { ways: [{ id: 100, coordinates: STRAIGHT_WAY }] } };
  const raw = [{ time: 0 }, { time: 15 }, { time: 40 }]; // 40s gap > GPS_MAX_GAP_S (30s)
  OSMEnricher._interpolateSnappedGps(analyzer, raw);
  assert(isNaN(sg[1].lat) && isNaN(sg[1].lon), '_interpolateSnappedGps — gap point stays NaN across a >30s time gap');
  assertEq(sg[1].roadLat, undefined, '_interpolateSnappedGps — >30s gap fill is the bare {lat,lon} shape, not the full 6-key snap-result shape');
}

// 8g. _interpolateSnappedGps — different way IDs on both ends, with real GPS at
// the gap point, blends both ways' projections and switches wayId at t=0.5.
{
  const sg = [
    { lat: 51.5000, lon: -0.1000, roadLat: 51.5000, roadLon: -0.1000, alpha: 0.6, dist: 0, wayId: 100 },
    { lat: NaN, lon: NaN }, { lat: NaN, lon: NaN },
    { lat: 51.5010, lon: -0.1020, roadLat: 51.5010, roadLon: -0.1020, alpha: 1.0, dist: 0, wayId: 200 }
  ];
  const analyzer = { snappedGps: sg, osmGeoms: wayMapFor({ id: 100, coordinates: STRAIGHT_WAY }, { id: 200, coordinates: PARALLEL_WAY }) };
  const raw = [
    { time: 0, lat: 51.5000, lon: -0.1010 },
    { time: 1, lat: 51.5003, lon: -0.1010 },
    { time: 2, lat: 51.5007, lon: -0.1010 },
    { time: 3, lat: 51.5010, lon: -0.1010 }
  ];
  OSMEnricher._interpolateSnappedGps(analyzer, raw);

  // i=1: t=1/3 < 0.5 → expect wayId to still read the near (A) side
  {
    const t = 1 / 3;
    const projA = GeoUtils.projectPointToSegment(raw[1].lat, raw[1].lon, STRAIGHT_WAY[0].lat, STRAIGHT_WAY[0].lon, STRAIGHT_WAY[1].lat, STRAIGHT_WAY[1].lon);
    const projB = GeoUtils.projectPointToSegment(raw[1].lat, raw[1].lon, PARALLEL_WAY[0].lat, PARALLEL_WAY[0].lon, PARALLEL_WAY[1].lat, PARALLEL_WAY[1].lon);
    const snapLat = (1 - t) * projA.lat + t * projB.lat;
    const snapLon = (1 - t) * projA.lon + t * projB.lon;
    const alpha = 0.6 + t * (1.0 - 0.6);
    const expLat = alpha * snapLat + (1 - alpha) * raw[1].lat;
    const expLon = alpha * snapLon + (1 - alpha) * raw[1].lon;
    assertClose(sg[1].lat, expLat, 1e-9, '_interpolateSnappedGps — dual-way blend (t<0.5) matches hand-computed blended lat');
    assertClose(sg[1].lon, expLon, 1e-9, '_interpolateSnappedGps — dual-way blend (t<0.5) matches hand-computed blended lon');
    assertEq(sg[1].wayId, 100, '_interpolateSnappedGps — dual-way blend reports the near-side wayId while t<0.5');
  }
  // i=2: t=2/3 >= 0.5 → expect wayId to switch to the far (B) side
  {
    const t = 2 / 3;
    const projA = GeoUtils.projectPointToSegment(raw[2].lat, raw[2].lon, STRAIGHT_WAY[0].lat, STRAIGHT_WAY[0].lon, STRAIGHT_WAY[1].lat, STRAIGHT_WAY[1].lon);
    const projB = GeoUtils.projectPointToSegment(raw[2].lat, raw[2].lon, PARALLEL_WAY[0].lat, PARALLEL_WAY[0].lon, PARALLEL_WAY[1].lat, PARALLEL_WAY[1].lon);
    const snapLat = (1 - t) * projA.lat + t * projB.lat;
    const snapLon = (1 - t) * projA.lon + t * projB.lon;
    const alpha = 0.6 + t * (1.0 - 0.6);
    const expLat = alpha * snapLat + (1 - alpha) * raw[2].lat;
    const expLon = alpha * snapLon + (1 - alpha) * raw[2].lon;
    assertClose(sg[2].lat, expLat, 1e-9, '_interpolateSnappedGps — dual-way blend (t>=0.5) matches hand-computed blended lat');
    assertClose(sg[2].lon, expLon, 1e-9, '_interpolateSnappedGps — dual-way blend (t>=0.5) matches hand-computed blended lon');
    assertEq(sg[2].wayId, 200, '_interpolateSnappedGps — dual-way blend switches to the far-side wayId once t>=0.5');
  }
}

// 8h. _interpolateSnappedGps — same way ID on both ends projects onto that one
// way and lerps alpha between the two endpoints.
{
  const sg = [
    { lat: 51.5000, lon: -0.1005, roadLat: 51.5000, roadLon: -0.1005, alpha: 0.4, dist: 0, wayId: 100 },
    { lat: NaN, lon: NaN },
    { lat: 51.5010, lon: -0.1005, roadLat: 51.5010, roadLon: -0.1005, alpha: 0.9, dist: 0, wayId: 100 }
  ];
  const analyzer = { snappedGps: sg, osmGeoms: wayMapFor({ id: 100, coordinates: STRAIGHT_WAY }) };
  const raw = [
    { time: 0, lat: 51.5000, lon: -0.1005 },
    { time: 1, lat: 51.5005, lon: -0.1005 },
    { time: 2, lat: 51.5010, lon: -0.1005 }
  ];
  OSMEnricher._interpolateSnappedGps(analyzer, raw);

  const proj = GeoUtils.projectPointToSegment(raw[1].lat, raw[1].lon, STRAIGHT_WAY[0].lat, STRAIGHT_WAY[0].lon, STRAIGHT_WAY[1].lat, STRAIGHT_WAY[1].lon);
  const alpha = 0.4 + 0.5 * (0.9 - 0.4);
  const expLat = alpha * proj.lat + (1 - alpha) * raw[1].lat;
  const expLon = alpha * proj.lon + (1 - alpha) * raw[1].lon;
  assertClose(sg[1].lat, expLat, 1e-9, '_interpolateSnappedGps — single-way projection matches hand-computed blended lat');
  assertClose(sg[1].lon, expLon, 1e-9, '_interpolateSnappedGps — single-way projection matches hand-computed blended lon');
  assertClose(sg[1].alpha, alpha, 1e-9, '_interpolateSnappedGps — single-way projection lerps alpha between the two endpoints');
  assertEq(sg[1].wayId, 100, '_interpolateSnappedGps — single-way projection keeps the shared wayId');
}

// 8i. _interpolateSnappedGps — different way IDs but no raw GPS at the gap point
// (hasGps false) falls through to a plain linear interpolation of the existing
// snap values, ignoring way geometry entirely.
{
  const sg = [
    { lat: 51.5000, lon: -0.1000, roadLat: 51.5000, roadLon: -0.1000, alpha: 0.3, dist: 0, wayId: 100 },
    { lat: NaN, lon: NaN },
    { lat: 51.5010, lon: -0.1020, roadLat: 51.5010, roadLon: -0.1020, alpha: 0.7, dist: 0, wayId: 200 }
  ];
  const analyzer = { snappedGps: sg, osmGeoms: wayMapFor({ id: 100, coordinates: STRAIGHT_WAY }, { id: 200, coordinates: PARALLEL_WAY }) };
  const raw = [
    { time: 0, lat: 51.5000, lon: -0.1000 },
    { time: 1, lat: NaN, lon: NaN }, // no GPS fix at the gap point
    { time: 2, lat: 51.5010, lon: -0.1020 }
  ];
  OSMEnricher._interpolateSnappedGps(analyzer, raw);
  assertClose(sg[1].lat, 51.5005, 1e-9, '_interpolateSnappedGps — hasGps=false falls back to linear lat interpolation of the anchors\' own values');
  assertClose(sg[1].lon, -0.1010, 1e-9, '_interpolateSnappedGps — hasGps=false falls back to linear lon interpolation of the anchors\' own values');
  assertClose(sg[1].alpha, 0.5, 1e-9, '_interpolateSnappedGps — hasGps=false fallback also lerps alpha directly from the anchors');
  assertEq(sg[1].wayId, 200, '_interpolateSnappedGps — hasGps=false fallback still picks a wayId by t<0.5 (far side here)');
}

// 8j. _interpolateSnappedGps — neither end has a way ID (even with real GPS at
// the gap point) also falls back to plain linear interpolation.
{
  const sg = [
    { lat: 51.5000, lon: -0.1000, roadLat: 51.5000, roadLon: -0.1000, alpha: 0.2, dist: 5, wayId: null },
    { lat: NaN, lon: NaN },
    { lat: 51.5010, lon: -0.1010, roadLat: 51.5010, roadLon: -0.1010, alpha: 0.8, dist: 5, wayId: null }
  ];
  const analyzer = { snappedGps: sg, osmGeoms: { ways: [] } };
  const raw = [
    { time: 0, lat: 51.5000, lon: -0.1000 },
    { time: 1, lat: 51.5005, lon: -0.1005 }, // real GPS fix — proves it's the missing wayId, not hasGps, causing the fallback
    { time: 2, lat: 51.5010, lon: -0.1010 }
  ];
  OSMEnricher._interpolateSnappedGps(analyzer, raw);
  assertClose(sg[1].lat, 51.5005, 1e-9, '_interpolateSnappedGps — no wayId on either end falls back to linear lat interpolation even with a real GPS fix present');
  assertClose(sg[1].dist, 5, 1e-9, '_interpolateSnappedGps — no-wayId fallback also lerps dist directly from the anchors');
  assertEq(sg[1].wayId, null, '_interpolateSnappedGps — no-wayId fallback keeps wayId null (t<0.5 side, still null either way)');
}

// 8k. _interpolateSnappedGps — only one end has a way ID; that way is used for
// the whole gap.
{
  const sg = [
    { lat: 51.5000, lon: -0.1003, roadLat: 51.5000, roadLon: -0.1003, alpha: 0.5, dist: 0, wayId: 100 },
    { lat: NaN, lon: NaN },
    { lat: 51.5010, lon: -0.1003, roadLat: 51.5010, roadLon: -0.1003, alpha: 0.9, dist: 0, wayId: null }
  ];
  const analyzer = { snappedGps: sg, osmGeoms: wayMapFor({ id: 100, coordinates: STRAIGHT_WAY }) };
  const raw = [
    { time: 0, lat: 51.5000, lon: -0.1003 },
    { time: 1, lat: 51.5005, lon: -0.1003 },
    { time: 2, lat: 51.5010, lon: -0.1003 }
  ];
  OSMEnricher._interpolateSnappedGps(analyzer, raw);

  const proj = GeoUtils.projectPointToSegment(raw[1].lat, raw[1].lon, STRAIGHT_WAY[0].lat, STRAIGHT_WAY[0].lon, STRAIGHT_WAY[1].lat, STRAIGHT_WAY[1].lon);
  const alpha = 0.5 + 0.5 * (0.9 - 0.5);
  const expLat = alpha * proj.lat + (1 - alpha) * raw[1].lat;
  assertClose(sg[1].lat, expLat, 1e-9, '_interpolateSnappedGps — only-A-has-a-wayId case projects onto A\'s way for the whole gap');
  assertEq(sg[1].wayId, 100, '_interpolateSnappedGps — only-A-has-a-wayId case reports A\'s wayId, not t-based');
}

// ════════════════════════════════════════════════════════════════════════
//  9. MapMatcher — geometric helpers
// ════════════════════════════════════════════════════════════════════════
console.log('\n── MapMatcher: geometric helpers ──');

// 8a. _snapAlpha — full snap at 0 m, no snap at/after the radius, cosine mid-point
assertEq(MapMatcher._snapAlpha(0, 50), 1.0, '_snapAlpha(0) → 1.0 (right on the road)');
assertEq(MapMatcher._snapAlpha(50, 50), 0.0, '_snapAlpha(radius) → 0.0');
assertEq(MapMatcher._snapAlpha(60, 50), 0.0, '_snapAlpha(beyond radius) clamps to 0.0');
assertClose(MapMatcher._snapAlpha(25, 50), 0.5, 1e-9, '_snapAlpha(half radius) → 0.5 (cosine roll-off)');

// 8b. _angularDiff — direct and wraparound cases
assertClose(MapMatcher._angularDiff(0, 0), 0, 1e-9, '_angularDiff same angle → 0');
assertClose(MapMatcher._angularDiff(0, Math.PI), Math.PI, 1e-9, '_angularDiff opposite angles → π');
assertClose(
  MapMatcher._angularDiff(0.1, 2 * Math.PI - 0.1), 0.2, 1e-9,
  '_angularDiff wraps around 2π correctly'
);

// 8c. _segmentBearing — cardinal directions
assertClose(MapMatcher._segmentBearing(0, 0, 1, 0), 0, 0.01, '_segmentBearing due north ≈ 0 rad');
assertClose(MapMatcher._segmentBearing(0, 0, 0, 1), Math.PI / 2, 0.01, '_segmentBearing due east ≈ π/2 rad');
assertClose(MapMatcher._segmentBearing(0, 0, 0, -1), -Math.PI / 2, 0.01, '_segmentBearing due west ≈ -π/2 rad');
assert(Math.abs(Math.abs(MapMatcher._segmentBearing(0, 0, -1, 0)) - Math.PI) < 0.01,
  '_segmentBearing due south ≈ ±π rad');

// 8d. _wayDistance — forward, backward, and same-segment tracing
{
  const coords = [
    { lat: 0, lon: 0 }, { lat: 0, lon: 0.001 }, { lat: 0, lon: 0.002 }, { lat: 0, lon: 0.003 }
  ];
  const c1 = { wayId: 'W', coords, segIdx: 0, snapLat: 0, snapLon: 0.0005 };
  const c2 = { wayId: 'W', coords, segIdx: 2, snapLat: 0, snapLon: 0.0025 };

  const expectedForward =
    GeoUtils.haversineMeters(0, 0.0005, 0, coords[1].lon) +
    GeoUtils.haversineMeters(0, coords[1].lon, 0, coords[2].lon) +
    GeoUtils.haversineMeters(0, coords[2].lon, 0, 0.0025);

  assertClose(MapMatcher._wayDistance(c1, c2), expectedForward, 0.5, '_wayDistance — forward trace matches manual sum');
  assertClose(MapMatcher._wayDistance(c2, c1), expectedForward, 0.5, '_wayDistance — reverse trace is symmetric');

  // Same segment: direct haversine between the two snap points.
  const c3 = { wayId: 'W', coords, segIdx: 1, snapLat: 0, snapLon: 0.0011 };
  const c4 = { wayId: 'W', coords, segIdx: 1, snapLat: 0, snapLon: 0.0019 };
  const expectedSame = GeoUtils.haversineMeters(0, 0.0011, 0, 0.0019);
  assertClose(MapMatcher._wayDistance(c3, c4), expectedSame, 0.5, '_wayDistance — same segment = direct haversine');
}

// 8e. _routeDistViaJunction — connected ways route through the shared endpoint;
//     disconnected ways (endpoints >5 m apart) return Infinity.
{
  const wayA = [{ lat: 0, lon: 0 }, { lat: 0, lon: 0.001 }];
  const wayB = [{ lat: 0, lon: 0.001 }, { lat: 0, lon: 0.002 }]; // shares wayA's endpoint exactly
  const wayC = [{ lat: 1, lon: 1 }, { lat: 1, lon: 1.001 }];      // far away, disconnected

  const c1 = { wayId: 'A', coords: wayA, segIdx: 0, snapLat: 0, snapLon: 0.0005, endpoints: [wayA[0], wayA[1]] };
  const c2 = { wayId: 'B', coords: wayB, segIdx: 0, snapLat: 0, snapLon: 0.0015, endpoints: [wayB[0], wayB[1]] };
  const c3 = { wayId: 'C', coords: wayC, segIdx: 0, snapLat: 1, snapLon: 1.0005, endpoints: [wayC[0], wayC[1]] };

  const expected =
    GeoUtils.haversineMeters(0, 0.0005, 0, 0.001) +
    GeoUtils.haversineMeters(0, 0.001, 0, 0.0015);
  assertClose(MapMatcher._routeDistViaJunction(c1, c2), expected, 0.5,
    '_routeDistViaJunction — connected ways route through shared endpoint');
  assertEq(MapMatcher._routeDistViaJunction(c1, c3), Infinity,
    '_routeDistViaJunction — disconnected ways (no shared endpoint) → Infinity');
}

// ════════════════════════════════════════════════════════════════════════
//  10. MapMatcher — candidate generation & full Viterbi match
// ════════════════════════════════════════════════════════════════════════
console.log('\n── MapMatcher: _getCandidates / match() ──');

// 9a. _getCandidates — respects the search radius and computes correct distance
{
  const near = { type: 'way', id: 'R1', tags: { highway: 'residential' },
                 coordinates: [{ lat: 0, lon: 0 }, { lat: 0, lon: 0.001 }] };
  const far  = { type: 'way', id: 'R2', tags: { highway: 'footway' },
                 coordinates: [{ lat: 0.01, lon: 0 }, { lat: 0.01, lon: 0.001 }] }; // ~1113 m away

  const cands = MapMatcher._getCandidates(0.00005, 0.0005, [near, far], 50, NaN, NaN);
  assertEq(cands.length, 1, '_getCandidates — excludes way beyond the search radius');
  assertEq(cands[0].wayId, 'R1', '_getCandidates — keeps the in-radius way');
  assertClose(cands[0].dist, 5.566, 0.1, '_getCandidates — perpendicular distance computed correctly');
  assertClose(cands[0].effDist, cands[0].dist, 1e-9, '_getCandidates — no bearing data → effDist=dist (residential penalty=0)');
}

// 9b. _getCandidates — road-class penalty re-ranks equal-distance candidates
{
  const residential = { type: 'way', id: 'Residential', tags: { highway: 'residential' },
                         coordinates: [{ lat: 0.00009, lon: 0 }, { lat: 0.00009, lon: 0.001 }] };
  const footway = { type: 'way', id: 'Footway', tags: { highway: 'footway' },
                     coordinates: [{ lat: -0.00009, lon: 0 }, { lat: -0.00009, lon: 0.001 }] };
  const cands = MapMatcher._getCandidates(0, 0.0005, [residential, footway], 50, NaN, NaN);
  assertEq(cands.length, 2, '_getCandidates — both equidistant ways within radius');
  assertEq(cands[0].wayId, 'Footway', '_getCandidates — footway penalty (-8) ranks it ahead at equal raw distance');
}

// 9c. match() — empty input → empty Map
assertEq(MapMatcher.match([], [], 50).size, 0, 'match([]) → empty Map');

// 9d. match() — three points near a straight road all snap to it with high confidence
{
  const way = { type: 'way', id: 'W1', tags: { highway: 'residential' },
                coordinates: [{ lat: 0, lon: 0 }, { lat: 0, lon: 0.001 }, { lat: 0, lon: 0.002 }] };
  const raw = [{ time: 0 }, { time: 1 }, { time: 2 }];
  const offsetDeg = 3.3 / 111320; // ~3.3 m north of the road
  const evalPoints = [
    { idx: 0, lat: offsetDeg, lon: 0.0000, nearby: [way] },
    { idx: 1, lat: offsetDeg, lon: 0.0010, nearby: [way] },
    { idx: 2, lat: offsetDeg, lon: 0.0020, nearby: [way] },
  ];
  const results = MapMatcher.match(evalPoints, raw, 50);
  assertEq(results.size, 3, 'match() — one result per evaluation point');
  for (const idx of [0, 1, 2]) {
    const r = results.get(idx);
    assertEq(r.wayId, 'W1', `match() — point ${idx} snapped to the only nearby way`);
    assert(r.alpha > 0.9, `match() — point ${idx} close to road → high snap confidence (alpha=${r.alpha.toFixed(3)})`);
    assert(r.lat < offsetDeg, `match() — point ${idx} blended position pulled toward the road`);
  }
}

// 9e. match() — no nearby road → pass-through unchanged, alpha=0
{
  const raw = [{ time: 0 }];
  const evalPoints = [{ idx: 0, lat: 5, lon: 5, nearby: [] }];
  const results = MapMatcher.match(evalPoints, raw, 50);
  const r = results.get(0);
  assertEq(r.wayId, null, 'match() — no candidates → wayId null');
  assertEq(r.alpha, 0, 'match() — no candidates → alpha 0');
  assertEq(r.lat, 5, 'match() — no candidates → lat passed through unchanged');
  assertEq(r.lon, 5, 'match() — no candidates → lon passed through unchanged');
}

// ────────────────────────────────────────────────────────────────────────────
summary();
