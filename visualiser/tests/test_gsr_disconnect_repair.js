const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { loadModule } = require('./support/load_module.js');

loadModule(
  path.join(__dirname, '../src/signal/gsr_disconnect_repair.js'),
  'GsrDisconnectRepair',
);
const { detectAndRepairGsrDisconnects } = global;

function mkRaw(vals) {
  return vals.map((val, i) => ({ time: i * 0.1, val }));
}

test('detectAndRepairGsrDisconnects: clean signal (no bit-exact repeats) — no spans, values untouched', () => {
  const vals = [];
  for (let i = 0; i < 40; i++) vals.push(5000 + i * 3.7 + (i % 3));
  const raw = mkRaw(vals);
  const { vals: out, spans } = detectAndRepairGsrDisconnects(raw);
  assert.deepStrictEqual(out, vals);
  assert.deepStrictEqual(spans, []);
});

test('detectAndRepairGsrDisconnects: mid-track dropout is bridged with a straight line', () => {
  // 0-9: normal baseline. 10-15: pinned open-circuit floor. 16-20: reconnect
  // transient (bounce spike, RC settling). 21-29: normal baseline resumes.
  const vals = [
    5000,
    5001,
    5002,
    5003,
    5004,
    5005,
    5006,
    5007,
    5008,
    5009, // 0-9
    100,
    100,
    100,
    100,
    100,
    100, // 10-15 (flat floor, len 6)
    900,
    4800,
    5010,
    5011,
    5012, // 16-20 (transient, settles by 20)
    5013,
    5014,
    5015,
    5016,
    5017,
    5018,
    5019,
    5020,
    5021, // 21-29
  ];
  const raw = mkRaw(vals);
  const { vals: out, spans } = detectAndRepairGsrDisconnects(raw);

  assert.strictEqual(spans.length, 1);
  assert.strictEqual(spans[0].repaired, true);
  assert.strictEqual(spans[0].startIdx, 10);
  assert.strictEqual(spans[0].endIdx, 20);

  // Anchors themselves are untouched.
  assert.strictEqual(out[9], 5009);
  assert.strictEqual(out[21], 5013);
  // Time-midpoint between the two anchors (idx 9 @ t=0.9, idx 21 @ t=2.1) is
  // idx 15 @ t=1.5 — exactly halfway, so it must land on the arithmetic mean.
  assert.strictEqual(out[15], (5009 + 5013) / 2);
  // Every bridged sample lies strictly between the two anchors and rises
  // monotonically — a real straight line, not a clamp to one endpoint.
  for (let i = 11; i <= 19; i++) {
    assert.ok(out[i] > out[i - 1], `index ${i} should be strictly rising`);
  }
  assert.ok(out[10] > 5009 && out[20] < 5013);

  // Everything outside the span is untouched.
  for (let i = 0; i < 10; i++) assert.strictEqual(out[i], vals[i]);
  for (let i = 21; i < vals.length; i++) assert.strictEqual(out[i], vals[i]);
});

test('detectAndRepairGsrDisconnects: cuffs not yet attached at recording start — detected but left unrepaired (no left anchor)', () => {
  // 0-9: pinned floor from the very first sample. 10-14: reconnect transient.
  // 15-29: normal baseline once contact is made.
  const vals = [
    100,
    100,
    100,
    100,
    100,
    100,
    100,
    100,
    100,
    100, // 0-9
    900,
    4800,
    5010,
    5011,
    5012, // 10-14 (transient, settles by 14)
    5013,
    5014,
    5015,
    5016,
    5017,
    5018,
    5019,
    5020,
    5021,
    5022,
    5023,
    5024,
    5025,
    5026,
    5027, // 15-29
  ];
  const raw = mkRaw(vals);
  const { vals: out, spans } = detectAndRepairGsrDisconnects(raw);

  assert.strictEqual(spans.length, 1);
  assert.strictEqual(spans[0].repaired, false);
  assert.strictEqual(spans[0].startIdx, 0);
  // Nothing was rewritten — there's no earlier good sample to draw a line from.
  assert.deepStrictEqual(out, vals);
});

test('detectAndRepairGsrDisconnects: cuffs removed and never reattached before recording stops — left unrepaired (no right anchor)', () => {
  const vals = [
    5000,
    5001,
    5002,
    5003,
    5004,
    5005,
    5006,
    5007,
    5008,
    5009, // 0-9
    100,
    100,
    100,
    100,
    100,
    100,
    100,
    100, // 10-17 (floor, runs to EOF)
  ];
  const raw = mkRaw(vals);
  const { vals: out, spans } = detectAndRepairGsrDisconnects(raw);

  assert.strictEqual(spans.length, 1);
  assert.strictEqual(spans[0].repaired, false);
  assert.strictEqual(spans[0].endIdx, vals.length - 1);
  assert.deepStrictEqual(out, vals);
});

