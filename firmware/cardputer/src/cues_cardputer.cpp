#include "cues_cardputer.h"

#include <M5Cardputer.h>

namespace {

struct Note {
    float    hz;
    uint32_t ms;
};

// About half volume: the bench's tone test used this level and found no
// effect on the GSR reading.
const uint8_t VOLUME = 128;

// Plays the notes one after another and waits until they finish, with
// the same 8 ms gap between notes as the Flipper. Waiting, like the
// Flipper, keeps the recording-start settle time (GSR_TONE_SETTLE_MS)
// counting from the real end of the sound.
void play(bool enabled, const Note* notes, size_t count) {
    if(!enabled) return;
    for(size_t i = 0; i < count; i++) {
        if(i > 0) delay(8);
        M5Cardputer.Speaker.tone(notes[i].hz, notes[i].ms);
        delay(notes[i].ms);
    }
}

template <size_t N>
void play(bool enabled, const Note (&notes)[N]) {
    play(enabled, notes, N);
}

const Note CLICK[]   = {{1800.0f, 35}};
const Note BACK[]    = {{1100.0f, 35}};
const Note CONFIRM[] = {{2200.0f, 45}};
const Note TOG_ON[]  = {{2400.0f, 45}};
const Note TOG_OFF[] = {{900.0f, 45}};
const Note RESET[]   = {{1400.0f, 45}, {1000.0f, 45}, {600.0f, 70}};
const Note REC_START[] = {{659.25f, 70}, {987.77f, 90}};
const Note REC_STOP[]  = {{987.77f, 70}, {659.25f, 90}};
const Note SUCCESS[] = {{880.0f, 60}, {1174.66f, 60}, {1567.98f, 130}};
const Note ERROR_[]  = {{600.0f, 90}, {450.0f, 130}};
const Note WARNING[] = {{550.0f, 110}, {550.0f, 110}};

}  // namespace

void cues_cardputer_begin(void) {
    M5Cardputer.Speaker.setVolume(VOLUME);
}

void cues_cardputer_play(bool sound_enabled, BioMapCue cue) {
    switch(cue) {
    case BioMapCueClick:     play(sound_enabled, CLICK); break;
    case BioMapCueBack:      play(sound_enabled, BACK); break;
    case BioMapCueConfirm:   play(sound_enabled, CONFIRM); break;
    case BioMapCueToggleOn:  play(sound_enabled, TOG_ON); break;
    case BioMapCueToggleOff: play(sound_enabled, TOG_OFF); break;
    case BioMapCueReset:     play(sound_enabled, RESET); break;
    case BioMapCueSuccess:   play(sound_enabled, SUCCESS); break;
    case BioMapCueError:     play(sound_enabled, ERROR_); break;

    case BioMapCueRecordingStarted:    play(sound_enabled, REC_START); break;
    case BioMapCueRecordingStopped:    play(sound_enabled, REC_STOP); break;
    case BioMapCueRecordingIncomplete: play(sound_enabled, WARNING); break;
    case BioMapCueSdWriteStoppedAlarm: play(sound_enabled, WARNING); break;
    case BioMapCueGpsColdStartDone:    play(sound_enabled, SUCCESS); break;
    case BioMapCueGpsColdStartFailed:  play(sound_enabled, ERROR_); break;

    // Light only.
    case BioMapCueHeartbeat:
    case BioMapCueHeartbeatFingersOff:
    case BioMapCueNoGpsFix:
    case BioMapCueSdRetrying:
    case BioMapCueSdWriteStopped:
    case BioMapCueStatusLightOff:
    case BioMapCueCount:
        break;
    }
}
