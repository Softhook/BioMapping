'use strict';
/**
 * Track-parametrised performance benchmark runner.
 *
 *   node tests/manual/bench/run.js [area ...] [options]
 *
 * Areas (omit to run all):
 *   analyze  signal-metrics  arousal-places  label-placement  gps-pipeline
 *   render-single  graph-draw  contour-surface  render-collective
 *
 * Options:
 *   --tracks=<spec>   comma list of set names + filenames. Sets: tiny small
 *                     medium large default all. e.g. --tracks=large
 *                     --tracks=biomap_016,biomap_113  (default: "default")
 *   --areas=a,b       alternative to positional area names
 *   --iters=N         override per-area iteration count
 *   --warmup=N        override per-area warmup count
 *   --json            emit machine-readable results on stdout (progress -> stderr)
 *   --list            print available areas + track sets and exit
 *
 * Every number is a REAL production function timed against a REAL track CSV.
 * Each area gets a FRESH bootApp() + recording-Leaflet + track reload — sharing
 * one context makes later areas 3-6x optimistic (analyze() mutates its
 * analyzer, renderData() warms the GPS + Arousal Places caches, contour reads a
 * warm filteredGps). Cost: ~150ms boot + one analyze() per track, per area.
 * The recording Leaflet models layer add/remove, not real DOM — pure-compute
 * numbers are faithful, layer-building numbers understate a real browser.
 *
 * `--tracks=all` (~68 CSVs) reloads every track for every area — pair it with
 * `--areas=` to narrow, or expect a multi-minute run.
 */

const h = require('./harness.js');
const AREAS = require('./areas.js');

function log(...a) { process.stderr.write(a.join(' ') + '\n'); }

function main(argv) {
  const args = h.parseArgs(argv);

  if (args.help) {
    console.log(`Usage: node tests/manual/bench/run.js [area ...] [options]

Areas (omit to run all):
${AREAS.map(a => '  ' + a.name.padEnd(18) + ' ' + a.title).join('\n')}

Options:
  --tracks=<spec>       track set name or comma list of CSV filenames (default: "default")
  --areas=a,b           comma list of area names (alternative to positional arguments)
  --iters=N             override per-area iteration count
  --warmup=N            override per-area warmup count
  --json                emit machine-readable JSON on stdout (progress to stderr)
  --list, -l            print available areas + track sets and exit
  --help, -h            show this help message and exit

Track sets:
${Object.entries(h.TRACK_SETS).map(([k, v]) => '  ' + k.padEnd(10) + ' ' + v.join(', ')).join('\n')}
  all        every non-empty track CSV on disk (${h.listTracks().length} tracks)
`);
    return;
  }

  if (args.list) {
    console.log('areas:');
    for (const a of AREAS) console.log(`  ${a.name.padEnd(18)} ${a.title}`);
    console.log('\ntrack sets:');
    for (const [k, v] of Object.entries(h.TRACK_SETS)) console.log(`  ${k.padEnd(10)} ${v.join(', ')}`);
    console.log(`\non disk: ${h.listTracks().length} tracks`);
    return;
  }

  const wanted = args.areas && args.areas.length
    ? AREAS.filter(a => args.areas.includes(a.name))
    : AREAS;
  if (!wanted.length) { log(`no matching areas for: ${(args.areas || []).join(', ')}`); process.exit(1); }

  const files = h.resolveTracks(args.tracks);
  if (!files.length) { log(`no matching tracks found for: "${args.tracks}"`); process.exit(1); }
  const opts = {};
  if (args.iters) opts.iters = args.iters;
  if (args.warmup) opts.warmup = args.warmup;

  const t0 = Date.now();
  log(`${wanted.length} area(s) × ${files.length} track(s): ${files.join(', ')}`);
  log(`(fresh bootApp + track load per area — keeps every area's numbers independent)`);
  if (files.length > 12 && wanted.length > 2) {
    log(`  ! ${files.length} tracks × ${wanted.length} areas is a long run — consider --areas= to narrow`);
  }

  const results = { meta: { tracks: files, generated: new Date().toISOString(), node: process.version }, areas: {} };

  for (const area of wanted) {
    const ta = Date.now();
    log(`\n▶ ${area.name} — booting + loading ${files.length} track(s) …`);
    const ctx = h.boot();
    const tracks = files.map((f, i) => h.loadTrack(ctx.window, f, `bt${i}`));
    const base = {
      h, window: ctx.window, context: ctx.context, mapManager: ctx.mapManager,
      L: ctx.L, map: ctx.map, GSR_CONST: ctx.GSR_CONST, tracks, opts,
    };

    let rows;
    try {
      if (area.perTrack) {
        rows = [];
        for (const track of tracks) {
          const r = area.run({ ...base, track });
          rows.push({ track: track.filename.replace(/\.csv$/, ''), ...r });
        }
      } else {
        rows = area.run({ ...base });
      }
    } catch (e) {
      log(`  ! ${area.name} failed: ${e && e.stack || e}`);
      results.areas[area.name] = { error: String(e && e.message || e) };
      process.exitCode = 1;
      continue;
    }
    results.areas[area.name] = { title: area.title, columns: area.columns, rows };
    if (!args.json) h.printTable(`── ${area.name} ──  ${area.title}`, area.columns, rows);
    log(`  (${((Date.now() - ta) / 1000).toFixed(1)}s)`);
  }

  if (args.json) process.stdout.write(JSON.stringify(results, null, 2) + '\n');
  else log(`\ndone in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main(process.argv.slice(2));
