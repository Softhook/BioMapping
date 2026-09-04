/**
 * Unit tests for ndvi_sampler.js (NDVISampler) — Web Mercator projection
 * math, raw single-band FLOAT32 TIFF decoding, circular buffer-mean raster
 * sampling, and the track sampling pipeline for BioMapping.
 *
 * Run: node --test tests/test_ndvi_sampler.js
 */

const assert = require('assert');
const test = require('node:test');
const zlib = require('zlib');

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

/**
 * Build a minimal little-endian baseline TIFF matching what a Sentinel Hub
 * { bands: 1, sampleType: "FLOAT32" } evalscript, requested as
 * image/tiff;depth=32f, produces: one IFD, strip-organised single-band
 * float32 samples, optionally Deflate-compressed, optionally split across
 * several strips.
 */
function buildFloat32Tiff({ width, height, values, stripsCount = 1, compress = false }) {
  const rowsPerStrip = Math.ceil(height / stripsCount);
  const actualStrips = Math.ceil(height / rowsPerStrip);

  const stripBuffers = [];
  for (let s = 0; s < actualStrips; s++) {
    const rowStart = s * rowsPerStrip;
    const rowEnd = Math.min(height, rowStart + rowsPerStrip);
    const nRows = rowEnd - rowStart;
    const buf = Buffer.alloc(nRows * width * 4);
    for (let r = 0; r < nRows; r++) {
      for (let c = 0; c < width; c++) {
        buf.writeFloatLE(values[(rowStart + r) * width + c], (r * width + c) * 4);
      }
    }
    stripBuffers.push(compress ? zlib.deflateSync(buf) : buf);
  }

  const headerSize = 8;
  let offset = headerSize;
  const stripOffsets = [];
  for (const s of stripBuffers) { stripOffsets.push(offset); offset += s.length; }
  const ifdOffset = offset;
  const stripByteCounts = stripBuffers.map(b => b.length);

  const entries = [
    { tag: 256, type: 3, count: 1, val: width },
    { tag: 257, type: 3, count: 1, val: height },
    { tag: 258, type: 3, count: 1, val: 32 },
    { tag: 259, type: 3, count: 1, val: compress ? 8 : 1 },
    { tag: 273, type: 4, count: stripOffsets.length, val: stripOffsets.length === 1 ? stripOffsets[0] : stripOffsets },
    { tag: 277, type: 3, count: 1, val: 1 },
    { tag: 278, type: 3, count: 1, val: rowsPerStrip },
    { tag: 279, type: 4, count: stripByteCounts.length, val: stripByteCounts.length === 1 ? stripByteCounts[0] : stripByteCounts },
    { tag: 339, type: 3, count: 1, val: 3 },
  ].sort((a, b) => a.tag - b.tag);

  const ifdSize = 2 + entries.length * 12 + 4;
  let extraOffset = ifdOffset + ifdSize;
  const extraChunks = [];
  for (const e of entries) {
    const typeSize = e.type === 3 ? 2 : 4;
    const totalSize = typeSize * e.count;
    if (totalSize > 4) {
      e._extraOffset = extraOffset;
      const buf = Buffer.alloc(totalSize);
      const arr = Array.isArray(e.val) ? e.val : [e.val];
      for (let i = 0; i < arr.length; i++) {
        if (e.type === 3) buf.writeUInt16LE(arr[i], i * 2); else buf.writeUInt32LE(arr[i], i * 4);
      }
      extraChunks.push(buf);
      extraOffset += totalSize;
    }
  }

  const out = Buffer.alloc(extraOffset);
  out.write('II', 0, 'ascii');
  out.writeUInt16LE(42, 2);
  out.writeUInt32LE(ifdOffset, 4);

  let w = headerSize;
  for (const s of stripBuffers) { s.copy(out, w); w += s.length; }

  let p = ifdOffset;
  out.writeUInt16LE(entries.length, p); p += 2;
  for (const e of entries) {
    out.writeUInt16LE(e.tag, p);
    out.writeUInt16LE(e.type, p + 2);
    out.writeUInt32LE(e.count, p + 4);
    const typeSize = e.type === 3 ? 2 : 4;
    if (typeSize * e.count <= 4) {
      const arr = Array.isArray(e.val) ? e.val : [e.val];
      let vp = p + 8;
      for (const v of arr) {
        if (e.type === 3) { out.writeUInt16LE(v, vp); vp += 2; } else { out.writeUInt32LE(v, vp); vp += 4; }
      }
    } else {
      out.writeUInt32LE(e._extraOffset, p + 8);
    }
    p += 12;
  }
  out.writeUInt32LE(0, p); p += 4;

  let q = p;
  for (const chunk of extraChunks) { chunk.copy(out, q); q += chunk.length; }

  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}

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
    arrayBuffer: async () => uniformTileBuffer(value)
  });
}

