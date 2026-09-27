/**
 * Test fixture: builds small baseline TIFF files in memory, shared by
 * test_tiff_decoder.js and test_ndvi_sampler.js.
 */
const zlib = require('node:zlib');

/**
 * Build a minimal baseline TIFF matching what a Sentinel Hub
 * { bands: 1, sampleType: "FLOAT32" } evalscript, requested as
 * image/tiff;depth=32f, produces: one IFD, strip-organised single-band
 * float32 samples, optionally Deflate-compressed, optionally split across
 * several strips. `littleEndian: false` writes a big-endian ("MM") file;
 * `compression` overrides the Compression tag (e.g. 5 = LZW) without
 * changing how the strips are actually encoded.
 */
function buildFloat32Tiff({
  width,
  height,
  values,
  stripsCount = 1,
  compress = false,
  littleEndian = true,
  compression = compress ? 8 : 1,
}) {
  const u16 = littleEndian ? 'writeUInt16LE' : 'writeUInt16BE';
  const u32 = littleEndian ? 'writeUInt32LE' : 'writeUInt32BE';
  const f32 = littleEndian ? 'writeFloatLE' : 'writeFloatBE';
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
        buf[f32](values[(rowStart + r) * width + c], (r * width + c) * 4);
      }
    }
    stripBuffers.push(compress ? zlib.deflateSync(buf) : buf);
  }

  const headerSize = 8;
  let offset = headerSize;
  const stripOffsets = [];
  for (const s of stripBuffers) {
    stripOffsets.push(offset);
    offset += s.length;
  }
  const ifdOffset = offset;
  const stripByteCounts = stripBuffers.map((b) => b.length);

  const entries = [
    { tag: 256, type: 3, count: 1, val: width },
    { tag: 257, type: 3, count: 1, val: height },
    { tag: 258, type: 3, count: 1, val: 32 },
    { tag: 259, type: 3, count: 1, val: compression },
    {
      tag: 273,
      type: 4,
      count: stripOffsets.length,
      val: stripOffsets.length === 1 ? stripOffsets[0] : stripOffsets,
    },
    { tag: 277, type: 3, count: 1, val: 1 },
    { tag: 278, type: 3, count: 1, val: rowsPerStrip },
    {
      tag: 279,
      type: 4,
      count: stripByteCounts.length,
      val: stripByteCounts.length === 1 ? stripByteCounts[0] : stripByteCounts,
    },
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
        if (e.type === 3) buf[u16](arr[i], i * 2);
        else buf[u32](arr[i], i * 4);
      }
      extraChunks.push(buf);
      extraOffset += totalSize;
    }
  }

  const out = Buffer.alloc(extraOffset);
  out.write(littleEndian ? 'II' : 'MM', 0, 'ascii');
  out[u16](42, 2);
  out[u32](ifdOffset, 4);

  let w = headerSize;
  for (const s of stripBuffers) {
    s.copy(out, w);
    w += s.length;
  }

  let p = ifdOffset;
  out[u16](entries.length, p);
  p += 2;
  for (const e of entries) {
    out[u16](e.tag, p);
    out[u16](e.type, p + 2);
    out[u32](e.count, p + 4);
    const typeSize = e.type === 3 ? 2 : 4;
    if (typeSize * e.count <= 4) {
      const arr = Array.isArray(e.val) ? e.val : [e.val];
      let vp = p + 8;
      for (const v of arr) {
        if (e.type === 3) {
          out[u16](v, vp);
          vp += 2;
        } else {
          out[u32](v, vp);
          vp += 4;
        }
      }
    } else {
      out[u32](e._extraOffset, p + 8);
    }
    p += 12;
  }
  out[u32](0, p);
  p += 4;

  let q = p;
  for (const chunk of extraChunks) {
    chunk.copy(out, q);
    q += chunk.length;
  }

  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}

module.exports = { buildFloat32Tiff };
