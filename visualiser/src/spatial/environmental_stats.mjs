// Copyright (c) 2026 Christian Nold
// Licensed under the Bio Mapping Community Licence 1.0.
// See LICENCE.md in the project root for terms.

/**
 * EnvironmentalStats — the maths behind the Environmental Analysis
 * dashboard: ~1 Hz samples pairing arousal with the environment where it was
 * caused (each walk's Response delay back along the route, see
 * signal/response_delay.mjs), the correlation matrix, and the per-road-class
 * profile.
 *
 * Pure module: no DOM. The dashboard (ui/ui_environmental_dashboard.mjs)
 * decides which walks go in, caches the result and draws it.
 */
import { GSR_CONST } from '../core/constants.mjs';
import { StatsMath } from '../signal/stats_math.mjs';

const KNOTS_TO_MS = 0.514444;
const PEAK_BIN_S = 15;
// Graded verdicts for 2+ walks: >= META_SOLID walks where the factor varies
// → 'meta'; 3..META_SOLID-1 → 'metaProvisional'; fewer → 'fewWalks'.
const META_SOLID = 5;

const isNum = (v) => typeof v === 'number' && !isNaN(v);
// Row times carry float noise (6.9 − 1 = 5.8999999999999995); a row within
// this of a window's start is outside it.
const EPS_S = 1e-6;
/**
 * First row of the one second ending at row `end` (rows with time in
 * (t − 1, t]), so "the last second" is one second at any sample rate.
 */
const secondStart = (raw, end) => {
  const from = raw[end].time - 1 + EPS_S;
  let s = end;
  while (s > 0 && raw[s - 1].time > from) s--;
  return s;
};
// Peaks counted by the dashboard: not excluded, and paired with a place that
// has a position — the same rule buildSamples() applies to its samples, so
// peak counts and the time they are divided by cover the same stretch of walk.
const countedPeaks = (a) =>
  a.peaks.filter((p) => !p.excluded && a.placeRowOf(p.index) >= 0);
const numOrNaN = (v) => (typeof v === 'number' ? v : NaN);
// 999.0 is the "no feature within radius" sentinel — not a distance.
const validNum = (v) =>
  v !== null && v !== undefined && !isNaN(v) && v !== 999.0;
const coerceBin = (v) =>
  v === true || v === 1 ? 1 : v === false || v === 0 ? 0 : NaN;

/**
 * The environment read at one sample. NDVI and EM Fog are NaN when the row
 * has no reading; they are dropped per feature later.
 */
function envFields(pt) {
  return {
    osm_road_class: pt.osm_road_class,
    osm_dist_major_road: pt.osm_dist_major_road,
    osm_in_park: pt.osm_in_park,
    osm_green_pct_50m: pt.osm_green_pct_50m,
    osm_dist_green: pt.osm_dist_green,
    osm_canopy_pct_50m: pt.osm_canopy_pct_50m,
    osm_building_density_50m: pt.osm_building_density_50m,
    osm_dist_water: pt.osm_dist_water,
    osm_tree_density_50m: pt.osm_tree_density_50m,
    osm_amenity_count_50m: pt.osm_amenity_count_50m,
    ndvi: numOrNaN(pt.ndvi),
    ndvi_50m: numOrNaN(pt.ndvi_50m),
    // EM Fog Index (0-100): place data, paired like the OSM fields.
    em_fog: numOrNaN(pt.em_fog),
  };
}

/** Turn a StatsMath.metaCorrelation result into a graded verdict. */
function gradeMeta(meta) {
  if (meta.k < 3)
    return { r: meta.r, p: NaN, method: 'fewWalks', k: meta.k, i2: NaN };
  return {
    r: meta.r,
    p: meta.p,
    method: meta.k < META_SOLID ? 'metaProvisional' : 'meta',
    k: meta.k,
    i2: meta.i2,
  };
}

