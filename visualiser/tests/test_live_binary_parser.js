/**
 * Unit tests for live_binary_parser.js (GSRLiveBinaryParser) — the wire
 * decoder for BioMapModeLiveStream's 45-byte packed binary packets (see
 * docs/archive/bluetooth_serial_investigation.md §5/§8). Exercises the resync-on-
 * magic-byte logic directly, since that's the part most likely to break
 * against a real, possibly-fragmenting transport (Web Serial/Web Bluetooth
 * notifications don't guarantee one packet per delivery).
 *
 * Run: node --test tests/test_live_binary_parser.js  (or `npm test` for the whole suite)
 */

const assert = require('assert');
const test = require('node:test');

const { GSRLiveBinaryParser, PACKET_SIZE } = require('../live_binary_parser.js');

// Builds one valid 45-byte wire packet from field values, matching the
// offset table in docs/archive/bluetooth_serial_investigation.md §5 exactly.
function buildPacket({
  timestampMs = 1000,
  lat = 51.5074,
  lon = -0.1278,
  gsrRaw = 1234.5,
  hdop = 1.2,
  pdop = 1.8,
  speedKts = 3.4,
  courseDeg = 270.0,
  sats = 9,
  fixType = 3,
  valid = 1,
} = {}) {
  const buf = new Uint8Array(PACKET_SIZE);
  const view = new DataView(buf.buffer);
  buf[0] = 0x42;
  buf[1] = 0x4d;
  view.setUint32(2, timestampMs, true);
  view.setFloat64(6, lat, true);
  view.setFloat64(14, lon, true);
  view.setFloat32(22, gsrRaw, true);
  view.setFloat32(26, hdop, true);
  view.setFloat32(30, pdop, true);
  view.setFloat32(34, speedKts, true);
  view.setFloat32(38, courseDeg, true);
  buf[42] = sats;
  buf[43] = fixType;
  buf[44] = valid;
  return buf;
}

function collectPackets() {
  const packets = [];
  const parser = new GSRLiveBinaryParser((pkt) => packets.push(pkt));
  return { parser, packets };
}

const closeTo = (actual, expected, tolerance, msg) => {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${msg || ''} expected ${actual} to be within ${tolerance} of ${expected}`,
  );
};

test('parses a single well-formed packet', () => {
  const { parser, packets } = collectPackets();
  parser.append(buildPacket({ timestampMs: 4200, lat: 51.5074, lon: -0.1278, gsrRaw: 999.5 }));

  assert.strictEqual(packets.length, 1);
  assert.strictEqual(packets[0].timestamp, 4.2);
  closeTo(packets[0].lat, 51.5074, 1e-6);
  closeTo(packets[0].lon, -0.1278, 1e-6);
  closeTo(packets[0].gsrRaw, 999.5, 1e-3);
  assert.strictEqual(packets[0].valid, true);
});

test('valid=0 maps lat/lon to NaN (no GPS fix this sample) but still emits GSR fields', () => {
  const { parser, packets } = collectPackets();
  parser.append(buildPacket({ valid: 0, gsrRaw: 500.0 }));

  assert.strictEqual(packets.length, 1);
  assert.ok(Number.isNaN(packets[0].lat));
  assert.ok(Number.isNaN(packets[0].lon));
  assert.strictEqual(packets[0].valid, false);
  closeTo(packets[0].gsrRaw, 500.0, 1e-3);
});

test('parses multiple packets delivered in a single append() call', () => {
  const { parser, packets } = collectPackets();
  const a = buildPacket({ timestampMs: 100, gsrRaw: 1 });
  const b = buildPacket({ timestampMs: 200, gsrRaw: 2 });
  const c = buildPacket({ timestampMs: 300, gsrRaw: 3 });
  const combined = new Uint8Array(a.length + b.length + c.length);
  combined.set(a, 0);
  combined.set(b, a.length);
  combined.set(c, a.length + b.length);

  parser.append(combined);

  assert.strictEqual(packets.length, 3);
  assert.deepStrictEqual(packets.map((p) => p.timestamp), [0.1, 0.2, 0.3]);
});

test('reassembles a packet split across two append() calls (transport fragmentation)', () => {
  const { parser, packets } = collectPackets();
  const pkt = buildPacket({ timestampMs: 5000, gsrRaw: 42.0 });

  parser.append(pkt.subarray(0, 20)); // first ~half arrives...
  assert.strictEqual(packets.length, 0, 'must not emit on a partial packet');
  parser.append(pkt.subarray(20)); // ...rest arrives in the next notification

  assert.strictEqual(packets.length, 1);
  assert.strictEqual(packets[0].timestamp, 5);
  closeTo(packets[0].gsrRaw, 42.0, 1e-3);
});

test('resyncs past garbage bytes preceding a valid packet', () => {
  const { parser, packets } = collectPackets();
  const garbage = new Uint8Array([0x00, 0xff, 0x13, 0x37, 0x99]);
  const pkt = buildPacket({ timestampMs: 777, gsrRaw: 7 });
  const combined = new Uint8Array(garbage.length + pkt.length);
  combined.set(garbage, 0);
  combined.set(pkt, garbage.length);

  parser.append(combined);

  assert.strictEqual(packets.length, 1);
  assert.strictEqual(packets[0].timestamp, 0.777);
});

test('resyncs even when the magic byte pair itself is split across two append() calls', () => {
  const { parser, packets } = collectPackets();
  const pkt = buildPacket({ timestampMs: 999, gsrRaw: 9 });
  // Deliver a lone 0x42 (first magic byte) as the tail of one notification...
  parser.append(new Uint8Array([0x00, 0x00, 0x42]));
  assert.strictEqual(packets.length, 0);
  // ...then the rest of the packet, starting with the second magic byte.
  parser.append(pkt.subarray(1));

  assert.strictEqual(packets.length, 1);
  assert.strictEqual(packets[0].timestamp, 0.999);
});

test('sustained non-matching noise never grows the held buffer past one packet worth of bytes', () => {
  const { parser, packets } = collectPackets();
  for (let i = 0; i < 500; i++) {
    parser.append(new Uint8Array([0x00, 0x01, 0x02]));
  }
  assert.strictEqual(packets.length, 0);
  // _processQueue only resyncs/discards once buffer.length >= PACKET_SIZE, so
  // up to PACKET_SIZE-1 bytes of noise can sit held between two append()
  // calls — this asserts that ceiling holds, not that it hits zero.
  assert.ok(
    parser.buffer.length < PACKET_SIZE,
    `buffer should stay below one packet's worth of held bytes, got ${parser.buffer.length}`,
  );
});

test('recovers cleanly and parses the next packet after a run of pure noise with no valid packet in it', () => {
  const { parser, packets } = collectPackets();
  const noise = new Uint8Array(200);
  noise.fill(0x55); // never matches the magic pair
  const pkt = buildPacket({ timestampMs: 1234, gsrRaw: 12 });

  parser.append(noise);
  parser.append(pkt);

  assert.strictEqual(packets.length, 1);
  assert.strictEqual(packets[0].timestamp, 1.234);
});
