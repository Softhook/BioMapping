#include "gps_cardputer.h"

#include <Arduino.h>
#include <atomic>
#include <driver/uart.h>
#include <hal/uart_ll.h>  // UART_INTR_FRAM_ERR

#include "core_check.h"
#include "wake_watch.h"

// The EXT header's serial pins (docs/cardputer_port.md, "Power and
// connections"). Serial is the USB link, so the GPS uses UART 1.
static const int GPS_TX_PIN = 13;  // to the M10Q's RX
static const int GPS_RX_PIN = 15;  // from the M10Q's TX
static HardwareSerial& port = Serial1;
static const uart_port_t GPS_UART_NUM = UART_NUM_1;  // Serial1

// Bytes the serial driver keeps until the main loop reads them. The
// module sends a few KB a second at 10 Hz; this covers a pause of about
// 2 s (the slowest SD write seen so far took 433 ms). The Flipper's
// buffer is 5 KB.
static const size_t RX_BUFFER_BYTES = 8192;

// The serial chip hands bytes to the driver once it holds this many, or
// once the line has been quiet for one byte's time. 120 is Arduino's
// default, used while streaming (fewer interrupts). During the wake watch
// it is 4, so a byte can be read within about 4 ms of arriving at 9600:
// the first byte's time is then close to the Flipper's, and the guard
// after a garbled-byte report (wake_watch.h) is short.
static const uint8_t RX_FIFO_FULL_BYTES = 120;
static const uint8_t WAKE_FIFO_FULL_BYTES = 4;
static uint8_t       g_fifo_full = RX_FIFO_FULL_BYTES;

// More than this many bytes waiting means the main loop is behind, so the
// GPS time read now is old (clock_cardputer.cpp). In normal running the
// loop leaves less than one sentence.
static const int BACKLOG_BYTES = 512;

static uint32_t g_baud = GPS_BAUD_RATE;

// ── Errors from the serial driver ───────────────────────────────────────
// The ESP32's driver reports receive errors through a callback, on its own
// task, not with each byte as the Flipper's does. The counters are written
// there and read on the main loop.
//
// The driver doesn't switch on the framing-error report itself (its
// interrupt mask is 0x80195, without UART_INTR_FRAM_ERR = 0x8), and a byte
// at the wrong speed is mostly a framing error, so
// gps_cardputer_port_open() switches it on.
//
// g_rx_error: a garbled byte (framing, parity, break) since the main loop
// last looked. It comes as soon as the byte reaches the chip, usually
// before the byte can be read (wake_watch.h). Only the wake watch uses it.
static std::atomic<bool> g_rx_error{false};
// g_garbled: every garbled-byte report, for the log.
static std::atomic<uint32_t> g_garbled{0};
// g_overflows: times the chip's receive queue overflowed and bytes were
// lost. The driver doesn't say how many bytes, so this counts the times,
// not the bytes as on the Flipper.
static std::atomic<uint32_t> g_overflows{0};
// g_buffer_full: times the driver's 8 KB buffer was full. Nothing is lost
// yet then: the driver keeps the bytes and stops taking more off the chip
// until the main loop reads some. Only if the chip's own queue then fills
// are bytes lost, which counts in g_overflows. So this is a near miss.
static std::atomic<uint32_t> g_buffer_full{0};

static void on_rx_error(hardwareSerial_error_t err) {
    switch(err) {
    case UART_BUFFER_FULL_ERROR:
        g_buffer_full++;
        break;
    case UART_FIFO_OVF_ERROR:
        g_overflows++;
        break;
    case UART_FRAME_ERROR:
    case UART_PARITY_ERROR:
    case UART_BREAK_ERROR:
        g_garbled++;
        g_rx_error = true;
        break;
    default:
        break;
    }
}

static bool     g_port_open = false;
static bool     g_gps_asleep = false;
static uint32_t g_garbled_at_awake = 0;

