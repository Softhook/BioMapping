/**
 * Junction response analysis — pure, no DOM.
 *
 * Question: does GSR differ around junctions where the walker TURNS compared
 * with junctions where they CARRY ON?  Takes the passages classified by
 * junctions.mjs plus an aligned GSR series and produces, per passage, GSR
 * summaries in a window just BEFORE and just AFTER the junction, then tests
 * turn vs straight two ways:
 *
 *   • pooled   — label-permutation test over all passages (treats passages as independent;
 *                passages within one walk are not, so read it as indicative).
 *   • paired   — within each junction that has both a turn and a straight
 *                visit, mean(turn) − mean(straight); labels permuted within
 *                junction for the p-value.  Controls for the junction's own
 *                surroundings and needs no distributional assumptions.
 *
 * Windows are clipped at the midpoint to neighbouring passages so no GSR
 * sample is counted in two passages.
 *
 * Records carry a trackId.  For the pooled test each level is centred on its
 * own track's mean (a per-walk fixed effect) so people/walks with a bigger GSR
 * amplitude don't masquerade as a turn effect; only tracks that contain both
 * turns and straights inform it (label-permutation within track).  One p and one BH q is reported per row, from
 * the paired test when there are enough paired junctions, else the pooled one,
 * and the verdict is decided on q — never on an uncorrected p.
 */
import { StatsMath } from '../signal/stats_math.mjs';

