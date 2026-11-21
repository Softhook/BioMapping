#include "gps_cardputer.h"

#include <Arduino.h>
#include <atomic>

#include "core_check.h"

// The EXT header's serial pins (docs/cardputer_port.md, "Power and
// connections"). Serial is the USB link, so the GPS uses UART 1.
static const int GPS_TX_PIN = 13;  // to the M10Q's RX
static const int GPS_RX_PIN = 15;  // from the M10Q's TX
static HardwareSerial& port = Serial1;

// Bytes the serial driver keeps until the main loop reads them. The
// module sends a few KB a second at 10 Hz; this covers a pause of about
// 2 s (the slowest SD write seen so far took 433 ms). The Flipper's
// buffer is 5 KB.
static const size_t RX_BUFFER_BYTES = 8192;

// ── Errors from the serial driver ───────────────────────────────────────
// The ESP32's driver reports receive errors through a callback, on its own
// task, not with each byte as the Flipper's does. Both counters are
// written there and read on the main loop.
//
// g_rx_error: a garbled byte (framing, parity, break) since the main loop
// last looked. Only the wake watch uses it.
static std::atomic<bool> g_rx_error{false};
// g_overflows: times the driver's buffer or the chip's receive queue was
// full and bytes were lost. The driver doesn't say how many bytes, so this
// counts the times, not the bytes as on the Flipper.
static std::atomic<uint32_t> g_overflows{0};

static void on_rx_error(hardwareSerial_error_t err) {
    switch(err) {
    case UART_BUFFER_FULL_ERROR:
    case UART_FIFO_OVF_ERROR:
        g_overflows++;
        break;
    case UART_FRAME_ERROR:
    case UART_PARITY_ERROR:
    case UART_BREAK_ERROR:
        g_rx_error = true;
        break;
    default:
        break;
    }
}

static bool g_port_open = false;

// ── State while receiving ───────────────────────────────────────────────
// The ESP32's driver always receives into its buffer. "Not receiving"
// (between rx_stop() and rx_start()) is copied from the Flipper by
// throwing those bytes away at the next rx_start().

enum class RxMode { Off, Stream, WakeWatch };

struct GpsCardputer {
    SemaphoreHandle_t mutex = nullptr;  // the shared code's lock
    uint32_t overflows_at_start = 0;
    bool     rx_again = false;          // handle_rx() stopped with bytes waiting
};

static RxMode g_rx_mode = RxMode::Off;

// Wake watch (GpsRxWakeWatch). The shared code asks rx_wake_seen() between
// 1 ms waits. A byte only counts as clean if no error arrives with it or
// in the next look: the error callback runs on the driver's own task, so it
// may come a moment after the byte can be read. Bytes that come with an
// error are thrown away and the wait goes on, as on the Flipper.
static bool     g_wake_seen = false;
static uint32_t g_wake_ms = 0;
static bool     g_wake_candidate = false;  // clean bytes seen once, not yet confirmed
static uint32_t g_wake_candidate_ms = 0;

static void drain_rx(void) {
    while(port.available() > 0) port.read();
}

static void wake_watch_look(void) {
    if(g_wake_seen) return;
    bool got = false;
    while(port.available() > 0) {
        port.read();
        got = true;
    }
    if(g_rx_error.exchange(false)) {
        g_wake_candidate = false;  // garbled: start again
        return;
    }
    if(g_wake_candidate) {
        g_wake_seen = true;
        g_wake_ms = g_wake_candidate_ms;
    } else if(got) {
        g_wake_candidate = true;
        g_wake_candidate_ms = millis();
    }
}

// ── Platform functions for core/gps_uart.c ──────────────────────────────

static void plat_set_baud(void* ctx, uint32_t baud) {
    (void)ctx;
    port.updateBaudRate(baud);
}

static void plat_tx(void* ctx, const uint8_t* data, size_t len) {
    (void)ctx;
    port.write(data, len);
}

static void plat_rx_start(void* ctx, GpsRxMode mode) {
    (void)ctx;
    drain_rx();
    g_rx_error = false;
    if(mode == GpsRxWakeWatch) {
        g_wake_seen = false;
        g_wake_candidate = false;
        g_rx_mode = RxMode::WakeWatch;
    } else {
        g_rx_mode = RxMode::Stream;
    }
}

static void plat_rx_stop(void* ctx) {
    (void)ctx;
    if(g_rx_mode == RxMode::WakeWatch) {
        // Give a byte that arrived in the last wait its confirming look,
        // so it still counts (the shared code asks again after stopping).
        wake_watch_look();
        if(g_wake_candidate && !g_wake_seen) {
            delay(2);
            wake_watch_look();
        }
    }
    g_rx_mode = RxMode::Off;
}

static size_t plat_rx_read(void* ctx, uint8_t* buf, size_t len) {
    (void)ctx;
    if(g_rx_mode != RxMode::Stream) return 0;
    int avail = port.available();
    if(avail <= 0) return 0;
    size_t n = (size_t)avail < len ? (size_t)avail : len;
    return port.read(buf, n);
}

static void plat_rx_clear(void* ctx) {
    (void)ctx;
    drain_rx();
}

