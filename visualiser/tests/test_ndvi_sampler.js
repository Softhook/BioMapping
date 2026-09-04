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

// ---------------------------------------------------------------------------
// 8. Provider Registry & Resolution Tests
// ---------------------------------------------------------------------------

test('PROVIDERS: registry contains standard satellite providers and handles resolution', () => {
  assert.ok(NDVISampler.PROVIDERS.copernicus, 'copernicus provider exists');
  assert.ok(NDVISampler.PROVIDERS.sentinel2_cloudless, 'sentinel2_cloudless provider exists');
  assert.ok(NDVISampler.PROVIDERS.nasa_gibs, 'nasa_gibs provider exists');
  assert.ok(NDVISampler.PROVIDERS.custom, 'custom provider exists');

  const s2 = NDVISampler.getProvider('sentinel2_cloudless');
  assert.strictEqual(s2.type, 'xyz');
  const resolvedS2 = NDVISampler.resolveTileUrl(s2, 10, 20, 5);
  assert.ok(resolvedS2.includes('/5/20/10.jpg'));

  const nasa = NDVISampler.getProvider('nasa_gibs');
  assert.strictEqual(nasa.type, 'xyz');
  const resolvedNasa = NDVISampler.resolveTileUrl(nasa, 5, 10, 4);
  assert.ok(resolvedNasa.includes('/4/10/5.png'));

  // Custom provider registration
  const registered = NDVISampler.registerProvider('test_landsat', {
    name: 'Landsat 8 NDVI',
    type: 'xyz',
    urlTemplate: 'https://tiles.example.com/{z}/{x}/{y}.png'
  });
  assert.strictEqual(registered, true);
  const resolvedCustom = NDVISampler.resolveTileUrl('test_landsat', 1, 2, 3);
  assert.strictEqual(resolvedCustom, 'https://tiles.example.com/3/1/2.png');
});

test('getActiveProvider: selects copernicus when credentials present, otherwise open sentinel-2', () => {
  // Without credentials -> open Sentinel-2 cloudless
  const provDefault = NDVISampler.getActiveProvider({});
  assert.strictEqual(provDefault.id, 'sentinel2_cloudless');

  // Explicit tileUrl -> custom
  const provCustom = NDVISampler.getActiveProvider({ tileUrl: 'https://foo/{z}/{x}/{y}.png' });
  assert.strictEqual(provCustom.id, 'custom');
});

// ---------------------------------------------------------------------------
// 9. Radial Pixel Mask Pre-computation & Offset Cache
// ---------------------------------------------------------------------------

test('_getCircularPixelOffsets: generates correct integer offsets within disk', () => {
  NDVISampler.clearCache();
  const offsets1 = NDVISampler._getCircularPixelOffsets(1);
  assert.ok(offsets1 instanceof Int16Array);

  // For r=1, disk contains (0,0), (0,1), (0,-1), (1,0), (-1,0) => 5 points = 10 coordinates
  assert.strictEqual(offsets1.length, 10);

  // Offsets are memoized
  const statsBefore = NDVISampler.getCacheStats();
  assert.strictEqual(statsBefore.offsetRadiiCached, 1);
  const offsets1Again = NDVISampler._getCircularPixelOffsets(1);
  assert.strictEqual(offsets1, offsets1Again, 'returns cached Int16Array reference');

  // Verify all returned offsets mathematically satisfy dx^2 + dy^2 <= r^2
  const r = 5;
  const offsets5 = NDVISampler._getCircularPixelOffsets(r);
  for (let i = 0; i < offsets5.length; i += 2) {
    const dx = offsets5[i];
    const dy = offsets5[i + 1];
    assert.ok(dx * dx + dy * dy <= r * r, `point (${dx}, ${dy}) must be within disk radius ${r}`);
  }
});

// ---------------------------------------------------------------------------
// 10. Tile Cache & LRU Eviction Tests
// ---------------------------------------------------------------------------

