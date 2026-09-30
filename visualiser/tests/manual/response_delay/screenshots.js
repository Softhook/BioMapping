/**
 * Response delay screenshots in real Chrome (docs/time_offsets_review.md,
 * Solution design, step 2): one walk at 0, 2 and 3 s, in Single view (graph
 * and map), 3D and the group map, so everything can be seen moving together.
 *
 * The map and 3D camera stay fixed on the walk's biggest hotspot while only
 * the slider changes, so whatever moves between shots moved because of the
 * delay. Body data (peak markers, path colour, the graph trace) should move;
 * place data (the route itself, the road band on the graph) should not.
 *
 *   node tests/manual/response_delay/screenshots.js [--walk=biomap_016]
 *                                                   [--delays=0,2,3] [--headful]
 *
 * Writes PNGs to tests/manual/response_delay/out/ (git-ignored). Map tiles
 * load from the internet here, unlike the smoke test.
 */

const fs = require('node:fs');
const path = require('node:path');
const B = require('../zoom_perf/browser.js');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);
const WALK = String(args.walk ?? 'biomap_016');
const DELAYS = String(args.delays ?? '0,2,3')
  .split(',')
  .map(Number);
const OUT = path.join(__dirname, 'out');

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const server = await B.startServer(B.VISUALISER);
  const browser = await B.launch({ headful: Boolean(args.headful) });
  const shots = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1500, height: 1000 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
    await page.evaluateOnNewDocument(() => {
      window.pageImport = (url) => import(url);
    });
    await page.goto(`${server.url}/index.html`, { waitUntil: 'load' });
    await B.sleep(1500);
    await (await page.$('#fileInput')).uploadFile(
      path.join(B.TRACKS, 'Stokey.zip'),
    );
    await page.waitForFunction(
      () => document.querySelectorAll('#trackList li').length >= 14,
      { timeout: 300000, polling: 500 },
    );
    await B.sleep(3000);
    await page.evaluate(() => document.getElementById('btnSingleView').click());
    await B.sleep(1500);

    // Open the walk, colour the path by phasic, and pick its biggest hotspot.
    const focus = await page.evaluate(async (walk) => {
      const { AppState } = await window.pageImport('/src/core/app_state.mjs');
      const { Controllers } = await window.pageImport(
        '/src/core/controllers.mjs',
      );
      const t = AppState.collectiveManager.tracks.find((x) =>
        x.name.includes(walk),
      );
      Controllers.trackManager.switchActiveTrack(t.id);
      await new Promise((r) => setTimeout(r, 500));
      AppState.mapManager.activeColoringMetric = 'phasic';
      const a = AppState.analyzer;
      // The hotspot where the walker covered the most ground in the 3 s
      // before it, so the shift is easy to see; the map is centred between
      // where it was recorded and where it is drawn at 3 s.
      const metres = (u, v) =>
        window.L.latLng(u.lat, u.lon).distanceTo(window.L.latLng(v.lat, v.lon));
      let best = null;
      for (const hs of a.memorableEvents) {
        const here = a.getCoordinates(hs.index);
        const before = a.getCoordinates(a.findClosestIndex(hs.time - 3));
        if (!here || !before) continue;
        const m = metres(here, before);
        if (!best || m > best.m) best = { hs, here, before, m };
      }
      return {
        name: t.name,
        k: a.peaks.indexOf(best.hs),
        time: best.hs.time,
        metres: best.m,
        lat: (best.here.lat + best.before.lat) / 2,
        lon: (best.here.lon + best.before.lon) / 2,
      };
    }, WALK);
    console.log(
      `${focus.name}: hotspot peak ${focus.k} at ${focus.time.toFixed(1)} s` +
        ` (walker moved ${focus.metres.toFixed(1)} m in the 3 s before)`,
    );

    const setDelay = (d) =>
      page.evaluate(async (d) => {
        const slider = document.getElementById('responseDelay');
        slider.value = String(d);
        slider.dispatchEvent(new Event('input'));
        slider.dispatchEvent(new Event('change'));
        await new Promise((r) => setTimeout(r, 1500));
      }, d);

    const shoot = async (name) => {
      const file = path.join(OUT, `${name}.png`);
      await page.screenshot({ path: file });
      shots.push(file);
    };

    // The map is placed before the slider moves, so the path is drawn at the
    // zoom it is shown at: overlap colouring (a walk passing the same spot
    // twice is coloured by the mean) depends on the zoom, and drawing zoomed
    // out then zooming in would show zoomed-out colours.
    const placeMap = (f, zoom) =>
      page.evaluate(
        async (f, zoom) => {
          const { AppState } = await window.pageImport(
            '/src/core/app_state.mjs',
          );
          AppState.mapManager.map.setView([f.lat, f.lon], zoom, {
            animate: false,
          });
          await new Promise((r) => setTimeout(r, 1500));
        },
        f,
        zoom,
      );

    // Peak and hotspot markers shown on the map.
    await page.evaluate(() => {
      for (const id of ['btnToggleMapPeaks', 'btnToggleMapHotspots']) {
        const b = document.getElementById(id);
        if (!b.classList.contains('active')) b.click();
      }
    });

    // Graph framed on the hotspot and hovered at its top, so the map dot
    // shows too.
    const frame = (f) =>
      page.evaluate(async (f) => {
        const { AppState } = await window.pageImport('/src/core/app_state.mjs');
        const { GSR_CONST } = await window.pageImport(
          '/src/core/constants.mjs',
        );
        const a = AppState.analyzer;
        const p = a.peaks[f.k];
        const d = a.responseDelay;
        AppState.viewDuration = 30;
        AppState.viewStartTime = AppState.clampViewStart(p.time - 3 - 15);
        window.redraw();
        const r = AppState.myCanvas.elt.getBoundingClientRect();
        const left = GSR_CONST.MARGIN.left;
        const right = r.width - GSR_CONST.MARGIN.right;
        return {
          x:
            r.left +
            left +
            ((p.time - d - AppState.viewStartTime) / AppState.viewDuration) *
              (right - left),
          y: r.top + GSR_CONST.MARGIN.top + 25,
        };
      }, f);

    // 1. Single view: graph + map.
    await placeMap(focus, 19);
    for (const d of DELAYS) {
      await setDelay(d);
      const hover = await frame(focus);
      await page.mouse.move(hover.x - 3, hover.y);
      await page.mouse.move(hover.x, hover.y);
      await B.sleep(2500); // tiles
      await shoot(`single_${d}s`);
    }
    await page.mouse.move(5, 5);

    // 2. 3D: camera placed once, at 0 s, then left alone.
    await page.evaluate(() =>
      document.getElementById('btnGlobeSurface').click(),
    );
    await B.sleep(8000);
    for (const [i, d] of DELAYS.entries()) {
      await setDelay(d);
      if (i === 0) {
        await page.evaluate(async (k) => {
          const { GSRGlobe3DView } = await window.pageImport(
            '/src/map/globe3d_view.mjs',
          );
          GSRGlobe3DView.focusOnPeakLocation(k);
        }, focus.k);
      }
      await B.sleep(6000);
      await shoot(`3d_${d}s`);
    }
    await page.evaluate(() => document.getElementById('btnMapSurface').click());
    await B.sleep(2000);

    // 3. Group map (Collective view), same fixed spot.
    await page.evaluate(() =>
      document.getElementById('btnCollectiveView').click(),
    );
    await B.sleep(5000);
    await placeMap(focus, 18);
    for (const d of DELAYS) {
      await setDelay(d);
      await B.sleep(4000);
      await shoot(`group_${d}s`);
    }

    for (const e of errors) console.log(`page error: ${e}`);
  } finally {
    await browser.close();
    server.close();
  }
  for (const s of shots) console.log(path.relative(process.cwd(), s));
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
