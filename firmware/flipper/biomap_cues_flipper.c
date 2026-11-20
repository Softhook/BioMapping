// Cues on the Flipper: each cue in core/biomap_cues.h as an LED pattern
// (the notification service) and/or a tone (flipper/sound.h).

#include "biomap_cues_flipper.h"
#include "sound.h"

#include <furi.h>

// 500 ms blink — much more visible than the standard 100 ms flash.
// Green for normal recording, red when cuffs are disconnected.
static const NotificationSequence sequence_blink_green_500 = {
    &message_green_255,
    &message_delay_500,
    &message_green_0,
    NULL,
};
static const NotificationSequence sequence_blink_red_500 = {
    &message_red_255,
    &message_delay_500,
    &message_red_0,
    NULL,
};
// (sequence_blink_blue_100 and the others below are standard SDK
// sequences.)

static void light(NotificationApp* notifications, const NotificationSequence* seq) {
    furi_check(notifications, "biomap_cue: light cue without NotificationApp");
    notification_message(notifications, seq);
}

void biomap_cue(NotificationApp* notifications, bool sound_enabled, BioMapCue cue) {
    switch(cue) {
    case BioMapCueClick:     biomap_sound_click(sound_enabled); break;
    case BioMapCueBack:      biomap_sound_back(sound_enabled); break;
    case BioMapCueConfirm:   biomap_sound_confirm(sound_enabled); break;
    case BioMapCueToggleOn:  biomap_sound_toggle(sound_enabled, true); break;
    case BioMapCueToggleOff: biomap_sound_toggle(sound_enabled, false); break;
    case BioMapCueReset:     biomap_sound_reset(sound_enabled); break;
    case BioMapCueSuccess:   biomap_sound_success(sound_enabled); break;
    case BioMapCueError:     biomap_sound_error(sound_enabled); break;

    case BioMapCueRecordingStarted:
        biomap_sound_recording_start(sound_enabled);
        break;
    // sequence_blink_stop turns the status light off: the firmware's
    // notification service (applications/services/notification/
    // notification_app.c, 1.4.3) stops the LED's blink mode and resets the
    // red, green and blue notification layers. Sequences run one after
    // another, so a heartbeat blink already showing finishes first.
    case BioMapCueRecordingStopped:
        light(notifications, &sequence_blink_stop);
        biomap_sound_recording_stop(sound_enabled);
        break;
    case BioMapCueRecordingIncomplete:
        light(notifications, &sequence_blink_stop);
        biomap_sound_warning(sound_enabled);
        break;

    case BioMapCueHeartbeat:           light(notifications, &sequence_blink_green_500); break;
    case BioMapCueHeartbeatFingersOff: light(notifications, &sequence_blink_red_500); break;
    case BioMapCueNoGpsFix:            light(notifications, &sequence_blink_blue_100); break;

    case BioMapCueSdRetrying:          light(notifications, &sequence_blink_red_100); break;
    // Solid red, paired with the renderer's "REC STOPPED" banner. Nothing
    // turns it off but BioMapCueStatusLightOff.
    case BioMapCueSdWriteStopped:      light(notifications, &sequence_set_only_red_255); break;
    case BioMapCueSdWriteStoppedAlarm: biomap_sound_warning(sound_enabled); break;
    case BioMapCueStatusLightOff:      light(notifications, &sequence_reset_red); break;

    case BioMapCueGpsColdStartDone:
        light(notifications, &sequence_blink_green_100);
        biomap_sound_success(sound_enabled);
        break;
    case BioMapCueGpsColdStartFailed:
        light(notifications, &sequence_blink_red_100);
        biomap_sound_error(sound_enabled);
        break;

    case BioMapCueCount:
        break;
    }
}
