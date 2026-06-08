// GPS UART Module for BioMapping 3.0
// Derived from ezod/flipperzero-gps — single-byte-per-IRQ UART pattern.
//
// GPS Controls — ORIGINAL L76K GNSS Shield pin assignment (no trace cuts):
//   STANDBY → gpio_ext_pc0 (Pin 16)
//   RESET   → gpio_ext_pc1 (Pin 15)

#include "gps_uart.h"
#include "../biomap_events.h" // ← Fix #1: use shared PluginEvent for queue posts

#include <furi.h>
#include <furi_hal.h>
#include <notification/notification_messages.h>
#include <math.h>
#include <string.h>

#include "../minmea.h"

// ---------------------------------------------------------------------------
// Internal structure (opaque to callers via forward-decl in header)
// ---------------------------------------------------------------------------

struct GpsUart {
    GpsStatus status;

    // UART RX pipeline
    FuriHalSerialHandle* serial_handle;
    FuriStreamBuffer*    rx_stream;
    uint8_t              rx_buf[1024];
    size_t               rx_offset;

    // Back-reference to the main event queue
    FuriMessageQueue* event_queue;

    // Caller-owned notification handle (LED blinks on NMEA parse).
    // Not opened or closed here — lifetime belongs to the caller.
    NotificationApp* notifications;

    // Hardware/resource handles we take ownership of
    bool       ready; // true if serial_handle acquired OK
    volatile bool rx_pending;
};

// ---------------------------------------------------------------------------
// UART IRQ callback — fires for every received byte (ISR context).
// Fix #1: post a real PluginEvent so the queue item size always matches
//         what biomap.c allocated (sizeof(PluginEvent)).
// ---------------------------------------------------------------------------
static void gps_uart_irq_cb(
    FuriHalSerialHandle* handle,
    FuriHalSerialRxEvent event,
    void* context) {
    UNUSED(handle);
    GpsUart* gps_uart = (GpsUart*)context;
    if(event == FuriHalSerialRxEventData) {
        uint8_t data = furi_hal_serial_async_rx(handle);
        furi_stream_buffer_send(gps_uart->rx_stream, &data, 1, 0);

        if(!gps_uart->rx_pending) {
            gps_uart->rx_pending = true;
            // Post a correctly-sized PluginEvent. The main loop checks only the
            // `type` field for UART events, so `input` can be zeroed.
            PluginEvent ev;
            memset(&ev, 0, sizeof(ev));
            ev.type = EventTypeUart;
            furi_message_queue_put(gps_uart->event_queue, &ev, 0);
        }
    }
}

// ---------------------------------------------------------------------------
// NMEA sentence parser
// ---------------------------------------------------------------------------
static void gps_uart_parse_line(GpsUart* gps_uart, char* line) {
    switch(minmea_sentence_id(line, false)) {
    case MINMEA_SENTENCE_RMC: {
        struct minmea_sentence_rmc frame;
        if(minmea_parse_rmc(&frame, line)) {
            gps_uart->status.fix_valid  = frame.valid;
            gps_uart->status.latitude   = minmea_tocoord(&frame.latitude);
            gps_uart->status.longitude  = minmea_tocoord(&frame.longitude);
            gps_uart->status.speed      = minmea_tofloat(&frame.speed);
            gps_uart->status.course     = minmea_tofloat(&frame.course);
            gps_uart->status.time       = frame.time;
            gps_uart->status.date       = frame.date;
            notification_message(gps_uart->notifications, &sequence_blink_green_10);
        }
    } break;

    case MINMEA_SENTENCE_GGA: {
        struct minmea_sentence_gga frame;
        if(minmea_parse_gga(&frame, line)) {
            gps_uart->status.latitude           = minmea_tocoord(&frame.latitude);
            gps_uart->status.longitude          = minmea_tocoord(&frame.longitude);
            gps_uart->status.altitude           = minmea_tofloat(&frame.altitude);
            gps_uart->status.altitude_units     = frame.altitude_units;
            gps_uart->status.satellites_tracked = frame.satellites_tracked;
            gps_uart->status.fix_quality        = frame.fix_quality;
            gps_uart->status.time               = frame.time;
            notification_message(gps_uart->notifications, &sequence_blink_magenta_10);
        }
    } break;

    case MINMEA_SENTENCE_GLL: {
        struct minmea_sentence_gll frame;
        if(minmea_parse_gll(&frame, line)) {
            gps_uart->status.latitude  = minmea_tocoord(&frame.latitude);
            gps_uart->status.longitude = minmea_tocoord(&frame.longitude);
            gps_uart->status.time      = frame.time;
            notification_message(gps_uart->notifications, &sequence_blink_red_10);
        }
    } break;

    default:
        break;
    }
}

