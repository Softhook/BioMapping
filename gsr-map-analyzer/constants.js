/**
 * Shared constants for the Bio Mapping GSR analyser.
 * Single source of truth for magic numbers scattered across files.
 */

const GSR_CONST = {

  // ── Sampling ──────────────────────────────────────────────────────────────
  SAMPLE_RATE: 10,          // Default / expected GSR sample rate (Hz)
  GPS_SAMPLE_RATE: 5,       // GPS sample rate (Hz) — firmware configured for 5 Hz

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
  // NOTE: maxHdop here (2.0) is the post-processing analysis filter, intentionally
  // stricter than the firmware logging gate (GPS_HDOP_GATE = 5.0 in biomap_types.h).
  // Firmware logs everything with a plausible fix; the analyser filters for quality.
  // See docs/csv_schema.md for the rationale.
  GPS_DEFAULT: {
    smoothing: 0.5, kalmanR: 10, maxHdop: 2.0, maxSpeed: 3.0, rdpTolerance: 0, downsample: false, trackWeight: 5, peakLatency: 0
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

  // Canonical CSV columns mirroring docs/csv_schema.md
  CSV_COLUMNS: [
    'timestamp',
    'lat',
    'lon',
    'hdop',
    'pdop',
    'sats',
    'fix_type',
    'speed_kts',
    'course_deg',
    'gsr_raw'
  ],

  // ── Unit conversion thresholds ──────────────────────────────────────────
  RESISTANCE_MIN_AVG: 50000,  // Average above this → resistance (Ohms)
  MICROSIEMENS_MIN_AVG: 100,  // Average above this but ≤ threshold → µS/1000
  MICROSIEMENS_MAX_AVG: 50000,

  // ── Peak detection ──────────────────────────────────────────────────────
  PEAK_AMPLITUDE_FACTOR: 0.5, // Minimum peak amplitude as fraction of threshold
  PEAK_MIN_GAP: 1.0,          // Minimum gap after peak (seconds)
  PEAK_RECOVERY_BREAK: 0.1,   // Break threshold for recovery search

  // ── Enhanced peak shape & width criteria ──────────────────────────────
  // Rise-time/half-recovery-time *definitions* and the amplitude threshold
  // range (0.01-0.05 µS) follow established GSR literature (Boucsein, 2012;
  // Dawson, Schell & Filion, 2007; see also https://edaguidelines.github.io).
  // The specific numeric bounds below are tuned/loosened beyond lab-reported
  // ranges to tolerate ambulatory/field-recording noise — see per-field notes.
  PEAK_SHAPE: {
    MIN_RISE_TIME: 0.5,          // Min onset→peak (s) — lab convention is ~1 s min; loosened for ambulatory data
    MAX_RISE_TIME: 5.0,          // Max onset→peak (s) — slower = tonic drift
    MIN_HALF_RECOVERY: 0.3,      // Min half-recovery (s) — internal default; no single literature minimum is well established for this parameter
    MAX_HALF_RECOVERY: 10.0,     // Max half-recovery (s) — too slow for SCR
    MIN_ONSET_SLOPE: 0.01,       // Min slope (µS/s) — converted to physical units
    MAX_ONSET_SLOPE: 5.0,        // Max slope (µS/s) — converted to physical units
    MIN_DECAY_SLOPE: 0.0001,     // Min decay (µS/s) — converted to physical units
    MAX_PEAK_WIDTH: 8.0,        // Max total peak width (s)
    MIN_SNR: 2.0,               // Min signal-to-noise ratio — internal heuristic threshold (NOT from NeuroKit2, which has no built-in EDA signal-quality/SNR criterion)
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

  // ── Lower graph metric definitions ───────────────────────────────────────
  // Selectable series for the lower graph panel. 'phasic' (SCR) is the
  // discrete/thresholded default; the other three are continuous,
  // threshold-independent alternatives that resolve the "thresholding
  // dilemma" and "superposition problem" — see
  // docs/environmental_stress_literature_review.md §5-6.
  LOWER_GRAPH_MODES: {
    phasic: {
      label: 'Phasic (SCR)', unit: 'μS', decimals: 4,
      colorVar: '--color-phasic', colorDefault: '#008f3c',
      showPeakOverlay: true, allowNegative: false
    },
    peakDensity: {
      label: 'Peak Density (NS-SCR)', unit: '/min', decimals: 1,
      colorVar: '--color-peak-density', colorDefault: '#e59e00',
      showPeakOverlay: false, allowNegative: false
    },
    phasicAUC: {
      label: 'Phasic AUC (ISCR)', unit: 'μS·s', decimals: 3,
      colorVar: '--color-phasic-auc', colorDefault: '#0099aa',
      showPeakOverlay: false, allowNegative: false
    },
    arousalIndex: {
      label: 'Combined Arousal Index', unit: 'z', decimals: 2,
      colorVar: '--color-arousal-index', colorDefault: '#7b00cc',
      showPeakOverlay: false, allowNegative: true
    }
  },

  // ── Collective surface defaults ─────────────────────────────────────────
  COLLECTIVE: {
    gridResolution: 40,
    isolationRadius: 50,
    contourCount: 10,
    idwExponent: 2,
    surfaceOpacity: 0.40,
    // Blend factor between the IDW weighted-mean and the local peak envelope (max value
    // within the interpolation radius) for the phasic/tonic continuous surface. 0 = pure
    // average (old behavior, smooths transient spikes away). 1 = pure "worst moment
    // recorded nearby" (no smoothing at all). 0.5 keeps a smooth, readable surface while
    // no longer averaging a lone spike down to near-baseline.
    peakPreservation: 0.5
  },

  // ── Road snapping defaults ──────────────────────────────────────────────
  SNAP: {
    RADIUS_IN:    12,    // m — snap-in gate (fast commit when clearly on-road)
    RADIUS_OUT:   25,    // m — snap-out gate (slow release to resist jitter)
    HEADING_W:    0.7,   // heading penalty weight (0 when speed < SPEED_GATE)
    HYST_MARGIN:  3,     // m — alternative must be this much closer
    HYST_SEC:     5,     // s — consecutive seconds to switch way
    SPEED_GATE:   0.3,   // m/s — suppress bearing penalty below this speed
    GRID_CELL:    25,    // m — highway-only spatial-index cell size
  }
};
