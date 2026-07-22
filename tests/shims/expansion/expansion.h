#pragma once

// expansion/expansion.h — host-test shim.
// gps_uart.c disables/re-enables the Expansion Service around USART1
// ownership; the mechanism itself has no effect on NMEA parsing, so this
// is a pure no-op stub.

typedef struct Expansion Expansion;

static inline void expansion_enable(Expansion* e) { (void)e; }
static inline void expansion_disable(Expansion* e) { (void)e; }
