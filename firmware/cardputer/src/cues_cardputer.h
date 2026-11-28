#pragma once

// Cues on the Cardputer: each cue in core/biomap_cues.h as a sound.
//
// The tones come from the shared palette in core/biomap_cues.h
// (biomap_cue_notes()), so both devices sound the same. The Cardputer has no
// status light yet, so the light-only cues (heartbeat, SD retrying, ...) do
// nothing for now; the screen shows the same states.
//
// Virtual speaker channels on M5Unified's 8-channel mixer:
//   0..4  start-up splash bells (splash_anim.c)
//   5     full-volume alerts, calibration tones & recording chirps (below)
//   6     continuous GSR Audio synthesis stream (gsr_audio_cardputer.cpp)
//   7     quiet menu navigation clicks (below)
// Note: M5Unified's `channel = -1` scans downward from channel 7, which would
// pick SPEAKER_CH_MENU (volume 64) whenever idle, so alerts use channel 5.

#include <stdint.h>

#include "biomap_cues.h"

constexpr uint8_t SPEAKER_CH_ALERT     = 5;
constexpr uint8_t SPEAKER_CH_GSR_AUDIO = 6;
constexpr uint8_t SPEAKER_CH_MENU      = 7;

void cues_cardputer_begin(void);
void cues_cardputer_play(bool sound_enabled, BioMapCue cue);
