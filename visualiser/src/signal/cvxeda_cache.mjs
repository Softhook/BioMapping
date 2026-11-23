/**
 * Recent cvxEDA answers, kept outside the solver: cvxeda.mjs is the
 * reference port and stays as it is.
 *
 * Collective view re-analyses every walk whenever anything changes, and a
 * peak-slider move re-analyses the open walk, but a cvxEDA answer depends
 * only on the signal, the sample rate and the solver settings. So a repeat
 * call with all three unchanged gets a copy of the earlier answer instead of
 * a fresh solve, which takes seconds on a long walk.
 */

import { GSR_CONST } from '../core/constants.mjs';
import { CVXEDA } from './cvxeda.mjs';

// Each remembered sample costs ~40 bytes: the signal plus the phasic, tonic,
// driver and residual arrays of the answer.
const MAX_SAMPLES = 400000; // ~11 h of 10 Hz recording
const recent = []; // oldest first: { key, y, res }

// Object.is: a NaN sample matches a NaN, and 0 never matches -0.
function sameValues(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}

// Callers may write into the arrays they get back; the remembered answer
// must not change with them.
function copyResult(res) {
  return {
    ...res,
    phasic: res.phasic.slice(),
    tonic: res.tonic.slice(),
    driver: res.driver.slice(),
    l: res.l.slice(),
    d: res.d.slice(),
    e: res.e.slice(),
  };
}

export const CvxedaCache = {
  /** CVXEDA.decompose(), answered from memory when nothing has changed. */
  decompose(y, sampleRate, options = {}) {
    // The solver fills any setting left out from GSR_CONST.CVXEDA, so those
    // are part of the key too.
    const key = JSON.stringify([sampleRate, options, GSR_CONST.CVXEDA]);
    for (let k = recent.length - 1; k >= 0; k--) {
      const hit = recent[k];
      if (hit.key === key && sameValues(hit.y, y)) {
        recent.splice(k, 1);
        recent.push(hit);
        return copyResult(hit.res);
      }
    }
    const res = CVXEDA.decompose(y, sampleRate, options);
    if (y.length <= MAX_SAMPLES) {
      recent.push({ key, y: Float64Array.from(y), res: copyResult(res) });
      let held = 0;
      for (const c of recent) held += c.y.length;
      while (held > MAX_SAMPLES) held -= recent.shift().y.length;
    }
    return res;
  },

  /** Forget every answer (the track library was emptied). */
  clear() {
    recent.length = 0;
  },
};
