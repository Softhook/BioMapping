/**
 * Minimal baseline-TIFF reader for single-band FLOAT32 rasters.
 *
 * Handles exactly what a Sentinel Hub WMS request with
 * FORMAT=image/tiff;depth=32f against a { bands: 1, sampleType: "FLOAT32" }
 * evalscript can produce: one IFD, strip-organised (not tiled) samples,
 * either uncompressed or Deflate/Adobe-Deflate compressed strips, either
 * byte order. This is not a general-purpose TIFF/GeoTIFF reader.
 *
 * Service-specific handling (e.g. recognising a Copernicus error reply sent
 * in place of an image) belongs to the caller — see NDVISampler.parseFloat32Tiff.
 */

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
  const stream = new Blob([bytes])
    .stream()
    .pipeThrough(new DecompressionStream('deflate'));
  return await new Response(stream).arrayBuffer();
}

/** True when the buffer starts with a TIFF byte-order marker ("II" or "MM"). */
export function hasTiffByteOrderMarker(buffer) {
  if (!buffer || buffer.byteLength < 2) return false;
  const bom = new DataView(buffer).getUint16(0, false);
  return bom === 0x4949 || bom === 0x4d4d;
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
  const numEntries = view.getUint16(ifdOffset, little);
  const tags = {};
  for (let i = 0; i < numEntries; i++) {
    const entryOffset = ifdOffset + 2 + i * 12;
    const tagId = view.getUint16(entryOffset, little);
    tags[tagId] = readTagValue(view, entryOffset, little);
  }

  const width = tags[256];
  const height = tags[257];
  const bitsPerSample = first(tags[258]);
  const compression = tags[259] || 1;
  const samplesPerPixel = tags[277] || 1;
  const stripOffsets = asArray(tags[273]);
  const stripByteCounts = asArray(tags[279]);
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

  // Decode each strip (Compression 1 = none, 5 = LZW unsupported here, 8/32946 = Deflate),
  // then concatenate into one contiguous pixel-data buffer.
  const pixelBytes = new Uint8Array(width * height * 4);
  let writeOffset = 0;
  for (let s = 0; s < stripOffsets.length; s++) {
    const raw = buffer.slice(
      stripOffsets[s],
      stripOffsets[s] + stripByteCounts[s],
    );
    let decoded;
    if (compression === 1) {
      decoded = raw;
    } else if (compression === 8 || compression === 32946) {
      decoded = await inflate(raw);
    } else {
      throw new Error(
        `Unsupported TIFF compression ${compression} (only none/Deflate are handled).`,
      );
    }
    pixelBytes.set(new Uint8Array(decoded), writeOffset);
    writeOffset += decoded.byteLength;
  }

  const pixelView = new DataView(pixelBytes.buffer);
  const data = new Float32Array(width * height);
  for (let i = 0; i < data.length; i++) {
    data[i] = pixelView.getFloat32(i * 4, little);
  }

  return { width, height, data };
}
