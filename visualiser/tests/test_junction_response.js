/**
 * Unit tests for junction_response.mjs — GSR windows around junction passages
 * and turn-vs-straight tests.  Run: node --test tests/test_junction_response.js
 */
const assert = require('node:assert');
const test = require('node:test');

const { JunctionResponse } = require('../src/gps/junction_response.mjs');

// 1 Hz series, `n` seconds; peaks/phasic supplied by fn(t).
function series(n, fn) {
  const s = { time: [], phasic: [], tonic: [], isPeak: [] };
  for (let t = 0; t < n; t++) {
    const v = fn(t);
    s.time.push(t);
    s.phasic.push(v.phasic ?? 0);
    s.tonic.push(v.tonic ?? 0);
    s.isPeak.push(v.peak ? 1 : 0);
  }
  return s;
}
const P = (time, decision = 'turn', key = 'K') => ({
  key,
  decision,
  kind: 'choice',
  time,
});

test('responses: before/after windows summarise the right samples', () => {
  // peaks only in the 10 s AFTER t=50; phasic 1 before, 3 after.
  const s = series(100, (t) => ({
    phasic: t < 50 ? 1 : 3,
    peak: t >= 50 && t < 60 && t % 2 === 0,
  }));
  const [r] = JunctionResponse.responses([P(50)], s);
  assert.strictEqual(r.before.peakRate, 0);
  assert.strictEqual(r.after.peakRate, 30); // 5 peaks in 10 s → 30/min
  assert.strictEqual(r.before.meanPhasic, 1);
  assert.strictEqual(r.after.meanPhasic, 3);
  assert.strictEqual(r.delta.meanPhasic, 2);
});

test('responses: windows are clipped at the midpoint to neighbours and never overlap', () => {
  const s = series(100, () => ({ peak: true }));
  const rs = JunctionResponse.responses([P(40), P(48, 'straight', 'K2')], s);
  // 8 s apart → each side clipped to 4 s < MIN_WINDOW_S(5) on the shared side → both dropped.
  assert.strictEqual(rs.length, 0);
  const ok = JunctionResponse.responses([P(40), P(52, 'straight', 'K2')], s);
  assert.strictEqual(ok.length, 2);
  assert.strictEqual(ok[0].after.peakRate, 60 * (6 / 6)); // 46-40 = 6 s, all peaks
});

test('responses: passages without GSR coverage on both sides are dropped', () => {
  const s = series(30, () => ({}));
  assert.strictEqual(JunctionResponse.responses([P(2)], s).length, 0); // no "before"
  assert.strictEqual(JunctionResponse.responses([P(28)], s).length, 0); // no "after"
  assert.strictEqual(JunctionResponse.responses([P(15)], s).length, 1);
});

function synthetic(effect) {
  // 16 junctions × (2 turn + 2 straight); after-window peakRate = base + effect for turns.
  const recs = [];
  const rng = JunctionResponse._rng(7);
  for (let j = 0; j < 16; j++) {
    const jBase = rng() * 10; // junction-specific level — the confound pairing removes
    for (const d of ['turn', 'turn', 'straight', 'straight']) {
      const noise = (rng() - 0.5) * 2;
      const after = jBase + noise + (d === 'turn' ? effect : 0);
      recs.push({
        key: `J${j}`,
        decision: d,
        before: { peakRate: jBase, meanPhasic: 0 },
        after: { peakRate: after, meanPhasic: 0 },
        delta: { peakRate: after - jBase, meanPhasic: 0, meanTonic: 0 },
      });
    }
  }
  return recs;
}
const row = (rows, phase, metric) =>
  rows.find((r) => r.phase === phase && r.metric === metric);

test('compare: a planted turn effect is found by the paired test despite big between-junction variation', () => {
  const rows = JunctionResponse.compare(synthetic(3));
  const r = row(rows, 'after', 'peakRate');
  assert.ok(r.pairedP < 0.01, `pairedP ${r.pairedP}`);
  assert.ok(Math.abs(r.pairedMeanDiff - 3) < 0.8, `diff ${r.pairedMeanDiff}`);
  assert.strictEqual(r.pairedN, 16);
});

