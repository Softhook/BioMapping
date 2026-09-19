/**
 * Unit tests for track_quality_popup.mjs (GSRTrackQualityPopup) —
 * Track Library hover card quality reporting, summary extraction,
 * formatting, HTML rendering, and show/hide lifecycle.
 *
 * Run: node --test tests/test_track_quality_popup.js
 */

const assert = require('node:assert');
const test = require('node:test');

const { GSRTrackQualityPopup } = require('../src/ui/track_quality_popup.mjs');

test('GSRTrackQualityPopup.formatDuration: formats durations into clean human-readable strings', () => {
  assert.strictEqual(GSRTrackQualityPopup.formatDuration(0), '0s');
  assert.strictEqual(GSRTrackQualityPopup.formatDuration(45), '45s');
  assert.strictEqual(GSRTrackQualityPopup.formatDuration(59.4), '59s');
  assert.strictEqual(GSRTrackQualityPopup.formatDuration(60), '1m 0s');
  assert.strictEqual(GSRTrackQualityPopup.formatDuration(125), '2m 5s');
  assert.strictEqual(GSRTrackQualityPopup.formatDuration(3600), '1h 0m');
  assert.strictEqual(GSRTrackQualityPopup.formatDuration(3665), '1h 1m');
  assert.strictEqual(GSRTrackQualityPopup.formatDuration(7320), '2h 2m');
  assert.strictEqual(GSRTrackQualityPopup.formatDuration(-10), '0s');
  assert.strictEqual(GSRTrackQualityPopup.formatDuration(NaN), '0s');
});

test('GSRTrackQualityPopup.formatDistance: formats meters and kilometers cleanly', () => {
  assert.strictEqual(GSRTrackQualityPopup.formatDistance(0), '0 m');
  assert.strictEqual(GSRTrackQualityPopup.formatDistance(-5), '0 m');
  assert.strictEqual(GSRTrackQualityPopup.formatDistance(NaN), '0 m');
  assert.strictEqual(GSRTrackQualityPopup.formatDistance(24.6), '25 m');
  assert.strictEqual(GSRTrackQualityPopup.formatDistance(999), '999 m');
  assert.strictEqual(GSRTrackQualityPopup.formatDistance(1000), '1.0 km');
  assert.strictEqual(GSRTrackQualityPopup.formatDistance(2450), '2.5 km');
});

test('GSRTrackQualityPopup.formatDateUK: formats UK style date with shortened month and correct day ordinals', () => {
  // 3rd Mar 2026: 2026-03-03T12:00:00Z
  const t20260303 = Math.floor(
    new Date('2026-03-03T12:00:00Z').getTime() / 1000,
  );
  assert.strictEqual(
    GSRTrackQualityPopup.formatDateUK(t20260303),
    '3rd Mar 2026',
  );

  // 1st Jan 2026
  const t20260101 = Math.floor(
    new Date('2026-01-01T12:00:00Z').getTime() / 1000,
  );
  assert.strictEqual(
    GSRTrackQualityPopup.formatDateUK(t20260101),
    '1st Jan 2026',
  );

  // 2nd Feb 2026
  const t20260202 = Math.floor(
    new Date('2026-02-02T12:00:00Z').getTime() / 1000,
  );
  assert.strictEqual(
    GSRTrackQualityPopup.formatDateUK(t20260202),
    '2nd Feb 2026',
  );

  // 11th, 12th, 13th (teens)
  const t20260311 = Math.floor(
    new Date('2026-03-11T12:00:00Z').getTime() / 1000,
  );
  assert.strictEqual(
    GSRTrackQualityPopup.formatDateUK(t20260311),
    '11th Mar 2026',
  );
  const t20260312 = Math.floor(
    new Date('2026-03-12T12:00:00Z').getTime() / 1000,
  );
  assert.strictEqual(
    GSRTrackQualityPopup.formatDateUK(t20260312),
    '12th Mar 2026',
  );
  const t20260313 = Math.floor(
    new Date('2026-03-13T12:00:00Z').getTime() / 1000,
  );
  assert.strictEqual(
    GSRTrackQualityPopup.formatDateUK(t20260313),
    '13th Mar 2026',
  );

  // 21st, 22nd, 23rd
  const t20260321 = Math.floor(
    new Date('2026-03-21T12:00:00Z').getTime() / 1000,
  );
  assert.strictEqual(
    GSRTrackQualityPopup.formatDateUK(t20260321),
    '21st Mar 2026',
  );
  const t20260322 = Math.floor(
    new Date('2026-03-22T12:00:00Z').getTime() / 1000,
  );
  assert.strictEqual(
    GSRTrackQualityPopup.formatDateUK(t20260322),
    '22nd Mar 2026',
  );
  const t20260323 = Math.floor(
    new Date('2026-03-23T12:00:00Z').getTime() / 1000,
  );
  assert.strictEqual(
    GSRTrackQualityPopup.formatDateUK(t20260323),
    '23rd Mar 2026',
  );

  // 31st Dec 2026
  const t20261231 = Math.floor(
    new Date('2026-12-31T12:00:00Z').getTime() / 1000,
  );
  assert.strictEqual(
    GSRTrackQualityPopup.formatDateUK(t20261231),
    '31st Dec 2026',
  );

  // Invalid / relative timestamps return empty string
  assert.strictEqual(GSRTrackQualityPopup.formatDateUK(0), '');
  assert.strictEqual(GSRTrackQualityPopup.formatDateUK(86399), '');
  assert.strictEqual(GSRTrackQualityPopup.formatDateUK(null), '');
});