function setCopernicusConfig(instanceId = 'test-instance-1234', rawLayerId = 'NDVI_RAW') {
  global.BIOMAP_CONFIG = { copernicusInstanceId: instanceId, copernicusRawLayerId: rawLayerId };
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
  assert.ok(url.startsWith('https://sh.dataspace.copernicus.eu/ogc/wms/test-instance-1234'));
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
  assert.ok(pxLondon > pxEquator, 'London pixels > equator pixels due to cos(lat)');
});

// ---------------------------------------------------------------------------
// 3. Raw NDVI Raster Decoding (single-band FLOAT32 TIFF)
// ---------------------------------------------------------------------------

test('parseFloat32Tiff: decodes an uncompressed single-strip raster exactly', async () => {
  const width = 4, height = 3;
  const values = [];
  for (let i = 0; i < width * height; i++) values.push((i - 6) / 10); // -0.6 .. 0.5

  const buf = buildFloat32Tiff({ width, height, values });
  const result = await NDVISampler.parseFloat32Tiff(buf);

  assert.strictEqual(result.width, width);
  assert.strictEqual(result.height, height);
  for (let i = 0; i < values.length; i++) {
    closeTo(result.data[i], values[i], 1e-6, `pixel ${i}`);
  }
});

test('parseFloat32Tiff: decodes a Deflate-compressed, multi-strip raster exactly', async () => {
  const width = 6, height = 9;
  const values = [];
  for (let i = 0; i < width * height; i++) values.push(Math.sin(i) * 0.5);

  const buf = buildFloat32Tiff({ width, height, values, stripsCount: 3, compress: true });
  const result = await NDVISampler.parseFloat32Tiff(buf);

  assert.strictEqual(result.width, width);
  assert.strictEqual(result.height, height);
  for (let i = 0; i < values.length; i++) {
    closeTo(result.data[i], values[i], 1e-5, `pixel ${i}`);
  }
});

test('parseFloat32Tiff: rejects a non-TIFF buffer', async () => {
  await assert.rejects(
    () => NDVISampler.parseFloat32Tiff(new ArrayBuffer(16)),
    /not a TIFF/
  );
});

test('parseFloat32Tiff: rejects an unexpected band/sample format (e.g. an RGBA rendering)', async () => {
  // BitsPerSample=8, SamplesPerPixel=4, SampleFormat=1 (unsigned int) — an
  // ordinary RGBA image, exactly what the rendered VEGETATION_INDEX layer
  // would produce if someone pointed the raw sampler at it by mistake.
  const width = 2, height = 2;
  const pixelBuf = Buffer.alloc(width * height * 4, 128);
  const headerSize = 8;
  const ifdOffset = headerSize + pixelBuf.length;
  const entries = [
    { tag: 256, type: 3, count: 1, val: width },
    { tag: 257, type: 3, count: 1, val: height },
    { tag: 258, type: 3, count: 1, val: 8 },
    { tag: 259, type: 3, count: 1, val: 1 },
    { tag: 273, type: 4, count: 1, val: headerSize },
    { tag: 277, type: 3, count: 1, val: 4 },
    { tag: 278, type: 3, count: 1, val: height },
    { tag: 279, type: 4, count: 1, val: pixelBuf.length },
  ];
  const out = Buffer.alloc(ifdOffset + 2 + entries.length * 12 + 4);
  out.write('II', 0, 'ascii');
  out.writeUInt16LE(42, 2);
  out.writeUInt32LE(ifdOffset, 4);
  pixelBuf.copy(out, headerSize);
  let p = ifdOffset;
  out.writeUInt16LE(entries.length, p); p += 2;
  for (const e of entries) {
    out.writeUInt16LE(e.tag, p);
    out.writeUInt16LE(e.type, p + 2);
    out.writeUInt32LE(e.count, p + 4);
    if (e.type === 3) out.writeUInt16LE(e.val, p + 8); else out.writeUInt32LE(e.val, p + 8);
    p += 12;
  }
  out.writeUInt32LE(0, p);

  const buf = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
  await assert.rejects(() => NDVISampler.parseFloat32Tiff(buf), /single-band FLOAT32/);
});

