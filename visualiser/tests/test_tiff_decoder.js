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
} = require('../src/osm/tiff_decoder.mjs');
const { buildFloat32Tiff } = require('./support/tiff_fixture.js');

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
