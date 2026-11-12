/**
 * Minimal baseline-TIFF reader for single-band FLOAT32 rasters.
 *
 * Handles what a Sentinel Hub WMS request with
 * FORMAT=image/tiff;depth=32f against a { bands: 1, sampleType: "FLOAT32" }
 * evalscript can produce: one IFD, strip-organised or tiled samples,
 * either uncompressed or Deflate/Adobe-Deflate compressed chunks, either
 * byte order. This is not a general-purpose TIFF/GeoTIFF reader.
 *
 * Service-specific handling (e.g. recognising a Copernicus error reply sent
 * in place of an image) belongs to the caller — see NDVISampler.parseFloat32Tiff.
 */

/**
 * Thrown when a TIFF's pixel data is cut short or corrupt, as opposed to a
 * file in a format this reader doesn't handle. A damaged download is worth
 * fetching again; a wrong format is not.
 */
export class TiffDamagedError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'TiffDamagedError';
  }
}

// Bytes per element for each TIFF field type (TIFF 6.0 §2, "Types").
const TYPE_SIZES = {
  1: 1,
  2: 1,
  3: 2,
  4: 4,
  5: 8,
  6: 1,
  7: 1,
  8: 2,
  9: 4,
  10: 8,
  11: 4,
  12: 8,
};

/**
 * Read a single TIFF IFD entry's value(s), following the offset pointer
 * when the value doesn't fit inline (TIFF 6.0 §2, "Value/Offset").
 */
function readTagValue(view, entryOffset, little) {
  const type = view.getUint16(entryOffset + 2, little);
  const count = view.getUint32(entryOffset + 4, little);
  const elemSize = TYPE_SIZES[type] || 1;
  const totalSize = elemSize * count;
  const valueFieldOffset = entryOffset + 8;
  const dataOffset =
    totalSize <= 4
      ? valueFieldOffset
      : view.getUint32(valueFieldOffset, little);

  const readOne = (off) => {
    switch (type) {
      case 1:
      case 6:
      case 7:
        return view.getUint8(off);
      case 3:
      case 8:
        return view.getUint16(off, little);
      case 4:
      case 9:
        return view.getUint32(off, little);
      case 11:
        return view.getFloat32(off, little);
      case 12:
        return view.getFloat64(off, little);
      default:
        return view.getUint32(off, little);
    }
  };

  const vals = [];
  for (let i = 0; i < count; i++) vals.push(readOne(dataOffset + i * elemSize));
  return count === 1 ? vals[0] : vals;
}

const first = (v) => (Array.isArray(v) ? v[0] : v);
const asArray = (v) => (Array.isArray(v) ? v : [v]);

/**
 * Inflate a zlib/Deflate-compressed byte range using the platform's native
 * Streams API — no vendored decompression library needed.
 * @param {ArrayBuffer} bytes
 * @returns {Promise<ArrayBuffer>}
 */
async function inflate(bytes) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error(
      'This browser has no DecompressionStream support, needed to decode a compressed TIFF.',
    );
  }
  try {
    const stream = new Blob([bytes])
      .stream()
      .pipeThrough(new DecompressionStream('deflate'));
    return await new Response(stream).arrayBuffer();
  } catch (err) {
    // Some engines reject with an empty message; keep the original as `cause`.
    throw new TiffDamagedError(
      err?.message || 'Deflate decompression failed.',
      { cause: err },
    );
  }
}

/** True when the buffer starts with a TIFF byte-order marker ("II" or "MM"). */
export function hasTiffByteOrderMarker(buffer) {
  if (!buffer || buffer.byteLength < 2) return false;
  const bom = new DataView(buffer).getUint16(0, false);
  return bom === 0x4949 || bom === 0x4d4d;
}

/**
 * Slice and decompress one raw TIFF strip or tile chunk.
 * Compression 1 = none, 8 / 32946 = Deflate / Adobe-Deflate.
 * @param {ArrayBuffer} buffer
 * @param {number} offset
 * @param {number} byteCount
 * @param {number} compression
 * @returns {Promise<ArrayBuffer>}
 */
async function readChunk(buffer, offset, byteCount, compression) {
  if (
    typeof offset !== 'number' ||
    typeof byteCount !== 'number' ||
    offset < 0 ||
    byteCount < 0 ||
    offset + byteCount > buffer.byteLength
  ) {
    throw new TiffDamagedError('TIFF chunk extends past end of buffer.');
  }
  const raw = buffer.slice(offset, offset + byteCount);
  if (compression === 1) return raw;
  if (compression === 8 || compression === 32946) return await inflate(raw);
  throw new Error(
    `Unsupported TIFF compression ${compression} (only none/Deflate are handled).`,
  );
}

/**
 * Decode strip-organised TIFF chunks sequentially into `pixelBytes`.
 */
async function decodeStrips(
  buffer,
  pixelBytes,
  stripOffsets,
  stripByteCounts,
  compression,
) {
  if (stripOffsets.length !== stripByteCounts.length) {
    throw new Error('TIFF StripOffsets and StripByteCounts lengths differ.');
  }
  const expected = pixelBytes.byteLength;
  let writeOffset = 0;
  for (let s = 0; s < stripOffsets.length; s++) {
    const decoded = await readChunk(
      buffer,
      stripOffsets[s],
      stripByteCounts[s],
      compression,
    );
    // Some writers pad the last strip out to a full RowsPerStrip; keep only
    // the bytes that belong to the image.
    const take = Math.min(decoded.byteLength, expected - writeOffset);
    pixelBytes.set(new Uint8Array(decoded, 0, take), writeOffset);
    writeOffset += take;
    if (writeOffset === expected) break;
  }
  // A short file would otherwise leave zeros, which read as real values.
  if (writeOffset !== expected) {
    throw new TiffDamagedError(
      `TIFF strips hold ${writeOffset} bytes, expected ${expected}.`,
    );
  }
}

