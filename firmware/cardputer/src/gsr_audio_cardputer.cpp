#include "gsr_audio_cardputer.h"

#include <atomic>
#include <math.h>
#include <new>
#include <stdio.h>

#include "cues_cardputer.h"
#include "gsr_audio.h"
#include "gsr_cardputer.h"
#include "settings_cardputer.h"
#include "ui_theme.h"

// Three 80 ms buffers used in turn at 48 kHz (3,840 mono 16-bit samples =
// 7,680 bytes each), the speaker library's safe pattern for one producer
// that refills only when isPlaying() < 2. Bundled with the synth state and
// screen history in one heap block that exists only while GSR Audio is open.
static const size_t      RING_BUFFERS     = 3;
static const size_t      BLOCK_SAMPLES    = 3840;
static const UBaseType_t AUDIO_TASK_PRIO  = 3;
static const uint32_t    AUDIO_TASK_STACK = 4096;

// On Esc: how long to wait for the mute fade (~110 ms of sound, rendered up
// to two blocks ahead) and then for the queued blocks to play out.
static const uint32_t FADE_WAIT_MS  = 400;
static const uint32_t DRAIN_WAIT_MS = 250;

static const int VOL_STEP_PCT = 10;
static const int VOL_MIN_PCT  = 0;
static const int VOL_MAX_PCT  = 100;

static const int      HIST_LEN       = 112;
static const uint32_t SENS_FLASH_MS  = 1800;  // highlight sensitivity readout on change

struct SynthSnapshot {
    bool  has_contact   = false;
    float cur_u         = GSR_AUDIO_REST_NORM;
    float cur_hz        = 138.0f;
    float lpf3_ns       = 0.0f;
    float breath_level  = 0.0f;
    bool  breath_inhale = true;
};

// All runtime state, on the heap only while GSR Audio is open; the rest of
// the time this file keeps 16 bytes of static RAM.
struct AudioRuntime {
    bool              muted              = false;
    bool              sensor_avail       = false;
    GsrSensor*        gsr                = nullptr;
    SemaphoreHandle_t mutex              = nullptr;
    TaskHandle_t      task               = nullptr;
    std::atomic<bool> task_running{false};
    std::atomic<bool> task_finished{false};
    size_t            next_buf           = 0;
    uint32_t          last_tick_ms       = 0;
    uint32_t          last_anim_ms       = 0;
    uint32_t          sens_flash_until   = 0;
    SynthSnapshot     snap               = {};
    int               hist_head          = 0;
    int               hist_count         = 0;
    float             hist_u[HIST_LEN]   = {};
    GsrAudio          synth              = {};
    int16_t           bufs[RING_BUFFERS * BLOCK_SAMPLES] = {};
};

// Choices kept between visits until power-off (never saved to the SD card).
static AudioRuntime* g_rt         = nullptr;
static GsrAudioMode  g_voice_mode = GsrAudioDrone;
static int           g_vol_pct    = 80;  // -12 dB on the 60 dB logarithmic scale
static int           g_sens_pct   = GSR_AUDIO_SENS_DEF_PCT;

static void refresh_snapshot_locked(AudioRuntime* rt) {
    rt->snap.has_contact   = rt->synth.has_contact;
    rt->snap.cur_u         = rt->synth.cur_u;
    rt->snap.cur_hz        = rt->synth.cur_hz;
    rt->snap.lpf3_ns       = rt->synth.lpf3_ns;
    rt->snap.breath_level  = rt->synth.breath_level;
    rt->snap.breath_inhale = rt->synth.breath_inhale;
}

// Core 0 feeder task: keeps M5Unified's 2-slot queue on SPEAKER_CH_GSR_AUDIO fed
// with 80 ms blocks so the sound never runs dry.
static void audio_feeder_task(void* arg) {
    auto* rt = static_cast<AudioRuntime*>(arg);
    while(rt->task_running.load(std::memory_order_acquire)) {
        while(rt->task_running.load(std::memory_order_acquire) &&
              M5Cardputer.Speaker.isPlaying(SPEAKER_CH_GSR_AUDIO) < 2) {
            int16_t* block = rt->bufs + rt->next_buf * BLOCK_SAMPLES;
            xSemaphoreTake(rt->mutex, portMAX_DELAY);
            gsr_audio_render(&rt->synth, block, BLOCK_SAMPLES);
            xSemaphoreGive(rt->mutex);

            if(!M5Cardputer.Speaker.playRaw(block, BLOCK_SAMPLES, GSR_AUDIO_SAMPLE_RATE,
                                            false, 1, SPEAKER_CH_GSR_AUDIO, false)) {
                break;
            }
            rt->next_buf = (rt->next_buf + 1) % RING_BUFFERS;
        }
        vTaskDelay(5);
    }
    rt->task_finished.store(true, std::memory_order_release);
    vTaskDelete(nullptr);
}

