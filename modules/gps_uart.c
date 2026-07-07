// GPS UART — NMEA parser for Bio Mapping.
// Single-byte-per-IRQ RX pattern, adapted from ezod/flipperzero-gps.

#include "gps_uart.h"
#include "../biomap_events.h"

#include <furi.h>
#include <furi_hal.h>
#include <notification/notification_messages.h>
#include <expansion/expansion.h>
#include <math.h>
#include <string.h>

#define RX_LINE_BUF  1024      // max NMEA line length (~80 in practice)

struct GpsUart {
    GpsStatus            status;
    FuriMutex*           status_mutex;  // protects status field
    FuriHalSerialHandle* serial_handle;
    FuriStreamBuffer*    rx_stream;
    uint8_t              rx_buf[RX_LINE_BUF];
    size_t               rx_offset;
    FuriMessageQueue*    event_queue;
    NotificationApp*     notifications;   // caller-owned
    bool                 ready;
    volatile bool        rx_pending;
};

// UART IRQ — fires per received byte (ISR context).
// Posts a single EventTypeUart to the main queue; subsequent bytes are
// drained in gps_uart_process_rx() so the queue doesn't overflow.
static void gps_uart_irq_cb(
    FuriHalSerialHandle* handle,
    FuriHalSerialRxEvent event,
    void* context) {
    UNUSED(handle);
    GpsUart* g = (GpsUart*)context;
    if(event == FuriHalSerialRxEventData) {
        uint8_t data = furi_hal_serial_async_rx(handle);
        furi_stream_buffer_send(g->rx_stream, &data, 1, 0);
        if(!g->rx_pending) {
            g->rx_pending = true;
            PluginEvent ev = {.type = EventTypeUart};
            furi_message_queue_put(g->event_queue, &ev, 0);
        }
    }
}

// NMEA sentence dispatcher
static void gps_uart_parse_line(GpsUart* g, char* line) {
    // Log proprietary PCAS messages for configuration debugging (SBAS status, etc.)
    if(strncmp(line, "$PCAS", 5) == 0) {
        FURI_LOG_D("GpsUart", "PCAS Response: %s", line);
        return;
    }

    switch(minmea_sentence_id(line, false)) {
    case MINMEA_SENTENCE_RMC: {
        struct minmea_sentence_rmc frame;
        if(minmea_parse_rmc(&frame, line)) {
            g->status.fix_valid = frame.valid;
            // Only trust coordinates, speed, and course when the RMC
            // validity flag is 'A'.  Void RMC sentences have empty
            // fields that minmea_tofloat/mimmea_tocoord turn into NaN,
            // which would overwrite good values from a prior GGA sentence.
            // Time and date are still set — they're useful for timestamp
            // fallback even on void frames.
            if(frame.valid) {
                g->status.latitude  = minmea_tocoord(&frame.latitude);
                g->status.longitude = minmea_tocoord(&frame.longitude);
                g->status.speed     = minmea_tofloat(&frame.speed);
                g->status.course    = minmea_tofloat(&frame.course);
            }
            g->status.time = frame.time;
            g->status.date = frame.date;
        }
    } break;

    case MINMEA_SENTENCE_GGA: {
        struct minmea_sentence_gga frame;
        if(minmea_parse_gga(&frame, line)) {
            g->status.latitude           = minmea_tocoord(&frame.latitude);
            g->status.longitude          = minmea_tocoord(&frame.longitude);
            g->status.altitude           = minmea_tofloat(&frame.altitude);
            g->status.satellites_tracked = frame.satellites_tracked;
            g->status.fix_quality        = frame.fix_quality;
            // Only overwrite HDOP when the field is present — minmea_tofloat
            // returns NaN for empty fields, which would clobber a good reading
            // from a prior GSA sentence.
            float gga_hdop = minmea_tofloat(&frame.hdop);
            if(!isnan(gga_hdop)) g->status.hdop = gga_hdop;
            g->status.time               = frame.time;
        }
    } break;

    case MINMEA_SENTENCE_GSA: {
        struct minmea_sentence_gsa frame;
        if(minmea_parse_gsa(&frame, line)) {
            // GSA gives the authoritative DOP values and distinguishes
            // 2D (fix_type=2) from 3D (fix_type=3).  GGA HDOP is kept
            // as primary when GSA hasn't arrived yet; GSA overwrites only
            // when the field is present (non-NaN) to avoid clobbering a
            // good reading from a previous sentence.
            g->status.fix_type = frame.fix_type;
            float gsa_hdop = minmea_tofloat(&frame.hdop);
            float gsa_vdop = minmea_tofloat(&frame.vdop);
            if(!isnan(gsa_hdop)) g->status.hdop = gsa_hdop;
            if(!isnan(gsa_vdop)) g->status.vdop = gsa_vdop;
        }
    } break;

    case MINMEA_SENTENCE_GLL: {
        // GLL is disabled in the current PCAS config, but guard the validity
        // flag here so stale/void sentences never overwrite good coordinates.
        struct minmea_sentence_gll gll_frame;
        if(minmea_parse_gll(&gll_frame, line) && gll_frame.status == MINMEA_GLL_STATUS_DATA_VALID) {
            g->status.latitude  = minmea_tocoord(&gll_frame.latitude);
            g->status.longitude = minmea_tocoord(&gll_frame.longitude);
            g->status.time      = gll_frame.time;
        }
    } break;

    default:
        break;
    }
}

