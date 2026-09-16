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

// Trailing seconds of the analysed buffer whose tonic/phasic/peaks are still
// provisional — decomposeTonicPhasic is zero-phase and has a ±6s look-ahead
// local-floor pass, so the newest samples haven't settled. Matches
// PHASIC_COLOR_LAG_S. Peak / hotspot markers are not drawn inside this tail.
// Lives here (rather than live_view.mjs, its logical "owner") so live_graph.mjs
// and live_map.mjs — both of which need it — can read it from a leaf module
// instead of importing live_view.mjs directly, which would reintroduce the
// mutual-import cycle the Controllers registry (core/controllers.mjs) breaks
// for the rest of the live_view.mjs/live_graph.mjs/live_map.mjs relationship.
export const LIVE_SETTLE_TAIL_S = 8;

export const LiveState = {
  status: 'disconnected', // 'connecting' | 'connected' | 'reconnecting' | 'disconnected'
  packets: [],
  gapCount: 0,

  // docs/archive/bluetooth_serial_investigation.md §3's BT_STREAM_INTERVAL_MS
  // (biomap_types.h) — kept in sync manually; a real send-interval change
  // on the firmware side needs the same number updated here.
  STREAM_INTERVAL_S: 0.3,

  _listeners: {},
  on(event, fn) {
    LiveState._listeners[event] ??= [];
    LiveState._listeners[event].push(fn);
  },
  emit(event, ...args) {
    (LiveState._listeners[event] || []).forEach((fn) => {
      fn(...args);
    });
  },

  setStatus(status) {
    this.status = status;
    this.emit('status', status);
  },

  reset() {
    this.packets = [];
    this.gapCount = 0;
    this.emit('reset');
  },

  addPacket(pkt) {
    const prev = this.packets[this.packets.length - 1];
    // pkt.timestamp is device-uptime ms, not wall-clock — a new device (or
    // the same one power-cycled) restarts it near 0, so a plain ">" delta
    // check misses that case (negative delta never exceeds the threshold).
    // Treat any non-increasing timestamp as a gap too.
    pkt.gap =
      !!prev &&
      (pkt.timestamp <= prev.timestamp ||
        pkt.timestamp - prev.timestamp > 2 * this.STREAM_INTERVAL_S);
    if (pkt.gap) this.gapCount++;
    this.packets.push(pkt);
    this.emit('packet', pkt);
  },
};
