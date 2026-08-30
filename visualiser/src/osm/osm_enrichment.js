/**
 * OSM Environmental Enrichment Module for Bio Mapping
 * Handles Overpass API fetching, client-side spatial grid hashing, 
 * geometry reconstruction, and coordinate-to-feature spatial math.
 */

// -- Numerical constants ---------------------------------------------------
const METERS_PER_DEG_LAT  = GeoUtils.METERS_PER_DEG_LAT;         // m per degree of latitude
const METERS_PER_DEG_LAT_KM = METERS_PER_DEG_LAT / 1000.0;       // km per degree (area calcs)
const CELL_SIZE_DEG       = 0.001;          // spatial-hash cell (~111 m)
const SENTINEL_DIST       = 999;            // sentinel for "no feature nearby"
const DEFAULT_RADIUS_M    = 50;             // enrichment search radius
const DEFAULT_BBOX_BUFFER_M = 100;          // bounding-box padding

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
const SAMPLING_RINGS      = 3;              // concentric rings
const POINTS_PER_RING     = [1, 8, 16];     // centre, ring 1, ring 2

// -- OSM tag sets ----------------------------------------------------------
const MAJOR_ROAD_CLASSES = new Set([
  'motorway', 'trunk', 'primary', 'secondary'
]);
const AMENITY_TYPES = new Set([
  'cafe', 'restaurant', 'pub', 'fast_food', 'bar',
  'school', 'university', 'hospital', 'clinic',
  'library', 'place_of_worship',
  'parking', 'fuel'
]);

const GREEN_LEISURE = new Set(['park', 'garden', 'nature_reserve', 'playground']);
const GREEN_LANDUSE = new Set(['grass', 'forest', 'meadow', 'recreation_ground', 'village_green', 'orchard']);
const GREEN_NATURAL = new Set(['wood', 'scrub', 'grassland', 'heath']);

const WATER_NATURAL  = new Set(['water', 'wetland']);
const WATER_WATERWAY = new Set(['river', 'canal', 'stream', 'drain', 'ditch']);
const WATER_LANDUSE  = new Set(['basin', 'reservoir']);

// -- Module-level helpers --------------------------------------------------

/** True when geom represents any kind of green/natural space. */
function _isGreenSpace(geom) {
  const t = geom.tags;
  if (!t) return false;
  return GREEN_LEISURE.has(t.leisure)  ||
         GREEN_LANDUSE.has(t.landuse)  ||
         GREEN_NATURAL.has(t.natural);
}

/** True when geom represents any kind of water body or waterway. */
function _isWaterSpace(geom) {
  const t = geom.tags;
  if (!t) return false;
  return WATER_NATURAL.has(t.natural)   ||
         WATER_WATERWAY.has(t.waterway) ||
         WATER_LANDUSE.has(t.landuse);
}

/** Extract highway classification from a way, or null. */
function _classifyRoad(way) {
  return (way.tags && way.tags.highway) ? way.tags.highway : null;
}

/** Compute lat/lon centroid of a coordinate array. */
function _centroidOf(coords) {
  let sumLat = 0, sumLon = 0;
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
    const d = distFn(lat, lon,
      coords[i].lat, coords[i].lon,
      coords[i + 1].lat, coords[i + 1].lon);
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
            if (pipFn(lat, lon, iway.coordinates)) { inIsland = true; break; }
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
  const radLon = radiusMeters / (METERS_PER_DEG_LAT * Math.cos(lat * Math.PI / 180));
  const points = [{ lat, lon }];  // centre
  for (let r = 1; r <= SAMPLING_RINGS; r++) {
    const frac = r / SAMPLING_RINGS;
    const rLat = radLat * frac;
    const rLon = radLon * frac;
    const nPts = POINTS_PER_RING[r];
    for (let p = 0; p < nPts; p++) {
      const a = (p / nPts) * 2 * Math.PI;
      points.push({
        lat: lat + rLat * Math.sin(a),
        lon: lon + rLon * Math.cos(a)
      });
    }
  }
  return points;
}