export const JunctionResponse = {
  WINDOW_S: 10,
  /** A window shorter than this (s) after clipping is dropped. */
  MIN_WINDOW_S: 5,
  /** …or with fewer than this many GSR samples. */
  MIN_SAMPLES: 5,
  /** …or with GSR covering less than this fraction of the window (recording
   *  start/end, dropouts): rates are computed over the covered time only. */
  MIN_COVERAGE: 0.8,
  PERMUTATIONS: 5000,
  /** Fewer paired junctions than this and the paired test is too coarse to
   *  be the headline (its permutation p can't get small). */
  MIN_PAIRED: 15,
  /** q below this is "supported"; a raw p below it alone is only "suggestive". */
  ALPHA: 0.05,

  METRICS: ['peakRate', 'meanPhasic', 'meanTonic'],

  /** Summarise series samples with time in [t0, t1). */
  _summarise(series, t0, t1, dt = 0) {
    const { time, phasic, tonic, isPeak } = series;
    let n = 0;
    let sumP = 0;
    let sumT = 0;
    let peaks = 0;
    for (
      let i = this._lowerBound(time, t0);
      i < time.length && time[i] < t1;
      i++
    ) {
      n++;
      sumP += phasic[i];
      if (tonic) sumT += tonic[i] ?? 0;
      if (isPeak?.[i]) peaks++;
    }
    const dur = t1 - t0;
    // Time actually observed: a window running off the recording or across a
    // dropout must not be divided by its nominal length.
    const covered = dt > 0 ? Math.min(dur, n * dt) : dur;
    if (
      n < this.MIN_SAMPLES ||
      dur < this.MIN_WINDOW_S ||
      covered < this.MIN_COVERAGE * dur ||
      !Number.isFinite(sumP) ||
      !Number.isFinite(sumT)
    ) {
      return null;
    }
    return {
      peakRate: (peaks / covered) * 60,
      meanPhasic: sumP / n,
      meanTonic: sumT / n,
    };
  },

  /** Median sample spacing (s); 0 when it can't be estimated. */
  _sampleInterval(time) {
    const n = time?.length ?? 0;
    if (n < 2) return 0;
    const step = Math.max(1, Math.floor(n / 200));
    const d = [];
    for (let i = step; i < n; i += step) d.push(time[i] - time[i - step]);
    d.sort((a, b) => a - b);
    return d[d.length >> 1] / step;
  },

  _lowerBound(arr, x) {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  },

  /**
   * @param {Array} passages from Junctions.classifyPassages (one track)
   * @param {{time:number[],phasic:number[],tonic:number[],isPeak:number[]}} series
   * @returns {Array<{key,trackId,decision,kind,time,before,after,delta}>} passages with a
   *   usable window on both sides.
   */
  responses(passages, series, opts = {}) {
    const W = opts.windowS ?? this.WINDOW_S;
    const dt = this._sampleInterval(series.time);
    const sorted = [...passages].sort((a, b) => a.time - b.time);
    const out = [];
    sorted.forEach((p, i) => {
      const prev = sorted[i - 1];
      const next = sorted[i + 1];
      const enter = p.timeEnter ?? p.time;
      const exit = p.timeExit ?? p.time;
      const prevExit = prev ? (prev.timeExit ?? prev.time) : -Infinity;
      const nextEnter = next ? (next.timeEnter ?? next.time) : Infinity;
      const t0 = Math.max(enter - W, prev ? (prevExit + enter) / 2 : -Infinity);
      const t1 = Math.min(exit + W, next ? (exit + nextEnter) / 2 : Infinity);
      const before = this._summarise(series, t0, enter, dt);
      const after = this._summarise(series, exit, t1, dt);
      if (!before || !after) return;
      const delta = {};
      for (const m of this.METRICS) delta[m] = after[m] - before[m];
      out.push({
        key: p.key,
        trackId: opts.trackId ?? null,
        decision: p.decision,
        kind: p.kind,
        time: p.time,
        timeEnter: enter,
        timeExit: exit,
        before,
        after,
        delta,
      });
    });
    return out;
  },

  /** Deterministic PRNG so permutation p-values are reproducible. */
  _rng(seed) {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  },

  /**
   * Paired within-junction contrast.  `groups` = [{turn:number[], straight:number[]}]
   * (only junctions with both).  Returns {n, meanDiff, p} — p from permuting
   * turn/straight labels within each junction.
   */
  pairedPermutation(groups, seed = 1) {
    const n = groups.length;
    if (n < 2) return { n, meanDiff: NaN, p: 1 };
    const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    const stat = (gs) => mean(gs.map((g) => mean(g.turn) - mean(g.straight)));
    const observed = stat(groups);
    if (!Number.isFinite(observed)) return { n, meanDiff: NaN, p: 1 };

    const pre = groups.map((g) => {
      const all = [...g.turn, ...g.straight];
      const nT = g.turn.length;
      const nS = g.straight.length;
      const sTotal = all.reduce((x, y) => x + y, 0);
      return { all, nT, nS, sTotal };
    });

    const rand = this._rng(seed);
    let extreme = 0;
    for (let it = 0; it < this.PERMUTATIONS; it++) {
      let sumDiff = 0;
      for (const p of pre) {
        const { all, nT, nS, sTotal } = p;
        for (let i = all.length - 1; i > 0; i--) {
          const j = Math.floor(rand() * (i + 1));
          const t = all[i];
          all[i] = all[j];
          all[j] = t;
        }
        let sTurn = 0;
        for (let i = 0; i < nT; i++) sTurn += all[i];
        sumDiff += sTurn / nT - (sTotal - sTurn) / nS;
      }
      const permStat = sumDiff / n;
      if (Math.abs(permStat) >= Math.abs(observed) - 1e-12) extreme++;
    }
    return {
      n,
      meanDiff: observed,
      p: (extreme + 1) / (this.PERMUTATIONS + 1),
    };
  },

  /**
   * Pooled turn-vs-straight test: permutation on the difference of means.
   * Labels are shuffled WITHIN each track (items without a trackId form one
   * group), so the design — which walk each passage came from — is preserved.
   * Distribution-free, so a few large SCRs in a small group can't fake a t.
   * items = [{v, turn:boolean, group}]. Returns {meanA, meanB, p}.
   */
  _pooledPermutation(items, seed = 1) {
    const nT = items.filter((x) => x.turn).length;
    const nS = items.length - nT;
    if (nT < 2 || nS < 2) return { meanA: NaN, meanB: NaN, p: 1 };
    const groups = new Map();
    for (const x of items) {
      if (!groups.has(x.group)) groups.set(x.group, []);
      groups.get(x.group).push(x);
    }
    const allVals = [];
    const flags = [];
    const groupLens = [];
    let sumTotal = 0;
    for (const g of groups.values()) {
      groupLens.push(g.length);
      for (const x of g) {
        allVals.push(x.v);
        flags.push(x.turn);
        sumTotal += x.v;
      }
    }
    const stat = (fl) => {
      let sT = 0;
      for (let i = 0; i < allVals.length; i++) {
        if (fl[i]) sT += allVals[i];
      }
      return sT / nT - (sumTotal - sT) / nS;
    };
    const observed = stat(flags);
    if (!Number.isFinite(observed)) return { meanA: NaN, meanB: NaN, p: 1 };
    const rand = this._rng(seed);
    let extreme = 0;
    for (let it = 0; it < this.PERMUTATIONS; it++) {
      let k = 0;
      for (const len of groupLens) {
        for (let i = len - 1; i > 0; i--) {
          const j = Math.floor(rand() * (i + 1));
          const t = flags[k + i];
          flags[k + i] = flags[k + j];
          flags[k + j] = t;
        }
        k += len;
      }
      if (Math.abs(stat(flags)) >= Math.abs(observed) - 1e-12) extreme++;
    }
    const mean = (t) =>
      items.filter((x) => x.turn === t).reduce((a, x) => a + x.v, 0) /
      (t ? nT : nS);
    return {
      meanA: mean(true),
      meanB: mean(false),
      p: (extreme + 1) / (this.PERMUTATIONS + 1),
    };
  },

  /**
   * Shift every record's level so tracks differ only by what happened at their
   * junctions: value − trackMean + grandMean, where the means are over that
   * track's compared records. Tracks with no within-track variation
   * carry no contrast and are dropped. Records without a trackId pass
   * through unchanged.
   */
  _adjustForTrack(recs, val) {
    const by = new Map();
    for (const r of recs) {
      if (r.trackId == null) continue;
      if (!by.has(r.trackId)) by.set(r.trackId, []);
      by.get(r.trackId).push(r);
    }
    const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    const usable = [...by.values()].filter((rs) => {
      const decs = new Set(rs.map((r) => r.decision));
      return decs.size >= 2;
    });
    const grand = usable.length ? mean(usable.flat().map(val)) : 0;
    const out = [];
    for (const r of recs) {
      if (r.trackId == null) {
        out.push({ r, v: val(r) });
        continue;
      }
      const rs = by.get(r.trackId);
      if (!usable.includes(rs)) continue;
      out.push({ r, v: val(r) - mean(rs.map(val)) + grand });
    }
    return { items: out, nTracks: usable.length };
  },

  /**
   * Turn-vs-straight and junction-vs-control tests on records pooled across tracks.
   * Each record needs {key, decision, before, after, delta} (+ trackId for the per-track
   * adjustment); 'turn', 'straight', and 'control' are used (reverse / ambiguous are
   * excluded). Returns rows with the chosen `test` ('paired' | 'pooled'), its
   * `p` and BH `q` across all rows, control baseline means and contrasts, and verdicts.
   */
  compare(records) {
    const recs = records.filter(
      (r) =>
        r.decision === 'turn' ||
        r.decision === 'straight' ||
        r.decision === 'control',
    );
    const rows = [];
    const turnVsStraightRecs = recs.filter(
      (r) => r.decision === 'turn' || r.decision === 'straight',
    );
    const straightVsControlRecs = recs.filter(
      (r) => r.decision === 'straight' || r.decision === 'control',
    );
    const turnVsControlRecs = recs.filter(
      (r) => r.decision === 'turn' || r.decision === 'control',
    );

    const nControl = recs.filter((r) => r.decision === 'control').length;

    const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

    for (const phase of ['before', 'after', 'delta']) {
      for (const metric of this.METRICS) {
        // meanTonic level is a between-place quantity; only its change is asked about.
        if (metric === 'meanTonic' && phase !== 'delta') continue;
        const val = (r) => r[phase][metric];

        // 1. Turn vs Straight contrast
        const { items: tvsItems, nTracks: nTracksTvs } = this._adjustForTrack(
          turnVsStraightRecs,
          val,
        );
        const turnItems = tvsItems.filter((x) => x.r.decision === 'turn');
        const straightItems = tvsItems.filter(
          (x) => x.r.decision === 'straight',
        );
        const nTurn = turnItems.length;
        const nStraight = straightItems.length;

        const pooled = this._pooledPermutation(
          tvsItems.map((x) => ({
            v: x.v,
            turn: x.r.decision === 'turn',
            group: x.r.trackId ?? null,
          })),
        );

        // 2. Straight vs Control (Junction vs Open Road baseline) contrast
        const { items: svcItems } = this._adjustForTrack(
          straightVsControlRecs,
          val,
        );
        const pooledJunction = this._pooledPermutation(
          svcItems.map((x) => ({
            v: x.v,
            turn: x.r.decision === 'straight',
            group: x.r.trackId ?? null,
          })),
        );

        // 3. Turn vs Control contrast
        const { items: tvcItems } = this._adjustForTrack(
          turnVsControlRecs,
          val,
        );
        const pooledTurnControl = this._pooledPermutation(
          tvcItems.map((x) => ({
            v: x.v,
            turn: x.r.decision === 'turn',
            group: x.r.trackId ?? null,
          })),
        );

        // Paired contrast uses the raw values: the junction itself is the control.
        const byKey = new Map();
        for (const r of turnVsStraightRecs) {
          if (!byKey.has(r.key)) byKey.set(r.key, { turn: [], straight: [] });
          byKey.get(r.key)[r.decision].push(val(r));
        }
        const groups = [...byKey.values()].filter(
          (g) => g.turn.length && g.straight.length,
        );
        const paired = this.pairedPermutation(groups);
        const test = paired.n >= this.MIN_PAIRED ? 'paired' : 'pooled';

        // Report the means, counts and difference from the SAME sample the
        // p-value is about, so the numbers shown always agree with each other.
        const usePaired = test === 'paired';
        const meanTurn = usePaired
          ? mean(groups.map((g) => mean(g.turn)))
          : pooled.meanA;
        const meanStraight = usePaired
          ? mean(groups.map((g) => mean(g.straight)))
          : pooled.meanB;

        const rawControls = recs.filter((r) => r.decision === 'control');
        const rawControlMean =
          rawControls.length >= 2
            ? mean(rawControls.map(val))
            : rawControls.length === 1
              ? val(rawControls[0])
              : NaN;

        const diffJunction =
          Number.isFinite(pooledJunction.meanA) &&
          Number.isFinite(pooledJunction.meanB)
            ? pooledJunction.meanA - pooledJunction.meanB
            : Number.isFinite(meanStraight) && Number.isFinite(rawControlMean)
              ? meanStraight - rawControlMean
              : NaN;

        // Ensure meanControl is aligned with the reported meanStraight baseline so
        // that meanStraight - meanControl === diffJunction identically.
        const meanControl =
          Number.isFinite(meanStraight) && Number.isFinite(diffJunction)
            ? meanStraight - diffJunction
            : Number.isFinite(pooledJunction.meanB)
              ? pooledJunction.meanB
              : rawControlMean;

        const diff = meanTurn - meanStraight;
        const diffTurnControl =
          Number.isFinite(meanTurn) && Number.isFinite(meanControl)
            ? meanTurn - meanControl
            : NaN;

        const nTurnUsed = usePaired
          ? groups.reduce((a, g) => a + g.turn.length, 0)
          : tvsItems.filter((x) => x.r.decision === 'turn').length;
        const nStraightUsed = usePaired
          ? groups.reduce((a, g) => a + g.straight.length, 0)
          : tvsItems.filter((x) => x.r.decision === 'straight').length;
        const nStraightJuncUsed = svcItems.filter(
          (x) => x.r.decision === 'straight',
        ).length;
        const nControlUsed = svcItems.filter(
          (x) => x.r.decision === 'control',
        ).length;

        rows.push({
          phase,
          metric,
          // All usable windows overall …
          nTurn,
          nStraight,
          nControl,
          nTracks: nTracksTvs,
          // … and those the reported test actually used.
          nTurnUsed,
          nStraightUsed,
          nStraightJuncUsed,
          nControlUsed: nControlUsed > 0 ? nControlUsed : nControl,
          meanTurn,
          meanStraight,
          meanStraightJunction: pooledJunction.meanA,
          meanControl,
          diff,
          diffJunction,
          diffTurnControl,
          pooledP: pooled.p,
          pairedN: paired.n,
          pairedMeanDiff: paired.meanDiff,
          pairedP: paired.p,
          test,
          p: usePaired ? paired.p : pooled.p,
          pJunction: pooledJunction.p,
          pTurnControl: pooledTurnControl.p,
        });
      }
    }
    const q = StatsMath.benjaminiHochberg(rows.map((r) => r.p));
    const qJunction = StatsMath.benjaminiHochberg(
      rows.map((r) => r.pJunction ?? 1),
    );
    const qTurnControl = StatsMath.benjaminiHochberg(
      rows.map((r) => r.pTurnControl ?? 1),
    );
    rows.forEach((r, i) => {
      r.q = q[i];
      r.qJunction = qJunction[i];
      r.qTurnControl = qTurnControl[i];
      r.verdict =
        r.q < this.ALPHA
          ? 'supported'
          : r.p < this.ALPHA
            ? 'suggestive'
            : 'none';
      r.verdictJunction =
        r.qJunction < this.ALPHA
          ? 'supported'
          : r.pJunction < this.ALPHA
            ? 'suggestive'
            : 'none';
      r.verdictTurnControl =
        r.qTurnControl < this.ALPHA
          ? 'supported'
          : r.pTurnControl < this.ALPHA
            ? 'suggestive'
            : 'none';
    });
    return rows;
  },
};
