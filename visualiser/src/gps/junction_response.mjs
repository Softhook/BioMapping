/**
 * Junction response analysis — pure, no DOM.
 *
 * Question: does GSR differ around junctions where the walker TURNS compared
 * with junctions where they CARRY ON?  Takes the passages classified by
 * junctions.mjs plus an aligned GSR series and produces, per passage, GSR
 * summaries in a window just BEFORE and just AFTER the junction, then tests
 * turn vs straight two ways (compare()):
 *
 *   • pooled   — label-permutation test over all passages (treats passages as
 *                independent; passages within one walk are not, so read it as
 *                indicative).
 *   • paired   — within each junction that has both a turn and a straight
 *                visit, mean(turn) − mean(straight); labels permuted within
 *                junction for the p-value.  Controls for the junction's own
 *                surroundings and needs no distributional assumptions.
 *
 * "Before" is the window ending at the junction's entry; "after" starts AT the
 * entry, so the traversal itself is inside it — that is where the response to
 * the decision lands (a turn's SCR peaks a few seconds after entry), and
 * starting "after" at the exit reads it from partway down its falling edge.
 * A passage whose traversal is longer than MAX_TRAVERSAL_S (a merged cluster,
 * a stop, a mis-snap) is dropped: its "after" window would not be about the
 * junction.  Windows are clipped at the midpoint between neighbouring entries
 * so no GSR sample is counted in two passages.
 *
 * Junction times are GPS (place) times, but GSR lags what evoked it
 * (PhysioLatency).  The windows are laid out in place time and each GSR
 * channel is read `lag` seconds later, so "after" starts once the response to
 * leaving the junction can show, and "before" is not credited with the
 * response to the junction itself.
 *
 * Records carry a trackId.  For the pooled test each level is centred on its
 * own track's mean (a per-walk fixed effect) so people/walks with a bigger GSR
 * amplitude don't masquerade as a turn effect; only tracks that contain both
 * turns and straights inform it (label-permutation within track).  One p and
 * one BH q is reported per row, from the paired test when there are enough
 * paired junctions, else the pooled one, and the verdict is decided on q —
 * never on an uncorrected p.
 *
 * Mid-block "control" passages give an open-road baseline: compare() also
 * contrasts straight and turn against them, and compareJunctionVsRoad() asks
 * the coarser question of any junction vs plain road.
 */
import { StatsMath } from '../signal/stats_math.mjs';

