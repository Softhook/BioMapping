// GPS on the Flipper: USART1 and its receive interrupt, the app-lifetime
// port, and the serial, clock, wait and lock functions the shared code in
// core/gps_uart.c works through.
// Single-byte-per-IRQ RX pattern, adapted from ezod/flipperzero-gps.

#include "gps_uart_flipper.h"
#include "../biomap_events.h"

#include <furi.h>
#include <furi_hal.h>
#include <expansion/expansion.h>
#include <stdatomic.h>
#include <stdlib.h>

#define TAG "GpsUart"

// One per GpsUart (one GPS session), except the bare one gps_uart_port_open()
// uses for the sleep sequence, which only has `handle`.
typedef struct {
    FuriHalSerialHandle* handle;      // the held port, or NULL when it couldn't be taken
    FuriStreamBuffer*    rx_stream;   // bytes from the interrupt (GpsRxStream)
    FuriMutex*           mutex;       // the shared code's lock (GpsPlatform.lock/unlock)
    FuriMessageQueue*    event_queue;
    volatile bool        rx_pending;  // an EventTypeUart is already queued
    // Written from ISR context (gps_flipper_rx_cb), read from the main
    // thread (gps_flipper_rx_drop_count) — genuinely cross-context, so
    // _Atomic, same reasoning as the GSR worker's `running` flag after its
    // ThreadSanitizer review.
    _Atomic uint32_t     rx_drop_count;
} GpsFlipper;

// ── USART1, held for the app's whole life ───────────────────────────────
// Opened at app start (gps_uart_port_open()) and closed at app exit, not per
// GPS session. A sleeping M10Q wakes on any edge on its RX pin (see
// ubx_rxm_pmreq_standby in core/gps_uart.c), and a released port leaves that
// line floating (furi_hal_serial_deinit() sets the pin to analog, no pull)
// and hands it to the Expansion Service — on hardware the module was awake
// again within seconds of every release. Held, the line idles steadily
// high, so the module stays asleep on the menu and in GSR-only mode. See
// research/archive/gps_sleep_investigation.md.
static FuriHalSerialHandle* g_port = NULL;
// Whether g_port has been through furi_hal_serial_init() since it was
// taken, so set_baud() and close only deinit a port that was initialised.
static bool g_port_inited = false;

// ── Platform functions for core/gps_uart.c ──────────────────────────────

static void gps_flipper_set_baud(void* ctx, uint32_t baud) {
    GpsFlipper* f = ctx;
    if(g_port_inited) furi_hal_serial_deinit(f->handle);
    furi_hal_serial_init(f->handle, baud);
    g_port_inited = true;
}

static void gps_flipper_tx(void* ctx, const uint8_t* data, size_t len) {
    GpsFlipper* f = ctx;
    furi_hal_serial_tx(f->handle, data, len);
}

// GpsRxStream: fires per received byte (ISR context). Posts a single
// EventTypeUart to the main queue; later bytes are drained in
// gps_uart_process_rx() so the queue doesn't overflow.
// `event` is a bitmask: a byte can arrive flagged Data together with an
// error bit (e.g. FrameError at a mismatched baud), so test the Data bit
// rather than comparing for equality — and keep the byte.
static void gps_flipper_rx_cb(FuriHalSerialHandle* handle, FuriHalSerialRxEvent event, void* context) {
    GpsFlipper* f = context;
    if(event & FuriHalSerialRxEventData) {
        uint8_t data = furi_hal_serial_async_rx(handle);
        if(furi_stream_buffer_send(f->rx_stream, &data, 1, 0) == 0) {
            // rx_stream was full — the byte is lost. See
            // gps_uart_get_rx_drop_count() in core/gps_uart.h.
            f->rx_drop_count++;
        }
        if(!f->rx_pending) {
            f->rx_pending = true;
            BioMapEvent ev = {.type = EventTypeUart};
            furi_message_queue_put(f->event_queue, &ev, 0);
        }
    }
}

// GpsRxWakeWatch: written from the RX ISR, read by the shared wake wait on
// the main thread. File-scope: the wake wait also runs at app start, with
// the bare GpsFlipper.
static _Atomic bool     g_wake_rx_seen;
static _Atomic uint32_t g_wake_first_byte_tick;

static void gps_flipper_wake_rx_cb(FuriHalSerialHandle* handle, FuriHalSerialRxEvent event, void* context) {
    UNUSED(context);
    if(!(event & FuriHalSerialRxEventData)) return; // bitmask — see gps_flipper_rx_cb()
    furi_hal_serial_async_rx(handle); // read to clear the byte; its value doesn't matter
    // Only a clean byte counts (see GpsRxWakeWatch in core/gps_uart.h).
    const FuriHalSerialRxEvent errors =
        FuriHalSerialRxEventFrameError | FuriHalSerialRxEventNoiseError |
        FuriHalSerialRxEventOverrunError | FuriHalSerialRxEventParityError;
    if(event & errors) return;
    if(!g_wake_rx_seen) {
        g_wake_first_byte_tick = furi_get_tick();
        g_wake_rx_seen = true;
    }
}