// ---------------------------------------------------------------------------
// Alloc — acquire USART1, init serial, configure GPS
// ---------------------------------------------------------------------------
static void gps_uart_configure(GpsUart* g);
GpsUart* gps_uart_alloc(FuriMessageQueue* event_queue, NotificationApp* notifications) {
    GpsUart* g = malloc(sizeof(GpsUart));
    furi_assert(g);

    g->event_queue   = event_queue;
    g->notifications = notifications;
    g->rx_offset     = 0;
    g->ready         = false;
    g->rx_pending    = false;
    g->status_mutex  = furi_mutex_alloc(FuriMutexTypeNormal);
    furi_assert(g->status_mutex);

    g->status = (GpsStatus){
        .latitude           = NAN,
        .longitude          = NAN,
        .altitude           = 0.0f,
        .speed              = NAN,    // set on first RMC sentence
        .course             = NAN,    // set on first RMC sentence
        .hdop               = 99.9f,
        .vdop               = 99.9f,
        .fix_quality        = 0,
        .fix_type           = 1,   // 1=no fix, 2=2D, 3=3D
        .satellites_tracked = 0,
        .fix_valid          = false,
        .time               = {0},
        .date               = {0},
    };

    g->rx_stream = furi_stream_buffer_alloc(GPS_RX_BUF_SIZE, 1);

    // Disable Expansion Service to free USART1 (re-enabled in free)
    Expansion* expansion = furi_record_open(RECORD_EXPANSION);
    expansion_disable(expansion);
    furi_record_close(RECORD_EXPANSION);

    g->serial_handle = furi_hal_serial_control_acquire(GPS_UART_CH);
    if(g->serial_handle) {
        furi_hal_serial_init(g->serial_handle, GPS_BAUD_RATE);
        furi_hal_serial_async_rx_start(g->serial_handle, gps_uart_irq_cb, g, false);
        g->ready = true;
        gps_uart_configure(g);
    } else {
        FURI_LOG_E("GpsUart", "Failed to acquire USART1");
    }

    return g;
}

// ---------------------------------------------------------------------------
// Free — release serial, re-enable Expansion Service
// ---------------------------------------------------------------------------
void gps_uart_free(GpsUart* g) {
    furi_assert(g);
    if(g->serial_handle) {
        furi_hal_serial_async_rx_stop(g->serial_handle);
        furi_hal_serial_deinit(g->serial_handle);
        furi_hal_serial_control_release(g->serial_handle);
    }
    Expansion* expansion = furi_record_open(RECORD_EXPANSION);
    expansion_enable(expansion);
    furi_record_close(RECORD_EXPANSION);
    furi_stream_buffer_free(g->rx_stream);
    furi_mutex_free(g->status_mutex);
    free(g);
}

