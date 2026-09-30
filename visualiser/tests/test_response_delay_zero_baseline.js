/**
 * At a response delay of 0 s, the app must produce exactly what it produced
 * before the Response delay build (docs/time_offsets_review.md, Solution
 * design, step 1: "Proof at 0 s"). The record was saved from the code before
 * the build by tests/support/gen_response_delay_baseline.js; hotspots are
 * left out because the build is allowed to change them.
 *
 * Run: node --test tests/test_response_delay_zero_baseline.js
 */

const assert = require('node:assert');
const test = require('node:test');
const path = require('node:path');
const { fixtureRecord } = require('./support/response_delay_baseline.js');

const saved = require(
  path.join(__dirname, 'fixtures/response_delay_zero_baseline.json'),
);
const now = fixtureRecord();

for (const [name, want] of Object.entries(saved.parts)) {
  test(`at 0 s, "${name}" is unchanged since ${saved.savedFrom}`, () => {
    assert.deepStrictEqual(now[name], want);
  });
}

test('the record covers the same parts it was saved with', () => {
  assert.deepStrictEqual(
    Object.keys(now).sort(),
    Object.keys(saved.parts).sort(),
  );
});
