#pragma once

// input/input.h — host-test shim.
// biomap_events.h only needs the InputEvent type to exist as a struct
// field of PluginEvent; gps_uart.c never reads or writes it.

typedef struct {
    int dummy;
} InputEvent;