// ── State while receiving ───────────────────────────────────────────────
// The ESP32's driver always receives into its buffer. "Not receiving"
// (between rx_stop() and rx_start()) is copied from the Flipper by
// throwing those bytes away at the next rx_start().

enum class RxMode { Off, Stream, WakeWatch };

struct GpsCardputer {
    SemaphoreHandle_t mutex = nullptr;  // the shared code's lock
    uint32_t overflows_at_start = 0;
    uint32_t buffer_full_at_start = 0;
    bool     rx_again = false;          // handle_rx() stopped with bytes waiting
};

static RxMode g_rx_mode = RxMode::Off;

// Wake watch (GpsRxWakeWatch). The shared code asks rx_wake_seen() between
// 1 ms waits; each ask is one look (wake_watch.c has the rule).
static WakeWatch g_wake;
static uint32_t  g_garbled_at_wake_start = 0;

static void drain_rx(void) {
    uart_flush_input(GPS_UART_NUM);
    uint8_t discard[64];
    while(port.available() > 0) {
        if(port.read(discard, sizeof(discard)) <= 0) break;
    }
}

static void wake_watch_poll(void) {
    if(g_wake.seen) return;
    // The report first, then the bytes: a report that comes in between is
    // caught by the next look.
    bool error = g_rx_error.exchange(false);
    bool got = false;
    uint8_t buf[32];
    int n;
    while((n = port.available()) > 0) {
        if(n > (int)sizeof(buf)) n = sizeof(buf);
        n = port.read(buf, n);
        if(n <= 0) break;
        got = true;
        // A byte that isn't text is as good as a report (wake_watch.h).
        if(!wake_watch_bytes_are_text(buf, (size_t)n)) error = true;
    }
    wake_watch_look(&g_wake, millis(), error, got, wake_watch_guard_ms(g_baud, g_fifo_full));
}

// ── Platform functions for core/gps_uart.c ──────────────────────────────

// While gps_cardputer_parse_down_to() runs: rx_read() leaves this many
// bytes waiting, so each caught-up row gets only its own slice. -1 = none.
// A reconfigure (set_baud, rx_clear) ends it: the shared code then reads
// the module's replies with rx_read, and must see every byte.
static int g_read_floor = -1;

static void plat_set_baud(void* ctx, uint32_t baud) {
    (void)ctx;
    g_read_floor = -1;
    if(g_baud == baud) return;
    port.updateBaudRate(baud);
    g_baud = baud;
}

static void plat_tx(void* ctx, const uint8_t* data, size_t len) {
    (void)ctx;
    port.write(data, len);
}

static void set_fifo_full(uint8_t bytes) {
    if(g_fifo_full == bytes) return;
    port.setRxFIFOFull(bytes);
    g_fifo_full = bytes;
}

static void plat_rx_start(void* ctx, GpsRxMode mode) {
    (void)ctx;
    drain_rx();
    // A report is left for the first look, not cleared: its garbled byte
    // may still be on the chip, so the wake watch must guard against it.
    // (A report from long before only delays the wait by the guard time.)
    if(mode == GpsRxWakeWatch) {
        set_fifo_full(WAKE_FIFO_FULL_BYTES);
        wake_watch_reset(&g_wake);
        g_garbled_at_wake_start = g_garbled;
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
        wake_watch_poll();
        if(g_wake.candidate && !g_wake.seen) {
            delay(2);
            wake_watch_poll();
        }
        set_fifo_full(RX_FIFO_FULL_BYTES);
        uint32_t garbled = g_garbled - g_garbled_at_wake_start;
        if(garbled > 0) {
            Serial.printf("[GPS] Wake: %lu garbled-byte reports during the wait\n",
                          (unsigned long)garbled);
        }
    }
    g_rx_mode = RxMode::Off;
}

static size_t plat_rx_read(void* ctx, uint8_t* buf, size_t len) {
    (void)ctx;
    if(g_rx_mode != RxMode::Stream) return 0;
    int avail = port.available();
    if(g_read_floor >= 0) avail -= g_read_floor;
    if(avail <= 0) return 0;
    size_t n = (size_t)avail < len ? (size_t)avail : len;
    return port.read(buf, n);
}