test('_tileCache: stores, retrieves, refreshes LRU, and clears', () => {
  NDVISampler.clearCache();
  assert.strictEqual(NDVISampler.getCacheStats().tileCount, 0);

  NDVISampler._putTileCache('tile_1', { data: 'img1' });
  NDVISampler._putTileCache('tile_2', { data: 'img2' });

  assert.strictEqual(NDVISampler.getCacheStats().tileCount, 2);
  assert.deepStrictEqual(NDVISampler._getTileCache('tile_1'), { data: 'img1' });
  assert.strictEqual(NDVISampler._getTileCache('non_existent'), null);

  // Clearing cache
  NDVISampler.clearCache();
  assert.strictEqual(NDVISampler.getCacheStats().tileCount, 0);
  assert.strictEqual(NDVISampler.getCacheStats().offsetRadiiCached, 0);
  assert.strictEqual(NDVISampler._getTileCache('tile_1'), null);
});

test('_tileCache: LRU eviction drops oldest entry when capacity exceeded', () => {
  NDVISampler.clearCache();
  const origMax = NDVISampler.MAX_CACHE_TILES;
  try {
    NDVISampler.MAX_CACHE_TILES = 3;
    NDVISampler._putTileCache('t1', { id: 1 });
    NDVISampler._putTileCache('t2', { id: 2 });
    NDVISampler._putTileCache('t3', { id: 3 });

    // Touch t1 so t2 becomes the oldest
    NDVISampler._getTileCache('t1');

    // Add t4 -> should evict t2
    NDVISampler._putTileCache('t4', { id: 4 });

    assert.strictEqual(NDVISampler.getCacheStats().tileCount, 3);
    assert.ok(NDVISampler._getTileCache('t1') !== null, 't1 retained because touched');
    assert.ok(NDVISampler._getTileCache('t2') === null, 't2 evicted as oldest');
    assert.ok(NDVISampler._getTileCache('t3') !== null, 't3 retained');
    assert.ok(NDVISampler._getTileCache('t4') !== null, 't4 retained');
  } finally {
    NDVISampler.MAX_CACHE_TILES = origMax;
    NDVISampler.clearCache();
  }
});

// ---------------------------------------------------------------------------
// 11. Network Concurrency Pool & Worker Queue
// ---------------------------------------------------------------------------

test('_fetchTilePool: streams batch of tile tasks with bounded concurrency and progress', async () => {
  const tasks = [
    { url: 'tile_a', destX: 0, destY: 0, tx: 0, ty: 0 },
    { url: 'tile_b', destX: 256, destY: 0, tx: 1, ty: 0 },
    { url: 'tile_c', destX: 0, destY: 256, tx: 0, ty: 1 },
    { url: 'tile_d', destX: 256, destY: 256, tx: 1, ty: 1 }
  ];

  let progressCalls = 0;
  const res = await NDVISampler._fetchTilePool(tasks, null, {
    concurrency: 2,
    timeoutMs: 1000,
    onTileProgress: (completed, total, wasCached) => {
      progressCalls++;
      assert.strictEqual(total, 4);
      assert.ok(completed >= 1 && completed <= 4);
    }
  });

  assert.strictEqual(res.total, 4);
  assert.strictEqual(progressCalls, 4);
});

test('_fetchTilePool: honors abort signal', async () => {
  const controller = new AbortController();
  const tasks = [
    { url: 'tile_1', destX: 0, destY: 0, tx: 0, ty: 0 },
    { url: 'tile_2', destX: 0, destY: 0, tx: 0, ty: 0 }
  ];

  controller.abort(); // pre-aborted
  const res = await NDVISampler._fetchTilePool(tasks, null, {
    concurrency: 1,
    signal: controller.signal
  });

  // Should break immediately without hanging
  assert.strictEqual(res.total, 2);
});

// ---------------------------------------------------------------------------
// 12. GeoUtils Bounding Box Integration
// ---------------------------------------------------------------------------

