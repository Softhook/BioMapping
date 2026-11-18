// BioMapping bench test for the M5Stack Cardputer ADV.
//
// A throwaway program for checking that the Flipper prototyping board
// (ADS1115 GSR front end + SAM-M10Q GPS) works when wired to the Cardputer's
// EXT header with jumper leads. It is not the real firmware.
//
// It checks:
//   - the ADS1115 and the keyboard can share the internal I2C bus (G8/G9);
//   - GSR readings look sensible (same maths as firmware/modules/gsr_sensor.c);
//   - the 0.5 V bias, which shows whether the board's 3.3 V supply is right;
//   - the GPS sends valid NMEA on G15 (RX) and listens on G13 (TX);
//   - the keyboard keeps responding over a long run.
//
// Everything runs in loop() on one thread, so no bus lock is needed. The
// ADS1115 goes through M5's In_I2C, the same driver the keyboard uses:
// opening the same pins with Arduino's Wire would make two drivers fight.
//
// A once-a-second CSV line goes to the USB serial port (115200 baud).
// Keys: S = rescan the I2C bus, R = reset the counters.

#include <M5Cardputer.h>

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

// Same formula as gsr_tia_counts_to_ns_at_bias() in firmware/modules/gsr_sensor.h:
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

struct {
    bool     present = false;
    uint8_t  pga = PGA_DEFAULT;
    int      low_run = 0;
    uint32_t settle_until_us = 0;
    uint32_t last_bias_ms = 0;
    uint32_t last_retry_ms = 0;
    // per-second accumulators
    int64_t  sum_norm = 0;
    uint32_t n = 0;
    uint32_t reads = 0;
    // results of the last full second
    float    ns = 0.0f;
    float    mean_norm = 0.0f;
    uint32_t reads_per_s = 0;
    float    bias_mv = NAN;
    float    bias_scale = 1.0f;   // last in-range bias / 500 mV, as the firmware uses
    uint32_t errors = 0;
    uint32_t pga_changes = 0;
} ads;

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

    if((int32_t)(micros() - ads.settle_until_us) < 0) return;

    int16_t raw;
    if(!ads_read_conv(&raw)) {
        ads.errors++;
        return;
    }
    ads.reads++;

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

    ads.sum_norm += (int32_t)raw * NORM_FACTOR[ads.pga];
    ads.n++;
}

static void ads_second(void) {
    ads.reads_per_s = ads.reads;
    ads.reads = 0;
    if(ads.n > 0) {
        ads.mean_norm = (float)ads.sum_norm / (float)ads.n;
        ads.ns = counts_to_ns(ads.mean_norm, ads.bias_scale);
    } else {
        ads.mean_norm = 0.0f;
        ads.ns = 0.0f;
    }
    ads.sum_norm = 0;
    ads.n = 0;
}

// ── GPS ─────────────────────────────────────────────────────────────────────
// The M10Q starts at 9600 baud, but if the Flipper app has already run on the
// same power it may still be at 115200. Try each in turn until valid NMEA
// arrives. Sending a byte also wakes it if the Flipper left it in standby.
static const uint32_t GPS_BAUDS[2] = {9600, 115200};
static const uint32_t GPS_HUNT_MS  = 3000;
static const uint32_t GPS_LOST_MS  = 5000;

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
    uint32_t total_good = 0;
    int      fix = -1;        // GGA fix quality, -1 = no GGA yet
    int      sats = -1;
    float    hdop = NAN;
    char     utc[9] = "--:--:--";
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

// $xxGGA,time,lat,N,lon,E,fix,sats,hdop,...
static void gps_parse_gga(const char* s) {
    char buf[100];
    strncpy(buf, s, sizeof(buf) - 1);
    buf[sizeof(buf) - 1] = 0;
    const char* field[10] = {0};
    int n = 0;
    char* p = buf;
    field[n++] = p;
    while(*p && n < 10) {
        if(*p == ',' || *p == '*') {
            *p = 0;
            field[n++] = p + 1;
        }
        p++;
    }
    if(n < 9) return;
    const char* t = field[1];
    if(strlen(t) >= 6) {
        snprintf(gps.utc, sizeof(gps.utc), "%.2s:%.2s:%.2s", t, t + 2, t + 4);
    }
    gps.fix  = *field[6] ? atoi(field[6]) : 0;
    gps.sats = *field[7] ? atoi(field[7]) : 0;
    gps.hdop = *field[8] ? atof(field[8]) : NAN;
}