static void plat_rx_clear(void* ctx) {
    (void)ctx;
    g_read_floor = -1;
    drain_rx();
}

static bool plat_rx_wake_seen(void* ctx, uint32_t* first_ms) {
    (void)ctx;
    if(g_rx_mode == RxMode::WakeWatch) wake_watch_poll();
    if(!g_wake.seen) return false;
    *first_ms = g_wake.seen_ms;
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
// As on the Flipper, bytes in the first GPS_IDLE_SETTLE_MS (core/gps_uart.h)
// aren't counted (a few stray bytes follow the sleep command).
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
        if(millis() - g_idle_start_ms >= GPS_IDLE_SETTLE_MS) g_idle_bytes++;
    }
}

static void idle_watch_stop(void) {
    if(!g_idle_watching) return;
    idle_watch_poll();
    g_idle_watching = false;
    uint32_t watched_ms = millis() - g_idle_start_ms;
    // A garbled-byte report is left for the wake watch, whose first look
    // guards against its byte still being on the chip. After a silent
    // sleep any report is from bytes long read and thrown away (the stray
    // bytes after the sleep command, say), and would only make the wake
    // watch ignore its first 30 ms for nothing.
    if(watched_ms >= GPS_IDLE_SETTLE_MS && g_idle_bytes == 0) g_rx_error = false;
    if(watched_ms < GPS_IDLE_SETTLE_MS + 1000) {
        // Too short a sleep (e.g. entering and leaving a non-GPS mode in
        // under 2 s) to judge whether standby held.
        Serial.printf("[GPS] Idle: not checked (asleep only %lu ms)\n", (unsigned long)watched_ms);
    } else if(g_idle_bytes == 0) {
        Serial.println("[GPS] Idle: GPS silent (stayed asleep)");
    } else {
        Serial.printf("[GPS] warning: Idle: %lu bytes from GPS (it was awake)\n",
                      (unsigned long)g_idle_bytes);
    }
}

// ── Public ──────────────────────────────────────────────────────────────

bool gps_cardputer_port_open(GpsUtcTime* boot_utc) {
    if(g_port_open) return false;
    port.setRxBufferSize(RX_BUFFER_BYTES);
    port.begin(GPS_BAUD_RATE, SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN, false, 20000,
               RX_FIFO_FULL_BYTES);
    g_baud = GPS_BAUD_RATE;
    port.onReceiveError(on_rx_error);
    // See "Errors from the serial driver" above.
    if(uart_enable_intr_mask(GPS_UART_NUM, UART_INTR_FRAM_ERR) != ESP_OK) {
        Serial.println("[GPS] warning: framing-error report not switched on");
    }
    g_port_open = true;

    // The boot wake + UTC poll sequence doesn't use the lock; a bare context
    // with no session is enough. Leaves the module awake at 115200.
    GpsCardputer bare;
    GpsPlatform p = platform_for(&bare);
    bool got_time = gps_uart_wake_to_fast(&p, boot_utc);
    g_gps_asleep = false;
    g_garbled_at_awake = g_garbled;
    return got_time;
}

void gps_cardputer_sleep(void) {
    if(!g_port_open || g_gps_asleep) return;
    GpsCardputer bare;
    GpsPlatform p = platform_for(&bare);
    gps_uart_standby(&p);
    g_gps_asleep = true;
    idle_watch_start();
}

bool gps_cardputer_is_asleep(void) {
    return g_gps_asleep;
}