test('sampleTrack: integrates cleanly with GeoUtils bounding box expansion', async () => {
  // Load GeoUtils into global environment
  global.GeoUtils = require('../src/gps/geo_utils.js').GeoUtils || require('../src/gps/geo_utils.js');

  const rawPoints = [
    { time: 0.0, lat: 51.505, lon: -0.09, osm_green_pct_50m: 60, osm_canopy_pct_50m: 50 },
    { time: 1.0, lat: 51.506, lon: -0.091, osm_green_pct_50m: 65, osm_canopy_pct_50m: 55 }
  ];

  const track = {
    id: 'geoutils_test_track',
    name: 'GeoUtils Integration Walk',
    analyzer: {
      raw: rawPoints,
      isEnriched: false,
      _dataVersion: 1
    }
  };

  const res = await NDVISampler.sampleTrack(track, { zoom: 15, radiusM: 50 });
  assert.strictEqual(res.sampleCount, 2);
  assert.strictEqual(track.analyzer.isEnriched, true);
  assert.ok(track.analyzer.raw[0].ndvi > 0);
  assert.ok(track.analyzer.raw[0].ndvi_50m > 0);
});

// ---------------------------------------------------------------------------
// 13. High-Performance In-Place Shading
// ---------------------------------------------------------------------------

test('writeThematicRgba and shadeImageData: transforms ImageData in-place without heap allocations', () => {
  const width = 2;
  const height = 2;
  const data = new Uint8ClampedArray(width * height * 4);

  // Pixel 0: Water (pure blue dominant)
  data[0] = 20; data[1] = 40; data[2] = 140; data[3] = 255;
  // Pixel 1: Asphalt / built (stronger red/earth dominance so NDVI < 0.12)
  data[4] = 160; data[5] = 100; data[6] = 80; data[7] = 255;
  // Pixel 2: Dense canopy (green dominant)
  data[8] = 20; data[9] = 160; data[10] = 30; data[11] = 255;
  // Pixel 3: Transparent nodata
  data[12] = 0; data[13] = 0; data[14] = 0; data[15] = 0;

  const mockImgData = { data, width, height };
  NDVISampler.shadeImageData(mockImgData);

  // Pixel 0 should have water color (blue dominant: 60, 130, 200)
  assert.strictEqual(data[0], 60);
  assert.strictEqual(data[1], 130);
  assert.strictEqual(data[2], 200);

  // Pixel 1 should have urban color (slate grey: 160, 160, 155)
  assert.strictEqual(data[4], 160);
  assert.strictEqual(data[5], 160);
  assert.strictEqual(data[6], 155);

  // Pixel 2 should have dense canopy color (emerald: 15, 140, 30)
  assert.strictEqual(data[8], 15);
  assert.strictEqual(data[9], 140);
  assert.strictEqual(data[10], 30);

  // Pixel 3 should remain untouched (alpha 0)
  assert.strictEqual(data[15], 0);
});

// ---------------------------------------------------------------------------
// 14. calculateBBox Unification Tests
// ---------------------------------------------------------------------------

test('calculateBBox: computes correctly buffered bounding box', () => {
  const points = [
    { lat: 51.500, lon: -0.100 },
    { lat: 51.510, lon: -0.090 }
  ];

  const bbox = NDVISampler.calculateBBox(points, 100);
  assert.ok(bbox !== null);
  assert.ok(bbox.minLat < 51.500, 'minLat expanded south');
  assert.ok(bbox.maxLat > 51.510, 'maxLat expanded north');
  assert.ok(bbox.minLon < -0.100, 'minLon expanded west');
  assert.ok(bbox.maxLon > -0.090, 'maxLon expanded east');

  // Empty or invalid points returns null
  assert.strictEqual(NDVISampler.calculateBBox([]), null);
  assert.strictEqual(NDVISampler.calculateBBox([{ lat: NaN, lon: NaN }]), null);
});

// ---------------------------------------------------------------------------
// 15. _stepHoldValues Forward Propagation Tests
// ---------------------------------------------------------------------------