static void gps_line(void) {
    gps.line[gps.len] = 0;
    if(gps.len < 6) return;
    if(!nmea_checksum_ok(gps.line)) {
        gps.bad++;
        return;
    }
    gps.good++;
    gps.total_good++;
    gps.last_good_ms = millis();
    gps.locked = true;
    if(strncmp(gps.line + 3, "GGA", 3) == 0) gps_parse_gga(gps.line);
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
}

// ── I2C scan ────────────────────────────────────────────────────────────────
static char i2c_found[64] = "";

static void i2c_scan(void) {
    i2c_found[0] = 0;
    size_t len = 0;
    for(uint8_t a = 0x08; a <= 0x77; a++) {
        if(M5.In_I2C.scanID(a, 100000)) {
            len += snprintf(i2c_found + len, sizeof(i2c_found) - len, "%02X ", a);
            if(len >= sizeof(i2c_found) - 4) break;
        }
    }
    if(len == 0) strcpy(i2c_found, "none");
}

// ── Keyboard ────────────────────────────────────────────────────────────────
struct {
    uint32_t presses = 0;
    uint32_t last_ms = 0;
    char     last[8] = "-";
} keys;

static void reset_counters(void) {
    ads.errors = 0;
    ads.pga_changes = 0;
    gps.total_good = 0;
    keys.presses = 0;
}

static void keys_poll(void) {
    if(!M5Cardputer.Keyboard.isChange() || !M5Cardputer.Keyboard.isPressed()) return;
    auto& st = M5Cardputer.Keyboard.keysState();
    keys.presses++;
    keys.last_ms = millis();
    if(st.enter)      strcpy(keys.last, "ENT");
    else if(st.del)   strcpy(keys.last, "DEL");
    else if(st.space) strcpy(keys.last, "SPC");
    else if(st.tab)   strcpy(keys.last, "TAB");
    else if(!st.word.empty()) {
        char c = st.word.back();
        snprintf(keys.last, sizeof(keys.last), "'%c'", c);
        if(c == 's' || c == 'S') i2c_scan();
        if(c == 'r' || c == 'R') reset_counters();
    } else strcpy(keys.last, "mod");
}

// ── Screen and serial log ───────────────────────────────────────────────────
static M5Canvas canvas(&M5Cardputer.Display);

static void draw_screen(void) {
    const int LH = 13;
    int y = 2;
    uint32_t up = millis() / 1000;
    canvas.fillSprite(TFT_BLACK);
    canvas.setTextColor(TFT_WHITE, TFT_BLACK);

    canvas.setCursor(2, y);
    canvas.printf("BioMap bench   up %02lu:%02lu:%02lu",
        (unsigned long)(up / 3600), (unsigned long)(up / 60 % 60), (unsigned long)(up % 60));
    y += LH + 2;

    canvas.setTextColor(strstr(i2c_found, "48") ? TFT_GREEN : TFT_RED, TFT_BLACK);
    canvas.setCursor(2, y);
    canvas.printf("I2C: %s", i2c_found);
    y += LH;

    if(!ads.present) {
        canvas.setTextColor(TFT_RED, TFT_BLACK);
        canvas.setCursor(2, y);
        canvas.print("GSR: ADS1115 not found at 0x48");
        y += 2 * LH;
    } else {
        canvas.setCursor(2, y);
        if(ads.ns < VALID_MIN_NS) {
            canvas.setTextColor(TFT_YELLOW, TFT_BLACK);
            canvas.printf("GSR: open circuit  pga %u", ads.pga);
        } else {
            canvas.setTextColor(TFT_GREEN, TFT_BLACK);
            canvas.printf("GSR: %.1f nS  pga %u", ads.ns, ads.pga);
        }
        y += LH;
        canvas.setTextColor(ads.errors ? TFT_RED : TFT_WHITE, TFT_BLACK);
        canvas.setCursor(2, y);
        canvas.printf("     %lu reads/s  I2C errors %lu",
            (unsigned long)ads.reads_per_s, (unsigned long)ads.errors);
        y += LH;
    }

    canvas.setCursor(2, y);
    if(isnan(ads.bias_mv)) {
        canvas.setTextColor(TFT_DARKGREY, TFT_BLACK);
        canvas.print("Bias: -");
    } else {
        bool ok = fabsf(ads.bias_mv - 500.0f) < 15.0f;
        canvas.setTextColor(ok ? TFT_GREEN : TFT_RED, TFT_BLACK);
        canvas.printf("Bias: %.1f mV  (supply ~%.2f V)", ads.bias_mv, ads.bias_mv * 6.6f / 1000.0f);
    }
    y += LH + 2;

    canvas.setCursor(2, y);
    if(gps.locked) {
        canvas.setTextColor(TFT_GREEN, TFT_BLACK);
        canvas.printf("GPS: %lu baud  %lu good/s  %lu bad/s",
            (unsigned long)GPS_BAUDS[gps.baud_idx],
            (unsigned long)gps.good_per_s, (unsigned long)gps.bad_per_s);
    } else {
        canvas.setTextColor(TFT_YELLOW, TFT_BLACK);
        canvas.printf("GPS: trying %lu baud  %lu bytes/s",
            (unsigned long)GPS_BAUDS[gps.baud_idx], (unsigned long)gps.bytes_per_s);
    }
    y += LH;
    canvas.setTextColor(TFT_WHITE, TFT_BLACK);
    canvas.setCursor(2, y);
    if(gps.fix < 0) {
        canvas.print("     no position message yet");
    } else {
        canvas.printf("     fix %d  sats %d  UTC %s", gps.fix, gps.sats, gps.utc);
    }
    y += LH + 2;

    canvas.setCursor(2, y);
    if(keys.presses == 0) {
        canvas.print("Keys: none yet");
    } else {
        canvas.printf("Keys: %lu  last %s  %lus ago", (unsigned long)keys.presses, keys.last,
            (unsigned long)((millis() - keys.last_ms) / 1000));
    }
    y += LH;
    canvas.setTextColor(TFT_DARKGREY, TFT_BLACK);
    canvas.setCursor(2, y);
    canvas.print("S = rescan I2C   R = reset counts");

    canvas.pushSprite(0, 0);
}