GpsUart* gps_cardputer_start(GpsNavModel nav_model, bool super_s) {
    auto* g = new GpsCardputer();
    g->mutex = xSemaphoreCreateMutex();
    CORE_CHECK(g->mutex, "GpsUart: mutex alloc failed");
    bool already_awake = false;
    if(g_port_open) {
        if(g_gps_asleep) {
            idle_watch_stop();
        } else if(g_garbled - g_garbled_at_awake >= 8) {
            // Framing errors arrived while idling at 115200 (e.g. the module
            // browned out or was connected at 9600 after boot): run the full
            // 9600 -> 115200 switch immediately rather than timing out UBX
            // packets at 115200.
            Serial.println("[GPS] warning: garbled bytes while idle at 115200; re-syncing from 9600");
        } else {
            drain_rx();
            already_awake = true;
        }
    } else {
        Serial.println("[GPS] error: port not open (see gps_cardputer_port_open())");
    }
    g->overflows_at_start = g_overflows;
    g->buffer_full_at_start = g_buffer_full;
    GpsPlatform p = platform_for(g);
    GpsUart* gps = gps_uart_create(&p, g_port_open, already_awake, nav_model, super_s);
    if(g_port_open) {
        g_gps_asleep = false;
        g_garbled_at_awake = g_garbled;
    }
    return gps;
}

void gps_cardputer_stop(GpsUart* gps) {
    auto* g = static_cast<GpsCardputer*>(gps_uart_platform_ctx(gps));  // stops on NULL
    gps_uart_destroy(gps);  // receiving off; module stays awake at 115200
    g_garbled_at_awake = g_garbled;
    vSemaphoreDelete(g->mutex);
    delete g;
}

bool gps_cardputer_cold_reset(GpsNavModel nav_model, bool super_s) {
    GpsUart* gps = gps_cardputer_start(nav_model, super_s);
    bool ok = gps && gps_uart_is_ready(gps);
    if(ok) {
        gps_uart_send_cold_start(gps);
        delay(GPS_COLD_START_SETTLE_MS);
    }
    if(gps) gps_cardputer_stop(gps);
    if(ok) gps_cardputer_sleep();
    return ok;
}

void gps_cardputer_poll(GpsUart* gps) {
    if(!gps) {
        if(g_idle_watching) {
            idle_watch_poll();
        } else if(g_port_open) {
            // Module is awake on the menu: keep the 8 KB RX buffer empty.
            uint8_t discard[64];
            for(int pass = 0; pass < 8 && port.available() > 0; pass++) {
                if(port.read(discard, sizeof(discard)) <= 0) break;
            }
        }
        return;
    }
    if(!gps_uart_is_ready(gps)) return;
    auto* g = static_cast<GpsCardputer*>(gps_uart_platform_ctx(gps));
    if(!g->rx_again && port.available() <= 0) return;
    g->rx_again = false;
    gps_uart_handle_rx(gps);
}

bool gps_cardputer_behind(const GpsUart* gps) {
    if(!gps || !gps_uart_is_ready(gps)) return false;
    const auto* g = static_cast<const GpsCardputer*>(gps_uart_platform_ctx(gps));
    return g->rx_again || port.available() > BACKLOG_BYTES;
}

uint32_t gps_cardputer_buffer_full_count(const GpsUart* gps) {
    if(!gps) return 0;
    const auto* g = static_cast<const GpsCardputer*>(gps_uart_platform_ctx(gps));
    return g_buffer_full - g->buffer_full_at_start;
}

int gps_cardputer_waiting_bytes(void) {
    return g_port_open ? port.available() : 0;
}

void gps_cardputer_parse_down_to(GpsUart* gps, int bytes_left) {
    if(!gps || !gps_uart_is_ready(gps)) return;
    auto* g = static_cast<GpsCardputer*>(gps_uart_platform_ctx(gps));
    // The shared reader takes up to 384 bytes a pass and parses up to 8
    // lines, keeping the rest in its own buffer (it then asks for another
    // pass: rx_again). With the floor it takes no more than this slice, and
    // the passes go on until the lines it holds are parsed too. The cap
    // stops a stream that keeps arriving from holding the loop.
    if(bytes_left < 0) bytes_left = 0;
    g_read_floor = bytes_left;
    for(int i = 0; i < 32 && (g->rx_again || port.available() > bytes_left); i++) {
        g->rx_again = false;
        gps_uart_handle_rx(gps);
    }
    g_read_floor = -1;
}
