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
 * Reconnect resilience — three independent, individually feature-detected
 * layers, each degrading to today's plain-backoff behaviour where the
 * platform lacks the underlying API (notably iOS/Bluefy for both):
 *   1. _waitBeforeRetry() — during the bounded backoff loop, wakes early via
 *      watchAdvertisements()'s 'advertisementreceived' the instant the
 *      device is detected back in range, instead of blindly waiting out the
 *      scheduled delay.
 *   2. _startBackgroundWatch() — once the bounded loop exhausts, keeps a
 *      passive (no active connection) advertisement watch armed so the
 *      device reappearing later still triggers an automatic reconnect
 *      without the user having to notice and click Reconnect.
 *   3. tryResumeDevice() — lets attemptConnect()'s "New Connection" silently
 *      reacquire the SAME previously-permitted device via
 *      navigator.bluetooth.getDevices(), skipping the requestDevice()
 *      chooser dialog entirely when the platform still remembers it.
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

// None of BluetoothRemoteGATTServer.connect() / getPrimaryService() /
// getCharacteristic() / startNotifications() carries a built-in timeout, and
// on Android Chrome in particular any of them has been observed to hang
// indefinitely (far past any reasonable time) rather than reject when the
// peripheral isn't actually reachable or its GATT cache is stale — e.g.
// right after the Flipper's BLE co-processor restart on Live Stream
// stop/start (see _handleDisconnect()'s doc comment). Without a cap, one
// hung step blocks the whole retry loop forever, which reads to the user as
// "reconnect just hangs" — and because nothing ever calls gatt.disconnect()
// to cancel it, the adapter/peripheral can stay wedged in a way that also
// hides the device from a fresh requestDevice() chooser.
// BLE_SUBSCRIBE_TIMEOUT_MS bounds the ENTIRE connect-through-startNotifications
// pipeline as one attempt (not just the initial connect) so the retry loop
// always completes regardless of which step gets stuck. 15s gives headroom
// for a working attempt's connect + service/characteristic discovery to
// finish (a few seconds is typical) while still bounding a hang.
const BLE_SUBSCRIBE_TIMEOUT_MS = 15000;

class GSRLiveBluetoothManager {
  constructor(onStatusText, options = {}) {
    this.device = null;
    this.characteristic = null;
    this.onStatusText = onStatusText || (() => {});
    this.onStatusChange = (options && options.onStatusChange) || ((status) => LiveState.setStatus(status));
    this.onPacket = (options && options.onPacket) || ((pkt) => LiveState.addPacket(pkt));
    this.parser = new GSRLiveBinaryParser((pkt) => this.onPacket(pkt));
    this._reconnecting = false;
    // Set by disconnect() just before it tears the GATT link down on purpose
    // (e.g. the user leaving the Live view), so the 'gattserverdisconnected'
    // event that fires as a result doesn't kick off _handleDisconnect()'s
    // auto-reconnect backoff. Cleared again on the next successful _subscribe()
    // so a later genuine link drop still recovers on its own.
    this._intentionalClose = false;
    // Set by abandon() when the caller (attemptConnect()'s "New Connection")
    // replaces this manager with a fresh one while this one may still have a
    // reconnect loop in flight (mid-backoff wait, or blocked inside
    // _subscribe()'s own timeout race). LiveState is a module-level singleton
    // shared by every manager instance, so without this flag that orphaned
    // loop finishing later — success or exhaustion alike — would still call
    // LiveState.setStatus() and stomp whatever the NEW manager already set.
    // Checked at every status-mutating point via _setStatus()/the loop guard
    // below, never by skipping the underlying BLE calls themselves — this
    // manager still cleanly gives up regardless of whether it's superseded.
    this._abandoned = false;
    // AbortController for the post-exhaustion passive advertisement watch
    // (_startBackgroundWatch()/_stopBackgroundWatch()) — non-null only while
    // one is armed.
    this._bgWatchController = null;
    this._onBgAdvertisement = null;
    // Bound once so _subscribe() can removeEventListener the previous
    // subscription before re-adding on a reconnect (see there).
    this._onCharValue = (e) => this.parser.append(new Uint8Array(e.target.value.buffer));
    // Bound once so connect() / tryResumeDevice() / disconnect() don't stack
    // duplicate 'gattserverdisconnected' listeners.
    this._onDisconnected = () => this._handleDisconnect();
    this._retryWaitController = null;
    this._retryWaitResolve = null;
    // Bumped at the top of every _subscribe() call. tryResumeDevice()'s own
    // outer timeout can lose the race to _subscribe()'s inner one and return
    // control to the caller while that _subscribe() call is still running in
    // the background (see _subscribe()'s catch below) — this lets that call
    // tell, once its own timeout does fire, whether a NEWER attempt has since
    // started on this same instance (connect()'s fallback, manualReconnect(),
    // or a fresh _handleDisconnect() attempt all run on the SAME manager).
    this._attemptToken = 0;
  }