/**
 * Decode tiled TIFF chunks in row-major tile order into `pixelBytes`.
 */
async function decodeTiles(
  buffer,
  pixelBytes,
  width,
  height,
  tileWidth,
  tileLength,
  tileOffsets,
  tileByteCounts,
  compression,
) {
  if (!tileWidth || !tileLength) {
    throw new Error('TIFF has invalid tile dimensions.');
  }
  if (tileOffsets.length !== tileByteCounts.length) {
    throw new Error('TIFF TileOffsets and TileByteCounts lengths differ.');
  }
  const tilesAcross = Math.ceil(width / tileWidth);
  const tilesDown = Math.ceil(height / tileLength);
  // A missing or short tile would otherwise leave zeros, which read as real values.
  if (tileOffsets.length !== tilesAcross * tilesDown) {
    throw new Error(
      `TIFF tile count wrong: expected ${tilesAcross * tilesDown} tiles, found ${tileOffsets.length}.`,
    );
  }
  const tileBytes = tileWidth * tileLength * 4;

  for (let t = 0; t < tileOffsets.length; t++) {
    const decoded = new Uint8Array(
      await readChunk(buffer, tileOffsets[t], tileByteCounts[t], compression),
    );
    if (decoded.byteLength < tileBytes) {
      throw new TiffDamagedError(
        `TIFF tile ${t} holds ${decoded.byteLength} bytes, expected ${tileBytes}.`,
      );
    }
    const x0 = (t % tilesAcross) * tileWidth;
    const y0 = Math.floor(t / tilesAcross) * tileLength;
    const copyCols = Math.min(tileWidth, width - x0);
    const copyRows = Math.min(tileLength, height - y0);
    if (copyCols <= 0 || copyRows <= 0) continue;

    if (tileWidth === width && x0 === 0 && copyRows === tileLength) {
      pixelBytes.set(
        decoded.subarray(0, copyCols * copyRows * 4),
        y0 * width * 4,
      );
    } else {
      for (let r = 0; r < copyRows; r++) {
        const srcStart = r * tileWidth * 4;
        const dstStart = ((y0 + r) * width + x0) * 4;
        pixelBytes.set(
          decoded.subarray(srcStart, srcStart + copyCols * 4),
          dstStart,
        );
      }
    }
  }
}

/**
 * Parse a baseline-TIFF byte buffer into a single-band FLOAT32 pixel grid.
 * @param {ArrayBuffer} buffer
 * @returns {Promise<{ width: number, height: number, data: Float32Array }>}
 */
export async function decodeFloat32Tiff(buffer) {
  if (!buffer || buffer.byteLength < 4) {
    throw new Error('Response is too short to be a valid TIFF.');
  }
  if (!hasTiffByteOrderMarker(buffer)) {
    throw new Error('Response is not a TIFF (bad byte-order marker).');
  }
  const view = new DataView(buffer);
  const little = view.getUint16(0, false) === 0x4949;
  if (view.getUint16(2, little) !== 42) {
    throw new Error('Response is not a TIFF (bad magic number).');
  }

  const ifdOffset = view.getUint32(4, little);
  const tags = {};
  try {
    const numEntries = view.getUint16(ifdOffset, little);
    for (let i = 0; i < numEntries; i++) {
      const entryOffset = ifdOffset + 2 + i * 12;
      const tagId = view.getUint16(entryOffset, little);
      tags[tagId] = readTagValue(view, entryOffset, little);
    }
  } catch (err) {
    if (!(err instanceof RangeError)) throw err;
    throw new TiffDamagedError('TIFF tag directory is cut short.', {
      cause: err,
    });
  }

  const width = tags[256];
  const height = tags[257];
  const bitsPerSample = first(tags[258]);
  const compression = tags[259] || 1;
  const predictor = tags[317] || 1;
  const samplesPerPixel = tags[277] || 1;
  const sampleFormat = tags[339] ? first(tags[339]) : 1;

  if (!width || !height) {
    throw new Error('TIFF has no usable image dimensions.');
  }
  if (samplesPerPixel !== 1 || bitsPerSample !== 32 || sampleFormat !== 3) {
    throw new Error(
      `Unexpected raster format (samples=${samplesPerPixel}, bits=${bitsPerSample}, ` +
        `sampleFormat=${sampleFormat}) — expected single-band FLOAT32.`,
    );
  }
  if (predictor !== 1) {
    throw new Error(
      `Unsupported TIFF predictor ${predictor} (only 1/none is handled).`,
    );
  }

  const pixelBytes = new Uint8Array(width * height * 4);
  const hasStrips = tags[273] !== undefined && tags[279] !== undefined;
  const hasTiles =
    tags[322] !== undefined &&
    tags[323] !== undefined &&
    tags[324] !== undefined &&
    tags[325] !== undefined;

  if (hasStrips) {
    await decodeStrips(
      buffer,
      pixelBytes,
      asArray(tags[273]),
      asArray(tags[279]),
      compression,
    );
  } else if (hasTiles) {
    await decodeTiles(
      buffer,
      pixelBytes,
      width,
      height,
      tags[322],
      tags[323],
      asArray(tags[324]),
      asArray(tags[325]),
      compression,
    );
  } else {
    throw new Error('TIFF has neither strip nor tile data.');
  }

  const pixelView = new DataView(pixelBytes.buffer);
  const data = new Float32Array(width * height);
  for (let i = 0; i < data.length; i++) {
    data[i] = pixelView.getFloat32(i * 4, little);
  }

  return { width, height, data };
}
