/**
 * Regenerates tests/fixtures/map_render_baseline.json (see
 * test_map_render_baseline.js).
 *
 * Only run this deliberately, after confirming a change to what the map
 * draws is intended — regenerating the record is what turns off the test's
 * protection for whatever just moved. Say why in the commit message.
 *
 * Run: node tests/support/gen_map_render_baseline.js
 */
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { mapRenderRecord } = require('./map_render_record.js');

const OUT = path.join(__dirname, '..', 'fixtures', 'map_render_baseline.json');

(async () => {
  let savedFrom = 'unknown';
  try {
    savedFrom = execSync('git rev-parse --short HEAD', { cwd: __dirname })
      .toString()
      .trim();
  } catch (_e) {
    /* not a git checkout */
  }
  const parts = await mapRenderRecord();
  fs.writeFileSync(OUT, `${JSON.stringify({ savedFrom, parts }, null, 2)}\n`);
  console.log(`Wrote ${Object.keys(parts).length} parts to ${OUT}`);
  process.exit(0);
})();
