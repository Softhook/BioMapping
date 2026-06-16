#pragma once

// GPS UART Module for BioMapping 3.0
// Derived from ezod/flipperzero-gps — single-byte-per-IRQ UART RX pattern.
// Handles: serial acquire/init, NMEA line parsing (RMC/GGA/GLL),
//          and OTG 5V power for the L76K GNSS shield.
//
// The Expansion Service is disabled at alloc() and re-enabled at free() so
// that USART1 is available for us to acquire. This does NOT affect GPS power.
//
// GPS power-management is done via PCAS serial commands — no hardware
// control pins (STANDBY/RESET) are needed.
//
// Locking contract:
//   The caller (biomap.c) owns the mutex and must hold it when calling
//   gps_uart_process_rx() and gps_uart_get_status().
//   This module does NOT manage the mutex internally.

#include <furi.h>
#include <furi_hal.h>
#include <notification/notification_messages.h>
#include "../minmea.h"

#define GPS_RX_BUF_SIZE   (1024 * 5)
#define GPS_BAUD_RATE     9600
#define GPS_UART_CH       FuriHalSerialIdUsart

// Parsed GPS state — updated from NMEA sentences.
// NaN in lat/lon signals "no fix yet".
typedef struct GpsStatus {
    float latitude;
    float longitude;
    float altitude;
    char  altitude_units;
    float speed;   // knots (raw from RMC)
    float course;  // degrees true
    int   fix_quality;        // 0 = no fix, 1 = GPS, 2 = DGPS
    int   satellites_tracked;
    bool  fix_valid;          // from RMC sentence
    struct minmea_time time;
    struct minmea_date date;
} GpsStatus;

// Opaque handle — allocate with gps_uart_alloc()
typedef struct GpsUart GpsUart;

// Lifecycle.
//   event_queue:   the main app's FuriMessageQueue — receives EventTypeUart events
//   notifications: the app's open NotificationApp handle — used for LED blinks on
//                  each parsed NMEA sentence. The caller retains ownership and must
//                  keep it open until gps_uart_free() returns.
GpsUart* gps_uart_alloc(FuriMessageQueue* event_queue, NotificationApp* notifications);
void     gps_uart_free(GpsUart* gps_uart);

// Snapshot of current GPS status.
// Caller must hold the app mutex when calling this.
GpsStatus gps_uart_get_status(GpsUart* gps_uart);

// True if the serial handle was successfully acquired at init
bool gps_uart_is_ready(GpsUart* gps_uart);

// Drain the stream buffer and parse any complete NMEA lines.
// Call from the main event loop when EventTypeUart arrives.
// Caller must hold the app mutex when calling this.
void gps_uart_process_rx(GpsUart* gps_uart);

// Configure the GPS module (baud, update rate, constellations, NMEA filters)
void gps_uart_configure(GpsUart* gps_uart);

// Send a Hot Start command ($PCAS10,0*1C\r\n) to reset the GPS module
void gps_uart_send_hot_start(GpsUart* gps_uart);
