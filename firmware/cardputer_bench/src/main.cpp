// BioMapping bench test for the M5Stack Cardputer ADV.
//
// A throwaway program for checking that the Flipper prototyping board
// (ADS1115 GSR front end + SAM-M10Q GPS) works when wired to the Cardputer's
// EXT header with jumper leads. It is not the real firmware.
//
// Already confirmed on the device, so no longer shown: the I2C address list
// (the ADS1115 at 0x48 does not clash), PSRAM (none) and the clock chip (none).
//
// What it shows now:
//   - GSR with the board's open-circuit zero removed (press Z with nothing
//     connected), as nS and as the resistance across the electrodes;
//   - how noisy the 100 ms readings are, and the longest gap between reads;
//   - the 0.5 V bias, which shows whether the board's 3.3 V supply is right;
//   - GPS satellites used / heard / in view, their signal strength, and the
//     time to the first fix;
//   - battery voltage, the boot count and why the Cardputer last restarted
//     (a brownout here means the GPS's power draw reset it).
//
// Everything runs in loop() on one thread, so no bus lock is needed. The
// ADS1115 goes through M5's In_I2C, the same driver the keyboard uses:
// opening the same pins with Arduino's Wire would make two drivers fight.
//
// A once-a-second CSV line goes to the USB serial port (115200 baud).
// Keys: Z = set the zero, G = GSR graph on/off, R = reset the counters.
//
// Noise tests: each key switches on one thing the real firmware does, so
// its effect on the GSR noise can be seen (scripts/bench_noise.py groups the
// log by these settings):
//   B = Bluetooth: advertise, and send a Live Stream sized packet every
//       300 ms once a phone connects;
//   T = play the Flipper's recording-start chirp and measure how far the
//       GSR jumps and how long it takes to settle;
//   L = step the screen backlight through 128, 255, 64, 16 and off;
//   W = write a 10 s batch of rows to the SD card every 10 s; each press
//       tries a different way of writing (see the SD section).

#include <BLEDevice.h>
#include <BLEServer.h>
#include <M5Cardputer.h>
#include <Preferences.h>
#include <SD.h>
#include <SPI.h>
#include <esp_system.h>

// ── Pins and addresses ──────────────────────────────────────────────────────
static const int      GPS_RX_PIN = 15;  // ESP32 receives here ← M10Q TX
static const int      GPS_TX_PIN = 13;  // ESP32 sends here    → M10Q RX
static const uint8_t  ADS_ADDR   = 0x48;
static const uint32_t I2C_FREQ   = 400000;

// ── ADS1115 ─────────────────────────────────────────────────────────────────
// Same settings as the Flipper firmware: continuous mode, 860 SPS,
// comparator off, AIN0–AIN1 differential, autoranging between pga 2 and 5.
static const uint8_t REG_CONV = 0x00;
static const uint8_t REG_CFG  = 0x01;
static const uint8_t CFG_LSB  = 0xE3;  // 860 SPS, comparator disabled
static const uint8_t MUX_DIFF_01 = 0;  // AIN0 − AIN1 (the GSR signal)
static const uint8_t MUX_AIN1    = 5;  // AIN1 against GND (the 0.5 V bias)

static const uint8_t  PGA_MIN = 2, PGA_MAX = 5, PGA_DEFAULT = 2;
static const int32_t  NORM_FACTOR[6] = {24, 16, 8, 4, 2, 1};  // to ±0.256 V counts
static const float    PGA_FSR_V[6]   = {6.144f, 4.096f, 2.048f, 1.024f, 0.512f, 0.256f};
static const int16_t  SATURATE_THRESH = 30000;
static const int16_t  LOW_THRESH      = 4096;
static const int      LOW_COUNT       = 5;
static const uint32_t SETTLE_US       = 4000;   // discard reads after a config change
static const uint32_t BIAS_EVERY_MS   = 2000;

static const float VALID_MIN_NS = 100.0f;

// Zero step, as in the Flipper calibration wizard: the open-circuit reading
// (normalised counts) is subtracted before the TIA formula. A reading further
// from 0 than CAL_ZERO_MAX_COUNTS (firmware/core/biomap_config.h) means something
// is still connected, so it is refused.
static const float ZERO_MAX_COUNTS = 2000.0f;
static const int   ZERO_SECONDS    = 3;

// Same formula as gsr_tia_counts_to_ns_at_bias() in firmware/core/gsr_sensor.h:
// bias_scale is the measured bias over 0.5 V.
static float counts_to_ns(float counts, float bias_scale) {
    if(counts <= 0.0f) return 0.0f;
    float max_counts = 319000.0f * bias_scale;
    if(counts > max_counts) counts = max_counts;
    return (counts * 5000000.0f) / (15040000.0f * bias_scale - counts * 47.0f);
}

static uint8_t cfg_msb(uint8_t mux, uint8_t pga) {
    return (uint8_t)(0x80u | (mux << 4) | (pga << 1));
}

static Preferences prefs;

struct {
    bool     present = false;
    uint8_t  pga = PGA_DEFAULT;
    int      low_run = 0;
    uint32_t settle_until_us = 0;
    uint32_t last_bias_ms = 0;
    uint32_t last_retry_ms = 0;
    uint32_t last_read_us = 0;    // 0 = don't count the next gap (config just changed)
    // per-second accumulators
    int64_t  sum_norm = 0;
    uint32_t n = 0;
    uint32_t reads = 0;
    // 100 ms accumulators for the graph (the same window as one CSV row)
    int64_t  sum_norm_100 = 0;
    uint32_t n_100 = 0;
    // spread of the 100 ms values within the current second
    float    sec_lo = INFINITY, sec_hi = -INFINITY;
    int      sec_valid = 0, sec_ticks = 0;
    // results of the last full second
    float    ns = 0.0f;           // with the zero removed
    float    raw_mean = 0.0f;     // normalised counts, zero NOT removed
    float    noise_pp = NAN;      // max − min of the 100 ms values, nS
    uint32_t reads_per_s = 0;
    float    bias_mv = NAN;
    float    bias_scale = 1.0f;   // last in-range bias / 500 mV, as the firmware uses
    // since the last R
    uint32_t errors = 0;
    uint32_t pga_changes = 0;
    uint32_t max_gap_us = 0;
} ads;

struct {
    bool  set = false;
    float counts = 0.0f;
    int   pending = 0;            // seconds still to average after Z
    float sum = 0.0f;
} zero;

// A short message on the third screen line (zero result, tone result...).
static struct {
    char     text[40] = "";
    uint32_t until_ms = 0;
} msg;

static void set_msg(const char* m, uint32_t show_ms = 4000) {
    strncpy(msg.text, m, sizeof(msg.text) - 1);
    msg.text[sizeof(msg.text) - 1] = 0;
    msg.until_ms = millis() + show_ms;
}

