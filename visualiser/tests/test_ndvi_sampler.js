/**
 * Unit tests for ndvi_sampler.js (NDVISampler) — Web Mercator projection
 * math, raw NDVI tile decoding (Copernicus errors; the TIFF format itself is
 * in test_tiff_decoder.js), circular buffer-mean raster
 * sampling, and the track sampling pipeline for BioMapping.
 *
 * Run: node --test tests/test_ndvi_sampler.js
 */

const assert = require('node:assert');
const test = require('node:test');

global.window = global;
global.GSR_CONST = require('../src/core/constants.mjs').GSR_CONST;
global.GSRAnalyzer = { calcEmFog: () => NaN };
global.StatsMath = require('../src/signal/stats_math.mjs').StatsMath;

const { NDVISampler } = require('../src/osm/ndvi_sampler.mjs');
const { GSRCSVParser } = require('../src/signal/csv_parser.mjs');
const { buildFloat32Tiff } = require('./support/tiff_fixture.js');

const closeTo = (actual, expected, tolerance = 1e-4, msg = '') => {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${msg} expected ${actual} to be within ${tolerance} of ${expected}`,
  );
};

/** A uniform-value 256x256 raw NDVI tile, uncompressed. */
function uniformTileBuffer(value) {
  const values = new Array(256 * 256).fill(value);
  return buildFloat32Tiff({ width: 256, height: 256, values });
}

/**
 * Installs a global.fetch mock that returns a uniform-value raw NDVI tile for
 * every request. Also clears the tile cache — it's keyed by URL and shared
 * across tests, so a previous test's mocked tile for the same bbox/zoom would
 * otherwise mask whatever this test's fetch mock is meant to exercise.
 */
function mockUniformNdviFetch(value) {
  NDVISampler.clearCache();
  global.fetch = async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => uniformTileBuffer(value),
  });
}

function setCopernicusConfig(
  instanceId = 'test-instance-1234',
  rawLayerId = 'NDVI_RAW',
) {
  global.BIOMAP_CONFIG = {
    copernicusInstanceId: instanceId,
    copernicusRawLayerId: rawLayerId,
  };
}

function clearCopernicusConfig() {
  delete global.BIOMAP_CONFIG;
}

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
    { lat: 40.7128, lon: -74.006 }, // NYC
    { lat: -33.8688, lon: 151.2093 }, // Sydney
  ];

  for (const c of coords) {
    const t = NDVISampler.latLonToTile(c.lat, c.lon, 15);
    assert.ok(t.tileX >= 0 && t.tileX < 2 ** 15);
    assert.ok(t.tileY >= 0 && t.tileY < 2 ** 15);
    assert.ok(t.pixelX >= 0 && t.pixelX <= 255);
    assert.ok(t.pixelY >= 0 && t.pixelY <= 255);
  }
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
  closeTo(maxX - minX, 2445.98, 1.0, 'tile width in EPSG:3857');
});

test('Copernicus credentials privacy: default instance ID is strictly empty in codebase', () => {
  clearCopernicusConfig();
  assert.strictEqual(NDVISampler.DEFAULT_INSTANCE_ID, '');
  assert.strictEqual(NDVISampler.hasCopernicusConfig(), false);
});

test('buildRawTileUrl: requests the raw FLOAT32 layer and format', () => {
  setCopernicusConfig('test-instance-1234', 'NDVI_RAW');
  const url = NDVISampler.buildRawTileUrl(8500, 5350, 14);
  assert.ok(
    url.startsWith(
      'https://sh.dataspace.copernicus.eu/ogc/wms/test-instance-1234',
    ),
  );
  assert.ok(url.includes('LAYERS=NDVI_RAW'));
  assert.ok(url.includes(encodeURIComponent('image/tiff;depth=32f')));
  clearCopernicusConfig();
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
  assert.ok(
    pxLondon > pxEquator,
    'London pixels > equator pixels due to cos(lat)',
  );
});

// ---------------------------------------------------------------------------
// 3. Raw NDVI Raster Decoding (single-band FLOAT32 TIFF)
// ---------------------------------------------------------------------------

// The TIFF format itself is covered in test_tiff_decoder.js; these check the
// NDVI-specific layer on top: Copernicus error replies and the layer hint.

test('parseFloat32Tiff: decodes a valid raw tile', async () => {
  const values = [-0.2, 0, 0.4, 0.9];
  const buf = buildFloat32Tiff({ width: 2, height: 2, values });
  const result = await NDVISampler.parseFloat32Tiff(buf);
  assert.strictEqual(result.width, 2);
  assert.strictEqual(result.height, 2);
  for (let i = 0; i < values.length; i++) {
    closeTo(result.data[i], values[i], 1e-6, `pixel ${i}`);
  }
});

test('parseFloat32Tiff: reports a Copernicus WMS ServiceException', async () => {
  const xml =
    '<?xml version="1.0"?><ServiceExceptionReport><ServiceException> Layer NDVI_RAW not found </ServiceException></ServiceExceptionReport>';
  await assert.rejects(
    () => NDVISampler.parseFloat32Tiff(new TextEncoder().encode(xml).buffer),
    /^Error: Copernicus WMS error: Layer NDVI_RAW not found$/,
  );
});

test('parseFloat32Tiff: reports a Copernicus JSON error body', async () => {
  const json = JSON.stringify({ error: { message: 'Invalid instance' } });
  await assert.rejects(
    () => NDVISampler.parseFloat32Tiff(new TextEncoder().encode(json).buffer),
    /^Error: Copernicus error: Invalid instance$/,
  );
});

test('parseFloat32Tiff: a decoding failure names the raw layer to check', async () => {
  setCopernicusConfig('test-instance-1234', 'MY_LAYER');
  await assert.rejects(
    () => NDVISampler.parseFloat32Tiff(new ArrayBuffer(16)),
    (err) =>
      /^NDVI raster: Response is not a TIFF/.test(err.message) &&
      err.message.includes('"MY_LAYER"'),
  );
  clearCopernicusConfig();
});

// ---------------------------------------------------------------------------
// 3b. Greyscale Map-Overlay Rendering (exact forward mapping, same raster used for sampling)
// ---------------------------------------------------------------------------

/** Minimal 2D-canvas-context stand-in: just enough for paintGreyscaleTile. */
function mockCanvasContext() {
  let lastImageData = null;
  return {
    createImageData: (w, h) => ({
      width: w,
      height: h,
      data: new Uint8ClampedArray(w * h * 4),
    }),
    putImageData: (imgData) => {
      lastImageData = imgData;
    },
    get lastImageData() {
      return lastImageData;
    },
  };
}

test('paintGreyscaleTile: maps NDVI linearly to grey — low = black, high = white', () => {
  const ctx = mockCanvasContext();
  const rasterTile = { width: 2, height: 1, data: new Float32Array([-1, 1]) };
  NDVISampler.paintGreyscaleTile(rasterTile, ctx);

  const d = ctx.lastImageData.data;
  assert.strictEqual(d[0], 0, 'NDVI -1 renders as black');
  assert.strictEqual(d[3], 255, 'opaque');
  assert.strictEqual(d[4], 255, 'NDVI +1 renders as white');
  assert.strictEqual(d[7], 255, 'opaque');
});

test('paintGreyscaleTile: mid-range NDVI values are distinguishable shades of grey, not clipped', () => {
  const ctx = mockCanvasContext();
  // Same values that clipped 25% of pixels to the ceiling under the old
  // colour-heuristic decoder — here they must map to distinct, ordered greys.
  const rasterTile = {
    width: 4,
    height: 1,
    data: new Float32Array([0.1, 0.3, 0.5, 0.85]),
  };
  NDVISampler.paintGreyscaleTile(rasterTile, ctx);

  const d = ctx.lastImageData.data;
  const greys = [d[0], d[4], d[8], d[12]];
  assert.ok(
    greys[0] < greys[1] && greys[1] < greys[2] && greys[2] < greys[3],
    `greys should be strictly increasing, got ${greys}`,
  );
  assert.ok(
    greys[3] < 255,
    'even a strong reading (0.85) stays below the absolute ceiling, unlike the old heuristic',
  );
});

test('paintGreyscaleTile: nodata sentinel pixels render fully transparent', () => {
  const ctx = mockCanvasContext();
  const rasterTile = {
    width: 2,
    height: 1,
    data: new Float32Array([-9999, 0.5]),
  };
  NDVISampler.paintGreyscaleTile(rasterTile, ctx);

  const d = ctx.lastImageData.data;
  assert.strictEqual(d[3], 0, 'nodata pixel is transparent');
  assert.strictEqual(d[7], 255, 'genuine reading stays opaque');
});

// ---------------------------------------------------------------------------
// 4. Circular Buffer Mean Sampling (on a decoded float grid)
// ---------------------------------------------------------------------------

test('sampleBuffer: correctly averages NDVI values within a circular disk', () => {
  const width = 10,
    height = 10;
  const data = new Float32Array(width * height).fill(0.05); // bare ground everywhere

  // Dense vegetation in the center 3x3
  for (let y = 4; y <= 6; y++) {
    for (let x = 4; x <= 6; x++) {
      data[y * width + x] = 0.85;
    }
  }

  const bufferSmall = NDVISampler.sampleBuffer(data, width, height, 5, 5, 1);
  assert.ok(
    bufferSmall > 0.6,
    'small radius buffer is predominantly dense vegetation',
  );

  const bufferLarge = NDVISampler.sampleBuffer(data, width, height, 5, 5, 4);
  assert.ok(
    bufferLarge < bufferSmall,
    'larger buffer including bare ground lowers the mean',
  );
  assert.ok(
    bufferLarge > 0.05,
    'larger buffer still retains some vegetation influence',
  );
});

test('sampleBuffer: nodata sentinel pixels are excluded from the mean, not averaged in', () => {
  const width = 3,
    height = 3;
  const data = new Float32Array([
    0.5, 0.5, 0.5, 0.5, -9999, 0.5, 0.5, 0.5, 0.5,
  ]);
  const mean = NDVISampler.sampleBuffer(data, width, height, 1, 1, 1);
  closeTo(
    mean,
    0.5,
    1e-3,
    'nodata center pixel excluded, not dragging the mean toward -9999',
  );
});

test('sampleBuffer: returns NaN when every pixel in range is nodata', () => {
  const width = 2,
    height = 2;
  const data = new Float32Array([-9999, -9999, -9999, -9999]);
  const mean = NDVISampler.sampleBuffer(data, width, height, 0, 0, 1);
  assert.ok(isNaN(mean));
});

// ---------------------------------------------------------------------------
// 5. Track Sampling Pipeline
// ---------------------------------------------------------------------------

test('sampleTrack: refuses to run without a configured Copernicus instance', async () => {
  clearCopernicusConfig();
  const track = { analyzer: { raw: [{ time: 0, lat: 51.5, lon: -0.1 }] } };
  await assert.rejects(() => NDVISampler.sampleTrack(track), /Copernicus/);
});

test('sampleTracks: refuses to run without a configured Copernicus instance', async () => {
  clearCopernicusConfig();
  const track = { analyzer: { raw: [{ time: 0, lat: 51.5, lon: -0.1 }] } };
  await assert.rejects(() => NDVISampler.sampleTracks([track]), /Copernicus/);
});

test('sampleTrack: decorates data points with real ndvi/ndvi_50m from the raw raster and updates analyzer', async () => {
  setCopernicusConfig();
  mockUniformNdviFetch(0.62);

  const rawPoints = [
    { time: 0.0, lat: 51.501, lon: -0.141 },
    { time: 1.0, lat: 51.502, lon: -0.142 },
    { time: 2.0, lat: 51.503, lon: -0.143 },
    { time: 3.0, lat: NaN, lon: NaN }, // non-fix row
  ];

  const mockTrack = {
    id: 'test_walk_1',
    name: 'Green Park Walk',
    analyzer: { raw: rawPoints, isEnriched: false, _dataVersion: 1 },
  };

  const res = await NDVISampler.sampleTrack(mockTrack, {
    zoom: 15,
    radiusM: 50,
  });

  assert.strictEqual(res.sampleCount, 3, 'sampled 3 valid GPS fixes');
  assert.ok(mockTrack.analyzer.isEnriched, 'analyzer marked isEnriched');
  assert.ok(mockTrack.analyzer.hasNdvi, 'analyzer marked hasNdvi');
  assert.strictEqual(
    mockTrack.analyzer._dataVersion,
    2,
    'dataVersion incremented',
  );

  for (let i = 0; i < 3; i++) {
    const pt = mockTrack.analyzer.raw[i];
    closeTo(
      pt.ndvi,
      0.62,
      0.01,
      `point ${i} ndvi matches the raster value exactly`,
    );
    closeTo(
      pt.ndvi_50m,
      0.62,
      0.01,
      `point ${i} ndvi_50m matches the raster value exactly`,
    );
  }

  // Non-fix row receives step-held value, not a fabricated one
  assert.strictEqual(
    mockTrack.analyzer.raw[3].ndvi,
    mockTrack.analyzer.raw[2].ndvi,
  );
  assert.strictEqual(
    mockTrack.analyzer.raw[3].ndvi_50m,
    mockTrack.analyzer.raw[2].ndvi_50m,
  );

  clearCopernicusConfig();
});

test('sampleTrack: a bad/missing raw layer ID fails fast with a clear error, not a silent guess', async () => {
  setCopernicusConfig();
  NDVISampler.clearCache();
  global.fetch = async () => ({
    ok: false,
    status: 404,
    headers: { get: () => null },
  });

  const rawPoints = [{ time: 0.0, lat: 51.501, lon: -0.141 }];
  const track = {
    analyzer: { raw: rawPoints, isEnriched: false, _dataVersion: 1 },
  };

  await assert.rejects(() => NDVISampler.sampleTrack(track), /raw layer/);
  clearCopernicusConfig();
});

test('sampleTrack: a point whose tile is unreachable (transient failure) is left as NaN, never fabricated from OSM columns', async () => {
  setCopernicusConfig();
  NDVISampler.clearCache();
  // Persistent 5xx exhausts retries -> _fetchRawTileWithBackoff returns null
  // (not a throw) -> that tile's region of the grid stays NaN.
  global.fetch = async () => ({
    ok: false,
    status: 503,
    headers: { get: () => null },
  });

  const rawPoints = [
    {
      time: 0.0,
      lat: 51.501,
      lon: -0.141,
      osm_green_pct_50m: 90,
      osm_canopy_pct_50m: 90,
    },
  ];
  const track = {
    analyzer: { raw: rawPoints, isEnriched: false, _dataVersion: 1 },
  };

  const res = await NDVISampler.sampleTrack(track, { zoom: 15, radiusM: 50 });

  assert.strictEqual(res.enrichedCount, 0, 'no genuine reading was obtained');
  assert.ok(
    isNaN(rawPoints[0].ndvi),
    'ndvi left as NaN, not fabricated from osm_green_pct_50m',
  );
  assert.ok(
    isNaN(rawPoints[0].ndvi_50m),
    'ndvi_50m left as NaN, not fabricated from osm_canopy_pct_50m',
  );

  clearCopernicusConfig();
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
  assert.strictEqual(
    parsed.isEnriched,
    true,
    'CSV with ndvi is marked as enriched',
  );
  assert.strictEqual(parsed.raw.length, 2);

  assert.strictEqual(parsed.raw[0].ndvi, 0.65);
  assert.strictEqual(parsed.raw[0].ndvi_50m, 0.72);
  assert.strictEqual(parsed.raw[1].ndvi, 0.61);
  assert.strictEqual(parsed.raw[1].ndvi_50m, 0.69);
});

// ---------------------------------------------------------------------------
// 7. GSRUI.sampleNdviTrack Single-Mode Resolution Test
// ---------------------------------------------------------------------------

test('GSRUI.sampleNdviTrack: successfully resolves single-mode track without false no-GPS alert', async () => {
  setCopernicusConfig();
  mockUniformNdviFetch(0.4);

  const { GSRUI } = require('../src/ui/ui.mjs');
  global.document = {
    getElementById: (_id) => ({
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
        setLineDash: () => {},
      }),
    }),
    querySelectorAll: () => [],
    querySelector: () => null,
  };

  const rawPoints = [
    { time: 0.0, lat: 55.9534, lon: -3.1897 },
    { time: 1.0, lat: 55.9535, lon: -3.1898 },
  ];

  // ui_enrichment.mjs (and the rest of refreshOsmControls()'s cascade) holds
  // a real static `import { AppState } from '../core/app_state.mjs'`
  // binding, not a bare global lookup — replacing global.AppState wholesale
  // is inert against it. Alias global.AppState to the real singleton and
  // mutate its fields in place instead (same pattern as layer 2's GSR_CONST
  // fix).
  const { AppState: RealAppState } = require('../src/core/app_state.mjs');
  global.AppState = RealAppState;
  Object.assign(RealAppState, {
    viewMode: 'single',
    activeTrackId: 'track_demo_123',
    analyzer: {
      raw: rawPoints,
      isEnriched: false,
      _dataVersion: 1,
      peaks: [],
      getCoordinates: (i) => ({ lat: rawPoints[i].lat, lon: rawPoints[i].lon }),
      findClosestIndex: (_t) => 0,
      stimulusIndexAt: (_t) => 0,
    },
  });

  let alertMessage = null;
  global.alert = (msg) => {
    alertMessage = msg;
  };

  await GSRUI.sampleNdviTrack(false);

  assert.strictEqual(
    alertMessage,
    null,
    `Should not alert error: ${alertMessage}`,
  );
  assert.strictEqual(RealAppState.analyzer.isEnriched, true);
  assert.strictEqual(RealAppState.analyzer.hasNdvi, true);
  assert.ok(typeof rawPoints[0].ndvi === 'number' && !isNaN(rawPoints[0].ndvi));
  assert.ok(
    typeof rawPoints[0].ndvi_50m === 'number' && !isNaN(rawPoints[0].ndvi_50m),
  );

  clearCopernicusConfig();
});

// ---------------------------------------------------------------------------
// 8. Provider Registry & Resolution Tests (visual map overlay only)
// ---------------------------------------------------------------------------

test('PROVIDERS: registry contains standard fallback imagery providers', () => {
  assert.ok(
    NDVISampler.PROVIDERS.sentinel2_cloudless,
    'sentinel2_cloudless provider exists',
  );
  assert.ok(NDVISampler.PROVIDERS.nasa_gibs, 'nasa_gibs provider exists');
  assert.ok(NDVISampler.PROVIDERS.custom, 'custom provider exists');

  const s2 = NDVISampler.getProvider('sentinel2_cloudless');
  assert.strictEqual(s2.type, 'xyz');

  const nasa = NDVISampler.getProvider('nasa_gibs');
  assert.strictEqual(nasa.type, 'xyz');
});

test('getActiveProvider: falls back to open sentinel-2 (or an explicit custom URL), regardless of Copernicus config', () => {
  // getActiveProvider is only consulted for the *fallback* imagery path —
  // when Copernicus is configured, showNdviLayer renders the raw raster
  // directly instead (see manager/osm.js) and never calls this.
  clearCopernicusConfig();
  const provDefault = NDVISampler.getActiveProvider({});
  assert.strictEqual(provDefault.id, 'sentinel2_cloudless');

  setCopernicusConfig();
  const provWithConfig = NDVISampler.getActiveProvider({});
  assert.strictEqual(
    provWithConfig.id,
    'sentinel2_cloudless',
    'still the fallback imagery provider, not a copernicus entry',
  );
  clearCopernicusConfig();

  const provCustom = NDVISampler.getActiveProvider({
    tileUrl: 'https://foo/{z}/{x}/{y}.png',
  });
  assert.strictEqual(provCustom.id, 'custom');
});

// ---------------------------------------------------------------------------
// 9. Radial Pixel Mask Pre-computation & Offset Cache
// ---------------------------------------------------------------------------

test('_getCircularPixelOffsets: generates correct integer offsets within disk', () => {
  NDVISampler.clearCache();
  const offsets1 = NDVISampler._getCircularPixelOffsets(1);
  assert.ok(offsets1 instanceof Int16Array);
  assert.strictEqual(offsets1.length, 10);

  const statsBefore = NDVISampler.getCacheStats();
  assert.strictEqual(statsBefore.offsetRadiiCached, 1);
  const offsets1Again = NDVISampler._getCircularPixelOffsets(1);
  assert.strictEqual(
    offsets1,
    offsets1Again,
    'returns cached Int16Array reference',
  );

  const r = 5;
  const offsets5 = NDVISampler._getCircularPixelOffsets(r);
  for (let i = 0; i < offsets5.length; i += 2) {
    const dx = offsets5[i];
    const dy = offsets5[i + 1];
    assert.ok(
      dx * dx + dy * dy <= r * r,
      `point (${dx}, ${dy}) must be within disk radius ${r}`,
    );
  }
});

// ---------------------------------------------------------------------------
// 10. Tile Cache & LRU Eviction Tests
// ---------------------------------------------------------------------------

test('_tileCache: stores, retrieves, refreshes LRU, and clears', () => {
  NDVISampler.clearCache();
  assert.strictEqual(NDVISampler.getCacheStats().tileCount, 0);

  NDVISampler._putTileCache('tile_1', {
    width: 1,
    height: 1,
    data: new Float32Array([0.1]),
  });
  NDVISampler._putTileCache('tile_2', {
    width: 1,
    height: 1,
    data: new Float32Array([0.2]),
  });

  assert.strictEqual(NDVISampler.getCacheStats().tileCount, 2);
  closeTo(NDVISampler._getTileCache('tile_1').data[0], 0.1, 1e-6);
  assert.strictEqual(NDVISampler._getTileCache('non_existent'), null);

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

    NDVISampler._getTileCache('t1');
    NDVISampler._putTileCache('t4', { id: 4 });

    assert.strictEqual(NDVISampler.getCacheStats().tileCount, 3);
    assert.ok(
      NDVISampler._getTileCache('t1') !== null,
      't1 retained because touched',
    );
    assert.ok(NDVISampler._getTileCache('t2') === null, 't2 evicted as oldest');
    assert.ok(NDVISampler._getTileCache('t3') !== null, 't3 retained');
    assert.ok(NDVISampler._getTileCache('t4') !== null, 't4 retained');
  } finally {
    NDVISampler.MAX_CACHE_TILES = origMax;
    NDVISampler.clearCache();
  }
});

// ---------------------------------------------------------------------------
// 11. Network Concurrency Pool & Worker Queue (raw tile mosaic writes)
// ---------------------------------------------------------------------------

test('_fetchRawTilePool: streams batch of tile tasks with bounded concurrency and writes into the mosaic', async () => {
  NDVISampler.clearCache();
  mockUniformNdviFetch(0.33);

  const mosaicWidth = 512;
  const mosaic = new Float32Array(mosaicWidth * 512).fill(NaN);
  const tasks = [
    { url: 'tile_a', destX: 0, destY: 0 },
    { url: 'tile_b', destX: 256, destY: 0 },
    { url: 'tile_c', destX: 0, destY: 256 },
    { url: 'tile_d', destX: 256, destY: 256 },
  ];

  let progressCalls = 0;
  const res = await NDVISampler._fetchRawTilePool(tasks, mosaic, mosaicWidth, {
    concurrency: 2,
    timeoutMs: 1000,
    onTileProgress: (completed, total) => {
      progressCalls++;
      assert.strictEqual(total, 4);
      assert.ok(completed >= 1 && completed <= 4);
    },
  });

  assert.strictEqual(res.total, 4);
  assert.strictEqual(res.loaded, 4);
  assert.strictEqual(progressCalls, 4);
  closeTo(mosaic[0], 0.33, 0.01, 'top-left tile written into mosaic');
  closeTo(
    mosaic[300 * mosaicWidth + 300],
    0.33,
    0.01,
    'bottom-right tile written into mosaic',
  );
});

test('_fetchRawTilePool: honors abort signal', async () => {
  const controller = new AbortController();
  const mosaic = new Float32Array(4).fill(NaN);
  const tasks = [
    { url: 'tile_1', destX: 0, destY: 0 },
    { url: 'tile_2', destX: 0, destY: 0 },
  ];

  controller.abort(); // pre-aborted
  const res = await NDVISampler._fetchRawTilePool(tasks, mosaic, 2, {
    concurrency: 1,
    signal: controller.signal,
  });

  assert.strictEqual(res.total, 2);
});

// ---------------------------------------------------------------------------
// 12. GeoUtils Bounding Box Integration
// ---------------------------------------------------------------------------

test('sampleTrack: integrates cleanly with GeoUtils bounding box expansion', async () => {
  global.GeoUtils =
    require('../src/gps/geo_utils.mjs').GeoUtils ||
    require('../src/gps/geo_utils.mjs');
  setCopernicusConfig();
  mockUniformNdviFetch(0.55);

  const rawPoints = [
    { time: 0.0, lat: 51.505, lon: -0.09 },
    { time: 1.0, lat: 51.506, lon: -0.091 },
  ];

  const track = {
    id: 'geoutils_test_track',
    name: 'GeoUtils Integration Walk',
    analyzer: { raw: rawPoints, isEnriched: false, _dataVersion: 1 },
  };

  const res = await NDVISampler.sampleTrack(track, { zoom: 15, radiusM: 50 });
  assert.strictEqual(res.sampleCount, 2);
  assert.strictEqual(track.analyzer.isEnriched, true);
  closeTo(track.analyzer.raw[0].ndvi, 0.55, 0.01);
  closeTo(track.analyzer.raw[0].ndvi_50m, 0.55, 0.01);

  clearCopernicusConfig();
});

// ---------------------------------------------------------------------------
// 13. calculateBBox Unification Tests
// ---------------------------------------------------------------------------

test('calculateBBox: computes correctly buffered bounding box', () => {
  const points = [
    { lat: 51.5, lon: -0.1 },
    { lat: 51.51, lon: -0.09 },
  ];

  const bbox = NDVISampler.calculateBBox(points, 100);
  assert.ok(bbox !== null);
  assert.ok(bbox.minLat < 51.5, 'minLat expanded south');
  assert.ok(bbox.maxLat > 51.51, 'maxLat expanded north');
  assert.ok(bbox.minLon < -0.1, 'minLon expanded west');
  assert.ok(bbox.maxLon > -0.09, 'maxLon expanded east');

  assert.strictEqual(NDVISampler.calculateBBox([]), null);
  assert.strictEqual(NDVISampler.calculateBBox([{ lat: NaN, lon: NaN }]), null);
});

// ---------------------------------------------------------------------------
// 14. _stepHoldValues Forward Propagation Tests
// ---------------------------------------------------------------------------

test('_stepHoldValues: cleanly propagates values across non-GPS rows', () => {
  const rows = [
    { time: 0, ndvi: 0.5, ndvi_50m: 0.6 },
    { time: 1, ndvi: NaN, ndvi_50m: NaN },
    { time: 2, ndvi: null, ndvi_50m: undefined },
    { time: 3, ndvi: 0.8, ndvi_50m: 0.85 },
    { time: 4, ndvi: NaN, ndvi_50m: NaN },
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
// 15. Network Resilience & Exponential Backoff
// ---------------------------------------------------------------------------

test('_fetchRawTileWithBackoff: respects 429 rate limit and retries with backoff, then stops on 404', async () => {
  const origFetch = global.fetch;
  let fetchAttempts = 0;
  const retryEvents = [];

  global.fetch = async () => {
    fetchAttempts++;
    if (fetchAttempts < 3) {
      return {
        ok: false,
        status: 429,
        headers: { get: (h) => (h === 'Retry-After' ? '0.01' : null) },
      };
    }
    return { ok: false, status: 404, headers: { get: () => null } };
  };

  try {
    await assert.rejects(
      () =>
        NDVISampler._fetchRawTileWithBackoff(
          'https://test-tiles.com/tile.tiff',
          {
            providerId: 'test_provider_rl',
            maxRetries: 3,
            timeoutMs: 100,
            onRetry: (att, delay, reason) => {
              retryEvents.push({ att, delay, reason });
            },
          },
        ),
      /HTTP 404/,
    );

    assert.strictEqual(fetchAttempts, 3);
    assert.strictEqual(retryEvents.length, 2);
    assert.ok(retryEvents[0].reason.includes('Rate limited'));
  } finally {
    global.fetch = origFetch;
  }
});

test('_fetchRawTileWithBackoff: exhausts retries on repeated server errors and returns null', async () => {
  const origFetch = global.fetch;
  let fetchAttempts = 0;
  global.fetch = async () => {
    fetchAttempts++;
    return { ok: false, status: 503, headers: { get: () => null } };
  };

  try {
    const result = await NDVISampler._fetchRawTileWithBackoff(
      'https://test-tiles.com/tile.tiff',
      {
        maxRetries: 2,
        timeoutMs: 100,
      },
    );
    assert.strictEqual(result, null);
    assert.strictEqual(fetchAttempts, 3); // initial + 2 retries
  } finally {
    global.fetch = origFetch;
  }
});

// ---------------------------------------------------------------------------
// 16. Collective Batch Processing, Shared Mosaic & Fault Isolation
// ---------------------------------------------------------------------------

test('calculateBBoxAreaKm2: computes non-zero geographic area', () => {
  const bbox = { minLat: 51.5, maxLat: 51.51, minLon: -0.1, maxLon: -0.09 };
  const area = NDVISampler.calculateBBoxAreaKm2(bbox);
  assert.ok(area > 0.5 && area < 2.0, `area should be ~0.8 km², got ${area}`);
  assert.strictEqual(NDVISampler.calculateBBoxAreaKm2(null), 0);
});

test('_calculateTileBounds: automatically steps down zoom when tile count exceeds budget', () => {
  const wideBBox = { minLat: 51.3, maxLat: 51.6, minLon: -0.3, maxLon: 0.1 };
  const bounds = NDVISampler._calculateTileBounds(wideBBox, 15, 64, true);

  assert.ok(bounds.wasAdapted, 'adaptive zoom should trigger on wide box');
  assert.ok(
    bounds.zoom < 15,
    `zoom should step down below 15, got ${bounds.zoom}`,
  );
  assert.ok(
    bounds.totalTiles <= 64,
    `totalTiles ${bounds.totalTiles} should stay within budget`,
  );
});

test('sampleTracks: processes co-located walks via Unified Mosaic Mode', async () => {
  setCopernicusConfig();
  mockUniformNdviFetch(0.5);

  const trackA = {
    id: 'walk_a',
    name: 'Walk A - Park Path',
    analyzer: {
      raw: [
        { time: 0, lat: 51.501, lon: -0.141 },
        { time: 1, lat: 51.502, lon: -0.142 },
      ],
      isEnriched: false,
    },
  };

  const trackB = {
    id: 'walk_b',
    name: 'Walk B - Nearby Avenue',
    analyzer: {
      raw: [
        { time: 0, lat: 51.503, lon: -0.143 },
        { time: 1, lat: 51.504, lon: -0.144 },
      ],
      isEnriched: false,
    },
  };

  const res = await NDVISampler.sampleTracks([trackA, trackB], {
    zoom: 15,
    radiusM: 50,
    maxMosaicAreaKm2: 16.0,
    maxMosaicTiles: 64,
  });

  assert.strictEqual(res.mode, 'unified_mosaic');
  assert.strictEqual(res.totalCount, 2);
  assert.strictEqual(res.enrichedCount, 2);
  assert.strictEqual(res.failedCount, 0);

  assert.strictEqual(trackA.analyzer.isEnriched, true);
  assert.strictEqual(trackB.analyzer.isEnriched, true);
  closeTo(trackA.analyzer.raw[0].ndvi, 0.5, 0.01);
  closeTo(trackB.analyzer.raw[0].ndvi, 0.5, 0.01);

  clearCopernicusConfig();
});

test('sampleTracks: handles dispersed walks and isolates failures cleanly', async () => {
  setCopernicusConfig();
  mockUniformNdviFetch(0.45);

  const normalTrack = {
    id: 'walk_london',
    name: 'London Walk',
    analyzer: {
      raw: [{ time: 0, lat: 51.501, lon: -0.141 }],
      isEnriched: false,
    },
  };

  const failingTrack = {
    id: 'walk_corrupt',
    name: 'Corrupted Track',
    analyzer: {
      raw: [{ time: 0, lat: 48.856, lon: 2.352 }], // Far away (Paris) -> forces per-track mode
      get isEnriched() {
        return false;
      },
      set isEnriched(_v) {
        throw new Error('Storage write lock failure');
      },
    },
  };

  const res = await NDVISampler.sampleTracks([normalTrack, failingTrack], {
    zoom: 15,
    maxMosaicAreaKm2: 16.0,
  });

  assert.strictEqual(
    res.mode,
    'per_track',
    'dispersed tracks fall back to per-track mode',
  );
  assert.strictEqual(res.totalCount, 2);
  assert.strictEqual(res.enrichedCount, 1, 'normal track succeeded');
  assert.strictEqual(
    res.failedCount,
    1,
    'corrupted track was isolated without halting batch',
  );
  assert.strictEqual(res.failedTracks.length, 1);
  assert.strictEqual(res.failedTracks[0].name, 'Corrupted Track');

  clearCopernicusConfig();
});
