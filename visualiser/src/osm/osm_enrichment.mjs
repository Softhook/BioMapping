/**
 * OSM Environmental Enrichment Module for Bio Mapping
 * Handles Overpass API fetching, client-side spatial grid hashing,
 * geometry reconstruction, and coordinate-to-feature spatial math.
 */

// -- Numerical constants ---------------------------------------------------
import { GeoUtils } from '../gps/geo_utils.mjs';
import { GpsPipeline } from '../gps/gps_pipeline.mjs';
import { Junctions } from '../gps/junctions.mjs';
import { MapMatcher } from '../gps/map_match.mjs';
import { SpatialGrid } from '../spatial/spatial_grid.mjs';
import { OverpassClient } from './overpass_client.mjs';

const METERS_PER_DEG_LAT = GeoUtils.METERS_PER_DEG_LAT; // m per degree of latitude
const CELL_SIZE_DEG = 0.001; // spatial-hash cell (~111 m)
const SENTINEL_DIST = 999; // sentinel for "no feature nearby"
const DEFAULT_RADIUS_M = 50; // enrichment search radius
const DEFAULT_BBOX_BUFFER_M = 100; // bounding-box padding
// Snapping spaces evaluation points at least this far apart (m), so the
// snap weight ramps over a few metres of walking, not a few rows.
const SNAP_THIN_M = 3;

// Collective-mode enrichment fetches one shared osmJson (by reference) for
// every track covering the same bbox (ui.js's union-bbox fetch), but each
// enrichTrack() call used to independently re-run reconstructGeometries() AND
// buildSpatialIndex() on it — both full-cost passes over every point/way/
// relation, repeated once per track even when the input was byte-identical
// (same object). Both WeakMaps key on object identity (not content), so
// neither ever returns a stale result for a genuinely different fetch, and
// entries are collected automatically once the track/analyzer that
// referenced them is gone. _spatialIndexCache keys on the *geoms* object
// (reconstructGeometries()'s output), not osmJson directly — since geoms
// itself is already deduped per osmJson via _geomsCache, two tracks sharing
// one osmJson resolve to the same geoms reference and therefore the same
// cached spatial index too, transitively.
const _geomsCache = new WeakMap();
const _spatialIndexCache = new WeakMap();

// -- Green-space sampling grid ---------------------------------------------
// Two concentric rings at 1/2 and the full search radius, plus the centre
// point (added separately). POINTS_PER_RING is indexed by ring number 1..N,
// so entry [0] is the centre count and never read in the ring loop.
const SAMPLING_RINGS = 2; // concentric rings (excl. centre)
const POINTS_PER_RING = [1, 8, 16]; // centre, ring 1 (½r), ring 2 (r)

// -- OSM tag sets ----------------------------------------------------------
const MAJOR_ROAD_CLASSES = new Set([
  'motorway',
  'trunk',
  'primary',
  'secondary',
]);
// Carriageways that carry motor traffic — the "road you're near" for an
// arousal-by-road-type analysis. A footway/path/cycleway 2 m away shouldn't
// mask a residential or primary road 15 m away, so these win the road-class
// label whenever one is within the search radius.
const VEHICULAR_ROAD_CLASSES = new Set([
  'motorway',
  'trunk',
  'primary',
  'secondary',
  'tertiary',
  'unclassified',
  'residential',
  'living_street',
  'service',
  'motorway_link',
  'trunk_link',
  'primary_link',
  'secondary_link',
  'tertiary_link',
]);
// `highway=*` values that aren't a road or path a walker travels *along*:
// point features (stops, signals, street furniture, junction markers) and
// not-currently-a-way lifecycle tags. The unfiltered `way["highway"]` query
// pulls these in, and without this guard they can win the `osm_road_class`
// label and seed junk rows in the Roads Profile.
const NON_ROAD_HIGHWAY = new Set([
  'bus_stop',
  'platform',
  'street_lamp',
  'traffic_signals',
  'crossing',
  'stop',
  'give_way',
  'milestone',
  'speed_camera',
  'passing_place',
  'turning_circle',
  'turning_loop',
  'mini_roundabout',
  'motorway_junction',
  'elevator',
  'emergency_bay',
  'rest_area',
  'services',
  'proposed',
  'construction',
  'planned',
  'razed',
  'dismantled',
  'abandoned',
]);
const AMENITY_TYPES = new Set([
  'cafe',
  'restaurant',
  'pub',
  'fast_food',
  'bar',
  'school',
  'university',
  'hospital',
  'clinic',
  'library',
  'place_of_worship',
  'parking',
  'fuel',
]);

// A `leisure=playground` is typically rubber safety surfacing and steel
// equipment, not vegetated nature — it is deliberately NOT green space.
const GREEN_LEISURE = new Set(['park', 'garden', 'nature_reserve']);
const GREEN_LANDUSE = new Set([
  'grass',
  'forest',
  'meadow',
  'recreation_ground',
  'village_green',
  'orchard',
]);
// `natural=wetland` is BOTH blue and green: it is a water feature for
// `dist_water` (see WATER_NATURAL below) AND vegetated nature for `green_pct`
// / `in_park`. A wetland geom therefore matches both _isGreenSpace and
// _isWaterSpace, and the green / water branches of _evaluatePosition run
// independently (not else-if), so it contributes to both metrics.
const GREEN_NATURAL = new Set([
  'wood',
  'scrub',
  'grassland',
  'heath',
  'wetland',
]);

const WATER_NATURAL = new Set(['water', 'wetland']);
const WATER_WATERWAY = new Set(['river', 'canal', 'stream', 'drain', 'ditch']);
const WATER_LANDUSE = new Set(['basin', 'reservoir']);

// -- Tree canopy ---------------------------------------------------------
// "Am I under / among trees" — the other half of perceived green, distinct
// from green *spaces*. `osm_tree_density_50m` (a raw count of natural=tree
// NODES) misses almost all real canopy: woodland is polygons with no tree
// nodes inside, tree-lined streets are one natural=tree_row way. So canopy_pct
// = fraction of the sampling grid that is inside a wood/forest polygon OR
// within CANOPY_BUFFER_M of a tree_row way / tree node.
const CANOPY_NATURAL_AREA = new Set(['wood']); // polygon
const CANOPY_LANDUSE_AREA = new Set(['forest']); // polygon
const CANOPY_BUFFER_M = 10; // crown reach around a tree_row / tree node

