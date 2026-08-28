#pragma once

// biomap_events.h — Shared event types for Bio Mapping
//
// Both biomap.c and modules/gps_uart.c post to the same FuriMessageQueue.
// The queue is allocated with sizeof(PluginEvent) as the item size, so EVERY
// caller must post an object of exactly that size.  Centralising the type here
// guarantees they agree — no padding hacks, no undefined behaviour.

#include <input/input.h>

typedef enum {
    EventTypeTick = 0,
    EventTypeKey  = 1,
    EventTypeUart = 2,
} EventType;

// Every event posted to the main queue must fit this struct exactly.
// The `input` field is only meaningful when type == EventTypeKey.
typedef struct {
    EventType  type;
    InputEvent input;
} PluginEvent;