bool gsr_audio_cardputer_start(void) {
    if(g_rt) {
        gsr_audio_cardputer_stop();
    }

    // Set up in this order and torn down in reverse (stop()).
    // Step 1: the runtime block
    auto* rt = new (std::nothrow) AudioRuntime();
    if(!rt) {
        Serial.println("[Audio] error: no memory for GSR Audio runtime");
        return false;
    }

    // Step 2: mutex
    rt->mutex = xSemaphoreCreateMutex();
    if(!rt->mutex) {
        delete rt;
        Serial.println("[Audio] error: no memory for audio mutex");
        return false;
    }

    // Step 3: GSR sensor and its worker (same set-up as GSR Only)
    rt->gsr = gsr_cardputer_start();
    if(rt->gsr) {
        gsr_sensor_set_calibration(rt->gsr, g_settings.cal_active,
                                   g_settings.cal_gain, g_settings.cal_zero_counts);
        rt->sensor_avail = gsr_sensor_available(rt->gsr);
    }

    if(g_voice_mode <= GsrAudioOff || g_voice_mode >= GsrAudioModeCount) {
        g_voice_mode = GsrAudioDrone;
    }
    for(int i = 0; i < HIST_LEN; i++) {
        rt->hist_u[i] = GSR_AUDIO_REST_NORM;
    }

    gsr_audio_init(&rt->synth, g_voice_mode);
    gsr_audio_set_volume_pct(&rt->synth, g_vol_pct);
    gsr_audio_set_sensitivity_pct(&rt->synth, g_sens_pct);
    refresh_snapshot_locked(rt);

    // The master volume stays at cues_cardputer's 128; this channel at its
    // default 255.
    M5Cardputer.Speaker.setChannelVolume(SPEAKER_CH_GSR_AUDIO, 255);

    // Step 4: Core 0 audio feeder task
    rt->task_finished.store(false, std::memory_order_release);
    rt->task_running.store(true, std::memory_order_release);
    if(xTaskCreatePinnedToCore(audio_feeder_task, "gsr_aud", AUDIO_TASK_STACK,
                               rt, AUDIO_TASK_PRIO, &rt->task, 0) != pdPASS) {
        rt->task_running.store(false, std::memory_order_release);
        if(rt->gsr) {
            gsr_cardputer_stop(rt->gsr);
        }
        vSemaphoreDelete(rt->mutex);
        delete rt;
        Serial.println("[Audio] error: audio task create failed");
        return false;
    }

    uint32_t now     = millis();
    rt->last_tick_ms = now;
    rt->last_anim_ms = now;
    g_rt             = rt;

    Serial.printf("[Audio] on: mode=%s rate=%d vol=%d%% sens=%d%%\n",
                  gsr_audio_mode_label(g_voice_mode),
                  GSR_AUDIO_SAMPLE_RATE,
                  g_vol_pct,
                  g_sens_pct);
    return true;
}

