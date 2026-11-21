#include "cues_cardputer.h"

#include <M5Cardputer.h>

// About half volume: the bench's tone test used this level and found no
// effect on the GSR reading.
static const uint8_t VOLUME = 128;

void cues_cardputer_begin(void) {
    M5Cardputer.Speaker.setVolume(VOLUME);
}

// Plays the shared notes one after another and waits until they finish,
// with the same gap between notes as the Flipper (core/biomap_cues.h).
// Waiting keeps the recording-start settle time (GSR_TONE_SETTLE_MS)
// counting from the real end of the sound.
void cues_cardputer_play(bool sound_enabled, BioMapCue cue) {
    if(!sound_enabled) return;
    const BioMapCueNote* notes = nullptr;
    size_t count = biomap_cue_notes(cue, &notes, nullptr);
    for(size_t i = 0; i < count; i++) {
        if(i > 0) delay(BIOMAP_CUE_NOTE_GAP_MS);
        M5Cardputer.Speaker.tone(notes[i].freq_hz, notes[i].dur_ms);
        delay(notes[i].dur_ms);
    }
}
