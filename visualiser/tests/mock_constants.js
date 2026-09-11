/**
 * Mock GSR_CONST for Node.js unit tests.
 * Mirrors the real constants.js values used by the tested modules.
 */
module.exports = {
  MARGIN: { top: 22, bottom: 10, left: 70, right: 35, gap: 40 },
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
    medianSize: 0, lpfWindow: 0.5,
    tonicMethod: 'lpf', tonicWindow: 45, peakThreshold: 0.015,
    shapeMinSnr: 1.5,
    minPeakQuality: 0.0,
    peakDensityWindow: 10,
    hotspotPercentile: 0.02,
    useDeconvolution: false,
    usePeakProminence: false,
    useCvxEDA: false
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
    minApexVal: 0.001,
    sparsedaKmax: 40,
    sparsedaEpsilon: 0.01,
    sparsedaDminSec: 1.25,
    sparsedaRho: 0.025,
    deconvAlgorithm: 'matching_pursuit'
  },

  CVXEDA: {
    tauSlow: 2.0,
    tauFast: 0.7,
    deltaKnotSec: 10.0,
    alpha: 2e-3,
    gamma: 1e-2,
    maxIter: 50,
    tol: 1e-10,
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
  MICROSIEMENS_MAX_SCR: 20,   // Artefact ceiling for prominence detector (µS)

  PEAK_MIN_GAP: 1.3,
  PEAK_RECOVERY_BREAK: 0.1,
  PEAK_PROMINENCE_BASELINE_SEC: 8,

  PEAK_SHAPE: {
    MAX_RISE_TIME: 5.0,
    MIN_SNR: 1.5,
    QUALITY_WEIGHTS: {
      amplitude: 0.20, riseTime: 0.15, recoveryTime: 0.15,
      skewness: 0.15, onsetSlope: 0.10, snr: 0.15, decaySlope: 0.10
    }
  },

  AROUSAL_INDEX: {
    wTonic: 0.3, wPhasic: 0.7, windowAucSec: 30
  },

  TRI_INDEX: {
    wTonic: 0.10, wPhasic: 0.45, wDensity: 0.45,
    windowAucSec: 30, windowDensitySec: 60
  },

  TOPOGRAPHY_SOURCES: {
    phasic:        { label: 'Phasic Arousal', unit: ' μS' },
    tonic:         { label: 'Tonic Baseline (SCL)', unit: ' μS' },
    peaks:         { label: 'Peak Stress Hotspots', unit: '' },
    auc:           { label: 'Phasic AUC (ISCR)', unit: ' μS·s' },
    arousal_index: { label: 'Combined Arousal Index', unit: ' z' },
    tri_index:     { label: 'Tri Index', unit: ' z' },
    gsr:           { label: 'GSR Signal', unit: ' μS' },
    peak_density:  { label: 'Peak Density', unit: ' /min' }
  },

  TEMPORAL_PEAK_DENSITY: {
    windowSizeSec: 10, sigmaRatio: 0.25, cutoffMultiplier: 3.5, scaleToPerMinute: 60.0
  },

  PEAK_KDE: {
    sigma: 15, ampWeightMin: 0.55, ampWeightMax: 3.0
  },

  AROUSAL_PLACES: {
    mergeM: 35, minMergeM: 10, maxMergeM: 120,
    seedSeparationFactor: 1.8, drawGapFactor: 0.46,
    footprintPadM: 10, dwellFloorS: 5, provisionalMaxTracks: 1,
    minMembers: 3, maxPlaces: 20
  },

  PATH_OVERLAP: {
    widthFactor: 1.0, maxRadiusM: 60, revisitGapS: 15
  },

  COLLECTIVE: {
    gridResolution: 60, upsampledResolution: 240, blurIterations: 6,
    isolationRadius: 50, contourCount: 10,
    idwExponent: 2, surfaceOpacity: 0.40, peakPreservation: 0.0, softening: 25.0,
    // Matches production constants.js so the moving-average pass in
    // generateContourSurface() is exercised. Tests that need a raw, unsmoothed
    // surface pass temporalSmoothingWindow: 0 explicitly in their contourParams.
    coverageWeighting: 0.5, temporalSmoothingWindow: 20.0
  },

  HILLSHADE: {
    azimuthDeg: 315, altitudeDeg: 35, exaggeration: 6.0,
    minLightness: 6, maxLightness: 60
  },

  SNAP: {
    HEADING_W: 0.7, SPEED_GATE: 0.3
  },

  MEMORABLE_EVENTS: {
    HOTSPOT_PERCENTILE: 0.02,
    MIN_SEPARATION_M: 30
  },

  OSM_METRICS: [
    { key: 'roadClass',       field: 'osm_road_class',            label: 'Road Class',              kind: 'categorical' },
    { key: 'distMajorRoad',   field: 'osm_dist_major_road',        label: 'Distance to Major Road',  kind: 'continuous', unit: 'm' },
    { key: 'inPark',          field: 'osm_in_park',                label: 'In Park / Green Space',   kind: 'binary' },
    { key: 'greenPct',        field: 'osm_green_pct_50m',          label: 'Green Space %',           kind: 'continuous' },
    { key: 'distGreen',       field: 'osm_dist_green',             label: 'Distance to Green Space', kind: 'continuous', unit: 'm' },
    { key: 'canopyPct',       field: 'osm_canopy_pct_50m',         label: 'Tree Canopy %',          kind: 'continuous' },
    { key: 'buildingDensity', field: 'osm_building_density_50m',   label: 'Building Density',        kind: 'continuous' },
    { key: 'distWater',       field: 'osm_dist_water',             label: 'Distance to Water',       kind: 'continuous', unit: 'm' },
    { key: 'treeDensity',     field: 'osm_tree_density_50m',       label: 'Tree Density',            kind: 'continuous' },
    { key: 'amenityCount',    field: 'osm_amenity_count_50m',      label: 'Amenity Count',           kind: 'continuous' }
  ],

  SATELLITE_METRICS: [
    { key: 'ndvi_50m', field: 'ndvi_50m', label: 'NDVI (50m Buffer)', kind: 'continuous', unit: 'index' },
    { key: 'ndvi',     field: 'ndvi',     label: 'Point NDVI',        kind: 'continuous', unit: 'index' }
  ]
};
