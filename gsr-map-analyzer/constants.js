/**
 * Shared constants for the Bio Mapping GSR analyser.
 * Single source of truth for magic numbers scattered across files.
 */

const GSR_CONST = {

  // ── Sampling ──────────────────────────────────────────────────────────────
  SAMPLE_RATE: 10,          // Default / expected GSR sample rate (Hz)
  GPS_SAMPLE_RATE: 1,       // GPS sample rate (Hz)

  // ── Graph layout (p5.js canvas) ──────────────────────────────────────────
  MARGIN: { top: 30, bottom: 16, left: 70, right: 35, gap: 40 },

  GRAPH_UPPER_RATIO: 0.62,  // Upper graph (GSR) proportion of plot area
  GRAPH_LOWER_RATIO: 0.38,  // Lower graph (Phasic) proportion
  TIMELINE_HEIGHT: 22,      // Overview timeline bar height (px)
  TIMELINE_GAP: 12,         // Gap between main graph and timeline (px)

  ZOOM_MIN: 1.0,            // Minimum zoom factor (full view)
  ZOOM_MAX: 50.0,           // Maximum zoom factor
  ZOOM_MIN_DURATION: 2.0,   // Shortest viewport duration (seconds)
  DRAW_MAX_VERTICES: 1500,  // Max vertices before sub-sampling curves
  SPLINE_THRESHOLD: 600,    // Below this count use spline, else linear

  // ── Contour / collective surface ─────────────────────────────────────────
  CONTOUR_MAX_POINTS: 20000,   // Target max points for IDW interpolation

  // ── GPS filter defaults ──────────────────────────────────────────────────
  GPS_DEFAULT: {
    // HDOP gate: reject positions with poor satellite geometry (>3.0).
    // fix_type gate: 2 = reject "no fix" only; 2D fixes are still useful
    //   (3D would reject 2D fixes that may have excellent horizontal accuracy).
    // Kalman: R=10m² (consumer GPS, HDOP-scaled), Q=0.5m²/s (pedestrian walk).
    // Speed filter: 3.0 m/s ≈ 10.8 km/h — brisk walking pace; catches GPS jumps.
    minSats: 0, maxHdop: 3.0, minFixType: 2, maxSpeed: 3.0, hampelWindow: 0, hampelSigma: 3.0,
    dbscanRadius: 0, dbscanMinPts: 4, kalmanR: 10.0, kalmanQ: 0.5,
    rdpTolerance: 0, downsample: false, trackWeight: 5
  },

  // ── GSR filter defaults ──────────────────────────────────────────────────
  GSR_DEFAULT: {
    medianSize: 0, lpfWindow: 0,
    tonicMethod: 'percentile', tonicWindow: 15, peakThreshold: 0.020,
    dwtLevel: 6,
    shapeMinRiseTime: 0, shapeMaxRiseTime: 0,
    shapeMinHalfRecovery: 0, shapeMaxHalfRecovery: 0,
    shapeMinSnr: 0, shapeMaxSkewRatio: 0
  },

  // ── CSV parsing keywords ─────────────────────────────────────────────────
  // NOTE: bare 't' was removed — it false-matched lat, alt, sats, fix_type,
  // speed_kts. 'timestamp' and 'time' already cover all common time columns.
  TIME_KEYWORDS: ['time', 'sec', 'timestamp', 'millis', 'ms'],
  GSR_KEYWORDS: ['gsr', 'eda', 'conductance', 'resistance', 'res', 'us', 'raw', 'micro', 'ohms', 'val'],

  // ── Unit conversion thresholds ──────────────────────────────────────────
  RESISTANCE_MIN_AVG: 50000,  // Average above this → resistance (Ohms)
  MICROSIEMENS_MIN_AVG: 100,  // Average above this but ≤ threshold → µS/1000
  MICROSIEMENS_MAX_AVG: 50000,

  // ── Peak detection ──────────────────────────────────────────────────────
  PEAK_AMPLITUDE_FACTOR: 0.5, // Minimum peak amplitude as fraction of threshold
  PEAK_MIN_GAP: 1.0,          // Minimum gap after peak (seconds)
  PEAK_RECOVERY_BREAK: 0.1,   // Break threshold for recovery search

  // ── Enhanced peak shape & width criteria ──────────────────────────────
  // Based on established GSR literature (Boucsein, 2012; Benedek & Kaernbach, 2010)
  PEAK_SHAPE: {
    MIN_RISE_TIME: 0.5,          // Min onset→peak (s) — per Boucsein 0.5–5 s
    MAX_RISE_TIME: 5.0,          // Max onset→peak (s) — slower = tonic drift
    MIN_HALF_RECOVERY: 0.3,      // Min half-recovery (s) — per Van Halem 0.5 s min
    MAX_HALF_RECOVERY: 10.0,     // Max half-recovery (s) — too slow for SCR
    MIN_ONSET_SLOPE: 0.01,       // Min slope (µS/s) — converted to physical units
    MAX_ONSET_SLOPE: 5.0,        // Max slope (µS/s) — converted to physical units
    MIN_DECAY_SLOPE: 0.0001,     // Min decay (µS/s) — converted to physical units
    MAX_PEAK_WIDTH: 8.0,        // Max total peak width (s)
    MIN_SNR: 2.0,               // Min signal-to-noise ratio — per NeuroKit standard
    SKEWNESS_RATIO_MIN: 0.2,    // Min rise/recovery ratio (asymmetric shape)
    SKEWNESS_RATIO_MAX: 6.0,    // Max rise/recovery ratio
    QUALITY_WEIGHTS: {           // For composite quality score (0–1)
      amplitude: 0.20,           // Higher amplitude = more confident
      riseTime: 0.15,            // Rise time in ideal range
      recoveryTime: 0.15,        // Recovery time in ideal range
      skewness: 0.15,            // Fast rise, slow recovery = classic SCR shape
      onsetSlope: 0.10,          // Steepness of rise
      snr: 0.15,                // Signal-to-noise ratio
      decaySlope: 0.10           // Recovery must be present
    }
  },

  // ── Collective surface defaults ─────────────────────────────────────────
  COLLECTIVE: {
    gridResolution: 40,
    isolationRadius: 50,
    contourCount: 10,
    idwExponent: 2,
    surfaceOpacity: 0.40
  }
};
