#pragma once

// GPS on the Flipper: USART1, the receive interrupt, and the app-lifetime
// port. All the GPS logic and read-outs are shared, in core/gps_uart.h;
// this adds only what needs the Flipper.
//
// Holds USART1 from gps_uart_port_open() to gps_uart_port_close()
// (Expansion Service disabled in between); the module sleeps whenever no
// GpsUart exists. Received bytes go from the interrupt into a stream
// buffer, and one EventTypeUart is posted to the app's queue; the main loop
// then calls gps_uart_process_rx().
// Thread safety: gps_uart_process_rx() and gps_uart_get_status() use an
// internal lock — do NOT hold the app mutex when calling gps_uart_process_rx().

#include <furi.h>
#include <furi_hal.h>
#include <notification/notification_messages.h>
#include "core/gps_uart.h"

#define GPS_RX_BUF_SIZE   (1024 * 5)
#define GPS_UART_CH       FuriHalSerialIdUsart

// Lifecycle — caller owns event_queue until free() returns. `notifications`
// is accepted for API-shape consistency with other module allocators but is
// not currently read or stored by this module. See gps_uart_create() for
// what alloc does and how long it blocks.
GpsUart* gps_uart_alloc(FuriMessageQueue* event_queue, NotificationApp* notifications,
                        GpsNavModel nav_model, bool super_s);
void     gps_uart_free(GpsUart* gps);

// Call on each EventTypeUart: clears the "event posted" flag, then
// gps_uart_handle_rx().
void     gps_uart_process_rx(GpsUart* gps);

// App lifetime: open at app start, close at app exit. Open takes USART1 and
// puts the module to sleep (gps_uart_sleep_from_unknown_state(): up to
// ~1.9 s); it then stays asleep between GPS sessions because the port is
// never released while the app runs. alloc() wakes it, free() sleeps it
// again. Safe with no module attached; if USART1 can't be taken, alloc()
// returns a GpsUart that is never ready.
void     gps_uart_port_open(void);
void     gps_uart_port_close(void);

// Bytes received since the module was last put to sleep. Should stay 0
// while it sleeps; also logged when the idle stretch ends.
uint32_t gps_uart_get_idle_rx_count(void);
