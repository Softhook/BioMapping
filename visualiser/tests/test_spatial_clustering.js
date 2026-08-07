/**
 * Unit tests for spatial_clustering.js (GSRSpatialClustering) — pure
 * geodesic peak clustering and concave-boundary generation, no DOM/Leaflet
 * dependency.
 *
 * Run: node --test tests/test_spatial_clustering.js  (or `npm test` for the whole suite)
 */

const assert = require('assert');
const test = require('node:test');

// getConcaveBlob() delegates contour extraction to the global MarchingSquares
// (typeof-guarded, so undefined is tolerated — but we want real boundaries
// for most tests, so load the real thing, same pattern as GeoUtils below).
global.MarchingSquares = require('../marching_squares.js').MarchingSquares;
global.GeoUtils = require('../geo_utils.js').GeoUtils;

const { GSRSpatialClustering } = require('../spatial_clustering.js');

const METERS_PER_DEG_LAT = 111320.0;

// ─── clusterPeaks ────────────────────────────────────────────────────────

test('clusterPeaks: empty array returns empty array', () => {
  assert.deepStrictEqual(GSRSpatialClustering.clusterPeaks([]), []);
});

test('clusterPeaks: null/undefined input returns empty array', () => {
  assert.deepStrictEqual(GSRSpatialClustering.clusterPeaks(null), []);
  assert.deepStrictEqual(GSRSpatialClustering.clusterPeaks(undefined), []);
});

test('clusterPeaks: single point returns a single cluster containing it', () => {
  const peaks = [{ lat: 51.5, lon: -0.1 }];
  const clusters = GSRSpatialClustering.clusterPeaks(peaks);
  assert.strictEqual(clusters.length, 1);
  assert.strictEqual(clusters[0].length, 1);
  assert.strictEqual(clusters[0][0], peaks[0]);
});

test('clusterPeaks: two coincident (identical) points merge into one cluster', () => {
  const peaks = [{ lat: 51.5, lon: -0.1 }, { lat: 51.5, lon: -0.1 }];
  const clusters = GSRSpatialClustering.clusterPeaks(peaks);
  assert.strictEqual(clusters.length, 1);
  assert.strictEqual(clusters[0].length, 2);
});

test('clusterPeaks: total number of peaks is preserved across all output clusters', () => {
  const peaks = [];
  for (let i = 0; i < 20; i++) {
    // Two loose groups plus scattered noise, all near lat=0 for simple geometry.
    const lat = (i < 10) ? 0 : 0.01;
    peaks.push({ lat: lat + i * 0.00001, lon: i * 0.00001 });
  }
  const clusters = GSRSpatialClustering.clusterPeaks(peaks);
  const total = clusters.reduce((sum, c) => sum + c.length, 0);
  assert.strictEqual(total, peaks.length);
  // No cluster should ever be empty.
  for (const c of clusters) assert.ok(c.length > 0);
});

test('clusterPeaks: with boundaryRadius=0 the merge threshold is exactly maxDistanceMeters (docstring invariant)', () => {
  // With boundaryRadius=0, getClusterRadius(1) === 0, so the merge threshold
  // collapses to Math.max(limit, 0+0) === limit — i.e. exactly the documented
  // "peaks within maxDistanceMeters of each other are in the same cluster."
  const limit = 35;
  const justInsideOffsetDeg = 34 / METERS_PER_DEG_LAT; // 34 m apart (pure lat offset -> exact meters)
  const justOutsideOffsetDeg = 36 / METERS_PER_DEG_LAT; // 36 m apart

  const insidePeaks = [{ lat: 0, lon: 0 }, { lat: justInsideOffsetDeg, lon: 0 }];
  const insideClusters = GSRSpatialClustering.clusterPeaks(insidePeaks, limit, 0, 15);
  assert.strictEqual(insideClusters.length, 1, '34 m apart with boundaryRadius=0 should merge');

  const outsidePeaks = [{ lat: 0, lon: 0 }, { lat: justOutsideOffsetDeg, lon: 0 }];
  const outsideClusters = GSRSpatialClustering.clusterPeaks(outsidePeaks, limit, 0, 15);
  assert.strictEqual(outsideClusters.length, 2, '36 m apart with boundaryRadius=0 should stay separate');
});