test('compare: with no effect the paired test does not fire, and the "before" phase is null', () => {
  const rows = JunctionResponse.compare(synthetic(0));
  assert.ok(row(rows, 'after', 'peakRate').pairedP > 0.05);
  assert.ok(row(rows, 'before', 'peakRate').pairedP > 0.9); // identical by construction
});

test('compare: reverse and ambiguous passages are excluded', () => {
  const recs = synthetic(0).concat([
    {
      key: 'X',
      decision: 'ambiguous',
      before: { peakRate: 99, meanPhasic: 0 },
      after: { peakRate: 99, meanPhasic: 0 },
      delta: { peakRate: 0, meanPhasic: 0, meanTonic: 0 },
    },
    {
      key: 'X',
      decision: 'reverse',
      before: { peakRate: 99, meanPhasic: 0 },
      after: { peakRate: 99, meanPhasic: 0 },
      delta: { peakRate: 0, meanPhasic: 0, meanTonic: 0 },
    },
  ]);
  const r = row(JunctionResponse.compare(recs), 'after', 'peakRate');
  assert.strictEqual(r.nTurn + r.nStraight, 64);
});

test('pairedPermutation: fewer than two junctions cannot be tested', () => {
  assert.strictEqual(
    JunctionResponse.pairedPermutation([{ turn: [1], straight: [2] }]).p,
    1,
  );
});

test('compare: per-track level differences are not mistaken for a turn effect', () => {
  // Track B has 5x the GSR amplitude of A; within each track turns == straights.
  const recs = [];
  const rng = JunctionResponse._rng(11);
  for (const [trackId, scale] of [
    ['A', 1],
    ['B', 5],
    ['C', 3],
  ]) {
    for (let i = 0; i < 20; i++) {
      // Make the turn/straight mix uneven: B is mostly turns.
      const d = (trackId === 'B' ? i % 5 !== 0 : i % 5 === 0)
        ? 'turn'
        : 'straight';
      const v = scale * (1 + (rng() - 0.5) * 0.2);
      recs.push({
        key: `${trackId}${i}`,
        trackId,
        decision: d,
        before: { peakRate: v, meanPhasic: v },
        after: { peakRate: v, meanPhasic: v },
        delta: { peakRate: 0, meanPhasic: 0, meanTonic: 0 },
      });
    }
  }
  const r = row(JunctionResponse.compare(recs), 'after', 'meanPhasic');
  assert.strictEqual(r.nTracks, 3);
  assert.ok(r.pooledP > 0.05, `pooledP ${r.pooledP}`);
  // Without the adjustment the same data look hugely "significant".
  const raw = recs.map((x) => ({ ...x, trackId: undefined }));
  assert.ok(
    row(JunctionResponse.compare(raw), 'after', 'meanPhasic').pooledP < 0.05,
  );
});

test('compare: tracks holding only one decision type are ignored by the pooled test', () => {
  const mk = (trackId, d, v) => ({
    key: `${trackId}${v}`,
    trackId,
    decision: d,
    before: { peakRate: v, meanPhasic: v },
    after: { peakRate: v, meanPhasic: v },
    delta: { peakRate: 0, meanPhasic: 0, meanTonic: 0 },
  });
  const recs = [
    ...[1, 2, 3].map((v) => mk('both', 'turn', v)),
    ...[1, 2, 3].map((v) => mk('both', 'straight', v + 0.1)),
    ...[7, 8, 9].map((v) => mk('onlyStraight', 'straight', v)),
  ];
  const r = row(JunctionResponse.compare(recs), 'after', 'meanPhasic');
  assert.strictEqual(r.nTracks, 1);
  assert.strictEqual(r.nTurn + r.nStraight, 6);
});

test('compare: verdict rests on BH q — a lone p<0.05 among many nulls is "suggestive"', () => {
  const rows = JunctionResponse.compare(synthetic(0));
  for (const r of rows)
    assert.ok(['none', 'suggestive', 'supported'].includes(r.verdict));
  assert.ok(rows.every((r) => Number.isFinite(r.q) && r.q >= r.p - 1e-12));
  const strong = JunctionResponse.compare(synthetic(3));
  assert.strictEqual(row(strong, 'after', 'peakRate').verdict, 'supported');
  assert.strictEqual(row(strong, 'after', 'peakRate').test, 'paired');
});