void gsr_audio_cardputer_stop(void) {
    AudioRuntime* rt = g_rt;
    if(!rt) return;
    g_rt = nullptr;

    // Step 4 in reverse. Fade out with the mute fade instead of cutting the
    // speaker mid-wave (which clicks): mute, wait until a block ending in
    // silence has been rendered, stop the task, then let the queued blocks
    // play out.
    if(rt->task) {
        xSemaphoreTake(rt->mutex, portMAX_DELAY);
        gsr_audio_set_mode(&rt->synth, GsrAudioOff);
        xSemaphoreGive(rt->mutex);
        uint32_t fade_start = millis();
        while(millis() - fade_start < FADE_WAIT_MS) {
            xSemaphoreTake(rt->mutex, portMAX_DELAY);
            bool silent = rt->synth.mode == GsrAudioOff && rt->synth.cur_gate == 0.0f;
            xSemaphoreGive(rt->mutex);
            if(silent) break;
            delay(5);
        }

        rt->task_running.store(false, std::memory_order_release);
        while(!rt->task_finished.load(std::memory_order_acquire)) {
            delay(1);
        }
        delay(3);  // lets FreeRTOS IDLE0 free the self-deleted task's TCB & 4 KB stack
        rt->task = nullptr;

        uint32_t drain_start = millis();
        while(M5Cardputer.Speaker.isPlaying(SPEAKER_CH_GSR_AUDIO) > 0 &&
              millis() - drain_start < DRAIN_WAIT_MS) {
            delay(1);
        }
    }
    M5Cardputer.Speaker.stop(SPEAKER_CH_GSR_AUDIO);  // only if the drain timed out
    uint32_t wait_start = millis();
    while(M5Cardputer.Speaker.isPlaying(SPEAKER_CH_GSR_AUDIO) > 0 && millis() - wait_start < 60) {
        delay(1);
    }

    // Step 3 in reverse: stop and power down the ADS1115.
    if(rt->gsr) {
        gsr_cardputer_stop(rt->gsr);
        rt->gsr = nullptr;
    }

    // Steps 2 and 1 in reverse: delete the mutex and free the runtime block.
    if(rt->mutex) {
        vSemaphoreDelete(rt->mutex);
        rt->mutex = nullptr;
    }
    delete rt;

    Serial.printf("[Audio] off (free heap %u)\n", (unsigned)ESP.getFreeHeap());
}

bool gsr_audio_cardputer_active(void) {
    return g_rt != nullptr;
}

const GsrSensor* gsr_audio_cardputer_sensor(void) {
    return g_rt ? g_rt->gsr : nullptr;
}

static void log_state(const AudioRuntime* rt) {
    Serial.printf("[Audio] mode=%s vol=%d%% sens=%d%%\n",
                  gsr_audio_mode_label(rt->muted ? GsrAudioOff : g_voice_mode),
                  g_vol_pct,
                  g_sens_pct);
}

static bool cycle_voice(bool next) {
    AudioRuntime* rt = g_rt;
    if(!rt) return false;
    g_voice_mode = gsr_audio_cycle_soundscape(g_voice_mode, next);
    rt->muted    = false;

    xSemaphoreTake(rt->mutex, portMAX_DELAY);
    gsr_audio_set_mode(&rt->synth, g_voice_mode);
    refresh_snapshot_locked(rt);
    xSemaphoreGive(rt->mutex);

    log_state(rt);
    return true;
}

static bool step_volume(bool up) {
    AudioRuntime* rt = g_rt;
    if(!rt) return false;
    int next = clampi(g_vol_pct + (up ? VOL_STEP_PCT : -VOL_STEP_PCT), VOL_MIN_PCT, VOL_MAX_PCT);
    g_vol_pct = next;
    if(up && rt->muted && next > 0) {
        rt->muted = false;
    }

    xSemaphoreTake(rt->mutex, portMAX_DELAY);
    gsr_audio_set_volume_pct(&rt->synth, g_vol_pct);
    if(!rt->muted && rt->synth.pending_mode == GsrAudioOff) {
        gsr_audio_set_mode(&rt->synth, g_voice_mode);
    }
    xSemaphoreGive(rt->mutex);

    log_state(rt);
    return true;
}

static bool step_sensitivity(bool up) {
    AudioRuntime* rt = g_rt;
    if(!rt) return false;
    g_sens_pct = clampi(g_sens_pct + (up ? GSR_AUDIO_SENS_STEP_PCT : -GSR_AUDIO_SENS_STEP_PCT),
                        GSR_AUDIO_SENS_MIN_PCT, GSR_AUDIO_SENS_MAX_PCT);
    rt->sens_flash_until = millis() + SENS_FLASH_MS;

    xSemaphoreTake(rt->mutex, portMAX_DELAY);
    gsr_audio_set_sensitivity_pct(&rt->synth, g_sens_pct);
    xSemaphoreGive(rt->mutex);

    log_state(rt);
    return true;
}

bool gsr_audio_cardputer_key(SessionKey key) {
    AudioRuntime* rt = g_rt;
    if(!rt) return false;

    switch(key) {
    case SessionKeyLeft:
        return cycle_voice(false);
    case SessionKeyRight:
        return cycle_voice(true);

    case SessionKeyUp:
        return step_sensitivity(true);
    case SessionKeyDown:
        return step_sensitivity(false);

    case SessionKeyOk:
        rt->muted = !rt->muted;
        xSemaphoreTake(rt->mutex, portMAX_DELAY);
        gsr_audio_set_mode(&rt->synth, rt->muted ? GsrAudioOff : g_voice_mode);
        xSemaphoreGive(rt->mutex);
        log_state(rt);
        return true;

    default:
        return false;
    }
}

