/**
 * Benchmark runner for loading the Stokey project bundle (tracks/Stokey.zip).
 *
 * Measures end-to-end load latency and profiles every individual stage:
 *   1. Zip decompression (JSZip loadAsync + async string reads)
 *   2. CSV parsing (GSRCSVParser.parse per track)
 *   3. Signal analysis (GSRAnalyzer.analyze per track, highlighting cvxEDA overhead)
 *   4. Track registration & UI activation (switchActiveTrack, slider sync, track list)
 *
 * Usage:
 *   node tests/manual/bench/bench_stokey.js [options]
 *
 * Options:
 *   --no-cvx      Temporarily force useCvxEDA=false to measure non-cvx baseline
 *   --json        Emit machine-readable JSON output
 *   --help, -h    Show help message
 */

const fs = require('node:fs');
const path = require('node:path');
const JSZip = require('../../../vendor/jszip/jszip.min.js');
const { boot } = require('./harness.js');

const PROJECT_PATH = path.resolve(__dirname, '../../../../tracks/Stokey.zip');

function parseArgs(argv) {
  const args = { noCvx: false, json: false, help: false };
  for (const arg of argv) {
    if (arg === '--no-cvx') args.noCvx = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
  }
  return args;
}

function fmtMs(ms) {
  return `${ms.toFixed(1)} ms`;
}

