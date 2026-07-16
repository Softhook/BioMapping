const { OSMEnricher } = require('../osm_enrichment.js');

let passed = 0;
let failed = 0;
const capturedLogs = [];

function assert(condition, msg) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error('  FAIL:', msg);
  }
}

function assertDoesNotThrow(fn, msg) {
  try {
    fn();
    passed++;
  } catch (err) {
    failed++;
    console.error('  FAIL:', msg, '-', err && err.message ? err.message : err);
  }
}

const originalConsole = {
  group: console.group,
  log: console.log,
  groupEnd: console.groupEnd
};

console.group = () => {};
console.log = (...args) => { capturedLogs.push(args); };
console.groupEnd = () => {};

assertDoesNotThrow(() => {
  OSMEnricher._logSnapDiagnostics({
    snappedGps: [
      undefined,
      { lat: NaN, lon: NaN },
      { lat: 51.5, lon: -0.1, alpha: undefined, dist: undefined },
      { lat: '51.5001', lon: '-0.1001', alpha: '0.5', dist: '12.3', wayId: 42 },
      { lat: 51.5002, lon: -0.1002, alpha: 1, dist: 0, wayId: 42 }
    ]
  }, [], 2);
}, 'OSM diagnostics tolerate sparse and partial snappedGps entries');

assertDoesNotThrow(() => {
  OSMEnricher._logSnapDiagnostics({
    snappedGps: new Array(4)
  }, [], 0);
}, 'OSM diagnostics tolerate fully sparse snappedGps arrays');

capturedLogs.length = 0;
OSMEnricher._logSnapDiagnostics({
  snappedGps: [
    { lat: 51.5, lon: -0.1, alpha: 0.25, dist: 4.4, wayId: 7 },
    { lat: 51.5001, lon: -0.1001, alpha: 1, dist: 10.2, wayId: 7 }
  ]
}, [], 2);

assert(
  capturedLogs.some(args => args[0] === 'Max α:' && args[1] === '1.00' && args[3] === '0.63'),
  'OSM diagnostics log formatted alpha summary for valid snapped points'
);
assert(
  capturedLogs.some(args => args[0] === 'Distance to road:  min:' && args[1] === '4.4m' && args[3] === '10.2m' && args[5] === '7.3m'),
  'OSM diagnostics log formatted distance summary for valid snapped points'
);

console.group = originalConsole.group;
console.log = originalConsole.log;
console.groupEnd = originalConsole.groupEnd;

assert(failed === 0, 'No OSM enrichment diagnostic regressions');

console.log(`OSM enrichment diagnostics: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
