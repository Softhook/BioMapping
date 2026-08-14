// BLE Stream — see bt_stream.h for the design rationale.
#include "bt_stream.h"

#include <furi.h>
#include <profiles/serial_profile.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>

struct BtStream {
    Bt* bt;
    FuriHalBleProfileBase* profile;
    _Atomic(BtStatus) status;
    uint32_t drop_count;
    uint32_t tx_peak_ms;
};

// bt_set_status_changed_callback()'s callback almost certainly runs on the
// BLE stack's own thread (§1.3) — never touch anything but the atomic here.
static void bt_stream_status_cb(BtStatus status, void* context) {
    BtStream* bs = context;
    atomic_store(&bs->status, status);
}

// Deliberate static singleton, NOT a per-call malloc/free like every other
// module (GpsUart, GsrSensor, SdLogger) — see bt_stream_free()'s comment
// below for why. bt_stream_alloc()/_free() keep the same alloc-shaped API
// those modules use so call sites (biomap_session.c) don't need to know
// the difference; only one Live Stream session can ever be active at a
// time anyway (BioMapMode is exclusive), so the "one instance" constraint
// this enforces isn't a new restriction, just a now-checked one.
static BtStream g_bt_stream;
static bool g_bt_stream_in_use = false;

BtStream* bt_stream_alloc(void) {
    furi_check(!g_bt_stream_in_use, "BtStream: already allocated");
    BtStream* bs = &g_bt_stream;
    bs->bt = NULL;
    bs->profile = NULL;
    atomic_store(&bs->status, BtStatusUnavailable);
    bs->drop_count = 0;
    bs->tx_peak_ms = 0;
    g_bt_stream_in_use = true;
    return bs;
}

// Deliberately does NOT free anything — see the static singleton above.
//
// Real-hardware crash investigation (2026-08-14): bt_profile_restore_default()
// "restarts the BLE co-processor's second core" per the SDK's own doc
// comment on bt_profile_start() — an inherently asynchronous hardware
// event, with no documented way to synchronously wait for it to fully
// settle (unlike GpsUart/GsrSensor's worker threads, which this codebase's
// other modules safely tear down via furi_thread_join() before freeing —
// there's no equivalent join here). That leaves a real window where
// bt_stream_status_cb() could still be invoked by the BLE stack's own
// thread, with the OLD context pointer, after a heap-allocated BtStream
// had already been freed — a genuine use-after-free write, and the most
// plausible explanation for a bus-fault crash observed on real hardware
// while backing out of and re-entering Live Stream mode. bt_stream_stop()
// below also explicitly asks the BLE stack to stop calling back before
// tearing down, but that's best-effort (unverified whether it's honored
// synchronously) — this static allocation is what actually guarantees
// safety: a stray late callback can only write a stale status value into
// still-valid memory, never into memory that's been freed and reused.
void bt_stream_free(BtStream* bs) {
    furi_check(bs == &g_bt_stream, "BtStream: bt_stream_free() with unexpected pointer");
    g_bt_stream_in_use = false;
}

bool bt_stream_start(BtStream* bs) {
    furi_check(bs, "BtStream: NULL in start()");
    bs->bt = furi_record_open(RECORD_BT);
    bt_set_status_changed_callback(bs->bt, bt_stream_status_cb, bs);
    bs->profile = bt_profile_start(bs->bt, ble_profile_serial, NULL);
    if(!bs->profile) {
        FURI_LOG_W("BtStream", "bt_profile_start() returned NULL — Bluetooth unavailable");
        return false;
    }
    return true;
}

void bt_stream_stop(BtStream* bs) {
    furi_check(bs, "BtStream: NULL in stop()");
    if(bs->bt) {
        // Best-effort: ask the BLE stack to stop calling back before
        // tearing down further. See bt_stream_free()'s doc comment — the
        // static singleton backing this struct is what actually makes a
        // late callback safe, not this call, since it's unverified
        // whether it's honored synchronously (or at all).
        bt_set_status_changed_callback(bs->bt, NULL, NULL);
        if(!bt_profile_restore_default(bs->bt)) {
            FURI_LOG_E("BtStream", "bt_profile_restore_default() failed");
        }
        furi_record_close(RECORD_BT);
        bs->bt = NULL;
    }
    bs->profile = NULL;
    atomic_store(&bs->status, BtStatusUnavailable);
}

