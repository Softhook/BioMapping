#pragma once

// GPS — NMEA parser and set-up for the u-blox SAM-M10Q GNSS module.
// Shared by every device; plain C with no device code.
//
// Everything that touches hardware (the serial port, collecting received
// bytes, the clock, waits, the lock) goes through the GpsPlatform functions
// the device hands to gps_uart_create(). The Flipper's functions, and its
// app-lifetime port handling, are in flipper/gps_uart_flipper.c.
//
// Everything here runs on one thread (the device's main loop): create(),
// destroy(), gps_uart_handle_rx(), gps_uart_send_cold_start() and
// gps_uart_sleep_from_unknown_state(). Two read-outs may be called from
// another thread (on the Flipper, the screen's): gps_uart_get_status(),
// which shares the device's lock with the parser, and gps_uart_is_ready(),
// which is set once inside create() and never changes after.
// Do NOT hold the app's own main lock when calling gps_uart_handle_rx():
// a reconfigure inside it waits for seconds.
//
// The waits: waking the module, the baud switch and each set-up packet's
// reply are timed sequences confirmed on real hardware, so they are kept as
// waits (GpsPlatform.delay_ms) rather than rewritten step by step. They
// happen only in create(), destroy(), the sleep sequence, and the rare
// reconfigure inside gps_uart_handle_rx().

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "../vendor/minmea/minmea.h"
#include "biomap_config.h"