  // LiveState.setStatus() gated on _abandoned — see the constructor comment.
  // Also the single place that retires a background watch on success,
  // regardless of which of connect()/_handleDisconnect()/manualReconnect()
  // reached it.
  _setStatus(status) {
    if (this._abandoned) return;
    if (status === 'connected') this._stopBackgroundWatch();
    this.onStatusChange(status);
  }

  // Called by the caller right before replacing this instance with a new
  // GSRLiveBluetoothManager (a fresh "New Connection"). Marks this instance
  // as superseded (so any in-flight loop's eventual status update is a
  // no-op), wakes any in-flight backoff wait immediately, and tears
  // down/cancels its own GATT link so it isn't left competing with the new
  // connection attempt for the radio.
  abandon() {
    this._abandoned = true;
    this._userDisconnected = true;
    this._intentionalClose = true;
    this._reconnecting = false;
    this._stopBackgroundWatch();
    if (this._retryWaitController) {
      this._retryWaitController.abort();
      this._retryWaitController = null;
    }
    if (typeof this._retryWaitResolve === 'function') {
      this._retryWaitResolve();
      this._retryWaitResolve = null;
    }
    // Unlike disconnect() (also used for a temporary, same-instance pause
    // that manualReconnect() later resumes on the SAME device+listener),
    // this instance is being permanently retired — so this is the one place
    // that must also drop its 'gattserverdisconnected' listener. Otherwise,
    // since getDevices() typically hands back the identical BluetoothDevice
    // across a session, each "New Connection" cycle would leave one more
    // listener permanently attached to it.
    if (this.device) {
      this.device.removeEventListener('gattserverdisconnected', this._onDisconnected);
    }
    this.disconnect();
  }

