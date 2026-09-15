/**
 * Arousal Places — turns proximity clusters of arousal peaks into ranked,
 * inspectable *place* records for the map's discrete "where did responses
 * concentrate" layer.
 *
 * The headline score is dwell-normalised: total rectified phasic-driver energy
 * accumulated by the contributing walk(s) while inside the place footprint,
 * divided by the time they spent there. This is deliberately NOT a peak count —
 * a walker who dawdles at a junction racks up peaks without the place being
 * especially arousing; dividing by dwell cancels that. See
 * docs/peak_density_vs_spatial_clustering.md §2.
 *
 * Pure module: no DOM, no Leaflet. GeoUtils is the only dependency and is
 * typeof-guarded so host tests can run without it.
 */
import { GeoUtils } from '../gps/geo_utils.mjs';

export class GSRArousalPlaces {
  /**
   * @param {Array<Array<object>>} clusters - Output of
   *   GSRSpatialClustering.compactClusters(): each entry an array of member peak
   *   objects carrying at least { lat, lon, amplitude }, and ideally
   *   { trackId, time } so cross-track agreement and first-visit time work.
   * @param {Array<object>} tracks - Contributing walks, each:
   *   { id, sampleRate, raw: [{ time, lat, lon, hasGps, osm_road_class?,
   *     osm_dist_green?, osm_canopy_pct_50m? }], phasic: [{ time, val }] }.
   *   raw[i] and phasic[i] are assumed sample-aligned.
   * @param {object} [opts] - GSR_CONST.AROUSAL_PLACES shape:
   *   { mergeM, footprintPadM, dwellFloorS, provisionalMaxTracks }.
   * @returns {Array<object>} Place records sorted by `rate` descending, each:
   *   { label, cluster, lat, lon, memberCount, trackIds, trackCount,
   *     meanAmp, maxAmp, firstTime, energy, dwellSeconds, rate, provisional,
   *     osm }.
   */
  static buildPlaces(clusters, tracks, opts = {}) {
    if (!Array.isArray(clusters) || clusters.length === 0) return [];

    const mergeM = num(opts.mergeM, 35);
    const footprintPad = num(opts.footprintPadM, 10);
    const dwellFloorS = num(opts.dwellFloorS, 5);
    const provMaxTracks = num(opts.provisionalMaxTracks, 1);
    const minMembers = num(opts.minMembers, 3);
    const maxPlaces = num(opts.maxPlaces, 20);

    const footprintRadiusM = mergeM / 2 + footprintPad;
    const footSq = footprintRadiusM * footprintRadiusM;

    const trackById = this._buildFastTrackMap(tracks);
    const candidateClusters = this._filterCandidates(clusters, minMembers);

    let places = candidateClusters.map((candidate) =>
      this._scorePlace(candidate, trackById, {
        footprintRadiusM,
        footSq,
        dwellFloorS,
        provMaxTracks,
      }),
    );

    places.sort((a, b) => b.rate - a.rate);
    if (places.length > maxPlaces) places = places.slice(0, maxPlaces);
    places.forEach((p, i) => {
      p.label = `P${i + 1}`;
    });
    return places;
  }

  /**
   * Index tracks by ID and ensure fast coordinate typed arrays are ready.
   * @private
   */
  static _buildFastTrackMap(tracks) {
    const trackList = Array.isArray(tracks) ? tracks : [];
    const trackById = new Map();
    for (const trk of trackList) {
      if (!trk || trk.id == null || !Array.isArray(trk.raw)) continue;
      trackById.set(trk.id, { trk, flat: this._getOrBuildFastCoords(trk) });
    }
    return trackById;
  }

  /**
   * Pre-extract raw coordinates and phasic values into contiguous typed arrays
   * cached on the track instance to avoid object allocation in hot loops.
   * @private
   */
  static _getOrBuildFastCoords(trk) {
    const raw = trk.raw;
    const n = raw.length;
    let flat = trk._fastCoords;
    if (flat && flat.len === n && flat.rawRef === raw) return flat;

    const lats = new Float64Array(n);
    const lons = new Float64Array(n);
    const phasicVals = new Float64Array(n);
    const flags = new Uint8Array(n); // 1 = valid GPS sample
    const phasic = Array.isArray(trk.phasic) ? trk.phasic : null;

    for (let i = 0; i < n; i++) {
      const s = raw[i];
      if (s && s.hasGps !== false && s.lat != null && s.lon != null) {
        const lat = +s.lat,
          lon = +s.lon;
        if (isFinite(lat) && isFinite(lon)) {
          lats[i] = lat;
          lons[i] = lon;
          flags[i] = 1;
        }
      }
      if (phasic && i < phasic.length) {
        const v = +phasic[i].val;
        if (v > 0) phasicVals[i] = v;
      }
    }
    flat = { lats, lons, phasicVals, flags, len: n, rawRef: raw };
    trk._fastCoords = flat;
    return flat;
  }

