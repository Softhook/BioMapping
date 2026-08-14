#pragma once

// BLE Stream — Live Stream mode's BLE serial transport
// (docs/bluetooth_serial_investigation.md §3/§4).
//
// Claims Flipper's stock BLE serial profile for the duration of one Live
// Stream session (bt_stream_start()/bt_stream_stop(), each called exactly
// once per session — both restart the BLE co-processor's second core, per
// the SDK's own comment on bt_profile_start()) and sends pre-packed binary
// updates over it at the caller's own pace via bt_stream_tx_batch().
//
// Runs entirely on the caller's thread — no dedicated BLE thread (§4: this
// codebase already found a background thread doesn't insulate the main
// thread from a blocking hardware call on the Flipper's single-core app
// CPU, via the sd_logger SD-write experiment). ble_profile_serial_tx()'s
// worst-case latency is unmeasured; that's real hardware's job to answer
// (§10 Phase 3), not this module's.
//
// Thread safety: bt_set_status_changed_callback()'s callback almost
// certainly runs on the BLE stack's own thread (§1.3), not the caller's —
// bt_stream_is_connected()/bt_stream_get_status() read an _Atomic cache
// rather than trusting single-threaded access, the same pattern this
// codebase already uses for GsrSensor's cross-thread flags
// (modules/gsr_sensor.c's running/rf_enabled/rf_spi_busy).

#include <bt/bt_service/bt.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct BtStream BtStream;

// Backed by a static singleton, not a per-call heap allocation, despite
// the malloc-shaped API (see bt_stream.c's bt_stream_free() for the real-
// hardware crash investigation that motivated this) — only one instance
// can be in use at a time. furi_check()-aborts if called again before the
// previous instance's bt_stream_free(). This isn't a new restriction in
// practice: only one Live Stream session can ever be active at once.
BtStream* bt_stream_alloc(void);
void      bt_stream_free(BtStream* bs);

// Claims RECORD_BT, registers the connection-status callback, and starts
// the stock serial profile. Returns false if the profile failed to start
// (§1.7 — Bluetooth off at the system level, radio already claimed by
// another service, ...); the caller must show an explicit "Bluetooth
// unavailable" screen in that case, not proceed as if streaming is active.
// RECORD_BT stays open even on failure — bt_stream_stop() is still the
// only place that releases it, so it's always safe (and required) to call
// bt_stream_stop() after this regardless of its return value.
bool bt_stream_start(BtStream* bs);

// Restores the default profile and releases RECORD_BT. Idempotent and safe
// to call even if bt_stream_start() was never called or failed — call this
// on EVERY session exit path (normal stop, error, back button).
void bt_stream_stop(BtStream* bs);

bool     bt_stream_is_connected(const BtStream* bs);
BtStatus bt_stream_get_status(const BtStream* bs);

// Sends one pre-packed update. Internally treats "not connected" and "the
// send itself failed" (§1.2 — ble_profile_serial_tx() returns bool; the
// BLE stack likely queues one outstanding send at a time and can reject a
// new one before the previous completes) identically: both count against
// bt_stream_get_drop_count() and neither is retried synchronously here —
// the caller's next interval is the retry, per §1.2/§1.10's "disconnects
// and drops are routine, not exceptional" design.
bool bt_stream_tx_batch(BtStream* bs, const uint8_t* data, size_t len);

// Cumulative count of intervals nothing was sent on (not connected, or the
// send failed) — the Flipper's own on-screen "Dropped: N" readout during a
// Live Stream session reads this directly.
uint32_t bt_stream_get_drop_count(const BtStream* bs);

// Worst single ble_profile_serial_tx() call ever seen (real furi_get_tick()
// delta, ms) — lifetime max, same pattern as sd_logger.h's flush_peak_ms
// and gsr_sensor.h's i2c_peak_ms/rf_rssi_peak_ms/rf_retune_peak_ms.
uint32_t bt_stream_get_tx_peak_ms(const BtStream* bs);
