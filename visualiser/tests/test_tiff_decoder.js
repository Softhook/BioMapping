/**
 * Unit tests for osm/tiff_decoder.mjs — the minimal single-band FLOAT32
 * baseline-TIFF reader behind the NDVI raster sampler.
 *
 * Run: node --test tests/test_tiff_decoder.js
 */

const assert = require('node:assert');
const test = require('node:test');

const {
  decodeFloat32Tiff,
  hasTiffByteOrderMarker,
  TiffDamagedError,
} = require('../src/osm/tiff_decoder.mjs');
const {
  buildFloat32Tiff,
  buildTiledFloat32Tiff,
  buildHeaderOnlyTiff,
} = require('./support/tiff_fixture.js');

const closeTo = (actual, expected, tolerance, msg) => {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${msg} expected ${actual} to be within ${tolerance} of ${expected}`,
  );
};

test('decodes an uncompressed single-strip raster exactly', async () => {
  const width = 4,
    height = 3;
  const values = [];
  for (let i = 0; i < width * height; i++) values.push((i - 6) / 10); // -0.6 .. 0.5

  const buf = buildFloat32Tiff({ width, height, values });
  const result = await decodeFloat32Tiff(buf);

  assert.strictEqual(result.width, width);
  assert.strictEqual(result.height, height);
  for (let i = 0; i < values.length; i++) {
    closeTo(result.data[i], values[i], 1e-6, `pixel ${i}`);
  }
});

test('decodes a Deflate-compressed, multi-strip raster exactly', async () => {
  const width = 6,
    height = 9;
  const values = [];
  for (let i = 0; i < width * height; i++) values.push(Math.sin(i) * 0.5);

  const buf = buildFloat32Tiff({
    width,
    height,
    values,
    stripsCount: 3,
    compress: true,
  });
  const result = await decodeFloat32Tiff(buf);

  assert.strictEqual(result.width, width);
  assert.strictEqual(result.height, height);
  for (let i = 0; i < values.length; i++) {
    closeTo(result.data[i], values[i], 1e-5, `pixel ${i}`);
  }
});

test('rejects a non-TIFF buffer', async () => {
  await assert.rejects(
    () => decodeFloat32Tiff(new ArrayBuffer(16)),
    /not a TIFF/,
  );
});

test('rejects an unexpected band/sample format (e.g. an RGBA rendering)', async () => {
  // BitsPerSample=8, SamplesPerPixel=4, SampleFormat=1 (unsigned int) — an
  // ordinary RGBA image, exactly what the rendered VEGETATION_INDEX layer
  // would produce if someone pointed the raw sampler at it by mistake.
  const width = 2,
    height = 2;
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
  out.writeUInt16LE(entries.length, p);
  p += 2;
  for (const e of entries) {
    out.writeUInt16LE(e.tag, p);
    out.writeUInt16LE(e.type, p + 2);
    out.writeUInt32LE(e.count, p + 4);
    if (e.type === 3) out.writeUInt16LE(e.val, p + 8);
    else out.writeUInt32LE(e.val, p + 8);
    p += 12;
  }
  out.writeUInt32LE(0, p);

  const buf = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
  await assert.rejects(() => decodeFloat32Tiff(buf), /single-band FLOAT32/);
});

test('decodes a big-endian ("MM") Deflate raster exactly', async () => {
  const width = 5,
    height = 4;
  const values = [];
  for (let i = 0; i < width * height; i++) values.push(Math.cos(i) * 0.7);

  const buf = buildFloat32Tiff({
    width,
    height,
    values,
    stripsCount: 2,
    compress: true,
    littleEndian: false,
  });
  const result = await decodeFloat32Tiff(buf);

  assert.strictEqual(result.width, width);
  assert.strictEqual(result.height, height);
  for (let i = 0; i < values.length; i++) {
    closeTo(result.data[i], values[i], 1e-6, `pixel ${i}`);
  }
});

test('rejects a buffer too short to hold a TIFF header', async () => {
  await assert.rejects(
    () => decodeFloat32Tiff(new ArrayBuffer(2)),
    /too short/,
  );
  await assert.rejects(() => decodeFloat32Tiff(null), /too short/);
});

test('rejects a correct byte-order marker with the wrong magic number', async () => {
  const buf = buildFloat32Tiff({ width: 1, height: 1, values: [0.5] });
  new DataView(buf).setUint16(2, 43, true);
  await assert.rejects(() => decodeFloat32Tiff(buf), /bad magic number/);
});

test('rejects an unsupported compression scheme (LZW)', async () => {
  const buf = buildFloat32Tiff({
    width: 2,
    height: 2,
    values: [0, 0, 0, 0],
    compression: 5,
  });
  await assert.rejects(
    () => decodeFloat32Tiff(buf),
    /Unsupported TIFF compression 5/,
  );
});

test('hasTiffByteOrderMarker: recognises II and MM, nothing else', () => {
  const le = buildFloat32Tiff({ width: 1, height: 1, values: [0] });
  const be = buildFloat32Tiff({
    width: 1,
    height: 1,
    values: [0],
    littleEndian: false,
  });
  assert.strictEqual(hasTiffByteOrderMarker(le), true);
  assert.strictEqual(hasTiffByteOrderMarker(be), true);
  assert.strictEqual(
    hasTiffByteOrderMarker(new TextEncoder().encode('<?xml').buffer),
    false,
  );
  assert.strictEqual(hasTiffByteOrderMarker(new ArrayBuffer(1)), false);
  assert.strictEqual(hasTiffByteOrderMarker(null), false);
});

// --- Tiled TIFFs ------------------------------------------------------------

const ramp = (n, f) => Array.from({ length: n }, (_, i) => f(i));

const assertGrid = (result, width, height, values) => {
  assert.strictEqual(result.width, width);
  assert.strictEqual(result.height, height);
  assert.strictEqual(result.data.length, values.length);
  for (let i = 0; i < values.length; i++) {
    closeTo(result.data[i], values[i], 1e-6, `pixel ${i}`);
  }
};

test('decodes a single-tile Adobe-Deflate (32946) tiled TIFF', async () => {
  const values = ramp(16, (i) => (i - 8) / 10);
  const buf = buildTiledFloat32Tiff({
    width: 4,
    height: 4,
    tileWidth: 4,
    tileLength: 4,
    values,
    compression: 32946,
  });
  assertGrid(await decodeFloat32Tiff(buf), 4, 4, values);
});

test('decodes a multi-tile Deflate TIFF with partial edge tiles', async () => {
  const values = ramp(25, (i) => Math.sin(i) * 0.8);
  const buf = buildTiledFloat32Tiff({
    width: 5,
    height: 5,
    tileWidth: 3,
    tileLength: 3,
    values,
    compression: 8,
  });
  assertGrid(await decodeFloat32Tiff(buf), 5, 5, values);
});

test('decodes an uncompressed tiled TIFF with non-square tiles', async () => {
  const values = ramp(7 * 6, (i) => i / 100);
  const buf = buildTiledFloat32Tiff({
    width: 7,
    height: 6,
    tileWidth: 4,
    tileLength: 2,
    values,
  });
  assertGrid(await decodeFloat32Tiff(buf), 7, 6, values);
});

test('decodes full-width tiles stacked down, with a padded last tile', async () => {
  // Tiles as wide as the image take the whole-row fast path; the last tile
  // hangs past the bottom edge and must only copy the rows that exist.
  const values = ramp(4 * 5, (i) => -i / 20);
  const buf = buildTiledFloat32Tiff({
    width: 4,
    height: 5,
    tileWidth: 4,
    tileLength: 2,
    values,
    compression: 8,
  });
  assertGrid(await decodeFloat32Tiff(buf), 4, 5, values);
});

test('decodes one tile larger than the image', async () => {
  const values = ramp(9, (i) => i * 0.1);
  const buf = buildTiledFloat32Tiff({
    width: 3,
    height: 3,
    tileWidth: 16,
    tileLength: 16,
    values,
    compression: 8,
  });
  assertGrid(await decodeFloat32Tiff(buf), 3, 3, values);
});

test('decodes a big-endian tiled TIFF', async () => {
  const values = ramp(25, (i) => (i % 7) / 7 - 0.5);
  const buf = buildTiledFloat32Tiff({
    width: 5,
    height: 5,
    tileWidth: 2,
    tileLength: 2,
    values,
    compression: 8,
    littleEndian: false,
  });
  assertGrid(await decodeFloat32Tiff(buf), 5, 5, values);
});

test('decodes a 256x256 tiled raster, the size the NDVI sampler requests', async () => {
  const values = ramp(256 * 256, (i) => ((i * 37) % 2001) / 1000 - 1);
  const buf = buildTiledFloat32Tiff({
    width: 256,
    height: 256,
    tileWidth: 256,
    tileLength: 256,
    values,
    compression: 32946,
  });
  assertGrid(await decodeFloat32Tiff(buf), 256, 256, values);
});

// --- Malformed files ---------------------------------------------------------

test('rejects a TIFF with neither strip nor tile tags', async () => {
  await assert.rejects(
    () => decodeFloat32Tiff(buildHeaderOnlyTiff()),
    /neither strip nor tile/,
  );
});

test('rejects an unsupported TIFF predictor (e.g. predictor=3)', async () => {
  const buf = buildHeaderOnlyTiff({
    extraTags: [
      { tag: 317, type: 3, val: 3 },
      { tag: 322, type: 3, val: 2 },
      { tag: 323, type: 3, val: 2 },
      { tag: 324, type: 4, val: 100 },
      { tag: 325, type: 4, val: 16 },
    ],
  });
  await assert.rejects(
    () => decodeFloat32Tiff(buf),
    /Unsupported TIFF predictor 3/,
  );
});

test('rejects a TIFF whose chunk extends past the end of the file', async () => {
  const bad = buildHeaderOnlyTiff({
    width: 4,
    height: 4,
    extraTags: [
      { tag: 322, type: 3, val: 4 },
      { tag: 323, type: 3, val: 4 },
      { tag: 324, type: 4, val: 8 },
      { tag: 325, type: 4, val: 10000 }, // far more bytes than the file holds
    ],
  });
  await assert.rejects(
    () => decodeFloat32Tiff(bad),
    /extends past end of buffer/,
  );
});

test('rejects corrupt Deflate data with a readable message', async () => {
  const bad = buildHeaderOnlyTiff({
    width: 2,
    height: 2,
    compression: 8,
    extraTags: [
      { tag: 322, type: 3, val: 2 },
      { tag: 323, type: 3, val: 2 },
      // Point the tile at the IFD itself, which is not valid zlib data.
      { tag: 324, type: 4, val: 8 },
      { tag: 325, type: 4, val: 20 },
    ],
  });
  await assert.rejects(
    () => decodeFloat32Tiff(bad),
    (err) =>
      err instanceof Error && err.message.length > 0 && err.cause !== undefined,
  );
});

// --- Damaged pixel data --------------------------------------------------------
// Missing pixels must never decode as 0: NDVI 0 is a real value (bare ground).

test('rejects a tiled TIFF with a tile missing', async () => {
  const buf = buildTiledFloat32Tiff({
    width: 4,
    height: 4,
    tileWidth: 2,
    tileLength: 2,
    values: new Array(16).fill(0.5),
    editChunks: (chunks) => chunks.slice(0, 3),
  });
  await assert.rejects(
    () => decodeFloat32Tiff(buf),
    /expected 4 tiles, found 3/,
  );
});

test('rejects a tile that decodes to too few bytes', async () => {
  const buf = buildTiledFloat32Tiff({
    width: 4,
    height: 4,
    tileWidth: 2,
    tileLength: 2,
    values: new Array(16).fill(0.5),
    editChunks: (chunks) =>
      chunks.map((c, i) => (i === 2 ? c.subarray(0, 8) : c)),
  });
  await assert.rejects(
    () => decodeFloat32Tiff(buf),
    /tile 2 holds 8 bytes, expected 16/,
  );
});

test('rejects strips that hold fewer pixels than the image', async () => {
  const buf = buildFloat32Tiff({
    width: 4,
    height: 4,
    values: new Array(16).fill(0.5),
    stripsCount: 2,
    editChunks: (chunks) => chunks.slice(0, 1),
  });
  await assert.rejects(
    () => decodeFloat32Tiff(buf),
    /strips hold 32 bytes, expected 64/,
  );
});

test('ignores padding after the last strip', async () => {
  // Some writers pad the last strip to a full RowsPerStrip.
  const values = Array.from({ length: 12 }, (_, i) => i / 10);
  const buf = buildFloat32Tiff({
    width: 4,
    height: 3,
    values,
    stripsCount: 2, // 2 rows per strip, so the second strip holds 1 row
    editChunks: (chunks) => [
      chunks[0],
      Buffer.concat([chunks[1], Buffer.alloc(16, 0xff)]),
    ],
  });
  const result = await decodeFloat32Tiff(buf);
  assert.strictEqual(result.data.length, 12);
  for (let i = 0; i < 12; i++)
    closeTo(result.data[i], values[i], 1e-6, `pixel ${i}`);
});

test('damaged data throws TiffDamagedError; a wrong format does not', async () => {
  const short = buildTiledFloat32Tiff({
    width: 4,
    height: 4,
    tileWidth: 2,
    tileLength: 2,
    values: new Array(16).fill(0.5),
    editChunks: (chunks) =>
      chunks.map((c, i) => (i === 1 ? c.subarray(0, 4) : c)),
  });
  await assert.rejects(() => decodeFloat32Tiff(short), TiffDamagedError);

  const corrupt = buildTiledFloat32Tiff({
    width: 2,
    height: 2,
    tileWidth: 2,
    tileLength: 2,
    values: [0.1, 0.2, 0.3, 0.4],
    compression: 8,
    editChunks: (_chunks) => [Buffer.from('not zlib data at all')],
  });
  await assert.rejects(() => decodeFloat32Tiff(corrupt), TiffDamagedError);

  const wrongFormat = buildFloat32Tiff({
    width: 2,
    height: 2,
    values: [0, 0, 0, 0],
    compression: 5,
  });
  await assert.rejects(
    () => decodeFloat32Tiff(wrongFormat),
    (err) =>
      !(err instanceof TiffDamagedError) && /compression 5/.test(err.message),
  );
});

test('a file cut short through its tag directory throws TiffDamagedError', async () => {
  // The fixture writes the tag directory after the pixels, so trimming the
  // end cuts into it.
  const buf = buildTiledFloat32Tiff({
    width: 4,
    height: 4,
    tileWidth: 4,
    tileLength: 4,
    values: new Array(16).fill(0.2),
  });
  await assert.rejects(
    () => decodeFloat32Tiff(buf.slice(0, buf.byteLength - 20)),
    (err) => err instanceof TiffDamagedError && /cut short/.test(err.message),
  );
});
