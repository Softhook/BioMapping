#pragma once

// GPS UART — NMEA parser for Quectel L76K / u-blox SAM-M10Q GNSS modules.
// Acquires USART1 at alloc (disables Expansion Service), re-enables at free.
// Power management via serial commands (PCAS on L76K, UBX on M10Q).
// Thread safety: gps_uart_process_rx() and gps_uart_get_status() use an
// internal status_mutex — do NOT hold the app mutex when calling them.

#include <furi.h>
#include <furi_hal.h>
#include <notification/notification_messages.h>
#include "../minmea.h"

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
    float hacc;                 // Estimated horizontal accuracy in meters (PUBX 00); 99.9 = unknown
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

// Lifecycle — caller owns event_queue and notifications until free() returns.
GpsUart* gps_uart_alloc(FuriMessageQueue* event_queue, NotificationApp* notifications, GpsNavModel nav_model);
void     gps_uart_free(GpsUart* gps);

GpsStatus gps_uart_get_status(const GpsUart* gps);
bool      gps_uart_is_ready(const GpsUart* gps);
void      gps_uart_process_rx(GpsUart* gps);
void      gps_uart_send_hot_start(GpsUart* gps);

// Put the GPS module into its lowest-power standby/sleep state.
// Acquires USART1 briefly — does NOT require a full GpsUart allocation.
// Safe to call even when no module is connected (no-op on acquire failure).
void      gps_uart_standby(void);
