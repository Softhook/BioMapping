/**
 * Gives a hand-built stand-in analyzer (a plain object with .raw and
 * .getCoordinates) the Response delay lookups a real GSRAnalyzer has, backed
 * by the real signal/response_delay.mjs — so tests that build a minimal walk
 * by hand still exercise the app's own pairing.
 */
const { ResponseDelay } = require('../../src/signal/response_delay.mjs');

function withJoin(a, delay = 0) {
  a.responseDelay = delay;
  a.maxResponseDelay = ResponseDelay.MAX_S;
  a.setResponseDelay = (s) => {
    a.responseDelay = ResponseDelay.normalise(s);
  };
  a.placeOf = (i) => ResponseDelay.placeOf(a, i);
  a.placeRowOf = (i) => ResponseDelay.placeRowOf(a, i);
  a.readingAt = (j) => ResponseDelay.readingAt(a, j);
  a.onTime = (i) => ResponseDelay.onTime(a, i);
  return a;
}

module.exports = { withJoin };
