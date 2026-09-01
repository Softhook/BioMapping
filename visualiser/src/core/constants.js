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
  // NOTE: maxHdop here (3.0) is a post-processing analysis filter. The firmware
  // applies no record-time HDOP gate — it logs everything with a plausible fix,
  // and the analyser filters for quality non-destructively.
  // See docs/csv_schema.md for the rationale.
  // NOTE: peakLatency default is 2.0s (not 0) — the "Peak Latency Compensation"
  // slider ships with a physiologically-recommended SCR-onset-delay default
  // (see docs/environmental_enrichment_plan.md §C and the slider's own
  // "Recommended: 1-3s" help text in index.html). This used to say 0 here,
  // silently disagreeing with the shipped UI default of 2.0.
  GPS_DEFAULT: {
    smoothing: 0.5, kalmanR: 10, maxHdop: 3.0, maxSpeed: 3.0, rdpTolerance: 0, downsample: false, trackWeight: 5, peakLatency: 2.0
  },

  // ── GSR filter defaults ──────────────────────────────────────────────────
  GSR_DEFAULT: {
    medianSize: 0, lpfWindow: 0,
    adaptiveNotch: false,
    tonicMethod: 'lpf', tonicWindow: 45, peakThreshold: 0.020,
    dwtLevel: 6,
    shapeMinRiseTime: 0.75, shapeMaxRiseTime: 4.0,
    shapeMinHalfRecovery: 0.65, shapeMaxHalfRecovery: 7.5,
    shapeMinSnr: 3.0, shapeMaxSkewRatio: 4.0,
    minPeakQuality: 0.55,
    hotspotPercentile: 0.02,
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
    // Kernel duration (s). Was 5.0 ("<8% residual at 5s" — that figure was
    // wrong; verified analytically, the kernel is still at ~24% of its peak
    // height and ~13% of its total mass is truncated at a 5s cutoff with
    // tauSlow=2.0). 10.0 = 5*tauSlow, matching the paper's convention and
    // bringing the truncated tail below ~1%. Must actually reach
    // buildSCRFKernel() — see deconvolve()'s opts.kernelSec.
    kernelSec: 10.0,
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
    // Stop when residual max < this (µS). MUST stay below impulseThreshold —
    // matching pursuit quits as soon as the residual drops below convTol, so
    // if convTol were >= impulseThreshold (as it briefly was: 0.01 vs 0.005)
    // MP would terminate before ever producing driver energy in the
    // [impulseThreshold, convTol) band, silently capping sensitivity below
    // what impulseThreshold (and, transitively, the user's peakThreshold
    // slider) implies is achievable — an unannounced, mode-dependent
    // asymmetry versus detectPeaks(), where the same slider isn't limited
    // this way. Set comfortably below impulseThreshold, not just under it,
    // so genuine impulses right at the threshold aren't clipped by residual
    // noise sitting near the boundary.
    convTol: 0.002,
    impulseThreshold: 0.005,  // Min driver amplitude for an impulse (µS)
    minImpulseGapSec: 0.5,    // Min gap between impulses (s)
    // Minimum resolved-apex value (µS) for a gated impulse to be treated as
    // a genuine local rise in the original phasic signal, not just a
    // driver-domain artifact — see _runDeconvolutionPipeline()'s gating
    // comment in analyzer.js. Deliberately far below impulseThreshold; this
    // only rejects near-zero apexes, not small-but-real ones.
    minApexVal: 0.001
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
    'gsr_raw',
    'hacc_m'
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

  // ── Graph view metric definitions ───────────────────────────────────────
  // Selectable series for the single-graph view. 'phasic' (SCR) is the
  // discrete/thresholded default; 'phasicAUC' and 'arousalIndex' are
  // continuous, threshold-independent alternatives that resolve the
  // "thresholding dilemma" and "superposition problem" — see
  // docs/environmental_stress_literature_review.md §5-6. 'tonic' (SCL) and
  // 'peakDensity' (NS-SCR rate) round out the set. (EM Fog is not offered as a
  // graph view — the map/globe still colour by it.)
  LOWER_GRAPH_MODES: {
    tonic: {
      label: 'Tonic (SCL)', unit: 'μS', decimals: 4,
      colorVar: '--color-tonic', colorDefault: '#a30091',
      showPeakOverlay: false, allowNegative: false
    },
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
    upsampledResolution: 240,
    blurIterations: 6,
    isolationRadius: 50,
    contourCount: 10,
    idwExponent: 2,
    surfaceOpacity: 0.40,
    // Softening/smoothing parameter in meters added to the IDW distance denominator
    // to prevent singular bull's eye spikes at track points and saddles between them.
    softening: 25.0,
    // Blend factor between the IDW weighted-mean and the local peak envelope (a
    // distance-decayed max within the interpolation radius) for the phasic/tonic
    // continuous surface. 0 = pure average (many overlapping calm samples can bury a
    // rare high-arousal one). 1 = pure "most aroused moment recorded nearby" (no
    // averaging at all). Exposed as the "Peak Preservation" slider in the UI.
    peakPreservation: 0.5,
    // Percentile-rank threshold (see generateContourSurface()'s coverage block) below which
    // a cell gets checkerboarded in map.js's renderContours() — how many distinct
    // participant tracks actually passed near that cell, relative to how well-covered the
    // rest of the loaded dataset is (not an absolute headcount). 0 = nothing checkered,
    // every cell renders as-is regardless of foot traffic (old behavior). 1 = only the
    // single best-covered cell escapes the pattern, so a single passerby's reading gets
    // visibly flagged as thin evidence rather than reading as confidently as a place many
    // people corroborated.
    coverageWeighting: 0.5,
    // Sliding window size in seconds for temporal anti-aliasing (smoothing) of biometric
    // data. 0.0 disables smoothing. 20.0 seconds filters out rapid 10 Hz spikes to reveal
    // macro-level arousal trends.
    temporalSmoothingWindow: 20.0
  },

  // ── Collective surface hillshading ──────────────────────────────────────
  // Relief-shades the same grid COLLECTIVE.gridResolution interpolates,
  // treating value (not elevation) as height. Since the values are z-scored
  // arousal/phasic metrics (not meters), the height field is
  // normalized to [0, 1] and re-scaled by `exaggeration` (in grid-cell
  // widths) before shading, rather than using real-world cell spacing —
  // that keeps the relief's visual intensity consistent across tracks
  // regardless of grid resolution or the metric's raw unit scale.
  HILLSHADE: {
    azimuthDeg: 315,   // simulated sun direction, true compass bearing (0=N, 90=E, 180=S, 270=W); 315 = NW (top-left on a north-up map), casting shadow toward SE (bottom-right)
    altitudeDeg: 35,   // sun elevation above the horizon — lower angle = longer, more dramatic shadows
    exaggeration: 6.0, // full 0..1 normalized value range mapped to this many grid-cell widths of "height"
    // minLightness/maxLightness are deliberately NOT symmetric around the 50%
    // baseline. Flat (unsloped) cells always render at cos(altitudeDeg) —
    // here cos(35deg) = 0.82 — regardless of exaggeration, so a naive
    // symmetric range (e.g. 8..92) brightens almost the ENTIRE surface well
    // above baseline (flat cells alone landed at ~76%), leaving true shadow
    // as the rare exception instead of the common case. maxLightness=60 puts
    // that same flat-cell brightness back at ~50% (neutral, matching the old
    // unshaded look), so brightening only shows up where a slope genuinely
    // faces the sun MORE than ambient — while minLightness stays low so
    // slopes facing away still read as a real, strong shadow.
    minLightness: 6,   // HSL lightness % for fully-shadowed cells
    maxLightness: 60   // HSL lightness % for cells facing the sun directly
  },

  // ── Memorable-event ("hotspot") selection ────────────────────────────────
  // See GSRAnalyzer.analyze()'s "Memorable-event view" section for the full
  // rationale (was a fixed salienceScore threshold, moved to percentile-based
  // selection — see that doc comment for the real-track yield numbers behind
  // the 2% choice).
  MEMORABLE_EVENTS: {
    HOTSPOT_PERCENTILE: 0.02  // Top X% of active (non-excluded) peaks by amplitude
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
  },

  // The 8 OSM enrichment fields (osm_enrichment.js), and the UI metric key
  // each is exposed under (map.js's "Map Metric" dropdown, ui.js's
  // correlation dashboard). Single source of truth for key<->field<->label —
  // used to live hardcoded in 4 separate places (map.js's legend title map
  // and _getMetricKey, ui.js's correlation-matrix feature list and
  // regression-scatter axis labels), which meant adding/renaming/removing a
  // metric meant editing all 4 by hand with nothing to catch a missed one.
  // `kind: 'categorical'` metrics (roadClass, inPark) render as legend
  // swatches and are excluded from the continuous-only correlation/scatter
  // UI; `unit` (when present) is appended in parens only where that already
  // happened (ui.js's regression-scatter axis labels) — every other consumer
  // uses the bare label, unchanged from before this table existed.
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
