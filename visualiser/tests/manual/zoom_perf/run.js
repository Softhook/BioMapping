/**
 * Zoom performance, measured in real Google Chrome with real track data.
 *
 *   node tests/manual/zoom_perf/run.js [options]
 *   npm run zoomperf -- [options]
 *
 * For each view (single, collective, live) and device (phone = two-finger
 * pinch, desktop = scroll wheel) it zooms in and out a few times and reports
 * how smooth the frames were and how busy the page's main thread was, then
 * how much work the page does with the map sitting still. See README.md.
 *
 * Options:
 *   --views=a,b      single, collective, live        (default: all three)
 *   --devices=a,b    phone, desktop                  (default: both)
 *   --compare=REF    also measure git REF (e.g. HEAD, main, a commit) and
 *                    show it side by side as "before"
 *   --runs=N         repeat each measurement N times, report the median
 *                    (default 1; use 3 before drawing conclusions)
 *   --cpu=N          slow the CPU down N times, like a mid-range phone
 *                    (default 4; 1 = this machine's full speed)
 *   --track=FILE     track for single/live (default biomap_019.csv)
 *   --headful        show the Chrome window
 *   --json           print the results as JSON (progress goes to stderr)
 *
 * Nothing here runs in `npm test`: every number is a measurement, not a pass
 * or fail. check.js is the pass/fail companion for peak-dot behaviour.
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const B = require('./browser.js');

const log = (...a) => process.stderr.write(`${a.join(' ')}\n`);

function parseArgs(argv) {
  const opts = {
    views: ['single', 'collective', 'live'],
    devices: ['phone', 'desktop'],
    compare: null,
    runs: 1,
    cpu: 4,
    track: null,
    headful: false,
    json: false,
  };
  for (const arg of argv) {
    const [k, v] = arg.replace(/^--/, '').split('=');
    if (k === 'views') opts.views = v.split(',');
    else if (k === 'devices') opts.devices = v.split(',');
    else if (k === 'compare') opts.compare = v;
    else if (k === 'runs') opts.runs = Math.max(1, Number(v));
    else if (k === 'cpu') opts.cpu = Number(v);
    else if (k === 'track') opts.track = v.endsWith('.csv') ? v : `${v}.csv`;
    else if (k === 'headful') opts.headful = true;
    else if (k === 'json') opts.json = true;
    else if (k === 'help' || k === 'h') {
      process.stdout.write(
        fs
          .readFileSync(__filename, 'utf8')
          .split('*/')[0]
          .replace(/^\/\*\*?|^ \* ?/gm, ''),
      );
      process.exit(0);
    } else throw new Error(`Unknown option: ${arg} (try --help)`);
  }
  return opts;
}

const percentile = (values, p) => {
  const s = [...values].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0;
};
const median = (values) => percentile(values, 0.5);

// Main-thread work in a trace, summed by kind. The renderer's main thread is
// the one that did the most work (other renderers sit idle).
const WORK_KINDS = {
  UpdateLayoutTree: 'style',
  Layout: 'layout',
  PrePaint: 'prepaint',
  Paint: 'paint',
  Layerize: 'layers',
  Commit: 'layers',
  UpdateLayer: 'layers',
  FunctionCall: 'script',
  EventDispatch: 'script',
  TimerFire: 'script',
  FireAnimationFrame: 'script',
};
function mainThreadWork(traceEvents) {
  const mains = traceEvents.filter(
    (e) => e.name === 'thread_name' && e.args?.name === 'CrRendererMain',
  );
  const busyOf = (m) =>
    traceEvents.reduce(
      (s, e) =>
        e.pid === m.pid && e.tid === m.tid && e.name === 'RunTask'
          ? s + (e.dur || 0)
          : s,
      0,
    );
  const main = mains.sort((a, b) => busyOf(b) - busyOf(a))[0];
  const work = { busy: 0 };
  if (!main) return work;
  for (const e of traceEvents) {
    if (e.pid !== main.pid || e.tid !== main.tid || e.ph !== 'X') continue;
    if (e.name === 'RunTask') work.busy += e.dur / 1000;
    const kind = WORK_KINDS[e.name];
    if (kind) work[kind] = (work[kind] || 0) + e.dur / 1000;
  }
  return work;
}

