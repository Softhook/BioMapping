/**
 * A peak label with no room on the map becomes a hover tooltip. Leaflet
 * renders a string tooltip as HTML and labels can arrive in an imported CSV,
 * so the tooltip text must be escaped.
 */
const test = require('node:test');
const assert = require('node:assert');

global.GSR_CONST = require('./mock_constants.js');
const { GSRMapPeaks } = require('../src/map/manager/peaks.mjs');

test('_buildPeakMarker: unplaceable label reaches the tooltip HTML-escaped', () => {
  let tooltip = null;
  global.L = {
    marker: () => ({
      setZIndexOffset() {},
      bindTooltip(content) {
        tooltip = content;
      },
    }),
  };
  try {
    const label = '<img src=x onerror="alert(1)">';
    const marker = GSRMapPeaks.prototype._buildPeakMarker.call(
      {},
      51,
      0,
      label,
      null, // all 8 label positions overlapped
      {},
      0,
      0,
    );
    assert.strictEqual(marker.hasLabel, true);
    assert.ok(!tooltip.includes('<img'), `unescaped tooltip: ${tooltip}`);
    assert.ok(tooltip.includes('&lt;img'));
  } finally {
    delete global.L;
  }
});