test('compare: too few paired junctions falls back to the pooled test as headline', () => {
  const recs = synthetic(0).filter((r) => Number(r.key.slice(1)) < 3);
  const r = row(JunctionResponse.compare(recs), 'after', 'peakRate');
  assert.strictEqual(r.test, 'pooled');
  assert.strictEqual(r.p, r.pooledP);
});

test('pooled permutation: one huge outlier among few turns does not produce significance', () => {
  const mk = (d, v) => ({
    key: `${d}${v}`,
    trackId: 'A',
    decision: d,
    before: { peakRate: 0, meanPhasic: v },
    after: { peakRate: 0, meanPhasic: v },
    delta: { peakRate: 0, meanPhasic: 0, meanTonic: 0 },
  });
  const recs = [
    ...[0.2, 0.25, 0.3, 0.2, 0.22, 3.0].map((v) => mk('turn', v)),
    ...[0.3, 0.25, 0.2, 0.28, 0.24, 0.3, 0.26, 0.22, 0.3, 0.25].map((v) =>
      mk('straight', v),
    ),
  ];
  const r = row(JunctionResponse.compare(recs), 'after', 'meanPhasic');
  assert.ok(r.pooledP > 0.05, `pooledP ${r.pooledP}`);
  assert.strictEqual(r.test, 'pooled');
});

test('pooled permutation: labels shuffle within track only (a track-level offset is not an effect)', () => {
  const recs = [];
  for (const [t, base] of [
    ['A', 1],
    ['B', 9],
  ]) {
    for (let i = 0; i < 8; i++)
      recs.push({
        key: `${t}${i}`,
        trackId: t,
        decision: i % 2 ? 'turn' : 'straight',
        before: { peakRate: base, meanPhasic: base },
        after: { peakRate: base, meanPhasic: base },
        delta: { peakRate: 0, meanPhasic: 0, meanTonic: 0 },
      });
  }
  const r = row(JunctionResponse.compare(recs), 'after', 'meanPhasic');
  assert.ok(r.pooledP > 0.9, `pooledP ${r.pooledP}`);
});

test('compare: the means shown always agree with the difference tested (paired and pooled)', () => {
  // Paired junctions where turns > straights by exactly 4 within each junction,
  // but junctions differ hugely in level, and there are extra straight-only passages
  // at a low level: pooled means would differ from the paired contrast.
  const recs = [];
  const mk = (key, trackId, d, v) => ({
    key,
    trackId,
    decision: d,
    before: { peakRate: v, meanPhasic: v },
    after: { peakRate: v, meanPhasic: v },
    delta: { peakRate: 0, meanPhasic: 0, meanTonic: 0 },
  });
  for (let j = 0; j < 16; j++) {
    recs.push(mk(`J${j}`, 'A', 'turn', 10 * j + 4));
    recs.push(mk(`J${j}`, 'A', 'straight', 10 * j));
  }
  for (let j = 0; j < 20; j++) recs.push(mk(`S${j}`, 'A', 'straight', 1));
  const r = row(JunctionResponse.compare(recs), 'after', 'peakRate');
  assert.strictEqual(r.test, 'paired');
  assert.ok(Math.abs(r.diff - 4) < 1e-9, `diff ${r.diff}`);
  assert.ok(Math.abs(r.meanTurn - r.meanStraight - r.diff) < 1e-9);
  assert.strictEqual(r.nTurnUsed, 16);
  assert.strictEqual(r.nStraightUsed, 16);
  assert.strictEqual(r.nStraight, 36); // overall usable windows still reported

  const pooledRow = row(
    JunctionResponse.compare(synthetic(0).slice(0, 12)),
    'after',
    'peakRate',
  );
  assert.strictEqual(pooledRow.test, 'pooled');
  assert.ok(
    Math.abs(pooledRow.meanTurn - pooledRow.meanStraight - pooledRow.diff) <
      1e-9,
  );
});