  // Show every nearby BLE device instead of filtering by namePrefix:'Flipper'
  // (§1.4 — the advertised name follows the Flipper's configured device name,
  // which a user can change in Settings > System > Device Name; using
  // acceptAllDevices: true allows connecting to a renamed Flipper Zero).
  async connect() {
    this._userDisconnected = false;
    this.device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: [BLE_SERVICE_UUID]
    });
    this.device.addEventListener('gattserverdisconnected', this._onDisconnected);
    await this._subscribe();
    this._setStatus('connected');
  }

  // Races the whole connect-through-startNotifications pipeline against
  // BLE_SUBSCRIBE_TIMEOUT_MS. On timeout (or any other failure), cancels the
  // GATT link via gatt.disconnect() — this is the only cancellation handle
  // Web Bluetooth exposes; there's no way to abort getPrimaryService() or
  // getCharacteristic() individually, but tearing down the connection they're
  // running on stops them too — before rejecting, so the caller's retry loop
  // moves on with the radio actually free again rather than leaving a stuck
  // step running in the background indefinitely.
  async _subscribe() {
    // Captured up front: tryResumeDevice()'s own outer timeout (3500ms) can
    // fire before this call's timeout below (15s) does, returning control to
    // its caller — connect()'s fallback requestDevice() — while this call
    // keeps running in the background against whatever `this.device` was at
    // the time. If THAT device is reassigned (or a newer _subscribe() call
    // starts) before this one's own timeout finally fires, `this.device` no
    // longer means what it did when this attempt began.
    const device = this.device;
    const token = ++this._attemptToken;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('BLE subscribe timed out')), BLE_SUBSCRIBE_TIMEOUT_MS);
    });
    try {
      await Promise.race([this._doSubscribe(), timeout]);
    } catch (e) {
      // gatt.disconnect() fires its own 'gattserverdisconnected' event (real
      // Web Bluetooth does this for a cancelled in-flight connect, same as
      // this file's fake does in tests). Whoever called _subscribe() — the
      // initial connect(), manualReconnect(), or _handleDisconnect()'s own
      // loop — is already the one deciding what happens next; without this
      // flag that synthetic event would also independently kick off
      // _handleDisconnect()'s auto-reconnect loop, racing the caller's own
      // handling of this same failure.
      //
      // But only when THIS is still the current attempt (token match): if a
      // newer _subscribe() call has since started on this same instance, it
      // owns _intentionalClose now, and stomping it here would mislabel that
      // newer attempt's own eventual disconnect as intentional, silently
      // swallowing the auto-reconnect it should trigger.
      const isCurrent = token === this._attemptToken;
      if (isCurrent) this._intentionalClose = true;
      // Same reasoning for the disconnect() call itself: cancelling `device`
      // is right when it's genuinely this attempt's own stuck connection —
      // either it's still the current attempt, or `this.device` has since
      // moved on to a different device object, so `device` here is stale and
      // safe to free. But when it's BOTH superseded AND still the same
      // device object (Web Bluetooth commonly hands back the identical
      // BluetoothDevice for the same peripheral across calls), a newer
      // attempt may already be relying on that live link — disconnecting it
      // here would silently kill a working connection nobody asked to close.
      if (isCurrent || device !== this.device) {
        try { device.gatt.disconnect(); } catch (e2) { /* nothing to cancel */ }
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  async _doSubscribe() {
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
    this._userDisconnected = true;
    this._intentionalClose = true;
    this._reconnecting = false;
    this._setStatus('disconnected');
    this._stopBackgroundWatch();
    if (this._retryWaitController) {
      this._retryWaitController.abort();
      this._retryWaitController = null;
    }
    if (typeof this._retryWaitResolve === 'function') {
      this._retryWaitResolve();
      this._retryWaitResolve = null;
    }
    try {
      if (this.characteristic) {
        this.characteristic.removeEventListener('characteristicvaluechanged', this._onCharValue);
      }
      // Call disconnect() unconditionally rather than gating on gatt.connected
      // — a reconnect attempt in flight (mid-_subscribe(), before its own
      // timeout race settles) hasn't set that flag yet, but there's still a
      // pending native connect to cancel. Leaving it running is what
      // previously left the adapter/peripheral wedged after the user
      // navigated away mid-reconnect.
      if (this.device && this.device.gatt) {
        this.device.gatt.disconnect();
      }
    } catch (e) {
      /* link already down — nothing to close */
    }
  }

  // Waits up to delayMs before the next reconnect attempt, but wakes early
  // if the device is detected advertising again — watchAdvertisements() is
  // Web Bluetooth's passive "is it back yet?" signal, no active GATT
  // connection required, so arming it costs nothing extra over the plain
  // timed wait it replaces. This is what turns "wait up to 8s on a blind
  // guess" into "reconnect within a beat of the device actually being back
  // in range" on platforms that support it (falls back to the plain timed
  // wait everywhere else — the API isn't universal, notably unavailable on
  // iOS/Bluefy).
  async _waitBeforeRetry(delayMs) {
    if (this._abandoned || this._userDisconnected) return;
    if (!this.device || typeof this.device.watchAdvertisements !== 'function') {
      await new Promise((resolve) => {
        let timer = setTimeout(resolve, delayMs);
        this._retryWaitResolve = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this._retryWaitResolve = null;
      return;
    }
    await new Promise((resolve) => {
      this._retryWaitController = new AbortController();
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        if (this.device) {
          this.device.removeEventListener('advertisementreceived', onAdvertisement);
        }
        if (this._retryWaitController) {
          this._retryWaitController.abort();
          this._retryWaitController = null;
        }
        resolve();
      };
      const onAdvertisement = () => cleanup();
      this._retryWaitController.signal.addEventListener('abort', cleanup);
      timer = setTimeout(cleanup, delayMs);
      this.device.addEventListener('advertisementreceived', onAdvertisement);
      // Swallow failure silently — the timer above still bounds the wait
      // even if watchAdvertisements() itself rejects (e.g. denied, or the
      // method exists but isn't actually functional on this device/OS).
      try {
        this.device.watchAdvertisements({ signal: this._retryWaitController.signal }).catch(() => {});
      } catch (e) {
        /* ignore synchronous throw if Bluetooth is unpermitted/disabled */
      }
    });
  }

  // After the bounded auto-reconnect loop exhausts, most drops caused by a
  // transient signal loss (phone in a pocket, brief range hop) are still
  // recoverable — the device just isn't advertising *yet*. Rather than
  // requiring the user to notice "Disconnected" and click Reconnect, keep a
  // passive watch armed (cheap: no active connection attempt, just
  // listening) and auto-retry the moment the device is actually detected
  // again. This is NOT another unbounded retry loop — it's a single dormant
  // listener that reacts at most once per detected reappearance (re-armed
  // only if that one attempt fails), so it can't reintroduce the
  // unbounded-retry hazard _handleDisconnect()'s attempt cap exists to
  // avoid (§1.10/§8).
  _startBackgroundWatch() {
    if (this._bgWatchController || this._abandoned || this._userDisconnected) return;
    if (!this.device || typeof this.device.watchAdvertisements !== 'function') return;
    this._bgWatchController = new AbortController();
    this._onBgAdvertisement = () => this._tryBackgroundReconnect();
    this.device.addEventListener('advertisementreceived', this._onBgAdvertisement);
    try {
      this.device.watchAdvertisements({ signal: this._bgWatchController.signal }).catch(() => {
        this._stopBackgroundWatch();
      });
    } catch (e) {
      this._stopBackgroundWatch();
    }
  }

  _stopBackgroundWatch() {
    if (this._bgWatchController) {
      this._bgWatchController.abort();
      this._bgWatchController = null;
    }
    if (this.device && this._onBgAdvertisement) {
      this.device.removeEventListener('advertisementreceived', this._onBgAdvertisement);
    }
    this._onBgAdvertisement = null;
  }

  async _tryBackgroundReconnect() {
    if (this._reconnecting || this._abandoned || this._userDisconnected) return;
    this._stopBackgroundWatch(); // one-shot; re-armed below if this attempt fails
    const ok = await this.manualReconnect();
    if (!ok && !this._abandoned && !this._userDisconnected) this._startBackgroundWatch();
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
    // A fresh drop always supersedes any dormant post-exhaustion watch from
    // a previous one (e.g. a brief reconnect that dropped again quickly) —
    // this loop is about to arm its own per-attempt waits instead.
    this._stopBackgroundWatch();
    // disconnect() closed the link on purpose — don't fight it with a
    // reconnect loop. Re-arm for the next real drop.
    if (this._intentionalClose || this._userDisconnected || this._abandoned) {
      this._intentionalClose = false;
      return;
    }
    if (this._reconnecting) return;
    this._reconnecting = true;
    this._setStatus('reconnecting');
    let lastError = null;
    for (let attempt = 0, delay = 500; attempt < 6; attempt++, delay = Math.min(delay * 2, 8000)) {
      // Superseded by a "New Connection" or intentional disconnect mid-loop — stop spending
      // attempts (and radio time the new connection could use) on a manager nobody
      // is looking at anymore.
      if (this._abandoned) {
        this._reconnecting = false;
        return;
      }
      if (this._userDisconnected) {
        this._reconnecting = false;
        this._setStatus('disconnected');
        return;
      }
      await this._waitBeforeRetry(delay);
      if (this._abandoned) {
        this._reconnecting = false;
        return;
      }
      if (this._userDisconnected) {
        this._reconnecting = false;
        this._setStatus('disconnected');
        return;
      }
      try {
        await this._subscribe();
        this._setStatus('connected');
        this._reconnecting = false;
        return;
      } catch (e) {
        if (this._abandoned) {
          this._reconnecting = false;
          return;
        }
        if (this._userDisconnected) {
          this._reconnecting = false;
          this._setStatus('disconnected');
          return;
        }
        lastError = e; // keep retrying within the cap
      }
    }
    this._reconnecting = false;
    this._setStatus('disconnected');
    const msg = (lastError && lastError.message) ? lastError.message : String(lastError);
    console.error('Live: auto-reconnect exhausted —', lastError);
    this.onStatusText(`Auto-reconnect failed: ${msg}`);
    if (!this._abandoned && !this._userDisconnected) {
      this._startBackgroundWatch();
    }
  }

  // Returns true on success, false on failure (never throws) — used both by
  // the Reconnect button (which ignores the return value) and by
  // _tryBackgroundReconnect(), which needs it to decide whether to re-arm
  // the passive watch.
  async manualReconnect() {
    if (!this.device || this._reconnecting) return false;
    this._userDisconnected = false;
    // Shares _handleDisconnect()'s lock: a timed-out _subscribe() here cancels
    // the pending GATT link via gatt.disconnect(), which some implementations
    // surface as a 'gattserverdisconnected' event — without this flag set,
    // that would fire a concurrent auto-reconnect loop racing this same attempt.
    this._reconnecting = true;
    this._setStatus('reconnecting');
    try {
      await this._subscribe();
      this._setStatus('connected');
      return true;
    } catch (e) {
      this._setStatus('disconnected');
      const msg = (e && e.message) ? e.message : String(e);
      console.error('Live: manual reconnect failed —', e);
      this.onStatusText(`Reconnect failed: ${msg}`);
      return false;
    } finally {
      this._reconnecting = false;
    }
  }

  // Best-effort silent resume of a SPECIFIC previously-permitted device,
  // bypassing requestDevice()'s chooser dialog entirely. The caller passes
  // the device it was just talking to (e.g. the superseded manager's
  // `.device` right before a "New Connection"). Only works where
  // navigator.bluetooth.getDevices() is supported (persisted Web Bluetooth
  // permissions — not universal; e.g. unavailable on iOS/Bluefy) and only
  // for a device this origin still holds a live permission grant for.
  // Returns false (never throws) on any failure so the caller falls through
  // to the normal requestDevice() chooser — a stale/broken bond behind the
  // same permission grant is exactly as likely to fail here as it would via
  // today's "New Connection", so this is pure upside: it only removes a
  // redundant manual re-pick, never blocks the existing fallback.
  // Capped at 3500ms so a dead device doesn't exhaust the browser's ~5s
  // transient user gesture before falling back to requestDevice().
  async tryResumeDevice(candidateDevice) {
    if (!candidateDevice || !navigator.bluetooth || typeof navigator.bluetooth.getDevices !== 'function') {
      return false;
    }
    let known;
    try {
      known = await navigator.bluetooth.getDevices();
    } catch (e) {
      return false;
    }
    const match = known.find((d) => d.id === candidateDevice.id);
    if (!match) return false;
    this._userDisconnected = false;
    this.device = match;
    this.device.addEventListener('gattserverdisconnected', this._onDisconnected);
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Resume attempt timed out')), 3500);
    });
    try {
      await Promise.race([this._subscribe(), timeout]);
      this._setStatus('connected');
      return true;
    } catch (e) {
      if (this.device) {
        this.device.removeEventListener('gattserverdisconnected', this._onDisconnected);
        try {
          if (this.device.gatt && typeof this.device.gatt.disconnect === 'function') {
            this.device.gatt.disconnect();
          }
        } catch (e2) {}
        this.device = null;
      }
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}

if (typeof window !== 'undefined') {
  window.GSRLiveBluetoothManager = GSRLiveBluetoothManager;
  window.BLE_SERVICE_UUID = BLE_SERVICE_UUID;
  window.BLE_RX_CHAR_UUID = BLE_RX_CHAR_UUID;
  window.BLE_SUBSCRIBE_TIMEOUT_MS = BLE_SUBSCRIBE_TIMEOUT_MS;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GSRLiveBluetoothManager, BLE_SERVICE_UUID, BLE_RX_CHAR_UUID, BLE_SUBSCRIBE_TIMEOUT_MS };
}
