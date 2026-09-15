/**
 * ES-module pilot conversion of src/gps/geo_utils.js — a byte-for-byte copy
 * of the real object body with the dual-mode tail replaced by a real
 * `export`. Used only to prove the migration harness (boot_pilot.mjs) can
 * load a converted leaf file with zero cross-file dependencies. Not wired
 * into the real app — see tests/manual/esm_migration/pilot/README.md.
 */
export const GeoUtils = {
  EARTH_RADIUS_M: 6371000,
  METERS_PER_DEG_LAT: 111320,

  getGeodesicScale(lat) {
    const degToMeterLon = GeoUtils.METERS_PER_DEG_LAT * Math.cos(parseFloat(lat) * Math.PI / 180);
    return { degToMeterLat: GeoUtils.METERS_PER_DEG_LAT, degToMeterLon };
  },

  distanceMetersSq(lat1, lon1, lat2, lon2, scale) {
    const sc = scale || GeoUtils.getGeodesicScale((parseFloat(lat1) + parseFloat(lat2)) / 2);
    const dy = (parseFloat(lat1) - parseFloat(lat2)) * sc.degToMeterLat;
    const dx = (parseFloat(lon1) - parseFloat(lon2)) * sc.degToMeterLon;
    return dx * dx + dy * dy;
  },

  distanceMeters(lat1, lon1, lat2, lon2, scale) {
    return Math.sqrt(GeoUtils.distanceMetersSq(lat1, lon1, lat2, lon2, scale));
  },

  haversineMeters(lat1, lon1, lat2, lon2) {
    const R = GeoUtils.EARTH_RADIUS_M;
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(Δφ / 2) ** 2 +
              Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  },
};
