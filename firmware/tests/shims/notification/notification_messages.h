#pragma once

// notification/notification_messages.h — host-test shim.
// gps_uart_alloc() takes a NotificationApp* but never dereferences it (an unused
// parameter carried through from the app layer); an opaque forward decl
// matching the real SDK's type name is enough for it to compile.

typedef struct NotificationApp NotificationApp;
