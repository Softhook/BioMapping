/**
 * Unit tests for overpass_client.js (OverpassClient) — Overpass API query
 * building, rate-limit/backoff/retry logic. Network calls are mocked via a
 * stubbed global.fetch (no real HTTP requests are made).
 *
 * Run: node --test tests/test_overpass_client.js  (or `npm test` for the whole suite)
 */

const assert = require('assert');
const test = require('node:test');

// overpass_client.js's real retry/backoff delays (up to 30s for a 429, and a
// 200s AbortController timeout armed on every attempt) would make this suite
// take minutes if left untouched, and that 200s timer is only clearTimeout()'d
// once `fetch()` *resolves* — on a path where the mocked fetch() *rejects*
// (network error / AbortError, exercised below), it's never cleared at all.
// Cap every setTimeout delay at 100ms and unref() the handle so these tests
// run fast and a leaked timer can never keep this process alive at exit. The
// _enforceRateLimit tests below use cooldowns under that cap (60-80ms) so
// their real-wait assertions are unaffected.
const _origSetTimeout = global.setTimeout;
global.setTimeout = (fn, ms, ...rest) => _origSetTimeout(fn, Math.min(ms, 100), ...rest).unref();

const { OverpassClient } = require('../src/osm/overpass_client.js');

const BBOX = { minLat: 51.5007, minLon: -0.1246, maxLat: 51.5107, maxLon: -0.1146 };

function resetClient() {
  OverpassClient._nextAllowedCallTime = null;
}

// ── buildQuery() ─────────────────────────────────────────────────────────

test('buildQuery: interpolates the bbox (lat,lon,lat,lon order) fixed to 6 decimal places', () => {
  const q = OverpassClient.buildQuery(BBOX);
  const expectedBbox = '51.500700,-0.124600,51.510700,-0.114600';
  assert.ok(q.includes(expectedBbox), 'query should contain the formatted bbox string');
});

test('buildQuery: uses a single global [bbox:...] setting rather than repeating the area filter on every clause', () => {
  const q = OverpassClient.buildQuery(BBOX);
  const expectedBbox = '51.500700,-0.124600,51.510700,-0.114600';
  assert.match(q, /\[bbox:51\.500700,-0\.124600,51\.510700,-0\.114600\];/);
  // Only the global [bbox:...] setting carries the coordinates — individual
  // clauses (e.g. way["highway"];) rely on it instead of repeating "(${b})".
  const occurrences = q.split(expectedBbox).length - 1;
  assert.strictEqual(occurrences, 1, `expected the bbox string to appear exactly once (in [bbox:...]), got ${occurrences}`);
  assert.ok(!q.includes(`(${expectedBbox})`), 'no clause should carry its own per-statement bbox filter');
});

test('buildQuery: rounds/pads bbox coordinates to exactly 6 decimals regardless of input precision', () => {
  const q = OverpassClient.buildQuery({ minLat: 1, minLon: 2, maxLat: 3, maxLon: 4 });
  assert.ok(q.includes('1.000000,2.000000,3.000000,4.000000'));
});

test('buildQuery: includes [out:json], timeout, and maxsize directives', () => {
  const q = OverpassClient.buildQuery(BBOX);
  assert.match(q, /\[out:json\]\[timeout:180\]\[maxsize:536870912\]\[bbox:[^\]]+\];/);
});

test('buildQuery: requests highway/building/leisure/natural/amenity/shop feature classes', () => {
  const q = OverpassClient.buildQuery(BBOX);
  for (const clause of [
    'way["highway"]', 'way["building"]', 'relation["building"]',
    'way["leisure"~"park|garden|nature_reserve"]',
    'way["natural"~"wood|scrub|grassland|heath|wetland"]',
    'way["natural"~"water|wetland"]', 'way["waterway"]',
    'node["amenity"]', 'way["shop"]', 'node["highway"="bus_stop"]', 'node["natural"="tree"]',
    'way["natural"="tree_row"]',
  ]) {
    assert.ok(q.includes(clause), `query should include ${clause}`);
  }
});

test('buildQuery: fetches natural=tree_row (ways + relations) — needed for osm_canopy_pct', () => {
  const q = OverpassClient.buildQuery(BBOX);
  assert.ok(q.includes('way["natural"="tree_row"]'), 'tree_row ways fetched');
  assert.ok(q.includes('relation["natural"="tree_row"]'), 'tree_row relations fetched');
});

test('buildQuery: does NOT request leisure=playground — it is not green space (matches _isGreenSpace / GREEN_LEISURE)', () => {
  const q = OverpassClient.buildQuery(BBOX);
  assert.ok(!q.includes('playground'), 'playground must not appear in any query clause');
});

