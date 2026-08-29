/**
 * Unit tests for map_colors.js (MapColors) — color scale/LUT helpers,
 * pure computation extracted from map.js.
 *
 * Run: node --test tests/test_map_colors.js  (or `npm test` for the whole suite)
 */

const assert = require('assert');
const test = require('node:test');

const { MapColors } = require('../src/map/map_colors.js');

// ---------------------------------------------------------------------------
// getHslColor
// ---------------------------------------------------------------------------

test('getHslColor: ratio 0 -> pure green (hue 120), default sat/lightness', () => {
  assert.strictEqual(MapColors.getHslColor(0), 'hsl(120, 100%, 50%)');
});

test('getHslColor: ratio 1 -> pure red (hue 0), default sat/lightness', () => {
  assert.strictEqual(MapColors.getHslColor(1), 'hsl(0, 100%, 50%)');
});

test('getHslColor: ratio 0.5 -> midpoint yellow (hue 60)', () => {
  assert.strictEqual(MapColors.getHslColor(0.5), 'hsl(60, 100%, 50%)');
});

test('getHslColor: ratio below 0 clamps to 0 (green)', () => {
  assert.strictEqual(MapColors.getHslColor(-5), 'hsl(120, 100%, 50%)');
});

test('getHslColor: ratio above 1 clamps to 1 (red)', () => {
  assert.strictEqual(MapColors.getHslColor(5), 'hsl(0, 100%, 50%)');
});

test('getHslColor: custom saturation/lightness are passed through verbatim', () => {
  assert.strictEqual(MapColors.getHslColor(0.5, 80, 30), 'hsl(60, 80%, 30%)');
});

// ---------------------------------------------------------------------------
// getColorForValue
// ---------------------------------------------------------------------------

test('getColorForValue: maxVal === minVal returns the default green sentinel', () => {
  assert.strictEqual(MapColors.getColorForValue(999, 5, 5), 'hsl(120, 90%, 50%)');
});

test('getColorForValue: val === minVal -> green end of scale', () => {
  assert.strictEqual(MapColors.getColorForValue(0, 0, 10), 'hsl(120, 90%, 50%)');
});

test('getColorForValue: val === maxVal -> red end of scale', () => {
  assert.strictEqual(MapColors.getColorForValue(10, 0, 10), 'hsl(0, 90%, 50%)');
});

test('getColorForValue: val at midpoint -> yellow', () => {
  assert.strictEqual(MapColors.getColorForValue(5, 0, 10), 'hsl(60, 90%, 50%)');
});

test('getColorForValue: val below minVal clamps to green (does not go out of range)', () => {
  assert.strictEqual(MapColors.getColorForValue(-100, 0, 10), 'hsl(120, 90%, 50%)');
});

test('getColorForValue: val above maxVal clamps to red', () => {
  assert.strictEqual(MapColors.getColorForValue(1000, 0, 10), 'hsl(0, 90%, 50%)');
});

// ---------------------------------------------------------------------------
// getColorForMetric
// ---------------------------------------------------------------------------

test('getColorForMetric: arousal-family metrics (gsr, phasic, tonic, peakDensity, phasicAUC, arousalIndex) share the green->red gradient', () => {
  const metrics = ['gsr', 'phasic', 'tonic', 'peakDensity', 'phasicAUC', 'arousalIndex'];
  for (const metric of metrics) {
    assert.strictEqual(MapColors.getColorForMetric(metric, 5, 0, 10), 'hsl(60, 90%, 50%)', metric);
    assert.strictEqual(MapColors.getColorForMetric(metric, 0, 0, 10), 'hsl(120, 90%, 50%)', metric);
    assert.strictEqual(MapColors.getColorForMetric(metric, 10, 0, 10), 'hsl(0, 90%, 50%)', metric);
  }
});

test('getColorForMetric: arousal-family metric with minVal===maxVal returns default green regardless of val', () => {
  assert.strictEqual(MapColors.getColorForMetric('phasicAUC', 123, 7, 7), 'hsl(120, 90%, 50%)');
});

