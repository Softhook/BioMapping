/**
 * OSM Environmental Enrichment Module for Bio Mapping
 * Handles Overpass API fetching, client-side spatial grid hashing, 
 * geometry reconstruction, and coordinate-to-feature spatial math.
 */

// -- Numerical constants ---------------------------------------------------
const METERS_PER_DEG_LAT  = 111320;         // m per degree of latitude
const METERS_PER_DEG_LAT_KM = 111.32;       // km per degree (area calcs)
const EARTH_RADIUS_M      = 6371000;        // haversine
const CELL_SIZE_DEG       = 0.001;          // spatial-hash cell (~111 m)
const SENTINEL_DIST       = 999;            // sentinel for "no feature nearby"
const DEFAULT_RADIUS_M    = 50;             // enrichment search radius
const DEFAULT_BBOX_BUFFER_M = 100;          // bounding-box padding

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
    const phi1 = lat1 * Math.PI / 180;
    const phi2 = lat2 * Math.PI / 180;
    const dPhi = (lat2 - lat1) * Math.PI / 180;
    const dLambda = (lon2 - lon1) * Math.PI / 180;

    const a = Math.sin(dPhi / 2) ** 2 +
              Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
    return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  },

  /**
   * Shortest distance (m) from point P(lat, lon) to line segment AB.
   */
  distanceToSegment(lat, lon, lat1, lon1, lat2, lon2) {
    const cosLat = Math.cos(((lat + lat1 + lat2) / 3) * Math.PI / 180);
    const x = lon * cosLat,  y = lat;
    const x1 = lon1 * cosLat, y1 = lat1;
    const x2 = lon2 * cosLat, y2 = lat2;

    const dx = x2 - x1, dy = y2 - y1;
    const l2 = dx * dx + dy * dy;

    let t = 0;
    if (l2 > 0) {
      t = ((x - x1) * dx + (y - y1) * dy) / l2;
      t = Math.max(0, Math.min(1, t));
    }

    const projX = x1 + t * dx;
    const projY = y1 + t * dy;
    const distLat = projY - y;
    const distLon = (projX - x) / cosLat;

    return Math.sqrt(distLat * distLat + distLon * distLon) * METERS_PER_DEG_LAT;
  },

  /**
   * Ray-casting point-in-polygon check.
   * Coordinates should be array of {lat, lon} or [lat, lon].
   */
  pointInPolygon(lat, lon, poly) {
    let inside = false;
    const n = poly.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const pi = poly[i], pj = poly[j];
      const xi = Array.isArray(pi) ? pi[1] : pi.lon;
      const yi = Array.isArray(pi) ? pi[0] : pi.lat;
      const xj = Array.isArray(pj) ? pj[1] : pj.lon;
      const yj = Array.isArray(pj) ? pj[0] : pj.lat;

      if ((yi > lat) !== (yj > lat) &&
          lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    return inside;
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

  buildQuery(bbox) {
    const b = `${bbox.minLat.toFixed(6)},${bbox.minLon.toFixed(6)},${bbox.maxLat.toFixed(6)},${bbox.maxLon.toFixed(6)}`;
    return `[out:json][timeout:180][maxsize:536870912];
(
  way["highway"](${b});
  way["building"](${b});
  relation["building"](${b});
  way["leisure"~"park|garden|nature_reserve|playground"](${b});
  way["landuse"~"grass|forest|meadow|recreation_ground|village_green|orchard"](${b});
  way["natural"~"wood|scrub|grassland|heath"](${b});
  relation["leisure"~"park|garden|nature_reserve|playground"](${b});
  relation["landuse"~"grass|forest|meadow|recreation_ground|village_green|orchard"](${b});
  relation["natural"~"wood|scrub|grassland|heath"](${b});
  way["natural"~"water|wetland"](${b});
  way["waterway"](${b});
  relation["natural"~"water|wetland"](${b});
  relation["waterway"](${b});
  node["amenity"](${b});
  way["amenity"](${b});
  node["shop"](${b});
  way["shop"](${b});
  node["highway"="bus_stop"](${b});
  node["natural"="tree"](${b});
);
out body;
>;
out skel qt;`;
  },

  /* ======================================================================
     Rate-limit tracker (module-level — persists across calls)
     ====================================================================== */

  /** @type {number|null} timestamp (ms) when we can next call the API */
  _nextAllowedCallTime: null,

  /**
   * Wait until we're allowed to call the API (respects global rate-limit backoff).
   * Returns the number of ms actually waited.
   */
  async _enforceRateLimit(onProgress) {
    const now = Date.now();
    if (this._nextAllowedCallTime && now < this._nextAllowedCallTime) {
      const wait = this._nextAllowedCallTime - now;
      if (onProgress) {
        const sec = Math.ceil(wait / 1000);
        onProgress(`Rate-limited. Waiting ${sec}s before next request…`);
      }
      await new Promise(r => setTimeout(r, wait));
    }
  },

  /**
   * Overpass API retry policy.  Returns a wait time in ms that doubles
   * per attempt (exponential backoff) with ±25 % jitter.
   */
  _backoffMs(attempt, baseMs) {
    const linear = baseMs * Math.pow(2, attempt);
    const jitter = 1 + (Math.random() - 0.5) * 0.5; // 0.75 – 1.25
    return Math.round(linear * jitter);
  },

  /**
   * Read `Retry-After` header (seconds or HTTP-date), defaulting to `fallbackMs`.
   */
  _retryAfterMs(response, fallbackMs) {
    const val = response.headers.get('Retry-After');
    if (!val) return fallbackMs;
    const sec = parseInt(val, 10);
    if (!isNaN(sec) && sec > 0) return sec * 1000;
    // Could be an HTTP-date — ignore for simplicity, use fallback
    return fallbackMs;
  },

  async fetchOSMData(bbox, onProgress) {
    if (onProgress) onProgress('Connecting to Overpass API...');

    const query = this.buildQuery(bbox);

    // Honour global rate-limit cooldown before we even start
    await this._enforceRateLimit(onProgress);

    // ── Retry loop ──────────────────────────────────────────────────────
    // 504 timeout:    3 attempts, backoff 5 s -> 10 s -> 20 s
    // 429 / rate-limit: 3 attempts, backoff 30 s -> 60 s -> 120 s
    const maxRetries = 3;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutMs = 200000;                       // 200 s network timeout
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        const response = await fetch(this.overpassEndpoint, {
          method: 'POST',
          body: 'data=' + encodeURIComponent(query),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (response.ok) {
          if (onProgress) onProgress('Parsing geographical payload...');
          return response.json();
        }

        // ── Non-200 — classify & retry (or fail) ────────────────────────

        if (response.status === 429 || response.status === 509) {
          // Rate limited: long backoff, respect Retry-After
          const retryAfterMs = this._retryAfterMs(response, 30000);
          // Set global cooldown so subsequent calls wait too
          this._nextAllowedCallTime = Date.now() + retryAfterMs;

          if (attempt < maxRetries) {
            const msg = `Overpass API rate-limited (HTTP ${response.status}). ` +
              `Waiting ${Math.ceil(retryAfterMs / 1000)}s… (attempt ${attempt + 1}/${maxRetries})`;
            if (onProgress) onProgress(msg);
            await new Promise(r => setTimeout(r, retryAfterMs));
            continue;
          }

          throw new Error(
            `Overpass API rejected the request with HTTP ${response.status} (rate-limited). ` +
            `Try again in a few minutes, or use a smaller search radius / shorter track ` +
            `to reduce query size.`
          );
        }

        if (response.status === 504) {
          if (attempt < maxRetries) {
            // Gateway timeout — short backoff
            const waitMs = this._backoffMs(attempt, 5000);
            if (onProgress) {
              onProgress(
                `Overpass API timed out (504). Retrying in ${Math.ceil(waitMs / 1000)}s… ` +
                `(attempt ${attempt + 1}/${maxRetries})`
              );
            }
            await new Promise(r => setTimeout(r, waitMs));
            continue;
          }
          // All retries exhausted — the query is too expensive for this area
          throw new Error(
            `Overpass API timed out after ${maxRetries + 1} attempts. ` +
            `The track covers too large an area. Try a shorter track, or split ` +
            `the session into smaller segments.`
          );
        }

        // All other HTTP errors — fail immediately (no retry)
        const hints = {
          400: 'The Overpass query was malformed. This is a bug — please report it.',
          403: 'Access denied by the Overpass API.',
          413: 'Request entity too large. Try a shorter track or smaller radius.',
          502: 'Overpass API gateway error. Try again later.',
          503: 'Overpass API is temporarily unavailable (maintenance or overload). Try again later.',
        };
        const hint = hints[response.status] ||
          `Unexpected HTTP ${response.status} from the Overpass API.`;
        throw new Error(hint);

      } catch (err) {
        // Network / abort errors
        if (err.name === 'AbortError' && attempt < maxRetries) {
          const waitMs = this._backoffMs(attempt, 5000);
          if (onProgress) {
            onProgress(
              `Request timed out. Retrying in ${Math.ceil(waitMs / 1000)}s… ` +
              `(attempt ${attempt + 1}/${maxRetries})`
            );
          }
          await new Promise(r => setTimeout(r, waitMs));
          continue;
        }
        // Re-throw everything else (including final AbortError after retries exhausted)
        throw err;
      }
    }
  },

  /* ======================================================================
     Geometry reconstruction
     ====================================================================== */

  reconstructGeometries(osmJson) {
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

    return { nodeMap, ways, points, relations };
  },

  /* ======================================================================
     Spatial index (grid hash)
     ====================================================================== */

  buildSpatialIndex(geoms) {
    const grid = new Map();
    const cellSize = CELL_SIZE_DEG;

    const add = (key, item) => {
      const bucket = grid.get(key);
      if (bucket) bucket.push(item);
      else grid.set(key, [item]);
    };

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

      const minCX = Math.floor(minLon / cellSize);
      const maxCX = Math.floor(maxLon / cellSize);
      const minCY = Math.floor(minLat / cellSize);
      const maxCY = Math.floor(maxLat / cellSize);

      for (let cx = minCX - 1; cx <= maxCX + 1; cx++) {
        for (let cy = minCY - 1; cy <= maxCY + 1; cy++) {
          add(`${cx}_${cy}`, geom);
        }
      }
    };

    for (const p of geoms.points)    insert(p);
    for (const w of geoms.ways)     insert(w);
    for (const r of geoms.relations) insert(r);

    return {
      grid,
      cellSize,

      getNearby(lat, lon) {
        const cx = Math.floor(lon / cellSize);
        const cy = Math.floor(lat / cellSize);
        const result = [];
        const seen = new Set();

        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            const bucket = grid.get(`${cx + dx}_${cy + dy}`);
            if (!bucket) continue;
            for (const item of bucket) {
              const key = `${item.type}_${item.id}`;
              if (!seen.has(key)) {
                seen.add(key);
                result.push(item);
              }
            }
          }
        }
        return result;
      }
    };
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
      if (coords && coords.lat != null && coords.lon != null) {
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

      // Diagnostic summary — check browser console after enrichment
      this._logSnapDiagnostics(analyzer, raw, computedMetrics.length);
    }

    analyzer.isEnriched = true;
    analyzer.enrichmentRadius = radiusMeters;
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
   * Project a point onto an OSM way's coordinates and find the closest segment.
   */
  _projectToWay(lat, lon, coords) {
    const cosLat = Math.cos(lat * Math.PI / 180);
    const MDEG   = 111320;

    let minDist = Infinity;
    let bestSnapLat = lat;
    let bestSnapLon = lon;

    const qx = lon * cosLat;
    const qy = lat;

    for (let i = 0; i < coords.length - 1; i++) {
      const a = coords[i], b = coords[i + 1];
      const ax = a.lon * cosLat, ay = a.lat;
      const bx = b.lon * cosLat, by = b.lat;

      const dx = bx - ax, dy = by - ay;
      const l2 = dx * dx + dy * dy;

      let t = 0;
      if (l2 > 1e-12) {
        t = ((qx - ax) * dx + (qy - ay) * dy) / l2;
        t = Math.max(0, Math.min(1, t));
      }

      const projX = ax + t * dx;
      const projY = ay + t * dy;

      const dLat = (projY - qy) * MDEG;
      const dLon = (projX - qx) * MDEG;
      const dist = Math.sqrt(dLat * dLat + dLon * dLon);

      if (dist < minDist) {
        minDist = dist;
        bestSnapLat = projY;
        bestSnapLon = projX / cosLat;
      }
    }

    return { snapLat: bestSnapLat, snapLon: bestSnapLon, dist: minDist };
  },

  /**
   * Log a diagnostic summary of snapping results to the browser console.
   * Shows alpha distribution, distance distribution, and way-ID coverage.
   */
  _logSnapDiagnostics(analyzer, raw, evalCount) {
    const sg = analyzer.snappedGps;
    if (!sg) return;

    let pointsWithSnap = 0, pointsTotal = 0;
    let sumAlpha = 0, maxAlpha = 0;
    const alphaBuckets = [0, 0, 0, 0, 0]; // 0, 0-0.1, 0.1-0.3, 0.3-0.7, 0.7-1.0
    let sumDist = 0, minDist = Infinity, maxDist = 0;
    let distCount = 0;
    const wayIds = new Set();
    let lockedCount = 0;

    for (let i = 0; i < sg.length; i++) {
      const s = sg[i];
      if (isNaN(s.lat)) continue;
      pointsTotal++;
      if (!isNaN(s.alpha) && s.alpha > 0) {
        pointsWithSnap++;
        sumAlpha += s.alpha;
        if (s.alpha > maxAlpha) maxAlpha = s.alpha;
        if (s.alpha <= 0.1) alphaBuckets[1]++;
        else if (s.alpha <= 0.3) alphaBuckets[2]++;
        else if (s.alpha <= 0.7) alphaBuckets[3]++;
        else alphaBuckets[4]++;
      } else {
        alphaBuckets[0]++;
      }
      if (!isNaN(s.dist) && s.dist < Infinity) {
        sumDist += s.dist;
        distCount++;
        if (s.dist < minDist) minDist = s.dist;
        if (s.dist > maxDist) maxDist = s.dist;
      }
      if (s.wayId != null) wayIds.add(s.wayId);
      if (s.alpha >= 1.0) lockedCount++;
    }

    const header = '━━ Road Snap Diagnostics ━━';
    console.group(header);
    console.log('Evaluation points:', evalCount);
    console.log('Timeline points:',  pointsTotal);
    console.log('Snapped (>0):',     pointsWithSnap,
      pointsTotal > 0 ? `(${(100*pointsWithSnap/pointsTotal).toFixed(0)}%)` : '');
    console.log('Fully locked (α=1):', lockedCount);
    console.log('Max α:', maxAlpha.toFixed(2), '  Mean α (snapped):',
      pointsWithSnap > 0 ? (sumAlpha/pointsWithSnap).toFixed(2) : 'n/a');
    console.log('α buckets:  zero:', alphaBuckets[0],
      ' 0-0.1:', alphaBuckets[1],
      ' 0.1-0.3:', alphaBuckets[2],
      ' 0.3-0.7:', alphaBuckets[3],
      ' 0.7-1.0:', alphaBuckets[4]);
    if (distCount > 0) {
      console.log('Distance to road:  min:', minDist.toFixed(1)+'m',
        ' max:', maxDist.toFixed(1)+'m',
        ' mean:', (sumDist/distCount).toFixed(1)+'m');
    }
    console.log('Unique ways snapped to:', wayIds.size);
    console.groupEnd();
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { OSMEnricher };
}
