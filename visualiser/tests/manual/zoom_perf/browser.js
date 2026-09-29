/**
 * Shared set-up for the zoom performance tools (run.js, check.js): serve a
 * copy of the visualiser, open it in the installed Google Chrome as a phone or
 * a desktop, and load a view with real track data.
 *
 * Map tiles are answered with a blank image (and every other outside request
 * with nothing), so network speed never enters a measurement.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer-core');

const REPO = path.join(__dirname, '..', '..', '..', '..');
const TRACKS = path.join(REPO, 'tracks');
const VISUALISER = path.join(REPO, 'visualiser');

const DEVICES = {
  // A current phone: small screen, 3x pixel density, touch.
  phone: {
    viewport: {
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
    },
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  },
  desktop: {
    viewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  },
};

const CHROME_PATHS = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);

const CONTENT_TYPES = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.html': 'text/html',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.csv': 'text/csv',
};
const BLANK_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Serve `root` (a visualiser folder) and the repo's tracks/ on localhost. */
async function startServer(root) {
  const server = http.createServer((req, res) => {
    let url = decodeURIComponent(req.url.split('?')[0]);
    if (url === '/') url = '/index.html';
    const file = url.startsWith('/tracks/')
      ? path.join(TRACKS, url.slice('/tracks/'.length))
      : path.join(root, url);
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, {
        'content-type':
          CONTENT_TYPES[path.extname(file)] || 'application/octet-stream',
      });
      res.end(data);
    });
  });
  await new Promise((r) => server.listen(0, r));
  const url = `http://localhost:${server.address().port}`;
  return { url, close: () => server.close() };
}

async function launch({ headful = false } = {}) {
  const executablePath = CHROME_PATHS.find((p) => fs.existsSync(p));
  if (!executablePath) {
    throw new Error(
      'Google Chrome not found — install it or set CHROME_PATH to its executable.',
    );
  }
  return puppeteer.launch({
    executablePath,
    headless: headful ? false : 'new',
    args: ['--window-size=1500,1000'],
  });
}

/** A new page with the device applied and outside requests stubbed. */
async function newPage(browser, baseUrl, device) {
  const page = await browser.newPage();
  page.__errors = [];
  page.on('pageerror', (e) => page.__errors.push(String(e).slice(0, 300)));
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = req.url();
    if (u.startsWith(baseUrl)) return req.continue();
    if (/\.(png|jpg)(\?|$)/.test(u) || /tile|basemaps/.test(u)) {
      return req.respond({
        status: 200,
        contentType: 'image/png',
        body: BLANK_PNG,
      });
    }
    return req.respond({ status: 200, contentType: 'text/plain', body: '' });
  });
  await page.emulate(DEVICES[device]);
  // The app's modules, loaded inside the page by URL (e.g.
  // '/src/core/app_state.mjs'); these are the same instances the app uses.
  await page.evaluateOnNewDocument(() => {
    window.pageImport = (url) => import(url);
  });
  return page;
}

/**
 * Open the app on `view` with data loaded; returns the map's CSS selector.
 *   single     — `tracks` (first one) as a single track
 *   collective — every file in `tracks`, then the Collective tab
 *   live       — the first track replayed as live Bluetooth packets (~5 Hz),
 *                ~8 min of walk up front, then one packet every 200 ms
 */
async function openView(page, baseUrl, view, tracks) {
  await page.goto(`${baseUrl}/index.html`, { waitUntil: 'load' });
  await sleep(1500);
  if (view === 'live') {
    await page.click('#btnLiveView');
    await sleep(800);
    await page.evaluate(async (file) => {
      document.getElementById('skipConnectBtn')?.click();
      const { LiveState } = await window.pageImport('/src/live/live_state.mjs');
      const text = await (await fetch(`/tracks/${file}`)).text();
      const lines = text.split('\n').filter((l) => l && !l.startsWith('#'));
      const head = lines[0].split(',');
      const col = (n) => head.indexOf(n);
      const toPacket = (r) => {
        const lat = +r[col('lat')];
        const lon = +r[col('lon')];
        const valid = Number.isFinite(lat) && lat !== 0;
        return {
          timestamp: +r[col('timestamp')],
          lat: valid ? lat : Number.NaN,
          lon: valid ? lon : Number.NaN,
          gsrRaw: +r[col('gsr_raw')],
          hdop: +r[col('hdop')],
          pdop: +r[col('pdop')],
          speedKts: +r[col('speed_kts')],
          courseDeg: +r[col('course_deg')],
          sats: +r[col('sats')],
          fixType: +r[col('fix_type')],
          valid,
          hacc: +r[col('hacc_m')],
        };
      };
      const packets = lines
        .slice(1)
        .filter((_, i) => i % 2 === 0)
        .map((l) => toPacket(l.split(',')));
      LiveState.setStatus('connected');
      let i = 0;
      for (; i < 2400 && i < packets.length; i++) {
        LiveState.addPacket(packets[i]);
      }
      window.__liveFeed = setInterval(() => {
        if (i < packets.length) LiveState.addPacket(packets[i++]);
      }, 200);
    }, path.basename(tracks[0]));
    await sleep(4000);
    return '#liveMap';
  }

  await page.click('#btnSingleView');
  await sleep(500);
  const files = view === 'single' ? tracks.slice(0, 1) : tracks;
  await (await page.$('#fileInput')).uploadFile(...files);
  await page.waitForFunction(
    () => document.querySelector('#map canvas.leaflet-zoom-animated'),
    { timeout: 120000, polling: 250 },
  );
  await sleep(4000);
  if (view === 'collective') {
    await page.click('#btnCollectiveView');
    await sleep(5000);
  }
  return '#map';
}

/** Default track sets: one long walk, and eight walks for Collective. */
function defaultTracks(view) {
  if (view !== 'collective') return [path.join(TRACKS, 'biomap_019.csv')];
  return fs
    .readdirSync(TRACKS)
    .filter((f) => /^biomap_0\d\d\.csv$/.test(f))
    .slice(0, 8)
    .map((f) => path.join(TRACKS, f));
}

module.exports = {
  DEVICES,
  REPO,
  TRACKS,
  VISUALISER,
  defaultTracks,
  launch,
  newPage,
  openView,
  sleep,
  startServer,
};