test('clusterPeaks: default boundaryRadius extends the effective merge threshold beyond maxDistanceMeters', () => {
  // With defaults (boundaryRadius=18), two singleton clusters each get
  // radius 18*1.05=18.9m, so the effective threshold is
  // max(35, 18.9+18.9)=37.8m, not the raw 35m limit. A pair 36m apart
  // (outside the raw limit but inside the radius-extended threshold)
  // should therefore still merge under defaults, unlike the boundaryRadius=0 case above.
  const offsetDeg = 36 / METERS_PER_DEG_LAT;
  const peaks = [{ lat: 0, lon: 0 }, { lat: offsetDeg, lon: 0 }];
  const clusters = GSRSpatialClustering.clusterPeaks(peaks); // default maxDistanceMeters=35, boundaryRadius=18
  assert.strictEqual(clusters.length, 1);
});

test('clusterPeaks: two well-separated points (>1km apart) remain in separate clusters', () => {
  const peaks = [{ lat: 51.5, lon: -0.10 }, { lat: 51.6, lon: -0.20 }];
  const clusters = GSRSpatialClustering.clusterPeaks(peaks);
  assert.strictEqual(clusters.length, 2);
});

test('clusterPeaks: invalid maxDistanceMeters/boundaryRadius/sigma fall back to defaults instead of throwing', () => {
  const peaks = [{ lat: 0, lon: 0 }, { lat: 0.0001, lon: 0 }];
  assert.doesNotThrow(() => {
    GSRSpatialClustering.clusterPeaks(peaks, 'not-a-number', 'nope', NaN);
  });
});

test('clusterPeaks: collinear chain of closely-spaced points can all merge into one cluster', () => {
  // Chain-clustering: each consecutive pair is close, growing cluster radius
  // lets the whole line merge even though the two ends are farther apart
  // than a single pairwise threshold would normally allow.
  const peaks = [];
  for (let i = 0; i < 8; i++) {
    peaks.push({ lat: 0, lon: (i * 15) / METERS_PER_DEG_LAT }); // ~15 m spacing
  }
  const clusters = GSRSpatialClustering.clusterPeaks(peaks);
  assert.strictEqual(clusters.length, 1, 'closely-chained collinear points should merge into a single cluster');
  assert.strictEqual(clusters[0].length, 8);
});

test('clusterPeaks: does not mutate the input peak objects', () => {
  const peaks = [{ lat: 51.5, lon: -0.1, amplitude: 2 }, { lat: 51.50001, lon: -0.1, amplitude: 3 }];
  const snapshot = JSON.parse(JSON.stringify(peaks));
  GSRSpatialClustering.clusterPeaks(peaks);
  assert.deepStrictEqual(peaks, snapshot);
});

// ─── relativeAmplitudeWeight ─────────────────────────────────────────────

test('relativeAmplitudeWeight: missing/non-positive refAmplitude returns unweighted 1', () => {
  assert.strictEqual(GSRSpatialClustering.relativeAmplitudeWeight(5, null), 1);
  assert.strictEqual(GSRSpatialClustering.relativeAmplitudeWeight(5, undefined), 1);
  assert.strictEqual(GSRSpatialClustering.relativeAmplitudeWeight(5, 0), 1);
  assert.strictEqual(GSRSpatialClustering.relativeAmplitudeWeight(5, -3), 1);
});

test('relativeAmplitudeWeight: invalid amplitude returns unweighted 1', () => {
  assert.strictEqual(GSRSpatialClustering.relativeAmplitudeWeight(NaN, 5), 1);
  assert.strictEqual(GSRSpatialClustering.relativeAmplitudeWeight(undefined, 5), 1);
  assert.strictEqual(GSRSpatialClustering.relativeAmplitudeWeight('x', 5), 1);
});

test('relativeAmplitudeWeight: amplitude equal to reference returns 1', () => {
  assert.strictEqual(GSRSpatialClustering.relativeAmplitudeWeight(4, 4), 1);
});

test('relativeAmplitudeWeight: mid-range ratio returns the exact ratio (unclamped)', () => {
  assert.strictEqual(GSRSpatialClustering.relativeAmplitudeWeight(6, 3), 2); // rel=2, within [0.55, 3.0]
});

test('relativeAmplitudeWeight: extreme outlier amplitude clamps at the max (default 3.0)', () => {
  assert.strictEqual(GSRSpatialClustering.relativeAmplitudeWeight(1000, 1), 3.0);
});

test('relativeAmplitudeWeight: near-zero amplitude clamps at the min (default 0.55)', () => {
  assert.strictEqual(GSRSpatialClustering.relativeAmplitudeWeight(0.0001, 1), 0.55);
});

// ─── stitchSegments ───────────────────────────────────────────────────────