// -- Module-level helpers --------------------------------------------------

/** True when geom represents any kind of green/natural space. */
function _isGreenSpace(geom) {
  const t = geom.tags;
  if (!t) return false;
  return (
    GREEN_LEISURE.has(t.leisure) ||
    GREEN_LANDUSE.has(t.landuse) ||
    GREEN_NATURAL.has(t.natural)
  );
}

/**
 * True when geom contributes tree canopy: a wood/forest polygon, a
 * natural=tree_row way, or a natural=tree node.
 */
function _isCanopy(geom) {
  const t = geom.tags;
  if (!t) return false;
  if (t.natural === 'tree') return geom.type === 'node';
  if (t.natural === 'tree_row') return true;
  return (
    CANOPY_NATURAL_AREA.has(t.natural) || CANOPY_LANDUSE_AREA.has(t.landuse)
  );
}

/** True when geom represents any kind of water body or waterway. */
function _isWaterSpace(geom) {
  const t = geom.tags;
  if (!t) return false;
  return (
    WATER_NATURAL.has(t.natural) ||
    WATER_WATERWAY.has(t.waterway) ||
    WATER_LANDUSE.has(t.landuse)
  );
}

/** Extract highway classification from a way, or null. */
function _classifyRoad(way) {
  return way.tags?.highway ? way.tags.highway : null;
}

// Carriageway width is rarely tagged in OSM, so it's estimated from lanes.
const LANE_WIDTH_M = 3.25;

/**
 * Estimated half-width (m) of a road's carriageway: half its `width` tag
 * when present, otherwise from `lanes` (or a default: 2 for a two-way road;
 * 2 for a one-way motorway/trunk, 1 for other one-way roads — a dual
 * carriageway is mapped as two one-way ways).
 */
function _halfCarriagewayM(tags) {
  const width = parseFloat(tags.width);
  if (Number.isFinite(width) && width > 0) return width / 2;
  let lanes = parseInt(tags.lanes, 10);
  if (!(lanes > 0)) {
    const oneway =
      tags.oneway === 'yes' ||
      tags.oneway === '1' ||
      tags.junction === 'roundabout';
    const big = /^(motorway|trunk)/.test(tags.highway);
    lanes = oneway && !big ? 1 : 2;
  }
  return (lanes * LANE_WIDTH_M) / 2;
}

/** Compute lat/lon centroid of a coordinate array. */
function _centroidOf(coords) {
  let sumLat = 0,
    sumLon = 0;
  for (let i = 0; i < coords.length; i++) {
    sumLat += coords[i].lat;
    sumLon += coords[i].lon;
  }
  return { lat: sumLat / coords.length, lon: sumLon / coords.length };
}

/** Shortest distance (m) from a point to any segment of a way. */
function _minDistanceToWay(lat, lon, way, distFn) {
  const coords = way.coordinates;
  let best = Infinity;
  for (let i = 0; i < coords.length - 1; i++) {
    const d = distFn(
      lat,
      lon,
      coords[i].lat,
      coords[i].lon,
      coords[i + 1].lat,
      coords[i + 1].lon,
    );
    if (d < best) best = d;
  }
  return best;
}

/**
 * Point-in-polygon test that handles both way and relation (multipolygon)
 * geometries.  Returns true if the point lies inside the green space.
 */
function _isPointInGreenSpace(geom, lat, lon, pipFn) {
  if (geom.type === 'way' && geom.coordinates && geom.coordinates.length > 2) {
    return pipFn(lat, lon, geom.coordinates);
  }
  if (geom.type === 'relation' && geom.outerWays) {
    for (const way of geom.outerWays) {
      if (pipFn(lat, lon, way.coordinates)) {
        // verify not inside an inner island ring
        if (geom.innerWays) {
          let inIsland = false;
          for (const iway of geom.innerWays) {
            if (pipFn(lat, lon, iway.coordinates)) {
              inIsland = true;
              break;
            }
          }
          if (inIsland) continue;
        }
        return true;
      }
    }
  }
  return false;
}

/**
 * Build concentric-ring sampling points around (lat, lon).
 * Returns an array of {lat, lon} (no .contained property).
 */
function _buildSamplingGrid(lat, lon, radiusMeters) {
  const radLat = radiusMeters / METERS_PER_DEG_LAT;
  const radLon =
    radiusMeters / (METERS_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180));
  // Each point carries the share of the buffer's AREA it stands for: ring k
  // (radius k/K) covers the annulus between the midpoints to its neighbours
  // (the outermost ring stops at the buffer edge), the centre the disc inside
  // the first midpoint. Unweighted, the 16 perimeter points were 64% of the
  // vote for ~44% of the area, so the "% within r" read as "% on the edge".
  const K = SAMPLING_RINGS;
  const centreR = 0.5 / K;
  const points = [{ lat, lon, w: centreR * centreR }]; // centre
  for (let r = 1; r <= K; r++) {
    const frac = r / K;
    const rLat = radLat * frac;
    const rLon = radLon * frac;
    const nPts = POINTS_PER_RING[r];
    const inner = (r - 0.5) / K;
    const outer = Math.min(1, (r + 0.5) / K);
    const w = (outer * outer - inner * inner) / nPts;
    for (let p = 0; p < nPts; p++) {
      const a = (p / nPts) * 2 * Math.PI;
      points.push({
        lat: lat + rLat * Math.sin(a),
        lon: lon + rLon * Math.cos(a),
        w,
      });
    }
  }
  return points;
}

// -- Main OSMEnricher namespace ---------------------------------------------