test('detectAndRepairGsrDisconnects: bouncing reconnection (flicker) merges into one bridged span', () => {
  // Electrode makes intermittent contact while being attached: a floor run,
  // a brief non-repeating blip that is itself still garbage, then another
  // floor run, before it finally settles. Each floor run is 6 samples (0.5s
  // at this 10Hz spacing) to clear minFlatSeconds on its own.
  const vals = [
    5000,
    5001,
    5002,
    5003,
    5004,
    5005,
    5006,
    5007,
    5008,
    5009, // 0-9
    100,
    100,
    100,
    100,
    100,
    100, // 10-15 (floor run A)
    180, // 16 (partial-contact blip, not a repeat)
    100,
    100,
    100,
    100,
    100,
    100, // 17-22 (floor run B)
    900,
    4800,
    5010,
    5011,
    5012, // 23-27 (transient, settles by 27)
    5013,
    5014,
    5015,
    5016, // 28-31
  ];
  const raw = mkRaw(vals);
  const { spans } = detectAndRepairGsrDisconnects(raw);

  assert.strictEqual(
    spans.length,
    1,
    'the blip between the two floor runs must not create a separate, unbridged gap',
  );
  assert.strictEqual(spans[0].repaired, true);
  assert.strictEqual(spans[0].startIdx, 10);
});

test('detectAndRepairGsrDisconnects: a reconnect transient that never settles before a second, later disconnect does not anchor inside it', () => {
  // Pathological case: disconnect A's recovery never damps down (kept
  // oscillating instead of settling) before disconnect B begins. The old
  // implementation would treat B's own flat run as "A has settled" and
  // silently draw a straight line into still-disconnected data — the two
  // reported spans even overlapped. A must come back unrepaired (it never
  // found a legitimate settled sample before hitting B's territory); B may
  // still repair off its own far side.
  const vals = [];
  for (let v = 0; v < 10; v++) vals.push(5000 + v); // 0-9 baseline
  for (let v = 0; v < 6; v++) vals.push(100); // 10-15 disconnect A floor
  for (let v = 0; v < 40; v++) vals.push(v % 2 === 0 ? 900 : 50); // 16-55 never settles
  for (let v = 0; v < 6; v++) vals.push(100); // 56-61 disconnect B floor
  for (let v = 0; v < 10; v++) vals.push(5000 + v); // 62-71 baseline resumes

  const raw = mkRaw(vals);
  const { spans } = detectAndRepairGsrDisconnects(raw);

  assert.strictEqual(spans.length, 2);
  const [a, b] = spans;
  assert.ok(
    a.endIdx < b.startIdx,
    `spans must not overlap: A=[${a.startIdx},${a.endIdx}] B=[${b.startIdx},${b.endIdx}]`,
  );
  assert.strictEqual(
    a.repaired,
    false,
    'A never found a genuinely settled sample, so it must not fabricate one',
  );
  assert.strictEqual(a.startIdx, 10);
});

test('detectAndRepairGsrDisconnects: a coincidental flat stretch at a normal signal level is not flagged', () => {
  // Six identical samples at 5005 — long enough to clear minFlatSeconds —
  // but sitting between neighbours of 5004/5006. A real disconnect floor
  // sits far below (or, in resistance mode, far above) the surrounding
  // signal; this one doesn't, so it must not be reported or rewritten.
  const vals = [
    5000,
    5001,
    5002,
    5003,
    5004, // 0-4
    5005,
    5005,
    5005,
    5005,
    5005,
    5005, // 5-10
    5006,
    5007,
    5008,
    5009,
    5010, // 11-15
  ];
  const raw = mkRaw(vals);
  const { vals: out, spans } = detectAndRepairGsrDisconnects(raw);
  assert.deepStrictEqual(spans, []);
  assert.deepStrictEqual(out, vals);
});

test('detectAndRepairGsrDisconnects: a non-finite anchor value is never used to repair', () => {
  // Index 9 (the would-be left anchor) is itself NaN — defensively guard
  // against propagating that into the interpolated span instead of silently
  // producing NaN-poisoned samples.
  const vals = [
    5000,
    5001,
    5002,
    5003,
    5004,
    5005,
    5006,
    5007,
    5008,
    NaN, // 0-9
    100,
    100,
    100,
    100,
    100,
    100, // 10-15 (disconnect floor)
    900,
    4800,
    5010,
    5011,
    5012, // 16-20 (transient, settles by 20)
    5013,
    5014,
    5015,
    5016,
    5017, // 21-25
  ];
  const raw = mkRaw(vals);
  const { vals: out, spans } = detectAndRepairGsrDisconnects(raw);

  assert.strictEqual(spans.length, 1);
  assert.strictEqual(spans[0].repaired, false);
  assert.ok(
    out.slice(10, 21).every(Number.isFinite),
    'no NaN must leak into the span just because one anchor was unusable',
  );
});