static float corrected_ns(float raw_counts) {
    return counts_to_ns(raw_counts - (zero.set ? zero.counts : 0.0f), ads.bias_scale);
}

static bool ads_write_cfg(uint8_t mux, uint8_t pga) {
    uint8_t cfg[2] = {cfg_msb(mux, pga), CFG_LSB};
    return M5.In_I2C.writeRegister(ADS_ADDR, REG_CFG, cfg, 2, I2C_FREQ);
}

static bool ads_read_conv(int16_t* out) {
    uint8_t b[2];
    if(!M5.In_I2C.readRegister(ADS_ADDR, REG_CONV, b, 2, I2C_FREQ)) return false;
    *out = (int16_t)((b[0] << 8) | b[1]);
    return true;
}

static void ads_start_gsr(void) {
    if(ads_write_cfg(MUX_DIFF_01, ads.pga)) {
        ads.settle_until_us = micros() + SETTLE_US;
    } else {
        ads.errors++;
    }
    ads.last_read_us = 0;
}

static void ads_init(void) {
    ads.present = M5.In_I2C.scanID(ADS_ADDR, I2C_FREQ);
    if(ads.present) {
        ads.pga = PGA_DEFAULT;
        ads_start_gsr();
    }
}

// Switch to AIN1 vs GND for one reading, then back to the GSR signal.
// The bias should be 3.3 V × 10k / 66k = 500 mV.
static void ads_measure_bias(void) {
    const uint8_t pga = 3;  // ±1.024 V
    if(!ads_write_cfg(MUX_AIN1, pga)) { ads.errors++; return; }
    delayMicroseconds(SETTLE_US);
    int16_t raw;
    if(ads_read_conv(&raw)) {
        ads.bias_mv = raw * (PGA_FSR_V[pga] / 32768.0f) * 1000.0f;
        // Same window as GSR_BIAS_MIN_V..GSR_BIAS_MAX_V: outside it, keep the last good value.
        if(ads.bias_mv >= 450.0f && ads.bias_mv <= 550.0f) ads.bias_scale = ads.bias_mv / 500.0f;
    } else {
        ads.errors++;
    }
    ads_start_gsr();
}

static void ads_poll(void) {
    uint32_t now_ms = millis();
    if(!ads.present) {
        if(now_ms - ads.last_retry_ms > 1000) {
            ads.last_retry_ms = now_ms;
            ads_init();
        }
        return;
    }

    if(now_ms - ads.last_bias_ms >= BIAS_EVERY_MS) {
        ads.last_bias_ms = now_ms;
        ads_measure_bias();
        return;
    }

    uint32_t now_us = micros();
    if((int32_t)(now_us - ads.settle_until_us) < 0) return;

    int16_t raw;
    if(!ads_read_conv(&raw)) {
        ads.errors++;
        return;
    }
    ads.reads++;
    if(ads.last_read_us && now_us - ads.last_read_us > ads.max_gap_us) {
        ads.max_gap_us = now_us - ads.last_read_us;
    }
    ads.last_read_us = now_us;

    // Autoranging, same rules as the firmware.
    int16_t mag = raw < 0 ? -raw : raw;
    if(mag >= SATURATE_THRESH && ads.pga > PGA_MIN) {
        ads.pga--;
        ads.low_run = 0;
        ads.pga_changes++;
        ads_start_gsr();
        return;
    }
    if(mag < LOW_THRESH && ads.pga < PGA_MAX) {
        if(++ads.low_run >= LOW_COUNT) {
            ads.pga++;
            ads.low_run = 0;
            ads.pga_changes++;
            ads_start_gsr();
            return;
        }
    } else {
        ads.low_run = 0;
    }

    int32_t norm = (int32_t)raw * NORM_FACTOR[ads.pga];
    ads.sum_norm += norm;
    ads.n++;
    ads.sum_norm_100 += norm;
    ads.n_100++;
}

static void zero_start(void) {
    zero.pending = ZERO_SECONDS;
    zero.sum = 0.0f;
}

static void zero_second(void) {
    if(zero.pending <= 0) return;
    if(ads.n == 0) {  // no readings this second: give up rather than average nothing
        zero.pending = 0;
        set_msg("Zero failed: no readings");
        return;
    }
    zero.sum += ads.raw_mean;
    if(--zero.pending > 0) return;
    float z = zero.sum / ZERO_SECONDS;
    if(fabsf(z) > ZERO_MAX_COUNTS) {
        set_msg("Zero refused: disconnect");
        return;
    }
    zero.counts = z;
    zero.set = true;
    prefs.putFloat("zero", z);
    set_msg("Zero saved");
}

static void ads_second(void) {
    ads.reads_per_s = ads.reads;
    ads.reads = 0;
    if(ads.n > 0) {
        ads.raw_mean = (float)ads.sum_norm / (float)ads.n;
        ads.ns = corrected_ns(ads.raw_mean);
    } else {
        ads.raw_mean = 0.0f;
        ads.ns = 0.0f;
    }
    // Noise only when every 100 ms value in the second was a valid reading.
    ads.noise_pp = (ads.sec_ticks > 0 && ads.sec_valid == ads.sec_ticks)
        ? ads.sec_hi - ads.sec_lo : NAN;
    ads.sec_lo = INFINITY;
    ads.sec_hi = -INFINITY;
    ads.sec_valid = ads.sec_ticks = 0;
    zero_second();
    ads.sum_norm = 0;
    ads.n = 0;
}

// ── GSR graph ───────────────────────────────────────────────────────────────
// One point every 100 ms, so the 220 points across the screen cover 22 s.
// Open circuit (below VALID_MIN_NS) is stored as NAN and drawn as a gap.
static const int      GRAPH_POINTS = 220;
static const uint32_t GRAPH_STEP_MS = 100;
static const float    GRAPH_MIN_SPAN_NS = 2.0f;  // stop pure noise filling the screen

static struct {
    float    v[GRAPH_POINTS];
    int      head = 0;   // next slot to write
    int      count = 0;
} graph;

static bool show_graph = false;

static void tone_tick(float ns);

static void graph_tick(void) {
    float ns = NAN;
    if(ads.n_100 > 0) {
        float c = corrected_ns((float)ads.sum_norm_100 / (float)ads.n_100);
        if(c >= VALID_MIN_NS) ns = c;
    }
    ads.sum_norm_100 = 0;
    ads.n_100 = 0;
    ads.sec_ticks++;
    if(!isnan(ns)) {
        ads.sec_valid++;
        if(ns < ads.sec_lo) ads.sec_lo = ns;
        if(ns > ads.sec_hi) ads.sec_hi = ns;
    }
    graph.v[graph.head] = ns;
    graph.head = (graph.head + 1) % GRAPH_POINTS;
    if(graph.count < GRAPH_POINTS) graph.count++;
    tone_tick(ns);
}

// ── Noise tests ─────────────────────────────────────────────────────────────

