/**
 * A saved processed CSV must reload to the same track as the device file it
 * came from: every per-row field the analysis and the environmental dashboard
 * read (position, speed, course, DOP, fix flag) on every row, including the
 * rows between GPS fixes. A second save must be byte-identical to the first.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

global.GSR_CONST = require('./mock_constants.js');
const { GSRAnalyzer } = require('../src/signal/analyzer.mjs');
const { GpsPipeline } = require('../src/gps/gps_pipeline.mjs');

const DEVICE_CSV = fs.readFileSync(
  path.join(__dirname, '../fixtures/default_processed.csv'),
  'utf8',
);

function loadAndExport(text) {
  const a = new GSRAnalyzer();
  a.parseCSV(text);
  const p = structuredClone(GSR_CONST.GSR_DEFAULT);
  const gp = structuredClone(GSR_CONST.GPS_DEFAULT);
  a.analyze(p, 0);
  const pts = GpsPipeline.filterFixes(GpsPipeline.collectFixes(a.raw), gp);
  GpsPipeline.reconstructFilteredGps(a, a.raw, pts, gp.maxSpeed);
  return { a, csv: a.exportToCSV(p, gp) };
}

const FIELDS = [
  'time',
  'lat',
  'lon',
  'hdop',
  'pdop',
  'hacc',
  'sats',
  'fixType',
  'speedKts',
  'course',
  'hasGps',
  '_isGpsFix',
  'em_fog',
];
const same = (x, y) =>
  typeof x === 'number' && typeof y === 'number'
    ? (Number.isNaN(x) && Number.isNaN(y)) || Math.abs(x - y) < 1e-9
    : x === y;

test('fixture has rows between GPS fixes (otherwise this test proves nothing)', () => {
  const { a } = loadAndExport(DEVICE_CSV);
  assert.ok(a.raw.filter((r) => !r._isGpsFix).length > 50);
});

test('reloaded export has the same position, speed, course and DOP on every row', () => {
  const orig = loadAndExport(DEVICE_CSV).a;
  const back = loadAndExport(loadAndExport(DEVICE_CSV).csv).a;
  assert.strictEqual(back.raw.length, orig.raw.length);
  for (let i = 0; i < orig.raw.length; i++) {
    for (const f of FIELDS) {
      assert.ok(
        same(orig.raw[i][f], back.raw[i][f]),
        `row ${i} (t=${orig.raw[i].time}) ${f}: ${orig.raw[i][f]} → ${back.raw[i][f]}`,
      );
    }
  }
});

test('saving a reloaded export again gives a byte-identical file', () => {
  const first = loadAndExport(loadAndExport(DEVICE_CSV).csv).csv;
  const second = loadAndExport(first).csv;
  assert.strictEqual(second, first);
});

test('EM fog is rebuilt exactly from the RF bands, not read back rounded', () => {
  const orig = loadAndExport(DEVICE_CSV).a;
  const back = loadAndExport(loadAndExport(DEVICE_CSV).csv).a;
  assert.ok(
    orig.raw.some((r) => !Number.isNaN(r.em_fog)),
    'fixture has RF',
  );
  assert.ok(orig.raw.some((r) => r.em_fog !== Number(r.em_fog.toFixed(1))));
  for (let i = 0; i < orig.raw.length; i++) {
    assert.ok(same(orig.raw[i].em_fog, back.raw[i].em_fog), `row ${i}`);
  }
});

// Live-stream recordings start mid-clock (6.60, 6.90, …); zero-basing them
// must not leave float noise the saved file then lacks.
test('a live recording starting mid-clock reloads with identical times and analysis', () => {
  const lines = DEVICE_CSV.split('\n');
  const header = lines.findIndex((l) => l.startsWith('timestamp'));
  let n = 0;
  const live = lines
    .map((l, i) => {
      if (i <= header || !l.trim()) return l;
      const cols = l.split(',');
      cols[0] = (6.6 + 0.3 * n++).toFixed(2);
      return cols.join(',');
    })
    .join('\n');
  const orig = loadAndExport(live).a;
  const back = loadAndExport(loadAndExport(live).csv).a;
  for (let i = 0; i < orig.raw.length; i++) {
    assert.strictEqual(back.raw[i].time, orig.raw[i].time, `row ${i}`);
  }
  assert.strictEqual(back.peaks.length, orig.peaks.length);
  for (let i = 0; i < orig.peaks.length; i++) {
    assert.ok(
      same(orig.peaks[i].qualityScore, back.peaks[i].qualityScore),
      `peak ${i} quality`,
    );
  }
  for (let i = 0; i < orig.phasicAUC.length; i++) {
    assert.ok(
      Math.abs(orig.phasicAUC[i].val - back.phasicAUC[i].val) < 1e-9,
      `phasicAUC row ${i}`,
    );
  }
});
