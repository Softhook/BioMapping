#pragma once

// furi_hal_speaker.h — host-test shim for flipper/sound.h, used by the cue
// tests (tests/test_cues.c). Defined in tests/shims/cue_mock.c, which
// records each call.

#include <stdbool.h>
#include <stdint.h>

bool furi_hal_speaker_acquire(uint32_t timeout);
void furi_hal_speaker_release(void);
void furi_hal_speaker_start(float frequency, float volume);
void furi_hal_speaker_stop(void);
