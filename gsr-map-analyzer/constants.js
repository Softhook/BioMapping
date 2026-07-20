/**
 * Shared constants for the Bio Mapping GSR analyser.
 * Single source of truth for magic numbers scattered across files.
 */

const GSR_CONST = {

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
  // NOTE: peakLatency default is 2.0s (not 0) — the "Peak Latency Compensation"
  // slider ships with a physiologically-recommended SCR-onset-delay default
  // (see docs/environmental_enrichment_plan.md §C and the slider's own
  // "Recommended: 1-3s" help text in index.html). This used to say 0 here,
  // silently disagreeing with the shipped UI default of 2.0.
  GPS_DEFAULT: {
    smoothing: 0.5, kalmanR: 10, maxHdop: 2.0, maxSpeed: 3.0, rdpTolerance: 0, downsample: false, trackWeight: 5, peakLatency: 2.0
  },

  // ── GSR filter defaults ──────────────────────────────────────────────────
  GSR_DEFAULT: {
    medianSize: 0, lpfWindow: 0,
    tonicMethod: 'percentile', tonicWindow: 15, peakThreshold: 0.020,
    dwtLevel: 6,
    shapeMinRiseTime: 0, shapeMaxRiseTime: 0,
    shapeMinHalfRecovery: 0, shapeMaxHalfRecovery: 0,
    shapeMinSnr: 0, shapeMaxSkewRatio: 0,
    minPeakQuality: 0.0,
    useDeconvolution: false
  },

  // ── SCR deconvolution (Benedek & Kaernbach, 2010) ────────────────────────
  // Bi-exponential (Bateman) SCRF kernel parameters. When useDeconvolution is
  // enabled, GSRAnalyzer._runDeconvolutionPipeline() runs ONE global
  // nonnegative deconvolution of the whole phasic trace against this kernel,
  // recovering a sparse driver signal. Each driver impulse becomes a peak
  // directly (bypassing detectPeaks() entirely for that analysis run), with
  // shape metrics (rise time, half-recovery, skew, FWHM) derived analytically
  // from the kernel rather than measured per-event — this is intentional and
  // matches the published method: fixing one canonical response shape per
  // recording is what makes amplitude the only free parameter, which is what
  // makes overlapping/superposed SCRs separable in the first place. The
  // reconvolved, superposition-resolved signal (phasicClean) replaces
  // this.phasic and feeds all downstream continuous metrics (AUC, temporal
  // density, arousal index).
  SCRF: {
    tauSlow: 2.0,       // Decay (slow) time constant (s) — Benedek & Kaernbach Table 1
    tauFast: 0.75,      // Rise (fast) time constant (s)
    kernelSec: 5.0,     // Kernel duration (s) — <8 % residual at 5 s
    // Max matching-pursuit iterations — this is a GLOBAL, whole-track budget
    // (one deconvolve() pass per analyze() call, not per-peak), so it must
    // scale with recording length/density. Measured on a 920s/9200-sample
    // busy walking track: natural convergence (residual < convTol) occurred
    // at 424 iterations, in ~3ms even with a 2000 cap — so 2000 is a
    // generous ceiling that's expected to rarely bind, not a value tuned to
    // this one recording. A value in the 30-50 range (left over from an
    // earlier per-peak ±5s-window design) silently truncates long/busy
    // tracks well before convergence, discarding genuine SCRs with no
    // indication anything was cut short — always check `iterations` in the
    // return value against maxIter if tuning this further.
    maxIter: 2000,
    lr: 1.0,            // Atom amplitude scale (1.0 = full subtraction)
    convTol: 0.01,      // Stop when residual max < this (µS)
    impulseThreshold: 0.005,  // Min driver amplitude for an impulse (µS)
    minImpulseGapSec: 0.5     // Min gap between impulses (s)
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

  // ── Spatial peak-density KDE ─────────────────────────────────────────────
  // Canonical Gaussian-kernel settings for turning discrete peak *locations*
  // into a spatial density field. Two call sites need this: the cluster-blob
  // boundaries (spatial_clustering.js getConcaveBlob) and the "Peak Stress
  // Hotspots" contour surface (collective_manager.js, topographySource ===
  // 'peaks'). These had drifted apart — sigma 15 vs a hardcoded 20, and a
  // clamped relative-to-mean amplitude weight vs raw/unclamped amplitude —
  // so the two "actual peaks" map views could disagree on where/how intense
  // the hot spots were for identical underlying data. Both now read from here.
  PEAK_KDE: {
    sigma: 15,          // default kernel width in meters; the blob UI's sigma (boundaryRadius * 0.83) overrides this per-render
    ampWeightMin: 0.55,  // floor so a below-average peak still contributes, never vanishes
    ampWeightMax: 3.0    // ceiling so one extreme outlier can't blow out the whole field
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

  // ── Road snapping — map-matcher bearing tuning ───────────────────────────
  // CORRECTION: an earlier cleanup pass deleted the whole former SNAP block as
  // "dead" because nothing reads `GSR_CONST.SNAP.*` directly. That check was
  // too shallow — map_match.js's `_getCandidates()` independently hardcodes
  // the *same* two values (0.7 and 0.3) inline for its heading-penalty term
  // and speed gate. Restored just those two, now actually wired (see
  // map_match.js), and left the rest removed: RADIUS_IN/RADIUS_OUT and
  // HYST_MARGIN/HYST_SEC described a dual-radius hysteresis state machine
  // that the current HMM/Viterbi matcher doesn't use (Viterbi gets
  // path-smoothness from global sequence optimization instead), and
  // GRID_CELL (25 m) doesn't match the spatial index actually in use
  // (osm_enrichment.js CELL_SIZE_DEG = 0.001° ≈ 111 m) — those three were
  // genuinely never implemented, not just disconnected from this constant.
  SNAP: {
    HEADING_W:  0.7,   // heading penalty weight in map-matcher candidate ranking
    SPEED_GATE: 0.3    // m/s — below this speed, course is unreliable so the heading penalty is skipped
  }
};