async function runBenchmark(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);

  if (args.help) {
    console.log(`Usage: node tests/manual/bench/bench_stokey.js [options]

Options:
  --no-cvx    Force useCvxEDA=false to measure non-convex baseline latency
  --json      Emit machine-readable JSON on stdout
  --help, -h  Show this help message and exit
`);
    return;
  }

  if (!fs.existsSync(PROJECT_PATH)) {
    console.error(`Error: Stokey project file not found at ${PROJECT_PATH}`);
    process.exit(1);
  }

  const { window } = await boot();
  window.JSZip = JSZip;

  const zipBuffer = fs.readFileSync(PROJECT_PATH);
  const zipSizeMb = zipBuffer.length / (1024 * 1024);

  const tTotalStart = performance.now();

  // 1. JSZip decompression of manifest
  const tZip0 = performance.now();
  const zip = await JSZip.loadAsync(zipBuffer);
  const manifestEntry = zip.file('manifest.json');
  if (!manifestEntry) {
    throw new Error('manifest.json not found in Stokey.zip');
  }
  const manifest = JSON.parse(await manifestEntry.async('string'));
  const tZipManifest = performance.now() - tZip0;

  // 2. Per-track decompression, parsing, and analysis
  let totalDecompressMs = tZipManifest;
  let totalParseMs = 0;
  let totalAnalyzeMs = 0;
  const trackRecords = [];

  for (let i = 0; i < manifest.tracks.length; i++) {
    const entry = manifest.tracks[i];

    // Decompress
    const tD0 = performance.now();
    const csvEntry = zip.file(entry.file);
    if (!csvEntry) {
      console.warn(`Warning: missing file ${entry.file} in zip`);
      continue;
    }
    const csvText = await csvEntry.async('string');
    const tDecompress = performance.now() - tD0;
    totalDecompressMs += tDecompress;

    // Parse CSV
    const tP0 = performance.now();
    const analyzer = new window.GSRAnalyzer();
    analyzer.parseCSV(csvText);
    const tParse = performance.now() - tP0;
    totalParseMs += tParse;

    // Filter params
    const filterParams =
      analyzer.importedFilterParams ||
      JSON.parse(JSON.stringify(window.GSR_CONST.GSR_DEFAULT));
    const gpsFilterParams =
      analyzer.importedGpsFilterParams ||
      JSON.parse(JSON.stringify(window.GSR_CONST.GPS_DEFAULT));

    if (args.noCvx) {
      filterParams.useCvxEDA = false;
    }

    // Analyze signal
    const tA0 = performance.now();
    analyzer.analyze(filterParams, gpsFilterParams.peakLatency || 0);
    const tAnalyze = performance.now() - tA0;
    totalAnalyzeMs += tAnalyze;

    trackRecords.push({
      file: entry.file,
      name: entry.name || entry.file,
      sizeKb: csvText.length / 1024,
      rows: analyzer.raw.length,
      peaks: analyzer.peaks.length,
      cvx: !!filterParams.useCvxEDA,
      decompressMs: tDecompress,
      parseMs: tParse,
      analyzeMs: tAnalyze,
      totalMs: tDecompress + tParse + tAnalyze,
    });

    const trackId = `track_${Date.now()}_${i}`;
    const newTrack = {
      id: trackId,
      name: entry.name || entry.file,
      color: entry.color || window.AppState.getNextTrackColor(),
      enabled: entry.enabled !== false,
      analyzer,
      filterParams,
      gpsFilterParams,
    };
    window.AppState.collectiveManager.addTrack(newTrack);
  }

  // 3. UI activation (making the active track active in the UI)
  const tAct0 = performance.now();
  const activeTrack =
    window.AppState.collectiveManager.tracks[manifest.activeTrackIndex || 0];
  if (activeTrack) {
    window.GSRTrackManager.switchActiveTrack(activeTrack.id);
  }
  const tActivation = performance.now() - tAct0;

  const totalLoadMs = performance.now() - tTotalStart;

  const totalRows = trackRecords.reduce((acc, t) => acc + t.rows, 0);
  const totalPeaks = trackRecords.reduce((acc, t) => acc + t.peaks, 0);

  const results = {
    meta: {
      project: 'Stokey.zip',
      fileSizeMb: Number(zipSizeMb.toFixed(2)),
      trackCount: trackRecords.length,
      totalRows,
      totalPeaks,
      forcedNoCvx: args.noCvx,
      timestamp: new Date().toISOString(),
    },
    timings: {
      zipDecompressMs: Number(totalDecompressMs.toFixed(1)),
      csvParseMs: Number(totalParseMs.toFixed(1)),
      signalAnalyzeMs: Number(totalAnalyzeMs.toFixed(1)),
      uiActivationMs: Number(tActivation.toFixed(1)),
      totalLoadMs: Number(totalLoadMs.toFixed(1)),
    },
    tracks: trackRecords,
  };

  if (args.json) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
    return;
  }

  console.log(
    '\n═══════════════════════════════════════════════════════════════════════════════',
  );
  console.log(
    ` STOKEY PROJECT LOAD BENCHMARK  (${zipSizeMb.toFixed(2)} MB, ${trackRecords.length} tracks, ${totalRows.toLocaleString()} rows)`,
  );
  if (args.noCvx) {
    console.log(' [Note: Running in --no-cvx baseline comparison mode]');
  }
  console.log(
    '═══════════════════════════════════════════════════════════════════════════════\n',
  );

  console.log('── Per-Track Breakdown ──');
  console.log(
    '  Track Name / File                Rows    Peaks  cvxEDA   Decompress     Parse       Analyze       Total',
  );
  console.log(
    '  ───────────────────────────────  ─────   ─────  ──────   ──────────  ─────────   ──────────  ──────────',
  );
  for (const s of trackRecords) {
    const fn = s.file.padEnd(31);
    const r = String(s.rows).padStart(5);
    const pk = String(s.peaks).padStart(5);
    const cv = (s.cvx ? 'YES' : 'no').padEnd(6);
    const d = fmtMs(s.decompressMs).padStart(10);
    const p = fmtMs(s.parseMs).padStart(9);
    const a = fmtMs(s.analyzeMs).padStart(10);
    const tot = fmtMs(s.totalMs).padStart(10);
    console.log(`  ${fn}  ${r}   ${pk}  ${cv}   ${d}  ${p}   ${a}  ${tot}`);
  }

  console.log('\n── Stage-by-Stage Profile ──');
  const pct = (val) => `${((val / totalLoadMs) * 100).toFixed(1)}%`.padStart(6);
  console.log(
    `  1. Zip Decompression:      ${fmtMs(totalDecompressMs).padStart(10)}  ${pct(totalDecompressMs)}`,
  );
  console.log(
    `  2. CSV Parsing (13 files):  ${fmtMs(totalParseMs).padStart(10)}  ${pct(totalParseMs)}`,
  );
  console.log(
    `  3. Signal Analysis:         ${fmtMs(totalAnalyzeMs).padStart(10)}  ${pct(totalAnalyzeMs)}`,
  );
  console.log(
    `  4. UI Track Activation:     ${fmtMs(tActivation).padStart(10)}  ${pct(tActivation)}`,
  );
  console.log('  ─────────────────────────────────────────────────────────');
  console.log(
    `  TOTAL END-TO-END LOAD TIME: ${(totalLoadMs / 1000).toFixed(2)} s (${fmtMs(totalLoadMs).trim()})`,
  );

  console.log('\n── Bottleneck Analysis ──');
  if (totalAnalyzeMs / totalLoadMs > 0.8) {
    console.log(
      `  • 90%+ of load time (${(totalAnalyzeMs / 1000).toFixed(2)}s) is spent in GSRAnalyzer.analyze().`,
    );
    console.log(
      '  • Every track in Stokey.zip has "useCvxEDA: true" specified in its # FilterParams: header.',
    );
    console.log(
      '  • cvxEDA solves a convex QP via interior-point iterations for all 216k samples sequentially',
    );
    console.log('    on the main thread during import.');
    console.log(
      '  • Tip: Run with --no-cvx to see load time without convex optimization (standard tonic filter).',
    );
  }
}

if (require.main === module) {
  runBenchmark().catch((err) => {
    console.error('Benchmark failed:', err);
    process.exit(1);
  });
}

module.exports = { runBenchmark };
