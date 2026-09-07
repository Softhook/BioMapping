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
class GSRArousalPlaces {
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

    const mergeM       = num(opts.mergeM, 35);
    const footprintPad  = num(opts.footprintPadM, 10);
    const dwellFloorS   = num(opts.dwellFloorS, 5);
    const provMaxTracks = num(opts.provisionalMaxTracks, 1);
    const minMembers    = num(opts.minMembers, 3);
    const maxPlaces     = num(opts.maxPlaces, 20);
    // A per-member-peak footprint radius. The dwell/energy scan below counts a
    // walk sample if it falls within this of ANY member peak — a union of small
    // circles that follows the cluster's actual shape, rather than one circle
    // around a centroid that a non-round cluster's mean position may sit off.
    const footprintRadiusM = mergeM / 2 + footprintPad;
    const footSq = footprintRadiusM * footprintRadiusM;

    const trackList = Array.isArray(tracks) ? tracks : [];
    const trackById = new Map();
    for (const t of trackList) if (t && t.id != null) trackById.set(t.id, t);

    let places = clusters.map(cluster => {
      const members = Array.isArray(cluster) ? cluster : [];
      const n = members.length || 1;

      let sumLat = 0, sumLon = 0, sumAmp = 0, maxAmp = 0, firstTime = Infinity;
      let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
      const trackIds = [];
      const memberPts = [];
      for (const pk of members) {
        const lat = parseFloat(pk.lat), lon = parseFloat(pk.lon);
        sumLat += lat; sumLon += lon;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
        memberPts.push({ lat, lon });
        const a = Number(pk.amplitude) || 0;
        sumAmp += a;
        if (a > maxAmp) maxAmp = a;
        if (typeof pk.time === 'number' && pk.time < firstTime) firstTime = pk.time;
        const tid = pk.trackId != null ? pk.trackId : 'single';
        if (!trackIds.includes(tid)) trackIds.push(tid);
      }
      const centroidLat = sumLat / n;
      const centroidLon = sumLon / n;
      const scale = geoScale(centroidLat);

      // Bounding box of the member peaks, expanded by the footprint radius —
      // an O(1) reject for the vast majority of walk samples before the
      // per-member-peak distance loop.
      const padLat = footprintRadiusM / scale.degToMeterLat;
      const padLon = footprintRadiusM / scale.degToMeterLon;
      const bMinLat = minLat - padLat, bMaxLat = maxLat + padLat;
      const bMinLon = minLon - padLon, bMaxLon = maxLon + padLon;

      let energy = 0, dwellSeconds = 0;
      let osm = null, osmBestDsq = Infinity;

      for (const tid of trackIds) {
        const trk = trackById.get(tid);
        if (!trk || !Array.isArray(trk.raw)) continue;
        const sr = num(trk.sampleRate, 10);
        const dt = sr > 0 ? 1 / sr : 0.1;
        const phasic = Array.isArray(trk.phasic) ? trk.phasic : null;
        const raw = trk.raw;
        for (let i = 0; i < raw.length; i++) {
          const s = raw[i];
          if (!s || s.hasGps === false) continue;
          const sLat = parseFloat(s.lat), sLon = parseFloat(s.lon);
          if (!isFinite(sLat) || !isFinite(sLon)) continue;
          if (sLat < bMinLat || sLat > bMaxLat || sLon < bMinLon || sLon > bMaxLon) continue;

          let nearDsq = Infinity;
          for (let m = 0; m < memberPts.length; m++) {
            const d = distSq(sLat, sLon, memberPts[m].lat, memberPts[m].lon, scale);
            if (d < nearDsq) nearDsq = d;
            if (nearDsq <= footSq) break;
          }
          if (nearDsq > footSq) continue;

          dwellSeconds += dt;
          if (phasic && i < phasic.length) {
            const v = Number(phasic[i].val) || 0;
            if (v > 0) energy += v * dt;
          }
          if (s.osm_road_class != null) {
            const dc = distSq(centroidLat, centroidLon, sLat, sLon, scale);
            if (dc < osmBestDsq) {
              osmBestDsq = dc;
              osm = {
                roadClass:  s.osm_road_class,
                distGreen:  numOrNull(s.osm_dist_green),
                canopyPct:  numOrNull(s.osm_canopy_pct_50m)
              };
            }
          }
        }
      }

      const rate = energy / Math.max(dwellSeconds, dwellFloorS) * 60;

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
        osm
      };
    });

    // Drop single-walk specks (a 1-2 peak cluster from one track is more likely
    // detector noise than a place), but keep small clusters that >=2 independent
    // walks agree on. Then rank by dwell-normalised rate, cap, and label.
    places = places.filter(p => p.memberCount >= minMembers || p.trackCount >= 2);
    places.sort((a, b) => b.rate - a.rate);
    if (places.length > maxPlaces) places = places.slice(0, maxPlaces);
    places.forEach((p, i) => { p.label = `P${i + 1}`; });
    return places;
  }
}

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
  if (typeof GeoUtils !== 'undefined' && typeof GeoUtils.getGeodesicScale === 'function') {
    return GeoUtils.getGeodesicScale(lat);
  }
  const DEG_TO_M_LAT = 111320.0;
  return { degToMeterLat: DEG_TO_M_LAT, degToMeterLon: DEG_TO_M_LAT * Math.cos(lat * Math.PI / 180) };
}
function distSq(lat1, lon1, lat2, lon2, scale) {
  if (typeof GeoUtils !== 'undefined' && typeof GeoUtils.distanceMetersSq === 'function') {
    return GeoUtils.distanceMetersSq(lat1, lon1, lat2, lon2, scale);
  }
  const dy = (lat1 - lat2) * scale.degToMeterLat;
  const dx = (lon1 - lon2) * scale.degToMeterLon;
  return dx * dx + dy * dy;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GSRArousalPlaces };
}
if (typeof window !== 'undefined') {
  window.GSRArousalPlaces = GSRArousalPlaces;
}
