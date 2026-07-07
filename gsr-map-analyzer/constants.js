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
    smoothing: 0.5, kalmanR: 10, maxHdop: 2.0, maxSpeed: 3.0, rdpTolerance: 0, downsample: false, trackWeight: 5
  },

  // ── GSR filter defaults ──────────────────────────────────────────────────
  GSR_DEFAULT: {
    medianSize: 0, lpfWindow: 0,
    tonicMethod: 'percentile', tonicWindow: 15, peakThreshold: 0.020,
    dwtLevel: 6,
    shapeMinRiseTime: 0, shapeMaxRiseTime: 0,
    shapeMinHalfRecovery: 0, shapeMaxHalfRecovery: 0,
    shapeMinSnr: 0, shapeMaxSkewRatio: 0,
    minPeakQuality: 0.0
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
  },

  // ── Road snapping defaults ──────────────────────────────────────────────
  SNAP: {
    RADIUS_IN:    12,    // m — snap-in gate (fast commit when clearly on-road)
    RADIUS_OUT:   25,    // m — snap-out gate (slow release to resist jitter)
    HEADING_W:    0.3,   // heading penalty weight (suppressed when speed < SPEED_GATE)
    HYST_MARGIN:  3,     // m — alternative must be this much closer
    HYST_SEC:     5,     // s — consecutive seconds to switch way
    SPEED_GATE:   0.3,   // m/s — suppress bearing penalty below this speed
    GRID_CELL:    25,    // m — highway-only spatial-index cell size
  }
};
