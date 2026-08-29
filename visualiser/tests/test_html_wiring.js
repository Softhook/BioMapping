/**
 * Guards the wiring between the two HTML entry points and the files they pull
 * off disk — the seam a directory reorg is most likely to break silently,
 * because a wrong <script src> or fetch() path throws only in a real browser,
 * never in the unit suite.
 *
 * 1. index.html's local <script> order stays identical to SCRIPT_ORDER in
 *    tests/support/boot_app.js (the jsdom smoke harness loads that copy, not
 *    index.html's real tags — nothing else keeps the two in step).
 * 2. live.html loads exactly the two shared modules it needs, from src/.
 * 3. every local href/src in either HTML file resolves to a real file.
 * 4. the demo CSV that tracks.js fetch()es at runtime actually exists where
 *    the fetch path points.
 *
 * CDN resources (https://…) are ignored throughout. config.js is a committed
 * runtime-config pre-load, not an app module, so it's excluded from the order
 * check; it also injects the gitignored config.local.js, but only on a local
 * origin so the hosted site never 404s on it.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { SCRIPT_ORDER } = require('./support/boot_app.js');

const APP_DIR = path.join(__dirname, '..');
const readApp = (rel) => fs.readFileSync(path.join(APP_DIR, rel), 'utf8');

// runtime-config pre-loads, not app modules — excluded from the order check
const NON_MODULE = new Set(['config.js', 'config.local.js']);

// a URL that names a file this repo ships (not a CDN, in-page anchor, or scheme link)
const isLocal = (url) =>
  url !== '' &&
  !/^(https?:)?\/\//.test(url) &&
  !/^(data:|mailto:|tel:|javascript:|#)/.test(url);

/** every `<script src="…">` / `<link href="…">` / `<img src="…">` URL in a file */
function localRefs(html) {
  return [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((m) => m[1])
    .filter(isLocal);
}
/** local `<script src>` app modules, in document order */
function scriptSrcs(html) {
  return [...html.matchAll(/<script\s+src="([^"]+)"><\/script>/g)]
    .map((m) => m[1])
    .filter((s) => isLocal(s) && !NON_MODULE.has(s));
}

test('index.html <script src> order matches boot_app.js SCRIPT_ORDER', () => {
  assert.deepStrictEqual(scriptSrcs(readApp('index.html')), SCRIPT_ORDER);
});

test('live.html loads exactly the two shared src/ modules it depends on', () => {
  assert.deepStrictEqual(scriptSrcs(readApp('live.html')), [
    'src/signal/gsr_filter.js',
    'src/live/live_binary_parser.js',
  ]);
});

for (const page of ['index.html', 'live.html']) {
  test(`${page}: every local href/src resolves to a file on disk`, () => {
    const missing = localRefs(readApp(page)).filter(
      (rel) => !fs.existsSync(path.join(APP_DIR, rel))
    );
    assert.deepStrictEqual(missing, [], `${page} points at missing file(s)`);
  });
}

test('committed config.js defines BIOMAP_CONFIG and both pages load it before any app/inline code', () => {
  assert.ok(fs.existsSync(path.join(APP_DIR, 'config.js')), 'config.js is committed, not gitignored');
  assert.match(readApp('config.js'), /window\.BIOMAP_CONFIG\s*=/);
  for (const page of ['index.html', 'live.html']) {
    const html = readApp(page);
    const cfg = html.indexOf('src="config.js"');
    assert.ok(cfg !== -1, `${page} loads config.js`);
    // must precede the first local app module and any inline <script> block
    const firstModule = html.indexOf('src="src/');
    const firstInline = html.search(/<script>(?!<\/)/);
    assert.ok(firstModule === -1 || cfg < firstModule, `${page}: config.js before first src/ module`);
    assert.ok(firstInline === -1 || cfg < firstInline, `${page}: config.js before first inline <script>`);
    // config.local.js must NOT be a plain tag (would 404 on the hosted site)
    assert.ok(!html.includes('src="config.local.js"'), `${page}: no unconditional config.local.js tag`);
  }
});

test('config.js injects config.local.js only on a local origin, guarded against a late load', () => {
  const src = readApp('config.js');
  assert.match(src, /config\.local\.js/, 'config.js references config.local.js');
  assert.match(src, /location\.protocol\s*===\s*['"]file:['"]/, 'gated on file:// …');
  assert.match(src, /localhost/, '… or localhost');
  assert.match(src, /document\.readyState\s*===\s*['"]loading['"]/, 'only document.write while still parsing');
});

test('map.js and live.html resolve the CARTO key (config → localStorage, guarded) and append ?key=', () => {
  for (const rel of ['src/map/map.js', 'live.html']) {
    const src = readApp(rel);
    assert.match(src, /BIOMAP_CONFIG\s*&&\s*window\.BIOMAP_CONFIG\.cartoApiKey/, `${rel} reads BIOMAP_CONFIG.cartoApiKey`);
    assert.match(src, /getItem\(['"]bioMappingCartoApiKey['"]\)/, `${rel} falls back to the localStorage key`);
    assert.match(src, /try\s*\{[^}]*getItem\(['"]bioMappingCartoApiKey/, `${rel} guards the localStorage read in try/catch`);
    assert.match(src, /\?key=['"]\s*\+\s*encodeURIComponent\(cartoKey\)/, `${rel} appends an encoded ?key=`);
  }
});

test('the demo CSV tracks.js fetch()es exists at that path', () => {
  const src = readApp('src/ui/tracks.js');
  const fetched = [...src.matchAll(/fetch\(['"]([^'"]+)['"]\)/g)]
    .map((m) => m[1])
    .filter(isLocal);
  assert.ok(fetched.length > 0, 'tracks.js makes no local fetch() — test is stale');
  for (const rel of fetched) {
    assert.ok(
      fs.existsSync(path.join(APP_DIR, rel)),
      `tracks.js fetch('${rel}') has no file at visualiser/${rel}`
    );
  }
});