test('_stepHoldValues: cleanly propagates values across non-GPS rows', () => {
  const rows = [
    { time: 0, ndvi: 0.5, ndvi_50m: 0.6 },
    { time: 1, ndvi: NaN, ndvi_50m: NaN },
    { time: 2, ndvi: null, ndvi_50m: undefined },
    { time: 3, ndvi: 0.8, ndvi_50m: 0.85 },
    { time: 4, ndvi: NaN, ndvi_50m: NaN }
  ];

  NDVISampler._stepHoldValues(rows, ['ndvi', 'ndvi_50m']);

  assert.strictEqual(rows[1].ndvi, 0.5);
  assert.strictEqual(rows[1].ndvi_50m, 0.6);
  assert.strictEqual(rows[2].ndvi, 0.5);
  assert.strictEqual(rows[2].ndvi_50m, 0.6);
  assert.strictEqual(rows[3].ndvi, 0.8);
  assert.strictEqual(rows[3].ndvi_50m, 0.85);
  assert.strictEqual(rows[4].ndvi, 0.8);
  assert.strictEqual(rows[4].ndvi_50m, 0.85);
});

// ---------------------------------------------------------------------------
// 16. Network Resilience & Exponential Backoff
// ---------------------------------------------------------------------------

test('_backoffMs: computes exponential backoff with jitter within expected bounds', () => {
  for (let attempt = 0; attempt < 4; attempt++) {
    const baseMs = 500;
    const linear = baseMs * Math.pow(2, attempt);
    const minBound = Math.floor(linear * 0.75);
    const maxBound = Math.ceil(linear * 1.25);

    for (let sample = 0; sample < 10; sample++) {
      const wait = NDVISampler._backoffMs(attempt, baseMs);
      assert.ok(
        wait >= minBound && wait <= maxBound,
        `attempt ${attempt} delay ${wait}ms should be between ${minBound} and ${maxBound}`
      );
    }
  }
});

test('_retryAfterMs: parses Retry-After header in seconds or uses fallback', () => {
  const respWithSec = {
    headers: {
      get: (h) => (h === 'Retry-After' ? '12' : null)
    }
  };
  assert.strictEqual(NDVISampler._retryAfterMs(respWithSec, 3000), 12000);

  const respNoHeader = {
    headers: {
      get: () => null
    }
  };
  assert.strictEqual(NDVISampler._retryAfterMs(respNoHeader, 4500), 4500);

  assert.strictEqual(NDVISampler._retryAfterMs(null, 5000), 5000);
});

test('_fetchTileWithBackoff: respects 429 rate limit and retries with backoff', async () => {
  const origFetch = global.fetch;
  let fetchAttempts = 0;
  const retryEvents = [];

  global.fetch = async (url) => {
    fetchAttempts++;
    if (fetchAttempts < 3) {
      return {
        ok: false,
        status: 429,
        headers: { get: (h) => (h === 'Retry-After' ? '0.01' : null) }
      };
    }
    return {
      ok: false,
      status: 404, // 404 immediately terminates
      headers: { get: () => null }
    };
  };

  try {
    const mockCtx = { drawImage: () => {} };
    const success = await NDVISampler._fetchTileWithBackoff(
      'https://test-tiles.com/tile.png',
      mockCtx, 0, 0,
      {
        providerId: 'test_provider_rl',
        maxRetries: 3,
        timeoutMs: 100,
        onRetry: (att, delay, reason) => {
          retryEvents.push({ att, delay, reason });
        }
      }
    );

    assert.strictEqual(success, false);
    assert.strictEqual(fetchAttempts, 3);
    assert.strictEqual(retryEvents.length, 2);
    assert.ok(retryEvents[0].reason.includes('Rate limited'));
  } finally {
    global.fetch = origFetch;
  }
});

// ---------------------------------------------------------------------------
// 17. Collective Batch Processing, Shared Mosaic & Fault Isolation
// ---------------------------------------------------------------------------

test('calculateBBoxAreaKm2: computes non-zero geographic area', () => {
  const bbox = { minLat: 51.500, maxLat: 51.510, minLon: -0.100, maxLon: -0.090 };
  const area = NDVISampler.calculateBBoxAreaKm2(bbox);
  assert.ok(area > 0.5 && area < 2.0, `area should be ~0.8 km², got ${area}`);
  assert.strictEqual(NDVISampler.calculateBBoxAreaKm2(null), 0);
});