test('buildQuery: fetches natural=wetland via BOTH the green and the water clause (wetland is blue and green)', () => {
  const q = OverpassClient.buildQuery(BBOX);
  assert.ok(q.includes('way["natural"~"wood|scrub|grassland|heath|wetland"]'), 'wetland is in the green natural clause');
  assert.ok(q.includes('way["natural"~"water|wetland"]'), 'wetland is still in the water natural clause');
});

test('buildQuery: ends with the standard "out body; >; out skel qt;" recursion idiom', () => {
  const q = OverpassClient.buildQuery(BBOX);
  assert.ok(q.trim().endsWith('out body;\n>;\nout skel qt;'));
});

// ── _backoffMs() ─────────────────────────────────────────────────────────

test('_backoffMs: grows exponentially with attempt number (within jitter bounds)', () => {
  const base = 1000;
  for (let attempt = 0; attempt < 5; attempt++) {
    const val = OverpassClient._backoffMs(attempt, base);
    const nominal = base * Math.pow(2, attempt);
    assert.ok(val >= nominal * 0.75 - 1 && val <= nominal * 1.25 + 1,
      `attempt ${attempt}: ${val} should be within +-25% of ${nominal}`);
  }
});

test('_backoffMs: returns an integer (Math.round applied)', () => {
  const val = OverpassClient._backoffMs(2, 777);
  assert.strictEqual(val, Math.round(val));
});

// ── _retryAfterMs() ──────────────────────────────────────────────────────

test('_retryAfterMs: uses the fallback when there is no Retry-After header', () => {
  const response = { headers: { get: () => null } };
  assert.strictEqual(OverpassClient._retryAfterMs(response, 12345), 12345);
});

test('_retryAfterMs: parses a numeric Retry-After header into milliseconds', () => {
  const response = { headers: { get: () => '30' } };
  assert.strictEqual(OverpassClient._retryAfterMs(response, 999), 30000);
});

test('_retryAfterMs: falls back when Retry-After is non-numeric or non-positive', () => {
  assert.strictEqual(OverpassClient._retryAfterMs({ headers: { get: () => 'never' } }, 5000), 5000);
  assert.strictEqual(OverpassClient._retryAfterMs({ headers: { get: () => '0' } }, 5000), 5000);
  assert.strictEqual(OverpassClient._retryAfterMs({ headers: { get: () => '-5' } }, 5000), 5000);
});

// ── _enforceRateLimit() ──────────────────────────────────────────────────

test('_enforceRateLimit: resolves immediately when there is no cooldown set', async () => {
  resetClient();
  const start = Date.now();
  await OverpassClient._enforceRateLimit();
  assert.ok(Date.now() - start < 50, 'should not wait when _nextAllowedCallTime is null');
});

test('_enforceRateLimit: resolves immediately when the cooldown has already passed', async () => {
  resetClient();
  OverpassClient._nextAllowedCallTime = Date.now() - 1000;
  const start = Date.now();
  await OverpassClient._enforceRateLimit();
  assert.ok(Date.now() - start < 50);
});

test('_enforceRateLimit: waits out the remaining cooldown and reports progress', async () => {
  resetClient();
  OverpassClient._nextAllowedCallTime = Date.now() + 80;
  const progressMsgs = [];
  const start = Date.now();
  await OverpassClient._enforceRateLimit((msg) => progressMsgs.push(msg));
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 70, `should have waited out the cooldown, only waited ${elapsed}ms`);
  assert.strictEqual(progressMsgs.length, 1);
  assert.match(progressMsgs[0], /Rate-limited\. Waiting \d+s/);
});

// ── fetchOSMData() ───────────────────────────────────────────────────────

test('fetchOSMData: happy path returns parsed JSON and reports progress milestones', async () => {
  resetClient();
  const payload = { elements: [{ type: 'node', id: 1 }] };
  let fetchCalls = 0;
  global.fetch = async (url, opts) => {
    fetchCalls++;
    assert.strictEqual(url, OverpassClient.overpassEndpoint);
    assert.strictEqual(opts.method, 'POST');
    assert.ok(opts.body.startsWith('data='));
    return { ok: true, status: 200, json: async () => payload };
  };

  const progress = [];
  const result = await OverpassClient.fetchOSMData(BBOX, (msg) => progress.push(msg));

  assert.strictEqual(fetchCalls, 1);
  assert.deepStrictEqual(result, payload);
  assert.ok(progress.some(m => /Connecting/.test(m)));
  assert.ok(progress.some(m => /Parsing geographical payload/.test(m)));
});

