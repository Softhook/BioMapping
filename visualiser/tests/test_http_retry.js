/**
 * Unit tests for osm/http_retry.mjs — the backoff and Retry-After timing
 * shared by the Overpass client and the NDVI tile fetcher.
 *
 * Run: node --test tests/test_http_retry.js
 */

const assert = require('node:assert');
const test = require('node:test');

const { backoffMs, retryAfterMs } = require('../src/osm/http_retry.mjs');

const header = (value) => ({ headers: { get: () => value } });

test('backoffMs: doubles per attempt, within ±25% jitter', () => {
  const base = 1000;
  for (let attempt = 0; attempt < 5; attempt++) {
    const nominal = base * 2 ** attempt;
    for (let sample = 0; sample < 10; sample++) {
      const val = backoffMs(attempt, base);
      assert.ok(
        val >= Math.floor(nominal * 0.75) && val <= Math.ceil(nominal * 1.25),
        `attempt ${attempt}: ${val} should be within ±25% of ${nominal}`,
      );
    }
  }
});

test('backoffMs: returns a whole number of ms', () => {
  const val = backoffMs(2, 777);
  assert.strictEqual(val, Math.round(val));
});

test('retryAfterMs: converts a numeric Retry-After (seconds) to ms', () => {
  assert.strictEqual(retryAfterMs(header('30'), 999), 30000);
  assert.strictEqual(retryAfterMs(header('1.5'), 999), 1500);
});

test('retryAfterMs: asks for the Retry-After header by name', () => {
  const response = {
    headers: { get: (h) => (h === 'Retry-After' ? '12' : null) },
  };
  assert.strictEqual(retryAfterMs(response, 3000), 12000);
});

test('retryAfterMs: falls back when the header is missing, non-numeric or non-positive', () => {
  assert.strictEqual(retryAfterMs(header(null), 12345), 12345);
  assert.strictEqual(retryAfterMs(header('never'), 5000), 5000);
  assert.strictEqual(retryAfterMs(header('0'), 5000), 5000);
  assert.strictEqual(retryAfterMs(header('-5'), 5000), 5000);
});

test('retryAfterMs: falls back when there is no response or no headers', () => {
  assert.strictEqual(retryAfterMs(null, 5000), 5000);
  assert.strictEqual(retryAfterMs({}, 4000), 4000);
});
