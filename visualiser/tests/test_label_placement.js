/**
 * Unit tests for label_placement.js (GSRLabelManager) — pure cartographic
 * label placement logic, extracted from map.js.
 *
 * Run: node --test tests/test_label_placement.js  (or `npm test` for the whole suite)
 */

const assert = require('assert');
const test = require('node:test');

// buildLabelledIcon() calls the global Leaflet `L.divIcon`; stub it before
// requiring the module so the module-level code doesn't need Leaflet itself.
global.L = { divIcon: (opts) => opts };

const { GSRLabelManager } = require('../src/render/label_placement.js');

test('textWidth: empty string returns just the padding', () => {
  assert.strictEqual(GSRLabelManager.textWidth(''), 8);
});

test('textWidth: grows with character count and character class', () => {
  const short = GSRLabelManager.textWidth('a');
  const long = GSRLabelManager.textWidth('aaaaaaaaaa');
  assert.ok(long > short, 'longer text should be wider');

  const upper = GSRLabelManager.textWidth('W'); // wide uppercase
  const narrow = GSRLabelManager.textWidth('i'); // narrow lowercase
  assert.ok(upper > narrow, 'wide glyphs should measure wider than narrow glyphs');
});

test('textWidth: caps at 160px for very long strings', () => {
  const huge = GSRLabelManager.textWidth('M'.repeat(200));
  assert.strictEqual(huge, 160);
});

test('textWidth: always returns an integer (Math.ceil applied)', () => {
  const w = GSRLabelManager.textWidth('Stress Peak 12.3');
  assert.strictEqual(w, Math.round(w));
});

test('computeLabelPositions: empty input returns empty Map', () => {
  const result = GSRLabelManager.computeLabelPositions([]);
  assert.ok(result instanceof Map);
  assert.strictEqual(result.size, 0);
});

test('computeLabelPositions: single peak gets a placed label with a valid box', () => {
  const result = GSRLabelManager.computeLabelPositions([{ idx: 0, px: 100, py: 100, text: 'A' }]);
  assert.strictEqual(result.size, 1);
  const placed = result.get(0);
  assert.ok(placed, 'peak idx 0 should have a placement');
  assert.ok(['N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW'].includes(placed.dir));
  const { box } = placed;
  assert.ok(Number.isFinite(box.left) && Number.isFinite(box.top));
  assert.ok(box.right > box.left, 'box should have positive width');
  assert.ok(box.bottom > box.top, 'box should have positive height');
});

test('computeLabelPositions: peak without text falls back to a default width candidate set', () => {
  // No `text` field — textWidth() is skipped in favour of a fixed 120px width.
  const result = GSRLabelManager.computeLabelPositions([{ idx: 7, px: 50, py: 50 }]);
  assert.strictEqual(result.size, 1);
  const { box } = result.get(7);
  assert.strictEqual(box.right - box.left, 120);
});

test('computeLabelPositions: widely-spaced peaks all get placed with non-overlapping boxes', () => {
  const peaks = [
    { idx: 0, px: 0, py: 0, text: 'Peak A' },
    { idx: 1, px: 500, py: 0, text: 'Peak B' },
    { idx: 2, px: 0, py: 500, text: 'Peak C' },
    { idx: 3, px: 500, py: 500, text: 'Peak D' },
  ];
  const result = GSRLabelManager.computeLabelPositions(peaks);
  assert.strictEqual(result.size, 4, 'all 4 well-separated peaks should be placed');

  const boxes = [...result.values()].map(r => r.box);
  const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      assert.ok(!overlaps(boxes[i], boxes[j]), `boxes ${i} and ${j} should not overlap`);
    }
  }
});

test('computeLabelPositions: crowded cluster never returns more placements than input peaks', () => {
  // Many peaks crammed into a tiny area — some may be dropped by the greedy
  // pack step, but the result can never exceed the input count, and every
  // idx present must trace back to an input peak.
  const peaks = [];
  for (let i = 0; i < 12; i++) {
    peaks.push({ idx: i, px: 10 + (i % 3), py: 10 + Math.floor(i / 3), text: `P${i}` });
  }
  const result = GSRLabelManager.computeLabelPositions(peaks);
  assert.ok(result.size <= peaks.length);
  for (const idx of result.keys()) {
    assert.ok(peaks.some(p => p.idx === idx));
  }
});

test('buildLabelledIcon: returns a Leaflet divIcon config with correct icon anchor/size', () => {
  const dirResult = { dir: 'N', box: { left: 90, top: 60, right: 150, bottom: 78 } };
  const icon = GSRLabelManager.buildLabelledIcon(100, 100, 'Stress 12.3', dirResult);

  assert.ok(Array.isArray(icon.iconSize) && icon.iconSize.length === 2);
  assert.ok(Array.isArray(icon.iconAnchor) && icon.iconAnchor.length === 2);
  assert.strictEqual(typeof icon.html, 'string');
  assert.ok(icon.html.includes('Stress 12.3'));
  assert.ok(icon.html.includes('stress-peak-icon-wrapper'));
  assert.ok(icon.html.includes('peak-glow-ring'), 'showGlow defaults to true');
});

test('buildLabelledIcon: escapes HTML-significant characters in the label text', () => {
  const dirResult = { dir: 'N', box: { left: 90, top: 60, right: 150, bottom: 78 } };
  const icon = GSRLabelManager.buildLabelledIcon(100, 100, '<script>"x"</script>', dirResult);
  assert.ok(!icon.html.includes('<script>'));
  assert.ok(icon.html.includes('&lt;script&gt;'));
  assert.ok(icon.html.includes('&quot;x&quot;'));
});

test('buildLabelledIcon: showGlow=false omits the glow ring element', () => {
  const dirResult = { dir: 'S', box: { left: 90, top: 110, right: 150, bottom: 128 } };
  const icon = GSRLabelManager.buildLabelledIcon(100, 100, 'X', dirResult, { showGlow: false });
  assert.ok(!icon.html.includes('peak-glow-ring'));
});

test('buildLabelledIcon: respects custom wrapper/dot class and dot pixel size overrides', () => {
  const dirResult = { dir: 'E', box: { left: 110, top: 92, right: 170, bottom: 110 } };
  const icon = GSRLabelManager.buildLabelledIcon(100, 100, 'X', dirResult, {
    wrapperClass: 'custom-wrapper',
    dotClass: 'custom-dot',
    dotPx: 20,
  });
  assert.ok(icon.html.includes('custom-wrapper'));
  assert.ok(icon.html.includes('custom-dot'));
  assert.ok(icon.html.includes('width:20px;height:20px'));
});