bool gsr_audio_cardputer_char(int ch) {
    if(!g_rt) return false;
    switch(ch) {
    case '\t':
        return cycle_voice(true);
    case '-':
    case '_':
        return step_volume(false);
    case '=':
    case '+':
        return step_volume(true);
    case '[':
    case '{':
        return step_sensitivity(false);
    case ']':
    case '}':
        return step_sensitivity(true);
    default:
        return false;
    }
}

bool gsr_audio_cardputer_poll(void) {
    AudioRuntime* rt = g_rt;
    if(!rt || !rt->mutex) return false;

    bool redraw = false;

    // The G0 button on top steps to the next soundscape (easy to find by feel).
    if(M5Cardputer.BtnA.wasPressed()) {
        cycle_voice(true);
        redraw = true;
    }

    uint32_t now = millis();
    const uint32_t tick_ms = 1000 / TICK_HZ;
    uint32_t guard = 0;
    while(now - rt->last_tick_ms >= tick_ms && guard < 8) {
        rt->last_tick_ms += tick_ms;
        guard++;
        float raw_ns = 0.0f;
        bool  avail  = false;
        if(rt->gsr) {
            gsr_sensor_tick(rt->gsr);
            avail  = gsr_sensor_available(rt->gsr);
            raw_ns = gsr_sensor_get_raw(rt->gsr);
        }
        rt->sensor_avail = avail;

        xSemaphoreTake(rt->mutex, portMAX_DELAY);
        gsr_audio_tick(&rt->synth, raw_ns, avail);
        refresh_snapshot_locked(rt);
        float plot_u = rt->synth.has_contact ? rt->synth.cur_u : GSR_AUDIO_REST_NORM;
        xSemaphoreGive(rt->mutex);

        rt->hist_u[rt->hist_head] = plot_u;
        rt->hist_head = (rt->hist_head + 1) % HIST_LEN;
        if(rt->hist_count < HIST_LEN) rt->hist_count++;
    }
    if(now - rt->last_tick_ms >= tick_ms) {
        rt->last_tick_ms = now;
    }

    if(now - rt->last_anim_ms >= UI_ANIM_MS) {
        rt->last_anim_ms = now;
        xSemaphoreTake(rt->mutex, portMAX_DELAY);
        refresh_snapshot_locked(rt);
        xSemaphoreGive(rt->mutex);
        redraw = true;
    }

    return redraw;
}

static uint16_t mode_accent_color(GsrAudioMode m) {
    switch(m) {
    case GsrAudioBreath: return TFT_GREEN;
    case GsrAudioChord:  return 0xB5FF;     // soft lavender-blue
    case GsrAudioBowls:  return TFT_YELLOW;
    case GsrAudioRain:   return 0x66FF;     // sky-rain blue
    case GsrAudioDrone:
    default:             return TFT_CYAN;
    }
}