// T: the Flipper's recording-start chirp (flipper/sound.h), then 3 s of
// watching the 100 ms values. The firmware waits GSR_TONE_SETTLE_MS (200 ms,
// biomap_session.c) after the chirp before it trusts the GSR again, so the
// question is whether the jump has died away within that.
// S: the same measurement with no sound. Ordinary jitter and slow wander also
// count as "disturbed", so a chirp result only means something next to the
// silent one: if both look alike, the speaker isn't the cause.
static const float    TONE_HZ[2] = {659.25f, 987.77f};
static const uint32_t TONE_MS[2] = {70, 90};
static const uint32_t TONE_TOTAL_MS = 160;
static const uint8_t  TONE_VOLUME = 128;
static const int      TONE_BASE_TICKS  = 20;  // 2 s of quiet before the tone
static const int      TONE_WATCH_TICKS = 30;  // 3 s from the start of the tone
static const float    TONE_MIN_BAND_NS = 0.1f;

static struct {
    bool     active = false;
    bool     silent = false;      // S: measure without playing anything
    bool     second_note_due = false;
    uint32_t start_ms = 0;
    int      ticks = 0;
    float    base = 0.0f;         // mean of the second before the tone
    float    band = 0.0f;         // how far from it counts as "still disturbed"
    float    jump = 0.0f;         // largest distance from base seen
    int      last_out = -1;       // last tick outside the band
    bool     result_new = false;  // a result for this second's log line
    float    result_jump = NAN;
    int      result_settle_ms = -1;
    bool     result_silent = false;
} chirp;

static void tone_start(bool silent) {
    if(chirp.active) return;
    // Baseline: the last 2 s of 100 ms values, all of them valid. Their full
    // spread (high minus low) is the band; 2 s rather than 1 s so ordinary
    // jitter in the next 3 s rarely pokes outside it by chance.
    if(graph.count < TONE_BASE_TICKS) { set_msg("Tone: wait 2 seconds"); return; }
    float sum = 0.0f, lo = INFINITY, hi = -INFINITY;
    for(int i = 1; i <= TONE_BASE_TICKS; i++) {
        float v = graph.v[(graph.head - i + GRAPH_POINTS) % GRAPH_POINTS];
        if(isnan(v)) { set_msg("Tone: fit a resistor first"); return; }
        sum += v;
        if(v < lo) lo = v;
        if(v > hi) hi = v;
    }
    chirp.base = sum / TONE_BASE_TICKS;
    chirp.band = fmaxf(hi - lo, TONE_MIN_BAND_NS);
    chirp.jump = 0.0f;
    chirp.last_out = -1;
    chirp.ticks = 0;
    chirp.active = true;
    chirp.silent = silent;
    chirp.second_note_due = !silent;
    chirp.start_ms = millis();
    if(!silent) M5Cardputer.Speaker.tone(TONE_HZ[0], TONE_MS[0]);
    set_msg(silent ? "Silent: measuring..." : "Tone: measuring...", 3500);
}

static void tone_poll(void) {
    if(chirp.second_note_due && millis() - chirp.start_ms >= TONE_MS[0]) {
        chirp.second_note_due = false;
        M5Cardputer.Speaker.tone(TONE_HZ[1], TONE_MS[1]);
    }
}

static void tone_tick(float ns) {
    if(!chirp.active) return;
    int i = chirp.ticks++;
    if(isnan(ns)) {
        chirp.last_out = i;  // a reading thrown out as open circuit is disturbed too
    } else {
        float d = fabsf(ns - chirp.base);
        if(d > chirp.jump) chirp.jump = d;
        if(d > chirp.band) chirp.last_out = i;
    }
    if(chirp.ticks < TONE_WATCH_TICKS) return;

    chirp.active = false;
    // Kept short: about 30 characters fit across the screen.
    const char* name = chirp.silent ? "Silent" : "Tone";
    char buf[40];
    if(chirp.last_out == TONE_WATCH_TICKS - 1) {
        chirp.result_settle_ms = -1;
        snprintf(buf, sizeof(buf), "%s %.2fnS >3s", name, chirp.jump);
    } else {
        // Ticks are 100 ms; the time counts from the end of the chirp (or
        // where it would have ended, for a silent run, so the two compare).
        int ms = (chirp.last_out + 1) * (int)GRAPH_STEP_MS - (int)TONE_TOTAL_MS;
        chirp.result_settle_ms = ms < 0 ? 0 : ms;
        snprintf(buf, sizeof(buf), "%s %.2fnS %dms", name, chirp.jump, chirp.result_settle_ms);
    }
    chirp.result_jump = chirp.jump;
    chirp.result_silent = chirp.silent;
    chirp.result_new = true;
    set_msg(buf, 15000);
}

// L: backlight steps. 255 is fully on; the levels in between dim it by
// switching the light on and off quickly, which can put noise on the supply.
static const uint8_t BACKLIGHT_LEVELS[] = {128, 255, 64, 16, 0};
static const int     BACKLIGHT_COUNT = sizeof(BACKLIGHT_LEVELS);
static int backlight_idx = 0;

static void backlight_next(void) {
    backlight_idx = (backlight_idx + 1) % BACKLIGHT_COUNT;
    M5Cardputer.Display.setBrightness(BACKLIGHT_LEVELS[backlight_idx]);
}

// B: Bluetooth. Live Stream sends a 49-byte packet every 300 ms
// (BT_STREAM_INTERVAL_MS, BT_STREAM_PACKET_SIZE). Without a phone connected
// the radio only advertises. Pressing B again stops all sending; the radio
// stays switched on but silent, so restart the Cardputer for a "never on"
// comparison.
static const char*    BLE_NAME = "BioMap bench";
static const char*    BLE_SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
static const char*    BLE_CHAR_UUID    = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";
static const uint32_t BLE_SEND_MS = 300;
static const size_t   BLE_PACKET_SIZE = 49;

static struct {
    bool              started = false;
    volatile bool     on = false;         // read by the Bluetooth task
    volatile bool     connected = false;  // written by the Bluetooth task
    BLEServer*        server = nullptr;
    BLECharacteristic* ch = nullptr;
    uint32_t          last_send_ms = 0;
    uint32_t          sent = 0;
} ble;

class BleCallbacks : public BLEServerCallbacks {
    void onConnect(BLEServer*) override { ble.connected = true; }
    void onDisconnect(BLEServer*) override {
        ble.connected = false;
        if(ble.on) BLEDevice::startAdvertising();
    }
};

