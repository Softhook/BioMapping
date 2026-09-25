/**
 * Regenerates tests/fixtures/gps_characterization_baseline.json.
 *
 * Only run this deliberately, after confirming a GPS filter change is an
 * intentional behaviour change — regenerating the baseline is what turns off
 * test_gps_characterization.js's protection for whatever just moved. Explain
 * why in the commit message.
 *
 * Run: node tests/support/gen_gps_characterization_baseline.js
 */
const fs = require('node:fs');
const path = require('node:path');
const { computeCharacterizationMetrics } = require('./gps_characterization.js');

const FIXTURE_PATH = path.join(
  __dirname,
  '..',
  '..',
  'fixtures',
  'default_processed.csv',
);
const BASELINE_PATH = path.join(
  __dirname,
  '..',
  'fixtures',
  'gps_characterization_baseline.json',
);

const csvText = fs.readFileSync(FIXTURE_PATH, 'utf8');
const baseline = {
  _comment:
    "Golden-master metrics for the GPS filter pipeline (HDOP/fix-type gates → constant-velocity Kalman+RTS → 10Hz reconstruction) run over fixtures/default_processed.csv with GSR_CONST.GPS_DEFAULT params. Regenerate with `node tests/support/gen_gps_characterization_baseline.js` ONLY when a GPS filter change is an intentional behaviour change, and describe why in the commit message. See test_gps_characterization.js and docs/todo.md's 'Characterisation harness' note.",
  default_processed: computeCharacterizationMetrics(csvText),
};

fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
console.log(`Wrote ${BASELINE_PATH}:`);
console.log(JSON.stringify(baseline, null, 2));