test('getColorForMetric: em_fog / emFog use a blue->magenta gradient (hue 220-300), both spellings alias to same logic', () => {
  assert.strictEqual(MapColors.getColorForMetric('em_fog', 5, 0, 10), 'hsl(260, 90%, 55%)');
  assert.strictEqual(MapColors.getColorForMetric('emFog', 0, 0, 10), 'hsl(220, 90%, 55%)');
  assert.strictEqual(MapColors.getColorForMetric('em_fog', 10, 0, 10), 'hsl(300, 90%, 55%)');
});

test('getColorForMetric: em_fog with minVal===maxVal treats ratio as 0 (blue)', () => {
  assert.strictEqual(MapColors.getColorForMetric('em_fog', 5, 5, 5), 'hsl(220, 90%, 55%)');
});

test('getColorForMetric: roadClass looks up a fixed hex palette by road value', () => {
  assert.strictEqual(MapColors.getColorForMetric('roadClass', 'motorway', 0, 1), '#ff0055');
  assert.strictEqual(MapColors.getColorForMetric('roadClass', 'residential', 0, 1), '#0099ff');
  assert.strictEqual(MapColors.getColorForMetric('roadClass', 'steps', 0, 1), '#cc9966');
});

test('getColorForMetric: roadClass with unrecognized value falls back to neutral gray', () => {
  assert.strictEqual(MapColors.getColorForMetric('roadClass', 'not_a_real_road_type', 0, 1), '#666666');
});

test('getColorForMetric: inPark is a strict-equality boolean-ish flag (1 -> green, anything else -> gray)', () => {
  assert.strictEqual(MapColors.getColorForMetric('inPark', 1, 0, 1), '#00e575');
  assert.strictEqual(MapColors.getColorForMetric('inPark', 0, 0, 1), '#666666');
  // Documented edge case: comparison is `val === 1` (strict), so a string '1'
  // does NOT match the numeric sentinel the rest of the codebase writes.
  assert.strictEqual(MapColors.getColorForMetric('inPark', '1', 0, 1), '#666666');
});

test('getColorForMetric: hdopQuality treats NaN and values >= 50 (incl. the 99.9 no-data sentinel) as unknown/gray', () => {
  assert.strictEqual(MapColors.getColorForMetric('hdopQuality', NaN, 0, 10), '#888888');
  assert.strictEqual(MapColors.getColorForMetric('hdopQuality', 50, 0, 10), '#888888');
  assert.strictEqual(MapColors.getColorForMetric('hdopQuality', 99.9, 0, 100), '#888888');
});

test('getColorForMetric: hdopQuality maps low HDOP (good accuracy) to green, high to red', () => {
  assert.strictEqual(MapColors.getColorForMetric('hdopQuality', 0, 0, 10), 'hsl(120, 90%, 45%)');
  assert.strictEqual(MapColors.getColorForMetric('hdopQuality', 10, 0, 10), 'hsl(0, 90%, 45%)');
});

test('getColorForMetric: hdopQuality with minVal===maxVal (and val below the 50 sentinel) treats ratio as 0', () => {
  assert.strictEqual(MapColors.getColorForMetric('hdopQuality', 5, 5, 5), 'hsl(120, 90%, 45%)');
});

test('getColorForMetric: greenPct goes brown(30)->green(130) hue', () => {
  assert.strictEqual(MapColors.getColorForMetric('greenPct', 0, 0, 100), 'hsl(30, 80%, 45%)');
  assert.strictEqual(MapColors.getColorForMetric('greenPct', 100, 0, 100), 'hsl(130, 80%, 45%)');
});

test('getColorForMetric: buildingDensity goes green(120)->red(0) hue', () => {
  assert.strictEqual(MapColors.getColorForMetric('buildingDensity', 0, 0, 10), 'hsl(120, 85%, 50%)');
  assert.strictEqual(MapColors.getColorForMetric('buildingDensity', 10, 0, 10), 'hsl(0, 85%, 50%)');
});