static void log_header(void) {
    Serial.println("ms,ads_present,gsr_ns,mean_counts,pga,reads_per_s,ads_i2c_errors,"
                   "pga_changes,bias_mv,gps_baud,gps_locked,gps_bytes_per_s,gps_good_per_s,"
                   "gps_bad_per_s,gps_fix,gps_sats,gps_hdop,gps_utc,key_presses,i2c_devices");
}

static void log_line(void) {
    Serial.printf("%lu,%d,%.2f,%.1f,%u,%lu,%lu,%lu,%.2f,%lu,%d,%lu,%lu,%lu,%d,%d,%.2f,%s,%lu,%s\n",
        (unsigned long)millis(), ads.present, ads.ns, ads.mean_norm, ads.pga,
        (unsigned long)ads.reads_per_s, (unsigned long)ads.errors,
        (unsigned long)ads.pga_changes, ads.bias_mv,
        (unsigned long)GPS_BAUDS[gps.baud_idx], gps.locked,
        (unsigned long)gps.bytes_per_s, (unsigned long)gps.good_per_s,
        (unsigned long)gps.bad_per_s, gps.fix, gps.sats, gps.hdop, gps.utc,
        (unsigned long)keys.presses, i2c_found);
}

// ── Arduino entry points ────────────────────────────────────────────────────
static uint32_t last_second_ms = 0;
static uint32_t last_draw_ms = 0;

void setup() {
    auto cfg = M5.config();
    M5Cardputer.begin(cfg, true);
    M5Cardputer.Display.setRotation(1);
    canvas.createSprite(M5Cardputer.Display.width(), M5Cardputer.Display.height());
    canvas.setTextSize(1);

    Serial.begin(115200);
    Serial.setTxTimeoutMs(0);  // don't stall the loop when no computer is listening

    // Hold the GPS port open for the whole run: a floating RX wire would wake
    // a sleeping M10Q (see docs/cardputer_port.md, "Gotchas").
    Serial1.setRxBufferSize(2048);
    Serial1.begin(GPS_BAUDS[0], SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);
    gps_set_baud(0);

    i2c_scan();
    ads_init();
    log_header();
    last_second_ms = millis();
}

void loop() {
    M5Cardputer.update();
    keys_poll();
    ads_poll();
    gps_poll();

    uint32_t now = millis();
    if(now - last_second_ms >= 1000) {
        last_second_ms += 1000;
        ads_second();
        gps_second();
        log_line();
    }
    if(now - last_draw_ms >= 250) {
        last_draw_ms = now;
        draw_screen();
    }
    delay(1);  // let lower-priority tasks run; the ADS makes a new reading every ~1.2 ms
}