test('stitchSegments: empty/undefined input returns empty array', () => {
  assert.deepStrictEqual(GSRSpatialClustering.stitchSegments([]), []);
  assert.deepStrictEqual(GSRSpatialClustering.stitchSegments(undefined), []);
});

test('stitchSegments: a single 2-point segment is discarded (degenerate, <3 points)', () => {
  const segments = [[{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }]];
  assert.deepStrictEqual(GSRSpatialClustering.stitchSegments(segments), []);
});

test('stitchSegments: four segments forming a closed square stitch into one closed 5-point path', () => {
  const A = { lat: 0, lon: 0 }, B = { lat: 0, lon: 1 }, C = { lat: 1, lon: 1 }, D = { lat: 1, lon: 0 };
  const segments = [[A, B], [B, C], [C, D], [D, A]];
  const paths = GSRSpatialClustering.stitchSegments(segments);
  assert.strictEqual(paths.length, 1);
  assert.strictEqual(paths[0].length, 5, 'closed square: 4 corners + repeated start/end point');
  assert.deepStrictEqual(paths[0][0], paths[0][paths[0].length - 1], 'first and last point of a closed loop coincide');
});

test('stitchSegments: order of segments does not affect the stitched result (shuffled input)', () => {
  const A = { lat: 0, lon: 0 }, B = { lat: 0, lon: 1 }, C = { lat: 1, lon: 1 }, D = { lat: 1, lon: 0 };
  const segments = [[C, D], [A, B], [D, A], [B, C]]; // scrambled order, some needing start-side stitching
  const paths = GSRSpatialClustering.stitchSegments(segments);
  assert.strictEqual(paths.length, 1);
  assert.strictEqual(paths[0].length, 5);
});

test('stitchSegments: two disjoint closed triangles stitch into two separate paths', () => {
  const A = { lat: 0, lon: 0 }, B = { lat: 0, lon: 1 }, C = { lat: 1, lon: 0.5 };
  const P = { lat: 10, lon: 10 }, Q = { lat: 10, lon: 11 }, R = { lat: 11, lon: 10.5 };
  const segments = [[A, B], [B, C], [C, A], [P, Q], [Q, R], [R, P]];
  const paths = GSRSpatialClustering.stitchSegments(segments);
  assert.strictEqual(paths.length, 2);
  for (const p of paths) assert.strictEqual(p.length, 4);
});

test('stitchSegments: endpoints within EPS tolerance (but not bit-identical) still stitch', () => {
  const A = { lat: 0, lon: 0 };
  const Bexact = { lat: 0, lon: 1 };
  const BclosePrime = { lat: 0, lon: 1 + 1e-9 }; // well within the 1e-6 EPS tolerance
  const C = { lat: 1, lon: 1 };
  const D = { lat: 1, lon: 0 };
  const segments = [[A, Bexact], [BclosePrime, C], [C, D], [D, A]];
  const paths = GSRSpatialClustering.stitchSegments(segments);
  assert.strictEqual(paths.length, 1, 'near-duplicate float endpoints within EPS should still be treated as connected');
});

test('stitchSegments: endpoints farther apart than EPS remain unstitched (separate short paths)', () => {
  const A = { lat: 0, lon: 0 };
  const Bexact = { lat: 0, lon: 1 };
  const Bfar = { lat: 0, lon: 1.001 }; // far outside EPS
  const C = { lat: 1, lon: 1 };
  const segments = [[A, Bexact], [Bfar, C]];
  const paths = GSRSpatialClustering.stitchSegments(segments);
  // Neither individual 2-point segment reaches the 3-point minimum, so both are dropped.
  assert.deepStrictEqual(paths, []);
});

// ─── getConcaveBlob ───────────────────────────────────────────────────────

function maxDistFromPeak(peak, paths) {
  let max = 0;
  for (const path of paths) {
    for (const pt of path) {
      const d = GeoUtils.haversineMeters(peak.lat, peak.lon, pt.lat, pt.lon);
      if (d > max) max = d;
    }
  }
  return max;
}

test('getConcaveBlob: empty cluster returns empty array', () => {
  assert.deepStrictEqual(GSRSpatialClustering.getConcaveBlob([]), []);
  assert.deepStrictEqual(GSRSpatialClustering.getConcaveBlob(null), []);
});

