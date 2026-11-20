// test_cues.c — Host-side test for flipper/biomap_cues_flipper.c: each cue
// in core/biomap_cues.h gives exactly the light and tones the app used for
// that moment before cues existed, light-only cues never touch the speaker
// (they are sent with the app's lock held, where a tone would freeze the
// screen), and Options > Sound off silences every tone but keeps the light.
//
// The expected table below was written from the code the cues replaced
// (the old sequences in biomap_session.c and biomap.c, and the tones in
// flipper/sound.h, whose values didn't change), not from the cue file.
//
// Build: ./run_tests.sh (or see that script for the raw gcc invocation).

#include <assert.h>
#include <math.h>
#include <stdio.h>
#include <string.h>

#include "flipper/biomap_cues_flipper.h"
#include "cue_mock.h"

#define MAX_EXPECTED 3

typedef struct {
    const char* lights[MAX_EXPECTED]; // NULL-terminated
    float notes[MAX_EXPECTED];        // 0-terminated, Hz
    const char* order;                // 'L' = light, 'S' = note
    float volume;                     // every note's volume; unused for light-only cues
} Expected;

// flipper/sound.h: key feedback at the normal volume, everything else at
// the alert volume. Literal here, not the macros, so a change there fails.
#define VOL_N 0.9f
#define VOL_A 1.0f

// Indexed by cue. A cue missing here is all zeros and fails "does something".
static const Expected expected[BioMapCueCount] = {
    [BioMapCueClick]     = {{NULL}, {1800.0f}, "S", VOL_N},
    [BioMapCueBack]      = {{NULL}, {1100.0f}, "S", VOL_N},
    [BioMapCueConfirm]   = {{NULL}, {2200.0f}, "S", VOL_N},
    [BioMapCueToggleOn]  = {{NULL}, {2400.0f}, "S", VOL_N},
    [BioMapCueToggleOff] = {{NULL}, {900.0f}, "S", VOL_N},
    [BioMapCueReset]     = {{NULL}, {1400.0f, 1000.0f, 600.0f}, "SSS", VOL_A},
    [BioMapCueSuccess]   = {{NULL}, {880.0f, 1174.66f, 1567.98f}, "SSS", VOL_A},
    [BioMapCueError]     = {{NULL}, {600.0f, 450.0f}, "SS", VOL_A},

    [BioMapCueRecordingStarted]    = {{NULL}, {659.25f, 987.77f}, "SS", VOL_A},
    [BioMapCueRecordingStopped]    = {{"sequence_blink_stop"}, {987.77f, 659.25f}, "LSS", VOL_A},
    [BioMapCueRecordingIncomplete] = {{"sequence_blink_stop"}, {550.0f, 550.0f}, "LSS", VOL_A},

    [BioMapCueHeartbeat]           = {{"green_255+delay_500+green_0"}, {0}, "L", VOL_A},
    [BioMapCueHeartbeatFingersOff] = {{"red_255+delay_500+red_0"}, {0}, "L", VOL_A},
    [BioMapCueNoGpsFix]            = {{"sequence_blink_blue_100"}, {0}, "L", VOL_A},

    [BioMapCueSdRetrying]          = {{"sequence_blink_red_100"}, {0}, "L", VOL_A},
    [BioMapCueSdWriteStopped]      = {{"sequence_set_only_red_255"}, {0}, "L", VOL_A},
    [BioMapCueSdWriteStoppedAlarm] = {{NULL}, {550.0f, 550.0f}, "SS", VOL_A},
    [BioMapCueStatusLightOff]      = {{"sequence_reset_red"}, {0}, "L", VOL_A},

    [BioMapCueGpsColdStartDone]   = {{"sequence_blink_green_100"}, {880.0f, 1174.66f, 1567.98f}, "LSSS", VOL_A},
    [BioMapCueGpsColdStartFailed] = {{"sequence_blink_red_100"}, {600.0f, 450.0f}, "LSS", VOL_A},
};

static NotificationApp* const k_app = (NotificationApp*)0x1; // never dereferenced by the mock

