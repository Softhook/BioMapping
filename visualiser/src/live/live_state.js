/**
 * LiveState — the live receiver's connection status + accumulated packet
 * buffer + a tiny listener/emit() bus, matching src/core/app_state.js's
 * shape (same pattern, not the same object — the live view has no
 * dependency on AppState).
 *
 * Pure: no DOM, no transport. GSRLiveBluetoothManager (src/live/
 * live_bluetooth.js) feeds it decoded packets via addPacket(); the view
 * layer subscribes with on('status'|'packet', …). Loaded as a classic
 * <script> by both live.html and (once integrated) index.html, and
 * require()-able from tests.
 */

const LiveState = {
  status: 'disconnected', // 'connecting' | 'connected' | 'reconnecting' | 'disconnected'
  packets: [],
  gapCount: 0,

  // docs/archive/bluetooth_serial_investigation.md §3's BT_STREAM_INTERVAL_MS
  // (biomap_types.h) — kept in sync manually; a real send-interval change
  // on the firmware side needs the same number updated here.
  STREAM_INTERVAL_S: 0.3,

  _listeners: {},
  on(event, fn) { (LiveState._listeners[event] = LiveState._listeners[event] || []).push(fn); },
  emit(event, ...args) { (LiveState._listeners[event] || []).forEach(fn => fn(...args)); },

  setStatus(status) {
    this.status = status;
    this.emit('status', status);
  },

  addPacket(pkt) {
    const prev = this.packets[this.packets.length - 1];
    // pkt.timestamp is device-uptime ms, not wall-clock — a new device (or
    // the same one power-cycled) restarts it near 0, so a plain ">" delta
    // check misses that case (negative delta never exceeds the threshold).
    // Treat any non-increasing timestamp as a gap too.
    pkt.gap = !!prev && (pkt.timestamp <= prev.timestamp || (pkt.timestamp - prev.timestamp) > 2 * this.STREAM_INTERVAL_S);
    if (pkt.gap) this.gapCount++;
    this.packets.push(pkt);
    this.emit('packet', pkt);
  },
};

if (typeof window !== 'undefined') window.LiveState = LiveState;
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { LiveState };
}