// -- Main OSMEnricher namespace ---------------------------------------------

const OSMEnricher = {
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
    let minLat = Infinity, maxLat = -Infinity;
    let minLon = Infinity, maxLon = -Infinity;
    let validCount = 0;

    for (const pt of rawPoints) {
      if (this._isValidCoord(pt.lat, pt.lon)) {
        if (pt.lat < minLat) minLat = pt.lat;
        if (pt.lat > maxLat) maxLat = pt.lat;
        if (pt.lon < minLon) minLon = pt.lon;
        if (pt.lon > maxLon) maxLon = pt.lon;
        validCount++;
      }
    }

    if (validCount === 0) return null;

    const latBuf = bufferMeters / METERS_PER_DEG_LAT;
    const midLat = (minLat + maxLat) / 2;
    const lonBuf = bufferMeters / (METERS_PER_DEG_LAT * Math.cos(midLat * Math.PI / 180));

    return {
      minLat: minLat - latBuf,
      minLon: minLon - lonBuf,
      maxLat: maxLat + latBuf,
      maxLon: maxLon + lonBuf
    };
  },

  calculateBBoxAreaKm2(bbox) {
    const midLat = (bbox.minLat + bbox.maxLat) / 2;
    const h = (bbox.maxLat - bbox.minLat) * METERS_PER_DEG_LAT_KM;
    const w = (bbox.maxLon - bbox.minLon) * METERS_PER_DEG_LAT_KM * Math.cos(midLat * Math.PI / 180);
    return h * w;
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
    const wayMap  = new Map();   // O(1) lookup for relation resolution
    const ways    = [];
    const points  = [];
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
        const outerWays = [], innerWays = [];
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
   * every direction. Combined with getNearby()'s own 3x3-neighborhood query
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
      let minLat = Infinity, maxLat = -Infinity;
      let minLon = Infinity, maxLon = -Infinity;

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

    for (const p of geoms.points)    insert(p);
    for (const w of geoms.ways)     insert(w);
    for (const r of geoms.relations) insert(r);

    const index = {
      getNearby(lat, lon) {
        return spatialGrid.getNearby(lat, lon, item => `${item.type}_${item.id}`);
      }
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
      const d = this.haversine(prev.lat, prev.lon, points[i].lat, points[i].lon);
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
    const havFn  = this.haversine.bind(this);
    const pipFn  = this.pointInPolygon.bind(this);

    let minRoadDist = Infinity, nearestRoadClass = 'none', minMajorRoadDist = Infinity;
    let inPark = 0, minWaterDist = Infinity;
    let buildingCount = 0, treeCount = 0, amenityCount = 0;

    // Sampling grid for green-space coverage
    const samplingPoints = _buildSamplingGrid(lat, lon, radiusMeters);
    let greenHits = 0;

    for (const geom of nearby) {
      const tags = geom.tags;
      if (!tags) continue;

      // -- Roads --
      if (geom.type === 'way' && tags.highway) {
        const d = _minDistanceToWay(lat, lon, geom, distFn);
        if (d < minRoadDist) {
          minRoadDist = d;
          nearestRoadClass = _classifyRoad(geom);
        }
        if (MAJOR_ROAD_CLASSES.has(tags.highway) && d < minMajorRoadDist) {
          minMajorRoadDist = d;
        }
      }

      // -- Buildings --
      if (geom.type === 'way' && tags.building && geom.coordinates) {
        const c = _centroidOf(geom.coordinates);
        if (havFn(lat, lon, c.lat, c.lon) <= radiusMeters) {
          buildingCount++;
        }
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
      if (tags.shop || AMENITY_TYPES.has(tags.amenity) || tags.highway === 'bus_stop') {
        let d = Infinity;
        if (geom.type === 'node') {
          d = havFn(lat, lon, geom.lat, geom.lon);
        } else if (geom.coordinates && geom.coordinates.length > 0) {
          const c = _centroidOf(geom.coordinates);
          d = havFn(lat, lon, c.lat, c.lon);
        }
        if (d <= radiusMeters) amenityCount++;
      }

      // -- Green space (point-in-polygon) --
      if (_isGreenSpace(geom)) {
        // exact query point
        if (_isPointInGreenSpace(geom, lat, lon, pipFn)) inPark = 1;

        // sampling grid density
        for (const sPt of samplingPoints) {
          if (!sPt._hit && _isPointInGreenSpace(geom, sPt.lat, sPt.lon, pipFn)) {
            sPt._hit = true;
            greenHits++;
          }
        }
      }
    }

    // Sanitize distances
    if (minRoadDist === Infinity)      minRoadDist = SENTINEL_DIST;
    if (minMajorRoadDist === Infinity) minMajorRoadDist = SENTINEL_DIST;
    if (minWaterDist === Infinity)     minWaterDist = SENTINEL_DIST;

    // Green-space percentage (float — rounding deferred to display layer)
    const greenPct = (greenHits / samplingPoints.length) * 100;

    return {
      roadClass: nearestRoadClass,
      distMajorRoad: minMajorRoadDist,
      inPark,
      greenSpacePct: greenPct,
      buildingDensity: buildingCount,
      distWater: minWaterDist,
      treeDensity: treeCount,
      amenityCount
    };
  },

  /**
   * Project sparse evaluation metrics onto the full 10 Hz raw timeline
   * using linear interpolation for continuous variables and step
   * interpolation for categorical variables.
   */
  _projectToTimeline(raw, computedMetrics) {
    if (computedMetrics.length === 0) return;

    // Single-evaluation edge case: broadcast to all samples
    if (computedMetrics.length === 1) {
      const m = computedMetrics[0].metrics;
      for (let i = 0; i < raw.length; i++) {
        raw[i].osm_road_class          = m.roadClass;
        raw[i].osm_in_park             = m.inPark;
        raw[i].osm_dist_major_road     = m.distMajorRoad;
        raw[i].osm_green_pct_50m       = m.greenSpacePct;
        raw[i].osm_building_density_50m = m.buildingDensity;
        raw[i].osm_dist_water          = m.distWater;
        raw[i].osm_tree_density_50m    = m.treeDensity;
        raw[i].osm_amenity_count_50m   = m.amenityCount;
      }
      return;
    }

    let segIdx = 1;  // current segment: between [segIdx-1] and [segIdx]

    for (let i = 0; i < raw.length; i++) {
      // Advance segment when we cross the next evaluation index
      while (segIdx < computedMetrics.length && i >= computedMetrics[segIdx].idx) {
        segIdx++;
      }

      const prev = computedMetrics[segIdx - 1];
      const next = computedMetrics[Math.min(segIdx, computedMetrics.length - 1)];

      const span = next.idx - prev.idx;
      const t = span > 0 ? (i - prev.idx) / span : 0;
      const p = prev.metrics, n = next.metrics;

      // Linear interpolation for continuous variables
      const lerp = (a, b) => a + (b - a) * t;

      raw[i].osm_road_class          = (t >= 0.5) ? n.roadClass      : p.roadClass;
      raw[i].osm_in_park             = (t >= 0.5) ? n.inPark         : p.inPark;
      raw[i].osm_dist_major_road     = lerp(p.distMajorRoad,  n.distMajorRoad);
      raw[i].osm_green_pct_50m       = lerp(p.greenSpacePct,  n.greenSpacePct);
      raw[i].osm_building_density_50m = lerp(p.buildingDensity, n.buildingDensity);
      raw[i].osm_dist_water          = lerp(p.distWater,       n.distWater);
      raw[i].osm_tree_density_50m    = lerp(p.treeDensity,     n.treeDensity);
      raw[i].osm_amenity_count_50m   = lerp(p.amenityCount,    n.amenityCount);
    }
  },

  /**
   * Enrich continuous track data series: runs spatial queries on ~1 Hz
   * GPS coordinates and projects results back to the full 10 Hz timeline.
   *
   * When snapParams.enabled is true, road snapping runs in the same loop:
   * each evaluation point is projected onto the nearest highway segment
   * before enrichment metrics are computed, so enrichment sees the
   * corrected (snapped) position — never misattributes a building because
   * of GPS multipath drift.
   *
   * @param {Object} analyzer     - GSRAnalyzer instance (has .raw, .getCoordinates())
   * @param {Object} osmJson      - parsed Overpass API JSON
   * @param {number} radiusMeters - search radius (default 50)
   * @param {Object} [snapParams] - { enabled: bool, ... } road snapping config
   * @param {Function} onProgress - optional progress callback(msg)
   */
  enrichTrack(analyzer, osmJson, radiusMeters = DEFAULT_RADIUS_M, snapParams, onProgress) {
    const raw = analyzer.raw;
    if (!raw || raw.length === 0) return;

    const doSnap  = snapParams && snapParams.enabled;

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
    const gpsIndices = [];
    for (let i = 0; i < raw.length; i++) {
      // Use raw GPS coordinates for enrichment to avoid feedback loop:
      // if filteredGps is already populated (from a prior render), using
      // it here would map-match a snap-biased path, progressively pulling
      // coordinates toward wrong parallel roads on subsequent runs.
      const coords = analyzer.getCoordinates(i, true);
      if (coords && coords.lat != null && coords.lon != null && !isNaN(coords.lat) && !isNaN(coords.lon)) {
        gpsIndices.push({ idx: i, lat: coords.lat, lon: coords.lon });
      }
    }
    if (gpsIndices.length === 0) {
      throw new Error('No valid GPS coordinates found in this track.');
    }

    // 3. Downsample to ~1 Hz evaluation points.
    let evalPoints = this._selectEvaluationPoints(raw, gpsIndices);
    if (doSnap) {
      // Spatially thin so the ramp spans a meaningful distance (~20 m
      // over 4 steps) instead of just 5.6 m at walking speed.
      evalPoints = this._thinPoints(evalPoints, 3);  // min 3 m spacing
    }
    const computedMetrics = [];

    // ── Snapped GPS output array (if snapping, for Kalman to consume) ─
    if (doSnap) {
      analyzer.snappedGps = new Array(raw.length);
      for (let i = 0; i < raw.length; i++) {
        analyzer.snappedGps[i] = { lat: NaN, lon: NaN };
      }
    }

    // ════════════════════════════════════════════════════════════════
    //  HMM-VITERBI PATH
    //  Collect candidates for all eval points, run Viterbi globally,
    //  then use the matched positions for enrichment.
    // ════════════════════════════════════════════════════════════════
    if (doSnap) {
      if (onProgress) onProgress('HMM map-matching: collecting candidates...');

      // Attach the spatial-index nearby result to each eval point so
      // MapMatcher._getCandidates can reuse it without a second query.
      const matchRadius = snapParams.radiusOut || MapMatcher.MATCH_RADIUS;
      const hmmPoints = evalPoints.map(node => ({
        ...node,
        nearby: spatialIndex.getNearby(node.lat, node.lon)
      }));

      if (onProgress) onProgress('HMM map-matching: running Viterbi...');
      const hmmResults = MapMatcher.match(hmmPoints, raw, matchRadius);

      // Store Viterbi-snapped positions.
      for (const [idx, r] of hmmResults) {
        analyzer.snappedGps[idx] = r;
      }

      // Enrichment pass using the matched (snapped) positions.
      if (onProgress) onProgress('HMM map-matching: computing spatial metrics...');
      for (let s = 0; s < hmmPoints.length; s++) {
        if (s % 50 === 0 && onProgress) {
          onProgress(`Computing spatial metrics: ${s}/${hmmPoints.length} positions...`);
        }
        const node    = hmmPoints[s];
        const matched = hmmResults.get(node.idx);
        const evalLat = matched ? matched.lat : node.lat;
        const evalLon = matched ? matched.lon : node.lon;

        const metrics = this._evaluatePosition(evalLat, evalLon, node.nearby, radiusMeters);
        computedMetrics.push({ idx: node.idx, time: raw[node.idx].time, metrics });
      }

    } else {
      // Non-snapped evaluation loop
      for (let s = 0; s < evalPoints.length; s++) {
        if (s % 50 === 0 && onProgress) {
          onProgress(`Computing spatial metrics: ${s}/${evalPoints.length} positions...`);
        }
        const node   = evalPoints[s];
        const nearby = spatialIndex.getNearby(node.lat, node.lon);

        const metrics = this._evaluatePosition(node.lat, node.lon, nearby, radiusMeters);
        computedMetrics.push({ idx: node.idx, time: raw[node.idx].time, metrics });
      }
    }

    // 4. Project back to full timeline
    if (onProgress) onProgress('Projecting results to full timeline...');
    this._projectToTimeline(raw, computedMetrics);

    // ── Interpolate snappedGps to full timeline ──────────────────────
    if (doSnap && analyzer.snappedGps) {
      this._interpolateSnappedGps(analyzer, raw);
    }

    analyzer.isEnriched = true;
    analyzer.enrichmentRadius = radiusMeters;
    // Wrote osm_* fields onto every raw sample above — bump so callers
    // caching derived data (e.g. GSRUI's environmental dashboard) recompute.
    analyzer._dataVersion = (analyzer._dataVersion || 0) + 1;
    if (onProgress) onProgress('Enrichment complete!');
  },

  /**
   * Fill NaN gaps in analyzer.snappedGps by interpolating along the OSM road
   * geometries when consecutive evaluation points match to the same or connected roads.
   * Prevents straight-line paths cutting corners through buildings.
   */
  _interpolateSnappedGps(analyzer, raw) {
    const sg = analyzer.snappedGps;
    const GPS_MAX_GAP_S = 30;

    // Collect valid indices
    const valid = [];
    for (let i = 0; i < sg.length; i++) {
      if (!isNaN(sg[i].lat) && !isNaN(sg[i].lon)) {
        valid.push(i);
      }
    }
    if (valid.length === 0) return;

    // Build way lookup map for geometry tracing
    const wayMap = new Map();
    if (analyzer.osmGeoms && analyzer.osmGeoms.ways) {
      for (const geom of analyzer.osmGeoms.ways) {
        wayMap.set(geom.id, geom.coordinates);
      }
    }

    // Fill before first
    const first = valid[0];
    for (let i = 0; i < first; i++) {
      sg[i] = { ...sg[first] };
    }

    // Interpolate between valid points
    for (let k = 0; k < valid.length - 1; k++) {
      const a = valid[k], b = valid[k + 1];
      const timeGap = raw[b].time - raw[a].time;
      if (timeGap > GPS_MAX_GAP_S) {
        for (let i = a + 1; i < b; i++) {
          sg[i] = { lat: NaN, lon: NaN };
        }
      } else {
        const wayIdA = sg[a].wayId;
        const wayIdB = sg[b].wayId;
        const coordsA = wayIdA ? wayMap.get(wayIdA) : null;
        const coordsB = wayIdB ? wayMap.get(wayIdB) : null;

        for (let i = a + 1; i < b; i++) {
          const t = (i - a) / (b - a);
          const rawPt = raw[i];
          const rawLat = rawPt.lat;
          const rawLon = rawPt.lon;
          const hasGps = !isNaN(rawLat) && !isNaN(rawLon);

          if (wayIdA && wayIdB && wayIdA !== wayIdB && coordsA && coordsB && hasGps) {
            // Project onto both ways and interpolate the results to prevent sudden jumps
            const projA = this._projectToWay(rawLat, rawLon, coordsA);
            const projB = this._projectToWay(rawLat, rawLon, coordsB);

            const snapLat = (1 - t) * projA.snapLat + t * projB.snapLat;
            const snapLon = (1 - t) * projA.snapLon + t * projB.snapLon;
            const dist = (1 - t) * projA.dist + t * projB.dist;

            const alphaA = sg[a].alpha;
            const alphaB = sg[b].alpha;
            const alpha = alphaA + t * (alphaB - alphaA);

            sg[i] = {
              lat:     alpha * snapLat + (1 - alpha) * rawLat,
              lon:     alpha * snapLon + (1 - alpha) * rawLon,
              roadLat: snapLat,
              roadLon: snapLon,
              alpha,
              dist,
              wayId:   t < 0.5 ? wayIdA : wayIdB
            };
          } else {
            // Single way projection or fallback
            let chosenWayId = null;
            let chosenCoords = null;

            if (wayIdA && wayIdB) {
              if (wayIdA === wayIdB) {
                chosenWayId = wayIdA;
                chosenCoords = coordsA;
              } else {
                chosenWayId = t < 0.5 ? wayIdA : wayIdB;
                chosenCoords = t < 0.5 ? coordsA : coordsB;
              }
            } else if (wayIdA) {
              chosenWayId = wayIdA;
              chosenCoords = coordsA;
            } else if (wayIdB) {
              chosenWayId = wayIdB;
              chosenCoords = coordsB;
            }

            if (chosenCoords && hasGps) {
              const proj = this._projectToWay(rawLat, rawLon, chosenCoords);
              const alphaA = sg[a].alpha;
              const alphaB = sg[b].alpha;
              const alpha = alphaA + t * (alphaB - alphaA);

              sg[i] = {
                lat:     alpha * proj.snapLat + (1 - alpha) * rawLat,
                lon:     alpha * proj.snapLon + (1 - alpha) * rawLon,
                roadLat: proj.snapLat,
                roadLon: proj.snapLon,
                alpha,
                dist:    proj.dist,
                wayId:   chosenWayId
              };
            } else {
              // Fallback: simple linear interpolation of coordinates
              sg[i] = {
                lat:     sg[a].lat + t * (sg[b].lat - sg[a].lat),
                lon:     sg[a].lon + t * (sg[b].lon - sg[a].lon),
                roadLat: sg[a].roadLat + t * (sg[b].roadLat - sg[a].roadLat),
                roadLon: sg[a].roadLon + t * (sg[b].roadLon - sg[a].roadLon),
                alpha:   sg[a].alpha + t * (sg[b].alpha - sg[a].alpha),
                dist:    sg[a].dist + t * (sg[b].dist - sg[a].dist),
                wayId:   t < 0.5 ? wayIdA : wayIdB
              };
            }
          }
        }
      }
    }

    // Fill after last
    const last = valid[valid.length - 1];
    for (let i = last; i < sg.length; i++) {
      sg[i] = { ...sg[last] };
    }
  },

  /**
   * Project a point onto the nearest segment of a way, returning the snapped
   * lat/lon and distance to that segment.
   */
  _projectToWay(lat, lon, coords) {
    let minDist = Infinity;
    let bestSnapLat = lat;
    let bestSnapLon = lon;

    for (let i = 0; i < coords.length - 1; i++) {
      const a = coords[i], b = coords[i + 1];
      const proj = GeoUtils.projectPointToSegment(lat, lon, a.lat, a.lon, b.lat, b.lon);

      if (proj.distance < minDist) {
        minDist = proj.distance;
        bestSnapLat = proj.lat;
        bestSnapLon = proj.lon;
      }
    }

    return { snapLat: bestSnapLat, snapLon: bestSnapLon, dist: minDist };
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { OSMEnricher };
}
