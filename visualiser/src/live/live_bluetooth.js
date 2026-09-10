/**
 * GSRLiveBluetoothManager — Web Bluetooth transport for the live receiver
 * (docs/archive/bluetooth_serial_investigation.md §8). Owns the
 * BluetoothDevice / GATT characteristic, pipes notification bytes through
 * GSRLiveBinaryParser (src/live/live_binary_parser.js) into LiveState
 * (src/live/live_state.js), and runs a bounded auto-reconnect on
 * 'gattserverdisconnected'.
 *
 * No DOM. Surfaces human-readable failure text through the onStatusText
 * callback the caller passes in. Loaded as a classic <script> by live.html
 * (and, once integrated, index.html); require()-able from tests.
 *
 * SERVICE_UUID/RX_CHAR_UUID are UNVERIFIED against real hardware (§8's own
 * caveat) — Flipper's stock BLE serial service's GATT table isn't in the
 * public app SDK headers this project builds against (checked: no UUID
 * appears anywhere under ~/.ufbt/current/sdk_headers), so these can only be
 * confirmed by a live GATT scan against a real Flipper running Live Stream
 * mode. If getPrimaryService() fails with this UUID, _logDiscoveredServices()
 * enumerates whatever the connected device actually advertises so the real
 * UUID can be read off the console instead of guessed at again.
 */

const BLE_SERVICE_UUID = '8fe5b3d5-2e7f-4a98-2a48-7acc60fe0000';
const BLE_RX_CHAR_UUID = '19ed82ae-ed21-4c9d-4145-228e61fe0000'; // Flipper TX / host notify

class GSRLiveBluetoothManager {
  constructor(onStatusText) {
    this.device = null;
    this.characteristic = null;
    this.onStatusText = onStatusText || (() => {});
    this.parser = new GSRLiveBinaryParser((pkt) => LiveState.addPacket(pkt));
    this._reconnecting = false;
    // Set by disconnect() just before it tears the GATT link down on purpose
    // (e.g. the user leaving the Live view), so the 'gattserverdisconnected'
    // event that fires as a result doesn't kick off _handleDisconnect()'s
    // auto-reconnect backoff. Cleared again on the next successful _subscribe()
    // so a later genuine link drop still recovers on its own.
    this._intentionalClose = false;
    // Bound once so _subscribe() can removeEventListener the previous
    // subscription before re-adding on a reconnect (see there).
    this._onCharValue = (e) => this.parser.append(new Uint8Array(e.target.value.buffer));
  }

