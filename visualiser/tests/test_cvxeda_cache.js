/**
 * CvxedaCache (src/signal/cvxeda_cache.mjs): recent cvxEDA answers kept
 * outside the solver. A repeat call must give exactly the solver's own
 * answer, callers must not be able to change a remembered answer, and any
 * change of signal, setting or default must reach the solver again.
 *
 * Run: node --test tests/test_cvxeda_cache.js
 */

const assert = require('node:assert');
const test = require('node:test');

const { GSR_CONST } = require('../src/core/constants.mjs');
const { CVXEDA } = require('../src/signal/cvxeda.mjs');
const { CvxedaCache } = require('../src/signal/cvxeda_cache.mjs');

const SR = 10;
const FIELDS = ['phasic', 'tonic', 'driver', 'l', 'd', 'e'];

function signal(n, phase) {
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    y[i] = 2 + 0.3 * Math.sin(i / 37 + phase) + (i % 97 === 0 ? 0.4 : 0);
  }
  return y;
}

/** Run fn with CVXEDA.decompose counted; returns how often it was called. */
function solves(fn) {
  const real = CVXEDA.decompose;
  let calls = 0;
  CVXEDA.decompose = (...args) => {
    calls++;
    return real.apply(CVXEDA, args);
  };
  try {
    fn();
  } finally {
    CVXEDA.decompose = real;
  }
  return calls;
}

test('CvxedaCache: a repeat call gives exactly the solver’s answer, without solving', () => {
  const y = signal(500, 0.1);
  const direct = CVXEDA.decompose(y, SR, { alpha: 3e-3 });
  let first;
  let again;
  assert.strictEqual(
    solves(() => {
      first = CvxedaCache.decompose(y, SR, { alpha: 3e-3 });
    }),
    1,
  );
  assert.strictEqual(
    solves(() => {
      again = CvxedaCache.decompose(Float64Array.from(y), SR, {
        alpha: 3e-3,
      });
    }),
    0,
  );
  for (const res of [first, again]) {
    for (const k of FIELDS) {
      assert.deepStrictEqual(Array.from(res[k]), Array.from(direct[k]), k);
    }
    assert.strictEqual(res.obj, direct.obj);
    assert.strictEqual(res.iterations, direct.iterations);
    assert.strictEqual(res.converged, direct.converged);
  }
});

test('CvxedaCache: writing into an answer does not change the next one', () => {
  const y = signal(400, 0.7);
  const keep = Array.from(CvxedaCache.decompose(y, SR).phasic);
  for (let k = 0; k < 3; k++) {
    const res = CvxedaCache.decompose(y, SR);
    assert.deepStrictEqual(Array.from(res.phasic), keep);
    res.phasic.fill(99);
    res.driver.fill(99);
  }
});

test('CvxedaCache: a changed signal, setting or default solves again', () => {
  const y = signal(400, 1.3);
  CvxedaCache.decompose(y, SR);
  assert.strictEqual(
    solves(() => CvxedaCache.decompose(y, SR)),
    0,
  );

  const y2 = Float64Array.from(y);
  y2[200] += 0.5;
  assert.strictEqual(
    solves(() => CvxedaCache.decompose(y2, SR)),
    1,
    'signal',
  );
  assert.strictEqual(
    solves(() => CvxedaCache.decompose(y, SR, { alpha: 0.05 })),
    1,
    'setting',
  );
  assert.strictEqual(
    solves(() => CvxedaCache.decompose(y, 20)),
    1,
    'sample rate',
  );

  const knots = GSR_CONST.CVXEDA.deltaKnotSec;
  GSR_CONST.CVXEDA.deltaKnotSec = knots + 5;
  try {
    assert.strictEqual(
      solves(() => CvxedaCache.decompose(y, SR)),
      1,
      'default setting',
    );
  } finally {
    GSR_CONST.CVXEDA.deltaKnotSec = knots;
  }
});

test('CvxedaCache: a NaN in the signal still matches; 0 and -0 do not', () => {
  const y = signal(300, 2.1);
  y[50] = Number.NaN;
  CvxedaCache.decompose(y, SR);
  assert.strictEqual(
    solves(() => CvxedaCache.decompose(Float64Array.from(y), SR)),
    0,
  );
  const z = signal(300, 2.9);
  z[10] = 0;
  CvxedaCache.decompose(z, SR);
  const zNeg = Float64Array.from(z);
  zNeg[10] = -0;
  assert.strictEqual(
    solves(() => CvxedaCache.decompose(zNeg, SR)),
    1,
  );
});

test('CvxedaCache: clear() forgets every answer', () => {
  const y = signal(300, 3.7);
  CvxedaCache.decompose(y, SR);
  CvxedaCache.clear();
  assert.strictEqual(
    solves(() => CvxedaCache.decompose(y, SR)),
    1,
  );
});