test('compare: control condition provides mid-block baseline and computes junction contrasts', () => {
  // 10 turns (val ~ 5), 10 straights (val ~ 5), 10 controls (val ~ 2) on track T1
  const recs = [];
  const mk = (key, d, v) => ({
    key,
    trackId: 'T1',
    decision: d,
    before: { peakRate: v, meanPhasic: v },
    after: { peakRate: v, meanPhasic: v },
    delta: { peakRate: 0, meanPhasic: 0, meanTonic: 0 },
  });
  for (let i = 0; i < 10; i++) {
    recs.push(mk(`J${i}`, 'turn', 5.0));
    recs.push(mk(`J${i}`, 'straight', 5.0));
    recs.push(mk(`C${i}`, 'control', 2.0));
  }
  const rows = JunctionResponse.compare(recs);
  const r = row(rows, 'after', 'meanPhasic');

  assert.strictEqual(r.nTurn, 10);
  assert.strictEqual(r.nStraight, 10);
  assert.strictEqual(r.nControl, 10);
  assert.ok(Math.abs(r.meanTurn - 5.0) < 0.1);
  assert.ok(Math.abs(r.meanStraight - 5.0) < 0.1);
  assert.ok(Math.abs(r.meanControl - 2.0) < 0.1);

  // Turn vs Straight diff should be ~0
  assert.ok(Math.abs(r.diff) < 0.1, `diff ${r.diff}`);
  // Junction vs Open Road (Straight vs Control) diff should be ~3.0
  assert.ok(
    Math.abs(r.diffJunction - 3.0) < 0.1,
    `diffJunction ${r.diffJunction}`,
  );
  // Straight vs Control should detect the planted effect
  assert.ok(r.pJunction < 0.05, `pJunction ${r.pJunction}`);
});

test('compare: multi-track data with disjoint conditions isolates contrast adjustments', () => {
  // Track T1 has turns (6.0) and straights (2.0), but no controls.
  // Track T2 has straights (2.0) and controls (1.0), but no turns.
  const recs = [];
  const mk = (key, trackId, d, v) => ({
    key,
    trackId,
    decision: d,
    before: { peakRate: v, meanPhasic: v },
    after: { peakRate: v, meanPhasic: v },
    delta: { peakRate: 0, meanPhasic: 0, meanTonic: 0 },
  });

  for (let i = 0; i < 8; i++) {
    recs.push(mk(`J_T1_${i}`, 'T1', 'turn', 6.0));
    recs.push(mk(`J_T1_${i}`, 'T1', 'straight', 2.0));
  }
  for (let i = 0; i < 8; i++) {
    recs.push(mk(`J_T2_${i}`, 'T2', 'straight', 2.0));
    recs.push(mk(`C_T2_${i}`, 'T2', 'control', 1.0));
  }

  const rows = JunctionResponse.compare(recs);
  const r = row(rows, 'after', 'meanPhasic');

  // Counts from usable tracks for Turn vs Straight
  assert.strictEqual(r.nTurn, 8);
  assert.strictEqual(r.nStraight, 8);
  assert.strictEqual(r.nControl, 8);

  // Turn vs Straight contrast should ONLY use T1 (8 turns, 8 straights)
  assert.strictEqual(r.nTurnUsed, 8);
  assert.strictEqual(r.nStraightUsed, 8);
  assert.ok(Math.abs(r.diff - 4.0) < 0.1, `expected diff ~4.0, got ${r.diff}`);
  assert.ok(r.p < 0.05, `expected p < 0.05, got ${r.p}`);

  // Straight vs Control should ONLY use T2 (8 straights, 8 controls)
  assert.strictEqual(r.nControlUsed, 8);
  assert.ok(
    Math.abs(r.diffJunction - 1.0) < 0.1,
    `expected diffJunction ~1.0, got ${r.diffJunction}`,
  );
  assert.ok(
    r.pJunction < 0.05,
    `expected pJunction < 0.05, got ${r.pJunction}`,
  );
});

test('pairedPermutation and _pooledPermutation: handle NaN observations safely without false significance', () => {
  // If inputs are NaN or cause NaN observed statistics, p must return 1, not < 0.001
  const pairedNaN = JunctionResponse.pairedPermutation([
    { turn: [NaN], straight: [1] },
    { turn: [2], straight: [3] },
  ]);
  assert.strictEqual(pairedNaN.p, 1);
  assert.ok(Number.isNaN(pairedNaN.meanDiff));

  const pooledNaN = JunctionResponse._pooledPermutation([
    { v: NaN, inA: true, group: 'A' },
    { v: 1, inA: true, group: 'A' },
    { v: 2, inA: false, group: 'A' },
    { v: 3, inA: false, group: 'A' },
  ]);
  assert.strictEqual(pooledNaN.p, 1);
  assert.ok(Number.isNaN(pooledNaN.meanA));
  assert.ok(Number.isNaN(pooledNaN.meanB));
});