test('GSRTrackQualityPopup.computeSummary: handles missing or invalid track analyzer safely', () => {
  assert.strictEqual(GSRTrackQualityPopup.computeSummary(null), null);
  assert.strictEqual(GSRTrackQualityPopup.computeSummary({}), null);
  assert.strictEqual(
    GSRTrackQualityPopup.computeSummary({ analyzer: null }),
    null,
  );
  assert.strictEqual(
    GSRTrackQualityPopup.computeSummary({ analyzer: { raw: null } }),
    null,
  );
});

test('GSRTrackQualityPopup.computeSummary: computes full metrics for a GPS+GSR track', () => {
  // 2026-03-03T08:00:00Z
  const startTime = Math.floor(
    new Date('2026-03-03T08:00:00Z').getTime() / 1000,
  );
  const track = {
    id: 'track-1',
    name: 'Morning Walk.csv',
    color: '#3498db',
    analyzer: {
      _dataVersion: 1,
      hasGpsData: true,
      hasRfData: false,
      recordingStartTime: startTime,
      formatDateShort: () => '03.03.2026',
      formatTimeOnly: () => '08:00',
      _userPeakLabels: new Map([
        [1, 'Surprise'],
        [2, 'Dog barking'],
      ]),
      _peaks: [{ index: 10 }, { index: 50 }, { index: 90 }],
      integrity: { status: 'verified', detail: 'Checksum verified' },
      _csvWarnings: [],
      raw: [
        {
          time: 0,
          val: 2.5,
          lat: 51.5,
          lon: -0.12,
          hacc: 3.2,
          hdop: 1.1,
          _isGpsFix: true,
        },
        {
          time: 1,
          val: 2.7,
          lat: 51.5001,
          lon: -0.1201,
          hacc: 3.0,
          hdop: 1.0,
          _isGpsFix: true,
        },
        {
          time: 2,
          val: 3.1,
          lat: 51.5002,
          lon: -0.1202,
          hacc: 2.8,
          hdop: 0.9,
          _isGpsFix: true,
        },
        {
          time: 3,
          val: 3.0,
          lat: 51.5003,
          lon: -0.1203,
          hacc: 3.5,
          hdop: 1.2,
          _isGpsFix: true,
        },
      ],
    },
  };

  const s = GSRTrackQualityPopup.computeSummary(track);
  assert.ok(s);
  assert.strictEqual(s.name, 'Morning Walk.csv');
  assert.strictEqual(s.color, '#3498db');
  assert.strictEqual(s.trackType, 'GPS + GSR');
  assert.strictEqual(s.durationStr, '3s');
  assert.strictEqual(s.dateTimeStr, '3rd Mar 2026, 08:00');
  assert.strictEqual(s.notesCount, 2);
  assert.strictEqual(s.integrity.status, 'verified');
  assert.strictEqual(s.integrity.detail, 'Checksum verified');

  // GSR metrics
  assert.strictEqual(s.gsr.valid, true);
  assert.strictEqual(s.gsr.isFlatline, false);
  assert.strictEqual(s.gsr.isDisconnected, false);
  assert.strictEqual(s.gsr.min, 2.5);
  assert.strictEqual(s.gsr.max, 3.1);
  assert.strictEqual(s.gsr.mean, 2.83);
  assert.strictEqual(s.gsr.peaksCount, 3);
  assert.strictEqual(s.gsr.peaksPerMin, 60);

  // GPS metrics
  assert.strictEqual(s.gps.hasGps, true);
  assert.strictEqual(s.gps.fixCount, 4);
  assert.ok(s.gps.medianHacc > 0);
  assert.ok(s.gps.medianHdop > 0);
  assert.strictEqual(s.gps.dropouts, 0);

  // Caching verification
  assert.strictEqual(track._qualitySummary, undefined);
  const cached = GSRTrackQualityPopup.computeSummary(track);
  assert.strictEqual(cached, s);

  // Invalidate cache version
  track.analyzer._dataVersion = 2;
  const recomputed = GSRTrackQualityPopup.computeSummary(track);
  assert.notStrictEqual(recomputed, s);
  assert.deepStrictEqual(recomputed, s);
  assert.strictEqual(GSRTrackQualityPopup.computeSummary(track), recomputed);

  // Renaming must invalidate even though _dataVersion is unchanged
  track.name = 'Renamed.csv';
  assert.strictEqual(
    GSRTrackQualityPopup.computeSummary(track).name,
    'Renamed.csv',
  );
});