static bool plat_rx_wake_seen(void* ctx, uint32_t* first_ms) {
    (void)ctx;
    if(g_rx_mode == RxMode::WakeWatch) wake_watch_look();
    if(!g_wake_seen) return false;
    *first_ms = g_wake_ms;
    return true;
}

static uint32_t plat_rx_drop_count(void* ctx) {
    auto* g = static_cast<GpsCardputer*>(ctx);
    return g ? g_overflows - g->overflows_at_start : 0;
}

static void plat_rx_again(void* ctx) {
    static_cast<GpsCardputer*>(ctx)->rx_again = true;
}

static uint32_t plat_now_ms(void* ctx) {
    (void)ctx;
    return millis();
}

static void plat_delay_ms(void* ctx, uint32_t ms) {
    (void)ctx;
    delay(ms);
}

static void plat_lock(void* ctx) {
    xSemaphoreTake(static_cast<GpsCardputer*>(ctx)->mutex, portMAX_DELAY);
}

static void plat_unlock(void* ctx) {
    xSemaphoreGive(static_cast<GpsCardputer*>(ctx)->mutex);
}

static void plat_log(void* ctx, bool warning, const char* line) {
    (void)ctx;
    Serial.printf("[GPS]%s %s\n", warning ? " warning:" : "", line);
}

static GpsPlatform platform_for(GpsCardputer* g) {
    GpsPlatform p = {};
    p.ctx = g;
    p.set_baud = plat_set_baud;
    p.tx = plat_tx;
    p.rx_start = plat_rx_start;
    p.rx_stop = plat_rx_stop;
    p.rx_read = plat_rx_read;
    p.rx_clear = plat_rx_clear;
    p.rx_wake_seen = plat_rx_wake_seen;
    p.rx_drop_count = plat_rx_drop_count;
    p.rx_again = plat_rx_again;
    p.now_ms = plat_now_ms;
    p.delay_ms = plat_delay_ms;
    p.lock = plat_lock;
    p.unlock = plat_unlock;
    p.log = plat_log;
    return p;
}

// ── Idle watch ──────────────────────────────────────────────────────────
// Between GPS sessions, bytes from the module are counted. A sleeping
// module sends nothing, so a count above 0 means it woke: the check on
// real hardware that the sleep held, logged when the next session starts.
// As on the Flipper, bytes in the first second aren't counted (a few stray
// bytes follow the sleep command).
static const uint32_t IDLE_SETTLE_MS = 1000;

static bool     g_idle_watching = false;
static uint32_t g_idle_start_ms = 0;
static uint32_t g_idle_bytes = 0;

static void idle_watch_start(void) {
    drain_rx();
    g_idle_bytes = 0;
    g_idle_start_ms = millis();
    g_idle_watching = true;
}

static void idle_watch_poll(void) {
    if(!g_idle_watching) return;
    while(port.available() > 0) {
        port.read();
        if(millis() - g_idle_start_ms >= IDLE_SETTLE_MS) g_idle_bytes++;
    }
}

static void idle_watch_stop(void) {
    if(!g_idle_watching) return;
    idle_watch_poll();
    g_idle_watching = false;
    if(g_idle_bytes == 0) {
        Serial.println("[GPS] Idle: GPS silent (stayed asleep)");
    } else {
        Serial.printf("[GPS] warning: Idle: %lu bytes from GPS (it was awake)\n",
                      (unsigned long)g_idle_bytes);
    }
}

// ── Public ──────────────────────────────────────────────────────────────

void gps_cardputer_port_open(void) {
    if(g_port_open) return;
    port.setRxBufferSize(RX_BUFFER_BYTES);
    port.begin(GPS_BAUD_RATE, SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);
    port.onReceiveError(on_rx_error);
    g_port_open = true;

    // The sleep sequence doesn't use the lock or rx_read; a bare context
    // with no session is enough.
    GpsCardputer bare;
    GpsPlatform p = platform_for(&bare);
    gps_uart_sleep_from_unknown_state(&p);
    idle_watch_start();
}

GpsUart* gps_cardputer_start(GpsNavModel nav_model, bool super_s) {
    auto* g = new GpsCardputer();
    g->mutex = xSemaphoreCreateMutex();
    CORE_CHECK(g->mutex, "GpsUart: mutex alloc failed");
    g->overflows_at_start = g_overflows;
    if(g_port_open) {
        idle_watch_stop();
    } else {
        Serial.println("[GPS] error: port not open (see gps_cardputer_port_open())");
    }
    GpsPlatform p = platform_for(g);
    return gps_uart_create(&p, g_port_open, nav_model, super_s);
}

void gps_cardputer_stop(GpsUart* gps) {
    auto* g = static_cast<GpsCardputer*>(gps_uart_platform_ctx(gps));  // stops on NULL
    gps_uart_destroy(gps);  // standby command, receiving off
    if(g_port_open) idle_watch_start();
    vSemaphoreDelete(g->mutex);
    delete g;
}

void gps_cardputer_poll(GpsUart* gps) {
    if(!gps) {
        idle_watch_poll();
        return;
    }
    if(!gps_uart_is_ready(gps)) return;
    auto* g = static_cast<GpsCardputer*>(gps_uart_platform_ctx(gps));
    if(!g->rx_again && port.available() <= 0) return;
    g->rx_again = false;
    gps_uart_handle_rx(gps);
}