#ifdef __cplusplus
extern "C" {
#endif

#define GPS_BAUD_RATE      9600
#define GPS_BAUD_RATE_FAST 115200

typedef struct GpsStatus {
    double latitude;            // NaN = no fix yet (double for sub-metre precision)
    double longitude;
    float speed;                // knots (RMC)
    float course;               // degrees true
    float hdop;                 // Horizontal Dilution of Precision (GGA/GSA)
    float hacc;                 // Estimated horizontal accuracy in metres (PUBX 00); 99.9 = unknown
    int   fix_quality;          // GGA quality: 0=none, 1=GPS, 2=DGPS, 3=PPS, 4/5=RTK, 6=estimated
    int   fix_type;             // 1=none, 2=2D, 3=3D (GSA)
    int   satellites_tracked;   // satellites used in the navigation solution (PUBX 00 numSvs)
    bool  fix_valid;            // RMC status A and not an estimated (mode E) fix
    bool  sbas_active;          // an SBAS satellite (GSA SystemID 1, number 33-64) was in use this second or the last
    float pdop;                 // Position Dilution of Precision from GSA (chip-computed, all constellations); 99.9 = unknown
    struct minmea_time time;
    struct minmea_date date;
} GpsStatus;

// True when a GGA quality value is a satellite fix (1–5: GPS, DGPS, PPS,
// RTK). 6 is the receiver's own estimate from its motion model after losing
// the satellites — including ones it flags as invalid ("dead reckoning fix,
// but user limits exceeded", M10 SPG 5.10 interface description §2.5.5) —
// which the integration manual says not to use.
static inline bool gps_quality_is_gnss_fix(int q) {
    return q >= 1 && q <= 5;
}

// True when the latest RMC or GGA reports a satellite fix.
static inline bool gps_status_has_fix(const GpsStatus* s) {
    return s->fix_valid || gps_quality_is_gnss_fix(s->fix_quality);
}

typedef struct GpsUart GpsUart;

// How the device's serial port handles received bytes, between rx_start()
// and rx_stop().
typedef enum {
    // Keep every byte, in order, for rx_read(). A byte that arrives with an
    // error flag (framing, noise) is still kept: dropping it would split
    // the sentence it belongs to.
    GpsRxStream,
    // Only note the time of the first clean byte (no error flag), for
    // rx_wake_seen(); throw the bytes away. A garbled byte can be a glitch
    // from a module still booting, or output at another baud — neither
    // means it is listening at 9600 yet.
    GpsRxWakeWatch,
} GpsRxMode;

// ── What each device supplies ───────────────────────────────────────────
// Every function gets `ctx` back as its first argument. All are required
// except `log`.
typedef struct {
    void* ctx;
    // (Re)start the port at `baud`. Received bytes are off until rx_start().
    // Never called while receiving.
    void (*set_baud)(void* ctx, uint32_t baud);
    // Send `len` bytes. May return before the last byte has left the wire;
    // the shared code waits afterwards where timing matters.
    void (*tx)(void* ctx, const uint8_t* data, size_t len);
    // Start or stop receiving. rx_stop() is only called after rx_start().
    void (*rx_start)(void* ctx, GpsRxMode mode);
    void (*rx_stop)(void* ctx);
    // GpsRxStream: take up to `len` bytes already received, without
    // waiting. Returns how many were taken.
    size_t (*rx_read)(void* ctx, uint8_t* buf, size_t len);
    // GpsRxStream: throw away every byte received but not yet read.
    void (*rx_clear)(void* ctx);
    // GpsRxWakeWatch: true once a clean byte has arrived since the last
    // rx_start(GpsRxWakeWatch), with the now_ms() time it arrived in
    // *first_ms. Still answers after rx_stop(), until the next rx_start().
    bool (*rx_wake_seen)(void* ctx, uint32_t* first_ms);
    // Received bytes lost because the device's buffer was full (the main
    // loop fell behind), counted since this session's create(). Read by
    // gps_uart_get_rx_drop_count() for the CSV diagnostics.
    uint32_t (*rx_drop_count)(void* ctx);
    // gps_uart_handle_rx() stopped early with bytes still waiting: ask the
    // device's main loop to call it again soon.
    void (*rx_again)(void* ctx);
    // A clock in milliseconds that counts up and wraps at 2^32. The wake
    // timeout and the 5 s NMEA watchdog are timed on it.
    uint32_t (*now_ms)(void* ctx);
    // Wait at least `ms`. Only in the timed sequences described above.
    void (*delay_ms)(void* ctx, uint32_t ms);
    // The lock described at the top: guards the GpsStatus fields between
    // the parser and gps_uart_get_status(). Not recursive.
    void (*lock)(void* ctx);
    void (*unlock)(void* ctx);
    // Optional (may be NULL): one log line. `warning` false is information.
    // Never called with the lock held.
    void (*log)(void* ctx, bool warning, const char* line);
} GpsPlatform;

// Starts a GPS session: wakes the module from standby, waits until it is
// listening, switches it to 115200 and sends its configuration. Blocks for
// a few hundred ms (longer when the module doesn't answer). `platform` is
// copied. `have_port` false (the device couldn't open its serial port)
// gives a GpsUart that is never ready and sends nothing. Stops
// (core_fatal) if `platform` lacks a required function or memory runs out.
//
// `super_s` true leaves the module's Super-S weak-signal compensation on
// automatic (its default); false switches it off (see ubx_send_super_s()).
GpsUart* gps_uart_create(const GpsPlatform* platform, bool have_port,
                         GpsNavModel nav_model, bool super_s);

// Ends the session: sends the standby command (the last byte sent, at the
// session's 115200) and stops receiving, then frees the GpsUart. The
// device keeps its port open afterwards — see gps_uart_sleep_from_unknown_state().
void gps_uart_destroy(GpsUart* gps);

// The `ctx` given in the platform, for the device's own wrappers.
void* gps_uart_platform_ctx(const GpsUart* gps);

// Takes the bytes received so far and parses every complete NMEA line, up
// to a fixed amount of work per call (it calls rx_again() when it stops
// early). Also runs the 5 s NMEA watchdog, which reconfigures the module.
// The device's main loop calls it whenever bytes have arrived.
void gps_uart_handle_rx(GpsUart* gps);

GpsStatus gps_uart_get_status(const GpsUart* gps);
bool      gps_uart_is_ready(const GpsUart* gps);
void      gps_uart_send_cold_start(GpsUart* gps);

// gps_uart_get_rx_drop_count(): received bytes the device had to drop because
// its buffer was full — the direct symptom of a main-thread stall (e.g. behind
// a mutex) delaying the drain until the buffer overflows. Cumulative,
// monotonic. 0 when the GpsUart is not ready.
uint32_t  gps_uart_get_rx_drop_count(const GpsUart* gps);

// gps_uart_get_nmea_fail_count(): incremented in gps_uart_parse_line()
// whenever a line fails NMEA checksum/format validation (minmea_sentence_id
// returns MINMEA_INVALID). A well-formed sentence of a type we don't act on
// (MINMEA_UNKNOWN) does NOT count — this is specifically a corruption/
// parse-failure proxy, not "sentences we ignore by design".
uint32_t  gps_uart_get_nmea_fail_count(const GpsUart* gps);

// gps_uart_get_reinit_count(): incremented once per gps_uart_reinit()
// call — a full baud-switch + module-reconfigure cycle, triggered either by
// the RX-buffer-full guard or the 5 s NMEA watchdog (both in
// gps_uart_handle_rx()). Makes "the module got reconfigured N times
// mid-recording" visible in the CSV rather than only in the serial log.
uint32_t  gps_uart_get_reinit_count(const GpsUart* gps);

// gps_uart_get_chip_id(): best-effort GPS module chip serial number,
// polled via the binary UBX-SEC-UNIQID message and rendered as a 5-word
// mnemonic phrase (EFF short wordlist — see ubx_poll_chip_id() in
// gps_uart.c) rather than the raw 12-hex-digit value, e.g. "axis slang
// boast putt chunk" — 1296^5 >= 2^48, so this is a lossless, collision-free
// encoding of the chip ID, not just a recognisable label. Returns "" if
// not yet captured — the poll got no valid response. Not tied to a specific GpsUart:
// a capture persists across destroy()/create() cycles
// within the same app run (file-scope cache), so a later mode switch
// can still see an ID found earlier.
const char* gps_uart_get_chip_id(const GpsUart* gps);

// UTC time read from the module's UBX-NAV-TIMEUTC message (u-blox M10 SPG 5.10
// Interface Description §3.15.24). Used at boot on devices without a hardware
// RTC (Cardputer) to grab the module's battery-backed clock before putting it
// to sleep.
typedef struct {
    uint16_t year;       // 2025..2099
    uint8_t  month;      // 1..12
    uint8_t  day;        // 1..31
    uint8_t  hour;       // 0..23
    uint8_t  minute;     // 0..59
    uint8_t  second;     // 0..60
    int32_t  nano;       // fractional second, -1e9..+1e9 ns
    uint32_t read_at_ms; // platform now_ms() when the reply arrived
} GpsUtcTime;

// Puts the module to sleep from whatever state it is in at app start:
// asleep, awake at its 9600 default, or awake at 115200. Blocks for up to
// ~1.9 s (most of it waiting for the module to wake first). Uses only
// set_baud, tx, rx_start/rx_stop in GpsRxWakeWatch, rx_wake_seen, now_ms,
// delay_ms and log; leaves the port at 115200 with receiving off.
//
// If `boot_utc` is non-NULL, polls UBX-NAV-TIMEUTC once (retrying once on
// timeout) after moving to 115200 and before sending standby, to read the
// module's battery-backed RTC (also requires rx_read and rx_clear). Returns
// true and fills *boot_utc when the module answers with a valid UTC time
// (validTOW + validWKN + validUTC set, year >= 2025); returns false otherwise
// (or when `boot_utc` is NULL).
//
// Hardware rule for every device: open the serial port once at app start,
// call this, and hold the port until the app exits. A sleeping M10Q wakes
// on any edge on its RX pin, and a released port leaves that line floating
// — on the Flipper the module was awake again within seconds of every
// release. Held, the line idles steadily high, so the module stays asleep
// between GPS sessions. See research/archive/gps_sleep_investigation.md.
bool gps_uart_sleep_from_unknown_state(const GpsPlatform* platform, GpsUtcTime* boot_utc);

#ifdef __cplusplus
}
#endif