// ---------------------------------------------------------------------------
// Public API — alloc
// Fix #10: accept caller-owned NotificationApp* instead of opening our own.
// Fix #13: removed unused FuriMutex* parameter.
// ---------------------------------------------------------------------------
GpsUart* gps_uart_alloc(FuriMessageQueue* event_queue, NotificationApp* notifications) {
    GpsUart* gps_uart = malloc(sizeof(GpsUart));
    furi_assert(gps_uart);

    gps_uart->event_queue   = event_queue;
    gps_uart->notifications = notifications; // caller retains ownership
    gps_uart->rx_offset     = 0;
    gps_uart->ready         = false;
    gps_uart->rx_pending    = false;

    // Initialise status — NaN flags "no fix yet"
    gps_uart->status.latitude           = NAN;
    gps_uart->status.longitude          = NAN;
    gps_uart->status.altitude           = 0.0f;
    gps_uart->status.altitude_units     = ' ';
    gps_uart->status.speed              = 0.0f;
    gps_uart->status.course             = 0.0f;
    gps_uart->status.fix_quality        = 0;
    gps_uart->status.satellites_tracked = 0;
    gps_uart->status.fix_valid          = false;
    memset(&gps_uart->status.time, 0, sizeof(struct minmea_time));
    memset(&gps_uart->status.date, 0, sizeof(struct minmea_date));

    // Stream buffer for byte-level RX
    gps_uart->rx_stream = furi_stream_buffer_alloc(GPS_RX_BUF_SIZE, 1);

    // NOTE: Do NOT call expansion_disable() — the GNSS shield is an expansion
    // module and disabling it kills GPS power/data. Do NOT touch GPIO pins
    // 15/16 (STANDBY/RESET) — the GPS wakes on its own when OTG power is
    // supplied, just like the proven ezod/flipperzero-gps app.

    // Acquire and initialise the serial peripheral
    gps_uart->serial_handle = furi_hal_serial_control_acquire(GPS_UART_CH);
    if(gps_uart->serial_handle) {
        furi_hal_serial_init(gps_uart->serial_handle, GPS_BAUD_RATE);
        furi_hal_serial_async_rx_start(
            gps_uart->serial_handle, gps_uart_irq_cb, gps_uart, false);
        gps_uart->ready = true;
    } else {
        FURI_LOG_E("GpsUart", "Failed to acquire USART1 — another app may have it open");
    }

    return gps_uart;
}

// ---------------------------------------------------------------------------
// Public API — free
// ---------------------------------------------------------------------------
void gps_uart_free(GpsUart* gps_uart) {
    furi_assert(gps_uart);

    // Shut down serial — stop IRQ before deinit, then release peripheral.
    // Order matters: async_rx_stop disables the IRQ before deinit touches hardware.
    if(gps_uart->serial_handle) {
        furi_hal_serial_async_rx_stop(gps_uart->serial_handle);
        furi_hal_serial_deinit(gps_uart->serial_handle);
        furi_hal_serial_control_release(gps_uart->serial_handle);
        gps_uart->serial_handle = NULL;
    }

    // NOTE: No GPIO or expansion cleanup needed — we never touched them.

    // Fix #10: we don't own RECORD_NOTIFICATION — do NOT close it here.
    // The caller (biomap.c) opened it and will close it at shutdown.

    furi_stream_buffer_free(gps_uart->rx_stream);
    free(gps_uart);
}

// ---------------------------------------------------------------------------
// Public API — status snapshot (call while holding app mutex)
// ---------------------------------------------------------------------------
GpsStatus gps_uart_get_status(GpsUart* gps_uart) {
    furi_assert(gps_uart);
    return gps_uart->status;
}

bool gps_uart_is_ready(GpsUart* gps_uart) {
    furi_assert(gps_uart);
    return gps_uart->ready;
}

// ---------------------------------------------------------------------------
// Public API — drain RX stream and parse NMEA lines.
// Call from the main event loop on EventTypeUart, while holding the mutex.
//
// Fix #3: if the line buffer fills with no newline (GPS sends garbage /
// baud mismatch), reset rx_offset so the module can resume receiving.
// Without this the buffer stays permanently full and GPS silently stops.
// ---------------------------------------------------------------------------
void gps_uart_process_rx(GpsUart* gps_uart) {
    furi_assert(gps_uart);
    gps_uart->rx_pending = false;

    size_t len = 0;
    do {
        // Fix #3: guard against a full buffer with no newline.
        if(sizeof(gps_uart->rx_buf) - 1 - gps_uart->rx_offset == 0) {
            FURI_LOG_W("GpsUart", "RX buffer full with no newline — discarding");
            gps_uart->rx_offset = 0;
        }

        len = furi_stream_buffer_receive(
            gps_uart->rx_stream,
            gps_uart->rx_buf + gps_uart->rx_offset,
            sizeof(gps_uart->rx_buf) - 1 - gps_uart->rx_offset,
            0);

        if(len > 0) {
            gps_uart->rx_offset += len;

            char* line = (char*)gps_uart->rx_buf;
            char* end = (char*)gps_uart->rx_buf + gps_uart->rx_offset;
            while(line < end) {
                char* newline = memchr(line, '\n', end - line);
                if(newline) {
                    *newline = '\0';
                    gps_uart_parse_line(gps_uart, line);
                    line = newline + 1;
                } else {
                    break;
                }
            }

            // Shift remaining bytes to the beginning of the buffer
            if(line > (char*)gps_uart->rx_buf) {
                size_t remaining = end - line;
                memmove(gps_uart->rx_buf, line, remaining);
                gps_uart->rx_offset = remaining;
            }
        }
    } while(len > 0);
}