test('compare: passages with all-NaN metrics yield p = 1 and verdict = none without throwing', () => {
  const recs = [
    {
      key: 'J1',
      decision: 'turn',
      before: { peakRate: NaN, meanPhasic: NaN },
      after: { peakRate: NaN, meanPhasic: NaN },
      delta: { peakRate: NaN, meanPhasic: NaN, meanTonic: NaN },
    },
    {
      key: 'J1',
      decision: 'straight',
      before: { peakRate: NaN, meanPhasic: NaN },
      after: { peakRate: NaN, meanPhasic: NaN },
      delta: { peakRate: NaN, meanPhasic: NaN, meanTonic: NaN },
    },
  ];
  const rows = JunctionResponse.compare(recs);
  assert.ok(rows.length > 0);
  for (const r of rows) {
    assert.strictEqual(r.p, 1);
    assert.strictEqual(r.verdict, 'none');
  }
});

test('compare: paired test for Turn vs Straight preserves clean Straight vs Control contrast', () => {
  // 12 paired junctions (Turn = 4.0, Straight = 2.0)
  // Plus 12 controls on the same track with Control = 1.0.
  // Straight vs Control should be exactly 2.0 - 1.0 = 1.0.
  const recs = [];
  const mk = (key, d, v) => ({
    key,
    decision: d,
    before: { peakRate: v, meanPhasic: v },
    after: { peakRate: v, meanPhasic: v },
    delta: { peakRate: 0, meanPhasic: 0, meanTonic: 0 },
  });

  for (let i = 0; i < 16; i++) {
    recs.push(mk(`J_${i}`, 'turn', 4.0));
    recs.push(mk(`J_${i}`, 'straight', 2.0));
    recs.push(mk(`C_${i}`, 'control', 1.0));
  }

  const rows = JunctionResponse.compare(recs);
  const r = row(rows, 'after', 'meanPhasic');

  // Paired test is triggered since pairedN = 16 >= MIN_PAIRED (15)
  assert.strictEqual(r.test, 'paired');
  assert.strictEqual(r.pairedN, 16);
  assert.ok(Math.abs(r.diff - 2.0) < 0.1, `diff ${r.diff}`);

  // diffJunction should reflect Straight (2.0) vs Control (1.0) = 1.0
  assert.ok(
    Math.abs(r.diffJunction - 1.0) < 0.1,
    `expected diffJunction ~1.0, got ${r.diffJunction}`,
  );
  assert.ok(
    r.pJunction < 0.05,
    `expected pJunction < 0.05, got ${r.pJunction}`,
  );
});

test('responses: "after" starts at junction entry, so the traversal (where the response lands) is inside it', () => {
  // Walker enters at t = 100 and exits at t = 112 (12 s crossing).
  // Approach (<100) phasic 2.0; from entry on (the response) 3.0.
  const time = [];
  const phasic = [];
  const tonic = [];
  for (let t = 80; t <= 135; t++) {
    time.push(t);
    phasic.push(t < 100 ? 2.0 : 3.0);
    tonic.push(10.0);
  }
  const series = {
    time,
    phasic,
    tonic,
    isPeak: new Array(time.length).fill(0),
  };
  const passage = {
    key: 'CROSSROADS_1',
    decision: 'turn',
    kind: 'choice',
    time: 100,
    timeEnter: 100,
    timeExit: 112,
  };

  const [r] = JunctionResponse.responses([passage], series);
  assert.strictEqual(r.before.meanPhasic, 2.0); // [90, 100)
  assert.strictEqual(r.after.meanPhasic, 3.0); // [100, 110) — starts at entry, not exit
  assert.strictEqual(r.delta.meanPhasic, 1.0);
});

test('responses: a passage whose traversal exceeds MAX_TRAVERSAL_S is dropped', () => {
  const s = series(300, () => ({ phasic: 1 }));
  const ok = {
    ...P(100),
    timeEnter: 100,
    timeExit: 100 + JunctionResponse.MAX_TRAVERSAL_S,
  };
  const long = {
    ...P(200, 'turn', 'L'),
    timeEnter: 200,
    timeExit: 200 + JunctionResponse.MAX_TRAVERSAL_S + 1,
  };
  const out = JunctionResponse.responses([ok, long], s);
  assert.deepStrictEqual(
    out.map((r) => r.key),
    ['K'],
  );
});

