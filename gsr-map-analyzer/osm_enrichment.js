/**
 * OSM Environmental Enrichment Module for Bio Mapping
 * Handles Overpass API fetching, client-side spatial grid hashing, 
 * geometry reconstruction, and coordinate-to-feature spatial math.
 */

const OSMEnricher = {
  // Configurable settings
  overpassEndpoint: 'https://overpass-api.de/api/interpreter',
  
  // Math utilities
  haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000; // Earth's radius in meters
    const phi1 = lat1 * Math.PI / 180;
    const phi2 = lat2 * Math.PI / 180;
    const deltaPhi = (lat2 - lat1) * Math.PI / 180;
    const deltaLambda = (lon2 - lon1) * Math.PI / 180;

    const a = Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
              Math.cos(phi1) * Math.cos(phi2) *
              Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c; // in meters
  },

  /**
   * Calculate the shortest distance (in meters) from point P(lat, lon)
   * to a line segment defined by A(lat1, lon1) and B(lat2, lon2).
   */
  distanceToSegment(lat, lon, lat1, lon1, lat2, lon2) {
    const cosLat = Math.cos(lat1 * Math.PI / 180);
    const x = lon * cosLat;
    const y = lat;
    const x1 = lon1 * cosLat;
    const y1 = lat1;
    const x2 = lon2 * cosLat;
    const y2 = lat2;

    const dx = x2 - x1;
    const dy = y2 - y1;
    const l2 = dx * dx + dy * dy;

    let t = 0;
    if (l2 > 0) {
      t = ((x - x1) * dx + (y - y1) * dy) / l2;
      t = Math.max(0, Math.min(1, t)); // Clamp projection to the segment
    }

    const projX = x1 + t * dx;
    const projY = y1 + t * dy;

    // Convert delta degrees to meters locally
    const distLat = projY - y;
    const distLon = (projX - x) / cosLat;
    
    return Math.sqrt(distLat * distLat + distLon * distLon) * 111320;
  },

  /**
   * Ray-casting point-in-polygon check.
   * Coordinates should be array of {lat, lon} or [lat, lon].
   */
  pointInPolygon(lat, lon, poly) {
    let inside = false;
    const n = poly.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const pi = poly[i];
      const pj = poly[j];
      
      const xi = Array.isArray(pi) ? pi[1] : pi.lon;
      const yi = Array.isArray(pi) ? pi[0] : pi.lat;
      const xj = Array.isArray(pj) ? pj[1] : pj.lon;
      const yj = Array.isArray(pj) ? pj[0] : pj.lat;

      const intersect = ((yi > lat) !== (yj > lat))
          && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  },

  /**
   * Calculates the bounding box of a track with an optional buffer in meters.
   */
  calculateBBox(rawPoints, bufferMeters = 100) {
    let minLat = Infinity, maxLat = -Infinity;
    let minLon = Infinity, maxLon = -Infinity;

    rawPoints.forEach(pt => {
      if (pt.lat !== null && pt.lon !== null && !isNaN(pt.lat) && !isNaN(pt.lon)) {
        if (pt.lat < minLat) minLat = pt.lat;
        if (pt.lat > maxLat) maxLat = pt.lat;
        if (pt.lon < minLon) minLon = pt.lon;
        if (pt.lon > maxLon) maxLon = pt.lon;
      }
    });

    if (minLat === Infinity) return null;

    const latBuffer = bufferMeters / 111320;
    const lonBuffer = bufferMeters / (111320 * Math.cos(((minLat + maxLat) / 2) * Math.PI / 180));

    return {
      minLat: minLat - latBuffer,
      minLon: minLon - lonBuffer,
      maxLat: maxLat + latBuffer,
      maxLon: maxLon + lonBuffer
    };
  },

  /**
   * Estimate area of bounding box in square kilometers.
   */
  calculateBBoxAreaKm2(bbox) {
    const height = (bbox.maxLat - bbox.minLat) * 111.32;
    const width = (bbox.maxLon - bbox.minLon) * 111.32 * Math.cos(((bbox.minLat + bbox.maxLat) / 2) * Math.PI / 180);
    return height * width;
  },

  /**
   * Build the Overpass API query for the bounding box.
   */
  buildQuery(bbox) {
    const b = `${bbox.minLat.toFixed(6)},${bbox.minLon.toFixed(6)},${bbox.maxLat.toFixed(6)},${bbox.maxLon.toFixed(6)}`;
    return `[out:json][timeout:90];
(
  way["highway"](${b});
  way["building"](${b});
  relation["building"](${b});
  way["leisure"="park"](${b});
  way["landuse"~"grass|forest|meadow"](${b});
  way["natural"="wood"](${b});
  relation["leisure"="park"](${b});
  relation["landuse"~"grass|forest|meadow"](${b});
  relation["natural"="wood"](${b});
  way["natural"="water"](${b});
  way["waterway"](${b});
  relation["natural"="water"](${b});
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

  /**
   * Query the Overpass API for a bounding box.
   */
  async fetchOSMData(bbox, onProgress) {
    if (onProgress) onProgress('Connecting to Overpass API...');
    
    const query = this.buildQuery(bbox);
    const response = await fetch(this.overpassEndpoint, {
      method: 'POST',
      body: 'data=' + encodeURIComponent(query),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });

    if (!response.ok) {
      throw new Error(`Overpass API responded with HTTP error: ${response.status}`);
    }

    if (onProgress) onProgress('Parsing geographical payload...');
    const data = await response.json();
    return data;
  },

  /**
   * Reconstruct flat OSM JSON nodes/ways/relations into spatial feature models.
   */
  reconstructGeometries(osmJson) {
    const nodeMap = new Map();
    const ways = [];
    const points = [];
    const relations = [];

    // 1. Index all nodes
    osmJson.elements.forEach(el => {
      if (el.type === 'node') {
        nodeMap.set(el.id, { lat: el.lat, lon: el.lon });
        if (el.tags) {
          points.push(el); // tree, shop, or bus stop node
        }
      }
    });

    // 2. Resolve ways
    osmJson.elements.forEach(el => {
      if (el.type === 'way') {
        const coords = el.nodes.map(nid => nodeMap.get(nid)).filter(n => !!n);
        el.coordinates = coords;
        ways.push(el);
      }
    });

    // 3. Resolve relations (Multipolygons)
    osmJson.elements.forEach(el => {
      if (el.type === 'relation') {
        const outerWays = [];
        const innerWays = [];
        if (el.members) {
          el.members.forEach(mem => {
            if (mem.type === 'way') {
              const way = ways.find(w => w.id === mem.ref);
              if (way && way.coordinates.length > 0) {
                if (mem.role === 'inner') {
                  innerWays.push(way);
                } else {
                  outerWays.push(way);
                }
              }
            }
          });
        }
        el.outerWays = outerWays;
        el.innerWays = innerWays;
        relations.push(el);
      }
    });

    return { nodeMap, ways, points, relations };
  },

  /**
   * Build a spatial grid partition (spatial hash) to optimize geometric indexing.
   * Cell size is roughly 100m.
   */
  buildSpatialIndex(geoms, bbox) {
    const index = {
      grid: new Map(),
      cellSize: 0.001, // ~111 meters

      getCellKey(lat, lon) {
        const cx = Math.floor(lon / this.cellSize);
        const cy = Math.floor(lat / this.cellSize);
        return `${cx}_${cy}`;
      },

      add(key, item) {
        if (!this.grid.has(key)) {
          this.grid.set(key, []);
        }
        this.grid.get(key).push(item);
      },

      insertGeometry(geom) {
        // Find bounds of the geometry
        let minLat = Infinity, maxLat = -Infinity;
        let minLon = Infinity, maxLon = -Infinity;

        const examinePoint = (lat, lon) => {
          if (lat < minLat) minLat = lat;
          if (lat > maxLat) maxLat = lat;
          if (lon < minLon) minLon = lon;
          if (lon > maxLon) maxLon = lon;
        };

        if (geom.type === 'node') {
          examinePoint(geom.lat, geom.lon);
        } else if (geom.coordinates) {
          geom.coordinates.forEach(pt => examinePoint(pt.lat, pt.lon));
        } else if (geom.outerWays) {
          geom.outerWays.forEach(way => {
            way.coordinates.forEach(pt => examinePoint(pt.lat, pt.lon));
          });
        }

        if (minLat === Infinity) return;

        // Map geometry to all intersecting grid cells
        const minCellX = Math.floor(minLon / this.cellSize);
        const maxCellX = Math.floor(maxLon / this.cellSize);
        const minCellY = Math.floor(minLat / this.cellSize);
        const maxCellY = Math.floor(maxLat / this.cellSize);

        for (let cx = minCellX - 1; cx <= maxCellX + 1; cx++) {
          for (let cy = minCellY - 1; cy <= maxCellY + 1; cy++) {
            this.add(`${cx}_${cy}`, geom);
          }
        }
      },

      getNearbyGeometries(lat, lon) {
        const cx = Math.floor(lon / this.cellSize);
        const cy = Math.floor(lat / this.cellSize);
        const result = [];
        const checkedIds = new Set();

        // Check current cell + 8 surrounding cells
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            const key = `${cx + dx}_${cy + dy}`;
            const items = this.grid.get(key);
            if (items) {
              items.forEach(item => {
                const uniqId = `${item.type}_${item.id}`;
                if (!checkedIds.has(uniqId)) {
                  checkedIds.add(uniqId);
                  result.push(item);
                }
              });
            }
          }
        }
        return result;
      }
    };

    // Populate index
    geoms.points.forEach(p => index.insertGeometry(p));
    geoms.ways.forEach(w => index.insertGeometry(w));
    geoms.relations.forEach(r => index.insertGeometry(r));

    return index;
  },

  /**
   * Enrich continuous track data series (runs spatial queries on 1 Hz coordinates
   * and projects back to 10 Hz series).
   */
  enrichTrack(analyzer, osmJson, radiusMeters = 50, onProgress) {
    const raw = analyzer.raw;
    if (!raw || raw.length === 0) return;

    // 1. Reconstruct OSM geometries and build spatial grid index
    if (onProgress) onProgress('Assembling spatial index...');
    const geoms = this.reconstructGeometries(osmJson);
    const spatialIndex = this.buildSpatialIndex(geoms);

    // 2. Identify unique GPS coordinates (effectively 1 Hz or actual updates)
    if (onProgress) onProgress('Analyzing GPS positions...');
    const gpsIndices = [];
    for (let i = 0; i < raw.length; i++) {
      // Find filtered GPS coords (from calibration/interpolation) or fall back to raw
      const coords = analyzer.getCoordinates(i);
      if (coords && coords.lat !== null && coords.lon !== null) {
        gpsIndices.push({ idx: i, lat: coords.lat, lon: coords.lon });
      }
    }

    if (gpsIndices.length === 0) {
      throw new Error("No valid GPS coordinates found in this track.");
    }

    // Downsample checking points: compute environment for points separated by at least 1.0s (or unique updates)
    // to prevent slow calculations. We interpolate everything else.
    const evaluationPoints = [];
    let lastEvaluatedTime = -999;
    gpsIndices.forEach(ptInfo => {
      const t = raw[ptInfo.idx].time;
      if (t - lastEvaluatedTime >= 1.0) {
        evaluationPoints.push(ptInfo);
        lastEvaluatedTime = t;
      }
    });
    // Ensure last point is included
    if (evaluationPoints.length > 0 && evaluationPoints[evaluationPoints.length - 1].idx !== gpsIndices[gpsIndices.length - 1].idx) {
      evaluationPoints.push(gpsIndices[gpsIndices.length - 1]);
    }

    const totalSteps = evaluationPoints.length;
    const computedMetrics = [];

    // Helper functions for spatial metrics inside evaluation loop
    const classifyRoad = (way) => {
      if (!way.tags || !way.tags.highway) return null;
      return way.tags.highway;
    };

    const isGreenSpace = (geom) => {
      if (!geom.tags) return false;
      const tags = geom.tags;
      return tags.leisure === 'park' ||
             tags.leisure === 'garden' ||
             tags.landuse === 'grass' ||
             tags.landuse === 'forest' ||
             tags.landuse === 'meadow' ||
             tags.landuse === 'recreation_ground' ||
             tags.natural === 'wood' ||
             tags.natural === 'scrub' ||
             tags.natural === 'grassland';
    };

    const isWaterSpace = (geom) => {
      if (!geom.tags) return false;
      const tags = geom.tags;
      return tags.natural === 'water' ||
             tags.waterway === 'river' ||
             tags.waterway === 'canal' ||
             tags.waterway === 'stream' ||
             tags.waterway === 'drain' ||
             tags.landuse === 'basin' ||
             tags.landuse === 'reservoir';
    };

    // 3. Perform local spatial calculations for each evaluation node
    for (let s = 0; s < totalSteps; s++) {
      if (s % 50 === 0 && onProgress) {
        onProgress(`Computing spatial metrics: ${s}/${totalSteps} positions...`);
      }

      const node = evaluationPoints[s];
      const lat = node.lat;
      const lon = node.lon;

      // Fetch geometries inside spatial hashing bucket (+ neighbors)
      const nearby = spatialIndex.getNearbyGeometries(lat, lon);

      let minRoadDist = Infinity;
      let nearestRoadClass = 'none';
      let minMajorRoadDist = Infinity;
      let inPark = 0;
      let minWaterDist = Infinity;
      let buildingDensityCount = 0;
      let treeDensity = 0;
      let amenityCount = 0;

      // Concentric circular sampling grid for green space % (25 points inside radius)
      let greenPointsContained = 0;
      const samplingPoints = [];
      const numRings = 3;
      const pointsPerRing = [1, 8, 16]; // center, 10m ring, 25m ring, 40m ring
      
      // Build sampling points coords
      // Radius conversion to lat/lon degree offsets
      const radLat = radiusMeters / 111320;
      const radLon = radiusMeters / (111320 * Math.cos(lat * Math.PI / 180));

      // 1. Center
      samplingPoints.push({ lat, lon });
      // 2. Rings
      for (let r = 1; r <= numRings; r++) {
        const frac = r / numRings;
        const ringRadLat = radLat * frac;
        const ringRadLon = radLon * frac;
        const ptsCount = pointsPerRing[r];
        for (let pIdx = 0; pIdx < ptsCount; pIdx++) {
          const angle = (pIdx / ptsCount) * 2 * Math.PI;
          samplingPoints.push({
            lat: lat + ringRadLat * Math.sin(angle),
            lon: lon + ringRadLon * Math.cos(angle)
          });
        }
      }

      nearby.forEach(geom => {
        // --- Roads Check ---
        if (geom.type === 'way' && geom.tags && geom.tags.highway) {
          const isMajor = ['motorway', 'trunk', 'primary', 'secondary'].includes(geom.tags.highway);
          
          // Calculate shortest distance to road segments
          for (let i = 0; i < geom.coordinates.length - 1; i++) {
            const segDist = this.distanceToSegment(
              lat, lon, 
              geom.coordinates[i].lat, geom.coordinates[i].lon,
              geom.coordinates[i+1].lat, geom.coordinates[i+1].lon
            );

            if (segDist < minRoadDist) {
              minRoadDist = segDist;
              nearestRoadClass = classifyRoad(geom);
            }
            if (isMajor && segDist < minMajorRoadDist) {
              minMajorRoadDist = segDist;
            }
          }
        }

        // --- Buildings check (density & footprint count) ---
        if (geom.type === 'way' && geom.tags && geom.tags.building) {
          // Centroid calculation
          let sumLat = 0, sumLon = 0;
          geom.coordinates.forEach(pt => { sumLat += pt.lat; sumLon += pt.lon; });
          const cenLat = sumLat / geom.coordinates.length;
          const cenLon = sumLon / geom.coordinates.length;
          const distToCentroid = this.haversine(lat, lon, cenLat, cenLon);
          if (distToCentroid <= radiusMeters) {
            buildingDensityCount++;
          }
        }

        // --- Water check ---
        if (isWaterSpace(geom)) {
          if (geom.type === 'way') {
            for (let i = 0; i < geom.coordinates.length - 1; i++) {
              const segDist = this.distanceToSegment(
                lat, lon, 
                geom.coordinates[i].lat, geom.coordinates[i].lon,
                geom.coordinates[i+1].lat, geom.coordinates[i+1].lon
              );
              if (segDist < minWaterDist) minWaterDist = segDist;
            }
          } else if (geom.type === 'relation' && geom.outerWays) {
            geom.outerWays.forEach(way => {
              for (let i = 0; i < way.coordinates.length - 1; i++) {
                const segDist = this.distanceToSegment(
                  lat, lon, 
                  way.coordinates[i].lat, way.coordinates[i].lon,
                  way.coordinates[i+1].lat, way.coordinates[i+1].lon
                );
                if (segDist < minWaterDist) minWaterDist = segDist;
              }
            });
          }
        }

        // --- Trees check ---
        if (geom.type === 'node' && geom.tags && geom.tags.natural === 'tree') {
          const dist = this.haversine(lat, lon, geom.lat, geom.lon);
          if (dist <= radiusMeters) {
            treeDensity++;
          }
        }

        // --- Amenities / Shops check ---
        if ((geom.tags && geom.tags.shop) || (geom.tags && ['cafe', 'restaurant', 'pub', 'fast_food', 'bar'].includes(geom.tags.amenity))) {
          let dist = Infinity;
          if (geom.type === 'node') {
            dist = this.haversine(lat, lon, geom.lat, geom.lon);
          } else if (geom.coordinates && geom.coordinates.length > 0) {
            let sumLat = 0, sumLon = 0;
            geom.coordinates.forEach(pt => { sumLat += pt.lat; sumLon += pt.lon; });
            dist = this.haversine(lat, lon, sumLat / geom.coordinates.length, sumLon / geom.coordinates.length);
          }
          if (dist <= radiusMeters) {
            amenityCount++;
          }
        }
        
        // --- Transport stop check ---
        if (geom.type === 'node' && geom.tags && geom.tags.highway === 'bus_stop') {
          const dist = this.haversine(lat, lon, geom.lat, geom.lon);
          if (dist <= radiusMeters) {
            amenityCount++; // treat bus stops as part of active amenity context
          }
        }

        // --- Green space check & Raycasting point-in-polygon containment ---
        if (isGreenSpace(geom)) {
          // 1. Direct point-in-polygon test for exact coordinate
          if (geom.type === 'way' && geom.coordinates.length > 2) {
            if (this.pointInPolygon(lat, lon, geom.coordinates)) {
              inPark = 1;
            }
          } else if (geom.type === 'relation' && geom.outerWays) {
            geom.outerWays.forEach(way => {
              if (this.pointInPolygon(lat, lon, way.coordinates)) {
                // Verify not inside inner island ring
                let inIsland = false;
                if (geom.innerWays) {
                  geom.innerWays.forEach(iway => {
                    if (this.pointInPolygon(lat, lon, iway.coordinates)) inIsland = true;
                  });
                }
                if (!inIsland) inPark = 1;
              }
            });
          }

          // 2. Sample containment checks for green percentage density
          samplingPoints.forEach(sPt => {
            if (geom.type === 'way' && geom.coordinates.length > 2) {
              if (this.pointInPolygon(sPt.lat, sPt.lon, geom.coordinates)) {
                sPt.contained = true;
              }
            } else if (geom.type === 'relation' && geom.outerWays) {
              geom.outerWays.forEach(way => {
                if (this.pointInPolygon(sPt.lat, sPt.lon, way.coordinates)) {
                  let inIsland = false;
                  if (geom.innerWays) {
                    geom.innerWays.forEach(iway => {
                      if (this.pointInPolygon(sPt.lat, sPt.lon, iway.coordinates)) inIsland = true;
                    });
                  }
                  if (!inIsland) sPt.contained = true;
                }
              });
            }
          });
        }
      });

      // Calculate sample green percentage
      samplingPoints.forEach(sPt => {
        if (sPt.contained) greenPointsContained++;
      });
      const greenSpacePct = Math.round((greenPointsContained / samplingPoints.length) * 100);

      // Final sanitization of distance values
      if (minRoadDist === Infinity) minRoadDist = 999;
      if (minMajorRoadDist === Infinity) minMajorRoadDist = 999;
      if (minWaterDist === Infinity) minWaterDist = 999;

      computedMetrics.push({
        idx: node.idx,
        time: raw[node.idx].time,
        metrics: {
          roadClass: nearestRoadClass,
          distMajorRoad: minMajorRoadDist,
          inPark: inPark,
          greenSpacePct: greenSpacePct,
          buildingDensity: buildingDensityCount,
          distWater: minWaterDist,
          treeDensity: treeDensity,
          amenityCount: amenityCount
        }
      });
    }

    // 4. Interpolate 1 Hz metrics up to match 10 Hz raw timeline
    if (onProgress) onProgress('Projecting results to 10 Hz signal...');
    
    // Quick index lookup map
    const evalIndexMap = new Map();
    computedMetrics.forEach(cm => {
      evalIndexMap.set(cm.idx, cm.metrics);
    });

    let currentMetrics = computedMetrics[0].metrics;
    let nextCMIdx = 1;

    for (let i = 0; i < raw.length; i++) {
      // If we crossed an evaluated index, update baseline
      if (evalIndexMap.has(i)) {
        currentMetrics = evalIndexMap.get(i);
        // Find next metric coordinate boundary for linear interpolation
        const nextCM = computedMetrics[nextCMIdx];
        if (nextCM && i === nextCM.idx) {
          nextCMIdx = Math.min(computedMetrics.length - 1, nextCMIdx + 1);
        }
      }

      // Find current and next nodes for interpolation
      const prevCM = computedMetrics[Math.max(0, nextCMIdx - 1)];
      const nextCM = computedMetrics[Math.min(computedMetrics.length - 1, nextCMIdx)];

      let interpFraction = 0;
      if (nextCM.idx !== prevCM.idx) {
        interpFraction = (i - prevCM.idx) / (nextCM.idx - prevCM.idx);
      }

      const p = prevCM.metrics;
      const n = nextCM.metrics;

      // Continuous variables -> linear interpolation
      const distMajor = p.distMajorRoad + (n.distMajorRoad - p.distMajorRoad) * interpFraction;
      const greenPct = p.greenSpacePct + (n.greenSpacePct - p.greenSpacePct) * interpFraction;
      const bldDensity = p.buildingDensity + (n.buildingDensity - p.buildingDensity) * interpFraction;
      const distWater = p.distWater + (n.distWater - p.distWater) * interpFraction;
      const treeDens = p.treeDensity + (n.treeDensity - p.treeDensity) * interpFraction;
      const amCount = p.amenityCount + (n.amenityCount - p.amenityCount) * interpFraction;

      // Categorical/indicator variables -> step interpolation (from closest evaluated node)
      const useNext = (interpFraction >= 0.5);
      const activeNode = useNext ? n : p;

      // Inject directly as custom attributes on raw timeline array
      raw[i].osm_road_class = activeNode.roadClass;
      raw[i].osm_in_park = activeNode.inPark;
      raw[i].osm_dist_major_road = distMajor;
      raw[i].osm_green_pct_50m = greenPct;
      raw[i].osm_building_density_50m = bldDensity;
      raw[i].osm_dist_water = distWater;
      raw[i].osm_tree_density_50m = treeDens;
      raw[i].osm_amenity_count_50m = amCount;
    }

    // Flag analyzer instance as fully enriched
    analyzer.isEnriched = true;
    analyzer.enrichmentRadius = radiusMeters;
    if (onProgress) onProgress('Enrichment complete!');
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { OSMEnricher };
}
