/**
 * Pass/fail check, in real Google Chrome, that the zoom speed-ups kept the
 * map working: canvas peak dots, their taps and popups, Arousal Place
 * popups, the Peaks toggle, SVG export, and an idle map at rest.
 *
 *   node tests/manual/zoom_perf/check.js [--device=desktop|phone] [--headful]
 *                                        [--root=<visualiser folder>]
 *   npm run zoomperf:check
 *
 * --root checks another copy of the visualiser (e.g. an older checkout);
 * the default is this one.
 *
 * Exits non-zero if any check fails. See README.md.
 */

const path = require('node:path');
const B = require('./browser.js');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);
const device = args.device || 'desktop';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`,
  );
}

async function main() {
  const server = await B.startServer(
    args.root ? path.resolve(args.root) : B.VISUALISER,
  );
  const browser = await B.launch({ headful: Boolean(args.headful) });
  try {
    const page = await B.newPage(browser, server.url, device);
    await B.openView(page, server.url, 'single', [
      path.join(B.TRACKS, 'biomap_019.csv'),
    ]);

    // Frame the densest cluster of peaks.
    const setup = await page.evaluate(async () => {
      const { AppState } = await window.pageImport('/src/core/app_state.mjs');
      const { GSRMapMarkers } = await window.pageImport(
        '/src/map/map_markers.mjs',
      );
      const mgr = AppState.mapManager;
      window.__mgr = mgr;
      // (An older checkout has no canvas dots: nothing counts as one there.)
      window.__isDot = (l) => GSRMapMarkers.isPeakDot?.(l) ?? false;
      window.__peaks = () =>
        mgr.getRenderLayers().peakMarkers.filter((l) => l._gsrKind === 'peak');
      const peaks = window.__peaks();
      let best = peaks[0];
      let bestN = -1;
      for (const p of peaks) {
        const n = peaks.filter(
          (q) => q.getLatLng().distanceTo(p.getLatLng()) < 150,
        ).length;
        if (n > bestN) [best, bestN] = [p, n];
      }
      mgr.map.setView(best.getLatLng(), 17, { animate: false });
      // On a phone the map runs past the bottom of the screen, and the first
      // press would scroll it up under the tap. Bring it fully into view.
      mgr.map.getContainer().scrollIntoView({ block: 'center' });
      return { peaks: peaks.length };
    });
    await B.sleep(1500);

    // 1. Plain peaks are canvas dots, not page elements.
    const dots = await page.evaluate(() => {
      const peaks = window.__peaks();
      const plain = peaks.filter((p) => !p.hasLabel);
      return {
        plain: plain.length,
        canvasDots: plain.filter((p) => window.__isDot(p)).length,
      };
    });
    check(
      'plain peaks are drawn on the canvas',
      dots.plain > 0 && dots.canvasDots === dots.plain,
      `${dots.canvasDots}/${dots.plain} canvas dots`,
    );

    // 2. Dots are drawn (and tapped) above every other canvas shape.
    const order = await page.evaluate(() => {
      const isDot = window.__isDot;
      let seenDot = false;
      let shapeAfterDot = 0;
      const map = window.__mgr.map;
      const renderer = map.options.renderer || map._renderer;
      for (let o = renderer?._drawFirst; o; o = o.next) {
        if (isDot(o.layer)) seenDot = true;
        else if (seenDot) shapeAfterDot++;
      }
      return { seenDot, shapeAfterDot };
    });
    check(
      'dots are on top of the path and shapes',
      order.seenDot && order.shapeAfterDot === 0,
      `${order.shapeAfterDot} shapes drawn over dots`,
    );

    // 3. Tapping a dot, a little off-centre, opens its popup.
    const dotPoint = await page.evaluate(() => {
      const map = window.__mgr.map;
      const size = map.getSize();
      const rect = map.getContainer().getBoundingClientRect();
      for (const p of window.__peaks().filter((l) => map.hasLayer(l))) {
        const c = map.latLngToContainerPoint(p.getLatLng());
        if (c.x > 60 && c.y > 60 && c.x < size.x - 60 && c.y < size.y - 60) {
          return { x: rect.left + c.x + 6, y: rect.top + c.y };
        }
      }
      return null;
    });
    let popup = null;
    if (dotPoint) {
      await page.mouse.click(dotPoint.x, dotPoint.y);
      await B.sleep(600);
      popup = await page.evaluate(
        () => document.querySelector('#map .leaflet-popup textarea') !== null,
      );
      await page.evaluate(() => window.__mgr.map.closePopup());
      await B.sleep(400); // let it fade out, or it takes the next click
    }
    check('tapping a dot opens its peak popup', popup === true);

    // 4. Arousal Place outlines under the dots still take clicks.
    const place = await page.evaluate(() => {
      const map = window.__mgr.map;
      const size = map.getSize();
      const rect = map.getContainer().getBoundingClientRect();
      let found = null;
      map.eachLayer((l) => {
        if (found || !(l instanceof L.Polygon) || !l.getPopup()) return;
        const c = map.latLngToContainerPoint(l.getCenter());
        if (c.x > 20 && c.y > 20 && c.x < size.x - 20 && c.y < size.y - 20) {
          found = { x: rect.left + c.x, y: rect.top + c.y };
        }
      });
      return found;
    });
    if (place) {
      await page.mouse.click(place.x, place.y);
      await B.sleep(600);
      const text = await page.evaluate(
        () => document.querySelector('#map .leaflet-popup')?.textContent || '',
      );
      await page.evaluate(() => window.__mgr.map.closePopup());
      check('clicking an Arousal Place opens its popup', /peaks/.test(text));
    } else {
      check(
        'clicking an Arousal Place opens its popup',
        false,
        'none on screen',
      );
    }

    // 5. The Peaks toggle hides and restores the dots.
    const visible = () =>
      page.evaluate(
        () =>
          window.__peaks().filter((p) => window.__mgr.map.hasLayer(p)).length,
      );
    const shown = await visible();
    await page.click('#btnToggleMapPeaks');
    await B.sleep(400);
    const hidden = await visible();
    await page.click('#btnToggleMapPeaks');
    await B.sleep(400);
    const restored = await visible();
    check(
      'the Peaks toggle hides and restores the dots',
      shown > 0 && hidden === 0 && restored === shown,
      `${shown} → ${hidden} → ${restored}`,
    );

    // 6. SVG export includes every dot.
    const svgDots = await page.evaluate(async () => {
      const { GSRMapExporter } = await window.pageImport(
        '/src/map/map_exporter.mjs',
      );
      const built = await GSRMapExporter._build(window.__mgr);
      return (built.svg.match(/<circle [^>]*\/>/g) || []).length;
    });
    check(
      'SVG export includes the dots',
      svgDots >= setup.peaks,
      `${svgDots} circles for ${setup.peaks} peaks`,
    );

    // 7. A map at rest leaves the page idle (no animation repainting it).
    await page.tracing.start({
      categories: [
        'devtools.timeline',
        'disabled-by-default-devtools.timeline',
      ],
    });
    await B.sleep(3000);
    const trace = JSON.parse(
      Buffer.from(await page.tracing.stop()).toString('utf8'),
    );
    const busyByThread = new Map();
    for (const e of trace.traceEvents) {
      if (e.name !== 'RunTask' || !e.dur) continue;
      const k = `${e.pid}:${e.tid}`;
      busyByThread.set(k, (busyByThread.get(k) || 0) + e.dur / 1000);
    }
    const mains = new Set(
      trace.traceEvents
        .filter(
          (e) => e.name === 'thread_name' && e.args?.name === 'CrRendererMain',
        )
        .map((e) => `${e.pid}:${e.tid}`),
    );
    const restMs = Math.max(
      0,
      ...[...busyByThread].filter(([k]) => mains.has(k)).map(([, ms]) => ms),
    );
    check(
      'the page is idle with the map at rest',
      restMs < 300,
      `${restMs.toFixed(0)} ms busy in 3 s`,
    );

    check(
      'no page errors',
      page.__errors.length === 0,
      page.__errors.join(' | '),
    );
  } finally {
    await browser.close();
    server.close();
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