test('_calculateTileBounds: automatically steps down zoom when tile count exceeds budget', () => {
  // A wide bounding box (~30 km across)
  const wideBBox = { minLat: 51.300, maxLat: 51.600, minLon: -0.300, maxLon: 0.100 };
  const bounds = NDVISampler._calculateTileBounds(wideBBox, 15, 64, true);

  assert.ok(bounds.wasAdapted, 'adaptive zoom should trigger on wide box');
  assert.ok(bounds.zoom < 15, `zoom should step down below 15, got ${bounds.zoom}`);
  assert.ok(bounds.totalTiles <= 64, `totalTiles ${bounds.totalTiles} should stay within budget`);
});

test('sampleTracks: processes co-located walks via Unified Mosaic Mode', async () => {
  const trackA = {
    id: 'walk_a',
    name: 'Walk A - Park Path',
    analyzer: {
      raw: [
        { time: 0, lat: 51.501, lon: -0.141, osm_green_pct_50m: 80, osm_canopy_pct_50m: 75 },
        { time: 1, lat: 51.502, lon: -0.142, osm_green_pct_50m: 70, osm_canopy_pct_50m: 65 }
      ],
      isEnriched: false
    }
  };

  const trackB = {
    id: 'walk_b',
    name: 'Walk B - Nearby Avenue',
    analyzer: {
      raw: [
        { time: 0, lat: 51.503, lon: -0.143, osm_green_pct_50m: 30, osm_canopy_pct_50m: 20 },
        { time: 1, lat: 51.504, lon: -0.144, osm_green_pct_50m: 40, osm_canopy_pct_50m: 25 }
      ],
      isEnriched: false
    }
  };

  const res = await NDVISampler.sampleTracks([trackA, trackB], {
    zoom: 15,
    radiusM: 50,
    maxMosaicAreaKm2: 16.0,
    maxMosaicTiles: 64
  });

  assert.strictEqual(res.mode, 'unified_mosaic');
  assert.strictEqual(res.totalCount, 2);
  assert.strictEqual(res.enrichedCount, 2);
  assert.strictEqual(res.failedCount, 0);

  // Verify both tracks are enriched and have NDVI fields
  assert.strictEqual(trackA.analyzer.isEnriched, true);
  assert.strictEqual(trackB.analyzer.isEnriched, true);
  assert.ok(trackA.analyzer.raw[0].ndvi > 0);
  assert.ok(trackB.analyzer.raw[0].ndvi > 0);
});

test('sampleTracks: handles dispersed walks and isolates failures cleanly', async () => {
  const normalTrack = {
    id: 'walk_london',
    name: 'London Walk',
    analyzer: {
      raw: [
        { time: 0, lat: 51.501, lon: -0.141, osm_green_pct_50m: 80, osm_canopy_pct_50m: 75 }
      ],
      isEnriched: false
    }
  };

  const failingTrack = {
    id: 'walk_corrupt',
    name: 'Corrupted Track',
    analyzer: {
      raw: [
        { time: 0, lat: 48.856, lon: 2.352 } // Far away (Paris) -> forces per-track mode
      ],
      get isEnriched() { return false; },
      set isEnriched(v) { throw new Error('Storage write lock failure'); }
    }
  };

  const res = await NDVISampler.sampleTracks([normalTrack, failingTrack], {
    zoom: 15,
    maxMosaicAreaKm2: 16.0
  });

  assert.strictEqual(res.mode, 'per_track', 'dispersed tracks fall back to per-track mode');
  assert.strictEqual(res.totalCount, 2);
  assert.strictEqual(res.enrichedCount, 1, 'normal track succeeded');
  assert.strictEqual(res.failedCount, 1, 'corrupted track was isolated without halting batch');
  assert.strictEqual(res.failedTracks.length, 1);
  assert.strictEqual(res.failedTracks[0].name, 'Corrupted Track');
});