export const OSMEnricher = {
  // Configurable settings
  overpassEndpoint: 'https://overpass-api.de/api/interpreter',

  /* ======================================================================
     Math utilities
     ====================================================================== */

  haversine(lat1, lon1, lat2, lon2) {
    return GeoUtils.haversineMeters(lat1, lon1, lat2, lon2);
  },

  distanceToSegment(lat, lon, lat1, lon1, lat2, lon2) {
    return GeoUtils.distanceToSegmentMeters(lat, lon, lat1, lon1, lat2, lon2);
  },

  pointInPolygon(lat, lon, poly) {
    return GeoUtils.pointInPolygon(lat, lon, poly);
  },

  /* ======================================================================
     Feature classification — the single source of truth for "what counts as
     green / water", shared with manager/osm.js's OSM-layer overlay so the
     drawn polygons and the enrichment metrics can never disagree.
     ====================================================================== */

  isGreenSpace(geom) {
    return _isGreenSpace(geom);
  },
  isWaterSpace(geom) {
    return _isWaterSpace(geom);
  },
  // True for a carriageway a vehicle drives on (vs. a footway/path/cycleway/
  // steps a pedestrian walks). Shared with the GSR graph's context bands
  // (renderer.js) so a footpath inside a park reads as park there too,
  // rather than re-deriving its own notion of "which roads count".
  isVehicularRoad(highwayClass) {
    return VEHICULAR_ROAD_CLASSES.has(highwayClass);
  },

  _buildSamplingGrid(lat, lon, radiusMeters) {
    return _buildSamplingGrid(lat, lon, radiusMeters);
  },

  /* ======================================================================
     Bounding box & query building
     ====================================================================== */

  /**
   * Returns true if (lat, lon) is a valid, plausible GPS coordinate.
   * Filters out NaN, null, (0,0) sentinel values, and obviously out-of-range readings
   * that would inflate the Overpass bounding box and cause 504 timeouts.
   */
  _isValidCoord(lat, lon) {
    if (lat == null || lon == null) return false;
    if (isNaN(lat) || isNaN(lon)) return false;
    // Reject (0,0) and near-zero — common GPS-startup sentinel
    if (Math.abs(lat) < 0.001 && Math.abs(lon) < 0.001) return false;
    // Valid lat/lon range
    if (lat < -90 || lat > 90) return false;
    if (lon < -180 || lon > 180) return false;
    return true;
  },

  calculateBBox(rawPoints, bufferMeters = DEFAULT_BBOX_BUFFER_M) {
    const rawBounds = GeoUtils.computeBounds(rawPoints, 0, (pt) =>
      this._isValidCoord(pt.lat, pt.lon),
    );
    if (!rawBounds) return null;
    return GeoUtils.expandBounds(rawBounds, bufferMeters);
  },

  calculateBBoxAreaKm2(bbox) {
    return GeoUtils.bboxAreaKm2(bbox);
  },

  /**
   * Stash Overpass JSON on an analyzer together with the bbox it is known to
   * cover (the fetched bbox, or the requested bbox on a cache hit). Every
   * writer of analyzer.osmJson goes through here so osmJsonFor() can tell
   * whether the in-memory copy is still wide enough for the current radius.
   */
  setAnalyzerOsmJson(analyzer, json, coveredBBox) {
    // Geometry reconstructed from a replaced JSON is stale (rebuilding it is
    // cheap — reconstructGeometries() memoises per JSON object).
    if (analyzer.osmJson !== json) analyzer.osmGeoms = null;
    analyzer.osmJson = json;
    analyzer.osmJsonBBox = json ? coveredBBox || null : null;
  },

  /**
   * The analyzer's in-memory Overpass JSON if it covers `bbox`, else null —
   * e.g. after the OSM or snap radius was raised, the JSON fetched for the
   * old, smaller buffer no longer reaches every feature within the new radius
   * of the walk's outermost points, so the caller must go back to the cache.
   */
  osmJsonFor(analyzer, bbox) {
    if (!analyzer?.osmJson) return null;
    return GeoUtils.bboxContains(analyzer.osmJsonBBox, bbox)
      ? analyzer.osmJson
      : null;
  },

  /* ======================================================================
     Overpass API
     ====================================================================== */

  async fetchOSMData(bbox, onProgress) {
    return OverpassClient.fetchOSMData(bbox, onProgress);
  },

  /* ======================================================================
     Geometry reconstruction
     ====================================================================== */

  reconstructGeometries(osmJson) {
    const cached = _geomsCache.get(osmJson);
    if (cached) return cached;

    const nodeMap = new Map();
    const wayMap = new Map(); // O(1) lookup for relation resolution
    const ways = [];
    const points = [];
    const relations = [];

    // 1. Index nodes
    for (const el of osmJson.elements) {
      if (el.type === 'node') {
        nodeMap.set(el.id, { lat: el.lat, lon: el.lon });
        if (el.tags) points.push(el);
      }
    }

    // 2. Resolve ways and index by ID
    for (const el of osmJson.elements) {
      if (el.type === 'way') {
        const coords = [];
        for (const nid of el.nodes) {
          const n = nodeMap.get(nid);
          if (n) coords.push(n);
        }
        el.coordinates = coords;
        ways.push(el);
        wayMap.set(el.id, el);
      }
    }

    // 3. Resolve relations (multipolygons) — O(1) way lookup
    for (const el of osmJson.elements) {
      if (el.type === 'relation' && el.members) {
        const outerWays = [],
          innerWays = [];
        for (const mem of el.members) {
          if (mem.type === 'way') {
            const way = wayMap.get(mem.ref);
            if (way && way.coordinates.length > 0) {
              (mem.role === 'inner' ? innerWays : outerWays).push(way);
            }
          }
        }
        el.outerWays = outerWays;
        el.innerWays = innerWays;
        relations.push(el);
      }
    }

    const geoms = { nodeMap, ways, points, relations };
    _geomsCache.set(osmJson, geoms);
    return geoms;
  },

  /* ======================================================================
     Spatial index (grid hash)
     ====================================================================== */

  /**
   * Thin wrapper over the shared SpatialGrid (spatial_grid.js): computes each
   * geom's own lat/lon bbox, then inserts it padded by one extra cell in
   * every direction. Combined with getNearby()'s own 3x3-neighbourhood query
   * below, a geom is reachable from up to ~2 cells away (~222m at
   * CELL_SIZE_DEG=0.001) — deliberately wider than the single-cell reach
   * either padding alone would give, since enrichment search radii can
   * exceed one cell width. _evaluatePosition still does the real distance/
   * containment check on every candidate this returns, so over-inclusion
   * here only costs a bit of extra evaluation work, never a wrong result.
   */
  buildSpatialIndex(geoms) {
    const cached = _spatialIndexCache.get(geoms);
    if (cached) return cached;

    const spatialGrid = new SpatialGrid(CELL_SIZE_DEG);

    const insert = (geom) => {
      let minLat = Infinity,
        maxLat = -Infinity;
      let minLon = Infinity,
        maxLon = -Infinity;

      const visit = (lat, lon) => {
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
      };

      if (geom.type === 'node') {
        visit(geom.lat, geom.lon);
      } else if (geom.coordinates) {
        for (const pt of geom.coordinates) visit(pt.lat, pt.lon);
      } else if (geom.outerWays) {
        for (const way of geom.outerWays) {
          for (const pt of way.coordinates) visit(pt.lat, pt.lon);
        }
      }

      if (minLat === Infinity) return;
      spatialGrid.insert({ minLat, maxLat, minLon, maxLon }, geom, 1);
    };

    for (const p of geoms.points) insert(p);
    for (const w of geoms.ways) insert(w);
    for (const r of geoms.relations) insert(r);

    const index = {
      getNearby(lat, lon) {
        return spatialGrid.getNearby(
          lat,
          lon,
          (item) => `${item.type}_${item.id}`,
        );
      },
    };
    _spatialIndexCache.set(geoms, index);
    return index;
  },

  /* ======================================================================
     Enrichment pipeline
     ====================================================================== */

  /**
   * Select evaluation points: GPS fixes at ≥1 s intervals.
   * Always includes the last fix.
   */
  _selectEvaluationPoints(raw, gpsIndices) {
    const points = [];
    let lastT = -999;
    for (const pt of gpsIndices) {
      const t = raw[pt.idx].time;
      if (t - lastT >= 1.0) {
        points.push(pt);
        lastT = t;
      }
    }
    const last = gpsIndices[gpsIndices.length - 1];
    if (points.length > 0 && points[points.length - 1].idx !== last.idx) {
      points.push(last);
    }
    return points;
  },

  /**
   * Spatial thinning: keep only points that are at least `minDist` metres
   * from the last kept point.  Always keeps the first and last point.
   * Reduces evaluation-point density so the snap ramp spans a meaningful
   * physical distance rather than completing in a few metres.
   */
  _thinPoints(points, minDist) {
    if (points.length < 3) return points;
    const kept = [points[0]];
    for (let i = 1; i < points.length - 1; i++) {
      const prev = kept[kept.length - 1];
      const d = this.haversine(
        prev.lat,
        prev.lon,
        points[i].lat,
        points[i].lon,
      );
      if (d >= minDist) {
        kept.push(points[i]);
      }
    }
    // Always keep the last point
    const last = points[points.length - 1];
    if (kept[kept.length - 1].idx !== last.idx) {
      kept.push(last);
    }
    return kept;
  },

  /**
   * Evaluate all environmental metrics at a single (lat, lon) position.
   * Returns a metrics object.
   */
  _evaluatePosition(lat, lon, nearby, radiusMeters) {
    const distFn = this.distanceToSegment.bind(this);
    const havFn = this.haversine.bind(this);
    const pipFn = this.pointInPolygon.bind(this);

    let minRoadDist = Infinity,
      nearestRoadClass = 'none',
      minMajorRoadDist = Infinity;
    let minVehRoadDist = Infinity,
      nearestVehRoadClass = null;
    let inPark = 0,
      minWaterDist = Infinity,
      minGreenDist = Infinity;
    let buildingCount = 0,
      treeCount = 0,
      amenityCount = 0;

    // Sampling grid — shared by green-space coverage and tree-canopy coverage
    const samplingPoints = _buildSamplingGrid(lat, lon, radiusMeters);
    let greenHits = 0,
      canopyHits = 0;

    for (const geom of nearby) {
      const tags = geom.tags;
      if (!tags) continue;

      // -- Roads --
      if (
        geom.type === 'way' &&
        tags.highway &&
        !NON_ROAD_HIGHWAY.has(tags.highway)
      ) {
        const d = _minDistanceToWay(lat, lon, geom, distFn);
        if (d < minRoadDist) {
          minRoadDist = d;
          nearestRoadClass = _classifyRoad(geom);
        }
        if (VEHICULAR_ROAD_CLASSES.has(tags.highway) && d < minVehRoadDist) {
          minVehRoadDist = d;
          nearestVehRoadClass = tags.highway;
        }
        if (MAJOR_ROAD_CLASSES.has(tags.highway)) {
          // To the kerb, not the centre line: a walker snapped onto the centre
          // line (pavement only noted as a tag) and one on a separately
          // mapped pavement beside the same road should read about the same.
          const kerb = Math.max(0, d - _halfCarriagewayM(tags));
          if (kerb < minMajorRoadDist) minMajorRoadDist = kerb;
        }
      }

      // -- Buildings (nearest footprint edge, ways + multipolygon relations) --
      // Centroid distance under-counts a large footprint whose wall is metres
      // away but whose centre is far — exactly the buildings that create the
      // "enclosure" this metric is meant to capture — and `relation["building"]`
      // multipolygons (fetched by the query, reconstructed into outerWays) were
      // not counted at all.
      if (tags.building) {
        let d = Infinity;
        if (
          geom.type === 'way' &&
          geom.coordinates &&
          geom.coordinates.length > 1
        ) {
          d = _minDistanceToWay(lat, lon, geom, distFn);
        } else if (geom.type === 'relation' && geom.outerWays) {
          for (const way of geom.outerWays) {
            if (way.coordinates && way.coordinates.length > 1) {
              d = Math.min(d, _minDistanceToWay(lat, lon, way, distFn));
            }
          }
        }
        if (d <= radiusMeters) buildingCount++;
      }

      // -- Water --
      if (_isWaterSpace(geom)) {
        let d = Infinity;
        if (geom.type === 'way') {
          d = _minDistanceToWay(lat, lon, geom, distFn);
        } else if (geom.type === 'relation' && geom.outerWays) {
          for (const way of geom.outerWays) {
            d = Math.min(d, _minDistanceToWay(lat, lon, way, distFn));
          }
        }
        if (d < minWaterDist) minWaterDist = d;
      }

      // -- Trees --
      if (geom.type === 'node' && tags.natural === 'tree') {
        if (havFn(lat, lon, geom.lat, geom.lon) <= radiusMeters) treeCount++;
      }

      // -- Amenities / shops / bus stops --
      if (
        tags.shop ||
        AMENITY_TYPES.has(tags.amenity) ||
        tags.highway === 'bus_stop'
      ) {
        let d = Infinity;
        if (geom.type === 'node') {
          d = havFn(lat, lon, geom.lat, geom.lon);
        } else if (geom.coordinates && geom.coordinates.length > 0) {
          const c = _centroidOf(geom.coordinates);
          d = havFn(lat, lon, c.lat, c.lon);
        }
        if (d <= radiusMeters) amenityCount++;
      }

      // -- Green space --
      if (_isGreenSpace(geom)) {
        const insideThis = _isPointInGreenSpace(geom, lat, lon, pipFn);
        if (insideThis) inPark = 1;

        // Distance to this green space — 0 when standing in it, otherwise the
        // distance to its nearest boundary (outer ring, or an inner-ring
        // "hole" edge — the edge of a clearing/pond inside a wood is still a
        // green boundary). This is the *visual-perception* channel: a park
        // across the street is part of the view even though the GPS point is
        // not inside its polygon. `in_park` is the 0/1 special case of this.
        let gd;
        if (insideThis) {
          gd = 0;
        } else {
          gd = Infinity;
          if (
            geom.type === 'way' &&
            geom.coordinates &&
            geom.coordinates.length > 1
          ) {
            gd = _minDistanceToWay(lat, lon, geom, distFn);
          } else if (geom.type === 'relation') {
            for (const w of geom.outerWays || []) {
              if (w.coordinates && w.coordinates.length > 1)
                gd = Math.min(gd, _minDistanceToWay(lat, lon, w, distFn));
            }
            for (const w of geom.innerWays || []) {
              if (w.coordinates && w.coordinates.length > 1)
                gd = Math.min(gd, _minDistanceToWay(lat, lon, w, distFn));
            }
          }
        }
        if (gd < minGreenDist) minGreenDist = gd;

        // sampling grid density
        for (const sPt of samplingPoints) {
          if (
            !sPt._hit &&
            _isPointInGreenSpace(geom, sPt.lat, sPt.lon, pipFn)
          ) {
            sPt._hit = true;
            greenHits += sPt.w;
          }
        }
      }

      // -- Tree canopy --
      // Fraction of the sampling grid under a wood/forest polygon, or within
      // CANOPY_BUFFER_M of a natural=tree_row way / natural=tree node.
      if (_isCanopy(geom)) {
        const isNode = geom.type === 'node'; // natural=tree
        const isLinear = geom.tags.natural === 'tree_row'; // linear way
        for (const sPt of samplingPoints) {
          if (sPt._canopyHit) continue;
          let hit = false;
          if (isNode) {
            hit =
              havFn(sPt.lat, sPt.lon, geom.lat, geom.lon) <= CANOPY_BUFFER_M;
          } else if (isLinear) {
            hit =
              geom.coordinates &&
              geom.coordinates.length > 1 &&
              _minDistanceToWay(sPt.lat, sPt.lon, geom, distFn) <=
                CANOPY_BUFFER_M;
          } else {
            hit = _isPointInGreenSpace(geom, sPt.lat, sPt.lon, pipFn); // wood / forest polygon
          }
          if (hit) {
            sPt._canopyHit = true;
            canopyHits += sPt.w;
          }
        }
      }
    }

    // Prefer the nearest motor-traffic carriageway when one is close by
    // (within the radius, and no more than 25 m away): otherwise a park footway
    // a couple of metres off hides the residential/primary road just beyond it
    // and the road-class profile fills with 'footway'/'path' rows. A road
    // further than 25 m doesn't relabel where you are — the literal nearest way
    // stands.
    if (nearestVehRoadClass && minVehRoadDist <= Math.min(radiusMeters, 25)) {
      nearestRoadClass = nearestVehRoadClass;
    }

    // Sanitize distances
    if (minRoadDist === Infinity) minRoadDist = SENTINEL_DIST;
    if (minMajorRoadDist === Infinity) minMajorRoadDist = SENTINEL_DIST;
    if (minWaterDist === Infinity) minWaterDist = SENTINEL_DIST;
    if (minGreenDist === Infinity) minGreenDist = SENTINEL_DIST;

    // Green-space and tree-canopy coverage (float — rounding deferred to display)
    // Area-weighted (the point weights sum to 1).
    const greenPct = greenHits * 100;
    const canopyPct = canopyHits * 100;

    return {
      roadClass: nearestRoadClass,
      distMajorRoad: minMajorRoadDist,
      inPark,
      greenSpacePct: greenPct,
      distGreen: minGreenDist,
      canopyPct,
      buildingDensity: buildingCount,
      distWater: minWaterDist,
      treeDensity: treeCount,
      amenityCount,
    };
  },

  /**
   * First and last row index that has a position: from `positions`
   * (_enrichmentPositions) when given, else the raw rows with a lat/lon.
   * Rows outside it (before the first GPS fix, after the last) have no
   * position, so get no map context or snap. `first > last` when none has.
   * @private
   */
  _positionedRange(raw, positions = null) {
    if (positions) {
      return positions.length
        ? { first: positions[0].idx, last: positions[positions.length - 1].idx }
        : { first: 0, last: -1 };
    }
    const hasPos = (i) => !isNaN(raw[i]?.lat) && !isNaN(raw[i]?.lon);
    let first = 0;
    while (first < raw.length && !hasPos(first)) first++;
    let last = raw.length - 1;
    while (last >= 0 && !hasPos(last)) last--;
    return { first, last };
  },

  /**
   * Project sparse evaluation metrics onto the full 10 Hz raw timeline
   * using linear interpolation for continuous variables and step
   * interpolation for categorical variables. Only rows with a position
   * (see _positionedRange) get values; the rest are cleared to the CSV
   * parser's blanks (null road class, NaN otherwise).
   */
  _projectToTimeline(raw, computedMetrics, positions = null) {
    if (computedMetrics.length === 0) return;
    const { first: firstPos, last: lastPos } = this._positionedRange(
      raw,
      positions,
    );
    for (let i = 0; i < raw.length; i++) {
      if (i >= firstPos && i <= lastPos) continue;
      raw[i].osm_road_class = null;
      raw[i].osm_in_park = NaN;
      raw[i].osm_dist_major_road = NaN;
      raw[i].osm_green_pct_50m = NaN;
      raw[i].osm_dist_green = NaN;
      raw[i].osm_canopy_pct_50m = NaN;
      raw[i].osm_building_density_50m = NaN;
      raw[i].osm_dist_water = NaN;
      raw[i].osm_tree_density_50m = NaN;
      raw[i].osm_amenity_count_50m = NaN;
    }

    // Single-evaluation edge case: broadcast to every positioned sample
    if (computedMetrics.length === 1) {
      const m = computedMetrics[0].metrics;
      for (let i = firstPos; i <= lastPos; i++) {
        raw[i].osm_road_class = m.roadClass;
        raw[i].osm_in_park = m.inPark;
        raw[i].osm_dist_major_road = m.distMajorRoad;
        raw[i].osm_green_pct_50m = m.greenSpacePct;
        raw[i].osm_dist_green = m.distGreen;
        raw[i].osm_canopy_pct_50m = m.canopyPct;
        raw[i].osm_building_density_50m = m.buildingDensity;
        raw[i].osm_dist_water = m.distWater;
        raw[i].osm_tree_density_50m = m.treeDensity;
        raw[i].osm_amenity_count_50m = m.amenityCount;
      }
      return;
    }

    let segIdx = 1; // current segment: between [segIdx-1] and [segIdx]

    for (let i = firstPos; i <= lastPos; i++) {
      // Advance segment when we cross the next evaluation index
      while (
        segIdx < computedMetrics.length &&
        i >= computedMetrics[segIdx].idx
      ) {
        segIdx++;
      }

      const prev = computedMetrics[segIdx - 1];
      const next =
        computedMetrics[Math.min(segIdx, computedMetrics.length - 1)];

      const span = next.idx - prev.idx;
      // Clamped: positioned samples before the first evaluation point hold
      // its value rather than extrapolating backwards (e.g. to a negative
      // green-space %).
      const t = span > 0 ? Math.max(0, Math.min(1, (i - prev.idx) / span)) : 0;
      const p = prev.metrics,
        n = next.metrics;

      const lerp = (a, b) => a + (b - a) * t;
      const step = (a, b) => (t >= 0.5 ? b : a);
      // Distance fields: when one endpoint is the SENTINEL_DIST "no feature
      // within radius" marker the distance is censored (> radius), so a lerp
      // would invent mid-range distances. Step instead: each sample takes its
      // nearer evaluation point's value, so the far half stays "beyond
      // radius" (and is dropped by consumers that filter === 999) rather than
      // being given a fabricated near distance.
      const lerpDist = (a, b) => {
        if (a === SENTINEL_DIST || b === SENTINEL_DIST) return step(a, b);
        return lerp(a, b);
      };

      raw[i].osm_road_class = step(p.roadClass, n.roadClass);
      raw[i].osm_in_park = step(p.inPark, n.inPark);
      raw[i].osm_dist_major_road = lerpDist(p.distMajorRoad, n.distMajorRoad);
      raw[i].osm_green_pct_50m = lerp(p.greenSpacePct, n.greenSpacePct);
      raw[i].osm_dist_green = lerpDist(p.distGreen, n.distGreen);
      raw[i].osm_canopy_pct_50m = lerp(p.canopyPct, n.canopyPct);
      // Discrete counts: step to the nearest evaluation point. Interpolating
      // them manufactures fractional buildings / trees / amenities that never
      // existed and over-smooths the predictor — which inflates its serial
      // autocorrelation, exactly what the dashboard then has to correct back
      // out when it down-weights the effective sample size.
      raw[i].osm_building_density_50m = step(
        p.buildingDensity,
        n.buildingDensity,
      );
      raw[i].osm_dist_water = lerpDist(p.distWater, n.distWater);
      raw[i].osm_tree_density_50m = step(p.treeDensity, n.treeDensity);
      raw[i].osm_amenity_count_50m = step(p.amenityCount, n.amenityCount);
    }
  },

  /**
   * Positions to map-match and enrich, one per row that has one: the smoothed
   * GPS path before any road snap (GpsPipeline.unsnappedPath), the raw row
   * where that path is blank. Not the drawn path: its road-snap pull comes
   * from an earlier enrichment, and re-matching it would entrench any wrong
   * snap (e.g. onto a parallel street) on every re-run.
   * @returns {Array<{idx: number, lat: number, lon: number}>}
   */
  _enrichmentPositions(analyzer) {
    const raw = analyzer.raw;
    const path = GpsPipeline.unsnappedPath(analyzer);
    const out = [];
    for (let i = 0; i < raw.length; i++) {
      const f = path[i];
      const p = f && !isNaN(f.lat) && !isNaN(f.lon) ? f : raw[i];
      if (
        p &&
        p.lat != null &&
        p.lon != null &&
        !isNaN(p.lat) &&
        !isNaN(p.lon)
      ) {
        out.push({ idx: i, lat: p.lat, lon: p.lon });
      }
    }
    return out;
  },

  /**
   * Enrich continuous track data series: runs spatial queries on ~1 Hz
   * GPS coordinates and projects results back to the full 10 Hz timeline.
   *
   * When snapParams.enabled is true, the track is snapped to the roads
   * (_snapTrack) before enrichment metrics are computed, so enrichment sees
   * the corrected (snapped) position — never misattributes a building
   * because of GPS multipath drift.
   *
   * @param {Object} analyzer     - GSRAnalyzer instance (has .raw, .getCoordinates())
   * @param {Object} osmJson      - parsed Overpass API JSON
   * @param {number} radiusMeters - search radius (default 50)
   * @param {Object} [snapParams] - { enabled: bool, ... } road snapping config
   * @param {Function} onProgress - optional progress callback(msg)
   */
  enrichTrack(
    analyzer,
    osmJson,
    radiusMeters = DEFAULT_RADIUS_M,
    snapParams,
    onProgress,
  ) {
    const raw = analyzer.raw;
    if (!raw || raw.length === 0) return;

    const doSnap = snapParams?.enabled;

    // Clear stale snapped positions when snapping is disabled so renderData
    // doesn't substitute from a previous enrichment run.
    if (!doSnap) {
      analyzer.snappedGps = null;
    }

    // 1. Reconstruct geometries & build spatial index
    if (onProgress) onProgress('Assembling spatial index...');
    const geoms = this.reconstructGeometries(osmJson);
    const spatialIndex = this.buildSpatialIndex(geoms);

    // Cache reconstructed geometries so drawOsmShapes doesn't rebuild them
    analyzer.osmGeoms = geoms;

    // 2. Collect GPS positions from the track
    if (onProgress) onProgress('Analyzing GPS positions...');
    const gpsIndices = this._enrichmentPositions(analyzer);
    if (gpsIndices.length === 0) {
      throw new Error('No valid GPS coordinates found in this track.');
    }

    // 3. Downsample to ~1 Hz evaluation points, each with the features
    //    near it (MapMatcher reuses them for its road candidates).
    let evalPoints = this._selectEvaluationPoints(raw, gpsIndices);
    if (doSnap) evalPoints = this._thinPoints(evalPoints, SNAP_THIN_M);
    const points = this._withNearby(evalPoints, spatialIndex);

    // Snapping matches the whole sequence at once (HMM-Viterbi), so the
    // metrics below see each point's snapped position.
    let matched = null;
    if (doSnap) {
      if (onProgress) onProgress('HMM map-matching: running Viterbi...');
      const snap = this._snapTrack(
        raw,
        points,
        gpsIndices,
        snapParams.radiusOut,
      );
      analyzer.snappedGps = snap.snappedGps;
      matched = snap.matched;
    }

    const computedMetrics = [];
    for (let s = 0; s < points.length; s++) {
      if (s % 50 === 0 && onProgress) {
        onProgress(
          `Computing spatial metrics: ${s}/${points.length} positions...`,
        );
      }
      const node = points[s];
      const at = matched?.get(node.idx) || node;
      computedMetrics.push({
        idx: node.idx,
        time: raw[node.idx].time,
        metrics: this._evaluatePosition(
          at.lat,
          at.lon,
          node.nearby,
          radiusMeters,
        ),
      });
    }

    // 4. Project back to full timeline
    if (onProgress) onProgress('Projecting results to full timeline...');
    this._projectToTimeline(raw, computedMetrics, gpsIndices);

    analyzer.isEnriched = true;
    // Wrote osm_* fields onto every raw sample above — bump so callers
    // caching derived data (e.g. GSRUI's environmental dashboard) recompute.
    analyzer._dataVersion = (analyzer._dataVersion || 0) + 1;
    if (onProgress) onProgress('Enrichment complete!');
  },

  /**
   * Evaluation points with the spatial-index features near each attached
   * as `nearby`.
   */
  _withNearby(evalPoints, spatialIndex) {
    return evalPoints.map((node) => ({
      ...node,
      nearby: spatialIndex.getNearby(node.lat, node.lon),
    }));
  },

  /**
   * Snap a track to the roads: match the evaluation points (_withNearby) as
   * one sequence (MapMatcher), then fill the rows between them
   * (_interpolateSnappedGps).
   * @returns {{snappedGps: Array<object>, matched: Map<number, object>}}
   *   snappedGps has one entry per raw row; matched holds the points' own.
   */
  _snapTrack(raw, points, positions, radius) {
    const matched = MapMatcher.match(
      points,
      raw,
      radius || MapMatcher.MATCH_RADIUS,
    );
    const snappedGps = Array.from({ length: raw.length }, () => ({
      lat: NaN,
      lon: NaN,
    }));
    for (const [idx, r] of matched) snappedGps[idx] = r;
    this._interpolateSnappedGps(snappedGps, raw, positions);
    return { snappedGps, matched };
  },

  /**
   * Fill the snapped track `sg` (one entry per raw row) between the matched rows.
   *
   * Each matched row carries a shift: how far, and which way, the snap moves
   * it (its road point minus the position the matcher was given). The rows in
   * between take the shift and the snap weight linearly from the matched rows
   * either side, applied to their own position. The snapped path is then the
   * smoothed path plus a gradually changing shift, so it cannot jump at a row
   * the matcher never looked at. Placing each in-between row on a road by
   * itself let neighbouring rows land on different points, bends or roads
   * from the matched rows beside them, and the drawn path zig-zagged.
   *
   * `positions` are the positions the matcher was given (the smoothed path);
   * a row missing from it falls back to its raw fix. The ends are held out to
   * the first/last row that has a position (see _positionedRange) and no
   * further: rows before the first GPS fix or after the last have no
   * position, so no snap either.
   */
  _interpolateSnappedGps(sg, raw, positions = null) {
    const valid = [];
    for (let i = 0; i < sg.length; i++) {
      if (!isNaN(sg[i].lat) && !isNaN(sg[i].lon)) valid.push(i);
    }
    if (valid.length === 0) return;

    const posAt = new Array(raw.length);
    if (positions) {
      for (const p of positions) {
        if (Number.isFinite(p.lat) && Number.isFinite(p.lon)) posAt[p.idx] = p;
      }
    }
    const pos = (i) => {
      const p = posAt[i] || raw[i];
      return p && Number.isFinite(p.lat) && Number.isFinite(p.lon) ? p : null;
    };

    const shifts = valid.map((k) => {
      const e = sg[k];
      const p = pos(k) || { lat: e.roadLat, lon: e.roadLon };
      return {
        dLat: e.roadLat - p.lat,
        dLon: e.roadLon - p.lon,
        alpha: e.alpha,
        dist: e.dist,
        wayId: e.wayId,
      };
    });

    const place = (i, s) => {
      const p = pos(i);
      if (!p) {
        sg[i] = { lat: NaN, lon: NaN };
        return;
      }
      sg[i] = {
        lat: p.lat + s.alpha * s.dLat,
        lon: p.lon + s.alpha * s.dLon,
        roadLat: p.lat + s.dLat,
        roadLon: p.lon + s.dLon,
        alpha: s.alpha,
        dist: s.dist,
        wayId: s.wayId,
      };
    };

    const { first: firstPos, last: lastPos } = this._positionedRange(
      raw,
      positions,
    );
    for (let i = firstPos; i < valid[0]; i++) place(i, shifts[0]);

    for (let k = 0; k < valid.length - 1; k++) {
      const a = valid[k];
      const b = valid[k + 1];
      const A = shifts[k];
      const B = shifts[k + 1];
      for (let i = a + 1; i < b; i++) {
        const t = (i - a) / (b - a);
        const near = t < 0.5 ? A : B;
        place(i, {
          dLat: A.dLat + t * (B.dLat - A.dLat),
          dLon: A.dLon + t * (B.dLon - A.dLon),
          alpha: A.alpha + t * (B.alpha - A.alpha),
          // A row matched to no road has no distance (Infinity) to blend.
          dist:
            Number.isFinite(A.dist) && Number.isFinite(B.dist)
              ? A.dist + t * (B.dist - A.dist)
              : near.dist,
          wayId: near.wayId,
        });
      }
    }

    const last = valid[valid.length - 1];
    for (let i = last + 1; i <= lastPos; i++) {
      place(i, shifts[shifts.length - 1]);
    }
  },

  /**
   * Fast HMM road-snapping for a track against reconstructed OSM geometries.
   * Useful when geometries are already available (e.g. from cache or OSM shapes)
   * so an enriched track can classify junction turns without a slow full re-enrichment.
   *
   * @param {object} analyzer
   * @param {object} geoms
   * @param {number} [snapRadius=25]
   * @param {{commit?: boolean}} [opts] commit:false leaves analyzer.snappedGps
   *   and _dataVersion untouched (the map keeps showing raw positions when the
   *   user has snapping off); the result is returned only.
   * @returns {Array<object>|null}
   */
  snapTrackGps(analyzer, geoms, snapRadius = 25, opts = {}) {
    const commit = opts.commit !== false;
    const raw = analyzer?.raw;
    if (!raw || raw.length === 0 || !geoms?.ways || geoms.ways.length === 0) {
      return null;
    }

    analyzer.osmGeoms = geoms;
    const gpsIndices = this._enrichmentPositions(analyzer);
    if (gpsIndices.length === 0) return null;

    const evalPoints = this._thinPoints(
      this._selectEvaluationPoints(raw, gpsIndices),
      SNAP_THIN_M,
    );
    const { snappedGps } = this._snapTrack(
      raw,
      this._withNearby(evalPoints, this.buildSpatialIndex(geoms)),
      gpsIndices,
      snapRadius,
    );
    if (commit) {
      analyzer.snappedGps = snappedGps;
      analyzer._dataVersion = (analyzer._dataVersion || 0) + 1;
    }
    return snappedGps;
  },

  /**
   * Snapped positions for analysis (junction detection). Uses the committed
   * analyzer.snappedGps when snapping is on; otherwise a private snap that is
   * cached per (raw, geoms, radius) and never reaches the map.
   */
  analysisSnap(analyzer, snapRadius = 25) {
    if (analyzer.snappedGps) return analyzer.snappedGps;
    const geoms = analyzer.osmGeoms;
    if (!geoms?.ways) return null;
    const c = analyzer._analysisSnap;
    if (
      c &&
      c.raw === analyzer.raw &&
      c.geoms === geoms &&
      c.r === snapRadius
    ) {
      return c.gps;
    }
    const gps = this.snapTrackGps(analyzer, geoms, snapRadius, {
      commit: false,
    });
    analyzer._analysisSnap = { raw: analyzer.raw, geoms, r: snapRadius, gps };
    return gps;
  },

  /**
   * Junction passages for one enriched track (control samples included), on
   * the analysis snap.  Memoised per (snap, geoms, radius) so the analysis
   * table and the map debug overlay share one classification.
   * @returns {{pts:Array, passages:Array, nodes:Map}|null} null when the track
   *   has no road geometry or too few matched fixes.
   */
  junctionPassages(analyzer, snapRadius = 25) {
    if (!analyzer?.isEnriched || !analyzer.osmGeoms?.ways) return null;
    const snapped = this.analysisSnap(analyzer, snapRadius);
    if (!snapped) return null;
    const c = analyzer._junctionPassages;
    if (c && c.snapped === snapped && c.ways === analyzer.osmGeoms.ways) {
      return c.result;
    }
    const pts = Junctions.buildPts(analyzer.raw || [], snapped);
    let result = null;
    if (pts.length >= 2) {
      const ways = analyzer.osmGeoms.ways;
      const index = Junctions.buildIndex(ways);
      const passages = Junctions.classifyPassages(pts, ways, {
        includeControl: true,
        index,
      });
      result = { pts, passages, nodes: index.nodes };
    }
    analyzer._junctionPassages = {
      snapped,
      ways: analyzer.osmGeoms.ways,
      result,
    };
    return result;
  },
};
