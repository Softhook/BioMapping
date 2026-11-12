/**
 * The map must draw exactly what it drew when the record was saved: every
 * track-line piece and its colour (including where the walk retraces itself
 * and the colours are pooled), peak dots, connectors, hotspots, the legend
 * range and the Arousal Places, single and Collective, at several Response
 * delays, line widths and colour metrics. Guards the drawing speed-ups
 * (values worked out once per point, cached gap breaks, reused 3×3 overlap
 * lookups, Response delay lookup tables) against changing the picture.
 *
 * If a change to the map's look is intended, regenerate the record with
 * `node tests/support/gen_map_render_baseline.js` and say why in the commit.
 *
 * Run: node --test tests/test_map_render_baseline.js
 */

const assert = require('node:assert');
const test = require('node:test');
const path = require('node:path');
const { mapRenderRecord } = require('./support/map_render_record.js');

const saved = require(
  path.join(__dirname, 'fixtures/map_render_baseline.json'),
);

test('the map draws what it drew when the record was saved', async (t) => {
  const now = await mapRenderRecord();
  await t.test('the record covers the same parts it was saved with', () => {
    assert.deepStrictEqual(
      Object.keys(now).sort(),
      Object.keys(saved.parts).sort(),
    );
  });
  for (const [name, want] of Object.entries(saved.parts)) {
    await t.test(`"${name}" is unchanged since ${saved.savedFrom}`, () => {
      assert.deepStrictEqual(now[name], want);
    });
  }
});
