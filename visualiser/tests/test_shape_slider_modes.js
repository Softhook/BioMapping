/**
 * GSREvents.updateDeconvolutionUIState — the morphology shape sliders
 * (rise / half-recovery / skew) must be shown only for the default
 * trough-to-peak detector, and hidden + disabled for both alternative
 * detectors (deconvolution, prominence). Min SNR stays live in every mode.
 *
 * Run: node visualiser/tests/test_shape_slider_modes.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const dom = new JSDOM(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'));
global.window = dom.window;
global.document = dom.window.document;
global.GSR_CONST = require('./mock_constants.js');

// deconvolution.js defines SCRDeconvolution (used for canonical kernel values)
vm.runInThisContext(
  fs.readFileSync(path.join(ROOT, 'src/signal/deconvolution.js'), 'utf8')
    .replace(/^const SCRDeconvolution\s*=/m, 'global.SCRDeconvolution ='),
  { filename: 'deconvolution.js' });
vm.runInThisContext(
  fs.readFileSync(path.join(ROOT, 'src/ui/events.js'), 'utf8')
    .replace(/^const GSREvents\s*=/m, 'global.GSREvents ='),
  { filename: 'events.js' });

let passed = 0, failed = 0;
const assert = (c, m) => { c ? passed++ : (failed++, console.error('  FAIL:', m)); };

const SHAPE = ['shapeMinRiseTime', 'shapeMaxRiseTime', 'shapeMinHalfRecovery',
               'shapeMaxHalfRecovery', 'shapeMaxSkewRatio'];
const $ = (id) => document.getElementById(id);
const groupHidden = (id) => $(id).closest('.slider-group').style.display === 'none';

function setMode({ deconv = false, prom = false }) {
  $('useDeconvolution').checked = deconv;
  $('usePeakProminence').checked = prom;
  global.GSREvents.updateDeconvolutionUIState();
}

// ── Default: everything visible & enabled ──────────────────────────────────
setMode({});
SHAPE.forEach(id => {
  assert(!$(id).disabled && !groupHidden(id), `default mode: ${id} is live`);
});
assert(!$('shapeMinSnr').disabled, 'default mode: Min SNR is live');

// ── Deconvolution: shape sliders hidden + disabled + pinned to canonical ───
setMode({ deconv: true });
SHAPE.forEach(id => {
  assert($(id).disabled && groupHidden(id), `deconvolution: ${id} is hidden & disabled`);
});
assert(!$('shapeMinSnr').disabled, 'deconvolution: Min SNR stays live');
assert(/locked/.test($('valShapeMinRiseTime').innerText), 'deconvolution: label reads "(locked)"');
// canonical value pinned (kernel rise time, ~1.2 s — not the shipped 0.3 default)
assert(parseFloat($('shapeMinRiseTime').value) > 0.5,
  'deconvolution: shapeMinRiseTime pinned to the kernel canonical value');

// ── Prominence: shape sliders hidden + disabled, values untouched ──────────
$('useDeconvolution').checked = false;
global.GSREvents.updateDeconvolutionUIState();      // unlock first (restores cached)
const preProm = SHAPE.map(id => $(id).value);
setMode({ prom: true });
SHAPE.forEach((id, i) => {
  assert($(id).disabled && groupHidden(id), `prominence: ${id} is hidden & disabled`);
  assert($(id).value === preProm[i], `prominence: ${id} value left untouched (${$(id).value})`);
});
assert(!$('shapeMinSnr').disabled, 'prominence: Min SNR stays live');
assert($('valShapeMinRiseTime').innerText === 'not used', 'prominence: label reads "not used"');

// ── Back to default: fully restored ───────────────────────────────────────
setMode({});
SHAPE.forEach(id => {
  assert(!$(id).disabled && !groupHidden(id), `restored: ${id} is live again`);
});

console.log('\n============================================================');
console.log(`Shape-slider mode suite: ${passed} passed, ${failed} failed`);
console.log('============================================================');
process.exit(failed > 0 ? 1 : 0);