static void gps_flipper_rx_start(void* ctx, GpsRxMode mode) {
    GpsFlipper* f = ctx;
    if(mode == GpsRxWakeWatch) {
        g_wake_rx_seen = false;
        furi_hal_serial_async_rx_start(f->handle, gps_flipper_wake_rx_cb, NULL, false);
    } else {
        furi_hal_serial_async_rx_start(f->handle, gps_flipper_rx_cb, f, false);
    }
}

static void gps_flipper_rx_stop(void* ctx) {
    GpsFlipper* f = ctx;
    furi_hal_serial_async_rx_stop(f->handle);
}

static size_t gps_flipper_rx_read(void* ctx, uint8_t* buf, size_t len) {
    GpsFlipper* f = ctx;
    return furi_stream_buffer_receive(f->rx_stream, buf, len, 0);
}

static void gps_flipper_rx_clear(void* ctx) {
    GpsFlipper* f = ctx;
    furi_stream_buffer_reset(f->rx_stream);
}

static bool gps_flipper_rx_wake_seen(void* ctx, uint32_t* first_ms) {
    UNUSED(ctx);
    if(!g_wake_rx_seen) return false;
    *first_ms = g_wake_first_byte_tick;
    return true;
}

static uint32_t gps_flipper_rx_drop_count(void* ctx) {
    GpsFlipper* f = ctx;
    return f->rx_drop_count;
}

// Only marks the event as queued if it really was: a full queue leaves
// rx_pending false, so the next byte posts again.
static void gps_flipper_rx_again(void* ctx) {
    GpsFlipper* f = ctx;
    BioMapEvent ev = {.type = EventTypeUart};
    if(furi_message_queue_put(f->event_queue, &ev, 0) == FuriStatusOk) {
        f->rx_pending = true;
    }
}

// furi_get_tick() counts milliseconds: the Flipper's kernel tick is 1 kHz
// (checked in gps_uart_port_open() and gps_uart_alloc()).
static uint32_t gps_flipper_now_ms(void* ctx) {
    UNUSED(ctx);
    return furi_get_tick();
}

static void gps_flipper_delay_ms(void* ctx, uint32_t ms) {
    UNUSED(ctx);
    furi_delay_ms(ms);
}

static void gps_flipper_lock(void* ctx) {
    GpsFlipper* f = ctx;
    furi_mutex_acquire(f->mutex, FuriWaitForever);
}

static void gps_flipper_unlock(void* ctx) {
    GpsFlipper* f = ctx;
    furi_mutex_release(f->mutex);
}

static void gps_flipper_log(void* ctx, bool warning, const char* line) {
    UNUSED(ctx);
    if(warning) {
        FURI_LOG_W(TAG, "%s", line);
    } else {
        FURI_LOG_I(TAG, "%s", line);
    }
}

static GpsPlatform gps_flipper_platform(GpsFlipper* f) {
    return (GpsPlatform){
        .ctx = f,
        .set_baud = gps_flipper_set_baud,
        .tx = gps_flipper_tx,
        .rx_start = gps_flipper_rx_start,
        .rx_stop = gps_flipper_rx_stop,
        .rx_read = gps_flipper_rx_read,
        .rx_clear = gps_flipper_rx_clear,
        .rx_wake_seen = gps_flipper_rx_wake_seen,
        .rx_drop_count = gps_flipper_rx_drop_count,
        .rx_again = gps_flipper_rx_again,
        .now_ms = gps_flipper_now_ms,
        .delay_ms = gps_flipper_delay_ms,
        .lock = gps_flipper_lock,
        .unlock = gps_flipper_unlock,
        .log = gps_flipper_log,
    };
}

// ── Idle watch ──────────────────────────────────────────────────────────
// Between GPS sessions the port listens and counts whatever arrives. A
// sleeping module sends nothing, so a non-zero count means it woke — the
// on-hardware check that the sleep held, logged when the idle stretch ends.
//
// Bytes in the first GPS_IDLE_SETTLE_MS aren't counted: after the app-start
// sleep, hardware showed exactly 9 stray bytes every time from a module that
// then needed a full restart to wake (so it was asleep) — leftovers from
// going to sleep, not a wake-up.
#define GPS_IDLE_SETTLE_MS 1000

static _Atomic uint32_t g_idle_rx_bytes;
static uint32_t g_idle_start_tick;
static uint32_t g_idle_settle_ticks;
static bool g_idle_watching = false;

static void gps_uart_idle_rx_cb(FuriHalSerialHandle* handle, FuriHalSerialRxEvent event, void* context) {
    UNUSED(context);
    if(!(event & FuriHalSerialRxEventData)) return; // bitmask — see gps_flipper_rx_cb()
    furi_hal_serial_async_rx(handle); // read to clear the byte; only the count matters
    if(furi_get_tick() - g_idle_start_tick < g_idle_settle_ticks) return;
    g_idle_rx_bytes++;
}

