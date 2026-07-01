/**
 * Shared constants for the Bio Mapping GSR analyser.
 * Single source of truth for magic numbers scattered across files.
 */

const GSR_CONST = {

  // ── Sampling ──────────────────────────────────────────────────────────────
  SAMPLE_RATE: 10,          // Default / expected GSR sample rate (Hz)
  GPS_SAMPLE_RATE: 1,       // GPS sample rate (Hz)

  // ── Graph layout (p5.js canvas) ──────────────────────────────────────────
  MARGIN: { top: 30, bottom: 50, left: 70, right: 35, gap: 40 },

  GRAPH_UPPER_RATIO: 0.62,  // Upper graph (GSR) proportion of plot area
  GRAPH_LOWER_RATIO: 0.38,  // Lower graph (Phasic) proportion
  TIMELINE_HEIGHT: 22,      // Overview timeline bar height (px)
  TIMELINE_GAP: 25,         // Gap between main graph and timeline (px)

  ZOOM_MIN: 1.0,            // Minimum zoom factor (full view)
  ZOOM_MAX: 50.0,           // Maximum zoom factor
  ZOOM_MIN_DURATION: 2.0,   // Shortest viewport duration (seconds)
  DRAW_MAX_VERTICES: 1500,  // Max vertices before sub-sampling curves
  SPLINE_THRESHOLD: 600,    // Below this count use spline, else linear

  // ── Track colours ────────────────────────────────────────────────────────
  TRACK_COLORS: [
    '#0ea5e9', '#10b981', '#f43f5e', '#a855f7',
    '#f59e0b', '#ec4899', '#14b8a6', '#f97316'
  ],

  // ── Contour / collective surface ─────────────────────────────────────────
  CONTOUR_MAX_POINTS: 20000, // Target max points for IDW interpolation
  CONTOUR_BOUNDARY_CHECK: 100, // Sample count for boundary mask check
  CONTOUR_ISOLATION_PAD: 1.5, // Radius multiplier for IDW isolation
  CONTOUR_IDW_EXACT: 1e-3,   // Distance threshold for exact grid match (deg)

  // ── GPS filter defaults ──────────────────────────────────────────────────
  GPS_DEFAULT: {
    minSats: 0, maxSpeed: 5, hampelWindow: 3, hampelSigma: 3.0,
    dbscanRadius: 10, dbscanMinPts: 4, kalmanR: 25, kalmanQ: 1e-4,
    rdpTolerance: 5, minDist: 0, downsample: true, trackWeight: 5
  },

  // ── GSR filter defaults ──────────────────────────────────────────────────
  GSR_DEFAULT: {
    medianSize: 1.0, lpfWindow: 0.8,
    tonicMethod: 'percentile', tonicWindow: 15, peakThreshold: 0.020
  },

  // ── CSV parsing keywords ─────────────────────────────────────────────────
  TIME_KEYWORDS: ['time', 'sec', 't', 'timestamp', 'millis', 'ms'],
  GSR_KEYWORDS: ['gsr', 'eda', 'conductance', 'resistance', 'res', 'us', 'raw', 'micro', 'ohms', 'val'],

  // ── Unit conversion thresholds ──────────────────────────────────────────
  RESISTANCE_MIN_AVG: 50000,  // Average above this → resistance (Ohms)
  MICROSIEMENS_MIN_AVG: 100,  // Average above this but ≤ threshold → µS/1000
  MICROSIEMENS_MAX_AVG: 50000,

  // ── Peak detection ──────────────────────────────────────────────────────
  PEAK_AMPLITUDE_FACTOR: 0.5, // Minimum peak amplitude as fraction of threshold
  PEAK_MIN_GAP: 1.0,          // Minimum gap after peak (seconds)
  PEAK_RECOVERY_BREAK: 0.1,   // Break threshold for recovery search

  // ── Grid step presets (renderer.js) ──────────────────────────────────────
  GRID_TIME_STEPS: [
    { max: 5,     step: 0.5 },
    { max: 15,    step: 1 },
    { max: 30,    step: 5 },
    { max: 120,   step: 10 },
    { max: 300,   step: 30 },
    { max: 900,   step: 60 },
    { max: 1800,  step: 300 },
    { max: 3600,  step: 600 },
    { max: 7200,  step: 1200 }
  ],
  GRID_TIME_STEP_DEFAULT: 1800,

  GRID_UPPER_STEPS: [
    { max: 0.2, step: 0.02 },
    { max: 1.0, step: 0.1 },
    { max: 3.0, step: 0.5 },
    { max: 10,  step: 1.0 }
  ],
  GRID_UPPER_STEP_DEFAULT: 2.0,

  GRID_LOWER_STEPS: [
    { max: 0.05, step: 0.005 },
    { max: 0.15, step: 0.01 },
    { max: 0.5,  step: 0.05 },
    { max: 1.5,  step: 0.1 }
  ],
  GRID_LOWER_STEP_DEFAULT: 0.5,

  // ── Collective surface defaults ─────────────────────────────────────────
  COLLECTIVE: {
    gridResolution: 40,
    isolationRadius: 50,
    contourCount: 10,
    idwExponent: 2,
    surfaceOpacity: 0.40
  }
};
