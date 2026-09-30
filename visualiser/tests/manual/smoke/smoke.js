/**
 * Whole-app check in real Google Chrome with real walks: opens a project,
 * goes through every view the way a person would, and fails on any page
 * error or on a view that comes up empty.
 *
 *   node tests/manual/smoke/smoke.js [--project=Stokey.zip] [--walk=biomap_001.csv]
 *                                    [--compare=REF] [--root=<visualiser folder>]
 *                                    [--headful]
 *   npm run smoke
 *
 * --compare=REF runs the same steps on git REF (e.g. main) as well, so an
 * error that shows up on both can be told apart from a new one.
 * --root checks another copy of the visualiser instead of this one.
 *
 * Exits non-zero if any step fails on the version being checked. See README.md.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const B = require('../zoom_perf/browser.js');
const JSZip = require(path.join(B.VISUALISER, 'vendor/jszip/jszip.min.js'));

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);
const PROJECT = path.join(B.TRACKS, args.project || 'Stokey.zip');
const WALK = path.join(B.TRACKS, args.walk || 'biomap_001.csv');
const TOPO_SOURCES = [
  'gsr',
  'tonic',
  'phasic',
  'peak_density',
  'peaks',
  'auc',
  'arousal_index',
  'tri_index',
];
const ENV_TABS = [
  ['btnEnvTabCorrelation', '#correlationTable tbody tr'],
  ['btnEnvTabScatter', null],
  ['btnEnvTabRoads', '#roadArousalTable tbody tr'],
  ['btnEnvTabJunctions', null],
];

/** Numbers shown in an element's text; fails on NaN / undefined text. */
const readText = (page, sel) =>
  page.$eval(sel, (el) => el.innerText.trim()).catch(() => null);
const badText = (t) => t == null || /NaN|undefined|Infinity/.test(t);

async function walkCount(page) {
  return page.$$eval('#trackList li', (els) => els.length);
}