  // Show every nearby BLE device instead of filtering by namePrefix:'Flipper'
  // (§1.4 — the advertised name follows the Flipper's configured device name,
  // which a user can change in Settings > System > Device Name; using
  // acceptAllDevices: true allows connecting to a renamed Flipper Zero).
  async connect() {
    this.device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: [BLE_SERVICE_UUID]
    });
    this.device.addEventListener('gattserverdisconnected', () => this._handleDisconnect());
    await this._subscribe();
    LiveState.setStatus('connected');
  }

  async _subscribe() {
    const server = await this.device.gatt.connect();
    let service;
    try {
      service = await server.getPrimaryService(BLE_SERVICE_UUID);
    } catch (e) {
      await this._logDiscoveredServices(server);
      throw e;
    }
    // Drop the listener from whatever we were subscribed to before re-adding
    // it. On a reconnect getCharacteristic() hands back the SAME object, so
    // without this each reconnect would stack another live listener and every
    // notification would be parsed once per listener — duplicate packets, and
    // (identical timestamp) bogus gaps. this._onCharValue is bound once in the
    // constructor precisely so this remove/add pair can match.
    if (this.characteristic) {
      this.characteristic.removeEventListener('characteristicvaluechanged', this._onCharValue);
    }
    this.characteristic = await service.getCharacteristic(BLE_RX_CHAR_UUID);
    this.characteristic.addEventListener('characteristicvaluechanged', this._onCharValue);
    await this.characteristic.startNotifications();
    // A live link again — arm auto-reconnect for the next unexpected drop.
    this._intentionalClose = false;
  }

  // Deliberate teardown — the user navigated away from the Live view. Drops
  // the notification listener and closes the GATT link, but keeps the
  // BluetoothDevice reference so manualReconnect() can resume the SAME
  // session (its packet buffer, drawn track and Export button are untouched
  // by this). _intentionalClose suppresses the auto-reconnect that the
  // resulting 'gattserverdisconnected' event would otherwise trigger.
  disconnect() {
    this._intentionalClose = true;
    try {
      if (this.characteristic) {
        this.characteristic.removeEventListener('characteristicvaluechanged', this._onCharValue);
      }
      if (this.device && this.device.gatt && this.device.gatt.connected) {
        this.device.gatt.disconnect();
      }
    } catch (e) {
      /* link already down — nothing to close */
    }
  }

  // Best-effort discovery aid — not a functional fallback (a specific
  // characteristic is still required to subscribe), just surfaces what the
  // real hardware actually advertises so BLE_SERVICE_UUID above can be
  // corrected without a separate BLE inspector tool.
  async _logDiscoveredServices(server) {
    try {
      const services = await server.getPrimaryServices();
      const uuids = services.map(s => s.uuid);
      console.warn('Live: expected service UUID not found. Discovered:', uuids);
      this.onStatusText('Service UUID mismatch — see console for discovered UUIDs');
    } catch (e2) {
      console.warn('Live: service discovery also failed', e2);
    }
  }

  // Bounded exponential backoff, capped attempts — §1.10/§8: unbounded
  // retry loops are a documented way to make requestDevice() itself stop
  // responding afterward, so this must give up and fall back to a manual
  // Reconnect button rather than retrying forever.
  //
  // This whole path assumes the SAME BLE peripheral session is still
  // reachable (device.gatt.connect() on the cached BluetoothDevice) — the
  // right model for a transient link drop (phone walks out of range). It
  // is NOT the right model for the Flipper exiting and re-entering Live
  // Stream mode: bt_stream_stop()/bt_stream_start() call
  // bt_profile_restore_default()/bt_profile_start(), which the SDK's own
  // doc comment says restarts the BLE co-processor's second core — a much
  // bigger discontinuity than a link drop, and (per the stale-bond issue
  // hit earlier the same session) plausibly enough to invalidate the
  // cached device/bond. When every attempt here fails, onStatusText
  // surfaces the real error so that's distinguishable from "still out of
  // range" — and the caller (wire-up code) offers "New Connection" (a
  // fresh requestDevice()) as the real fix for that case, not more
  // retries against a reference that may no longer be usable.
  async _handleDisconnect() {
    // disconnect() closed the link on purpose — don't fight it with a
    // reconnect loop. Re-arm for the next real drop.
    if (this._intentionalClose) {
      this._intentionalClose = false;
      return;
    }
    if (this._reconnecting) return;
    this._reconnecting = true;
    LiveState.setStatus('reconnecting');
    let lastError = null;
    for (let attempt = 0, delay = 500; attempt < 6; attempt++, delay = Math.min(delay * 2, 8000)) {
      await new Promise(r => setTimeout(r, delay));
      try {
        await this._subscribe();
        LiveState.setStatus('connected');
        this._reconnecting = false;
        return;
      } catch (e) {
        lastError = e; // keep retrying within the cap
      }
    }
    this._reconnecting = false;
    LiveState.setStatus('disconnected');
    const msg = (lastError && lastError.message) ? lastError.message : String(lastError);
    console.error('Live: auto-reconnect exhausted —', lastError);
    this.onStatusText(`Auto-reconnect failed: ${msg}`);
  }

  async manualReconnect() {
    if (!this.device) return;
    LiveState.setStatus('reconnecting');
    try {
      await this._subscribe();
      LiveState.setStatus('connected');
    } catch (e) {
      LiveState.setStatus('disconnected');
      const msg = (e && e.message) ? e.message : String(e);
      console.error('Live: manual reconnect failed —', e);
      this.onStatusText(`Reconnect failed: ${msg}`);
    }
  }
}

if (typeof window !== 'undefined') {
  window.GSRLiveBluetoothManager = GSRLiveBluetoothManager;
  window.BLE_SERVICE_UUID = BLE_SERVICE_UUID;
  window.BLE_RX_CHAR_UUID = BLE_RX_CHAR_UUID;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GSRLiveBluetoothManager, BLE_SERVICE_UUID, BLE_RX_CHAR_UUID };
}