test('GSRTrackQualityPopup.computeSummary: detects flatline and disconnected GSR data', () => {
  const flatlineTrack = {
    id: 'flatline-track',
    name: 'Flatline.csv',
    color: '#e74c3c',
    analyzer: {
      _dataVersion: 1,
      hasGpsData: false,
      hasRfData: false,
      recordingStartTime: 0,
      formatDateShort: () => '',
      formatTimeOnly: () => '',
      _userPeakLabels: new Map(),
      _peaks: [],
      integrity: { status: 'incomplete', detail: 'File ended abruptly' },
      _csvWarnings: [
        'Warning: Electrode was likely not in skin contact (flatline at 0 µS)',
      ],
      raw: [
        { time: 0, val: 0.0 },
        { time: 1, val: 0.0 },
        { time: 2, val: 0.0 },
      ],
    },
  };

  const s = GSRTrackQualityPopup.computeSummary(flatlineTrack);
  assert.ok(s);
  assert.strictEqual(s.trackType, 'GSR');
  assert.strictEqual(s.integrity.status, 'incomplete');
  assert.strictEqual(s.gsr.isFlatline, true);
  assert.strictEqual(s.gsr.isDisconnected, true);
  assert.strictEqual(s.gsr.peaksCount, 0);
  assert.strictEqual(s.warnings.length, 1);
});

test('GSRTrackQualityPopup.computeSummary: detects RF telemetry and bands', () => {
  const rfTrack = {
    id: 'rf-track',
    name: 'RF_Survey.csv',
    color: '#9b59b6',
    analyzer: {
      _dataVersion: 1,
      hasGpsData: true,
      hasRfData: true,
      recordingStartTime: 1710000000,
      formatDateShort: () => '10 Mar',
      formatTimeOnly: () => '12:00',
      bandFloors: { 868: -95, 915: -98 },
      rfPeakIndices: new Set([10, 25, 42]),
      integrity: { status: 'verified', detail: 'OK' },
      raw: [
        { time: 0, val: 3.0, lat: 51.5, lon: -0.1, _isGpsFix: true },
        { time: 1, val: 3.2, lat: 51.5001, lon: -0.1001, _isGpsFix: true },
      ],
    },
  };

  const s = GSRTrackQualityPopup.computeSummary(rfTrack);
  assert.ok(s);
  assert.strictEqual(s.trackType, 'GPS + GSR + RF');
  assert.strictEqual(s.rf.hasRf, true);
  assert.deepStrictEqual(s.rf.bands, ['868 MHz', '915 MHz']);
  assert.strictEqual(s.rf.hotspots, 3);
});

test('GSRTrackQualityPopup.renderCardHtml: renders HTML with integrity, metadata, and sensors', () => {
  const summary = {
    name: 'Test <Track> & "Special"',
    color: '#2ecc71',
    trackType: 'GPS + GSR + RF',
    dateTimeStr: '19th Sep 2026, 10:30',
    durationStr: '42m 15s',
    distanceStr: '3.4 km',
    notesCount: 3,
    integrity: { status: 'verified', detail: 'Checksum OK' },
    gsr: {
      valid: true,
      isFlatline: false,
      isDisconnected: false,
      min: 1.2,
      max: 5.8,
      mean: 3.1,
      peaksCount: 14,
      peaksPerMin: 2.3,
    },
    gps: {
      hasGps: true,
      fixCount: 2500,
      retentionPct: 99,
      medianHacc: 2.4,
      medianHdop: 0.9,
      dropouts: 0,
    },
    rf: {
      hasRf: true,
      bands: ['868 MHz', '915 MHz'],
      hotspots: 5,
    },
    warnings: ['Sensor dropped out momentarily <alert>'],
  };

  const html = GSRTrackQualityPopup.renderCardHtml(summary);
  assert.ok(
    html.includes('Test &lt;Track&gt; &amp; &quot;Special&quot;'),
    'Track name should be escaped',
  );
  assert.ok(html.includes('GPS + GSR + RF'));
  assert.ok(html.includes('tq-badge-verified'));
  assert.ok(html.includes('42m 15s'));
  assert.ok(html.includes('3.4 km'));
  assert.ok(html.includes('3 notes'));
  assert.ok(html.includes('19th Sep 2026, 10:30'));
  assert.ok(html.includes('Good</span>'));
  assert.ok(html.includes('3.1 µS · <b>2.3</b> peaks/m'));
  assert.ok(html.includes('±2.4m acc'));
  assert.ok(html.includes('99% fixes'));
  assert.ok(html.includes('Solid path'));
  assert.ok(html.includes('868 MHz, 915 MHz'));
  assert.ok(
    !html.includes('Hotspot'),
    'RF hotspot text should not be present in RF row',
  );
  assert.ok(
    html.includes('Sensor dropped out momentarily &lt;alert&gt;'),
    'Warning should be escaped',
  );
});