test('compare: multi-track unequal condition distribution preserves exact meanStraight - meanControl === diffJunction arithmetic', () => {
  // Simulates unbalanced multi-walk datasets (like Stokey)
  const recs = [];
  const mk = (key, trackId, d, v) => ({
    key,
    trackId,
    decision: d,
    before: { peakRate: v, meanPhasic: v },
    after: { peakRate: v, meanPhasic: v },
    delta: { peakRate: 0, meanPhasic: 0, meanTonic: 0 },
  });

  // Track 1: mostly turns, low baseline
  for (let i = 0; i < 10; i++) recs.push(mk(`J1_t_${i}`, 'T1', 'turn', 0.2));
  for (let i = 0; i < 2; i++) recs.push(mk(`J1_s_${i}`, 'T1', 'straight', 0.2));
  for (let i = 0; i < 2; i++) recs.push(mk(`C1_c_${i}`, 'T1', 'control', 0.3));

  // Track 2: mostly straights/controls, high baseline
  for (let i = 0; i < 2; i++) recs.push(mk(`J2_t_${i}`, 'T2', 'turn', 0.4));
  for (let i = 0; i < 10; i++)
    recs.push(mk(`J2_s_${i}`, 'T2', 'straight', 0.4));
  for (let i = 0; i < 10; i++) recs.push(mk(`C2_c_${i}`, 'T2', 'control', 0.6));

  const rows = JunctionResponse.compare(recs);
  for (const r of rows) {
    if (!Number.isFinite(r.meanStraight) || !Number.isFinite(r.meanControl))
      continue;
    const expectedDiffJunc = r.meanStraight - r.meanControl;
    assert.ok(
      Math.abs(r.diffJunction - expectedDiffJunc) < 1e-9,
      `diffJunction (${r.diffJunction}) must match meanStraight - meanControl (${expectedDiffJunc})`,
    );
  }
});

test('responses: a window running off the start of the recording is dropped, and a dropout is not counted as quiet time', () => {
  const series = { time: [], phasic: [], tonic: [], isPeak: [] };
  for (let t = 0; t < 100; t += 0.1) {
    // dropout 40–46 s
    if (t >= 40 && t < 46) continue;
    series.time.push(t);
    series.phasic.push(0.1);
    series.tonic.push(1);
    series.isPeak.push(Math.abs(t % 1) < 0.05 ? 1 : 0);
  }
  // Only 5 s of GSR before t=5: window would be [-5,5) → dropped.
  const early = JunctionResponse.responses(
    [{ key: 'a', decision: 'straight', kind: 'choice', time: 5 }],
    series,
  );
  assert.strictEqual(early.length, 0);
  // Clean window: 1 peak/s → 60/min.
  const ok = JunctionResponse.responses(
    [{ key: 'b', decision: 'straight', kind: 'choice', time: 30 }],
    series,
  );
  assert.strictEqual(ok.length, 1);
  assert.ok(Math.abs(ok[0].before.peakRate - 60) < 1.5);
  // Passage at 50: after-window [50,60) is clean but before-window [40,50) is 60% missing → dropped.
  const gap = JunctionResponse.responses(
    [{ key: 'c', decision: 'straight', kind: 'choice', time: 50 }],
    series,
  );
  assert.strictEqual(gap.length, 0);
});

test('responses: lag reads the GSR response that follows the junction, not the walker-time window', () => {
  // A response evoked at the junction (t=50) shows up 3 s later in the GSR:
  // phasic 1 before t=53, 3 from t=53.  peaks only in [53, 63).
  const s = series(120, (t) => ({
    phasic: t < 53 ? 1 : 3,
    peak: t >= 53 && t < 63 && t % 2 === 1,
    tonic: t,
  }));
  const p = [P(50)];

  // No lag: the 'after' window [50, 60) is contaminated by pre-response samples.
  const [plain] = JunctionResponse.responses(p, s);
  assert.ok(plain.after.meanPhasic < 3);

  // Lag 3 s: 'before' = GSR in [43, 53) (all baseline), 'after' = [53, 63).
  const lag = { phasic: 3, tonic: 3 };
  const [r] = JunctionResponse.responses(p, s, { lag });
  assert.strictEqual(r.before.meanPhasic, 1);
  assert.strictEqual(r.after.meanPhasic, 3);
  assert.strictEqual(r.before.peakRate, 0);
  assert.strictEqual(r.after.peakRate, 30);
  // tonic ramps 1/s, so each window's mean shifts by exactly the lag
  assert.strictEqual(plain.before.meanTonic + 3, r.before.meanTonic);
});

