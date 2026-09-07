'use strict';
/**
 * Regression coverage for fused GPS downsampling in _getOrBuildDrawPoints / GpsPipeline.buildDrawPoints.
 *
 * Verifies that buildDrawPoints directly yields output 100% identical to the legacy two-step
 * (full 40k spread followed by downsampleForDisplay) process, while saving ~125ms of
 * throwaway object allocation and GC on large tracks.
 *
 * Run: node --test tests/test_gps_drawpoints_fused.js
 */

const assert = require('assert');
const test = require('node:test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { bootApp } = require('./support/boot_app.js');

const TRACKS_DIR = path.join(__dirname, '..', '..', 'tracks');

function boot() {
  const { window, context } = bootApp();
  window.HTMLCanvasElement.prototype.getContext = () => ({ fillStyle: '', fillRect() {} });
  window.setup();
  return { window, context, mapManager: window.AppState.mapManager };
}

// Reference implementation of the legacy two-step approach
function legacyBuildDrawPoints(data, filteredGps, sampleRate, doDownsample, forceIndexSet, GpsPipeline) {
  const drawPoints = [];
  for (let i = 0; i < data.length; i++) {
    const fg = filteredGps[i];
    if (fg && !isNaN(fg.lat) && !isNaN(fg.lon)) {
      drawPoints.push({
        ...data[i],
        lat: fg.lat,
        lon: fg.lon,
        origIdx: i,
        isRfPeak: !!(forceIndexSet && forceIndexSet.has(i))
      });
    }
  }
  return GpsPipeline.downsampleForDisplay(drawPoints, sampleRate, doDownsample, forceIndexSet);
}

test('buildDrawPoints: returns byte-for-byte identical output to legacy two-step method (downsample=true)', () => {
  const { window, context, mapManager } = boot();
  const GpsPipeline = vm.runInContext('GpsPipeline', context);
  const GpsFilter = vm.runInContext('GpsFilter', context);
  const gpsDefault = vm.runInContext('GSR_CONST.GPS_DEFAULT', context);

  const analyzer = new window.GSRAnalyzer();
  const csv = fs.readFileSync(path.join(TRACKS_DIR, 'biomap_048.csv'), 'utf8');
  analyzer.parseCSV(csv);

  const p = { ...gpsDefault, downsample: true };
  const data = analyzer.raw;

  let gpsPoints = mapManager._collectGpsPoints(data);
  gpsPoints = GpsPipeline.applyHdopGate(gpsPoints, p.maxHdop || 3.0);
  gpsPoints = GpsPipeline.applyFixTypeGate(gpsPoints);
  gpsPoints = GpsPipeline.applyPreKalmanFilters(gpsPoints, p.smoothing || 0.5, p.maxSpeed || 3.0);
  gpsPoints = GpsFilter.applyKalman(gpsPoints, p.smoothing || 0.5, p.kalmanR || 10);
  GpsPipeline.reconstructFilteredGps(analyzer, data, gpsPoints);

  const legacy = legacyBuildDrawPoints(data, analyzer.filteredGps, analyzer.sampleRate || 10.0, true, analyzer.rfPeakIndices, GpsPipeline);
  const fused = GpsPipeline.buildDrawPoints(data, analyzer.filteredGps, analyzer.sampleRate || 10.0, true, analyzer.rfPeakIndices);

  assert.ok(fused.length > 0, 'fused produces points');
  assert.strictEqual(fused.length, legacy.length, 'lengths match');
  assert.deepStrictEqual(fused, legacy, 'output matches byte-for-byte');
});

test('buildDrawPoints: returns byte-for-byte identical output to legacy two-step method (downsample=false)', () => {
  const { window, context, mapManager } = boot();
  const GpsPipeline = vm.runInContext('GpsPipeline', context);
  const GpsFilter = vm.runInContext('GpsFilter', context);
  const gpsDefault = vm.runInContext('GSR_CONST.GPS_DEFAULT', context);

  const analyzer = new window.GSRAnalyzer();
  const csv = fs.readFileSync(path.join(TRACKS_DIR, 'biomap_048.csv'), 'utf8');
  analyzer.parseCSV(csv);

  const p = { ...gpsDefault, downsample: false };
  const data = analyzer.raw;

  let gpsPoints = mapManager._collectGpsPoints(data);
  gpsPoints = GpsPipeline.applyHdopGate(gpsPoints, p.maxHdop || 3.0);
  gpsPoints = GpsPipeline.applyFixTypeGate(gpsPoints);
  gpsPoints = GpsPipeline.applyPreKalmanFilters(gpsPoints, p.smoothing || 0.5, p.maxSpeed || 3.0);
  gpsPoints = GpsFilter.applyKalman(gpsPoints, p.smoothing || 0.5, p.kalmanR || 10);
  GpsPipeline.reconstructFilteredGps(analyzer, data, gpsPoints);

  const legacy = legacyBuildDrawPoints(data, analyzer.filteredGps, analyzer.sampleRate || 10.0, false, analyzer.rfPeakIndices, GpsPipeline);
  const fused = GpsPipeline.buildDrawPoints(data, analyzer.filteredGps, analyzer.sampleRate || 10.0, false, analyzer.rfPeakIndices);

  assert.ok(fused.length > 0, 'fused produces points');
  assert.strictEqual(fused.length, legacy.length, 'lengths match');
  assert.deepStrictEqual(fused, legacy, 'output matches byte-for-byte');
});

test('buildDrawPoints: correctly handles forced RF peak indices that fall between strides', () => {
  const { window, context } = boot();
  const GpsPipeline = vm.runInContext('GpsPipeline', context);

  // 25 synthetic points at 10 Hz with indices 0..24
  const data = [];
  const filteredGps = [];
  for (let i = 0; i < 25; i++) {
    data.push({ time: i * 0.1, val: 5.0, customField: 'val_' + i });
    filteredGps.push({ lat: 51.5 + i * 0.0001, lon: -0.1 + i * 0.0001 });
  }

  // Force index 3 and index 17 (neither is divisible by step 10)
  const forced = new Set([3, 17]);
  const legacy = legacyBuildDrawPoints(data, filteredGps, 10, true, forced, GpsPipeline);
  const fused = GpsPipeline.buildDrawPoints(data, filteredGps, 10, true, forced);

  assert.deepStrictEqual(fused, legacy, 'forced indices merged and sorted correctly');
  assert.ok(fused.some(p => p.origIdx === 3 && p.isRfPeak === true), 'forced index 3 present with isRfPeak=true');
  assert.ok(fused.some(p => p.origIdx === 17 && p.isRfPeak === true), 'forced index 17 present with isRfPeak=true');
  assert.ok(fused.every((p, i) => i === 0 || p.origIdx > fused[i - 1].origIdx), 'indices remain strictly ascending');
});

test('buildDrawPoints: handles empty data or null filteredGps gracefully', () => {
  const { window, context } = boot();
  const GpsPipeline = vm.runInContext('GpsPipeline', context);

  assert.strictEqual(GpsPipeline.buildDrawPoints([], [], 10, true).length, 0);
  assert.strictEqual(GpsPipeline.buildDrawPoints(null, null, 10, true).length, 0);
  assert.strictEqual(GpsPipeline.buildDrawPoints([{ val: 1 }], [{ lat: NaN, lon: NaN }], 10, true).length, 0);
});

test('_getOrBuildDrawPoints: integrates buildDrawPoints and caches successfully', () => {
  const { window, context, mapManager } = boot();
  const gpsDefault = vm.runInContext('GSR_CONST.GPS_DEFAULT', context);

  const analyzer = new window.GSRAnalyzer();
  const csv = fs.readFileSync(path.join(TRACKS_DIR, 'biomap_048.csv'), 'utf8');
  analyzer.parseCSV(csv);

  const p = { ...gpsDefault, downsample: true };
  const res1 = mapManager._getOrBuildDrawPoints('track_test', analyzer, p);
  assert.ok(res1.drawPoints.length > 0, 'produces drawPoints');

  // Verify caching returns identical references
  const res2 = mapManager._getOrBuildDrawPoints('track_test', analyzer, p);
  assert.strictEqual(res1.drawPoints, res2.drawPoints, 'cached references returned');
});
