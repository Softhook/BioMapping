#pragma once

// cue_mock.h — what tests/shims/cue_mock.c recorded.

#include <stdbool.h>
#include <stddef.h>
#include <notification/notification_messages.h>

#define CUE_MOCK_MAX  16
#define CUE_MOCK_TEXT 96

typedef struct {
    char lights[CUE_MOCK_MAX][CUE_MOCK_TEXT]; // each notification_message(), message names joined by '+'
    int  light_count;
    struct {
        float freq;
        float volume;
    } notes[CUE_MOCK_MAX];                     // each furi_hal_speaker_start()
    int  note_count;
    int  speaker_acquired;
    int  speaker_released;
    char order[2 * CUE_MOCK_MAX + 1];          // 'L' per light, 'S' per note, in call order
    int  order_count;
} CueMockLog;

extern CueMockLog cue_mock;
void cue_mock_reset(void);