/** Run every step on one copy of the visualiser; returns step results. */
async function runSteps(root, label) {
  const results = [];
  let step = 'start-up';
  const errors = [];
  const check = (name, ok, detail = '') => {
    const pageErrors = errors.splice(0);
    const passed = ok && pageErrors.length === 0;
    results.push({ name, ok: passed, detail, pageErrors });
    console.log(
      `${passed ? 'PASS' : 'FAIL'}  [${label}] ${name}${detail ? `  (${detail})` : ''}`,
    );
    for (const e of pageErrors) console.log(`        page error: ${e}`);
  };

  const server = await B.startServer(root);
  const browser = await B.launch({ headful: Boolean(args.headful) });
  try {
    const page = await B.newPage(browser, server.url, 'desktop');
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
    // Outside requests are stubbed (see ../zoom_perf/browser.js), so the
    // browser's own complaints about them are noise; a local file that fails
    // to load is not.
    const OUTSIDE_NOISE = /Failed to load resource|blocked by CORS policy/;
    page.on('console', (m) => {
      if (m.type() === 'error' && !OUTSIDE_NOISE.test(m.text())) {
        errors.push(m.text().slice(0, 200));
      }
    });
    // config.local.js is an optional, git-ignored key file (see config.js):
    // a fresh checkout doesn't have it, and the app carries on without it.
    page.on('response', (r) => {
      if (
        r.url().startsWith(server.url) &&
        r.status() >= 400 &&
        !r.url().endsWith('/config.local.js')
      ) {
        errors.push(`${r.status()} ${r.url().slice(server.url.length)}`);
      }
    });
    page.on('dialog', (d) => d.accept());
    const click = async (id, wait = 1000) => {
      step = id;
      await page.evaluate((i) => document.getElementById(i)?.click(), id);
      await B.sleep(wait);
    };

    await page.goto(`${server.url}/index.html`, { waitUntil: 'load' });
    await B.sleep(1500);
    check('app starts', true);

    // 1. Open the project and wait for every walk.
    step = 'open project';
    const manifest = JSON.parse(
      await (await JSZip.loadAsync(fs.readFileSync(PROJECT)))
        .file('manifest.json')
        .async('string'),
    );
    const expected = manifest.tracks.length;
    const t0 = Date.now();
    await (await page.$('#fileInput')).uploadFile(PROJECT);
    await page
      .waitForFunction(
        (n) => document.querySelectorAll('#trackList li').length >= n,
        { timeout: 300000, polling: 500 },
        expected,
      )
      .catch(() => {});
    await B.sleep(3000);
    const loaded = await walkCount(page);
    check(
      `project opens with all its walks`,
      loaded === expected,
      `${loaded}/${expected} walks in ${((Date.now() - t0) / 1000).toFixed(0)} s`,
    );

    // 2. Single view: the stats bar is filled in.
    const peaks = await readText(page, '#statPeakCount');
    const duration = await readText(page, '#statDuration');
    check(
      'single view shows stats',
      !badText(peaks) && peaks !== '--' && !badText(duration),
      `peaks ${peaks}, duration ${duration}`,
    );

    // 3. Collective view: every map type draws with a sensible colour key.
    await click('btnCollectiveView', 5000);
    for (const src of TOPO_SOURCES) {
      step = `map ${src}`;
      await page.select('#topoSource', src);
      await B.sleep(3500);
      const want = await page.$eval(`#topoSource option[value="${src}"]`, (o) =>
        o.textContent.trim(),
      );
      const key = await page
        .$eval('#map .map-legend', (el) => ({
          title: el.querySelector('.legend-title')?.innerText.trim() ?? '',
          labels: [...el.querySelectorAll('.legend-labels span')].map((s) =>
            s.innerText.trim(),
          ),
        }))
        .catch(() => null);
      const [lo, hi] = (key?.labels ?? []).map((t) => parseFloat(t));
      check(
        `collective map: ${src}`,
        key?.title === want &&
          Number.isFinite(lo) &&
          Number.isFinite(hi) &&
          lo < hi,
        key ? `${key.title} ${key.labels.join(' to ')}` : 'no colour key',
      );
    }

    // 4. Environmental dashboard tabs.
    for (const [tab, rowsSel] of ENV_TABS) {
      await click(tab, 2500);
      const rows = rowsSel ? await page.$$eval(rowsSel, (r) => r.length) : null;
      const text = await readText(page, '#environmentalPanel');
      check(
        `dashboard tab: ${tab.replace('btnEnvTab', '')}`,
        !badText(text) && (rows == null || rows > 0),
        rows == null ? '' : `${rows} rows`,
      );
    }

    // 5. Track list: add a walk, rename it, delete it.
    await click('btnSingleView', 3000);
    step = 'add walk';
    const before = await walkCount(page);
    await (await page.$('#fileInput')).uploadFile(WALK);
    await page
      .waitForFunction(
        (n) => document.querySelectorAll('#trackList li').length > n,
        { timeout: 120000, polling: 500 },
        before,
      )
      .catch(() => {});
    await B.sleep(2000);
    check('add a walk', (await walkCount(page)) === before + 1);

    step = 'rename walk';
    await page.evaluate(() => {
      const li = [...document.querySelectorAll('#trackList li')].at(-1);
      li.querySelector('.edit-btn').click();
      const input = li.querySelector('.track-name-input');
      input.value = 'smoke test walk';
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    await B.sleep(800);
    const names = await page.$$eval('#trackList .track-name', (els) =>
      els.map((e) => e.innerText),
    );
    check('rename a walk', names.includes('smoke test walk'));

    step = 'delete walk';
    await page.evaluate(() =>
      [...document.querySelectorAll('#trackList li')]
        .at(-1)
        .querySelector('.delete-btn')
        .click(),
    );
    await B.sleep(3000);
    check('delete a walk', (await walkCount(page)) === before);

    // 6. 3D globe and back.
    await click('btnGlobeSurface', 8000);
    check('3D globe opens', true);
    await click('btnMapSurface', 2000);
    check('back to the 2D map', true);

    // 7. Live tab and back.
    await click('btnLiveView', 4000);
    const live = await page.$('#cacheMapBtn');
    check('live tab opens', Boolean(live));
    await click('btnSingleView', 2000);
    check('back to single view', true);
  } catch (e) {
    check(`step "${step}" ran`, false, String(e.message || e).slice(0, 160));
  } finally {
    await browser.close();
    server.close();
  }
  return results;
}

// A throwaway checkout of `ref`, removed afterwards.
function checkout(ref) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-'));
  execFileSync('git', ['worktree', 'add', '--detach', dir, ref], {
    cwd: B.REPO,
    stdio: 'ignore',
  });
  // The checkout has no node_modules; the app itself doesn't need them.
  return {
    root: path.join(dir, 'visualiser'),
    remove: () =>
      execFileSync('git', ['worktree', 'remove', '--force', dir], {
        cwd: B.REPO,
        stdio: 'ignore',
      }),
  };
}

async function main() {
  for (const f of [PROJECT, WALK]) {
    if (!fs.existsSync(f)) {
      console.error(
        `Not found: ${f} (the walks live in the repo's tracks/ folder)`,
      );
      process.exit(2);
    }
  }
  const root = args.root ? path.resolve(args.root) : B.VISUALISER;
  const label = args.root ? path.basename(path.dirname(root)) : 'this copy';

  let ref = null;
  if (args.compare) {
    const co = checkout(args.compare);
    try {
      ref = await runSteps(co.root, args.compare);
    } finally {
      co.remove();
    }
    console.log('');
  }
  const mine = await runSteps(root, label);

  const failed = mine.filter((r) => !r.ok);
  console.log(
    `\n${mine.length - failed.length}/${mine.length} steps passed on ${label}.`,
  );
  if (ref) {
    for (const r of failed) {
      const old = ref.find((x) => x.name === r.name);
      console.log(
        `  ${r.name}: ${old && !old.ok ? `also fails on ${args.compare} (older problem)` : `passes on ${args.compare} (NEW)`}`,
      );
    }
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