async function withTrace(page, fn) {
  await page.tracing.start({
    categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline'],
  });
  const t0 = Date.now();
  await fn();
  const seconds = (Date.now() - t0) / 1000;
  const raw = await page.tracing.stop();
  const trace = JSON.parse(Buffer.from(raw).toString('utf8'));
  return { work: mainThreadWork(trace.traceEvents), seconds };
}

// Zoom in and out twice at the map's centre.
async function zoomGestures(page, cdp, device, center) {
  for (let rep = 0; rep < 2; rep++) {
    for (const scale of [2.5, 0.4]) {
      if (device === 'phone') {
        await cdp.send('Input.synthesizePinchGesture', {
          x: center.x,
          y: center.y,
          scaleFactor: scale,
          relativeSpeed: 600,
          gestureSourceType: 'touch',
        });
      } else {
        await page.mouse.move(center.x, center.y);
        // A trackpad-like burst: 25 events of 12 px, 16 ms apart.
        for (let k = 0; k < 25; k++) {
          await page.mouse.wheel({ deltaY: scale > 1 ? -12 : 12 });
          await B.sleep(16);
        }
      }
      await B.sleep(400);
    }
  }
  await B.sleep(700); // let the last zoom settle and its follow-up work run
}

/** One measurement of one view on one device. */
async function measureOnce(root, view, device, opts) {
  const server = await B.startServer(root);
  const browser = await B.launch({ headful: opts.headful });
  try {
    const page = await B.newPage(browser, server.url, device);
    const tracks = opts.track
      ? [path.join(B.TRACKS, opts.track)]
      : B.defaultTracks(view);
    const mapSel = await B.openView(page, server.url, view, tracks);
    const info = await page.evaluate((sel) => {
      const map = document.querySelector(sel);
      map.scrollIntoView({ block: 'center' });
      return {
        domMarkers: map.querySelectorAll('.leaflet-marker-icon').length,
      };
    }, mapSel);
    await B.sleep(500);
    const box = await page.evaluate((sel) => {
      const r = document.querySelector(sel).getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    }, mapSel);
    if (!box.w || !box.h) throw new Error(`${view}: the map is not on screen`);
    const center = {
      x: Math.round(box.x + box.w / 2),
      y: Math.round(box.y + box.h / 2),
    };
    const cdp = await page.createCDPSession();
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: opts.cpu });

    // At rest first: no frame counter running, since requesting frames makes
    // the page do per-frame work it otherwise wouldn't.
    const rest = await withTrace(page, () => B.sleep(3000));

    // Then zooming, counting every frame the page produced.
    await page.evaluate(() => {
      window.__frames = [];
      window.__longTasks = [];
      const loop = (t) => {
        window.__frames.push(t);
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) window.__longTasks.push(e.duration);
      }).observe({ type: 'longtask' });
    });
    const zoom = await withTrace(page, () =>
      zoomGestures(page, cdp, device, center),
    );
    const { frames, longTasks } = await page.evaluate(() => ({
      frames: window.__frames,
      longTasks: window.__longTasks,
    }));
    const gaps = frames.slice(1).map((t, i) => t - frames[i]);
    if (page.__errors.length)
      log(`  page errors: ${page.__errors.join(' | ')}`);
    return {
      domMarkers: info.domMarkers,
      frames: gaps.length,
      slowFrames: gaps.filter((g) => g > 20).length,
      p99FrameMs: percentile(gaps, 0.99),
      longTasks: longTasks.length,
      worstLongTaskMs: longTasks.length ? Math.max(...longTasks) : 0,
      zoomBusyMsPerS: zoom.work.busy / zoom.seconds,
      zoomWork: zoom.work,
      restBusyMsPerS: rest.work.busy / rest.seconds,
    };
  } finally {
    await browser.close();
    server.close();
  }
}

