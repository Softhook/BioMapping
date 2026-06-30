#pragma once

// GPS UART — NMEA parser for the L76K GNSS shield.
// Acquires USART1 at alloc (disables Expansion Service), re-enables at free.
// Power management via PCAS serial commands — no hardware control pins needed.
// Caller holds the app mutex for gps_uart_process_rx() and gps_uart_get_status().

#include <furi.h>
#include <furi_hal.h>
#include <notification/notification_messages.h>
#include "../minmea.h"

#define GPS_RX_BUF_SIZE   (1024 * 5)
#define GPS_BAUD_RATE     9600
#define GPS_UART_CH       FuriHalSerialIdUsart

typedef struct GpsStatus {
    float latitude;             // NaN = no fix yet
    float longitude;
    float altitude;
    float speed;                // knots (RMC)
    float course;               // degrees true
    int   fix_quality;          // 0=none, 1=GPS, 2=DGPS
    int   satellites_tracked;
    bool  fix_valid;            // from RMC
    struct minmea_time time;
    struct minmea_date date;
} GpsStatus;

typedef struct GpsUart GpsUart;

// Lifecycle — caller owns event_queue and notifications until free() returns.
GpsUart* gps_uart_alloc(FuriMessageQueue* event_queue, NotificationApp* notifications);
void     gps_uart_free(GpsUart* gps);

GpsStatus gps_uart_get_status(const GpsUart* gps);   // hold app mutex
bool      gps_uart_is_ready(const GpsUart* gps);
void      gps_uart_process_rx(GpsUart* gps);   // hold app mutex
void      gps_uart_configure(GpsUart* gps);
void      gps_uart_send_hot_start(GpsUart* gps);
void      gps_uart_send_factory_reset(GpsUart* gps);
