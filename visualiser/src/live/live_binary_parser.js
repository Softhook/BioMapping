/**
 * GSR Live Binary Parser — decodes the 45-byte packed binary packets sent by
 * BioMapModeLiveStream (see docs/archive/bluetooth_serial_investigation.md §5 for the
 * wire format). Pure, no DOM/transport coupling — fed raw bytes via append()
 * from either a Web Serial ReadableStream (Phase 0) or a Web Bluetooth
 * 'characteristicvaluechanged' event (Phase 4), and resyncs on the magic
 * byte pair if the underlying transport ever splits or garbles a packet.
 */

const PACKET_SIZE = 45;
const MAGIC_0 = 0x42; // 'B'
const MAGIC_1 = 0x4d; // 'M'

class GSRLiveBinaryParser {
  /**
   * @param {(pkt: object) => void} onPacketParsed
   */
  constructor(onPacketParsed) {
    this.onPacketParsed = onPacketParsed;
    this.buffer = new Uint8Array(0);
  }

  /**
   * Feed newly-arrived bytes in. Synchronously parses and emits every
   * complete packet currently available, then holds any trailing partial
   * packet for the next call.
   * @param {Uint8Array} newData
   */
  append(newData) {
    const combined = new Uint8Array(this.buffer.length + newData.length);
    combined.set(this.buffer, 0);
    combined.set(newData, this.buffer.length);
    this.buffer = combined;
    this._processQueue();
  }

  _processQueue() {
    for (;;) {
      if (this.buffer.length < PACKET_SIZE) return;

      if (this.buffer[0] === MAGIC_0 && this.buffer[1] === MAGIC_1) {
        this._parsePacket(this.buffer.subarray(0, PACKET_SIZE));
        this.buffer = this.buffer.subarray(PACKET_SIZE);
        continue;
      }

      // Not aligned on a packet boundary — scan forward for the next
      // magic-byte pair and drop everything before it.
      let syncIndex = -1;
      for (let i = 1; i < this.buffer.length - 1; i++) {
        if (this.buffer[i] === MAGIC_0 && this.buffer[i + 1] === MAGIC_1) {
          syncIndex = i;
          break;
        }
      }
      if (syncIndex !== -1) {
        this.buffer = this.buffer.subarray(syncIndex);
        continue;
      }

      // No resync point found in what we have. Keep a trailing lone
      // MAGIC_0 byte (it may be the first half of a magic pair split
      // across this append() and the next); discard everything else.
      this.buffer =
        this.buffer[this.buffer.length - 1] === MAGIC_0
          ? new Uint8Array([MAGIC_0])
          : new Uint8Array(0);
      return;
    }
  }

  _parsePacket(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const valid = view.getUint8(44);
    this.onPacketParsed({
      timestamp: view.getUint32(2, true) / 1000.0,
      lat: valid ? view.getFloat64(6, true) : NaN,
      lon: valid ? view.getFloat64(14, true) : NaN,
      gsrRaw: view.getFloat32(22, true),
      hdop: view.getFloat32(26, true),
      pdop: view.getFloat32(30, true),
      speedKts: view.getFloat32(34, true),
      courseDeg: view.getFloat32(38, true),
      sats: view.getUint8(42),
      fixType: view.getUint8(43),
      valid: !!valid,
    });
  }
}

if (typeof window !== 'undefined') window.GSRLiveBinaryParser = GSRLiveBinaryParser;
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GSRLiveBinaryParser, PACKET_SIZE, MAGIC_0, MAGIC_1 };
}
