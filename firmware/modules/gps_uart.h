#pragma once

// GPS UART — NMEA parser for the u-blox SAM-M10Q GNSS module.
// Holds USART1 from gps_uart_port_open() to gps_uart_port_close() (Expansion
// Service disabled in between); the module sleeps whenever no GpsUart exists.
// Power management via UBX serial commands.
// Thread safety: gps_uart_process_rx() and gps_uart_get_status() use an
// internal status_mutex — do NOT hold the app mutex when calling them.

#include <furi.h>
#include <furi_hal.h>
#include <notification/notification_messages.h>
#include "../vendor/minmea/minmea.h"
#include "../biomap_config.h"

#define GPS_RX_BUF_SIZE   (1024 * 5)
#define GPS_BAUD_RATE     9600
#define GPS_BAUD_RATE_FAST 115200
#define GPS_UART_CH       FuriHalSerialIdUsart

typedef struct GpsStatus {
    double latitude;            // NaN = no fix yet (double for sub-metre precision)
    double longitude;
    float speed;                // knots (RMC)
    float course;               // degrees true
    float hdop;                 // Horizontal Dilution of Precision (GGA/GSA)
    float hacc;                 // Estimated horizontal accuracy in metres (PUBX 00); 99.9 = unknown
    int   fix_quality;          // GGA quality: 0=none, 1=GPS, 2=DGPS, 3=PPS, 4/5=RTK, 6=estimated
    int   fix_type;             // 1=none, 2=2D, 3=3D (GSA)
    int   satellites_tracked;   // satellites used in the navigation solution (PUBX 00 numSvs)
    bool  fix_valid;            // RMC status A and not an estimated (mode E) fix
    bool  sbas_active;          // an SBAS satellite (GSA SystemID 1, number 33-64) was in use this second or the last
    float pdop;                 // Position Dilution of Precision from GSA (chip-computed, all constellations); 99.9 = unknown
    struct minmea_time time;
    struct minmea_date date;
} GpsStatus;

// True when a GGA quality value is a satellite fix (1–5: GPS, DGPS, PPS,
// RTK). 6 is the receiver's own estimate from its motion model after losing
// the satellites — including ones it flags as invalid ("dead reckoning fix,
// but user limits exceeded", M10 SPG 5.10 interface description §2.5.5) —
// which the integration manual says not to use.
static inline bool gps_quality_is_gnss_fix(int q) {
    return q >= 1 && q <= 5;
}

// True when the latest RMC or GGA reports a satellite fix.
static inline bool gps_status_has_fix(const GpsStatus* s) {
    return s->fix_valid || gps_quality_is_gnss_fix(s->fix_quality);
}

typedef struct GpsUart GpsUart;

// Lifecycle — caller owns event_queue until free() returns. `notifications`
// is accepted for API-shape consistency with other module allocators but is
// not currently read or stored by this module.
// `super_s` true leaves the module's Super-S weak-signal compensation on
// automatic (its default); false switches it off (see ubx_send_super_s()).
GpsUart* gps_uart_alloc(FuriMessageQueue* event_queue, NotificationApp* notifications,
                        GpsNavModel nav_model, bool super_s);
void     gps_uart_free(GpsUart* gps);

GpsStatus gps_uart_get_status(const GpsUart* gps);
bool      gps_uart_is_ready(const GpsUart* gps);
void      gps_uart_process_rx(GpsUart* gps);
void      gps_uart_send_cold_start(GpsUart* gps);

// ── Contention diagnostics (see docs/archive/gps_rf_mutex_status.md) ──────────────
// Cumulative, monotonic counters — the caller (biomap_session.c) diffs or
// just logs the running totals, same pattern as gsr_sensor.c's iter_count.
//
// gps_uart_get_rx_drop_count(): incremented from ISR context
// (gps_uart_irq_cb) whenever a received byte can't be pushed into rx_stream
// because it's full — i.e. the main thread fell behind draining it. That is
// the direct symptom of a main-thread stall (e.g. behind a mutex) delaying
// UART event processing until rx_stream overflows.
uint32_t  gps_uart_get_rx_drop_count(const GpsUart* gps);

// gps_uart_get_nmea_fail_count(): incremented in gps_uart_parse_line()
// whenever a line fails NMEA checksum/format validation (minmea_sentence_id
// returns MINMEA_INVALID). A well-formed sentence of a type we don't act on
// (MINMEA_UNKNOWN) does NOT count — this is specifically a corruption/
// parse-failure proxy, not "sentences we ignore by design".
uint32_t  gps_uart_get_nmea_fail_count(const GpsUart* gps);

// gps_uart_get_reinit_count(): incremented once per gps_uart_reinit()
// call — a full baud-switch + module-reconfigure cycle, triggered either by
// the RX-buffer-full guard or the 5 s NMEA watchdog (both in
// gps_uart_process_rx()). Makes "the module got reconfigured N times
// mid-recording" visible in the CSV rather than only in the serial log.
uint32_t  gps_uart_get_reinit_count(const GpsUart* gps);

// gps_uart_get_chip_id(): best-effort GPS module chip serial number,
// polled via the binary UBX-SEC-UNIQID message and rendered as a 5-word
// mnemonic phrase (EFF short wordlist — see ubx_poll_chip_id() in
// gps_uart.c) rather than the raw 12-hex-digit value, e.g. "axis slang
// boast putt chunk" — 1296^5 >= 2^48, so this is a lossless, collision-free
// encoding of the chip ID, not just a recognisable label. Returns "" if
// not yet captured — the poll got no valid response. Not tied to a specific GpsUart allocation:
// a capture persists across gps_uart_free()/gps_uart_alloc() cycles
// within the same app session (file-scope cache), so a later mode switch
// can still see an ID found earlier.
const char* gps_uart_get_chip_id(const GpsUart* gps);

// App lifetime: open at app start, close at app exit. Open takes USART1 and
// puts the module to sleep (M10Q: up to ~1.9 s — wakes it first, see
// ubx_wake() in gps_uart.c); it then stays asleep between GPS sessions
// because the port is never released while the app runs. alloc() wakes it,
// free() sleeps it again. Safe with no module attached; if USART1 can't be
// taken, alloc() returns a GpsUart that is never ready.
void      gps_uart_port_open(void);
void      gps_uart_port_close(void);

// Bytes received since the module was last put to sleep. Should stay 0
// while it sleeps; also logged when the idle stretch ends.
uint32_t  gps_uart_get_idle_rx_count(void);