// ---------------------------------------------------------------------------
// 3b. Greyscale Map-Overlay Rendering (exact forward mapping, same raster used for sampling)
// ---------------------------------------------------------------------------

/** Minimal 2D-canvas-context stand-in: just enough for paintGreyscaleTile. */
function mockCanvasContext() {
  let lastImageData = null;
  return {
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: (imgData) => { lastImageData = imgData; },
    get lastImageData() { return lastImageData; }
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
  const rasterTile = { width: 4, height: 1, data: new Float32Array([0.1, 0.3, 0.5, 0.85]) };
  NDVISampler.paintGreyscaleTile(rasterTile, ctx);

  const d = ctx.lastImageData.data;
  const greys = [d[0], d[4], d[8], d[12]];
  assert.ok(greys[0] < greys[1] && greys[1] < greys[2] && greys[2] < greys[3], `greys should be strictly increasing, got ${greys}`);
  assert.ok(greys[3] < 255, 'even a strong reading (0.85) stays below the absolute ceiling, unlike the old heuristic');
});

test('paintGreyscaleTile: nodata sentinel pixels render fully transparent', () => {
  const ctx = mockCanvasContext();
  const rasterTile = { width: 2, height: 1, data: new Float32Array([-9999, 0.5]) };
  NDVISampler.paintGreyscaleTile(rasterTile, ctx);

  const d = ctx.lastImageData.data;
  assert.strictEqual(d[3], 0, 'nodata pixel is transparent');
  assert.strictEqual(d[7], 255, 'genuine reading stays opaque');
});

// ---------------------------------------------------------------------------
// 4. Circular Buffer Mean Sampling (on a decoded float grid)
// ---------------------------------------------------------------------------

test('sampleBuffer: correctly averages NDVI values within a circular disk', () => {
  const width = 10, height = 10;
  const data = new Float32Array(width * height).fill(0.05); // bare ground everywhere

  // Dense vegetation in the center 3x3
  for (let y = 4; y <= 6; y++) {
    for (let x = 4; x <= 6; x++) {
      data[y * width + x] = 0.85;
    }
  }

  const bufferSmall = NDVISampler.sampleBuffer(data, width, height, 5, 5, 1);
  assert.ok(bufferSmall > 0.6, 'small radius buffer is predominantly dense vegetation');

  const bufferLarge = NDVISampler.sampleBuffer(data, width, height, 5, 5, 4);
  assert.ok(bufferLarge < bufferSmall, 'larger buffer including bare ground lowers the mean');
  assert.ok(bufferLarge > 0.05, 'larger buffer still retains some vegetation influence');
});

test('sampleBuffer: nodata sentinel pixels are excluded from the mean, not averaged in', () => {
  const width = 3, height = 3;
  const data = new Float32Array([0.5, 0.5, 0.5, 0.5, -9999, 0.5, 0.5, 0.5, 0.5]);
  const mean = NDVISampler.sampleBuffer(data, width, height, 1, 1, 1);
  closeTo(mean, 0.5, 1e-3, 'nodata center pixel excluded, not dragging the mean toward -9999');
});