test('fetchOSMData: 429 sets a rate-limit cooldown, retries, then succeeds', async () => {
  resetClient();
  let attempt = 0;
  global.fetch = async () => {
    attempt++;
    if (attempt === 1) {
      return { ok: false, status: 429, headers: { get: (h) => (h === 'Retry-After' ? '0' : null) }, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };

  const progress = [];
  const result = await OverpassClient.fetchOSMData(BBOX, (msg) => progress.push(msg));

  assert.strictEqual(attempt, 2, 'should retry once after the 429');
  assert.deepStrictEqual(result, { ok: true });
  assert.ok(progress.some(m => /rate-limited/i.test(m)));
  assert.ok(OverpassClient._nextAllowedCallTime !== null, '_nextAllowedCallTime should be set after a 429');
});

test('fetchOSMData: 429 exhausting all retries throws a descriptive rate-limit error', async () => {
  resetClient();
  global.fetch = async () => ({
    ok: false, status: 429,
    headers: { get: (h) => (h === 'Retry-After' ? '0' : null) },
  });

  let attempts = 0;
  const origFetch = global.fetch;
  global.fetch = async (...args) => { attempts++; return origFetch(...args); };

  await assert.rejects(
    () => OverpassClient.fetchOSMData(BBOX),
    /rate-limited/i
  );
  assert.strictEqual(attempts, 4, 'initial attempt + 3 retries = 4 total fetch calls');
});

test('fetchOSMData: 509 is treated the same as 429 (rate-limited retry path)', async () => {
  resetClient();
  let attempt = 0;
  global.fetch = async () => {
    attempt++;
    if (attempt === 1) {
      return { ok: false, status: 509, headers: { get: (h) => (h === 'Retry-After' ? '0' : null) } };
    }
    return { ok: true, status: 200, json: async () => ({ done: true }) };
  };
  const result = await OverpassClient.fetchOSMData(BBOX);
  assert.deepStrictEqual(result, { done: true });
});

test('fetchOSMData: 504 retries with exponential backoff, then succeeds', async () => {
  resetClient();
  let attempt = 0;
  global.fetch = async () => {
    attempt++;
    if (attempt <= 2) return { ok: false, status: 504, headers: { get: () => null } };
    return { ok: true, status: 200, json: async () => ({ recovered: true }) };
  };
  const progress = [];
  const result = await OverpassClient.fetchOSMData(BBOX, (m) => progress.push(m));
  assert.strictEqual(attempt, 3);
  assert.deepStrictEqual(result, { recovered: true });
  assert.ok(progress.some(m => /timed out \(504\)/.test(m)));
});

test('fetchOSMData: 504 exhausting all retries throws a "too large" style error', async () => {
  resetClient();
  global.fetch = async () => ({ ok: false, status: 504, headers: { get: () => null } });
  await assert.rejects(
    () => OverpassClient.fetchOSMData(BBOX),
    /timed out after 4 attempts/
  );
});

test('fetchOSMData: a 4xx/5xx status with a known hint throws that specific hint message', async () => {
  resetClient();
  global.fetch = async () => ({ ok: false, status: 403, headers: { get: () => null } });
  await assert.rejects(
    () => OverpassClient.fetchOSMData(BBOX),
    /Access denied by the Overpass API/
  );
});

test('fetchOSMData: an unrecognised status code throws a generic "Unexpected HTTP" error', async () => {
  resetClient();
  global.fetch = async () => ({ ok: false, status: 418, headers: { get: () => null } });
  await assert.rejects(
    () => OverpassClient.fetchOSMData(BBOX),
    /Unexpected HTTP 418/
  );
});

test('fetchOSMData: AbortError (timeout) is retried then can succeed', async () => {
  resetClient();
  let attempt = 0;
  global.fetch = async () => {
    attempt++;
    if (attempt === 1) {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    }
    return { ok: true, status: 200, json: async () => ({ afterAbort: true }) };
  };
  const progress = [];
  const result = await OverpassClient.fetchOSMData(BBOX, (m) => progress.push(m));
  assert.strictEqual(attempt, 2);
  assert.deepStrictEqual(result, { afterAbort: true });
  assert.ok(progress.some(m => /Request timed out\. Retrying/.test(m)));
});

test('fetchOSMData: a non-AbortError thrown by fetch propagates immediately without retrying', async () => {
  resetClient();
  let attempt = 0;
  global.fetch = async () => {
    attempt++;
    throw new Error('network down');
  };
  await assert.rejects(() => OverpassClient.fetchOSMData(BBOX), /network down/);
  assert.strictEqual(attempt, 1, 'should not retry on a generic (non-Abort) network error');
});

test('fetchOSMData: honours an existing rate-limit cooldown before issuing the first fetch', async () => {
  resetClient();
  OverpassClient._nextAllowedCallTime = Date.now() + 60;
  let fetchCalledAt = null;
  global.fetch = async () => {
    fetchCalledAt = Date.now();
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const start = Date.now();
  await OverpassClient.fetchOSMData(BBOX);
  assert.ok(fetchCalledAt - start >= 50, 'fetch should not fire until the cooldown elapses');
});
