/**
 * The 0 s record (tests/support/response_delay_baseline.js) for every walk in
 * the repo's tracks/ folder, plus the dashboard for the walks in Stokey.zip
 * together. The walks are git-ignored, so this lives here rather than in
 * npm test.
 *
 *   node tests/manual/response_delay/baseline.js --save    before the build
 *   node tests/manual/response_delay/baseline.js --check   after each step
 *
 * --check lists every part that changed. Hotspot changes are listed
 * separately: the build is allowed to change those. Everything else must be
 * unchanged at 0 s. See docs/time_offsets_review.md (Solution design, step 1).
 */

const fs = require('node:fs');
const path = require('node:path');

global.window = global;
const { GSR_CONST } = require('../../../src/core/constants.mjs');
global.GSR_CONST = GSR_CONST;
const { GSRAnalyzer } = require('../../../src/signal/analyzer.mjs');
const { GpsPipeline } = require('../../../src/gps/gps_pipeline.mjs');
const {
  GSRCollectiveManager,
} = require('../../../src/spatial/collective_manager.mjs');
const {
  EnvironmentalStats,
} = require('../../../src/spatial/environmental_stats.mjs');
const { GSRMapPath } = require('../../../src/map/manager/path.mjs');
const { superMock } = require('../../support/realm_bridge.js');
const {
  walkRecord,
  dashboardRecord,
  exportRecord,
  part,
} = require('../../support/response_delay_baseline.js');

const VIS = path.join(__dirname, '../../..');
const TRACKS = path.join(VIS, '../tracks');
const OUT = path.join(__dirname, 'out/baseline.json');
const JSZip = require(path.join(VIS, 'vendor/jszip/jszip.min.js'));
const deps = { GSRCollectiveManager, GSRMapPath, GpsPipeline, superMock };

// The app logs CSV warnings for some walks; they aren't what's checked here.
console.warn = () => {};

function load(text) {
  const a = new GSRAnalyzer();
  a.parseCSV(text);
  if (!a.raw.length || !a.raw.some((r) => r.hasGps)) return null;
  a.setResponseDelay?.(0);
  GpsPipeline.ensureFilteredGps(a, GSR_CONST.GPS_DEFAULT);
  a.analyze(GSR_CONST.GSR_DEFAULT, 0);
  return a;
}

function record(a) {
  const rec = walkRecord(a, deps);
  rec.export = exportRecord(a, GSR_CONST);
  // Allowed to change: kept apart so --check can list it separately.
  rec.hotspots = part(a.memorableEvents.map((p) => p.index));
  return rec;
}

async function build() {
  const walks = {};
  for (const f of fs
    .readdirSync(TRACKS)
    .filter((x) => x.endsWith('.csv'))
    .sort()) {
    const a = load(fs.readFileSync(path.join(TRACKS, f), 'utf8'));
    if (a) walks[f] = record(a);
  }
  const zip = await JSZip.loadAsync(
    fs.readFileSync(path.join(TRACKS, 'Stokey.zip')),
  );
  const manifest = JSON.parse(await zip.file('manifest.json').async('string'));
  const stokey = [];
  for (const t of manifest.tracks) {
    const a = load(await zip.file(t.file).async('string'));
    if (!a) continue;
    walks[`Stokey/${t.file}`] = record(a);
    if (a.isEnriched) stokey.push({ id: t.id, analyzer: a });
  }
  return {
    walks,
    stokeyDashboard: dashboardRecord(stokey, EnvironmentalStats),
    stokeyEnrichedWalks: stokey.length,
  };
}

async function main() {
  const mode = process.argv[2];
  if (mode !== '--save' && mode !== '--check') {
    console.error('Use --save (before the build) or --check (after).');
    process.exit(2);
  }
  const t0 = Date.now();
  const now = await build();
  const took = `${((Date.now() - t0) / 1000).toFixed(0)} s`;
  if (mode === '--save') {
    fs.writeFileSync(OUT, `${JSON.stringify(now, null, 1)}\n`);
    console.log(
      `Saved ${Object.keys(now.walks).length} walks and the Stokey dashboard ` +
        `(${now.stokeyEnrichedWalks} enriched walks) in ${took} to ${OUT}`,
    );
    return;
  }
  const was = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  const changed = [];
  const hotspots = [];
  for (const [w, parts] of Object.entries(was.walks)) {
    if (!now.walks[w]) {
      changed.push(`${w}: missing`);
      continue;
    }
    for (const [k, v] of Object.entries(parts)) {
      if (JSON.stringify(now.walks[w][k]) === JSON.stringify(v)) continue;
      (k === 'hotspots' ? hotspots : changed).push(`${w}: ${k}`);
    }
  }
  for (const [k, v] of Object.entries(was.stokeyDashboard)) {
    if (JSON.stringify(now.stokeyDashboard[k]) !== JSON.stringify(v)) {
      changed.push(`Stokey dashboard: ${k}`);
    }
  }
  console.log(`Checked ${Object.keys(was.walks).length} walks in ${took}.`);
  console.log(`Hotspots changed (allowed): ${hotspots.length}`);
  for (const h of hotspots) console.log(`  ${h}`);
  console.log(`Anything else changed: ${changed.length}`);
  for (const c of changed) console.log(`  ${c}`);
  process.exit(changed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