test('sampleBuffer: returns NaN when every pixel in range is nodata', () => {
  const width = 2, height = 2;
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
    { time: 3.0, lat: NaN, lon: NaN } // non-fix row
  ];

  const mockTrack = {
    id: 'test_walk_1',
    name: 'Green Park Walk',
    analyzer: { raw: rawPoints, isEnriched: false, _dataVersion: 1 }
  };

  const res = await NDVISampler.sampleTrack(mockTrack, { zoom: 15, radiusM: 50 });

  assert.strictEqual(res.sampleCount, 3, 'sampled 3 valid GPS fixes');
  assert.ok(mockTrack.analyzer.isEnriched, 'analyzer marked isEnriched');
  assert.ok(mockTrack.analyzer.hasNdvi, 'analyzer marked hasNdvi');
  assert.strictEqual(mockTrack.analyzer._dataVersion, 2, 'dataVersion incremented');

  for (let i = 0; i < 3; i++) {
    const pt = mockTrack.analyzer.raw[i];
    closeTo(pt.ndvi, 0.62, 0.01, `point ${i} ndvi matches the raster value exactly`);
    closeTo(pt.ndvi_50m, 0.62, 0.01, `point ${i} ndvi_50m matches the raster value exactly`);
  }

  // Non-fix row receives step-held value, not a fabricated one
  assert.strictEqual(mockTrack.analyzer.raw[3].ndvi, mockTrack.analyzer.raw[2].ndvi);
  assert.strictEqual(mockTrack.analyzer.raw[3].ndvi_50m, mockTrack.analyzer.raw[2].ndvi_50m);

  clearCopernicusConfig();
});

test('sampleTrack: a bad/missing raw layer ID fails fast with a clear error, not a silent guess', async () => {
  setCopernicusConfig();
  NDVISampler.clearCache();
  global.fetch = async () => ({ ok: false, status: 404, headers: { get: () => null } });

  const rawPoints = [{ time: 0.0, lat: 51.501, lon: -0.141 }];
  const track = { analyzer: { raw: rawPoints, isEnriched: false, _dataVersion: 1 } };

  await assert.rejects(() => NDVISampler.sampleTrack(track), /raw layer/);
  clearCopernicusConfig();
});

test('sampleTrack: a point whose tile is unreachable (transient failure) is left as NaN, never fabricated from OSM columns', async () => {
  setCopernicusConfig();
  NDVISampler.clearCache();
  // Persistent 5xx exhausts retries -> _fetchRawTileWithBackoff returns null
  // (not a throw) -> that tile's region of the grid stays NaN.
  global.fetch = async () => ({ ok: false, status: 503, headers: { get: () => null } });

  const rawPoints = [
    { time: 0.0, lat: 51.501, lon: -0.141, osm_green_pct_50m: 90, osm_canopy_pct_50m: 90 }
  ];
  const track = { analyzer: { raw: rawPoints, isEnriched: false, _dataVersion: 1 } };

  const res = await NDVISampler.sampleTrack(track, { zoom: 15, radiusM: 50 });

  assert.strictEqual(res.enrichedCount, 0, 'no genuine reading was obtained');
  assert.ok(isNaN(rawPoints[0].ndvi), 'ndvi left as NaN, not fabricated from osm_green_pct_50m');
  assert.ok(isNaN(rawPoints[0].ndvi_50m), 'ndvi_50m left as NaN, not fabricated from osm_canopy_pct_50m');

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
  setCopernicusConfig();
  mockUniformNdviFetch(0.4);

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
    { time: 0.0, lat: 55.9534, lon: -3.1897 },
    { time: 1.0, lat: 55.9535, lon: -3.1898 }
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

  clearCopernicusConfig();
});

// ---------------------------------------------------------------------------
// 8. Provider Registry & Resolution Tests (visual map overlay only)
// ---------------------------------------------------------------------------

test('PROVIDERS: registry contains standard fallback imagery providers and handles resolution', () => {
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

  const registered = NDVISampler.registerProvider('test_landsat', {
    name: 'Landsat 8 (visual)',
    type: 'xyz',
    urlTemplate: 'https://tiles.example.com/{z}/{x}/{y}.png'
  });
  assert.strictEqual(registered, true);
  const resolvedCustom = NDVISampler.resolveTileUrl('test_landsat', 1, 2, 3);
  assert.strictEqual(resolvedCustom, 'https://tiles.example.com/3/1/2.png');
});

