#pragma once

// Standalone GSR Audio mode on the Cardputer ADV.
//
// Kept apart from GPS + GSR, GSR Only, Live Stream, Diagnostics,
// Calibration, Wi-Fi Files and saved Options:
//   - Uses 16 bytes of static RAM when closed: the synth state, screen
//     history and 48 kHz sound buffers live in one heap block that exists
//     only while GSR Audio is open.
//   - The menu puts the GPS to sleep first (as for GSR Only). Starting opens
//     the GSR sensor with the saved calibration (read only) and a Core 0
//     audio task that streams 80 ms blocks of 48 kHz 16-bit sound on its own
//     speaker channel.
//   - Esc fades the sound out (the mute fade), lets it play out, stops the
//     audio task, powers down the GSR sensor and frees all the memory.

#include <M5Cardputer.h>

#include "biomap_session.h"
#include "gsr_sensor.h"

// Starts the GSR Audio sensor and Core 0 audio task. False if out of memory.
bool gsr_audio_cardputer_start(void);

// Fades out, stops the audio task, powers down the GSR sensor and frees all
// runtime memory (takes up to ~0.4 s). Safe to call when not open.
void gsr_audio_cardputer_stop(void);

// True only while the standalone GSR Audio mode is open.
bool gsr_audio_cardputer_active(void);

// Active GSR sensor while GSR Audio is open (nullptr when inactive), for the
// once-a-second USB status line.
const GsrSensor* gsr_audio_cardputer_sensor(void);

// Drives the 10 Hz GSR conditioning tick, top G0 button, and 30 FPS screen
// animation while GSR Audio is open.
bool gsr_audio_cardputer_poll(void);

// Handles Left/Right (soundscape), Up/Down (GSR sensitivity), and Enter (mute).
// Esc is handled by menu_cardputer.cpp.
bool gsr_audio_cardputer_key(SessionKey key);

// GSR Audio's extra typed keys, from the keyboard or USB serial. Returns
// true if `ch` was one of them (and acted on); always false when GSR Audio
// is not open, so other screens never see a difference.
//   Tab      next soundscape
//   - _      volume down 10%      = +  volume up 10%
//   [ {      sensitivity down     ] }  sensitivity up
bool gsr_audio_cardputer_char(int ch);

// Draws the dedicated 240 x 135 GSR Audio screen into `canvas`.
void gsr_audio_cardputer_draw(M5Canvas& canvas);
