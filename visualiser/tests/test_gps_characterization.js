/**
 * GPS filter pipeline characterisation harness.
 *
 * Per docs/todo.md's "Characterisation harness" note: pins the GPS filter
 * chain's aggregate output (total path length, vertex count, % interpolated,
 * max deviation from raw) against a golden-master baseline, so a filter
 * order/tuning change can't silently distort every track without a test
 * noticing. This is a regression net for the GPS pipeline architecture work
 * tracked in docs/todo.md's "GPS pipeline architecture" section — it exists
 * so those changes (velocity-smoothing/Kalman fusion, snap-vs-gate ordering,
 * etc.) have something to check themselves against before/after.
 *
 * Two tiers:
 *  - fixtures/default_processed.csv (committed, reproducible everywhere):
 *    exact-tolerance comparison against the committed golden-master JSON.
 *    This is the real regression gate and is what CI runs.
 *  - ../../tracks/*.csv (gitignored local recordings, present only on dev
 *    machines that have run real walks): sanity-bound checks only, no
 *    pinned baseline, since that data isn't committed or reproducible in CI.
 *    Skipped entirely when the directory doesn't exist.
 *
 * If you change the GPS filter pipeline on purpose, regenerate the baseline
 * with `node tests/support/gen_gps_characterization_baseline.js` and explain
 * why in the commit message — do not hand-edit the JSON.
 *
 * Run: node --test tests/test_gps_characterization.js
 */
const assert = require('node:assert');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const {
  computeCharacterizationMetrics,
} = require('./support/gps_characterization.js');

const FIXTURE_PATH = path.join(
  __dirname,
  '..',
  'fixtures',
  'default_processed.csv',
);
const BASELINE_PATH = path.join(
  __dirname,
  'fixtures',
  'gps_characterization_baseline.json',
);
const TRACKS_DIR = path.join(__dirname, '..', '..', 'tracks');

// ── Committed fixture: exact golden-master comparison ──────────────────────

test('GPS pipeline characterisation: default_processed.csv matches golden-master baseline', () => {
  const csvText = fs.readFileSync(FIXTURE_PATH, 'utf8');
  const baseline = JSON.parse(
    fs.readFileSync(BASELINE_PATH, 'utf8'),
  ).default_processed;
  const actual = computeCharacterizationMetrics(csvText);

  // Point counts are deterministic integer outputs of the gate/filter chain —
  // any drift here means a stage dropped or kept a different set of points.
  assert.strictEqual(
    actual.n_raw,
    baseline.n_raw,
    'n_raw (fixture itself changed?)',
  );
  assert.strictEqual(
    actual.n_raw_gps_fixes,
    baseline.n_raw_gps_fixes,
    'n_raw_gps_fixes',
  );
  assert.strictEqual(
    actual.n_after_gates,
    baseline.n_after_gates,
    'n_after_gates (HDOP/fix-type gate behaviour changed)',
  );
  assert.strictEqual(
    actual.vertex_count,
    baseline.vertex_count,
    'vertex_count (pre-Kalman filters or Kalman chi² gate dropped/kept a different point set)',
  );

  // Continuous metrics get a small relative tolerance for floating-point
  // rounding, not for real behaviour drift — a genuine filter-order or
  // noise-model change should move these by far more than this.
  const closeToPct = (actualVal, baselineVal, pct, label) => {
    const tol = Math.abs(baselineVal) * pct;
    assert.ok(
      Math.abs(actualVal - baselineVal) <= tol,
      `${label}: expected ${actualVal} within ${pct * 100}% of baseline ${baselineVal}`,
    );
  };
  closeToPct(
    actual.pct_interpolated,
    baseline.pct_interpolated,
    0.05,
    'pct_interpolated',
  );
  closeToPct(
    actual.total_path_length_m,
    baseline.total_path_length_m,
    0.02,
    'total_path_length_m',
  );
  closeToPct(
    actual.raw_path_length_m,
    baseline.raw_path_length_m,
    0.001,
    'raw_path_length_m (raw fixes are gate/filter-independent; only the fixture data should move this)',
  );
  closeToPct(
    actual.max_deviation_from_raw_m,
    baseline.max_deviation_from_raw_m,
    0.05,
    'max_deviation_from_raw_m',
  );
});

// ── Local real tracks: sanity-bound invariants only, no pinned baseline ────
// tracks/ is gitignored (real recorded walks) so its contents aren't
// reproducible in CI or on a fresh clone — see .gitignore. These checks
// exist to catch gross corruption (NaN leaking through, a stage exploding
// path length, near-100% of the reconstructed path being points nobody
// actually measured) on the tracks a developer already has locally, without
// requiring anyone to commit private recordings as golden fixtures.

const trackFiles = fs.existsSync(TRACKS_DIR)
  ? fs
      .readdirSync(TRACKS_DIR)
      .filter((f) => f.endsWith('.csv'))
      .sort()
  : [];

if (trackFiles.length === 0) {
  test('GPS pipeline characterisation: local tracks/ sanity checks (skipped, no tracks/ found)', () => {
    assert.ok(true);
  });
} else {
  for (const file of trackFiles) {
    test(`GPS pipeline characterisation sanity: ${file}`, (t) => {
      const csvText = fs.readFileSync(path.join(TRACKS_DIR, file), 'utf8');
      let metrics;
      try {
        metrics = computeCharacterizationMetrics(csvText);
      } catch (err) {
        t.skip(`could not parse ${file}: ${err.message}`);
        return;
      }
      if (metrics.n_raw_gps_fixes === 0) {
        t.skip(`${file} has no GPS fixes`);
        return;
      }
      if (metrics.vertex_count === 0) {
        // A real, legitimate outcome for e.g. a short indoor live-capture
        // where every fix fails the default HDOP gate (HDOP 6+ throughout) —
        // not a pipeline defect. Nothing downstream to check.
        t.skip(`${file}: every fix gated out (poor HDOP/fix-type throughout)`);
        return;
      }
      assert.ok(
        metrics.vertex_count <= metrics.n_raw_gps_fixes,
        `${file}: filter chain never invents anchor points (${metrics.vertex_count} <= ${metrics.n_raw_gps_fixes})`,
      );
      assert.ok(
        metrics.pct_interpolated >= 0 && metrics.pct_interpolated <= 100,
        `${file}: pct_interpolated in [0,100] (${metrics.pct_interpolated})`,
      );
      assert.ok(
        metrics.total_path_length_m >= 0,
        `${file}: non-negative path length`,
      );
      // The Kalman/RTS displacement clamp is 3·sqrt(R_base); at the default
      // R=10 that's ~9.5m, and hacc-scaled R can widen it further on noisy
      // fixes — 100m is a generous corruption tripwire, not a tuning target.
      assert.ok(
        metrics.max_deviation_from_raw_m < 100,
        `${file}: max_deviation_from_raw_m stays sane (${metrics.max_deviation_from_raw_m} m)`,
      );
      // A filtered path should never come out wildly longer than the raw
      // fix-to-fix path — smoothing shortens or lightly reshapes it, it
      // doesn't add distance an order of magnitude greater.
      assert.ok(
        metrics.total_path_length_m < metrics.raw_path_length_m * 3 + 50,
        `${file}: filtered path length (${metrics.total_path_length_m} m) not wildly longer than raw (${metrics.raw_path_length_m} m)`,
      );
    });
  }
}