test('getActiveProvider: falls back to open sentinel-2 (or an explicit custom URL), regardless of Copernicus config', () => {
  // getActiveProvider is only consulted for the *fallback* imagery path —
  // when Copernicus is configured, showNdviLayer renders the raw raster
  // directly instead (see map_manager_osm.js) and never calls this.
  clearCopernicusConfig();
  const provDefault = NDVISampler.getActiveProvider({});
  assert.strictEqual(provDefault.id, 'sentinel2_cloudless');

  setCopernicusConfig();
  const provWithConfig = NDVISampler.getActiveProvider({});
  assert.strictEqual(provWithConfig.id, 'sentinel2_cloudless', 'still the fallback imagery provider, not a copernicus entry');
  clearCopernicusConfig();

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
  assert.strictEqual(offsets1.length, 10);

  const statsBefore = NDVISampler.getCacheStats();
  assert.strictEqual(statsBefore.offsetRadiiCached, 1);
  const offsets1Again = NDVISampler._getCircularPixelOffsets(1);
  assert.strictEqual(offsets1, offsets1Again, 'returns cached Int16Array reference');

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

  NDVISampler._putTileCache('tile_1', { width: 1, height: 1, data: new Float32Array([0.1]) });
  NDVISampler._putTileCache('tile_2', { width: 1, height: 1, data: new Float32Array([0.2]) });

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
    { url: 'tile_d', destX: 256, destY: 256 }
  ];

  let progressCalls = 0;
  const res = await NDVISampler._fetchRawTilePool(tasks, mosaic, mosaicWidth, {
    concurrency: 2,
    timeoutMs: 1000,
    onTileProgress: (completed, total) => {
      progressCalls++;
      assert.strictEqual(total, 4);
      assert.ok(completed >= 1 && completed <= 4);
    }
  });

  assert.strictEqual(res.total, 4);
  assert.strictEqual(res.loaded, 4);
  assert.strictEqual(progressCalls, 4);
  closeTo(mosaic[0], 0.33, 0.01, 'top-left tile written into mosaic');
  closeTo(mosaic[300 * mosaicWidth + 300], 0.33, 0.01, 'bottom-right tile written into mosaic');
});

test('_fetchRawTilePool: honors abort signal', async () => {
  const controller = new AbortController();
  const mosaic = new Float32Array(4).fill(NaN);
  const tasks = [
    { url: 'tile_1', destX: 0, destY: 0 },
    { url: 'tile_2', destX: 0, destY: 0 }
  ];

  controller.abort(); // pre-aborted
  const res = await NDVISampler._fetchRawTilePool(tasks, mosaic, 2, {
    concurrency: 1,
    signal: controller.signal
  });

  assert.strictEqual(res.total, 2);
});

// ---------------------------------------------------------------------------
// 12. GeoUtils Bounding Box Integration
// ---------------------------------------------------------------------------

test('sampleTrack: integrates cleanly with GeoUtils bounding box expansion', async () => {
  global.GeoUtils = require('../src/gps/geo_utils.js').GeoUtils || require('../src/gps/geo_utils.js');
  setCopernicusConfig();
  mockUniformNdviFetch(0.55);

  const rawPoints = [
    { time: 0.0, lat: 51.505, lon: -0.09 },
    { time: 1.0, lat: 51.506, lon: -0.091 }
  ];

  const track = {
    id: 'geoutils_test_track',
    name: 'GeoUtils Integration Walk',
    analyzer: { raw: rawPoints, isEnriched: false, _dataVersion: 1 }
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
    { lat: 51.500, lon: -0.100 },
    { lat: 51.510, lon: -0.090 }
  ];

  const bbox = NDVISampler.calculateBBox(points, 100);
  assert.ok(bbox !== null);
  assert.ok(bbox.minLat < 51.500, 'minLat expanded south');
  assert.ok(bbox.maxLat > 51.510, 'maxLat expanded north');
  assert.ok(bbox.minLon < -0.100, 'minLon expanded west');
  assert.ok(bbox.maxLon > -0.090, 'maxLon expanded east');

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
// 15. Network Resilience & Exponential Backoff
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
  const respWithSec = { headers: { get: (h) => (h === 'Retry-After' ? '12' : null) } };
  assert.strictEqual(NDVISampler._retryAfterMs(respWithSec, 3000), 12000);

  const respNoHeader = { headers: { get: () => null } };
  assert.strictEqual(NDVISampler._retryAfterMs(respNoHeader, 4500), 4500);

  assert.strictEqual(NDVISampler._retryAfterMs(null, 5000), 5000);
});