BtStatus bt_stream_get_status(const BtStream* bs) {
    furi_check(bs, "BtStream: NULL in get_status()");
    // Cast away const for the atomic load — bt_stream_status_cb (a
    // different thread) never sees this pointer as const, and reading an
    // _Atomic field through a const-qualified struct pointer is a type
    // mismatch for atomic_load's implicit non-const requirement, not a
    // real mutation.
    return atomic_load((_Atomic(BtStatus)*)&bs->status);
}

bool bt_stream_is_connected(const BtStream* bs) {
    return bt_stream_get_status(bs) == BtStatusConnected;
}

bool bt_stream_tx_batch(BtStream* bs, const uint8_t* data, size_t len) {
    furi_check(bs, "BtStream: NULL in tx_batch()");
    furi_check(len <= UINT16_MAX, "BtStream: packet too large for BLE serial");

    if(!bt_stream_is_connected(bs) || !bs->profile) {
        bs->drop_count++;
        return false;
    }

    uint32_t t0 = furi_get_tick();
    // Cast away const: ble_profile_serial_tx()'s signature takes non-const
    // uint8_t*, but the SDK does not modify the buffer — it copies into the
    // BLE stack's own internal queue. Safe as long as that contract holds.
    bool sent = ble_profile_serial_tx(bs->profile, (uint8_t*)data, (uint16_t)len);
    uint32_t dt = furi_get_tick() - t0;
    if(dt > bs->tx_peak_ms) bs->tx_peak_ms = dt;

    if(!sent) {
        bs->drop_count++;
        return false;
    }
    return true;
}

uint32_t bt_stream_get_drop_count(const BtStream* bs) {
    furi_check(bs, "BtStream: NULL in get_drop_count()");
    return bs->drop_count;
}

uint32_t bt_stream_get_tx_peak_ms(const BtStream* bs) {
    furi_check(bs, "BtStream: NULL in get_tx_peak_ms()");
    return bs->tx_peak_ms;
}

void bt_stream_pack_packet(uint8_t out[BT_STREAM_PACKET_SIZE],
                           uint32_t timestamp_ms,
                           const GpsPosition* pos,
                           float gsr_raw) {
    out[0] = 0x42; // 'B'
    out[1] = 0x4d; // 'M'
    memcpy(out + 2, &timestamp_ms, sizeof(timestamp_ms));
    // Not a `pos->valid ? pos->lat : 0.0` ternary — this project's build
    // treats -Wdouble-promotion as an error, and GCC's conditional-operator
    // type unification flags that form even though both branches are
    // already double.
    double lat = 0.0, lon = 0.0;
    if(pos->valid) {
        lat = pos->lat;
        lon = pos->lon;
    }
    memcpy(out + 6,  &lat, sizeof(lat));
    memcpy(out + 14, &lon, sizeof(lon));
    memcpy(out + 22, &gsr_raw, sizeof(gsr_raw));
    memcpy(out + 26, &pos->hdop, sizeof(pos->hdop));
    memcpy(out + 30, &pos->pdop, sizeof(pos->pdop));
    // speed_kts/course_deg are NaN when GPS has no velocity fix (see
    // get_gps_position) — the wire format has no separate "no velocity"
    // flag, so send 0 rather than propagating a NaN the frontend would
    // have to special-case.
    float speed = isnan(pos->speed_kts) ? 0.0f : pos->speed_kts;
    float course = isnan(pos->course_deg) ? 0.0f : pos->course_deg;
    memcpy(out + 34, &speed, sizeof(speed));
    memcpy(out + 38, &course, sizeof(course));
    out[42] = (uint8_t)pos->sats;
    out[43] = (uint8_t)pos->fix_type;
    out[44] = pos->valid ? 1 : 0;
}
