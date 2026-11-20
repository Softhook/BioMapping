// cue_mock.c — records the notification and speaker calls that
// flipper/biomap_cues_flipper.c makes, for tests/test_cues.c.

#include "cue_mock.h"
#include <furi_hal_speaker.h>
#include <string.h>

const NotificationMessage message_green_255 = {"green_255"};
const NotificationMessage message_green_0   = {"green_0"};
const NotificationMessage message_red_255   = {"red_255"};
const NotificationMessage message_red_0     = {"red_0"};
const NotificationMessage message_delay_500 = {"delay_500"};

// Each standard sequence holds one message naming it, so a test can tell
// which one was sent.
static const NotificationMessage m_blink_stop      = {"sequence_blink_stop"};
static const NotificationMessage m_blink_blue_100  = {"sequence_blink_blue_100"};
static const NotificationMessage m_blink_red_100   = {"sequence_blink_red_100"};
static const NotificationMessage m_blink_green_100 = {"sequence_blink_green_100"};
static const NotificationMessage m_set_only_red    = {"sequence_set_only_red_255"};
static const NotificationMessage m_reset_red       = {"sequence_reset_red"};
const NotificationSequence sequence_blink_stop       = {&m_blink_stop, NULL};
const NotificationSequence sequence_blink_blue_100   = {&m_blink_blue_100, NULL};
const NotificationSequence sequence_blink_red_100    = {&m_blink_red_100, NULL};
const NotificationSequence sequence_blink_green_100  = {&m_blink_green_100, NULL};
const NotificationSequence sequence_set_only_red_255 = {&m_set_only_red, NULL};
const NotificationSequence sequence_reset_red        = {&m_reset_red, NULL};

CueMockLog cue_mock;

void cue_mock_reset(void) {
    memset(&cue_mock, 0, sizeof(cue_mock));
}

// Writes the sequence's message names, joined by '+', as one light entry.
void notification_message(NotificationApp* app, const NotificationSequence* sequence) {
    (void)app;
    if(cue_mock.light_count >= CUE_MOCK_MAX) return;
    char* out = cue_mock.lights[cue_mock.light_count++];
    out[0] = '\0';
    for(int i = 0; (*sequence)[i]; i++) {
        if(i > 0) strncat(out, "+", CUE_MOCK_TEXT - strlen(out) - 1);
        strncat(out, (*sequence)[i]->name, CUE_MOCK_TEXT - strlen(out) - 1);
    }
    cue_mock.order[cue_mock.order_count++] = 'L';
}

bool furi_hal_speaker_acquire(uint32_t timeout) {
    (void)timeout;
    cue_mock.speaker_acquired++;
    return true;
}

void furi_hal_speaker_release(void) {
    cue_mock.speaker_released++;
}

void furi_hal_speaker_start(float frequency, float volume) {
    if(cue_mock.note_count >= CUE_MOCK_MAX) return;
    cue_mock.notes[cue_mock.note_count].freq = frequency;
    cue_mock.notes[cue_mock.note_count].volume = volume;
    cue_mock.note_count++;
    cue_mock.order[cue_mock.order_count++] = 'S';
}

void furi_hal_speaker_stop(void) {}