test('getColorForMetric: distMajorRoad goes red(0, close)->green(120, far) hue', () => {
  assert.strictEqual(MapColors.getColorForMetric('distMajorRoad', 0, 0, 10), 'hsl(0, 85%, 50%)');
  assert.strictEqual(MapColors.getColorForMetric('distMajorRoad', 10, 0, 10), 'hsl(120, 85%, 50%)');
});

test('getColorForMetric: distWater goes cyan(200, close)->brown(30, far) hue', () => {
  assert.strictEqual(MapColors.getColorForMetric('distWater', 0, 0, 10), 'hsl(200, 80%, 45%)');
  assert.strictEqual(MapColors.getColorForMetric('distWater', 10, 0, 10), 'hsl(30, 80%, 45%)');
});

test('getColorForMetric: treeDensity ramps both hue (60->140) and saturation (30->90)', () => {
  assert.strictEqual(MapColors.getColorForMetric('treeDensity', 0, 0, 10), 'hsl(60, 30%, 45%)');
  assert.strictEqual(MapColors.getColorForMetric('treeDensity', 10, 0, 10), 'hsl(140, 90%, 45%)');
});

test('getColorForMetric: amenityCount goes blue(240, none)->red(0, many) hue', () => {
  assert.strictEqual(MapColors.getColorForMetric('amenityCount', 0, 0, 10), 'hsl(240, 85%, 55%)');
  assert.strictEqual(MapColors.getColorForMetric('amenityCount', 10, 0, 10), 'hsl(0, 85%, 55%)');
});

test('getColorForMetric: unrecognized metric name falls through to the neutral gray default', () => {
  assert.strictEqual(MapColors.getColorForMetric('totallyMadeUpMetric', 5, 0, 10), '#666666');
});

// ---------------------------------------------------------------------------
// getColorLut
// ---------------------------------------------------------------------------

test('getColorLut: returns a 30-entry array', () => {
  const lut = MapColors.getColorLut('gsr', 0, 10);
  assert.strictEqual(lut.length, 30);
});

test('getColorLut: degenerate range (minVal===maxVal) produces 30 identical default-green entries', () => {
  const lut = MapColors.getColorLut('gsr', 42, 42);
  assert.strictEqual(lut.length, 30);
  for (const c of lut) {
    assert.strictEqual(c, 'hsl(120, 90%, 50%)');
  }
});

test('getColorLut: entries trend from green (high hue) toward red (low hue) as bin index increases for an arousal metric', () => {
  const lut = MapColors.getColorLut('tonic', 0, 30);
  const hueOf = (s) => Number(s.match(/^hsl\((-?[\d.]+),/)[1]);
  const firstHue = hueOf(lut[0]);
  const lastHue = hueOf(lut[29]);
  assert.ok(firstHue > lastHue, 'first bin (low value) should have a higher (greener) hue than the last bin (high value)');
  // Every intermediate bin should be non-increasing in hue as the bin index grows.
  let prev = firstHue;
  for (let i = 1; i < 30; i++) {
    const h = hueOf(lut[i]);
    assert.ok(h <= prev + 1e-9, `hue should be monotonically non-increasing at bin ${i}`);
    prev = h;
  }
});

test('getColorLut: caches by (metric, minVal, maxVal) — identical args return the same array instance', () => {
  const a = MapColors.getColorLut('buildingDensity', 1, 9);
  const b = MapColors.getColorLut('buildingDensity', 1, 9);
  assert.strictEqual(a, b, 'second call with identical args should hit the cache and return the same reference');
});

test('getColorLut: different metric/range produces a distinct cache entry (not confused with an unrelated key)', () => {
  const a = MapColors.getColorLut('distWater', 0, 100);
  const b = MapColors.getColorLut('distMajorRoad', 0, 100);
  assert.notDeepStrictEqual(a, b);
});

test('getColorLut: cache size is capped at 50 entries (oldest evicted first)', () => {
  for (let i = 0; i < 60; i++) {
    MapColors.getColorLut(`syntheticMetric_${i}`, 0, 100);
  }
  assert.ok(MapColors._colorLutCache.size <= 50, `cache size should be capped at 50, got ${MapColors._colorLutCache.size}`);
});
