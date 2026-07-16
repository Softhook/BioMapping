const { OSMEnricher } = require('../osm_enrichment.js');

let passed = 0;
let failed = 0;

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
console.log = () => {};
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

console.group = originalConsole.group;
console.log = originalConsole.log;
console.groupEnd = originalConsole.groupEnd;

assert(failed === 0, 'No OSM enrichment diagnostic regressions');

console.log(`OSM enrichment diagnostics: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
