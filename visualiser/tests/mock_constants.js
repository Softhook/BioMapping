/**
 * Mock GSR_CONST for Node.js unit tests.
 * Mirrors the real constants.js values used by the tested modules.
 */
module.exports = {
  MARGIN: { top: 30, bottom: 16, left: 70, right: 35, gap: 40 },
  GRAPH_UPPER_RATIO: 0.62,
  GRAPH_LOWER_RATIO: 0.38,
  TIMELINE_HEIGHT: 22,
  TIMELINE_GAP: 12,

  ZOOM_MIN: 1.0,
  ZOOM_MAX: 50.0,
  ZOOM_MIN_DURATION: 2.0,
  DRAW_MAX_VERTICES: 1500,
  SPLINE_THRESHOLD: 600,
  CONTOUR_MAX_POINTS: 20000,

  GPS_DEFAULT: {
    smoothing: 0.5, kalmanR: 10, maxHdop: 3.0, maxSpeed: 3.0,
    rdpTolerance: 0, downsample: false, trackWeight: 5, peakLatency: 2.0
  },

  GSR_DEFAULT: {
    medianSize: 0, lpfWindow: 0,
    tonicMethod: 'lpf', tonicWindow: 45, peakThreshold: 0.020,
    dwtLevel: 6,
    shapeMinRiseTime: 0.75, shapeMaxRiseTime: 4.0,
    shapeMinHalfRecovery: 0.65, shapeMaxHalfRecovery: 7.5,
    shapeMinSnr: 3.0, shapeMaxSkewRatio: 4.0,
    minPeakQuality: 0.55,
    hotspotPercentile: 0.02,
    useDeconvolution: false
  },

  SCRF: {
    tauSlow: 2.0,
    tauFast: 0.75,
    kernelSec: 10.0,
    maxIter: 2000,
    lr: 1.0,
    convTol: 0.002,
    impulseThreshold: 0.005,
    minImpulseGapSec: 0.5,
    minApexVal: 0.001
  },

  TIME_KEYWORDS: ['time', 'sec', 'timestamp', 'millis', 'ms'],
  GSR_KEYWORDS: ['gsr', 'eda', 'conductance', 'resistance', 'res', 'us', 'raw', 'micro', 'ohms', 'val'],

  CSV_COLUMNS: [
    'timestamp', 'lat', 'lon', 'hdop', 'pdop', 'sats',
    'fix_type', 'speed_kts', 'course_deg', 'gsr_raw', 'hacc_m'
  ],

  RESISTANCE_MIN_AVG: 50000,
  MICROSIEMENS_MIN_AVG: 100,
  MICROSIEMENS_MAX_AVG: 50000,

  PEAK_MIN_GAP: 1.0,
  PEAK_RECOVERY_BREAK: 0.1,

  PEAK_SHAPE: {
    MIN_RISE_TIME: 0.5,
    MAX_RISE_TIME: 5.0,
    MIN_HALF_RECOVERY: 0.3,
    MAX_HALF_RECOVERY: 10.0,
    MIN_ONSET_SLOPE: 0.01,
    MAX_ONSET_SLOPE: 5.0,
    MIN_DECAY_SLOPE: 0.0001,
    MAX_PEAK_WIDTH: 8.0,
    MIN_SNR: 2.0,
    SKEWNESS_RATIO_MIN: 0.2,
    SKEWNESS_RATIO_MAX: 6.0,
    QUALITY_WEIGHTS: {
      amplitude: 0.20, riseTime: 0.15, recoveryTime: 0.15,
      skewness: 0.15, onsetSlope: 0.10, snr: 0.15, decaySlope: 0.10
    }
  },

  PEAK_KDE: {
    sigma: 15, ampWeightMin: 0.55, ampWeightMax: 3.0
  },

  COLLECTIVE: {
    gridResolution: 60, upsampledResolution: 240, blurIterations: 6,
    isolationRadius: 50, contourCount: 10,
    idwExponent: 2, surfaceOpacity: 0.40, peakPreservation: 0.0, softening: 25.0,
    temporalSmoothingWindow: 0.0
  },

  HILLSHADE: {
    azimuthDeg: 315, altitudeDeg: 35, exaggeration: 6.0,
    minLightness: 6, maxLightness: 60
  },

  SNAP: {
    HEADING_W: 0.7, SPEED_GATE: 0.3
  },

  MEMORABLE_EVENTS: {
    HOTSPOT_PERCENTILE: 0.02
  },

  OSM_METRICS: [
    { key: 'roadClass',       field: 'osm_road_class',            label: 'Road Class',              kind: 'categorical' },
    { key: 'distMajorRoad',   field: 'osm_dist_major_road',        label: 'Distance to Major Road',  kind: 'continuous', unit: 'm' },
    { key: 'inPark',          field: 'osm_in_park',                label: 'In Park / Green Space',   kind: 'categorical' },
    { key: 'greenPct',        field: 'osm_green_pct_50m',          label: 'Green Space %',           kind: 'continuous' },
    { key: 'buildingDensity', field: 'osm_building_density_50m',   label: 'Building Density',        kind: 'continuous' },
    { key: 'distWater',       field: 'osm_dist_water',             label: 'Distance to Water',       kind: 'continuous', unit: 'm' },
    { key: 'treeDensity',     field: 'osm_tree_density_50m',       label: 'Tree Density',            kind: 'continuous' },
    { key: 'amenityCount',    field: 'osm_amenity_count_50m',      label: 'Amenity Count',           kind: 'continuous' }
  ]
};
