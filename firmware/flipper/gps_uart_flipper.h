#pragma once

// GPS on the Flipper: USART1, the receive interrupt, and the app-lifetime
// port. All the GPS logic and read-outs are shared, in core/gps_uart.h;
// this adds only what needs the Flipper.
//
// Holds USART1 from gps_uart_port_open() to gps_uart_port_close()
// (Expansion Service disabled in between). The module starts awake at 115200
// so it can acquire satellites on the menu and between GPS sessions, and is
// put into standby by gps_uart_sleep() when entering non-GPS modes (GSR Only,
// Diagnostics, calibration) or exiting the app. Received bytes go from the
// interrupt into a stream buffer, and one EventTypeUart is posted to the
// app's queue; the main loop then calls gps_uart_process_rx().
// Thread safety: gps_uart_process_rx() and gps_uart_get_status() use an
// internal lock — do NOT hold the app mutex when calling gps_uart_process_rx().

#include <furi.h>
#include <furi_hal.h>
#include "core/gps_uart.h"

#define GPS_RX_BUF_SIZE   (1024 * 5)
#define GPS_UART_CH       FuriHalSerialIdUsart

// Lifecycle — caller owns event_queue until free() returns. See
// gps_uart_create() for what alloc does and how long it blocks.
GpsUart* gps_uart_alloc(FuriMessageQueue* event_queue, GpsNavModel nav_model, bool super_s);
void     gps_uart_free(GpsUart* gps);

// Call on each EventTypeUart: clears the "event posted" flag, then
// gps_uart_handle_rx().
void     gps_uart_process_rx(GpsUart* gps);

// App lifetime: open at app start, close at app exit. Open takes USART1 and
// brings the module up to 115200 awake (gps_uart_wake_to_fast()) so it starts
// acquiring satellites immediately. gps_uart_sleep() puts it into software
// standby (100 ms; no-op if already asleep) and starts counting stray bytes
// until the next alloc(). close() sleeps the module before releasing USART1.
// Safe with no module attached; if USART1 can't be taken, alloc() returns a
// GpsUart that is never ready.
void     gps_uart_port_open(void);
void     gps_uart_sleep(void);
void     gps_uart_port_close(void);

// Bytes received since the module was last put to sleep. Should stay 0
// while it sleeps; also logged when the idle stretch ends.
uint32_t gps_uart_get_idle_rx_count(void);