// ---------------------------------------------------------------------------
// Status accessors
// ---------------------------------------------------------------------------
GpsStatus gps_uart_get_status(const GpsUart* g) {
    furi_assert(g);
    furi_mutex_acquire(g->status_mutex, FuriWaitForever);
    GpsStatus s = g->status;
    furi_mutex_release(g->status_mutex);
    return s;
}

bool gps_uart_is_ready(const GpsUart* g) {
    furi_assert(g);
    return g->ready;
}

// ---------------------------------------------------------------------------
// Helper — send a PCAS command over the GPS UART
// ---------------------------------------------------------------------------
static void pcas_tx(GpsUart* g, const char* cmd) {
    furi_hal_serial_tx(g->serial_handle, (const uint8_t*)cmd, strlen(cmd));
    furi_delay_ms(100);
}

// ---------------------------------------------------------------------------
// Drain RX stream, parse complete NMEA lines
// ---------------------------------------------------------------------------
void gps_uart_process_rx(GpsUart* g) {
    furi_assert(g);
    if(!g->ready) return;
    // Clear rx_pending BEFORE draining so that any new byte arriving from the
    // ISR mid-drain sets it true again and posts a fresh UART event to the queue.
    // If cleared AFTER the drain, an ISR byte arriving mid-drain would see
    // rx_pending=true (suppressing a new queue event) and then be left with no
    // event to trigger a follow-up drain — silently deferring until the next IRQ.
    g->rx_pending = false;

    size_t len;
    do {
        if(sizeof(g->rx_buf) - 1 - g->rx_offset == 0) {
            FURI_LOG_W("GpsUart", "RX buffer full — resetting");
            g->rx_offset = 0;
            gps_uart_send_hot_start(g);
        }

        len = furi_stream_buffer_receive(
            g->rx_stream,
            g->rx_buf + g->rx_offset,
            sizeof(g->rx_buf) - 1 - g->rx_offset,
            0);

        if(len > 0) {
            g->rx_offset += len;
            char* line = (char*)g->rx_buf;
            char* end  = (char*)g->rx_buf + g->rx_offset;

            // Parse each complete line, holding status_mutex only for the
            // brief status update — not for the entire drain.
            furi_mutex_acquire(g->status_mutex, FuriWaitForever);
            while(line < end) {
                char* nl = memchr(line, '\n', end - line);
                if(nl) {
                    *nl = '\0';
                    gps_uart_parse_line(g, line);
                    line = nl + 1;
                } else {
                    break;
                }
            }
            furi_mutex_release(g->status_mutex);

            if(line > (char*)g->rx_buf) {
                size_t remaining = end - line;
                memmove(g->rx_buf, line, remaining);
                g->rx_offset = remaining;
            }
        }
    } while(len > 0);
}

// ---------------------------------------------------------------------------
// Send init sequence: constellations, NMEA filter, 1 Hz rate
// ---------------------------------------------------------------------------
static void gps_uart_configure(GpsUart* g) {
    furi_assert(g);
    if(!g->ready || !g->serial_handle) return;
    FURI_LOG_I("GpsUart", "Configuring GPS");
    pcas_tx(g, "$PCAS04,7*1E\r\n");                             // GPS+BeiDou+GLONASS
    pcas_tx(g, "$PCAS03,1,0,1,0,1,0,0,0,0,0,,,0,0*03\r\n");   // GGA + GSA + RMC
    pcas_tx(g, "$PCAS02,1000*2E\r\n");                          // 1 Hz update rate
    pcas_tx(g, "$PCAS06,1,1*07\r\n");                           // Force-enable SBAS corrections (WAAS/EGNOS)
}

// ---------------------------------------------------------------------------
// Hot Start reset
// ---------------------------------------------------------------------------
void gps_uart_send_hot_start(GpsUart* g) {
    furi_assert(g);
    if(!g->ready || !g->serial_handle) return;
    FURI_LOG_I("GpsUart", "Hot Start reset");
    pcas_tx(g, "$PCAS10,0*1C\r\n");
}

