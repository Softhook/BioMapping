#pragma once

// notification/notification_messages.h — host-test shim.
// gps_uart_alloc() takes a NotificationApp* but never dereferences it (an
// unused parameter carried through from the app layer). The cue tests
// (tests/test_cues.c) need a little more: the message and sequence types,
// the messages and sequences flipper/biomap_cues_flipper.c uses, and
// notification_message(), all defined in tests/shims/cue_mock.c, which
// records each call.

typedef struct NotificationApp NotificationApp;

// The real SDK's NotificationMessage is a typed struct; the tests only
// compare which message or sequence was sent, so a name is enough.
typedef struct {
    const char* name;
} NotificationMessage;
typedef const NotificationMessage* NotificationSequence[];

extern const NotificationMessage message_green_255;
extern const NotificationMessage message_green_0;
extern const NotificationMessage message_red_255;
extern const NotificationMessage message_red_0;
extern const NotificationMessage message_delay_500;

extern const NotificationSequence sequence_blink_stop;
extern const NotificationSequence sequence_blink_blue_100;
extern const NotificationSequence sequence_blink_red_100;
extern const NotificationSequence sequence_blink_green_100;
extern const NotificationSequence sequence_set_only_red_255;
extern const NotificationSequence sequence_reset_red;

void notification_message(NotificationApp* app, const NotificationSequence* sequence);
