/**
 * Test fixture: builds small baseline TIFF files in memory, shared by
 * test_tiff_decoder.js and test_ndvi_sampler.js.
 */
const zlib = require('node:zlib');

/**
 * Write a one-IFD TIFF: header, then the pixel chunks, then the IFD, then any
 * tag values too big to sit inline. Entries are sorted by tag as TIFF requires.
 * A `{ chunkOffsets: true }` entry gets the chunk offsets as its value; a
 * `{ chunkCounts: true }` entry gets the chunk byte counts.
 * @param {{ entries: Array<object>, chunks?: Buffer[], littleEndian?: boolean }} opts
 * @returns {ArrayBuffer}
 */
function writeTiff({ entries, chunks = [], littleEndian = true }) {
  const u16 = littleEndian ? 'writeUInt16LE' : 'writeUInt16BE';
  const u32 = littleEndian ? 'writeUInt32LE' : 'writeUInt32BE';
  const headerSize = 8;

  let offset = headerSize;
  const chunkOffsets = [];
  for (const c of chunks) {
    chunkOffsets.push(offset);
    offset += c.length;
  }
  const ifdOffset = offset;
  const chunkCounts = chunks.map((c) => c.length);

  const list = entries
    .map((e) => {
      let val = e.val;
      if (e.chunkOffsets) val = chunkOffsets;
      if (e.chunkCounts) val = chunkCounts;
      const arr = Array.isArray(val) ? val : [val];
      return { tag: e.tag, type: e.type, arr };
    })
    .sort((a, b) => a.tag - b.tag);

  const ifdSize = 2 + list.length * 12 + 4;
  let extraOffset = ifdOffset + ifdSize;
  for (const e of list) {
    const size = (e.type === 3 ? 2 : 4) * e.arr.length;
    if (size > 4) {
      e.extraOffset = extraOffset;
      extraOffset += size;
    }
  }

  const out = Buffer.alloc(extraOffset);
  out.write(littleEndian ? 'II' : 'MM', 0, 'ascii');
  out[u16](42, 2);
  out[u32](ifdOffset, 4);
  chunks.forEach((c, i) => {
    c.copy(out, chunkOffsets[i]);
  });

  const writeValues = (e, at) => {
    for (const v of e.arr) {
      if (e.type === 3) {
        out[u16](v, at);
        at += 2;
      } else {
        out[u32](v, at);
        at += 4;
      }
    }
  };

  let p = ifdOffset;
  out[u16](list.length, p);
  p += 2;
  for (const e of list) {
    out[u16](e.tag, p);
    out[u16](e.type, p + 2);
    out[u32](e.arr.length, p + 4);
    if (e.extraOffset === undefined) writeValues(e, p + 8);
    else {
      out[u32](e.extraOffset, p + 8);
      writeValues(e, e.extraOffset);
    }
    p += 12;
  }
  out[u32](0, p);

  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}

/** Tags shared by every single-band FLOAT32 raster built here. */
function float32Tags(width, height, compression) {
  return [
    { tag: 256, type: 3, val: width },
    { tag: 257, type: 3, val: height },
    { tag: 258, type: 3, val: 32 },
    { tag: 259, type: 3, val: compression },
    { tag: 277, type: 3, val: 1 },
    { tag: 339, type: 3, val: 3 },
  ];
}

/**
 * Build a strip-organised single-band FLOAT32 TIFF, optionally
 * Deflate-compressed, optionally split across several strips.
 * `littleEndian: false` writes a big-endian ("MM") file; `compression`
 * overrides the Compression tag (e.g. 5 = LZW) without changing how the
 * strips are actually encoded. `editChunks` lets a test damage the encoded
 * chunks (drop or shorten them) before they are written.
 */
function buildFloat32Tiff({
  width,
  height,
  values,
  stripsCount = 1,
  compress = false,
  littleEndian = true,
  compression = compress ? 8 : 1,
  editChunks = (c) => c,
}) {
  const f32 = littleEndian ? 'writeFloatLE' : 'writeFloatBE';
  const rowsPerStrip = Math.ceil(height / stripsCount);
  const actualStrips = Math.ceil(height / rowsPerStrip);

  const chunks = [];
  for (let s = 0; s < actualStrips; s++) {
    const rowStart = s * rowsPerStrip;
    const nRows = Math.min(height, rowStart + rowsPerStrip) - rowStart;
    const buf = Buffer.alloc(nRows * width * 4);
    for (let r = 0; r < nRows; r++) {
      for (let c = 0; c < width; c++) {
        buf[f32](values[(rowStart + r) * width + c], (r * width + c) * 4);
      }
    }
    chunks.push(compress ? zlib.deflateSync(buf) : buf);
  }

  return writeTiff({
    littleEndian,
    chunks: editChunks(chunks),
    entries: [
      ...float32Tags(width, height, compression),
      { tag: 273, type: 4, chunkOffsets: true },
      { tag: 278, type: 3, val: rowsPerStrip },
      { tag: 279, type: 4, chunkCounts: true },
    ],
  });
}

/**
 * Build a tiled single-band FLOAT32 TIFF (TileWidth/TileLength/TileOffsets/
 * TileByteCounts). Edge tiles are padded to full tile size, as the TIFF spec
 * requires. Compression 8 or 32946 deflates each tile. `editChunks` lets a
 * test damage the encoded tiles before they are written.
 */
function buildTiledFloat32Tiff({
  width,
  height,
  tileWidth,
  tileLength,
  values,
  compression = 1,
  littleEndian = true,
  editChunks = (c) => c,
}) {
  const f32 = littleEndian ? 'writeFloatLE' : 'writeFloatBE';
  const tilesAcross = Math.ceil(width / tileWidth);
  const tilesDown = Math.ceil(height / tileLength);
  const deflate = compression === 8 || compression === 32946;

  const chunks = [];
  for (let ty = 0; ty < tilesDown; ty++) {
    for (let tx = 0; tx < tilesAcross; tx++) {
      const buf = Buffer.alloc(tileWidth * tileLength * 4);
      for (let r = 0; r < tileLength; r++) {
        const y = ty * tileLength + r;
        if (y >= height) continue;
        for (let c = 0; c < tileWidth; c++) {
          const x = tx * tileWidth + c;
          if (x >= width) continue;
          buf[f32](values[y * width + x], (r * tileWidth + c) * 4);
        }
      }
      chunks.push(deflate ? zlib.deflateSync(buf) : buf);
    }
  }

  return writeTiff({
    littleEndian,
    chunks: editChunks(chunks),
    entries: [
      ...float32Tags(width, height, compression),
      { tag: 322, type: 3, val: tileWidth },
      { tag: 323, type: 3, val: tileLength },
      { tag: 324, type: 4, chunkOffsets: true },
      { tag: 325, type: 4, chunkCounts: true },
    ],
  });
}

/**
 * Build a FLOAT32 TIFF header with only the given extra tags and no pixel
 * data — for testing how the decoder rejects malformed files.
 */
function buildHeaderOnlyTiff({
  width = 2,
  height = 2,
  compression = 1,
  extraTags = [],
} = {}) {
  return writeTiff({
    entries: [...float32Tags(width, height, compression), ...extraTags],
  });
}

module.exports = {
  buildFloat32Tiff,
  buildTiledFloat32Tiff,
  buildHeaderOnlyTiff,
};