test('responses: tonic uses its own (longer) lag', () => {
  const s = series(120, (t) => ({ tonic: t }));
  const [a] = JunctionResponse.responses([P(50)], s, {
    lag: { phasic: 0, tonic: 0 },
  });
  const [b] = JunctionResponse.responses([P(50)], s, {
    lag: { phasic: 0, tonic: 8 },
  });
  assert.strictEqual(b.before.meanTonic - a.before.meanTonic, 8);
});

// ── compareJunctionVsRoad: any junction (whatever the walker did) vs plain road ──
function overviewRecs({ junctionShift = 0, peakShift = 0 } = {}) {
  const recs = [];
  const decisions = ['turn', 'straight', 'reverse', 'ambiguous', 'control'];
  for (const trackId of ['A', 'B', 'C']) {
    // per-walk level offset the adjustment has to remove
    const walk = trackId === 'A' ? 0 : trackId === 'B' ? 1 : 2;
    for (let i = 0; i < 40; i++) {
      const decision = decisions[i % decisions.length];
      const isRoad = decision === 'control';
      const noise = ((i * 37) % 11) / 100; // deterministic, ~±0.05
      const level = walk + noise + (isRoad ? 0 : junctionShift);
      const rate = 10 + noise * 10 + (isRoad ? 0 : peakShift);
      recs.push({
        key: `${trackId}${i}`,
        trackId,
        decision,
        before: { meanPhasic: level, peakRate: rate, meanTonic: 0 },
        after: { meanPhasic: level, peakRate: rate, meanTonic: 0 },
        delta: { meanPhasic: 0, peakRate: 0, meanTonic: 0 },
      });
    }
  }
  return recs;
}

test('compareJunctionVsRoad: reverse and ambiguous count as junction passages', () => {
  const rows = JunctionResponse.compareJunctionVsRoad(overviewRecs());
  const level = rows.find((r) => r.metric === 'meanPhasic');
  // per walk: 8 each of turn/straight/reverse/ambiguous (32 junction) + 8 road
  assert.strictEqual(level.nJunction, 96);
  assert.strictEqual(level.nRoad, 24);
  assert.strictEqual(level.nTracks, 3);
});

test('compareJunctionVsRoad: a planted junction effect is supported, a walk-level offset is not', () => {
  const planted = JunctionResponse.compareJunctionVsRoad(
    overviewRecs({ junctionShift: 0.3, peakShift: 3 }),
  );
  for (const m of ['meanPhasic', 'peakRate']) {
    const r = planted.find((x) => x.metric === m);
    assert.strictEqual(r.verdict, 'supported', `${m} q=${r.q}`);
    assert.ok(r.diff > 0);
  }
  // no junction effect: the 0/1/2 µS walk offsets must not leak in as one
  const none = JunctionResponse.compareJunctionVsRoad(overviewRecs());
  for (const r of none) {
    assert.strictEqual(r.verdict, 'none', `${r.metric} p=${r.p}`);
    assert.ok(Math.abs(r.diff) < 0.05);
  }
});

test('compareJunctionVsRoad: needs both groups', () => {
  const onlyJunctions = overviewRecs().filter((r) => r.decision !== 'control');
  const rows = JunctionResponse.compareJunctionVsRoad(onlyJunctions);
  assert.ok(rows.every((r) => r.verdict === 'none' && r.p === 1));
});

test('compare: below MIN_PAIRED the paired test is skipped and the pooled test is reported', () => {
  // Only 4 junctions have both a turn and a straight.
  const recs = synthetic(3).filter((r) => Number(r.key.slice(1)) < 4);
  const r = row(JunctionResponse.compare(recs), 'after', 'peakRate');
  assert.strictEqual(r.test, 'pooled');
  assert.strictEqual(r.pairedN, 4);
  assert.ok(Number.isNaN(r.pairedP));
  assert.strictEqual(r.p, r.pooledP);
});
