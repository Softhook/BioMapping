/**
 * Response delay sync check in real Chrome (docs/time_offsets_review.md,
 * Solution design, step 1: "Sync test"). Opens tracks/Stokey.zip, sets the
 * Response delay slider, and for a spread of peaks on one walk hovers the
 * graph at the peak's top, then checks that
 *   1. the map dot (the hover's 'scrub' position) sits on that peak's own
 *      marker (within 1 cm: both come from the same join, so a correct build
 *      puts them on the same point),
 *   2. the path colour at that place is that peak's reading,
 *   3. the road-context band under the cursor is the road class the
 *      dashboard pairs the peak with,
 *   4. the graph's time label is the place time (reading time − delay).
 *
 *   node tests/manual/response_delay/sync_check.js [--delay=2] [--peaks=12]
 *                                                  [--walk=biomap_016] [--break]
 *
 * --break draws the peak markers without the delay (and nothing else), to
 * show the check notices when one view drifts out of step.
 */

const path = require('node:path');
const B = require('../zoom_perf/browser.js');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);
const DELAY = Number(args.delay ?? 2);
const N_PEAKS = Number(args.peaks ?? 12);
const WALK = String(args.walk ?? 'biomap_016');
const BREAK = Boolean(args.break);

async function main() {
  const server = await B.startServer(B.VISUALISER);
  const browser = await B.launch({ headful: Boolean(args.headful) });
  let failed = 0;
  try {
    const page = await B.newPage(browser, server.url, 'desktop');
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
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

    // Open the walk, set the slider, colour the path by phasic.
    const setup = await page.evaluate(
      async (walk, delay, brk) => {
        const { AppState } = await window.pageImport('/src/core/app_state.mjs');
        const { Controllers } = await window.pageImport(
          '/src/core/controllers.mjs',
        );
        const t = AppState.collectiveManager.tracks.find((x) =>
          x.name.includes(walk),
        );
        Controllers.trackManager.switchActiveTrack(t.id);
        const slider = document.getElementById('responseDelay');
        slider.value = String(delay);
        slider.dispatchEvent(new Event('input'));
        await new Promise((r) => setTimeout(r, 300));
        const mm = AppState.mapManager;
        mm.activeColoringMetric = 'phasic';
        const a = AppState.analyzer;
        if (brk) {
          // Deliberate break: markers ignore the delay; nothing else does.
          const real = a.placeOf.bind(a);
          a.placeOf = (i) => a.getCoordinates(i);
          Controllers.ui.rerenderMap();
          a.placeOf = real;
        } else {
          Controllers.ui.rerenderMap();
        }
        window.__scrubs = [];
        AppState.on('scrub', (p) => window.__scrubs.push(p));
        return {
          name: t.name,
          delay: a.responseDelay,
          peaks: a.peaks.length,
          enriched: !!a.isEnriched,
        };
      },
      WALK,
      DELAY,
      BREAK,
    );
    console.log(
      `${setup.name}: ${setup.peaks} peaks, Response delay ${setup.delay} s` +
        `${setup.enriched ? '' : ' (no OSM data: band check skipped)'}` +
        `${BREAK ? '  [deliberate break: markers not delayed]' : ''}`,
    );

    // A spread of peaks that have a place and a reading.
    const picks = await page.evaluate(async (n) => {
      const { AppState } = await window.pageImport('/src/core/app_state.mjs');
      const a = AppState.analyzer;
      const ok = a.peaks
        .map((p, k) => ({ p, k }))
        .filter(({ p }) => !p.excluded && a.placeOf(p.index));
      const step = Math.max(1, Math.floor(ok.length / n));
      return ok
        .filter((_, i) => i % step === 0)
        .slice(0, n)
        .map((x) => x.k);
    }, N_PEAKS);

    for (const k of picks) {
      // Frame the peak on the graph and work out where its top is drawn.
      const target = await page.evaluate(async (k) => {
        const { AppState } = await window.pageImport('/src/core/app_state.mjs');
        const { GSR_CONST } = await window.pageImport(
          '/src/core/constants.mjs',
        );
        const a = AppState.analyzer;
        const p = a.peaks[k];
        const d = a.responseDelay;
        AppState.viewDuration = 30;
        AppState.viewStartTime = AppState.clampViewStart(p.time - d - 15);
        window.redraw();
        const el = AppState.myCanvas.elt;
        const r = el.getBoundingClientRect();
        const left = GSR_CONST.MARGIN.left;
        const right = r.width - GSR_CONST.MARGIN.right;
        const x =
          left +
          ((p.time - d - AppState.viewStartTime) / AppState.viewDuration) *
            (right - left);
        return {
          x: r.left + x,
          y: r.top + GSR_CONST.MARGIN.top + 25,
          time: p.time,
        };
      }, k);
      await page.mouse.move(target.x - 3, target.y);
      await page.mouse.move(target.x, target.y);
      await B.sleep(250);

      const res = await page.evaluate(async (k) => {
        const { AppState } = await window.pageImport('/src/core/app_state.mjs');
        const { GSRRenderer } = await window.pageImport(
          '/src/render/renderer.mjs',
        );
        const a = AppState.analyzer;
        const mm = AppState.mapManager;
        const p = a.peaks[k];
        const d = a.responseDelay;
        const scrub = window.__scrubs.filter((s) => !s.clear).at(-1);
        const metres = (u, v) =>
          window.L.latLng(u.lat, u.lon).distanceTo(
            window.L.latLng(v.lat, v.lon),
          );
        // 1. The peak's own marker (tagged with its peak index), shown or
        // hidden (the map's peak layer can be toggled off).
        const track = AppState.collectiveManager.getTrack(
          AppState.activeTrackId,
        );
        const marker = (track._ownedLayers || []).find(
          (l) => l._gsrKind === 'peak' && l._gsrPeakIndex === k,
        );
        const ll = marker?.getLatLng();
        const markerM =
          scrub && ll ? metres(scrub, { lat: ll.lat, lon: ll.lng }) : null;
        // 2. Path colour at the peak's place.
        const place = a.placeRowOf(p.index);
        const dp = mm._lastDrawPoints?.find?.((q) => q.origIdx === place);
        const colourVal = dp ? mm._lastPathGetVal(dp) : undefined;
        // 3. Road band under the cursor vs the dashboard's pairing.
        const cls = (row) =>
          row ? (GSRRenderer._classifyOsmContext(row)?.label ?? null) : null;
        const bandRow = a.raw[a.findClosestIndex(p.time - d)];
        return {
          hovered: AppState.hoveredIndex,
          peakRow: p.index,
          markerM,
          colourOk: dp ? colourVal === a.phasic[p.index].val : null,
          band: a.isEnriched ? cls(bandRow) : null,
          dash: a.isEnriched ? cls(a.raw[place]) : null,
          placeTime: +(p.time - d).toFixed(2),
          labelTime: +(a.raw[AppState.hoveredIndex].time - d).toFixed(2),
        };
      }, k);

      const checks = [
        [
          'map dot on the marker',
          res.markerM != null && res.markerM < 0.01,
          res.markerM == null ? 'no hover dot' : `${res.markerM.toFixed(2)} m`,
        ],
        [
          'path colour is its reading',
          res.colourOk !== false,
          res.colourOk === null ? 'place not a drawn point' : '',
        ],
        [
          'band = dashboard road class',
          res.band === res.dash,
          res.band === null ? 'no OSM data' : `${res.band}`,
        ],
        [
          'label is place time',
          Math.abs(res.labelTime - res.placeTime) < 0.15,
          `${res.labelTime} s`,
        ],
      ];
      const hoverOk = Math.abs(res.hovered - res.peakRow) <= 1;
      for (const [name, ok, detail] of checks) {
        const pass = ok && hoverOk;
        if (!pass) failed++;
        console.log(
          `${pass ? 'PASS' : 'FAIL'}  peak ${k} at ${target.time.toFixed(1)} s: ${name}` +
            `${detail ? `  (${detail})` : ''}${hoverOk ? '' : `  [hovered row ${res.hovered}, peak row ${res.peakRow}]`}`,
        );
      }
    }
    for (const e of errors) {
      failed++;
      console.log(`FAIL  page error: ${e.slice(0, 200)}`);
    }
  } finally {
    await browser.close();
    server.close();
  }
  console.log(failed ? `\n${failed} check(s) failed.` : '\nAll checks passed.');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