test('getConcaveBlob: single peak produces at least one closed path enclosing it, all points finite', () => {
  const cluster = [{ lat: 51.5, lon: -0.1 }];
  const paths = GSRSpatialClustering.getConcaveBlob(cluster, 15, 18);
  assert.ok(paths.length >= 1, 'a single peak should produce a boundary blob');
  for (const path of paths) {
    assert.ok(path.length >= 3);
    for (const pt of path) {
      assert.ok(Number.isFinite(pt.lat) && Number.isFinite(pt.lon));
    }
  }
});

test('getConcaveBlob: single-peak boundary radius roughly matches thresholdRadius', () => {
  const cluster = [{ lat: 0, lon: 0 }];
  const thresholdRadius = 18;
  const paths = GSRSpatialClustering.getConcaveBlob(cluster, 15, thresholdRadius);
  const maxDist = maxDistFromPeak(cluster[0], paths);
  // Grid is 70x70 over a padded window, so allow generous tolerance for
  // interpolation/discretisation error.
  assert.ok(maxDist > thresholdRadius * 0.7 && maxDist < thresholdRadius * 1.3,
    `expected boundary ~${thresholdRadius}m from peak, got ${maxDist.toFixed(2)}m`);
});

test('getConcaveBlob: two coincident (identical) peaks does not crash and still returns a valid boundary', () => {
  const cluster = [{ lat: 10, lon: 10 }, { lat: 10, lon: 10 }];
  assert.doesNotThrow(() => {
    const paths = GSRSpatialClustering.getConcaveBlob(cluster, 15, 18);
    assert.ok(paths.length >= 1);
  });
});

test('getConcaveBlob: collinear (degenerate) cluster geometry produces a valid, non-crashing boundary', () => {
  const cluster = [
    { lat: 0, lon: 0 },
    { lat: 0, lon: 0.0001 },
    { lat: 0, lon: 0.0002 },
  ];
  assert.doesNotThrow(() => {
    const paths = GSRSpatialClustering.getConcaveBlob(cluster, 15, 18);
    assert.ok(paths.length >= 1, 'collinear cluster should still yield an elongated boundary');
    for (const path of paths) {
      for (const pt of path) assert.ok(Number.isFinite(pt.lat) && Number.isFinite(pt.lon));
    }
  });
});

test('getConcaveBlob: amplitude-weighted peak (refAmplitude supplied) grows a larger boundary than the unweighted case', () => {
  const cluster = [{ lat: 0, lon: 0, amplitude: 10 }]; // rel = 10/1 = 10, clamped to max 3.0
  const sigma = 15, thresholdRadius = 18;

  const unweightedPaths = GSRSpatialClustering.getConcaveBlob(cluster, sigma, thresholdRadius, null);
  const weightedPaths = GSRSpatialClustering.getConcaveBlob(cluster, sigma, thresholdRadius, 1 /* refAmplitude */);

  const unweightedMax = maxDistFromPeak(cluster[0], unweightedPaths);
  const weightedMax = maxDistFromPeak(cluster[0], weightedPaths);

  assert.ok(weightedMax > unweightedMax,
    `severe peak with refAmplitude weighting (${weightedMax.toFixed(1)}m) should reach farther than unweighted (${unweightedMax.toFixed(1)}m)`);
});

test('getConcaveBlob: invalid sigma/thresholdRadius fall back to defaults instead of throwing', () => {
  const cluster = [{ lat: 0, lon: 0 }];
  assert.doesNotThrow(() => {
    const paths = GSRSpatialClustering.getConcaveBlob(cluster, -5, 0);
    assert.ok(paths.length >= 1);
  });
});

test('getConcaveBlob: returns [] (without throwing) when MarchingSquares is unavailable', () => {
  const saved = global.MarchingSquares;
  delete global.MarchingSquares;
  try {
    const cluster = [{ lat: 0, lon: 0 }];
    const paths = GSRSpatialClustering.getConcaveBlob(cluster, 15, 18);
    assert.deepStrictEqual(paths, []);
  } finally {
    global.MarchingSquares = saved;
  }
});

test('getConcaveBlob: every returned path contains at least one of the cluster peaks (isolated-island filter)', () => {
  // Two well-separated peaks -> two separate blobs, each of which must
  // contain at least one of the actual cluster peaks (per the
  // point-in-polygon filter documented in the source).
  const cluster = [{ lat: 0, lon: 0 }, { lat: 0.01, lon: 0.01 }]; // ~1.5km apart
  const paths = GSRSpatialClustering.getConcaveBlob(cluster, 15, 18);
  assert.ok(paths.length >= 2, 'two far-apart peaks should produce at least two separate boundary islands');
  for (const path of paths) {
    const containsAPeak = cluster.some(pk => GSRSpatialClustering._isPointInPolygon
      ? GSRSpatialClustering._isPointInPolygon(pk, path)
      : true);
    assert.ok(containsAPeak);
  }
});

