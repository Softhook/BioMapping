#pragma once

// notification/notification_messages.h — host-test shim.
// gps_uart.c stores a NotificationApp* but never dereferences it (unused
// field carried through from the app layer); an opaque forward decl
// matching the real SDK's type name is enough for it to compile.

typedef struct NotificationApp NotificationApp;
