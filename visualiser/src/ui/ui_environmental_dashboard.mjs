/**
 * GSRUI — environmental dashboard orchestration. Object-augment split from
 * ui.js: loaded immediately after ui.js, adds this method to the shared
 * GSRUI object.
 *
 * updateEnvironmentalDashboard() is the single entry point that assembles
 * the whole dashboard: per-walk stats, the correlation table
 * (ui_correlation_table.js), the road profile (ui_road_profile.js), and the
 * scatter plots.
 */
import { AppState } from '../core/app_state.mjs';
import { GSR_CONST } from '../core/constants.mjs';
import { StatsMath } from '../signal/stats_math.mjs';
import { GSRUI } from './ui.mjs';

export const __methods = {

  updateEnvironmentalDashboard() {
    // Every active track (the walks the user has toggled on), and the
    // enriched subset the analysis can actually use.
    const allActive = (AppState.viewMode === 'single')
      ? (AppState.analyzer ? [{ id: AppState.activeTrackId, analyzer: AppState.analyzer }] : [])
      : AppState.collectiveManager.getActiveTracks();
    const activeTracks = allActive.filter(t => t.analyzer && t.analyzer.isEnriched);
    const totalWalks = allActive.length;

    if (activeTracks.length === 0) return;

    const latency = parseFloat(document.getElementById('gpsPeakLatency').value) || 2.0;
    // SCL (tonic) follows its driver several times more slowly than an SCR, so
    // its environment is read further back than the phasic/peaks latency —
    // scaled from the same knob (×4, capped at 30 s ≈ ~40 m at walking pace).
    const tonicLatency = Math.min(30, latency * 4);
    const trackIdsStr = activeTracks.map(t => t.id).join(',');
    // Per-track mutation fingerprint (analyzer._dataVersion is bumped by
    // analyze(), setPeakLabel(), setPeakExcluded(), enrichTrack()). In the
    // cache key, so the cache self-invalidates on any of them.
    const versionSig = activeTracks.map(t => (t.analyzer && t.analyzer._dataVersion) || 0).join(',');

    // Cache on the analyzer (single mode) or the collective manager
    // (collective mode — survives active-track switches).
    const cacheTarget = (AppState.viewMode === 'single') ? AppState.analyzer : AppState.collectiveManager;
    const cache = cacheTarget._cachedEnvStats;
    const needsRecalc = !cache ||
                      cache.latency !== latency ||
                      cache.trackCount !== activeTracks.length ||
                      cache.trackIds !== trackIdsStr ||
                      cache.versionSig !== versionSig;

    if (needsRecalc) {
      const allData = [];
      activeTracks.forEach(track => {
        const a = track.analyzer;
        if (!a || !a.isEnriched || a.raw.length === 0) return;
        
        let lastTime = -999;
        for (let i = 0; i < a.raw.length; i++) {
          const pt = a.raw[i];
          // Sample at ~1 Hz (keeps the point set manageable)
          if (pt.time - lastTime >= 1.0) {
            const coords = a.getCoordinates(i);
            if (coords) {
              // Phasic + peaks: environment read `latency` seconds earlier —
              // an SCR lags its trigger and the subject has since moved on.
              // Tonic: read `tonicLatency` (a larger lag) earlier — SCL tracks
              // its driver over a slower time course (envPtTonic below).
              const envIdx = a.findClosestIndex(Math.max(0, pt.time - latency));
              const envPt = (envIdx !== -1) ? a.raw[envIdx] : pt;
              const envIdxT = a.findClosestIndex(Math.max(0, pt.time - tonicLatency));
              const envPtTonic = (envIdxT !== -1) ? a.raw[envIdxT] : pt;

              // Aggregate arousal over the trailing 1 s (10 samples @ 10 Hz):
              // mean for level, max for the phasic peak, mean for walking speed.
              const windowStartIdx = Math.max(0, i - 9);
              let sumVal = 0;
              let sumTonic = 0;
              let maxPhasic = 0;
              let sumSpeed = 0;
              let speedCount = 0;
              let count = 0;
              for (let j = windowStartIdx; j <= i; j++) {
                if (a.raw[j]) {
                  sumVal += a.raw[j].val || 0;
                  if (a.tonic && a.tonic[j]) {
                    sumTonic += a.tonic[j].val || 0;
                  }
                  if (a.phasic && a.phasic[j]) {
                    maxPhasic = Math.max(maxPhasic, a.phasic[j].val || 0);
                  }
                  const rawSpd = a.raw[j].speedKts;
                  if (typeof rawSpd === 'number' && !isNaN(rawSpd)) {
                    sumSpeed += rawSpd * 0.514444; // knots -> m/s
                    speedCount++;
                  }
                  count++;
                }
              }
              const avgVal = count > 0 ? sumVal / count : pt.val;
              const avgTonic = (count > 0 && a.tonic) ? sumTonic / count : 0;
              const finalPhasic = a.phasic ? maxPhasic : 0;
              const avgSpeed = speedCount > 0 ? sumSpeed / speedCount : ((typeof pt.speedKts === 'number' && !isNaN(pt.speedKts)) ? pt.speedKts * 0.514444 : 0);
              const tonicSpeedMs = (envPtTonic && typeof envPtTonic.speedKts === 'number' && !isNaN(envPtTonic.speedKts)) ? envPtTonic.speedKts * 0.514444 : avgSpeed;

              allData.push({
                trackId: track.id,
                time: pt.time,
                val: avgVal,
                phasic: finalPhasic,
                tonic: avgTonic,
                speed: avgSpeed,
                osm_road_class: envPt.osm_road_class,
                osm_dist_major_road: envPt.osm_dist_major_road,
                osm_in_park: envPt.osm_in_park,
                osm_green_pct_50m: envPt.osm_green_pct_50m,
                osm_dist_green: envPt.osm_dist_green,
                osm_canopy_pct_50m: envPt.osm_canopy_pct_50m,
                osm_building_density_50m: envPt.osm_building_density_50m,
                osm_dist_water: envPt.osm_dist_water,
                osm_tree_density_50m: envPt.osm_tree_density_50m,
                osm_amenity_count_50m: envPt.osm_amenity_count_50m,
                ndvi: (typeof envPt.ndvi === 'number') ? envPt.ndvi : NaN,
                ndvi_50m: (typeof envPt.ndvi_50m === 'number') ? envPt.ndvi_50m : NaN,
                // EM Fog Index (0-100), latency-shifted like the OSM fields.
                // NaN when the row has no Sub-GHz RSSI; dropped per-feature below.
                em_fog: (typeof envPt.em_fog === 'number') ? envPt.em_fog : NaN,
                // Environment for the tonic channel, read `tonicLatency` s back.
                tonicEnv: {
                  speed: tonicSpeedMs,
                  osm_road_class: envPtTonic.osm_road_class,
                  osm_dist_major_road: envPtTonic.osm_dist_major_road,
                  osm_in_park: envPtTonic.osm_in_park,
                  osm_green_pct_50m: envPtTonic.osm_green_pct_50m,
                  osm_dist_green: envPtTonic.osm_dist_green,
                  osm_canopy_pct_50m: envPtTonic.osm_canopy_pct_50m,
                  osm_building_density_50m: envPtTonic.osm_building_density_50m,
                  osm_dist_water: envPtTonic.osm_dist_water,
                  osm_tree_density_50m: envPtTonic.osm_tree_density_50m,
                  osm_amenity_count_50m: envPtTonic.osm_amenity_count_50m,
                  ndvi: (typeof envPtTonic.ndvi === 'number') ? envPtTonic.ndvi : NaN,
                  ndvi_50m: (typeof envPtTonic.ndvi_50m === 'number') ? envPtTonic.ndvi_50m : NaN,
                  em_fog: (typeof envPtTonic.em_fog === 'number') ? envPtTonic.em_fog : NaN
                }
              });
              lastTime = pt.time;
            }
          }
        }
      });

      // Correlation features: continuous OSM fields + binary "in park"
      // (point-biserial r is Pearson on a 0/1 variable). Road Class is
      // multi-level categorical and stays out.
      const features = GSR_CONST.OSM_METRICS
        .filter(m => m.kind === 'continuous' || m.kind === 'binary')
        .map(m => ({ name: m.label, key: m.field, binary: m.kind === 'binary' }));

      // Satellite remote-sensing metrics (NDVI) — add when some sample carries a reading
      if (allData.some(d => !isNaN(d.ndvi_50m))) {
        features.push({ name: 'NDVI (50m Buffer)', key: 'ndvi_50m', binary: false });
      }
      if (allData.some(d => !isNaN(d.ndvi))) {
        features.push({ name: 'Point NDVI', key: 'ndvi', binary: false });
      }

      // EM Fog comes from Sub-GHz RSSI, not Overpass, so it's not in
      // OSM_METRICS. Add it only when some sample carries a reading.
      if (allData.some(d => !isNaN(d.em_fog))) {
        features.push({ name: 'EM Fog Index', key: 'em_fog', binary: false });
      }

      // Peak count per sample = number of peaks in its 15 s bin. The Peaks
      // channel doesn't correlate this per-1-Hz-sample (that duplicates each
      // count ~15×); instead each walk's Peaks series is re-aggregated to one
      // point per 15 s bin in the feature loop below.
      const peakCounts = [];
      activeTracks.forEach(track => {
        const a = track.analyzer;
        const peaks = a.peaks.filter(p => !p.excluded);
        const peakBinMap = new Map();
        peaks.forEach(p => {
          const bin = Math.floor(p.time / 15);
          peakBinMap.set(bin, (peakBinMap.get(bin) || 0) + 1);
        });
        allData.forEach(d => {
          if (d.trackId === track.id) {
            const bin = Math.floor(d.time / 15);
            peakCounts.push(peakBinMap.get(bin) || 0);
          }
        });
      });

      // 999.0 is the "no feature within radius" sentinel — not a distance.
      const validNum = (v) => v !== null && v !== undefined && !isNaN(v) && v !== 999.0;
      const coerceBin = (v) => (v === true || v === 1) ? 1 : (v === false || v === 0) ? 0 : NaN;

      const correlationMatrix = features.map(f => {
        // Valid samples for this feature, bucketed per track. allData is
        // track-contiguous. A track is a "walk" — an independent recording.
        //  - xPhasic / phasic : short-lag environment vs momentary arousal
        //  - xTonic  / tonic  : long-lag environment vs baseline arousal
        //  - peakBinX / peakBinY : one point per 15 s bin (mean feature vs
        //    peak count) — no per-second duplication of the binned count
        const byTrack = new Map();
        const validX = []; // pooled latency-shifted values, for the variance check
        for (let i = 0; i < allData.length; i++) {
          const row = allData[i];
          const tid = row.trackId;
          let b = byTrack.get(tid);
          if (!b) {
            b = { xPhasic: [], phasic: [], xTonic: [], tonic: [], speedTonic: [], binX: new Map(), binPk: new Map() };
            byTrack.set(tid, b);
          }
          let xP = f.binary ? coerceBin(row[f.key]) : row[f.key];
          const tEnv = row.tonicEnv || row;
          let xT = f.binary ? coerceBin(tEnv[f.key]) : tEnv[f.key];

          if (validNum(xP)) {
            b.xPhasic.push(xP);
            b.phasic.push(row.phasic);
            validX.push(xP);
            const bin = Math.floor(row.time / 15);
            let bx = b.binX.get(bin);
            if (!bx) { bx = []; b.binX.set(bin, bx); }
            bx.push(xP);
            b.binPk.set(bin, peakCounts[i] || 0);
          }
          if (validNum(xT)) {
            b.xTonic.push(xT);
            b.tonic.push(row.tonic);
            const spd = (tEnv && typeof tEnv.speed === 'number' && !isNaN(tEnv.speed)) ? tEnv.speed : (row.speed || 0);
            b.speedTonic.push(spd);
          }
        }
        const walks = [...byTrack.values()];
        // Collapse each walk's binned Peaks data to one (mean x, count) pair
        // per 15 s bin.
        for (const b of walks) {
          b.peakBinX = []; b.peakBinY = [];
          for (const [bin, xs] of b.binX) {
            let s = 0;
            for (const v of xs) s += v;
            b.peakBinX.push(s / xs.length);
            b.peakBinY.push(b.binPk.get(bin) || 0);
          }
        }

        // One method for the whole matrix, by walk count:
        //  - 1 walk  → pooled r + autocorrelation-adjusted p ('single').
        //  - 2+ walks → random-effects meta-analysis across walks
        //    (inverse-variance per-walk r via effective N, DerSimonian–Laird
        //    heterogeneity, Knapp–Hartung t). Needs >= 3 walks in which this
        //    factor actually varies; graded by how many:
        //      >= META_SOLID  → 'meta' (a real significance verdict)
        //      3..SOLID-1     → 'metaProvisional' (direction only, "N walks")
        //      < 3            → 'fewWalks' (effect size only, no test)
        const META_SOLID = 5;
        const analyse = (getX, getY) => {
          if (walks.length === 1) {
            const c = StatsMath.calculateAutocorrCorrelation(getX(walks[0]), getY(walks[0]));
            return { r: c.r, p: c.p, method: 'single', k: 1, i2: NaN };
          }
          const meta = StatsMath.metaCorrelation(walks.map(w => ({ x: getX(w), y: getY(w) })));
          if (meta.k < 3) return { r: meta.r, p: NaN, method: 'fewWalks', k: meta.k, i2: NaN };
          if (meta.k < META_SOLID) return { r: meta.r, p: meta.p, method: 'metaProvisional', k: meta.k, i2: meta.i2 };
          return { r: meta.r, p: meta.p, method: 'meta', k: meta.k, i2: meta.i2 };
        };
        const chPhasic = analyse(w => w.xPhasic,  w => w.phasic);
        const chTonic  = analyse(w => w.xTonic,   w => w.tonic);
        const chPeaks  = analyse(w => w.peakBinX, w => w.peakBinY);

        // Speed-adjusted partial correlation for the tonic channel
        let chTonicSpeed;
        if (walks.length === 1) {
          const w = walks[0];
          const pc = StatsMath.partialCorrelation(w.xTonic, w.tonic, w.speedTonic);
          chTonicSpeed = { r: pc.r, p: pc.p, method: 'single', k: 1 };
        } else {
          const metaSpeed = StatsMath.metaCorrelation(walks.map(w => {
            const statZ = StatsMath.calculateStats(w.speedTonic);
            if (statZ.variance > 1e-12) {
              const regX = StatsMath.calculateLinearRegression(w.speedTonic, w.xTonic);
              const regY = StatsMath.calculateLinearRegression(w.speedTonic, w.tonic);
              const resX = w.xTonic.map((v, i) => v - (regX.m * w.speedTonic[i] + regX.c));
              const resY = w.tonic.map((v, i) => v - (regY.m * w.speedTonic[i] + regY.c));
              return { x: resX, y: resY };
            }
            return { x: w.xTonic, y: w.tonic };
          }));
          if (metaSpeed.k < 3) chTonicSpeed = { r: metaSpeed.r, p: NaN, method: 'fewWalks', k: metaSpeed.k };
          else if (metaSpeed.k < META_SOLID) chTonicSpeed = { r: metaSpeed.r, p: metaSpeed.p, method: 'metaProvisional', k: metaSpeed.k };
          else chTonicSpeed = { r: metaSpeed.r, p: metaSpeed.p, method: 'meta', k: metaSpeed.k };
        }

        // hasVariance = the factor actually changed. A constant predictor
        // explains no variance in arousal whatever its r. Continuous fields
        // need a coefficient of variation ≥ 1% (sx.std is floored at 1, so
        // use the true spread from sx.variance).
        const sx = StatsMath.calculateStats(validX);
        const trueStd = Math.sqrt(sx.variance);
        const cv = trueStd / (Math.abs(sx.mean) + 1e-9);
        const hasVariance = f.binary
          ? (new Set(validX).size > 1)
          : (validX.length > 2 && trueStd > 0 && cv >= 0.01);

        return { name: f.name, key: f.key, n: validX.length, featureWalks: walks.length, hasVariance,
                 rPhasic: chPhasic.r, rTonic: chTonic.r, rPeaks: chPeaks.r,
                 rTonicSpeedAdj: chTonicSpeed.r, pTonicSpeedAdj: chTonicSpeed.p, mTonicSpeedAdj: chTonicSpeed.method,
                 pPhasic: chPhasic.p, pTonic: chTonic.p, pPeaks: chPeaks.p,
                 mPhasic: chPhasic.method, mTonic: chTonic.method, mPeaks: chPeaks.method,
                 kPhasic: chPhasic.k, kTonic: chTonic.k, kPeaks: chPeaks.k,
                 i2Phasic: chPhasic.i2, i2Tonic: chTonic.i2, i2Peaks: chPeaks.i2 };
      });

      // Multiple comparisons: Benjamini–Hochberg FDR, one family PER arousal
      // channel (phasic, tonic, peaks). Phasic / tonic / peaks are three
      // correlated views of the same arousal, not three independent
      // discoveries, so pooling them into one 3×features family both
      // over-counts the tests and mixes hypotheses. Within a channel the
      // family is "which environmental factors relate to THIS measure" — the
      // features are the real multiple comparisons. Only cells carrying a
      // significance verdict ('meta'/'single') and real variation enter;
      // effect-size-only cells ('metaProvisional', 'fewWalks') get no q.
      const testable = (row, m) => row.hasVariance && (m === 'meta' || m === 'single');
      const adjustChannel = (mKey, pKey, qKey) => {
        const fam = correlationMatrix.map(row => testable(row, row[mKey]) ? row[pKey] : NaN);
        const q = StatsMath.benjaminiHochberg(fam);
        correlationMatrix.forEach((row, i) => { row[qKey] = q[i]; });
      };
      adjustChannel('mPhasic', 'pPhasic', 'qPhasic');
      adjustChannel('mTonic',  'pTonic',  'qTonic');
      adjustChannel('mPeaks',  'pPeaks',  'qPeaks');

      // Per-road-class arousal: mean, std, autocorrelation-adjusted 95% CI,
      // peak rate. 'unclassified' (OSM's mixed-bag minor-road tag) and any
      // class with under 5 s of data are dropped.
      const ROAD_SKIP = new Set(['unclassified']);
      const roadGroups = new Map();
      // Pass 1 — phasic arousal + the group structure, keyed by the
      // phasic-lagged road class (env read `latency` s back). Per-walk
      // sub-arrays: the CI's effective sample size must be estimated *within*
      // each walk and summed, never off the walks stitched end to end (that
      // autocorrelation runs across recording boundaries and is meaningless).
      allData.forEach(d => {
        const cls = d.osm_road_class || 'none';
        let g = roadGroups.get(cls);
        if (!g) { g = { phasicVals: [], tonicVals: [], byWalk: new Map(), peaks: 0 }; roadGroups.set(cls, g); }
        g.phasicVals.push(d.phasic);
        let w = g.byWalk.get(d.trackId);
        if (!w) { w = { phasicVals: [], tonicVals: [] }; g.byWalk.set(d.trackId, w); }
        w.phasicVals.push(d.phasic);
      });
      // Pass 2 — tonic (SCL) arousal, keyed by the *tonic*-lagged road class
      // (env read `tonicLatency` s back, a longer lag). This differs from the
      // phasic class only where a class boundary falls between the two lags —
      // a few metres of path — but pairing baseline arousal with the wrong-lag
      // class is still a lag mismatch. Falls back to the phasic-lagged group
      // when the tonic class has no group of its own, so no sample is dropped.
      allData.forEach(d => {
        const clsT = (d.tonicEnv && d.tonicEnv.osm_road_class) || d.osm_road_class || 'none';
        const g = roadGroups.get(clsT) || roadGroups.get(d.osm_road_class || 'none');
        if (!g) return;
        g.tonicVals.push(d.tonic);
        let w = g.byWalk.get(d.trackId);
        if (!w) { w = { phasicVals: [], tonicVals: [] }; g.byWalk.set(d.trackId, w); }
        w.tonicVals.push(d.tonic);
      });

      activeTracks.forEach(track => {
        const a = track.analyzer;
        const peaks = a.peaks.filter(p => !p.excluded);
        peaks.forEach(p => {
          const idx = a.findClosestIndex(Math.max(0, p.time - latency));
          const rc = (idx !== -1 && a.raw[idx].osm_road_class) ? a.raw[idx].osm_road_class : 'none';
          if (roadGroups.has(rc)) {
            roadGroups.get(rc).peaks++;
          }
        });
      });

      const roadProfile = [];
      roadGroups.forEach((val, key) => {
        if (ROAD_SKIP.has(key)) return;
        const n = val.phasicVals.length;
        if (n < 5) return;
        // Tonic count can differ from n by a handful of samples now it's routed
        // by its own lag (pass 2 above) — divide each moment by its own count.
        const nT = val.tonicVals.length;
        const meanPhasic = val.phasicVals.reduce((s, v) => s + v, 0) / n;
        const meanTonic = nT > 0 ? val.tonicVals.reduce((s, v) => s + v, 0) / nT : 0;
        const stdPhasic = Math.sqrt(val.phasicVals.reduce((s, v) => s + (v - meanPhasic) ** 2, 0) / n);
        const stdTonic = nT > 0 ? Math.sqrt(val.tonicVals.reduce((s, v) => s + (v - meanTonic) ** 2, 0) / nT) : 0;
        // CI uses the effective sample size, not the raw second count:
        // consecutive 1 Hz EDA samples are correlated, so sqrt(n) overstates
        // precision. Effective N is summed over per-walk estimates so the
        // autocorrelation is measured within a recording, not across the join.
        const walkArrs = [...val.byWalk.values()];
        const nEffPhasic = walkArrs.reduce((s, w) => s + StatsMath.effectiveSampleSize(w.phasicVals), 0);
        const nEffTonic  = walkArrs.reduce((s, w) => s + StatsMath.effectiveSampleSize(w.tonicVals), 0);
        const ciPhasic = nEffPhasic > 1 ? 1.96 * stdPhasic / Math.sqrt(nEffPhasic) : 0;
        const ciTonic = nEffTonic > 1 ? 1.96 * stdTonic / Math.sqrt(nEffTonic) : 0;
        roadProfile.push({
          name: key,
          timeSpent: n,
          effSamples: Math.round(nEffPhasic),
          meanPhasic,
          meanTonic,
          stdPhasic,
          stdTonic,
          ciPhasic,
          ciTonic,
          peakRate: (val.peaks / (n / 60)),
          _phasicVals: val.phasicVals,
          _nEffPhasic: nEffPhasic
        });
      });
      roadProfile.sort((a, b) => b.meanPhasic - a.meanPhasic);

      // Highest vs lowest road class: a Welch t-test on effective sample
      // sizes (a CI-overlap check is not a valid significance test), using the
      // per-walk-summed effective N so the autocorrelation isn't measured
      // across the joins between walks. hi and lo are the extremes of
      // `roadProfile.length` group means, picked *after* seeing the data —
      // testing that gap as if it were pre-specified inflates the false-positive
      // rate, so Bonferroni-adjust the p by the number of pairwise contrasts
      // that could have been the widest (k choose 2).
      let roadComparison = null;
      if (roadProfile.length >= 2) {
        const hi = roadProfile[0];
        const lo = roadProfile[roadProfile.length - 1];
        const w = StatsMath.welchTTest(hi._phasicVals, lo._phasicVals, true,
                                       { a: hi._nEffPhasic, b: lo._nEffPhasic });
        const nPairs = roadProfile.length * (roadProfile.length - 1) / 2;
        roadComparison = {
          highName: hi.name, lowName: lo.name,
          highMean: hi.meanPhasic, lowMean: lo.meanPhasic,
          diffPct: lo.meanPhasic !== 0 ? (hi.meanPhasic - lo.meanPhasic) / lo.meanPhasic * 100 : 0,
          t: w.t, df: w.df, p: w.p,
          pAdj: Number.isFinite(w.p) ? Math.min(1, w.p * nPairs) : w.p,
          nGroups: roadProfile.length
        };
      }
      roadProfile.forEach(p => { delete p._phasicVals; delete p._nEffPhasic; }); // drop internals before caching

      cacheTarget._cachedEnvStats = {
        latency,
        trackCount: activeTracks.length,
        trackIds: trackIdsStr,
        versionSig,
        allData,
        correlationMatrix,
        roadProfile,
        roadComparison
      };
    }

    // ── Render from the cache ─────────────────────────────────────────────
    const cachedStats = cacheTarget._cachedEnvStats;
    const hasEmFog = cachedStats.correlationMatrix.some(r => r.key === 'em_fog');
    const hasSpeed = (cachedStats.allData || []).some(d => typeof d.speed === 'number' && d.speed > 0);
    const hasNdvi = (cachedStats.allData || []).some(d => !isNaN(d.ndvi) || !isNaN(d.ndvi_50m));

    // enriched-walk count is cached; totalWalks (incl. not-yet-enriched) is live.
    GSRUI.syncScatterEnvOptions(hasEmFog, hasSpeed, hasNdvi);
    GSRUI.renderCorrelationTable(cachedStats.correlationMatrix, cachedStats.trackCount, totalWalks);
    GSRUI.drawRegressionScatterPlot(cachedStats.allData);
    GSRUI.renderRoadProfile(cachedStats.roadProfile, cachedStats.roadComparison);
  },

};

Object.assign(GSRUI, __methods);