static void ble_toggle(void) {
    if(ble.on) {
        ble.on = false;
        BLEDevice::stopAdvertising();
        if(ble.connected) ble.server->disconnect(ble.server->getConnId());
        return;
    }
    if(!ble.started) {
        BLEDevice::init(BLE_NAME);
        BLEDevice::setMTU(BLE_PACKET_SIZE + 3);
        ble.server = BLEDevice::createServer();
        ble.server->setCallbacks(new BleCallbacks());
        BLEService* svc = ble.server->createService(BLE_SERVICE_UUID);
        ble.ch = svc->createCharacteristic(BLE_CHAR_UUID,
            BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
        svc->start();
        BLEDevice::getAdvertising()->addServiceUUID(BLE_SERVICE_UUID);
        ble.started = true;
    }
    ble.on = true;
    BLEDevice::startAdvertising();
}

static void ble_poll(void) {
    if(!ble.on || !ble.connected) return;
    uint32_t now = millis();
    if(now - ble.last_send_ms < BLE_SEND_MS) return;
    ble.last_send_ms = now;
    uint8_t pkt[BLE_PACKET_SIZE];
    for(size_t i = 0; i < sizeof(pkt); i++) pkt[i] = (uint8_t)(ble.sent + i);
    ble.ch->setValue(pkt, sizeof(pkt));
    ble.ch->notify();
    ble.sent++;
}

static int ble_state(void) {  // for the log: 0 off, 1 advertising, 2 connected
    if(!ble.on) return 0;
    return ble.connected ? 2 : 1;
}

// W: SD card. A recording collects rows in memory and writes them in one go
// every FLUSH_INTERVAL (10 s, biomap_types.h): about 100 rows of a GPS + GSR
// file, then saves (syncs) the file. The write runs on this loop's thread, so
// the gap and reads/s suffer while it runs; the real firmware reads the GSR
// on its own thread.
//
// W steps through four ways of writing, to find what makes the write quick:
//   1 plain:    add to the end of the file, card at 25 MHz;
//   2 reserved: first reserve 8 MB, as the Flipper does at the start of a
//               recording (SD_LOGGER_PREALLOC_BYTES, modules/sd_logger.c),
//               so the card's file table isn't changed on every write;
//   3 sectors:  as 2, but each write is a whole number of 512-byte sectors;
//   4 40 MHz:   as 3, with the card at 40 MHz.
// Each starts the test file again from empty.
static const uint32_t SD_EVERY_MS = 10000;
static const size_t   SD_CHUNK_PLAIN   = 12000;
static const size_t   SD_CHUNK_SECTORS = 24 * 512;  // 12,288
static const uint32_t SD_RESERVE_BYTES = 8u * 1024u * 1024u;
static const char*    SD_PATH = "/bench_sd_test.csv";
static const int      SD_MODES = 4;
static const char* const SD_MODE_TEXT[SD_MODES + 1] = {"off", "plain", "reserved", "sectors", "40 MHz"};

static uint8_t sd_buf[SD_CHUNK_SECTORS];

static struct {
    uint32_t mounted_hz = 0;       // 0 = not mounted
    int      mode = 0;             // 0 = off, 1..SD_MODES as above
    File     f;
    uint32_t last_ms = 0;
    uint32_t write_ms_this_s = 0;  // for the log, 0 = no write this second
    uint32_t sync_ms_this_s = 0;   // the part of it spent saving the file
    uint32_t max_write_ms = 0;     // since the last R or the last W
} sd;

static void sd_fill_buffer(void) {
    static const char row[] =
        "1234.50,51.5012345,-0.1234567,0.9,1.6,12,3,1.20,123.4,4567.8,2.1\n";
    for(size_t i = 0; i < sizeof(sd_buf); i++) sd_buf[i] = row[i % (sizeof(row) - 1)];
}

static bool sd_mount(uint32_t hz) {
    if(sd.mounted_hz == hz) return true;
    if(sd.mounted_hz) SD.end();
    sd.mounted_hz = 0;
    int cs = M5.getPin(m5::pin_name_t::sd_spi_ss);
    SPI.begin(M5.getPin(m5::pin_name_t::sd_spi_sclk), M5.getPin(m5::pin_name_t::sd_spi_miso),
              M5.getPin(m5::pin_name_t::sd_spi_mosi), cs);
    if(!SD.begin(cs, SPI, hz)) return false;
    sd.mounted_hz = hz;
    return true;
}

static void sd_stop(const char* why) {
    sd.mode = 0;
    sd.f.close();
    if(why) set_msg(why);
}

static void sd_toggle(void) {
    int next = (sd.mode + 1) % (SD_MODES + 1);
    if(sd.mode) sd.f.close();
    sd.mode = 0;
    sd.max_write_ms = 0;
    if(next == 0) return;

    if(!sd_mount(next == 4 ? 40000000 : 25000000)) {
        set_msg(next == 4 ? "SD won't run at 40 MHz" : "SD card not found");
        return;
    }
    sd.f = SD.open(SD_PATH, FILE_WRITE);  // starts the file again from empty
    if(!sd.f) { set_msg("SD: can't open file"); return; }

    char buf[40];
    if(next >= 2) {
        // Reserve: jump to the far end, write one byte, save, come back.
        uint32_t t0 = millis();
        bool ok = sd.f.seek(SD_RESERVE_BYTES - 1) && sd.f.write((uint8_t)0) == 1;
        sd.f.flush();
        ok = ok && sd.f.seek(0);
        if(!ok) { sd_stop("SD: couldn't reserve 8 MB"); return; }
        snprintf(buf, sizeof(buf), "SD %d %s: 8 MB in %lu ms", next, SD_MODE_TEXT[next],
                 (unsigned long)(millis() - t0));
    } else {
        snprintf(buf, sizeof(buf), "SD %d %s", next, SD_MODE_TEXT[next]);
    }
    set_msg(buf);
    sd.mode = next;
    sd.last_ms = millis() - SD_EVERY_MS;  // first write straight away
}

static void sd_poll(void) {
    if(!sd.mode) return;
    uint32_t now = millis();
    if(now - sd.last_ms < SD_EVERY_MS) return;
    sd.last_ms = now;
    size_t len = sd.mode >= 3 ? SD_CHUNK_SECTORS : SD_CHUNK_PLAIN;
    uint32_t t0 = micros();
    size_t n = sd.f.write(sd_buf, len);
    uint32_t t1 = micros();
    sd.f.flush();  // pushes out what's left and saves the file (fsync)
    uint32_t t2 = micros();
    if(n != len) { sd_stop("SD write failed"); return; }
    if(sd.mode >= 2 && sd.f.position() + len > SD_RESERVE_BYTES) {
        // Past the reserved space (about 3 hours): start the file again.
        sd.f.seek(0);
    }
    uint32_t ms = (t2 - t0 + 999) / 1000;
    uint32_t sync_ms = (t2 - t1 + 999) / 1000;
    if(ms > sd.write_ms_this_s) { sd.write_ms_this_s = ms; sd.sync_ms_this_s = sync_ms; }
    if(ms > sd.max_write_ms) sd.max_write_ms = ms;
    char buf[40];
    snprintf(buf, sizeof(buf), "SD %d: %lu ms (save %lu)", sd.mode, (unsigned long)ms,
             (unsigned long)sync_ms);
    set_msg(buf, 3000);
}

// ── GPS ─────────────────────────────────────────────────────────────────────
// The M10Q starts at 9600 baud, but if the Flipper app has already run on the
// same power it may still be at 115200. Try each in turn until valid NMEA
// arrives. Sending a byte also wakes it if the Flipper left it in standby.
static const uint32_t GPS_BAUDS[2] = {9600, 115200};
static const uint32_t GPS_HUNT_MS  = 3000;
static const uint32_t GPS_LOST_MS  = 5000;
static const uint32_t GSV_STALE_MS = 3000;

// Satellites in view, from the GSV sentences. The M10Q sends a separate set
// of GSV messages per constellation AND per signal: signal 1 lists the
// satellites it hears (with their strength), signal 0 the ones it knows are
// up but can't hear. So each (constellation, signal) pair keeps its own slot.
// A set is committed when its last message arrives, so a half-received set
// is never counted.
static const int TALKERS = 6;
static const int SIGNALS = 16;  // NMEA 4.11 signal id, one hex digit
static const char* const TALKER_IDS[TALKERS] = {"GP", "GL", "GA", "GB", "GQ", "GN"};
static const int MAX_SV = 32;

struct Gsv {
    uint8_t  in_view = 0;
    uint8_t  n = 0, cno[MAX_SV];          // committed signal strengths (dB-Hz, > 0 only)
    uint8_t  tmp_n = 0, tmp_cno[MAX_SV];  // set being received
    uint32_t ms = 0;                      // when the set was committed
};

struct {
    int      baud_idx = 0;
    bool     locked = false;
    uint32_t phase_start_ms = 0;
    uint32_t last_good_ms = 0;
    char     line[100];
    size_t   len = 0;
    // per-second counters
    uint32_t bytes = 0, good = 0, bad = 0;
    // results of the last full second
    uint32_t bytes_per_s = 0, good_per_s = 0, bad_per_s = 0;
    int      fix = -1;        // GGA fix quality, -1 = no GGA yet
    int      used = -1;       // satellites used in the fix (GGA)
    float    hdop = NAN;
    char     utc[9] = "--:--:--";
    Gsv      gsv[TALKERS][SIGNALS];
    bool     gsv_seen = false;
    int      in_view = 0, heard = 0, best_cno = 0;
    float    top4_cno = NAN;  // mean of the four strongest: the usual u-blox quality figure
    uint32_t ttff_s = 0;      // seconds from start-up to the first fix, 0 = none yet
} gps;

static void gps_set_baud(int idx) {
    gps.baud_idx = idx;
    Serial1.updateBaudRate(GPS_BAUDS[idx]);
    Serial1.write((uint8_t)0xFF);  // wake from standby
    gps.phase_start_ms = millis();
    gps.len = 0;
}

static int hexval(char c) {
    if(c >= '0' && c <= '9') return c - '0';
    if(c >= 'A' && c <= 'F') return c - 'A' + 10;
    if(c >= 'a' && c <= 'f') return c - 'a' + 10;
    return -1;
}

static bool nmea_checksum_ok(const char* s) {
    if(s[0] != '$') return false;
    uint8_t sum = 0;
    const char* p = s + 1;
    while(*p && *p != '*') sum ^= (uint8_t)*p++;
    if(*p != '*') return false;
    int hi = hexval(p[1]), lo = hexval(p[2]);
    return hi >= 0 && lo >= 0 && ((hi << 4) | lo) == sum;
}

// Split a sentence into fields at ',' and '*' (the checksum becomes the last
// field). Returns the number of fields.
static int nmea_split(const char* s, char* buf, size_t buf_size, const char** field, int max_fields) {
    strncpy(buf, s, buf_size - 1);
    buf[buf_size - 1] = 0;
    int n = 0;
    char* p = buf;
    field[n++] = p;
    while(*p && n < max_fields) {
        if(*p == ',' || *p == '*') {
            *p = 0;
            field[n++] = p + 1;
        }
        p++;
    }
    return n;
}

// $xxGGA,time,lat,N,lon,E,fix,sats,hdop,...
static void gps_parse_gga(const char* s) {
    char buf[100];
    const char* field[10];
    int n = nmea_split(s, buf, sizeof(buf), field, 10);
    if(n < 9) return;
    const char* t = field[1];
    if(strlen(t) >= 6) {
        snprintf(gps.utc, sizeof(gps.utc), "%.2s:%.2s:%.2s", t, t + 2, t + 4);
    }
    gps.fix  = *field[6] ? atoi(field[6]) : 0;
    gps.used = *field[7] ? atoi(field[7]) : 0;
    gps.hdop = *field[8] ? atof(field[8]) : NAN;
    if(gps.fix > 0 && gps.ttff_s == 0) gps.ttff_s = millis() / 1000 + 1;
}

// $xxGSV,numMsg,msgNum,numSV,{svid,elev,az,cno}×(up to 4)[,signalId]*cs
static void gps_parse_gsv(const char* s) {
    int t = -1;
    for(int i = 0; i < TALKERS; i++) {
        if(strncmp(s + 1, TALKER_IDS[i], 2) == 0) { t = i; break; }
    }
    if(t < 0) return;
    char buf[100];
    const char* field[24];
    int n = nmea_split(s, buf, sizeof(buf), field, 24);
    if(n < 5) return;
    int num_msg = atoi(field[1]), msg_num = atoi(field[2]);
    // With a signal id, the fields after the satellites are signal + checksum.
    int sig = 0;
    if((n - 5) % 4 == 1) {
        sig = hexval(field[n - 2][0]);
        if(sig < 0) return;
    }
    Gsv& g = gps.gsv[t][sig];
    if(msg_num == 1) g.tmp_n = 0;
    int groups = (n - 5) / 4;  // works with or without the trailing signalId
    for(int i = 0; i < groups && i < 4; i++) {
        const char* cno = field[4 + 4 * i + 3];
        if(*cno && atoi(cno) > 0 && g.tmp_n < MAX_SV) g.tmp_cno[g.tmp_n++] = (uint8_t)atoi(cno);
    }
    if(msg_num == num_msg) {
        g.in_view = (uint8_t)atoi(field[3]);
        g.n = g.tmp_n;
        memcpy(g.cno, g.tmp_cno, g.tmp_n);
        g.ms = millis();
        gps.gsv_seen = true;
    }
}

// The Flipper app turns GSV off (gps_uart.c, ubx_send_nmea_output_rates), and
// the M10Q keeps that until it loses power. Turn it back on in RAM only
// (CFG-VALSET, layer RAM, CFG-MSGOUT-NMEA_ID_GSV_UART1 = 1), so the next
// power cycle undoes it.
static void gps_enable_gsv(void) {
    uint8_t msg[] = {
        0xB5, 0x62, 0x06, 0x8A, 0x09, 0x00,   // UBX CFG-VALSET, 9-byte payload
        0x00, 0x01, 0x00, 0x00,               // version 0, layer RAM, reserved
        0xC5, 0x00, 0x91, 0x20, 0x01,         // key 0x209100C5 = 1
        0x00, 0x00};                          // checksum, filled in below
    uint8_t a = 0, b = 0;
    for(size_t i = 2; i < sizeof(msg) - 2; i++) { a += msg[i]; b += a; }
    msg[sizeof(msg) - 2] = a;
    msg[sizeof(msg) - 1] = b;
    Serial1.write(msg, sizeof(msg));
}

static void gps_line(void) {
    gps.line[gps.len] = 0;
    if(gps.len < 6) return;
    if(!nmea_checksum_ok(gps.line)) {
        gps.bad++;
        return;
    }
    gps.good++;
    gps.last_good_ms = millis();
    if(!gps.locked) gps_enable_gsv();  // each time the right baud rate is found
    gps.locked = true;
    if(strncmp(gps.line + 3, "GGA", 3) == 0) gps_parse_gga(gps.line);
    else if(strncmp(gps.line + 3, "GSV", 3) == 0) gps_parse_gsv(gps.line);
}

static void gps_poll(void) {
    while(Serial1.available()) {
        char c = (char)Serial1.read();
        gps.bytes++;
        if(c == '$') gps.len = 0;
        if(c == '\r') continue;
        if(c == '\n') {
            gps_line();
            gps.len = 0;
        } else if(gps.len < sizeof(gps.line) - 1) {
            gps.line[gps.len++] = c;
        }
    }

    uint32_t now = millis();
    if(gps.locked && now - gps.last_good_ms > GPS_LOST_MS) gps.locked = false;
    if(!gps.locked && now - gps.phase_start_ms > GPS_HUNT_MS) {
        gps_set_baud(1 - gps.baud_idx);
    }
}

static void gps_second(void) {
    gps.bytes_per_s = gps.bytes;
    gps.good_per_s  = gps.good;
    gps.bad_per_s   = gps.bad;
    gps.bytes = gps.good = gps.bad = 0;

    // Sum the satellite picture over the constellations heard recently.
    uint8_t all[TALKERS * MAX_SV];
    int heard = 0, in_view = 0;
    uint32_t now = millis();
    for(int t = 0; t < TALKERS; t++) {
        for(int sg = 0; sg < SIGNALS; sg++) {
            const Gsv& g = gps.gsv[t][sg];
            if(g.ms == 0 || now - g.ms > GSV_STALE_MS) continue;
            in_view += g.in_view;
            int room = (int)sizeof(all) - heard;
            int k = g.n < room ? g.n : room;
            memcpy(all + heard, g.cno, k);
            heard += k;
        }
    }
    gps.in_view = in_view;
    gps.heard = heard;
    // Best four by partial selection sort.
    int top = heard < 4 ? heard : 4;
    for(int i = 0; i < top; i++) {
        int m = i;
        for(int j = i + 1; j < heard; j++) if(all[j] > all[m]) m = j;
        uint8_t tmp = all[i]; all[i] = all[m]; all[m] = tmp;
    }
    gps.best_cno = heard ? all[0] : 0;
    if(top == 4) {
        gps.top4_cno = (all[0] + all[1] + all[2] + all[3]) / 4.0f;
    } else {
        gps.top4_cno = NAN;
    }
}

// ── Power and restarts ──────────────────────────────────────────────────────
static uint32_t boot_count = 0;
static esp_reset_reason_t reset_reason = ESP_RST_UNKNOWN;
static int batt_mv = 0;

static const char* reset_text(esp_reset_reason_t r) {
    switch(r) {
    case ESP_RST_POWERON:   return "power on";
    case ESP_RST_SW:        return "software";
    case ESP_RST_PANIC:     return "CRASH";
    case ESP_RST_INT_WDT:
    case ESP_RST_TASK_WDT:
    case ESP_RST_WDT:       return "WATCHDOG";
    case ESP_RST_BROWNOUT:  return "BROWNOUT";
    case ESP_RST_EXT:       return "reset pin";
    case ESP_RST_DEEPSLEEP: return "sleep";
    case ESP_RST_USB:       return "USB";
    default:                return "other";
    }
}

static bool reset_is_bad(esp_reset_reason_t r) {
    return r == ESP_RST_PANIC || r == ESP_RST_INT_WDT || r == ESP_RST_TASK_WDT ||
           r == ESP_RST_WDT || r == ESP_RST_BROWNOUT;
}

// ── Keyboard ────────────────────────────────────────────────────────────────
static uint32_t key_presses = 0;

static void reset_counters(void) {
    ads.errors = 0;
    ads.pga_changes = 0;
    ads.max_gap_us = 0;
    sd.max_write_ms = 0;
    key_presses = 0;
}

static void keys_poll(void) {
    if(!M5Cardputer.Keyboard.isChange() || !M5Cardputer.Keyboard.isPressed()) return;
    auto& st = M5Cardputer.Keyboard.keysState();
    key_presses++;
    if(st.word.empty()) return;
    char c = st.word.back();
    if(c == 'z' || c == 'Z') zero_start();
    if(c == 'r' || c == 'R') reset_counters();
    if(c == 'g' || c == 'G') show_graph = !show_graph;
    if(c == 'b' || c == 'B') ble_toggle();
    if(c == 't' || c == 'T') tone_start(false);
    if(c == 's' || c == 'S') tone_start(true);
    if(c == 'l' || c == 'L') backlight_next();
    if(c == 'w' || c == 'W') sd_toggle();
}

// ── Screen and serial log ───────────────────────────────────────────────────
static M5Canvas canvas(&M5Cardputer.Display);

// Font 2 is 16 px tall: twice the size of the default font, and narrow enough
// for about 30 characters across the 240 px screen.
static const lgfx::IFont* const SCREEN_FONT = &fonts::Font2;
static const int LH = 16;  // line height in pixels

static void line_at(int& y, uint16_t colour) {
    canvas.setTextColor(colour, TFT_BLACK);
    canvas.setCursor(2, y);
    y += LH;
}

static void print_resistance(float ns) {
    float ohm = 1e9f / ns;
    if(ohm >= 1e6f) canvas.printf("%.2f Mohm", ohm / 1e6f);
    else canvas.printf("%.0f kohm", ohm / 1e3f);
}

static void draw_screen(void) {
    const int W = M5Cardputer.Display.width();
    const int H = M5Cardputer.Display.height();
    int y = 0;
    canvas.fillSprite(TFT_BLACK);

    // 1. Board: ADC found, bias and the supply worked out from it.
    if(!ads.present) {
        line_at(y, TFT_RED);
        canvas.print("ADC not found: check SDA/SCL");
    } else if(isnan(ads.bias_mv)) {
        line_at(y, TFT_DARKGREY);
        canvas.print("Bias -");
    } else {
        bool ok = fabsf(ads.bias_mv - 500.0f) < 15.0f;
        line_at(y, ok ? TFT_GREEN : TFT_RED);
        canvas.printf("Bias %.1f mV  supply %.2f V", ads.bias_mv, ads.bias_mv * 6.6f / 1000.0f);
    }

    // 2. GSR value and the resistance it means.
    if(ads.present) {
        if(zero.pending > 0) {
            line_at(y, TFT_YELLOW);
            canvas.printf("Zeroing... %d s (no contact)", zero.pending);
        } else if(ads.ns < VALID_MIN_NS) {
            line_at(y, TFT_YELLOW);
            canvas.print("GSR open circuit");
        } else {
            line_at(y, zero.set ? TFT_GREEN : TFT_YELLOW);
            canvas.printf("GSR %.1f nS  ", ads.ns);
            print_resistance(ads.ns);
        }

        // 3. Zero status, or noise.
        if(millis() < msg.until_ms) {
            line_at(y, TFT_CYAN);
            canvas.print(msg.text);
        } else if(!zero.set) {
            line_at(y, TFT_YELLOW);
            canvas.printf("No zero: open, press Z (%.0f)", ads.raw_mean);
        } else {
            line_at(y, TFT_WHITE);
            if(isnan(ads.noise_pp)) canvas.printf("Noise -   zero %.0f", zero.counts);
            else canvas.printf("Noise %.2f nS  zero %.0f", ads.noise_pp, zero.counts);
        }

        // 4. Bus health.
        line_at(y, ads.errors ? TFT_RED : TFT_WHITE);
        canvas.printf("%lu/s err %lu gap %lu ms pga %u", (unsigned long)ads.reads_per_s,
            (unsigned long)ads.errors, (unsigned long)(ads.max_gap_us / 1000), ads.pga);
    } else {
        y += 3 * LH;
    }

    // 5–6. GPS.
    if(!gps.locked) {
        line_at(y, TFT_YELLOW);
        canvas.printf("GPS no data  %lu baud  %lu B/s",
            (unsigned long)GPS_BAUDS[gps.baud_idx], (unsigned long)gps.bytes_per_s);
        y += LH;
    } else {
        line_at(y, gps.fix > 0 ? TFT_GREEN : TFT_WHITE);
        if(!gps.gsv_seen) {
            canvas.printf("Sats used %d  (no GSV)", gps.used < 0 ? 0 : gps.used);
        } else {
            canvas.printf("Sats used %d heard %d seen %d",
                gps.used < 0 ? 0 : gps.used, gps.heard, gps.in_view);
        }
        if(gps.bad_per_s) line_at(y, TFT_RED);
        else line_at(y, gps.fix > 0 ? TFT_GREEN : TFT_WHITE);
        if(gps.fix > 0) {
            canvas.printf("Fix (%lu s) hdop %.1f", (unsigned long)gps.ttff_s, gps.hdop);
            if(gps.heard) canvas.printf(" sig %d", gps.best_cno);
        } else {
            canvas.print("No fix");
            if(gps.heard) canvas.printf("  best signal %d dB", gps.best_cno);
        }
        if(gps.bad_per_s) canvas.printf(" bad %lu", (unsigned long)gps.bad_per_s);
    }

    // 7. Power and restarts.
    line_at(y, reset_is_bad(reset_reason) ? TFT_RED : TFT_WHITE);
    if(batt_mv > 0) canvas.printf("Batt %.2f V  ", batt_mv / 1000.0f);
    else canvas.print("Batt -  ");
    canvas.printf("boot %lu %s", (unsigned long)boot_count, reset_text(reset_reason));

    // Footer: which noise tests are on, and uptime. Anything switched on
    // from its usual state is yellow.
    uint32_t up = millis() / 1000;
    char upbuf[12];
    snprintf(upbuf, sizeof(upbuf), "%lu:%02lu:%02lu",
        (unsigned long)(up / 3600), (unsigned long)(up / 60 % 60), (unsigned long)(up % 60));
    canvas.setCursor(2, H - LH);
    static const char* const BT_TEXT[3] = {"BT off ", "BT adv ", "BT conn "};
    int bt = ble_state();
    canvas.setTextColor(bt ? TFT_YELLOW : TFT_DARKGREY, TFT_BLACK);
    canvas.print(BT_TEXT[bt]);
    canvas.setTextColor(backlight_idx ? TFT_YELLOW : TFT_DARKGREY, TFT_BLACK);
    canvas.printf("L%u ", BACKLIGHT_LEVELS[backlight_idx]);
    canvas.setTextColor(sd.mode ? TFT_YELLOW : TFT_DARKGREY, TFT_BLACK);
    if(sd.mode) canvas.printf("SD%d %lums", sd.mode, (unsigned long)sd.max_write_ms);
    else canvas.print("SD off");
    canvas.setTextColor(TFT_DARKGREY, TFT_BLACK);
    canvas.drawString(upbuf, W - 2 - canvas.textWidth(upbuf), H - LH);

    canvas.pushSprite(0, 0);
}

static void draw_graph(void) {
    const int W = M5Cardputer.Display.width();
    const int H = M5Cardputer.Display.height();
    const int TOP = LH + 2, BOTTOM = H - LH - 2;          // plot area rows
    const int LEFT = W - GRAPH_POINTS;            // plot area starts here

    canvas.fillSprite(TFT_BLACK);

    // Visible range, with a minimum span so a flat signal isn't blown up.
    float lo = INFINITY, hi = -INFINITY;
    for(int i = 0; i < graph.count; i++) {
        float v = graph.v[i];
        if(isnan(v)) continue;
        if(v < lo) lo = v;
        if(v > hi) hi = v;
    }
    bool any = lo <= hi;
    if(any && hi - lo < GRAPH_MIN_SPAN_NS) {
        float mid = (hi + lo) * 0.5f;
        lo = mid - GRAPH_MIN_SPAN_NS * 0.5f;
        hi = mid + GRAPH_MIN_SPAN_NS * 0.5f;
    }

    // Title line: the latest second's value.
    canvas.setCursor(2, 0);
    if(!ads.present) {
        canvas.setTextColor(TFT_RED, TFT_BLACK);
        canvas.print("GSR: ADC not found");
    } else if(ads.ns < VALID_MIN_NS) {
        canvas.setTextColor(TFT_YELLOW, TFT_BLACK);
        canvas.print("GSR: open circuit");
    } else {
        canvas.setTextColor(zero.set ? TFT_GREEN : TFT_YELLOW, TFT_BLACK);
        canvas.printf("GSR: %.1f nS  ", ads.ns);
        print_resistance(ads.ns);
    }

    canvas.drawRect(LEFT - 1, TOP - 1, GRAPH_POINTS + 1, BOTTOM - TOP + 2, TFT_DARKGREY);

    if(any) {
        float span = hi - lo;
        float pad = span * 0.05f;
        lo -= pad; hi += pad; span = hi - lo;
        int prev_x = -1, prev_y = 0;
        // Oldest point on the left, newest on the right.
        int start = (graph.head - graph.count + GRAPH_POINTS) % GRAPH_POINTS;
        int x0 = LEFT + GRAPH_POINTS - graph.count;
        for(int i = 0; i < graph.count; i++) {
            float v = graph.v[(start + i) % GRAPH_POINTS];
            if(isnan(v)) { prev_x = -1; continue; }
            int x = x0 + i;
            int y = BOTTOM - (int)((v - lo) / span * (BOTTOM - TOP) + 0.5f);
            if(prev_x >= 0) canvas.drawLine(prev_x, prev_y, x, y, TFT_CYAN);
            else canvas.drawPixel(x, y, TFT_CYAN);
            prev_x = x; prev_y = y;
        }
        canvas.setTextColor(TFT_DARKGREY, TFT_BLACK);
        canvas.setCursor(2, BOTTOM + 2);
        canvas.printf("%.1f..%.1f nS", lo, hi);
    } else {
        canvas.setTextColor(TFT_DARKGREY, TFT_BLACK);
        canvas.setCursor(LEFT + 20, (TOP + BOTTOM - LH) / 2);
        canvas.print("no reading yet");
        canvas.setCursor(2, BOTTOM + 2);
        canvas.print("last 22 s");
    }
    canvas.drawString("G back", W - 2 - canvas.textWidth("G back"), BOTTOM + 2);

    canvas.pushSprite(0, 0);
}

static void log_header(void) {
    Serial.printf("# boot=%lu reset=%s zero=%s",
        (unsigned long)boot_count, reset_text(reset_reason), zero.set ? "set" : "none");
    if(zero.set) Serial.printf(" zero_counts=%.1f", zero.counts);
    Serial.println();
    Serial.println("ms,ads_present,gsr_ns,raw_counts,zero_counts,pga,reads_per_s,ads_i2c_errors,"
                   "pga_changes,max_gap_ms,noise_pp_ns,bias_mv,gps_locked,gps_good_per_s,"
                   "gps_bad_per_s,gps_fix,gps_used,gps_heard,gps_in_view,gps_best_cno,"
                   "gps_top4_cno,gps_hdop,gps_utc,gps_ttff_s,batt_mv,key_presses,"
                   "bt,backlight,sd_mode,sd_write_ms,sd_sync_ms,tone_jump_ns,tone_settle_ms,tone_silent");
}

static void log_line(void) {
    // Tone result only on the second it arrives; empty otherwise.
    char tone_jump[12] = "", tone_settle[12] = "", tone_silent[4] = "";
    if(chirp.result_new) {
        chirp.result_new = false;
        snprintf(tone_jump, sizeof(tone_jump), "%.2f", chirp.result_jump);
        snprintf(tone_settle, sizeof(tone_settle), "%d", chirp.result_settle_ms);
        snprintf(tone_silent, sizeof(tone_silent), "%d", chirp.result_silent ? 1 : 0);
    }
    Serial.printf("%lu,%d,%.2f,%.1f,%.1f,%u,%lu,%lu,%lu,%.1f,%.2f,%.2f,%d,%lu,%lu,%d,%d,%d,%d,%d,%.1f,%.2f,%s,%lu,%d,%lu,"
                  "%d,%u,%d,%lu,%lu,%s,%s,%s\n",
        (unsigned long)millis(), ads.present, ads.ns, ads.raw_mean,
        zero.set ? zero.counts : 0.0f, ads.pga,
        (unsigned long)ads.reads_per_s, (unsigned long)ads.errors,
        (unsigned long)ads.pga_changes, ads.max_gap_us / 1000.0f, ads.noise_pp, ads.bias_mv,
        gps.locked, (unsigned long)gps.good_per_s, (unsigned long)gps.bad_per_s,
        gps.fix, gps.used, gps.heard, gps.in_view, gps.best_cno, gps.top4_cno, gps.hdop,
        gps.utc, (unsigned long)gps.ttff_s, batt_mv, (unsigned long)key_presses,
        ble_state(), BACKLIGHT_LEVELS[backlight_idx], sd.mode, (unsigned long)sd.write_ms_this_s,
        (unsigned long)sd.sync_ms_this_s, tone_jump, tone_settle, tone_silent);
    sd.write_ms_this_s = 0;
    sd.sync_ms_this_s = 0;
}

// ── Arduino entry points ────────────────────────────────────────────────────
static uint32_t last_second_ms = 0;
static uint32_t last_draw_ms = 0;
static uint32_t last_graph_ms = 0;

void setup() {
    reset_reason = esp_reset_reason();

    auto cfg = M5.config();
    M5Cardputer.begin(cfg, true);
    // M5GFX already turns the ADV's panel to landscape; rotation 0 keeps it there.
    M5Cardputer.Display.setRotation(0);
    canvas.createSprite(M5Cardputer.Display.width(), M5Cardputer.Display.height());
    canvas.setFont(SCREEN_FONT);
    M5Cardputer.Display.setBrightness(BACKLIGHT_LEVELS[0]);
    M5Cardputer.Speaker.setVolume(TONE_VOLUME);
    sd_fill_buffer();

    Serial.begin(115200);
    Serial.setTxTimeoutMs(0);  // don't stall the loop when no computer is listening

    // Boot count and the saved zero survive power-off (flash).
    prefs.begin("bench", false);
    boot_count = prefs.getUInt("boots", 0) + 1;
    prefs.putUInt("boots", boot_count);
    if(prefs.isKey("zero")) {
        zero.counts = prefs.getFloat("zero", 0.0f);
        zero.set = true;
    }

    // Hold the GPS port open for the whole run: a floating RX wire would wake
    // a sleeping M10Q (see docs/cardputer_port.md, "Gotchas").
    Serial1.setRxBufferSize(2048);
    Serial1.begin(GPS_BAUDS[0], SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);
    gps_set_baud(0);

    ads_init();
    log_header();
    last_second_ms = millis();
    last_graph_ms = last_second_ms;
}

void loop() {
    M5Cardputer.update();
    keys_poll();
    ads_poll();
    gps_poll();
    tone_poll();
    ble_poll();
    sd_poll();

    uint32_t now = millis();
    if(now - last_graph_ms >= GRAPH_STEP_MS) {
        last_graph_ms += GRAPH_STEP_MS;
        graph_tick();
    }
    if(now - last_second_ms >= 1000) {
        last_second_ms += 1000;
        ads_second();
        gps_second();
        batt_mv = M5.Power.getBatteryVoltage();
        log_line();
    }
    if(now - last_draw_ms >= 250) {
        last_draw_ms = now;
        if(show_graph) draw_graph();
        else draw_screen();
    }
    delay(1);  // let lower-priority tasks run; the ADS makes a new reading every ~1.2 ms
}