void gsr_audio_cardputer_draw(M5Canvas& canvas) {
    AudioRuntime* rt = g_rt;
    if(!rt) return;
    const SynthSnapshot snap = rt->snap;

    ui_reset_canvas(canvas);

    char right_hdr[32];
    uint16_t right_col;
    if(rt->muted) {
        snprintf(right_hdr, sizeof(right_hdr), "MUTED  %d%%", g_vol_pct);
        right_col = TFT_YELLOW;
    } else {
        snprintf(right_hdr, sizeof(right_hdr), "%s  %d%%",
                 gsr_audio_mode_label(g_voice_mode), g_vol_pct);
        right_col = mode_accent_color(g_voice_mode);
    }
    ui_draw_header(canvas, "GSR Audio", right_hdr, right_col);

    // Info row: live conductance (left), GSR sensitivity (centre), note/Hz (right)
    const bool contact = snap.has_contact;
    char left_info[24];
    if(!rt->sensor_avail) {
        snprintf(left_info, sizeof(left_info), "No GSR");
        canvas.setTextColor(TFT_RED);
    } else if(!contact) {
        snprintf(left_info, sizeof(left_info), "Touch cuffs");
        canvas.setTextColor(TFT_YELLOW);
    } else {
        float us = snap.lpf3_ns * 0.001f;
        snprintf(left_info, sizeof(left_info), "%.2f uS", (double)us);
        canvas.setTextColor(TFT_WHITE);
    }
    canvas.drawString(left_info, 6, 26);

    char sens_info[20];
    snprintf(sens_info, sizeof(sens_info), "Sens %d%%", g_sens_pct);
    bool sens_flash = (rt->sens_flash_until != 0) &&
                      ((int32_t)(rt->sens_flash_until - millis()) > 0);
    canvas.setTextColor(sens_flash ? TFT_CYAN : UI_COL_MUTED);
    int sw = canvas.textWidth(sens_info);
    canvas.drawString(sens_info, (UI_SCREEN_W - sw) / 2, 26);

    char note[8];
    char right_info[24];
    float show_hz = contact ? snap.cur_hz
                            : gsr_audio_norm_to_hz(g_voice_mode, GSR_AUDIO_REST_NORM);
    gsr_audio_hz_note_name(show_hz, note, sizeof(note));
    snprintf(right_info, sizeof(right_info), "%s %dHz", note, (int)lroundf(show_hz));
    uint16_t pitch_col = contact ? ui_spectrum565(snap.cur_u) : UI_COL_MUTED;
    canvas.setTextColor(pitch_col);
    int riw = canvas.textWidth(right_info);
    canvas.drawString(right_info, UI_SCREEN_W - riw - 6, 26);

    // Scrolling tension graph (x = 6..233, y = 45..111)
    const int gx = 6;
    const int gy = 45;
    const int gw = 228;
    const int gh = (g_voice_mode == GsrAudioBreath) ? 56 : 66;
    const int y_top = gy + 3;
    const int y_bot = gy + gh - 4;
    const int plot_h = y_bot - y_top;

    canvas.drawFastHLine(gx + 1, y_top + plot_h / 2, gw - 2, UI_COL_GRID);
    int y_rest = y_bot - (int)lroundf(GSR_AUDIO_REST_NORM * (float)plot_h);
    ui_draw_dashed_hline(canvas, gx + 3, gx + gw - 3, y_rest, UI_COL_FRAME, 5);

    if(contact && rt->hist_count >= 2) {
        const int plot_w = gw - 4;
        int prev_y = y_rest;
        for(int px = 0; px < plot_w; px++) {
            float pos = ((float)px / (float)(plot_w - 1)) * (float)(HIST_LEN - 1);
            int i0 = (int)pos;
            float frac = pos - (float)i0;
            if(i0 >= HIST_LEN - 1) { i0 = HIST_LEN - 2; frac = 1.0f; }

            int ring0 = (rt->hist_head + i0) % HIST_LEN;
            int ring1 = (rt->hist_head + i0 + 1) % HIST_LEN;
            float u = clampf(rt->hist_u[ring0] + frac * (rt->hist_u[ring1] - rt->hist_u[ring0]),
                             0.0f, 1.0f);

            int y_cur = clampi(y_bot - (int)lroundf(u * (float)plot_h), y_top, y_bot);
            if(px == 0) prev_y = y_cur;

            int x_cur = gx + 2 + px;
            uint16_t col  = ui_spectrum565(u, rt->muted ? 0.45f : 1.0f);
            uint16_t glow = ui_spectrum565(u, rt->muted ? 0.18f : 0.38f);
            ui_draw_glow_span(canvas, x_cur, prev_y, y_cur, y_top, y_bot, col, glow);
            prev_y = y_cur;
        }
    }
    canvas.drawRect(gx, gy, gw, gh, UI_COL_FRAME);

    if(g_voice_mode == GsrAudioBreath) {
        const int by = 104;
        const int bh = 8;
        canvas.drawRect(gx, by, gw, bh, UI_COL_FRAME);
        if(contact && !rt->muted) {
            int fill_w = (int)lroundf(snap.breath_level * (float)(gw - 2));
            if(fill_w > 1) {
                uint16_t bcol = snap.breath_inhale ? TFT_CYAN : 0x0555;
                canvas.fillRect(gx + 1, by + 1, fill_w, bh - 2, bcol);
            }
        }
    }

    ui_draw_footer(canvas, "<>:Sound  ^v:Sens  -/+:Vol  Esc");
}