test('_fetchRawTileWithBackoff: respects 429 rate limit and retries with backoff, then stops on 404', async () => {
  const origFetch = global.fetch;
  let fetchAttempts = 0;
  const retryEvents = [];

  global.fetch = async () => {
    fetchAttempts++;
    if (fetchAttempts < 3) {
      return { ok: false, status: 429, headers: { get: (h) => (h === 'Retry-After' ? '0.01' : null) } };
    }
    return { ok: false, status: 404, headers: { get: () => null } };
  };

  try {
    await assert.rejects(
      () => NDVISampler._fetchRawTileWithBackoff('https://test-tiles.com/tile.tiff', {
        providerId: 'test_provider_rl',
        maxRetries: 3,
        timeoutMs: 100,
        onRetry: (att, delay, reason) => { retryEvents.push({ att, delay, reason }); }
      }),
      /HTTP 404/
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
  global.fetch = async () => { fetchAttempts++; return { ok: false, status: 503, headers: { get: () => null } }; };

  try {
    const result = await NDVISampler._fetchRawTileWithBackoff('https://test-tiles.com/tile.tiff', {
      maxRetries: 2, timeoutMs: 100
    });
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
  const bbox = { minLat: 51.500, maxLat: 51.510, minLon: -0.100, maxLon: -0.090 };
  const area = NDVISampler.calculateBBoxAreaKm2(bbox);
  assert.ok(area > 0.5 && area < 2.0, `area should be ~0.8 km², got ${area}`);
  assert.strictEqual(NDVISampler.calculateBBoxAreaKm2(null), 0);
});

test('_calculateTileBounds: automatically steps down zoom when tile count exceeds budget', () => {
  const wideBBox = { minLat: 51.300, maxLat: 51.600, minLon: -0.300, maxLon: 0.100 };
  const bounds = NDVISampler._calculateTileBounds(wideBBox, 15, 64, true);

  assert.ok(bounds.wasAdapted, 'adaptive zoom should trigger on wide box');
  assert.ok(bounds.zoom < 15, `zoom should step down below 15, got ${bounds.zoom}`);
  assert.ok(bounds.totalTiles <= 64, `totalTiles ${bounds.totalTiles} should stay within budget`);
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
        { time: 1, lat: 51.502, lon: -0.142 }
      ],
      isEnriched: false
    }
  };

  const trackB = {
    id: 'walk_b',
    name: 'Walk B - Nearby Avenue',
    analyzer: {
      raw: [
        { time: 0, lat: 51.503, lon: -0.143 },
        { time: 1, lat: 51.504, lon: -0.144 }
      ],
      isEnriched: false
    }
  };

  const res = await NDVISampler.sampleTracks([trackA, trackB], {
    zoom: 15, radiusM: 50, maxMosaicAreaKm2: 16.0, maxMosaicTiles: 64
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
    analyzer: { raw: [{ time: 0, lat: 51.501, lon: -0.141 }], isEnriched: false }
  };

  const failingTrack = {
    id: 'walk_corrupt',
    name: 'Corrupted Track',
    analyzer: {
      raw: [{ time: 0, lat: 48.856, lon: 2.352 }], // Far away (Paris) -> forces per-track mode
      get isEnriched() { return false; },
      set isEnriched(v) { throw new Error('Storage write lock failure'); }
    }
  };

  const res = await NDVISampler.sampleTracks([normalTrack, failingTrack], {
    zoom: 15, maxMosaicAreaKm2: 16.0
  });

  assert.strictEqual(res.mode, 'per_track', 'dispersed tracks fall back to per-track mode');
  assert.strictEqual(res.totalCount, 2);
  assert.strictEqual(res.enrichedCount, 1, 'normal track succeeded');
  assert.strictEqual(res.failedCount, 1, 'corrupted track was isolated without halting batch');
  assert.strictEqual(res.failedTracks.length, 1);
  assert.strictEqual(res.failedTracks[0].name, 'Corrupted Track');

  clearCopernicusConfig();
});