// ─── getConcaveBlob perf fix (2026-08-07): cutoff + splat restructuring ───
// docs/visualizer_architecture_refactor_plan.md Phase 7. The density-grid
// loop used to scan every (grid cell, peak) pair unconditionally; it now
// (a) skips Math.exp() for pairs beyond a 6-sigma cutoff (negligible
// contribution) and (b) only touches the small window of cells that could
// possibly be within that cutoff of each peak, instead of scanning the
// full 70x70 grid for every peak. Verified byte-identical against the
// pre-fix implementation on real 800+ peak collective data (see the plan
// doc's Phase 7 status note) — these tests pin the two behaviors that
// restructuring could plausibly get wrong: a peak far outside the cutoff
// contributing nothing, and the splat window not clipping a peak's own
// legitimate boundary.
test('getConcaveBlob: a peak far outside the density cutoff does not distort a nearby peak\'s boundary radius', () => {
  const sigma = 15, thresholdRadius = 18;
  // Second peak ~500m away — far beyond any plausible cutoff for this
  // sigma/threshold pairing (6*sigma = 90m) — so the boundary radius around
  // the first peak should be indistinguishable from the single-peak case.
  const cluster = [{ lat: 0, lon: 0 }, { lat: 0.0045, lon: 0 }];
  const paths = GSRSpatialClustering.getConcaveBlob(cluster, sigma, thresholdRadius);
  const distsFromFirst = [];
  for (const path of paths) {
    for (const pt of path) {
      const d = GeoUtils.haversineMeters(cluster[0].lat, cluster[0].lon, pt.lat, pt.lon);
      if (d < 100) distsFromFirst.push(d); // only points that belong to peak 0's own blob
    }
  }
  const maxDist = Math.max(...distsFromFirst);
  assert.ok(maxDist > thresholdRadius * 0.7 && maxDist < thresholdRadius * 1.3,
    `expected peak 0's boundary ~${thresholdRadius}m (unaffected by the far peak), got ${maxDist.toFixed(2)}m`);
});

test('getConcaveBlob: a threshold deep in the Gaussian tail (thresholdRadius >> sigma) still reaches its boundary radius', () => {
  // sigma=5, thresholdRadius=25 -> the isolevel sits at exp(-25^2/(2*25)) =
  // exp(-12.5), deep in the tail. A too-tight cutoff (this fix uses 6 sigma
  // = 30m, comfortably past 25m) would silently shrink the boundary well
  // below thresholdRadius instead of reaching it, because contributions
  // between the (buggy) cutoff and the real isolevel distance would be
  // dropped as if they were negligible when they aren't, at this shape.
  const sigma = 5, thresholdRadius = 25;
  const cluster = [{ lat: 0, lon: 0 }];
  const paths = GSRSpatialClustering.getConcaveBlob(cluster, sigma, thresholdRadius);
  const maxDist = maxDistFromPeak(cluster[0], paths);
  assert.ok(maxDist > thresholdRadius * 0.7 && maxDist < thresholdRadius * 1.3,
    `expected boundary ~${thresholdRadius}m even deep in the tail, got ${maxDist.toFixed(2)}m`);
});

test('getConcaveBlob: three peaks spanning near/mid/far distances all get correctly-sized independent boundaries', () => {
  // 0m, ~40m, ~600m apart — the middle peak is close enough that a
  // too-small splat window would clip its boundary, and the far peak is
  // close enough (relative to a buggy huge cutoff) that it could wrongly
  // bleed into the others if the cutoff distance were computed wrong.
  const sigma = 4.15, thresholdRadius = 5; // matches this codebase's actual default clustering params
  const cluster = [
    { lat: 0, lon: 0 },
    { lat: 0.00036, lon: 0 },  // ~40m north
    { lat: 0.0054, lon: 0 },   // ~600m north
  ];
  const paths = GSRSpatialClustering.getConcaveBlob(cluster, sigma, thresholdRadius);
  assert.ok(paths.length >= 2, 'well-separated peaks should not all merge into one blob');
  // Every peak must be inside at least one returned path (isolated-island filter).
  for (const pk of cluster) {
    const found = paths.some(path => GeoUtils.pointInPolygon(pk.lat, pk.lon, path));
    assert.ok(found, `peak at (${pk.lat},${pk.lon}) should be enclosed by its own boundary blob`);
  }
});