export const EnvironmentalStats = {
  /**
   * Everything the dashboard shows, for these walks.
   * @param {Array<object>} activeTracks - enriched tracks ({ id, analyzer }).
   * @returns {{ allData, correlationMatrix, roadProfile, roadComparison }}
   */
  compute(activeTracks) {
    const S = EnvironmentalStats;
    const allData = S.buildSamples(activeTracks);
    const peakCounts = S.peakCountsPerSample(activeTracks, allData);
    const correlationMatrix = S.correlationMatrix(
      allData,
      S.correlationFeatures(allData),
      peakCounts,
    );
    const roadProfile = S.roadProfile(allData, activeTracks);
    const roadComparison = S.compareRoadExtremes(roadProfile);
    for (const p of roadProfile) delete p._sePhasic; // internal, not cached
    return { allData, correlationMatrix, roadProfile, roadComparison };
  },

  /**
   * One sample per ~1 s of each walk: arousal over the trailing second,
   * paired with the place data (environment and walking speed) where it was
   * caused — the walk's Response delay back along the route (placeRowOf).
   * Tonic, phasic and peaks all use that same pairing.
   */
  buildSamples(activeTracks) {
    const allData = [];
    activeTracks.forEach((track) => {
      const a = track.analyzer;
      if (!a?.isEnriched || a.raw.length === 0) return;

      // GSR sensor disconnects (see gsr_disconnect_repair.mjs) are detected
      // unconditionally regardless of the "Repair Sensor Disconnects"
      // toggle. A disconnected sample — pinned at the open-circuit floor,
      // or a straight-line interpolation bridging one — is not a real
      // measurement, so it must not feed a genuine environmental
      // correlation. GPS/speed are unaffected: the location is still real
      // even when the GSR sensor wasn't reading anything meaningful.
      const disconnectSpans = a.gsrDisconnectSpans || [];
      const isDisconnected = (j) =>
        disconnectSpans.some((s) => j >= s.startIdx && j <= s.endIdx);

      let lastTime = -999;
      for (let i = 0; i < a.raw.length; i++) {
        const pt = a.raw[i];
        // Sample at ~1 Hz (keeps the point set manageable)
        if (!(pt.time - lastTime >= 1.0)) continue;
        lastTime = pt.time; // keep the ~1Hz cadence even if this sample ends up excluded below
        // Where this reading was caused; no place, no sample.
        const place = a.placeRowOf(i);
        if (place < 0) continue;
        const envPt = a.raw[place];

        // Walking speed is place data too: the mean over the last second
        // at the place.
        let sumSpeed = 0;
        let speedCount = 0;
        for (let j = secondStart(a.raw, place); j <= place; j++) {
          if (!a.onTime(j)) continue; // a device hold-up: its time is wrong
          const rawSpd = a.raw[j].speedKts;
          if (isNum(rawSpd)) {
            sumSpeed += rawSpd * KNOTS_TO_MS;
            speedCount++;
          }
        }

        // Aggregate arousal over the last second: mean for level, max for
        // the phasic peak.
        const windowStartIdx = secondStart(a.raw, i);
        let sumVal = 0;
        let sumTonic = 0;
        let maxPhasic = 0;
        let count = 0;
        for (let j = windowStartIdx; j <= i; j++) {
          if (!a.raw[j]) continue;
          if (isDisconnected(j)) continue; // no real GSR reading at this sample
          if (!a.onTime(j)) continue; // a device hold-up: its time is wrong
          sumVal += a.raw[j].val || 0;
          if (a.tonic?.[j]) {
            sumTonic += a.tonic[j].val || 0;
          }
          if (a.phasic?.[j]) {
            maxPhasic = Math.max(maxPhasic, a.phasic[j].val || 0);
          }
          count++;
        }
        // The whole trailing window was disconnected — there is no real GSR
        // reading to correlate against this location at all (falling back
        // to pt.val would just be the floor/interpolated value again), so
        // skip the point entirely rather than fake one.
        if (count === 0) continue;

        const avgSpeed = speedCount > 0 ? sumSpeed / speedCount : 0;
        allData.push({
          trackId: track.id,
          time: pt.time,
          val: sumVal / count,
          phasic: a.phasic ? maxPhasic : 0,
          tonic: a.tonic ? sumTonic / count : 0,
          speed: avgSpeed,
          // The tonic channel's speed adjustment uses the speed at the place
          // itself rather than the 1 s mean.
          tonicSpeed: isNum(envPt.speedKts)
            ? envPt.speedKts * KNOTS_TO_MS
            : avgSpeed,
          ...envFields(envPt),
        });
      }
    });
    return allData;
  },

  /**
   * Correlation features: continuous OSM fields + binary "in park"
   * (point-biserial r is Pearson on a 0/1 variable). Road Class is
   * multi-level categorical and stays out. NDVI and EM Fog (from Sub-GHz
   * RSSI, not Overpass, so not in OSM_METRICS) are added only when some
   * sample carries a reading.
   */
  correlationFeatures(allData) {
    const features = GSR_CONST.OSM_METRICS.filter(
      (m) => m.kind === 'continuous' || m.kind === 'binary',
    ).map((m) => ({
      name: m.label,
      key: m.field,
      binary: m.kind === 'binary',
    }));
    if (allData.some((d) => !isNaN(d.ndvi_50m))) {
      features.push({
        name: 'NDVI (50m Buffer)',
        key: 'ndvi_50m',
        binary: false,
      });
    }
    if (allData.some((d) => !isNaN(d.ndvi))) {
      features.push({ name: 'Point NDVI', key: 'ndvi', binary: false });
    }
    if (allData.some((d) => !isNaN(d.em_fog))) {
      features.push({ name: 'EM Fog Index', key: 'em_fog', binary: false });
    }
    return features;
  },

  /**
   * Peak count per sample = number of counted peaks (see countedPeaks) in
   * its 15 s bin, index-aligned with allData. The Peaks channel doesn't correlate this
   * per-1-Hz-sample (that duplicates each count ~15×); each walk's Peaks
   * series is re-aggregated to one point per bin in correlationMatrix().
   */
  peakCountsPerSample(activeTracks, allData) {
    const peakCounts = [];
    activeTracks.forEach((track) => {
      const peakBinMap = new Map();
      countedPeaks(track.analyzer).forEach((p) => {
        const bin = Math.floor(p.time / PEAK_BIN_S);
        peakBinMap.set(bin, (peakBinMap.get(bin) || 0) + 1);
      });
      allData.forEach((d) => {
        if (d.trackId === track.id) {
          peakCounts.push(peakBinMap.get(Math.floor(d.time / PEAK_BIN_S)) || 0);
        }
      });
    });
    return peakCounts;
  },

  /**
   * One row per feature: r / p / method for the phasic, tonic, peaks and
   * speed-adjusted tonic channels, whether the factor varied at all, and
   * Benjamini–Hochberg q-values per channel.
   */
  correlationMatrix(allData, features, peakCounts) {
    const matrix = features.map((f) =>
      EnvironmentalStats._featureRow(f, allData, peakCounts),
    );

    // Multiple comparisons: Benjamini–Hochberg FDR, one family PER arousal
    // channel (phasic, tonic, peaks). Phasic / tonic / peaks are three
    // correlated views of the same arousal, not three independent
    // discoveries, so pooling them into one 3×features family both
    // over-counts the tests and mixes hypotheses. Within a channel the
    // family is "which environmental factors relate to THIS measure" — the
    // features are the real multiple comparisons. Only cells carrying a
    // significance verdict ('meta'/'single') and real variation enter;
    // effect-size-only cells ('metaProvisional', 'fewWalks') get no q.
    const testable = (row, m) =>
      row.hasVariance && (m === 'meta' || m === 'single');
    const adjustChannel = (mKey, pKey, qKey) => {
      const q = StatsMath.benjaminiHochberg(
        matrix.map((row) => (testable(row, row[mKey]) ? row[pKey] : NaN)),
      );
      matrix.forEach((row, i) => {
        row[qKey] = q[i];
      });
    };
    adjustChannel('mPhasic', 'pPhasic', 'qPhasic');
    adjustChannel('mTonic', 'pTonic', 'qTonic');
    adjustChannel('mPeaks', 'pPeaks', 'qPeaks');
    return matrix;
  },

  /**
   * Valid samples for one feature, bucketed per walk (allData is
   * track-contiguous; a track is an independent recording):
   *  - xPhasic / phasic : environment vs momentary arousal
   *  - xTonic  / tonic  : environment vs baseline arousal
   *  - peakBinX / peakBinY : one point per 15 s bin (mean feature vs peak
   *    count) — no per-second duplication of the binned count
   * validX is every walk's environment values pooled, for the variance check.
   * @private
   */
  _walkSeries(f, allData, peakCounts) {
    const byTrack = new Map();
    const validX = [];
    for (let i = 0; i < allData.length; i++) {
      const row = allData[i];
      let b = byTrack.get(row.trackId);
      if (!b) {
        b = {
          xPhasic: [],
          phasic: [],
          xTonic: [],
          tonic: [],
          speedTonic: [],
          binX: new Map(),
          binPk: new Map(),
        };
        byTrack.set(row.trackId, b);
      }
      const xP = f.binary ? coerceBin(row[f.key]) : row[f.key];

      if (validNum(xP)) {
        b.xPhasic.push(xP);
        b.phasic.push(row.phasic);
        validX.push(xP);
        const bin = Math.floor(row.time / PEAK_BIN_S);
        let bx = b.binX.get(bin);
        if (!bx) {
          bx = [];
          b.binX.set(bin, bx);
        }
        bx.push(xP);
        b.binPk.set(bin, peakCounts[i] || 0);
        b.xTonic.push(xP);
        b.tonic.push(row.tonic);
        b.speedTonic.push(isNum(row.tonicSpeed) ? row.tonicSpeed : row.speed);
      }
    }
    const walks = [...byTrack.values()];
    // Collapse each walk's binned Peaks data to one (mean x, count) pair
    // per 15 s bin.
    for (const b of walks) {
      b.peakBinX = [];
      b.peakBinY = [];
      for (const [bin, xs] of b.binX) {
        let s = 0;
        for (const v of xs) s += v;
        b.peakBinX.push(s / xs.length);
        b.peakBinY.push(b.binPk.get(bin) || 0);
      }
    }
    return { walks, validX };
  },

  /**
   * One method for the whole matrix, by walk count:
   *  - 1 walk  → pooled r + autocorrelation-adjusted p ('single').
   *  - 2+ walks → random-effects meta-analysis across walks
   *    (inverse-variance per-walk r via effective N, DerSimonian–Laird
   *    heterogeneity, Knapp–Hartung t), graded by gradeMeta().
   * @private
   */
  _featureRow(f, allData, peakCounts) {
    const { walks, validX } = EnvironmentalStats._walkSeries(
      f,
      allData,
      peakCounts,
    );
    const analyse = (getX, getY) => {
      if (walks.length === 1) {
        const c = StatsMath.calculateAutocorrCorrelation(
          getX(walks[0]),
          getY(walks[0]),
        );
        return { r: c.r, p: c.p, method: 'single', k: 1, i2: NaN };
      }
      return gradeMeta(
        StatsMath.metaCorrelation(
          walks.map((w) => ({ x: getX(w), y: getY(w) })),
        ),
      );
    };
    const chPhasic = analyse(
      (w) => w.xPhasic,
      (w) => w.phasic,
    );
    const chTonic = analyse(
      (w) => w.xTonic,
      (w) => w.tonic,
    );
    const chPeaks = analyse(
      (w) => w.peakBinX,
      (w) => w.peakBinY,
    );

    // Speed-adjusted partial correlation for the tonic channel
    let chTonicSpeed;
    if (walks.length === 1) {
      const w = walks[0];
      const pc = StatsMath.partialCorrelation(w.xTonic, w.tonic, w.speedTonic);
      chTonicSpeed = { r: pc.r, p: pc.p, method: 'single' };
    } else {
      chTonicSpeed = gradeMeta(
        StatsMath.metaCorrelation(
          walks.map(EnvironmentalStats._speedResiduals),
        ),
      );
    }

    // hasVariance = the factor actually changed. A constant predictor
    // explains no variance in arousal whatever its r. Continuous fields
    // need a coefficient of variation ≥ 1%.
    const sx = StatsMath.calculateStats(validX);
    const trueStd = Math.sqrt(sx.variance);
    const cv = trueStd / (Math.abs(sx.mean) + 1e-9);
    const hasVariance = f.binary
      ? new Set(validX).size > 1
      : validX.length > 2 && trueStd > 0 && cv >= 0.01;

    return {
      name: f.name,
      key: f.key,
      n: validX.length,
      featureWalks: walks.length,
      hasVariance,
      rPhasic: chPhasic.r,
      rTonic: chTonic.r,
      rPeaks: chPeaks.r,
      rTonicSpeedAdj: chTonicSpeed.r,
      pTonicSpeedAdj: chTonicSpeed.p,
      mTonicSpeedAdj: chTonicSpeed.method,
      pPhasic: chPhasic.p,
      pTonic: chTonic.p,
      pPeaks: chPeaks.p,
      mPhasic: chPhasic.method,
      mTonic: chTonic.method,
      mPeaks: chPeaks.method,
      kPhasic: chPhasic.k,
      kTonic: chTonic.k,
      kPeaks: chPeaks.k,
      i2Phasic: chPhasic.i2,
      i2Tonic: chTonic.i2,
      i2Peaks: chPeaks.i2,
    };
  },

  /**
   * One walk's tonic series with walking speed regressed out of both the
   * feature and the arousal (for the meta-analysed partial correlation).
   * A walk whose speed never changed is passed through unadjusted.
   * @private
   */
  _speedResiduals(w) {
    if (!(StatsMath.calculateStats(w.speedTonic).variance > 1e-12)) {
      return { x: w.xTonic, y: w.tonic };
    }
    const regX = StatsMath.calculateLinearRegression(w.speedTonic, w.xTonic);
    const regY = StatsMath.calculateLinearRegression(w.speedTonic, w.tonic);
    return {
      x: w.xTonic.map((v, i) => v - (regX.m * w.speedTonic[i] + regX.c)),
      y: w.tonic.map((v, i) => v - (regY.m * w.speedTonic[i] + regY.c)),
      nCovariates: 1,
    };
  },

  /**
   * Per-road-class arousal: mean, std, autocorrelation-adjusted 95% CI,
   * peak rate, sorted by mean phasic (highest first). 'unclassified' (OSM's
   * mixed-bag minor-road tag) and any class with under 5 s of data are
   * dropped. Each entry keeps `_sePhasic` for compareRoadExtremes().
   */
  roadProfile(allData, activeTracks) {
    const roadGroups = EnvironmentalStats._roadGroups(allData);

    activeTracks.forEach((track) => {
      const a = track.analyzer;
      countedPeaks(a).forEach((p) => {
        const rc = a.raw[a.placeRowOf(p.index)].osm_road_class || 'none';
        if (roadGroups.has(rc)) {
          roadGroups.get(rc).peaks++;
        }
      });
    });

    const ROAD_SKIP = new Set(['unclassified']);
    const roadProfile = [];
    roadGroups.forEach((val, key) => {
      if (ROAD_SKIP.has(key)) return;
      if (val.phasicVals.length < 5) return;
      roadProfile.push(EnvironmentalStats._roadClassStats(key, val));
    });
    roadProfile.sort((a, b) => b.meanPhasic - a.meanPhasic);
    return roadProfile;
  },

  /**
   * Group samples by road class, with per-walk sub-arrays: the CI's
   * effective sample size must be estimated *within* each walk and summed,
   * never off the walks stitched end to end (that autocorrelation runs
   * across recording boundaries and is meaningless).
   * @private
   */
  _roadGroups(allData) {
    const roadGroups = new Map();
    const walkOf = (g, trackId) => {
      let w = g.byWalk.get(trackId);
      if (!w) {
        w = { phasicVals: [], tonicVals: [] };
        g.byWalk.set(trackId, w);
      }
      return w;
    };
    // Phasic and tonic arousal, keyed by the road class of the place each
    // sample is paired with.
    allData.forEach((d) => {
      const cls = d.osm_road_class || 'none';
      let g = roadGroups.get(cls);
      if (!g) {
        g = { phasicVals: [], tonicVals: [], byWalk: new Map(), peaks: 0 };
        roadGroups.set(cls, g);
      }
      const w = walkOf(g, d.trackId);
      g.phasicVals.push(d.phasic);
      w.phasicVals.push(d.phasic);
      g.tonicVals.push(d.tonic);
      w.tonicVals.push(d.tonic);
    });
    return roadGroups;
  },

  /** @private */
  _roadClassStats(key, val) {
    const n = val.phasicVals.length;
    const nT = val.tonicVals.length;
    const meanPhasic = val.phasicVals.reduce((s, v) => s + v, 0) / n;
    const meanTonic =
      nT > 0 ? val.tonicVals.reduce((s, v) => s + v, 0) / nT : 0;
    // Sample SD (n − 1): it feeds a standard error, and dividing by n
    // narrows the interval on thinly-sampled road classes.
    const stdPhasic = Math.sqrt(
      val.phasicVals.reduce((s, v) => s + (v - meanPhasic) ** 2, 0) / (n - 1),
    );
    const stdTonic =
      nT > 1
        ? Math.sqrt(
            val.tonicVals.reduce((s, v) => s + (v - meanTonic) ** 2, 0) /
              (nT - 1),
          )
        : 0;
    // CI uses the effective sample size, not the raw second count:
    // consecutive 1 Hz EDA samples are correlated, so sqrt(n) overstates
    // precision. Effective N is summed over per-walk estimates so the
    // autocorrelation is measured within a recording, not across the join.
    const walkArrs = [...val.byWalk.values()];
    const nEffPhasic = walkArrs.reduce(
      (s, w) => s + StatsMath.effectiveSampleSize(w.phasicVals),
      0,
    );
    const nEffTonic = walkArrs.reduce(
      (s, w) => s + StatsMath.effectiveSampleSize(w.tonicVals),
      0,
    );
    // Standard error with the walk as the independent unit. Within a
    // walk, serial correlation is handled by the effective N; across
    // walks, each walk has its own baseline, so samples from different
    // walks are not exchangeable. With 2+ walks contributing, use the
    // larger of the within-walk SE and the between-walk SE of the walk
    // means (the latter on k-1 df) — the same "can only widen" rule as
    // the modified Knapp–Hartung SE in StatsMath.metaCorrelation.
    const MIN_WALK_SAMPLES = 5;
    const seOf = (std, nEff, arrKey) => {
      const within = {
        se: nEff > 1 ? std / Math.sqrt(nEff) : 0,
        df: Math.max(1, nEff - 1),
      };
      const means = walkArrs
        .map((w) => w[arrKey])
        .filter((a) => a.length >= MIN_WALK_SAMPLES)
        .map((a) => a.reduce((s, v) => s + v, 0) / a.length);
      const k = means.length;
      if (k < 2) return within;
      const m = means.reduce((s, v) => s + v, 0) / k;
      const sdB = Math.sqrt(
        means.reduce((s, v) => s + (v - m) ** 2, 0) / (k - 1),
      );
      const between = { se: sdB / Math.sqrt(k), df: k - 1 };
      return between.se > within.se ? between : within;
    };
    const sePhasic = seOf(stdPhasic, nEffPhasic, 'phasicVals');
    const seTonic = seOf(stdTonic, nEffTonic, 'tonicVals');
    // t rather than z: a briefly-walked road class has only a handful of
    // effective samples (or walks), where 1.96 would understate the interval.
    const ci95 = ({ se, df }) => (se > 0 ? StatsMath.tCritical(df) * se : 0);
    return {
      name: key,
      timeSpent: n,
      effSamples: Math.round(nEffPhasic),
      meanPhasic,
      meanTonic,
      stdPhasic,
      stdTonic,
      ciPhasic: ci95(sePhasic),
      ciTonic: ci95(seTonic),
      peakRate: val.peaks / (n / 60),
      _sePhasic: sePhasic,
    };
  },

  /**
   * Highest vs lowest road class: a Welch t-test on each class's walk-aware
   * standard error (a CI-overlap check is not a valid significance test) —
   * within-walk effective N, or the between-walk SE when walks disagree
   * more than that. hi and lo are the extremes of `roadProfile.length`
   * group means, picked *after* seeing the data — testing that gap as if it
   * were pre-specified inflates the false-positive rate, so Bonferroni-adjust
   * the p by the number of pairwise contrasts that could have been the
   * widest (k choose 2). Null with fewer than two classes.
   */
  compareRoadExtremes(roadProfile) {
    if (roadProfile.length < 2) return null;
    const hi = roadProfile[0];
    const lo = roadProfile[roadProfile.length - 1];
    // Welch t on the same walk-aware SEs as the CIs, Welch–Satterthwaite df.
    const a = hi._sePhasic;
    const b = lo._sePhasic;
    const va = a.se ** 2;
    const vb = b.se ** 2;
    const se = Math.sqrt(va + vb);
    const t = se > 0 ? (hi.meanPhasic - lo.meanPhasic) / se : 0;
    const df =
      va + vb > 0 ? (va + vb) ** 2 / (va ** 2 / a.df + vb ** 2 / b.df) : 0;
    const p = se > 0 && df > 0 ? StatsMath._tTestPValue(t, df) : 1;
    const nPairs = (roadProfile.length * (roadProfile.length - 1)) / 2;
    return {
      highName: hi.name,
      lowName: lo.name,
      highMean: hi.meanPhasic,
      lowMean: lo.meanPhasic,
      diffPct:
        lo.meanPhasic !== 0
          ? ((hi.meanPhasic - lo.meanPhasic) / lo.meanPhasic) * 100
          : 0,
      t,
      df,
      p,
      pAdj: Number.isFinite(p) ? Math.min(1, p * nPairs) : p,
      nGroups: roadProfile.length,
    };
  },
};