  /**
   * Pre-filter: drop single-walk specks (a 1-2 peak cluster from one track is
   * more likely detector noise than a place), but keep small clusters that >=2
   * independent walks agree on.
   * @private
   */
  static _filterCandidates(clusters, minMembers) {
    const candidates = [];
    for (let cIdx = 0; cIdx < clusters.length; cIdx++) {
      const cluster = clusters[cIdx];
      const members = Array.isArray(cluster) ? cluster : [];
      const trackIds = [];
      for (let i = 0; i < members.length; i++) {
        const tid = members[i].trackId != null ? members[i].trackId : 'single';
        if (!trackIds.includes(tid)) trackIds.push(tid);
      }
      if (members.length < minMembers && trackIds.length < 2) continue;
      candidates.push({ cluster, members, trackIds });
    }
    return candidates;
  }

  /**
   * Score a candidate cluster by dwell time, rectified phasic energy, and nearest OSM context.
   * @private
   */
  static _scorePlace({ cluster, members, trackIds }, trackById, config) {
    const n = members.length || 1;
    const { footprintRadiusM, footSq, dwellFloorS, provMaxTracks } = config;

    let sumLat = 0,
      sumLon = 0,
      sumAmp = 0,
      maxAmp = 0,
      firstTime = Infinity;
    let minLat = Infinity,
      maxLat = -Infinity,
      minLon = Infinity,
      maxLon = -Infinity;
    const mCount = members.length;
    const memberLats = new Float64Array(mCount);
    const memberLons = new Float64Array(mCount);

    for (let i = 0; i < mCount; i++) {
      const pk = members[i];
      const lat = +pk.lat,
        lon = +pk.lon;
      memberLats[i] = lat;
      memberLons[i] = lon;
      sumLat += lat;
      sumLon += lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      const a = Number(pk.amplitude) || 0;
      sumAmp += a;
      if (a > maxAmp) maxAmp = a;
      if (typeof pk.time === 'number' && pk.time < firstTime)
        firstTime = pk.time;
    }

    const centroidLat = sumLat / n;
    const centroidLon = sumLon / n;
    const scale = geoScale(centroidLat);
    const degLat = scale.degToMeterLat;
    const degLon = scale.degToMeterLon;

    const padLat = footprintRadiusM / degLat;
    const padLon = footprintRadiusM / degLon;
    const bMinLat = minLat - padLat,
      bMaxLat = maxLat + padLat;
    const bMinLon = minLon - padLon,
      bMaxLon = maxLon + padLon;

    let energy = 0,
      dwellSeconds = 0;
    let osm = null,
      osmBestDsq = Infinity;

    for (let tIdx = 0; tIdx < trackIds.length; tIdx++) {
      const tid = trackIds[tIdx];
      const entry = trackById.get(tid);
      if (!entry) continue;
      const { trk, flat } = entry;
      const sr = num(trk.sampleRate, 10);
      const dt = sr > 0 ? 1 / sr : 0.1;
      const { lats, lons, phasicVals, flags, len } = flat;
      const raw = trk.raw;

      for (let i = 0; i < len; i++) {
        if (flags[i] === 0) continue;
        const sLat = lats[i];
        if (sLat < bMinLat || sLat > bMaxLat) continue;
        const sLon = lons[i];
        if (sLon < bMinLon || sLon > bMaxLon) continue;

        let nearDsq = Infinity;
        for (let m = 0; m < mCount; m++) {
          const dy = (sLat - memberLats[m]) * degLat;
          if (dy * dy > footSq) continue;
          const dx = (sLon - memberLons[m]) * degLon;
          const d = dx * dx + dy * dy;
          if (d < nearDsq) nearDsq = d;
          if (nearDsq <= footSq) break;
        }
        if (nearDsq > footSq) continue;

        dwellSeconds += dt;
        const pv = phasicVals[i];
        if (pv > 0) energy += pv * dt;

        const s = raw[i];
        if (s && s.osm_road_class != null) {
          const dyc = (centroidLat - sLat) * degLat;
          const dxc = (centroidLon - sLon) * degLon;
          const dc = dxc * dxc + dyc * dyc;
          if (dc < osmBestDsq) {
            osmBestDsq = dc;
            osm = {
              roadClass: s.osm_road_class,
              distGreen: numOrNull(s.osm_dist_green),
              canopyPct: numOrNull(s.osm_canopy_pct_50m),
            };
          }
        }
      }
    }

    const rate = (energy / Math.max(dwellSeconds, dwellFloorS)) * 60;

    return {
      label: '',
      cluster: members,
      lat: centroidLat,
      lon: centroidLon,
      memberCount: members.length,
      trackIds,
      trackCount: trackIds.length,
      meanAmp: sumAmp / n,
      maxAmp,
      firstTime: isFinite(firstTime) ? firstTime : null,
      energy,
      dwellSeconds,
      rate,
      provisional: trackIds.length <= provMaxTracks,
      osm,
    };
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

export function num(v, fallback) {
  const n = parseFloat(v);
  return isNaN(n) ? fallback : n;
}
export function numOrNull(v) {
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}
export function geoScale(lat) {
  return GeoUtils.getGeodesicScale(lat);
}
