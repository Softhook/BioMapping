#include "cues_cardputer.h"

#include <M5Cardputer.h>

// About half volume: the bench's tone test used this level and found no
// effect on the GSR reading.
static const uint8_t VOLUME = 128;

// Menu sounds (moving, Back, OK, Options switches) are on a quieter
// channel: a quarter of the others' loudness. Recording, warning and
// calibration sounds keep the full level, so they are heard while walking.
static const uint8_t MENU_CHANNEL_VOLUME = 64;

// The ADV's sound chip (ES8311) is switched on by M5Unified at start-up,
// but its clock only starts with the first sound, and that start clicks.
// The clock then runs until power-off. So it is started here with silence,
// with the chip's own volume at mute (register 0x32), and the volume put
// back to M5Unified's 0 dB (0xBF) once it is running.
static const uint8_t ES8311_ADDR = 0x18;
static const uint8_t ES8311_DAC_VOLUME = 0x32;
static const uint8_t ES8311_DAC_VOLUME_MUTE = 0x00;
static const uint8_t ES8311_DAC_VOLUME_0DB = 0xBF;
static const int16_t SILENCE[480] = {};  // 10 ms at 48 kHz

static void start_sound_clock(void) {
    bool muted = M5.In_I2C.writeRegister8(ES8311_ADDR, ES8311_DAC_VOLUME, ES8311_DAC_VOLUME_MUTE, 400000);
    M5Cardputer.Speaker.playRaw(SILENCE, sizeof(SILENCE) / sizeof(SILENCE[0]), 48000, false, 10,
                                SPEAKER_CH_MENU, true);
    uint32_t start = millis();
    while(M5Cardputer.Speaker.isPlaying(SPEAKER_CH_MENU) && millis() - start < 500) delay(5);
    delay(50);
    if(muted) M5.In_I2C.writeRegister8(ES8311_ADDR, ES8311_DAC_VOLUME, ES8311_DAC_VOLUME_0DB, 400000);
}

void cues_cardputer_begin(void) {
    M5Cardputer.Speaker.setVolume(VOLUME);
    M5Cardputer.Speaker.setChannelVolume(SPEAKER_CH_MENU, MENU_CHANNEL_VOLUME);
    start_sound_clock();
}

// Plays the shared notes one after another and waits until they finish,
// with the same gap between notes as the Flipper (core/biomap_cues.h).
// Waiting keeps the recording-start settle time (GSR_TONE_SETTLE_MS)
// counting from the real end of the sound.
void cues_cardputer_play(bool sound_enabled, BioMapCue cue) {
    if(!sound_enabled) return;
    const BioMapCueNote* notes = nullptr;
    bool alert = false;
    size_t count = biomap_cue_notes(cue, &notes, &alert);
    if(count == 0) return;
    int channel = alert ? SPEAKER_CH_ALERT : SPEAKER_CH_MENU;
    for(size_t i = 0; i < count; i++) {
        if(i > 0) delay(BIOMAP_CUE_NOTE_GAP_MS);
        M5Cardputer.Speaker.tone(notes[i].freq_hz, notes[i].dur_ms, channel);
        delay(notes[i].dur_ms);
    }
}