export const JunctionResponse = {
  WINDOW_S: 10,
  /** A window shorter than this (s) after clipping is dropped. */
  MIN_WINDOW_S: 5,
  /** Passages whose entry→exit span exceeds this (s) are dropped. */
  MAX_TRAVERSAL_S: 20,
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

  /**
   * Summarise series samples for the place-time window [t0, t1).  Phasic and
   * peaks are read from [t0 + lag.phasic, t1 + lag.phasic), tonic from its own
   * (longer) lag; both must be adequately covered.
   */
  _summarise(series, t0, t1, dt = 0, lag = {}) {
    const { time, phasic, tonic, isPeak } = series;
    const lp = lag.phasic || 0;
    const lt = lag.tonic || 0;
    let n = 0;
    let sumP = 0;
    let peaks = 0;
    for (
      let i = this._lowerBound(time, t0 + lp);
      i < time.length && time[i] < t1 + lp;
      i++
    ) {
      n++;
      sumP += phasic[i];
      if (isPeak?.[i]) peaks++;
    }
    let nT = n;
    let sumT = 0;
    if (tonic) {
      nT = 0;
      for (
        let i = this._lowerBound(time, t0 + lt);
        i < time.length && time[i] < t1 + lt;
        i++
      ) {
        nT++;
        sumT += tonic[i] ?? 0;
      }
    }
    const dur = t1 - t0;
    // Time actually observed: a window running off the recording or across a
    // dropout must not be divided by its nominal length.
    const covered = dt > 0 ? Math.min(dur, n * dt) : dur;
    const coveredT = dt > 0 ? Math.min(dur, nT * dt) : dur;
    if (
      n < this.MIN_SAMPLES ||
      nT < this.MIN_SAMPLES ||
      dur < this.MIN_WINDOW_S ||
      covered < this.MIN_COVERAGE * dur ||
      coveredT < this.MIN_COVERAGE * dur ||
      !Number.isFinite(sumP) ||
      !Number.isFinite(sumT)
    ) {
      return null;
    }
    return {
      peakRate: (peaks / covered) * 60,
      meanPhasic: sumP / n,
      meanTonic: sumT / nT,
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
   * @param {{windowS?:number, trackId?:*, lag?:{phasic:number,tonic:number}}} [opts]
   *   `lag` = PhysioLatency.lags(slider); omitted → no latency shift.
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
      if (exit - enter > this.MAX_TRAVERSAL_S) return;
      const prevEnter = prev ? (prev.timeEnter ?? prev.time) : null;
      const nextEnter = next ? (next.timeEnter ?? next.time) : null;
      const t0 = Math.max(
        enter - W,
        prevEnter != null ? (prevEnter + enter) / 2 : -Infinity,
      );
      const t1 = Math.min(
        enter + W,
        nextEnter != null ? (enter + nextEnter) / 2 : Infinity,
      );
      const before = this._summarise(series, t0, enter, dt, opts.lag);
      const after = this._summarise(series, enter, t1, dt, opts.lag);
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
   * items = [{v, inA:boolean, group}]. Returns {meanA, meanB, p}.
   */
  _pooledPermutation(items, seed = 1) {
    const nT = items.filter((x) => x.inA).length;
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
        flags.push(x.inA);
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
      items.filter((x) => x.inA === t).reduce((a, x) => a + x.v, 0) /
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
  _adjustForTrack(recs, val, group = (r) => r.decision) {
    const by = new Map();
    for (const r of recs) {
      if (r.trackId == null) continue;
      if (!by.has(r.trackId)) by.set(r.trackId, []);
      by.get(r.trackId).push(r);
    }
    const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    const usable = [...by.values()].filter((rs) => {
      const groups = new Set(rs.map(group));
      return groups.size >= 2;
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
   * Walk-adjusted permutation contrast between two decision classes.
   * Levels are centred per track (see _adjustForTrack) and labels shuffled
   * within track.
   * @returns {{items:Array, nTracks:number, meanA:number, meanB:number, p:number}}
   *   `meanA` is the mean of class `a`, `meanB` of class `b`.
   */
  _contrast(recs, val, a, b) {
    const sel = recs.filter((r) => r.decision === a || r.decision === b);
    const { items, nTracks } = this._adjustForTrack(sel, val);
    const test = this._pooledPermutation(
      items.map((x) => ({
        v: x.v,
        inA: x.r.decision === a,
        group: x.r.trackId ?? null,
      })),
    );
    return { items, nTracks, ...test };
  },

  /** "supported" on q, "suggestive" on an uncorrected p alone, else "none". */
  _verdict(p, q) {
    if (q < this.ALPHA) return 'supported';
    return p < this.ALPHA ? 'suggestive' : 'none';
  },

  /**
   * Turn-vs-straight, straight-vs-control and turn-vs-control tests on records
   * pooled across tracks.  Each record needs {key, decision, before, after,
   * delta} (+ trackId for the per-track adjustment); 'turn', 'straight' and
   * 'control' are used (reverse / ambiguous are excluded).
   *
   * One row per (phase, metric).  The headline turn-vs-straight `test` is
   * 'paired' when enough junctions have both a turn and a straight, else
   * 'pooled'; its p and BH q drive `verdict`.  The two control contrasts are
   * always pooled and carry their own p / q / verdict (…Junction = straight vs
   * control, …TurnControl = turn vs control).
   */
  compare(records) {
    const recs = records.filter(
      (r) =>
        r.decision === 'turn' ||
        r.decision === 'straight' ||
        r.decision === 'control',
    );
    const tvsRecs = recs.filter((r) => r.decision !== 'control');
    const nControl = recs.filter((r) => r.decision === 'control').length;
    const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    const count = (items, d) => items.filter((x) => x.r.decision === d).length;

    const rows = [];
    for (const phase of ['before', 'after', 'delta']) {
      for (const metric of this.METRICS) {
        // meanTonic level is a between-place quantity; only its change is asked about.
        if (metric === 'meanTonic' && phase !== 'delta') continue;
        const val = (r) => r[phase][metric];

        const tvs = this._contrast(recs, val, 'turn', 'straight');
        const svc = this._contrast(recs, val, 'straight', 'control');
        const tvc = this._contrast(recs, val, 'turn', 'control');

        // Paired contrast uses the raw values: the junction itself is the control.
        const byKey = new Map();
        for (const r of tvsRecs) {
          if (!byKey.has(r.key)) byKey.set(r.key, { turn: [], straight: [] });
          byKey.get(r.key)[r.decision].push(val(r));
        }
        const groups = [...byKey.values()].filter(
          (g) => g.turn.length && g.straight.length,
        );
        // Below MIN_PAIRED the paired test isn't reported, so skip its permutations.
        const usePaired = groups.length >= this.MIN_PAIRED;
        const paired = usePaired
          ? this.pairedPermutation(groups)
          : { n: groups.length, meanDiff: NaN, p: NaN };

        // Report the means, counts and difference from the SAME sample the
        // p-value is about, so the numbers shown always agree with each other.
        const meanTurn = usePaired
          ? mean(groups.map((g) => mean(g.turn)))
          : tvs.meanA;
        const meanStraight = usePaired
          ? mean(groups.map((g) => mean(g.straight)))
          : tvs.meanB;

        // The control baseline is expressed against the reported straight mean
        // so that meanStraight − meanControl === diffJunction identically.
        // With no turns there is no reported straight mean, but the controls
        // still have one of their own.
        const rawControls = recs
          .filter((r) => r.decision === 'control')
          .map(val);
        const rawControlMean = rawControls.length ? mean(rawControls) : NaN;
        const diffJunction =
          Number.isFinite(svc.meanA) && Number.isFinite(svc.meanB)
            ? svc.meanA - svc.meanB
            : meanStraight - rawControlMean;
        const meanControl =
          Number.isFinite(diffJunction) && Number.isFinite(meanStraight)
            ? meanStraight - diffJunction
            : Number.isFinite(svc.meanB)
              ? svc.meanB
              : rawControlMean;

        rows.push({
          phase,
          metric,
          // All usable windows overall …
          nTurn: count(tvs.items, 'turn'),
          nStraight: count(tvs.items, 'straight'),
          nControl,
          nTracks: tvs.nTracks,
          // … and those the reported test actually used.
          nTurnUsed: usePaired
            ? groups.reduce((a, g) => a + g.turn.length, 0)
            : count(tvs.items, 'turn'),
          nStraightUsed: usePaired
            ? groups.reduce((a, g) => a + g.straight.length, 0)
            : count(tvs.items, 'straight'),
          nStraightJuncUsed: count(svc.items, 'straight'),
          nControlUsed: count(svc.items, 'control'),
          meanTurn,
          meanStraight,
          meanStraightJunction: svc.meanA,
          meanControl,
          diff: meanTurn - meanStraight,
          diffJunction,
          diffTurnControl:
            Number.isFinite(meanTurn) && Number.isFinite(meanControl)
              ? meanTurn - meanControl
              : NaN,
          pooledP: tvs.p,
          pairedN: paired.n,
          pairedMeanDiff: paired.meanDiff,
          pairedP: paired.p,
          test: usePaired ? 'paired' : 'pooled',
          p: usePaired ? paired.p : tvs.p,
          pJunction: svc.p,
          pTurnControl: tvc.p,
        });
      }
    }
    const q = StatsMath.benjaminiHochberg(rows.map((r) => r.p));
    const qJunction = StatsMath.benjaminiHochberg(rows.map((r) => r.pJunction));
    const qTurnControl = StatsMath.benjaminiHochberg(
      rows.map((r) => r.pTurnControl),
    );
    rows.forEach((r, i) => {
      r.q = q[i];
      r.qJunction = qJunction[i];
      r.qTurnControl = qTurnControl[i];
      r.verdict = this._verdict(r.p, r.q);
      r.verdictJunction = this._verdict(r.pJunction, r.qJunction);
      r.verdictTurnControl = this._verdict(r.pTurnControl, r.qTurnControl);
    });
    return rows;
  },

  /**
   * Arousal near ANY junction vs on plain road, ignoring what the walker did
   * there: turn, straight, reverse and ambiguous passages all count as
   * "junction"; controls are "road".  Each record's window pair is collapsed to
   * the whole ±window around the point (mean of before and after), plus the
   * change across it.  Same walk-adjusted permutation test as compare(); one BH
   * q across the three measures.
   * @returns {Array<{metric,nJunction,nRoad,nTracks,meanJunction,meanRoad,diff,p,q,verdict}>}
   */
  compareJunctionVsRoad(records) {
    const isRoad = (r) => r.decision === 'control';
    const group = (r) => (isRoad(r) ? 'road' : 'junction');
    const recs = records.filter((r) => r.before && r.after && r.delta);
    const both = (f) => (r) => (f(r.before) + f(r.after)) / 2;
    const measures = [
      { metric: 'meanPhasic', val: both((w) => w.meanPhasic) },
      { metric: 'peakRate', val: both((w) => w.peakRate) },
      { metric: 'change', val: (r) => r.delta.meanPhasic },
    ];
    const rows = measures.map(({ metric, val }) => {
      const { items, nTracks } = this._adjustForTrack(recs, val, group);
      const test = this._pooledPermutation(
        items.map((x) => ({
          v: x.v,
          inA: !isRoad(x.r),
          group: x.r.trackId ?? null,
        })),
      );
      const nJunction = items.filter((x) => !isRoad(x.r)).length;
      return {
        metric,
        nJunction,
        nRoad: items.length - nJunction,
        nTracks,
        meanJunction: test.meanA,
        meanRoad: test.meanB,
        diff: test.meanA - test.meanB,
        p: test.p,
      };
    });
    const q = StatsMath.benjaminiHochberg(rows.map((r) => r.p));
    rows.forEach((r, i) => {
      r.q = q[i];
      r.verdict = this._verdict(r.p, r.q);
    });
    return rows;
  },
};