test('GSRTrackQualityPopup.show and hide: controls DOM element lifecycle', () => {
  // Minimal DOM mock
  const elements = [];
  const fakeElement = {
    id: '',
    className: '',
    style: {},
    innerHTML: '',
    getBoundingClientRect: () => ({
      width: 320,
      height: 200,
      top: 100,
      left: 100,
      right: 420,
      bottom: 300,
    }),
  };

  global.document = {
    createElement: (tag) => {
      const el = { ...fakeElement, tagName: tag.toUpperCase() };
      return el;
    },
    body: {
      appendChild: (el) => elements.push(el),
    },
  };
  global.window = {
    innerWidth: 1200,
    innerHeight: 800,
  };

  const targetEl = {
    getBoundingClientRect: () => ({
      top: 150,
      left: 50,
      right: 250,
      bottom: 180,
      width: 200,
      height: 30,
    }),
  };

  const track = {
    id: 'track-dom-test',
    name: 'DOM Test',
    color: '#ff00ff',
    analyzer: {
      _dataVersion: 1,
      hasGpsData: false,
      hasRfData: false,
      raw: [
        { time: 0, val: 2.0 },
        { time: 10, val: 2.5 },
      ],
    },
  };

  // Reset popup singleton state for clean test
  GSRTrackQualityPopup._popupEl = null;
  GSRTrackQualityPopup._activeTrackId = null;

  GSRTrackQualityPopup.show(track, targetEl);
  assert.ok(GSRTrackQualityPopup._popupEl);
  assert.strictEqual(GSRTrackQualityPopup._popupEl.style.display, 'block');
  assert.strictEqual(GSRTrackQualityPopup._popupEl.style.opacity, '1');
  assert.strictEqual(GSRTrackQualityPopup._activeTrackId, 'track-dom-test');
  assert.strictEqual(elements.length, 1);

  GSRTrackQualityPopup.hide();
  assert.strictEqual(GSRTrackQualityPopup._popupEl.style.display, 'none');
  assert.strictEqual(GSRTrackQualityPopup._popupEl.style.opacity, '0');
  assert.strictEqual(GSRTrackQualityPopup._activeTrackId, null);
});

test('GSRTrackQualityPopup: raw scan is reused across re-analysis, rebuilt when raw changes', () => {
  const raw = [
    { time: 0, val: 2, _isGpsFix: false },
    { time: 10, val: 3, _isGpsFix: false },
  ];
  const a = { _dataVersion: 1, raw, hasGpsData: false, hasRfData: false };
  const scan1 = GSRTrackQualityPopup._rawScan(a);
  a._dataVersion = 2; // e.g. slider drag re-analysis
  assert.strictEqual(GSRTrackQualityPopup._rawScan(a), scan1);
  raw.push({ time: 20, val: 4, _isGpsFix: false });
  assert.notStrictEqual(GSRTrackQualityPopup._rawScan(a), scan1);
});

test('GSRTrackQualityPopup.renderCardHtml: escapes integrity detail and colour', () => {
  const html = GSRTrackQualityPopup.renderCardHtml({
    name: 'x',
    color: '"><script>',
    trackType: 'GSR',
    dateTimeStr: '',
    durationStr: '1s',
    distanceStr: '0 m',
    notesCount: 0,
    integrity: { status: 'corrupt', detail: '"><img onerror=1>' },
    gsr: { valid: false },
    gps: { hasGps: false, fixCount: 0 },
    rf: { hasRf: false, bands: [] },
    warnings: [],
  });
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img'));
});
