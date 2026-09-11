/**
 * Shared constants for the Bio Mapping GSR analyser.
 * Single source of truth for magic numbers scattered across files.
 */

const GSR_CONST = {

  // ── Graph layout (p5.js canvas) ──────────────────────────────────────────
  MARGIN: { top: 22, bottom: 10, left: 70, right: 35, gap: 40 },

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
  // The default detector (full-scan trough-to-peak) gates on amplitude
  // (peakThreshold), Min SNR (shapeMinSnr) and composite quality
  // (minPeakQuality) only — the literature SCR criteria. Both extra gates ship
  // at recall-oriented values: Min SNR 1.5 is a light noise guard that mostly
  // matters when the LPF is lowered/off, and Min Peak Quality ships off (0).
  // Raise either per recording when precision matters more than recall.
  GSR_DEFAULT: {
    // Mild low-pass on by default: raw 10 Hz GSR carries quantisation +
    // sensor fuzz + low-level motion tremor that an unsmoothed detector reads
    // as extra peaks with poor shape scores. A 0.5 s moving average clears
    // that without touching SCR morphology (responses rise over 1–3 s) —
    // measured across real tracks it lifts median peak quality ~0.10–0.15 and
    // pulls inter-peak intervals toward physiological values. Raise toward
    // 1.0–1.2 s to also cancel a walking-gait artefact.
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

  // ── SCR deconvolution (Benedek & Kaernbach, 2010) ────────────────────────
  // Bi-exponential (Bateman) SCRF kernel parameters. When useDeconvolution is
  // enabled, GSRAnalyzer._runDeconvolutionPipeline() runs ONE global
  // nonnegative deconvolution of the whole phasic trace against this kernel,
  // recovering a sparse driver signal. Each driver impulse becomes a peak
  // directly (replacing the default detector for that analysis run), with
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
    // asymmetry versus the raw detectors, where the same slider isn't limited
    // this way. Set comfortably below impulseThreshold, not just under it,
    // so genuine impulses right at the threshold aren't clipped by residual
    // noise sitting near the boundary.
    convTol: 0.002,
    impulseThreshold: 0.005,  // Min driver amplitude for an impulse (µS)
    minImpulseGapSec: 0.5,    // Min gap between impulses (s)
    // Minimum resolved-apex value (µS) for a gated impulse to be treated as
    // a genuine local rise in the original phasic signal, not just a
    // driver-domain artefact — see _runDeconvolutionPipeline()'s gating
    // comment in analyzer.js. Deliberately far below impulseThreshold; this
    // only rejects near-zero apexes, not small-but-real ones.
    minApexVal: 0.001,
    // Official SparsEDA reference defaults: epsilon=1, Kmax=40,
    // dmin=1.25*sr, rho=0.025. These are only used when
    // deconvAlgorithm === 'sparseda'; the matching-pursuit path continues to
    // use the MP-specific maxIter/convTol/minImpulseGapSec knobs above.
    sparsedaKmax: 40,
    sparsedaEpsilon: 1.0,
    sparsedaDminSec: 1.25,
    sparsedaRho: 0.025,
    deconvAlgorithm: 'sparseda' // 'sparseda' | 'matching_pursuit' | 'cvxeda'
  },

  // ── cvxEDA Convex Optimization Decomposition (Greco, Citi et al., 2016) ─
  // Faithful port of the reference cvxEDA.py `qp` path: the identical QP
  // (½‖Mq+Cd+Bl−y‖² + α·1ᵀAq + ½γ‖l‖²  s.t. Aq ≥ 0) solved by the same
  // algorithm CVXOPT uses — a Mehrotra predictor-corrector primal-dual
  // interior-point method — with a direct banded/Schur factor for each
  // Newton step's KKT system.
  CVXEDA: {
    tauSlow: 2.0,       // Bateman slow decay τ (s) — reference default tau0
    tauFast: 0.7,       // Bateman fast rise τ (s) — reference default tau1 (Greco et al. 2016 / NeuroKit)
    deltaKnotSec: 10.0, // Tonic cubic B-spline knot spacing (s)
    // L1 weight on the driver. The paper quotes α ≈ 8e-4 at 25 Hz; BioMapping
    // samples at 10 Hz, where the same inter-event sparsity needs a
    // proportionally stronger penalty (≈ 8e-4 · 25/10). Raise it to merge
    // fewer ripples, lower it to keep more small SCRs.
    alpha: 2e-3,
    gamma: 1e-2,        // L2 weight on tonic spline smoothness
    maxIter: 50,        // Newton iteration cap. Real tracks converge in ~10-25;
                        // this is headroom, not a tuning knob.
    tol: 1e-10,         // Duality-gap (μ) convergence threshold, analogous to
                        // CVXOPT's reltol.
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
  // Hard ceiling for a single SCR amplitude, used by the prominence detector's
  // artefact guard (see _prominenceNMS). Real SCRs in even the most
  // reactive subjects rarely exceed ~5 µS; 20 µS is 4× that and gives
  // comfortable headroom for unusual recordings without admitting sensor
  // artefacts. Electrode disconnects, motion artefacts and ADC rail-hits
  // routinely produce spikes of hundreds of µS — the prominence detector is
  // uniquely vulnerable to these because it identifies peaks by local shape
  // (prominence), not absolute level, so a physically massive spike is simply
  // a very prominent peak. The trough-to-peak detector avoids the problem
  // because the LPF and peakThreshold clip spikes before detection; prominence
  // has no such implicit ceiling and requires this explicit hard cap.
  MICROSIEMENS_MAX_SCR: 20,

  // ── Peak detection ──────────────────────────────────────────────────────
  // Minimum gap between accepted peaks (seconds) — an SCR refractory period.
  // Boucsein (2012) puts the minimum resolvable inter-SCR interval at ~1–2 s;
  // 1.3 sits at the recall-leaning end of that while still suppressing the
  // tail-ripple clustering that a looser 1.0 s lets through on busy tracks
  // once the amplitude/SNR/quality gates are relaxed (median inter-peak
  // interval drops well below 2 s there — not physiologically distinct
  // bursts). Lower it further for maximum sensitivity; raise it for a
  // stricter NS-SCR census.
  PEAK_MIN_GAP: 1.3,
  PEAK_RECOVERY_BREAK: 0.1,   // Break threshold for recovery search
  // Prominence detector (_prominenceNMS, GSR_DEFAULT.usePeakProminence): trailing
  // window (s) over which the phasic minimum is taken for the artefact-ceiling
  // baseline-amplitude check. Long enough to see under a stacked burst of SCRs
  // to the pre-burst level, short enough not to reach back to an unrelated
  // earlier trough.
  PEAK_PROMINENCE_BASELINE_SEC: 8,

  // ── Peak shape constants ─────────────────────────────────────────────────
  // The rise/half-recovery/skew *rejection bounds* that the retired greedy
  // detector applied were removed (2026-09-09) — the shape-audit found they
  // preferentially dropped the compound-burst and rising-edge SCRs the
  // default full-scan detector exists to recover, and the skew ratio was
  // miscalibrated for LPF'd ambulatory data. What remains is used by the live
  // detectors: MAX_RISE_TIME bounds the onset walk-back in full-scan /
  // prominence / the deconvolution curve scan; MIN_SNR is the Min SNR
  // fallback; QUALITY_WEIGHTS feed the composite quality score
  // (_computePeakQuality), whose own ideal-range breakpoints are inline
  // literals, not these constants.
  PEAK_SHAPE: {
    MAX_RISE_TIME: 5.0,          // Max onset→peak (s) — onset walk-back search bound
    MIN_SNR: 1.5,               // Min signal-to-noise ratio fallback — matches GSR_DEFAULT.shapeMinSnr
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
  // 'peakDensity' (NS-SCR rate) round out the set. 'phasicDriver' is
  // detector-dependent (deconvolution / cvxEDA only). (EM Fog is not offered as
  // a graph view — the map/globe still colour by it.)
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
      // Base label; ' (ISCR)' is appended at render time when the series
      // integrated the deconvolved driver (analyzer.phasicAUCIsISCR).
      label: 'Phasic AUC', unit: 'μS·s', decimals: 3,
      colorVar: '--color-phasic-auc', colorDefault: '#0099aa',
      showPeakOverlay: false, allowNegative: false
    },
    // The sparse sudomotor driver (analyzer.phasicDriver) — the burst signal
    // the deconvolution / cvxEDA models recover *before* the SCRF shape smears
    // each impulse into a response, and the series computePhasicAUC integrates
    // to produce Phasic AUC (ISCR). Only populated while a deconvolution or
    // cvxEDA detector is active; GSRUI.syncGraphViewDetectorOptions() disables
    // the dropdown option (and falls back to 'signal') in the other modes, so
    // the plot never has to handle an empty series here. Peaks are marked as
    // dots on the curve at their own time (showPeakOverlay:false) — each dot is
    // one SCR's originating impulse.
    //
    // unit/decimals below are the matching-pursuit default (µS — matching-
    // pursuit amplitude-matches its atoms directly to the phasic curve, so its
    // driver really is µS, sample-rate-independent) and are a fallback only.
    // The two detectors' drivers are NOT the same physical quantity — see
    // DRIVER_UNIT_BY_ALGORITHM below — so the renderer picks the display unit
    // from analyzer._driverAlgorithm at draw time rather than trusting this
    // static value blindly.
    phasicDriver: {
      label: 'Sudomotor Driver (ISCR)', unit: 'μS', decimals: 4,
      colorVar: '--color-phasic-driver', colorDefault: '#c2410c',
      showPeakOverlay: false, allowNegative: false
    },
    arousalIndex: {
      label: 'Combined Arousal Index', unit: 'z', decimals: 2,
      colorVar: '--color-arousal-index', colorDefault: '#7b00cc',
      showPeakOverlay: false, allowNegative: true
    },
    triIndex: {
      label: 'Tri Index', unit: 'z', decimals: 2,
      colorVar: '--color-tri-index', colorDefault: '#6366f1',
      showPeakOverlay: false, allowNegative: true
    }
  },

  // Display unit for the 'phasicDriver' graph view, keyed by
  // analyzer._driverAlgorithm — the two detectors' "driver" arrays are not
  // the same physical quantity, so one shared label would misrepresent one
  // of them. Matching pursuit fits atoms whose peak height is amplitude-
  // matched directly to the phasic curve, so its driver is µS and sample-
  // rate-independent, same convention as Phasic.
  //
  // cvxEDA's driver is p = A·q — the coefficient of the discretised Bateman
  // ARMA's A operator (cvxeda.js), whose bilinear-transform coefficients
  // carry a built-in ~1/Δt gain (Δt = 1/sampleRate) that the phasic-
  // producing M operator doesn't. Confirmed empirically: resampling the same
  // event at 5/10/20 Hz scales the driver peak almost exactly linearly with
  // sample rate (driver/sampleRate stays ~constant), which is what a
  // discretised *rate* does, not an amplitude — the same normalisation
  // computePhasicAUC() already applies (runningSum / sampleRate) to turn it
  // into µS·s. So µS/s is the honest unit, not µS; grid steps sized ~25x
  // matching-pursuit's (the empirical gain for this app's fixed SR=10Hz /
  // τ_fast=0.7 / τ_slow=2.0 — see docs/eda_decomposition_analysis.md).
  DRIVER_UNIT_BY_ALGORITHM: {
    sparseda: {
      unit: 'μS', decimals: 4,
      gridSteps: [[0.05, 0.005], [0.15, 0.01], [0.5, 0.05], [1.5, 0.1]], gridDefaultStep: 0.5
    },
    matching_pursuit: {
      unit: 'μS', decimals: 4,
      gridSteps: [[0.05, 0.005], [0.15, 0.01], [0.5, 0.05], [1.5, 0.1]], gridDefaultStep: 0.5
    },
    cvxeda: {
      unit: 'μS/s', decimals: 2,
      gridSteps: [[1, 0.1], [4, 0.5], [12, 1], [40, 5]], gridDefaultStep: 10
    }
  },

  // ── Composite Arousal Indices defaults ──────────────────────────────────
  AROUSAL_INDEX: {
    wTonic: 0.3,
    wPhasic: 0.7,
    windowAucSec: 30
  },

  TRI_INDEX: {
    wTonic: 0.10,
    wPhasic: 0.45,
    wDensity: 0.45,
    windowAucSec: 30,
    windowDensitySec: 60
  },

  // ── Topography source definitions ───────────────────────────────────────
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

  // ── Continuous temporal peak-density Gaussian KDE ────────────────────────
  // Evaluates continuous Non-Specific SCR frequency (peaks/minute) along the
  // timeline via 1D Gaussian Kernel Density Estimation (KDE). The kernel
  // bandwidth sigma is scaled directly from the nominal spotlight window width:
  // sigma = windowSizeSec * sigmaRatio (e.g. 10s * 0.25 = 2.5s).
  TEMPORAL_PEAK_DENSITY: {
    windowSizeSec: 10,       // Spotlight window width in seconds (fixed; no longer slider-adjustable)
    sigmaRatio: 0.25,        // Bandwidth ratio (sigma = W * 0.25, encompassing 95.4% of mass in ±W/2)
    cutoffMultiplier: 3.5,   // Bounding window in units of sigma (±3.5*sigma captures >99.95% of kernel mass)
    scaleToPerMinute: 60.0   // Multiplier to express density in standard peaks/minute
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

  // ── Arousal Places ──────────────────────────────────────────────────────
  // The map's discrete, clickable "where did responses concentrate" layer
  // (arousal_places.js buildPlaces + map_manager_arousal_places.js _renderArousalPlaces).
  // A place is a proximity cluster of arousal peaks, scored by dwell-normalised
  // phasic-response energy so "lots of peaks because the walker dawdled here"
  // doesn't outrank a genuinely arousing spot. mergeM is the single UI slider
  // (#placeMergeDistance); everything else is derived or fixed.
  AROUSAL_PLACES: {
    mergeM: 35,               // default grouping radius in metres (compactClusters leader radius)
    minMergeM: 10,            // slider bounds
    maxMergeM: 120,
    seedSeparationFactor: 1.8,// compactClusters: two place centres must be >= this * mergeM apart;
                             // peaks in the mergeM..(this*mergeM) ring are absorbed by the nearest
                             // existing place rather than seeding an overlapping neighbour
    drawGapFactor: 0.46,     // _renderArousalPlaces: a place's drawn outline is capped at this *
                             // (distance to its nearest neighbour), so two footprints can kiss
                             // but never overlap (belt-and-braces on top of seedSeparationFactor)
    footprintPadM: 10,        // per-member-peak dwell footprint radius = mergeM/2 + this
    dwellFloorS: 5,           // floor on dwell seconds so a near-zero dwell can't blow up the rate
    provisionalMaxTracks: 1,  // collective: a place with <= this many contributing walks renders faint/dashed
    minMembers: 3,            // drop single-walk clusters smaller than this (kept if >=2 walks agree)
    maxPlaces: 20             // cap the map to the top-N places by rate
  },

  // ── Overlap-aware path colour ─────────────────────────────────────────
  // Where a walk retraces itself AND the two drawn strokes visually merge at
  // the current zoom, _renderPathSegments colours that spot by the mean of the
  // active metric across every nearby point instead of last-visit-wins. The
  // "same spot" radius is the stroke's on-screen width converted to metres, so
  // it scales with both the track-width slider and the zoom level.
  // See docs/dwell_time_spec.md.
  PATH_OVERLAP: {
    widthFactor: 1.0,   // overlap radius = trackWeight(px) * metresPerPixel * this
    maxRadiusM: 60,     // safety cap when zoomed right out (huge radii get slow + meaningless)
    revisitGapS: 15     // nearby points more than this far apart in time = a distinct visit
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
    // every cell renders as-is regardless of foot traffic (old behaviour). 1 = only the
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
  // normalised to [0, 1] and re-scaled by `exaggeration` (in grid-cell
  // widths) before shading, rather than using real-world cell spacing —
  // that keeps the relief's visual intensity consistent across tracks
  // regardless of grid resolution or the metric's raw unit scale.
  HILLSHADE: {
    azimuthDeg: 315,   // simulated sun direction, true compass bearing (0=N, 90=E, 180=S, 270=W); 315 = NW (top-left on a north-up map), casting shadow toward SE (bottom-right)
    altitudeDeg: 35,   // sun elevation above the horizon — lower angle = longer, more dramatic shadows
    exaggeration: 6.0, // full 0..1 normalised value range mapped to this many grid-cell widths of "height"
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
    HOTSPOT_PERCENTILE: 0.02,  // Count target: top X% of active (non-excluded) peaks
    // Minimum great-circle spacing (m) between two hotspots. Walking the
    // amplitude-ranked peak list, a candidate within this distance of an
    // already-selected hotspot is skipped — the biggest response in any
    // neighbourhood wins its spot, smaller ones nearby are dropped rather
    // than stacked into the same map pixel. ~30 m ≈ a building width at urban
    // walking scale. A spatially compact recording can therefore end up with
    // fewer hotspots than the percentile target — intended. 0 disables spacing.
    MIN_SEPARATION_M: 30
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

  // The 10 OSM enrichment fields (osm_enrichment.js) and their UI metric key
  // — single source of truth for key<->field<->label, shared by map.js's
  // "Map Metric" dropdown/legend and ui.js's correlation dashboard.
  //   kind: 'categorical' (roadClass)  — legend swatches; not correlatable.
  //   kind: 'binary'      (inPark)     — 0/1; correlated as point-biserial r.
  //   kind: 'continuous'               — correlated and plottable.
  //   unit                             — appended in parens on scatter axes only.
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

  // Satellite remote-sensing vegetation metrics (NDVISampler)
  SATELLITE_METRICS: [
    { key: 'ndvi_50m', field: 'ndvi_50m', label: 'NDVI (50m Buffer)', kind: 'continuous', unit: 'index' },
    { key: 'ndvi',     field: 'ndvi',     label: 'Point NDVI',        kind: 'continuous', unit: 'index' }
  ]
};
