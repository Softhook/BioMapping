/**
 * Arousal Places — turns proximity clusters of arousal peaks into ranked,
 * inspectable *place* records for the map's discrete "where did responses
 * concentrate" layer.
 *
 * The headline score is dwell-normalised: total rectified phasic-driver energy
 * accumulated by every walk that passed through the place footprint (calm
 * passes included, so they dilute it), divided by the time they spent there.
 * This is deliberately NOT a peak count — a walker who dawdles at a junction
 * racks up peaks without the place being especially arousing; dividing by
 * dwell cancels that. See
 * docs/peak_density_vs_spatial_clustering.md §2.
 *
 * Pure module: no DOM, no Leaflet. GeoUtils is the only dependency and is
 * typeof-guarded so host tests can run without it.
 */
import { GeoUtils } from '../gps/geo_utils.mjs';

export const GSRArousalPlaces = {
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
   *   { mergeM, footprintPadM, dwellFloorS, minVisitS, provisionalMaxTracks,
   *     walkRankExponent, minWalks }.
   * @returns {Array<object>} Place records sorted by `rankScore` descending
   *   (rate boosted by how many walks reacted), each:
   *   { label, cluster, lat, lon, memberCount, trackIds, trackCount,
   *     visitCount, meanAmp, maxAmp, firstTime, energy, dwellSeconds, rate,
   *     rankScore, provisional, osm }. `trackIds`/`trackCount` are the walks
   *   with a peak here; `visitCount` is every walk that passed through,
   *   reacting or not.
   */
  buildPlaces(clusters, tracks, opts = {}) {
    if (!Array.isArray(clusters) || clusters.length === 0) return [];

    const mergeM = num(opts.mergeM, 35);
    const footprintPad = num(opts.footprintPadM, 10);
    const dwellFloorS = num(opts.dwellFloorS, 5);
    const minVisitS = num(opts.minVisitS, 3);
    const provMaxTracks = num(opts.provisionalMaxTracks, 1);
    const minMembers = num(opts.minMembers, 3);
    const minWalks = num(opts.minWalks, 1);
    const maxPlaces = num(opts.maxPlaces, 20);
    const walkRankExp = num(opts.walkRankExponent, 0.5);

    const footprintRadiusM = mergeM / 2 + footprintPad;
    const footSq = footprintRadiusM * footprintRadiusM;

    const trackById = GSRArousalPlaces._buildFastTrackMap(tracks);
    const candidateClusters = GSRArousalPlaces._filterCandidates(
      clusters,
      minMembers,
      minWalks,
    );

    let places = candidateClusters.map((candidate) =>
      GSRArousalPlaces._scorePlace(candidate, trackById, {
        footprintRadiusM,
        footSq,
        dwellFloorS,
        minVisitS,
        provMaxTracks,
      }),
    );

    // Rank by rate boosted by how many walks reacted, so a place several walks
    // corroborate outranks an equally strong one only a single walk saw. Calm
    // passes already pull `rate` down, so 2 of 10 walks reacting ranks far
    // below 2 of 2. `rate` itself stays the honest figure shown to the user.
    for (const p of places) p.rankScore = p.rate * p.trackCount ** walkRankExp;
    places.sort((a, b) => b.rankScore - a.rankScore);
    if (places.length > maxPlaces) places = places.slice(0, maxPlaces);
    places.forEach((p, i) => {
      p.label = `P${i + 1}`;
    });
    return places;
  },

  /**
   * Index tracks by ID and ensure fast coordinate typed arrays are ready.
   * @private
   */
  _buildFastTrackMap(tracks) {
    const trackList = Array.isArray(tracks) ? tracks : [];
    const trackById = new Map();
    for (const trk of trackList) {
      if (!trk || trk.id == null || !Array.isArray(trk.raw)) continue;
      trackById.set(trk.id, {
        trk,
        flat: GSRArousalPlaces._getOrBuildFastCoords(trk),
      });
    }
    return trackById;
  },

  /**
   * Pre-extract coordinates and phasic values into contiguous typed arrays
   * cached on the track instance to avoid object allocation in hot loops.
   * Positions come from the smoothed path the map draws (trk.filteredGps),
   * falling back to the raw row where it has none — as
   * GSRAnalyzer.getCoordinates() does.
   *
   * Phasic is filed under the place it is paired with by the walk's Response
   * delay (trk.placeRowOf, GSRAnalyzer.placeRowOf) — the same place the
   * member peaks are drawn at — so a place's energy is the response to being
   * there, not to where they had walked on to. Phasic with no place (before
   * the recording started, or no position there) is left out. Without
   * trk.placeRowOf each reading stays at its own row.
   * @private
   */
  _getOrBuildFastCoords(trk) {
    const raw = trk.raw;
    const n = raw.length;
    const delay = Number(trk.responseDelay) || 0;
    const placeRowOf =
      typeof trk.placeRowOf === 'function' ? trk.placeRowOf : null;
    const path =
      Array.isArray(trk.filteredGps) && trk.filteredGps.length === n
        ? trk.filteredGps
        : null;
    let flat = trk._fastCoords;
    if (
      flat &&
      flat.len === n &&
      flat.rawRef === raw &&
      flat.pathRef === path &&
      flat.delay === delay
    )
      return flat;

    const lats = new Float64Array(n);
    const lons = new Float64Array(n);
    const phasicVals = new Float64Array(n);
    const flags = new Uint8Array(n); // 1 = valid GPS sample
    let minLat = Infinity,
      maxLat = -Infinity,
      minLon = Infinity,
      maxLon = -Infinity;
    const phasic = Array.isArray(trk.phasic) ? trk.phasic : null;

    for (let i = 0; i < n; i++) {
      const f = path?.[i];
      if (f && Number.isFinite(f.lat) && Number.isFinite(f.lon)) {
        lats[i] = f.lat;
        lons[i] = f.lon;
        flags[i] = 1;
        continue;
      }
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
    }
    // Bounding box, so _scorePlace can skip walks that never came near a place.
    for (let i = 0; i < n; i++) {
      if (flags[i] === 0) continue;
      if (lats[i] < minLat) minLat = lats[i];
      if (lats[i] > maxLat) maxLat = lats[i];
      if (lons[i] < minLon) minLon = lons[i];
      if (lons[i] > maxLon) maxLon = lons[i];
    }
    if (phasic) {
      const m = Math.min(n, phasic.length);
      for (let i = 0; i < m; i++) {
        const v = +phasic[i].val;
        if (!(v > 0)) continue;
        const j = placeRowOf ? placeRowOf(i) : i;
        if (j >= 0) phasicVals[j] += v;
      }
    }
    flat = {
      lats,
      lons,
      phasicVals,
      flags,
      minLat,
      maxLat,
      minLon,
      maxLon,
      len: n,
      rawRef: raw,
      pathRef: path,
      delay,
    };
    trk._fastCoords = flat;
    return flat;
  },

  /**
   * Pre-filter: drop single-walk specks (a 1-2 peak cluster from one track is
   * more likely detector noise than a place), but keep small clusters that >=2
   * independent walks agree on. Also drop clusters with peaks from fewer than
   * minWalks different walks.
   * @private
   */
  _filterCandidates(clusters, minMembers, minWalks = 1) {
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
      if (trackIds.length < minWalks) continue;
      candidates.push({ cluster, members, trackIds });
    }
    return candidates;
  },

  /**
   * Score a candidate cluster by dwell time, rectified phasic energy, and nearest OSM context.
   * Every walk that spent at least minVisitS inside the footprint counts as a
   * visit and adds its dwell and energy, whether it peaked here or not; a walk
   * with a peak here always counts. A brief edge-clip below minVisitS is
   * treated as GPS wobble, not a visit.
   * @private
   */
  _scorePlace({ members, trackIds }, trackById, config) {
    const n = members.length || 1;
    const { footprintRadiusM, footSq, dwellFloorS, minVisitS, provMaxTracks } =
      config;

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
      dwellSeconds = 0,
      visitCount = 0;
    let osm = null,
      osmBestDsq = Infinity;

    for (const [tid, { trk, flat }] of trackById) {
      if (
        flat.maxLat < bMinLat ||
        flat.minLat > bMaxLat ||
        flat.maxLon < bMinLon ||
        flat.minLon > bMaxLon
      )
        continue;
      const sr = num(trk.sampleRate, 10);
      const dt = sr > 0 ? 1 / sr : 0.1;
      const { lats, lons, phasicVals, flags, len } = flat;
      const raw = trk.raw;
      let trkDwell = 0,
        trkEnergy = 0;

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

        trkDwell += dt;
        const pv = phasicVals[i];
        if (pv > 0) trkEnergy += pv * dt;

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
      if (trkDwell <= 0) continue;
      if (trkDwell < minVisitS && !trackIds.includes(tid)) continue;
      visitCount++;
      dwellSeconds += trkDwell;
      energy += trkEnergy;
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
      visitCount: Math.max(visitCount, trackIds.length),
      meanAmp: sumAmp / n,
      maxAmp,
      firstTime: isFinite(firstTime) ? firstTime : null,
      energy,
      dwellSeconds,
      rate,
      provisional: trackIds.length <= provMaxTracks,
      osm,
    };
  },
};

// ─── helpers ────────────────────────────────────────────────────────────────

function num(v, fallback) {
  const n = parseFloat(v);
  return isNaN(n) ? fallback : n;
}
function numOrNull(v) {
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}
function geoScale(lat) {
  return GeoUtils.getGeodesicScale(lat);
}
