/**
 * Hotspot ("memorable event") selection — GSRAnalyzer._selectMemorableEvents.
 *
 * Contract:
 *   - ranked by peak amplitude, descending (biggest response first);
 *   - count target = round(activePeaks * hotspotPercentile), at least 1;
 *   - no two hotspots closer than MEMORABLE_EVENTS.MIN_SEPARATION_M — the
 *     biggest in any neighbourhood wins, nearby smaller ones are dropped;
 *   - peaks with no GPS fix, and excluded peaks, are skipped;
 *   - a spatially compact recording can yield fewer than the target.
 *
 * Run: node visualiser/tests/test_hotspot_selection.js
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

global.window = global;
global.GSR_CONST = require('./mock_constants.js');

function loadModule(filePath, varName) {
  const src = fs.readFileSync(filePath, 'utf8');
  const wrapped = src
    .replace(new RegExp(`class ${varName}\\s*{`), `global.${varName} = class ${varName} {`)
    .replace(new RegExp(`const ${varName}\\s*=`), `global.${varName} =`);
  vm.runInThisContext(wrapped, { filename: filePath });
}
loadModule(path.join(__dirname, '../src/signal/dwt_filter.js'), 'DWT');
loadModule(path.join(__dirname, '../src/signal/gsr_filter.js'), 'GsrFilter');
loadModule(path.join(__dirname, '../src/signal/deconvolution.js'), 'SCRDeconvolution');
loadModule(path.join(__dirname, '../src/signal/csv_parser.js'), 'GSRCSVParser');
loadModule(path.join(__dirname, '../src/signal/analyzer.js'), 'GSRAnalyzer');
const { GSRAnalyzer } = global;
const MIN_SEP = global.GSR_CONST.MEMORABLE_EVENTS.MIN_SEPARATION_M; // 30 m

let passed = 0, failed = 0;
const assert = (c, m) => { c ? passed++ : (failed++, console.error('  FAIL:', m)); };

// Build an analyzer with a hand-placed peak list. `spec` entries:
//   { amp, lat, lon, excluded?, noGps? }
function makeAnalyzer(spec) {
  const a = new GSRAnalyzer();
  a.raw = [];
  a.peaks = [];
  a.filteredGps = [];
  spec.forEach((s, i) => {
    a.raw[i] = s.noGps ? { time: i, val: 1 } : { time: i, val: 1, lat: s.lat, lon: s.lon };
    a.peaks.push({ index: i, time: i, amplitude: s.amp, excluded: !!s.excluded, salienceScore: 0.5 });
  });
  return a;
}

const A   = { lat: 51.5000,  lon: -0.1000 };
const A5  = { lat: 51.50004, lon: -0.1000 };  // ~4.4 m north of A
const B   = { lat: 51.5100,  lon: -0.1000 };  // ~1.1 km from A
const C   = { lat: 51.5000,  lon: -0.1100 };  // ~700 m from A
const Dp  = { lat: 51.4900,  lon: -0.1000 };  // far

// ── 1. Amplitude ranking ────────────────────────────────────────────────────
{
  const a = makeAnalyzer([
    { amp: 0.30, ...A }, { amp: 0.90, ...B }, { amp: 0.50, ...C },
    { amp: 1.00, ...Dp }, { amp: 0.10, lat: 51.4800, lon: -0.1000 },
  ]);
  const hs = a._selectMemorableEvents({ hotspotPercentile: 0.60 }); // target 3
  assert(hs.length === 3, `picks the target count (got ${hs.length})`);
  assert(hs.map(p => p.amplitude).join(',') === '1,0.9,0.5',
    `picks the 3 biggest, amplitude-descending (got ${hs.map(p => p.amplitude).join(',')})`);
}

// ── 2. Spatial spacing: biggest in a cluster wins, nearby smaller dropped ────
{
  const a = makeAnalyzer([
    { amp: 1.00, ...A },   // biggest, at A
    { amp: 0.90, ...A5 },  // 2nd biggest, ~4 m from A -> dropped
    { amp: 0.80, ...B },   // far -> kept
    { amp: 0.70, ...C },   // far -> kept
  ]);
  const hs = a._selectMemorableEvents({ hotspotPercentile: 0.75 }); // target 3
  assert(hs.length === 3, `fills the target from well-separated peaks (got ${hs.length})`);
  assert(hs.map(p => p.amplitude).join(',') === '1,0.8,0.7',
    `the 0.90 peak ~4 m from the 1.00 peak is skipped (got ${hs.map(p => p.amplitude).join(',')})`);
}

// ── 3. Every selected pair is >= MIN_SEPARATION_M apart ─────────────────────
{
  const a = makeAnalyzer([
    { amp: 1.0, ...A }, { amp: 0.95, ...A5 }, { amp: 0.9, ...B },
    { amp: 0.85, ...C }, { amp: 0.8, ...Dp },
  ]);
  const hs = a._selectMemorableEvents({ hotspotPercentile: 1.0 }); // target = all 5
  const coords = hs.map(p => a.getCoordinates(p.index));
  let minPair = Infinity;
  for (let i = 0; i < coords.length; i++)
    for (let j = i + 1; j < coords.length; j++)
      minPair = Math.min(minPair, a._haversineMeters(coords[i].lat, coords[i].lon, coords[j].lat, coords[j].lon));
  assert(minPair >= MIN_SEP, `closest selected pair >= ${MIN_SEP} m (got ${minPair.toFixed(1)} m)`);
  assert(hs.length === 4, `the crowded 2nd peak is excluded, 4 of 5 kept (got ${hs.length})`);
}

// ── 4. Compact recording yields fewer than the target ──────────────────────
{
  const a = makeAnalyzer([
    { amp: 1.0, ...A }, { amp: 0.9, ...A5 },
    { amp: 0.8, lat: 51.50008, lon: -0.1000 },  // ~9 m from A
    { amp: 0.7, lat: 51.50012, lon: -0.1000 },  // ~13 m from A
  ]);
  const hs = a._selectMemorableEvents({ hotspotPercentile: 1.0 }); // target 4
  assert(hs.length === 1, `only the single biggest survives when all peaks are within ${MIN_SEP} m (got ${hs.length})`);
  assert(hs[0].amplitude === 1.0, 'and it is the largest one');
}

// ── 5. No-GPS peaks and excluded peaks are skipped ─────────────────────────
{
  const a = makeAnalyzer([
    { amp: 1.0, noGps: true },        // biggest but unrenderable -> skipped
    { amp: 0.9, ...A, excluded: true }, // excluded -> skipped
    { amp: 0.8, ...B },               // kept
    { amp: 0.7, ...C },               // kept
  ]);
  const hs = a._selectMemorableEvents({ hotspotPercentile: 1.0 });
  assert(hs.map(p => p.amplitude).join(',') === '0.8,0.7',
    `no-GPS and excluded peaks are skipped (got ${hs.map(p => p.amplitude).join(',')})`);
}

// ── 6. Empty / all-excluded input ─────────────────────────────────────────
{
  assert(new GSRAnalyzer()._selectMemorableEvents({}).length === 0, 'no peaks -> empty');
  const a = makeAnalyzer([{ amp: 1.0, ...A, excluded: true }]);
  assert(a._selectMemorableEvents({}).length === 0, 'all peaks excluded -> empty');
}

// ── 7. MIN_SEPARATION_M = 0 disables spacing ──────────────────────────────
{
  const saved = global.GSR_CONST.MEMORABLE_EVENTS.MIN_SEPARATION_M;
  global.GSR_CONST.MEMORABLE_EVENTS.MIN_SEPARATION_M = 0;
  const a = makeAnalyzer([{ amp: 1.0, ...A }, { amp: 0.9, ...A5 }, { amp: 0.8, ...B }]);
  const hs = a._selectMemorableEvents({ hotspotPercentile: 1.0 });
  global.GSR_CONST.MEMORABLE_EVENTS.MIN_SEPARATION_M = saved;
  assert(hs.length === 3, `spacing off -> all 3 kept including the ~4 m pair (got ${hs.length})`);
}

console.log('\n============================================================');
console.log(`Hotspot selection suite: ${passed} passed, ${failed} failed`);
console.log('============================================================');
process.exit(failed > 0 ? 1 : 0);