static void gps_uart_idle_watch_start(void) {
    g_idle_rx_bytes = 0;
    g_idle_settle_ticks = (GPS_IDLE_SETTLE_MS * furi_kernel_get_tick_frequency()) / 1000;
    g_idle_start_tick = furi_get_tick();
    furi_hal_serial_async_rx_start(g_port, gps_uart_idle_rx_cb, NULL, false);
    g_idle_watching = true;
}

static void gps_uart_idle_watch_stop(void) {
    if(!g_idle_watching) return;
    furi_hal_serial_async_rx_stop(g_port);
    g_idle_watching = false;
    uint32_t n = g_idle_rx_bytes;
    if(n == 0) {
        FURI_LOG_I(TAG, "Idle: GPS silent (stayed asleep)");
    } else {
        FURI_LOG_W(TAG, "Idle: %lu bytes from GPS (it was awake)", (unsigned long)n);
    }
}

uint32_t gps_uart_get_idle_rx_count(void) {
    return g_idle_rx_bytes;
}

// Disable/enable the Expansion Service around USART1 use — this app claims
// the pin for GPS, which Expansion also wants.
static void gps_uart_set_expansion_enabled(bool enabled) {
    Expansion* expansion = furi_record_open(RECORD_EXPANSION);
    if(enabled) {
        expansion_enable(expansion);
    } else {
        expansion_disable(expansion);
    }
    furi_record_close(RECORD_EXPANSION);
}

void gps_uart_port_open(void) {
    if(g_port) return;
    // furi_check, not furi_assert: this app's build defines FURI_NDEBUG.
    furi_check(furi_kernel_get_tick_frequency() == 1000, "GpsUart: tick is not 1 ms");
    gps_uart_set_expansion_enabled(false);
    g_port = furi_hal_serial_control_acquire(GPS_UART_CH);
    if(!g_port) {
        FURI_LOG_E(TAG, "Failed to acquire USART1");
        gps_uart_set_expansion_enabled(true);
        return;
    }
    g_port_inited = false;
    GpsFlipper bare = {.handle = g_port};
    GpsPlatform platform = gps_flipper_platform(&bare);
    gps_uart_sleep_from_unknown_state(&platform);
    gps_uart_idle_watch_start();
}

void gps_uart_port_close(void) {
    if(!g_port) return;
    gps_uart_idle_watch_stop();
    if(g_port_inited) furi_hal_serial_deinit(g_port);
    g_port_inited = false;
    furi_hal_serial_control_release(g_port);
    g_port = NULL;
    gps_uart_set_expansion_enabled(true);
}

// ---------------------------------------------------------------------------
// Session: alloc wakes the module, free sleeps it; the port stays open
// ---------------------------------------------------------------------------
GpsUart* gps_uart_alloc(FuriMessageQueue* event_queue, NotificationApp* notifications,
                        GpsNavModel nav_model, bool super_s) {
    UNUSED(notifications); // not currently used by this module — see gps_uart_flipper.h
    furi_check(furi_kernel_get_tick_frequency() == 1000, "GpsUart: tick is not 1 ms");
    GpsFlipper* f = malloc(sizeof(GpsFlipper));
    furi_check(f, "GpsUart: NULL struct alloc");
    f->handle        = g_port;
    f->event_queue   = event_queue;
    f->rx_pending    = false;
    f->rx_drop_count = 0;
    f->mutex = furi_mutex_alloc(FuriMutexTypeNormal);
    furi_check(f->mutex, "GpsUart: status_mutex alloc failed");
    f->rx_stream = furi_stream_buffer_alloc(GPS_RX_BUF_SIZE, 1);

    if(f->handle) {
        gps_uart_idle_watch_stop();
    } else {
        FURI_LOG_E(TAG, "USART1 not open (see gps_uart_port_open())");
    }
    GpsPlatform platform = gps_flipper_platform(f);
    return gps_uart_create(&platform, f->handle != NULL, nav_model, super_s);
}

void gps_uart_free(GpsUart* g) {
    GpsFlipper* f = gps_uart_platform_ctx(g); // stops on NULL
    gps_uart_destroy(g); // standby command, receiving off
    if(f->handle) gps_uart_idle_watch_start();
    furi_stream_buffer_free(f->rx_stream);
    furi_mutex_free(f->mutex);
    free(f);
}

void gps_uart_process_rx(GpsUart* g) {
    GpsFlipper* f = gps_uart_platform_ctx(g); // stops on NULL
    if(!gps_uart_is_ready(g)) return;
    // Clear rx_pending BEFORE draining so that any new byte arriving from the
    // ISR mid-drain sets it true again and posts a fresh UART event to the queue.
    // If cleared AFTER the drain, an ISR byte arriving mid-drain would see
    // rx_pending=true (suppressing a new queue event) and then be left with no
    // event to trigger a follow-up drain — silently deferring until the next IRQ.
    f->rx_pending = false;
    gps_uart_handle_rx(g);
}