static int count_lights(const Expected* e) {
    int n = 0;
    while(n < MAX_EXPECTED && e->lights[n]) n++;
    return n;
}

static int count_notes(const Expected* e) {
    int n = 0;
    while(n < MAX_EXPECTED && e->notes[n] > 0.0f) n++;
    return n;
}

// Every cue, Sound on: the same lights, tones (pitch and volume) and order
// as before. Tone lengths aren't checked: the shims' furi_delay_ms() records
// nothing.
static void test_each_cue_matches_old_response(void) {
    printf("Running test_each_cue_matches_old_response...\n");
    for(int c = 0; c < BioMapCueCount; c++) {
        const Expected* e = &expected[c];
        assert(e->order && "cue missing from the expected table");
        cue_mock_reset();
        biomap_cue(k_app, true, (BioMapCue)c);

        assert(cue_mock.light_count == count_lights(e));
        for(int i = 0; i < cue_mock.light_count; i++) {
            assert(strcmp(cue_mock.lights[i], e->lights[i]) == 0);
        }
        assert(cue_mock.note_count == count_notes(e));
        for(int i = 0; i < cue_mock.note_count; i++) {
            assert(fabsf(cue_mock.notes[i].freq - e->notes[i]) < 0.01f);
            assert(fabsf(cue_mock.notes[i].volume - e->volume) < 0.001f);
        }
        cue_mock.order[cue_mock.order_count] = '\0';
        assert(strcmp(cue_mock.order, e->order) == 0);
        assert(cue_mock.speaker_acquired == cue_mock.speaker_released);
    }
    printf("  -> Pass (%d cues)\n", (int)BioMapCueCount);
}

// Light-only cues may be sent with the app's lock held (core/biomap_cues.h,
// rule 1), so they must never reach the speaker, whatever the Sound
// setting.
static void test_light_cues_never_touch_speaker(void) {
    printf("Running test_light_cues_never_touch_speaker...\n");
    int light_only = 0;
    for(int c = 0; c < BioMapCueCount; c++) {
        if(count_notes(&expected[c]) > 0) continue;
        light_only++;
        for(int sound = 0; sound <= 1; sound++) {
            cue_mock_reset();
            biomap_cue(k_app, sound == 1, (BioMapCue)c);
            assert(cue_mock.speaker_acquired == 0);
            assert(cue_mock.note_count == 0);
        }
    }
    assert(light_only == 6);
    printf("  -> Pass (%d light-only cues)\n", light_only);
}

// Sound off: no tone at all, the light unchanged (rule 4).
static void test_sound_off_keeps_lights(void) {
    printf("Running test_sound_off_keeps_lights...\n");
    for(int c = 0; c < BioMapCueCount; c++) {
        const Expected* e = &expected[c];
        cue_mock_reset();
        biomap_cue(k_app, false, (BioMapCue)c);
        assert(cue_mock.speaker_acquired == 0);
        assert(cue_mock.note_count == 0);
        assert(cue_mock.light_count == count_lights(e));
        for(int i = 0; i < cue_mock.light_count; i++) {
            assert(strcmp(cue_mock.lights[i], e->lights[i]) == 0);
        }
    }
    printf("  -> Pass\n");
}

// Sound-only cues may be sent without a NotificationApp (the header says
// so); they must not touch it.
static void test_sound_cues_need_no_notifications(void) {
    printf("Running test_sound_cues_need_no_notifications...\n");
    for(int c = 0; c < BioMapCueCount; c++) {
        if(count_lights(&expected[c]) > 0) continue;
        cue_mock_reset();
        biomap_cue(NULL, true, (BioMapCue)c);
        assert(cue_mock.light_count == 0);
        assert(cue_mock.note_count == count_notes(&expected[c]));
    }
    printf("  -> Pass\n");
}

int main(void) {
    test_each_cue_matches_old_response();
    test_light_cues_never_touch_speaker();
    test_sound_off_keeps_lights();
    test_sound_cues_need_no_notifications();
    printf("All cue tests passed!\n");
    return 0;
}