async function measure(root, view, device, opts) {
  const runs = [];
  for (let i = 0; i < opts.runs; i++) {
    runs.push(await measureOnce(root, view, device, opts));
  }
  const med = (k) => median(runs.map((r) => r[k]));
  return {
    domMarkers: runs[0].domMarkers,
    frames: med('frames'),
    slowFrames: med('slowFrames'),
    p99FrameMs: med('p99FrameMs'),
    longTasks: med('longTasks'),
    worstLongTaskMs: med('worstLongTaskMs'),
    zoomBusyMsPerS: med('zoomBusyMsPerS'),
    restBusyMsPerS: med('restBusyMsPerS'),
    zoomWork: runs[0].zoomWork,
  };
}

// A throwaway checkout of `ref`, removed afterwards.
function checkout(ref) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zoomperf-'));
  execFileSync('git', ['worktree', 'add', '--detach', dir, ref], {
    cwd: B.REPO,
    stdio: 'ignore',
  });
  return {
    root: path.join(dir, 'visualiser'),
    remove: () =>
      execFileSync('git', ['worktree', 'remove', '--force', dir], {
        cwd: B.REPO,
        stdio: 'ignore',
      }),
  };
}

const fmt = (n, digits = 0) => (Number.isFinite(n) ? n.toFixed(digits) : '–');

function printTable(results, compare) {
  const cols = [
    ['slow frames', (r) => `${r.slowFrames}/${r.frames}`],
    ['worst 1% frame', (r) => `${fmt(r.p99FrameMs)} ms`],
    [
      'freezes (>50 ms)',
      (r) => `${r.longTasks}, worst ${fmt(r.worstLongTaskMs)} ms`,
    ],
    ['busy zooming', (r) => `${fmt(r.zoomBusyMsPerS)} ms/s`],
    ['busy at rest', (r) => `${fmt(r.restBusyMsPerS)} ms/s`],
    ['page markers', (r) => String(r.domMarkers)],
  ];
  const rows = [['view / device', ...cols.map((c) => c[0])]];
  for (const r of results) {
    const cell = (c) =>
      compare ? `${c[1](r.before)} → ${c[1](r.after)}` : c[1](r.after);
    rows.push([`${r.view} / ${r.device}`, ...cols.map(cell)]);
  }
  const widths = rows[0].map((_, i) =>
    Math.max(...rows.map((row) => row[i].length)),
  );
  for (const [i, row] of rows.entries()) {
    console.log(row.map((c, j) => c.padEnd(widths[j])).join('  '));
    if (i === 0) console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  }
  console.log(
    '\nslow frames: frames taking over 20 ms (visible stutter) out of all frames ' +
      'during the zooms. busy: main-thread work per second of wall time ' +
      '(1000 = never idle).',
  );
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const before = opts.compare ? checkout(opts.compare) : null;
  const results = [];
  try {
    for (const view of opts.views) {
      for (const device of opts.devices) {
        const r = { view, device };
        if (before) {
          log(`${view} / ${device}: measuring ${opts.compare}…`);
          r.before = await measure(before.root, view, device, opts);
        }
        log(`${view} / ${device}: measuring the working tree…`);
        r.after = await measure(B.VISUALISER, view, device, opts);
        results.push(r);
      }
    }
  } finally {
    before?.remove();
  }
  if (opts.json) {
    console.log(JSON.stringify({ options: opts, results }, null, 2));
  } else {
    console.log(
      `\nZoom performance — CPU slowed ${opts.cpu}×, median of ${opts.runs} run(s)` +
        (opts.compare ? `, ${opts.compare} → working tree` : '') +
        '\n',
    );
    printTable(results, Boolean(opts.compare));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
