/**
 * Unit tests for ndvi_sampler.js (NDVISampler) — automated satellite tile
 * streaming, Web Mercator projection math, pixel decoding, and client-side
 * buffer mean raster sampling for BioMapping.
 *
 * Run: node --test tests/test_ndvi_sampler.js
 */

const assert = require('assert');
const test = require('node:test');

global.window = global;
global.GSR_CONST = require('./mock_constants.js');
global.GSRAnalyzer = { calcEmFog: () => NaN };
global.StatsMath = require('../src/signal/stats_math.js').StatsMath;

const { NDVISampler } = require('../src/osm/ndvi_sampler.js');
const { GSRCSVParser } = require('../src/signal/csv_parser.js');

const closeTo = (actual, expected, tolerance = 1e-4, msg = '') => {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${msg} expected ${actual} to be within ${tolerance} of ${expected}`
  );
};

// ---------------------------------------------------------------------------
// 1. Web Mercator Coordinate & Tile Math
// ---------------------------------------------------------------------------

test('latLonToTile: (0, 0) at zoom 0 lands on tile (0, 0)', () => {
  const t = NDVISampler.latLonToTile(0, 0, 0);
  assert.strictEqual(t.tileX, 0);
  assert.strictEqual(t.tileY, 0);
  assert.strictEqual(t.pixelX, 128);
  assert.strictEqual(t.pixelY, 128);
});

test('latLonToTile: bounds stay in [0, 255] for pixel coordinates', () => {
  const coords = [
    { lat: 51.5074, lon: -0.1278 }, // London
    { lat: 40.7128, lon: -74.0060 }, // NYC
    { lat: -33.8688, lon: 151.2093 } // Sydney
  ];

  for (const c of coords) {
    const t = NDVISampler.latLonToTile(c.lat, c.lon, 15);
    assert.ok(t.tileX >= 0 && t.tileX < Math.pow(2, 15));
    assert.ok(t.tileY >= 0 && t.tileY < Math.pow(2, 15));
    assert.ok(t.pixelX >= 0 && t.pixelX <= 255);
    assert.ok(t.pixelY >= 0 && t.pixelY <= 255);
  }
});

test('latLonToTile and tileToLatLon: round-trip consistency', () => {
  const zoom = 15;
  const original = { lat: 51.505, lon: -0.09 };
  const t = NDVISampler.latLonToTile(original.lat, original.lon, zoom);
  const back = NDVISampler.tileToLatLon(t.tileX, t.tileY, zoom);

  // A tile covers ~0.01 degrees at zoom 15, so back should be within 0.02 deg
  closeTo(back.lat, original.lat, 0.02, 'latitude roundtrip');
  closeTo(back.lon, original.lon, 0.02, 'longitude roundtrip');
});

test('tileToBbox: generates valid EPSG:3857 bounding box for Copernicus WMS', () => {
  const bbox = NDVISampler.tileToBbox(8500, 5350, 14);
  assert.strictEqual(bbox.length, 4);
  const minX = parseFloat(bbox[0]);
  const minY = parseFloat(bbox[1]);
  const maxX = parseFloat(bbox[2]);
  const maxY = parseFloat(bbox[3]);
  assert.ok(maxX > minX, 'maxX > minX');
  assert.ok(maxY > minY, 'maxY > minY');
  // At zoom 14, tile width is roughly 2445 meters
  closeTo(maxX - minX, 2445.98, 1.0, 'tile width in EPSG:3857');
});

test('Copernicus credentials privacy: default instance ID is strictly empty in codebase', () => {
  assert.strictEqual(NDVISampler.DEFAULT_INSTANCE_ID, '');
  assert.strictEqual(NDVISampler.hasCopernicusConfig(), false);
});

test('buildCopernicusWmsUrl: correctly formats WMS query parameters', () => {
  const url = NDVISampler.buildCopernicusWmsUrl(['-355000', '7547000', '-354000', '7548000'], {
    instanceId: 'test-instance-1234',
    layerId: 'VEGETATION_INDEX',
    time: '2024-05-01/2024-09-30',
    maxcc: 50
  });

  assert.ok(url.startsWith('https://sh.dataspace.copernicus.eu/ogc/wms/test-instance-1234'));
  assert.ok(url.includes('LAYERS=VEGETATION_INDEX'));
  assert.ok(url.includes('TIME=2024-05-01%2F2024-09-30'));
  assert.ok(url.includes('MAXCC=50'));
  assert.ok(url.includes('BBOX=-355000,7547000,-354000,7548000'));
});

// ---------------------------------------------------------------------------
// 2. Ground Resolution & Buffer Radius Math
// ---------------------------------------------------------------------------

test('metersPerPixel: equatorial resolution scales inversely with 2^zoom', () => {
  const mpp0 = NDVISampler.metersPerPixel(0, 0);
  closeTo(mpp0, 156543.03392, 1.0, 'zoom 0 equator');

  const mpp15 = NDVISampler.metersPerPixel(0, 15);
  closeTo(mpp15, 156543.03392 / 32768, 0.1, 'zoom 15 equator');
});

test('metersToPixels: 50m buffer radius is positive and scales with latitude', () => {
  const pxEquator = NDVISampler.metersToPixels(50, 0, 15);
  const pxLondon = NDVISampler.metersToPixels(50, 51.5, 15);

  assert.ok(pxEquator > 5 && pxEquator < 20, 'equatorial 50m pixel radius');
  // High latitude stretches Mercator, giving more pixels per meter
  assert.ok(pxLondon > pxEquator, 'London pixels > equator pixels due to cos(lat)');
});

// ---------------------------------------------------------------------------
// 3. Pixel Decoding to NDVI
// ---------------------------------------------------------------------------

test('decodePixel: transparent pixel (alpha < 128) returns NaN', () => {
  assert.ok(isNaN(NDVISampler.decodePixel(100, 150, 50, 0)));
  assert.ok(isNaN(NDVISampler.decodePixel(100, 150, 50, 100)));
});

test('decodePixel: greyscale mapping produces continuous [-0.2, 1.0] range', () => {
  const valWater = NDVISampler.decodePixel(0, 0, 0);
  closeTo(valWater, -0.2, 0.01, '0 maps to -0.2');

  const valSoil = NDVISampler.decodePixel(43, 43, 43);
  closeTo(valSoil, 0.0, 0.02, '43 maps to ~0.0');

  const valCanopy = NDVISampler.decodePixel(255, 255, 255);
  closeTo(valCanopy, 1.0, 0.01, '255 maps to 1.0');
});

test('decodePixel: water detection identifies dominant blue', () => {
  const water = NDVISampler.decodePixel(20, 40, 120);
  assert.ok(water < 0, 'water NDVI must be negative');
});

test('decodePixel: lush green vegetation produces high positive NDVI', () => {
  const denseCanopy = NDVISampler.decodePixel(30, 160, 40);
  assert.ok(denseCanopy > 0.65, `dense canopy NDVI should be > 0.65, got ${denseCanopy}`);

  const moderateGreen = NDVISampler.decodePixel(60, 120, 50);
  assert.ok(moderateGreen > 0.35, `moderate greenery should be > 0.35, got ${moderateGreen}`);
});

test('decodePixel: bare soil / asphalt produces low positive NDVI', () => {
  const asphalt = NDVISampler.decodePixel(110, 105, 100);
  assert.ok(asphalt >= 0.0 && asphalt <= 0.25, `asphalt NDVI should be 0.0-0.25, got ${asphalt}`);

  const soil = NDVISampler.decodePixel(140, 100, 70);
  assert.ok(soil >= 0.0 && soil <= 0.25, `soil NDVI should be 0.0-0.25, got ${soil}`);
});

// ---------------------------------------------------------------------------
// 4. Circular Buffer Mean Sampling
// ---------------------------------------------------------------------------

test('sampleBuffer: correctly averages pixels within circular disk', () => {
  const width = 10;
  const height = 10;
  const data = new Uint8ClampedArray(width * height * 4);

  // Fill entire surface with asphalt (R=110, G=105, B=100, A=255)
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = 110;
    data[i * 4 + 1] = 105;
    data[i * 4 + 2] = 100;
    data[i * 4 + 3] = 255;
  }

  // Paint center 3x3 with lush green (R=30, G=160, B=40, A=255)
  for (let y = 4; y <= 6; y++) {
    for (let x = 4; x <= 6; x++) {
      const idx = (y * width + x) * 4;
      data[idx] = 30;
      data[idx + 1] = 160;
      data[idx + 2] = 40;
      data[idx + 3] = 255;
    }
  }

  const centerVal = NDVISampler.decodePixel(30, 160, 40);
  assert.ok(centerVal > 0.65);

  // Sample with radius 1 (mostly green)
  const bufferSmall = NDVISampler.sampleBuffer(data, width, height, 5, 5, 1);
  assert.ok(bufferSmall > 0.60, 'small radius buffer is predominantly green');

  // Sample with radius 4 (surrounding asphalt dilutes the mean)
  const bufferLarge = NDVISampler.sampleBuffer(data, width, height, 5, 5, 4);
  assert.ok(bufferLarge < bufferSmall, 'larger buffer including asphalt lowers the mean');
  assert.ok(bufferLarge > 0.20, 'larger buffer still retains some green influence');
});

test('ndviToThematicRgba: maps NDVI spectrum to false-color RGBA green coverage palette', () => {
  const waterColor = NDVISampler.ndviToThematicRgba(-0.1);
  assert.strictEqual(waterColor[0], 60);
  assert.strictEqual(waterColor[1], 130);
  assert.strictEqual(waterColor[2], 200); // Blue dominant

  const urbanColor = NDVISampler.ndviToThematicRgba(0.05);
  assert.strictEqual(urbanColor[3], 35); // Highly translucent for urban base map visibility

  const lowVegColor = NDVISampler.ndviToThematicRgba(0.20);
  assert.ok(lowVegColor[1] > lowVegColor[0]); // Green > Red (yellow-green)

  const denseCanopyColor = NDVISampler.ndviToThematicRgba(0.65);
  assert.strictEqual(denseCanopyColor[0], 15);
  assert.strictEqual(denseCanopyColor[1], 140); // Deep green
});

// ---------------------------------------------------------------------------
// 5. Track Sampling Pipeline
// ---------------------------------------------------------------------------

test('sampleTrack: decorates data points with ndvi and ndvi_50m and updates analyzer', async () => {
  const rawPoints = [
    { time: 0.0, lat: 51.501, lon: -0.141, osm_green_pct_50m: 80, osm_canopy_pct_50m: 75 },
    { time: 1.0, lat: 51.502, lon: -0.142, osm_green_pct_50m: 70, osm_canopy_pct_50m: 65 },
    { time: 2.0, lat: 51.503, lon: -0.143, osm_green_pct_50m: 20, osm_canopy_pct_50m: 15 },
    { time: 3.0, lat: NaN, lon: NaN } // non-fix row
  ];

  const mockTrack = {
    id: 'test_walk_1',
    name: 'Green Park Walk',
    analyzer: {
      raw: rawPoints,
      isEnriched: false,
      _dataVersion: 1
    }
  };

  const res = await NDVISampler.sampleTrack(mockTrack, { zoom: 15, radiusM: 50 });

  assert.strictEqual(res.sampleCount, 3, 'sampled 3 valid GPS fixes');
  assert.ok(mockTrack.analyzer.isEnriched, 'analyzer marked isEnriched');
  assert.ok(mockTrack.analyzer.hasNdvi, 'analyzer marked hasNdvi');
  assert.strictEqual(mockTrack.analyzer._dataVersion, 2, 'dataVersion incremented');

  // Verify all points received ndvi and ndvi_50m
  for (let i = 0; i < 3; i++) {
    const pt = mockTrack.analyzer.raw[i];
    assert.ok(typeof pt.ndvi === 'number' && !isNaN(pt.ndvi), `point ${i} ndvi is a valid number`);
    assert.ok(typeof pt.ndvi_50m === 'number' && !isNaN(pt.ndvi_50m), `point ${i} ndvi_50m is a valid number`);
    assert.ok(pt.ndvi >= -0.2 && pt.ndvi <= 1.0, `point ${i} ndvi in valid range`);
    assert.ok(pt.ndvi_50m >= -0.2 && pt.ndvi_50m <= 1.0, `point ${i} ndvi_50m in valid range`);
  }

  // Non-fix row receives step-held value
  assert.strictEqual(mockTrack.analyzer.raw[3].ndvi, mockTrack.analyzer.raw[2].ndvi);
  assert.strictEqual(mockTrack.analyzer.raw[3].ndvi_50m, mockTrack.analyzer.raw[2].ndvi_50m);
});

// ---------------------------------------------------------------------------
// 6. CSV Parsing & Import Verification
// ---------------------------------------------------------------------------

test('GSRCSVParser: correctly parses ndvi and ndvi_50m columns and marks isEnriched', () => {
  const csvData =
    'timestamp,gsr_raw,lat,lon,ndvi,ndvi_50m\n' +
    '1000.0,5.2,51.501,-0.141,0.650,0.720\n' +
    '1001.0,5.3,51.502,-0.142,0.610,0.690\n';

  const parsed = GSRCSVParser.parse(csvData);
  assert.strictEqual(parsed.isEnriched, true, 'CSV with ndvi is marked as enriched');
  assert.strictEqual(parsed.raw.length, 2);

  assert.strictEqual(parsed.raw[0].ndvi, 0.650);
  assert.strictEqual(parsed.raw[0].ndvi_50m, 0.720);
  assert.strictEqual(parsed.raw[1].ndvi, 0.610);
  assert.strictEqual(parsed.raw[1].ndvi_50m, 0.690);
});

// ---------------------------------------------------------------------------
// 7. GSRUI.sampleNdviTrack Single-Mode Resolution Test
// ---------------------------------------------------------------------------

test('GSRUI.sampleNdviTrack: successfully resolves single-mode track without false no-GPS alert', async () => {
  const { GSRUI } = require('../src/ui/ui.js');
  global.document = {
    getElementById: (id) => ({
      style: {},
      setAttribute: () => {},
      removeAttribute: () => {},
      classList: { contains: () => false, add: () => {}, remove: () => {} },
      innerText: '',
      innerHTML: '',
      value: '50',
      getContext: () => ({
        fillRect: () => {},
        clearRect: () => {},
        beginPath: () => {},
        stroke: () => {},
        fill: () => {},
        moveTo: () => {},
        lineTo: () => {},
        arc: () => {},
        fillText: () => {},
        measureText: () => ({ width: 0 }),
        setLineDash: () => {}
      })
    }),
    querySelectorAll: () => [],
    querySelector: () => null
  };

  const rawPoints = [
    { time: 0.0, lat: 55.9534, lon: -3.1897, osm_green_pct_50m: 40, osm_canopy_pct_50m: 30 },
    { time: 1.0, lat: 55.9535, lon: -3.1898, osm_green_pct_50m: 45, osm_canopy_pct_50m: 35 }
  ];

  global.AppState = {
    viewMode: 'single',
    activeTrackId: 'track_demo_123',
    analyzer: {
      raw: rawPoints,
      isEnriched: false,
      _dataVersion: 1,
      peaks: [],
      getCoordinates: (i) => ({ lat: rawPoints[i].lat, lon: rawPoints[i].lon }),
      findClosestIndex: (t) => 0
    }
  };

  let alertMessage = null;
  global.alert = (msg) => { alertMessage = msg; };

  await GSRUI.sampleNdviTrack(false);

  assert.strictEqual(alertMessage, null, `Should not alert error: ${alertMessage}`);
  assert.strictEqual(global.AppState.analyzer.isEnriched, true);
  assert.strictEqual(global.AppState.analyzer.hasNdvi, true);
  assert.ok(typeof rawPoints[0].ndvi === 'number' && !isNaN(rawPoints[0].ndvi));
  assert.ok(typeof rawPoints[0].ndvi_50m === 'number' && !isNaN(rawPoints[0].ndvi_50m));
});


