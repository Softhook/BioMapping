/**
 * Saves today's 0 s record for the fixture walk to
 * tests/fixtures/response_delay_zero_baseline.json. Run once, BEFORE the
 * Response delay build, from visualiser/:
 *
 *   node tests/support/gen_response_delay_baseline.js
 *
 * test_response_delay_zero_baseline.js then checks the built app still
 * produces the same record at 0 s.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { fixtureRecord } = require('./response_delay_baseline.js');

const out = path.join(
  __dirname,
  '../fixtures/response_delay_zero_baseline.json',
);
const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
  encoding: 'utf8',
}).trim();
const record = { savedFrom: commit, parts: fixtureRecord() };
fs.writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
console.log(
  `Saved ${Object.keys(record.parts).length} parts from ${commit} to ${out}`,
);
