#pragma once

// GPS UART — NMEA parser for Quectel L76K / u-blox SAM-M10Q GNSS modules.
// Acquires USART1 at alloc (disables Expansion Service), re-enables at free.
// Power management via serial commands (PCAS on L76K, UBX on M10Q).
// Thread safety: gps_uart_process_rx() and gps_uart_get_status() use an
// internal status_mutex — do NOT hold the app mutex when calling them.

#include <furi.h>
#include <furi_hal.h>
#include <notification/notification_messages.h>
#include "../vendor/minmea/minmea.h"

#define GPS_RX_BUF_SIZE   (1024 * 5)
#define GPS_BAUD_RATE     9600
#define GPS_BAUD_RATE_FAST 115200
#define GPS_UART_CH       FuriHalSerialIdUsart

typedef struct GpsStatus {
    double latitude;            // NaN = no fix yet (double for sub-metre precision)
    double longitude;
    float altitude;
    float speed;                // knots (RMC)
    float course;               // degrees true
    float hdop;                 // Horizontal Dilution of Precision (GGA/GSA)
    float vdop;                 // Vertical Dilution of Precision (GSA)
    float hacc;                 // Estimated horizontal accuracy in metres (PUBX 00); 99.9 = unknown
    int   fix_quality;          // 0=none, 1=GPS, 2=DGPS (GGA)
    int   fix_type;             // 1=none, 2=2D, 3=3D (GSA)
    int   satellites_tracked;
    bool  fix_valid;            // from RMC
    bool  sbas_active;          // true when any GSA PRN >= 120 (SBAS satellite in use)
    float pdop;                 // Position Dilution of Precision from GSA (chip-computed, all constellations); 99.9 = unknown
    int8_t sat_elevation[512];  // elevation per PRN (constellation-offset), 0 = no data
    bool  gsv_fresh;            // complete GSV cycle received since last GSA
    int   active_prns[32];      // PRNs from current epoch's GSA sentences (constellation-offset)
    int   active_prn_count;     // number of active PRNs
    int   gsv_total_sats;       // sum of GSV total_sats across all constellations (real sat count)
    struct minmea_time time;
    struct minmea_date date;
} GpsStatus;

typedef struct GpsUart GpsUart;

#include "../biomap_config.h"

// Lifecycle — caller owns event_queue until free() returns. `notifications`
// is accepted for API-shape consistency with other module allocators but is
// not currently read or stored by this module.
GpsUart* gps_uart_alloc(FuriMessageQueue* event_queue, NotificationApp* notifications, GpsNavModel nav_model);
void     gps_uart_free(GpsUart* gps);

GpsStatus gps_uart_get_status(const GpsUart* gps);
bool      gps_uart_is_ready(const GpsUart* gps);
void      gps_uart_process_rx(GpsUart* gps);
void      gps_uart_send_hot_start(GpsUart* gps);

// ── Contention diagnostics (see docs/gps_rf_mutex_status.md) ──────────────
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
// not yet captured — e.g. L76K builds (no UBX protocol support), or the
// poll got no valid response. Not tied to a specific GpsUart allocation:
// a capture persists across gps_uart_free()/gps_uart_alloc() cycles
// within the same app session (file-scope cache), so a later mode switch
// can still see an ID found earlier.
const char* gps_uart_get_chip_id(const GpsUart* gps);

// Put the GPS module into its lowest-power standby/sleep state.
// Acquires USART1 briefly — does NOT require a full GpsUart allocation.
// Safe to call even when no module is connected (no-op on acquire failure).
void      gps_uart_standby(void);
