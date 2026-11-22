// GPS — NMEA parser and M10Q set-up for Bio Mapping. Shared by every
// device: the hardware is reached only through GpsPlatform (gps_uart.h).

#include "gps_uart.h"
#include "core_check.h"

#include <limits.h>
#include <math.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "eff_short_wordlist.h" // chip-ID mnemonic phrase — see ubx_poll_chip_id()

#define RX_LINE_BUF  1024      // max NMEA line length (~80 in practice)
// Bound main-thread monopolization: drain a chunk, then reschedule if more.
// This keeps one UART event from consuming an unbounded slice of the app
// loop when backlog builds.
#define GPS_RX_MAX_DRAIN_BYTES_PER_CALL 384
#define GPS_RX_MAX_LINES_PER_CALL 8

#define GPS_COUNT_OF(a) (sizeof(a) / sizeof((a)[0]))

struct GpsUart {
    GpsPlatform          platform;
    GpsStatus            status;        // guarded by platform.lock
    GpsNavModel          nav_model;
    bool                 super_s;
    uint8_t              rx_buf[RX_LINE_BUF];
    size_t               rx_offset;
    bool                 ready;
    uint32_t             last_valid_nmea_ms;  // watchdog: last successful $Gx parse; 0 = disarmed
    struct minmea_time   last_epoch_time;
    bool                 sbas_seen_this_second; // an SBAS satellite was in use since the last whole-second reset
    // Per-session log-once flag. Kept in the struct (not as a function-local
    // static) so it resets correctly on each gps_uart_create() call. The
    // parser runs under the lock, so it only notes the line here; it is
    // logged once the lock is released.
    bool                 gsa_talker_logged;
    bool                 gsa_talker_log_pending;
    char                 gsa_talker[2];
    int                  gsa_system_id;

    // ── Contention diagnostics — see gps_uart.h ─────────────────────────
    // Both written only on the main thread, inside gps_uart_handle_rx()
    // (the parser and both gps_uart_reinit() call sites), so plain
    // uint32_t is enough.
    uint32_t             nmea_fail_count;
    uint32_t             reinit_count;
    // Set once ubx_poll_chip_id() has tried in this session, so a mid-session
    // gps_uart_reinit() (RX-buffer-full or NMEA watchdog) never retries the
    // poll if the module didn't answer at create().
    bool                 chip_id_poll_attempted;
};

// One log line, if the device takes them. printf-style; lines longer than
// the buffer are cut short.
static void gps_log(const GpsPlatform* p, bool warning, const char* fmt, ...) {
    if(!p->log) return;
    char line[80];
    va_list args;
    va_start(args, fmt);
    vsnprintf(line, sizeof(line), fmt, args);
    va_end(args);
    p->log(p->ctx, warning, line);
}

// ── Double-precision coordinate converter ───────────────────────────────
// minmea_tocoord() returns float, which loses ~0.4 m of precision at
// 6-7 decimal places.  This double version preserves full NMEA precision
// (~1 cm at the equator).  Formula: deg + min / (60 * scale).
// Uses integer literals (not 60.0/100.0) to avoid -Wdouble-promotion
// warnings when the toolchain uses -fsingle-precision-constant.
// Integer→double promotion is not flagged; only float→double is.
static inline double minmea_tocoord_double(const struct minmea_float* f) {
    if(f->scale == 0) return (double)NAN;
    if(f->scale > (INT_LEAST32_MAX / 100)) return (double)NAN;
    if(f->scale < (INT_LEAST32_MIN / 100)) return (double)NAN;
    int_least32_t scale100 = f->scale * 100;
    int_least32_t deg = f->value / scale100;
    int_least32_t min = f->value % scale100;
    return (double)deg + (double)min / ((double)f->scale * 60);
}

// ── SBAS detection ───────────────────────────────────────────────────
// The M10Q runs at its defaults, NMEA 4.11 with strict satellite numbering
// (gps_uart_configure() leaves CFG-NMEA-PROTVER/SVNUMBERING alone), which
// reuses the same numbers across constellations: GPS 1-32, SBAS 33-64,
// GLONASS 65-96, Galileo 1-36, BeiDou 1-63, QZSS 1-10 (u-blox M10 SPG 5.10
// Interface Description, Table 3). The number alone is therefore ambiguous;
// the GSA SystemID says which constellation it belongs to (1=GPS/SBAS,
// 2=GLONASS, 3=Galileo, 4=BeiDou, 5=QZSS, §1.5.4). SBAS satellites are the
// SystemID 1 numbers 33-64.
static bool gps_sat_is_sbas(int system_id, int sat) {
    return system_id == 1 && sat >= 33 && sat <= 64;
}

// ── PDOP helper: store GSA's chip-computed Position DOP. ───────────────
// PDOP comes from the GSA sentence and is computed by the M10Q firmware
// from ALL active satellites across ALL constellations.
static void gps_store_pdop(GpsUart* g, float pdop) {
    if(!isnan(pdop)) {
        g->status.pdop = pdop;
    }
}

// Start of comma-separated field n ("$PUBX" is field 0), or NULL if the
// line has fewer fields.
static const char* nmea_field(const char* line, int n) {
    const char* p = line;
    for(int field = 0; field < n; field++) {
        p = strchr(p, ',');
        if(!p) return NULL;
        p++;
    }
    return p;
}

// NMEA sentence dispatcher. Called with the lock held.
static void gps_uart_parse_line(GpsUart* g, char* line) {
    // $PUBX,00 (u-blox M10 SPG 5.10 Interface Description §2.8.2): field 9 is
    // hAcc in metres, field 18 numSvs, the satellites used in the navigation
    // solution. numSvs is the satellite count: GGA's is capped at 12, and
    // GSV counts satellites in view whether or not they're heard.
    if(strncmp(line, "$PUBX,00,", 9) == 0) {
        // minmea doesn't parse PUBX, so check it here. Strict, as below.
        if(!minmea_check(line, true)) {
            g->nmea_fail_count++;
            return;
        }
        const char* hacc_field = nmea_field(line, 9);
        if(hacc_field) {
            float hacc = strtof(hacc_field, NULL);
            if(hacc > 0.0f) {
                g->status.hacc = hacc;
            }
        }
        // An empty numSvs keeps the last count, as an empty HDOP does.
        const char* num_svs_field = nmea_field(line, 18);
        if(num_svs_field && *num_svs_field >= '0' && *num_svs_field <= '9') {
            g->status.satellites_tracked = atoi(num_svs_field);
        }
        g->last_valid_nmea_ms = g->platform.now_ms(g->platform.ctx);
        return;
    }

    // Strict: the M10Q always sends a checksum, so a line without one was
    // cut off in transit and would otherwise pass with a truncated field.
    enum minmea_sentence_id id = minmea_sentence_id(line, true);
    if(id == MINMEA_INVALID) {
        // Checksum/format failure — our proxy for a corrupted or dropped
        // byte in transit (see gps_uart.h's doc comment). A well-formed
        // sentence of a type we don't handle is MINMEA_UNKNOWN, not this —
        // that's not counted, since nothing was actually lost.
        g->nmea_fail_count++;
        return;
    }

    switch(id) {
    case MINMEA_SENTENCE_RMC: {
        struct minmea_sentence_rmc frame;
        if(minmea_parse_rmc(&frame, line)) {
            // Trust coordinates only when:
            //   - RMC Status = 'A' (data valid)
            //   - ModeInd is NOT 'E' (dead-reckoning/estimated) or 'N' (no fix)
            // ModeInd 'E' means the position is calculated from motion model,
            // not satellite observations — logging it would corrupt the track.
            // ModeInd '\0' means field absent (older NMEA 2.1) — treat as OK.
            // A=autonomous, D=differential, E=estimated, N=no fix (u-blox M10
            // SPG 5.10 Interface Description §2.5.5, position fix flags).
            char mi = frame.mode_indicator;
            bool position_ok = frame.valid && (mi != 'E') && (mi != 'N');
            g->status.fix_valid = position_ok;
            if(position_ok) {
                g->status.latitude  = minmea_tocoord_double(&frame.latitude);
                g->status.longitude = minmea_tocoord_double(&frame.longitude);
                g->status.speed     = minmea_tofloat(&frame.speed);
                g->status.course    = minmea_tofloat(&frame.course);
            } else if(gps_quality_is_gnss_fix(g->status.fix_quality)) {
                // Don't leave a prior epoch's GGA satellite-fix quality
                // keeping gps_status_has_fix() true until this epoch's GGA
                // arrives; if this epoch's GGA already set a non-GNSS quality
                // (e.g. 6 = estimated), preserve it.
                g->status.fix_quality = 0;
            }
            g->status.time = frame.time;
            g->status.date = frame.date;
            g->last_valid_nmea_ms = g->platform.now_ms(g->platform.ctx);

            // Roll the SBAS window over on each whole second. Sub-second
            // differences are ignored so that all of one second's
            // per-constellation GSA sentences count towards the same window.
            if(frame.time.hours   != g->last_epoch_time.hours ||
               frame.time.minutes != g->last_epoch_time.minutes ||
               frame.time.seconds != g->last_epoch_time.seconds) {
                g->last_epoch_time = frame.time;
                g->status.sbas_active = g->sbas_seen_this_second;
                g->sbas_seen_this_second = false;
            }
        }
    } break;

    case MINMEA_SENTENCE_GGA: {
        struct minmea_sentence_gga frame;
        if(minmea_parse_gga(&frame, line)) {
            // Only trust GGA position on a satellite fix. Without this
            // guard, a GGA arriving before RMC in a new epoch would
            // overwrite good coordinates with 0.0 — and an estimated
            // (quality 6) fix would overwrite them with the receiver's
            // guess, undoing the RMC mode-E check above.
            bool gga_ok = gps_quality_is_gnss_fix(frame.fix_quality);
            if(gga_ok) {
                g->status.latitude  = minmea_tocoord_double(&frame.latitude);
                g->status.longitude = minmea_tocoord_double(&frame.longitude);
            } else {
                g->status.fix_valid = false;
            }
            // The satellite count is left to PUBX 00: GGA's caps at 12.
            g->status.fix_quality        = frame.fix_quality;
            // Only overwrite HDOP when the field is present — minmea_tofloat
            // returns NaN for empty fields, which would clobber a good reading
            // from a prior GSA sentence.
            float gga_hdop = minmea_tofloat(&frame.hdop);
            if(!isnan(gga_hdop)) g->status.hdop = gga_hdop;
            g->status.time               = frame.time;
            g->last_valid_nmea_ms = g->platform.now_ms(g->platform.ctx);
        }
    } break;

    case MINMEA_SENTENCE_GSA: {
        struct minmea_sentence_gsa frame;
        if(minmea_parse_gsa(&frame, line)) {
            // Log SystemID on first sighting — the u-blox M10Q emits
            // one $GNGSA per constellation per epoch, distinguished by the trailing
            // SystemID field (1=GPS, 2=GLONASS, 3=Galileo, 4=BeiDou, 5=QZSS)
            // rather than by TalkerID. Logged after the lock is released.
            if(!g->gsa_talker_logged) {
                g->gsa_talker_logged = true;
                g->gsa_talker_log_pending = true;
                g->gsa_talker[0] = line[1];
                g->gsa_talker[1] = line[2];
                g->gsa_system_id = frame.system_id;
            }
            // GSA gives the authoritative HDOP/PDOP values and distinguishes
            // 2D (fix_type=2) from 3D (fix_type=3).  GGA HDOP is kept
            // as primary when GSA hasn't arrived yet; GSA overwrites only
            // when the field is present (non-NaN) to avoid clobbering a
            // good reading from a previous sentence.
            g->status.fix_type = frame.fix_type;
            float gsa_hdop = minmea_tofloat(&frame.hdop);
            if(!isnan(gsa_hdop)) g->status.hdop = gsa_hdop;
            g->last_valid_nmea_ms = g->platform.now_ms(g->platform.ctx);

            // Stays set until a whole second passes without an SBAS
            // satellite in use (cleared in the RMC epoch reset): the M10Q
            // sends one GSA per constellation, and only the SystemID 1 one
            // can list SBAS.
            for(int i = 0; i < 12 && frame.sats[i]; i++) {
                if(gps_sat_is_sbas(frame.system_id, frame.sats[i])) {
                    g->status.sbas_active = true;
                    g->sbas_seen_this_second = true;
                }
            }
            gps_store_pdop(g, minmea_tofloat(&frame.pdop));
        }
    } break;

    case MINMEA_SENTENCE_GLL: {
        // GLL is not enabled in the current config, but guard the validity
        // flag here so stale/void sentences never overwrite good coordinates.
        struct minmea_sentence_gll gll_frame;
        if(minmea_parse_gll(&gll_frame, line) && gll_frame.status == MINMEA_GLL_STATUS_DATA_VALID
           && gll_frame.mode != 'E' && gll_frame.mode != 'N') {
            g->status.latitude  = minmea_tocoord_double(&gll_frame.latitude);
            g->status.longitude = minmea_tocoord_double(&gll_frame.longitude);
            g->status.time      = gll_frame.time;
        }
    } break;

    default:
        break;
    }
}

// ── GPS chip ID cache ────────────────────────────────────────────────────
// File-scope, not a GpsStatus/GpsUart field: the app destroys and recreates
// GpsUart across mode switches (every GPS session is its own create), and a
// capture from an earlier session should survive into a later one within the
// same app run rather than being lost with the struct that held it.
// Empty ("") until ubx_poll_chip_id() (see below) polls and
// validates one. Never cleared — once found, kept for the life of the
// process. Polled with UBX-SEC-UNIQID rather than read from the module's
// NMEA boot banner: the banner goes out once, usually before the app is
// listening at the right baud.
//
// Holds a 5-word mnemonic phrase (see ubx_poll_chip_id_once()), not the
// raw hex — max 5*5-char words + 4 spaces + NUL = 30 bytes, comfortably
// under 32.
static char g_gps_chip_id[32] = {0};

// ---------------------------------------------------------------------------
// Helpers — send binary UBX packets over the GPS UART
// ---------------------------------------------------------------------------
static void ubx_tx(GpsUart* g, const uint8_t* data, size_t len) {
    g->platform.tx(g->platform.ctx, data, len);
    g->platform.delay_ms(g->platform.ctx, 100);
}

// ── Wake from software standby and wait until the module is listening ──
// ubx_rxm_pmreq_standby (below) sets wakeupSources = uartrx, so any edge on
// the module's RX pin wakes it. Standby clears the module's RAM
// configuration (SAM-M10Q integration manual §3.5.3.3), so waking is a
// restart: the module comes back at its 9600 baud default and is deaf until
// it has booted. u-blox publish no boot time, so rather than a fixed delay
// this waits for the first clean byte the module sends — its first output
// means its UART is up. A module that was already awake answers within one
// NMEA epoch. GPS_WAKE_TIMEOUT_MS covers boot plus one 1 Hz epoch at the
// module's default output rate; it only runs out when no module answers.
//
// Bounded by iteration count AND elapsed ms: the host test shim's clock
// never advances on its own (see ubx_find_sync()), and on hardware a 1 ms
// wait can take 2+ ms, so the clock bound is the real one there.
//
// Takes the platform (not GpsUart*) — also called at app start
// (gps_uart_sleep_from_unknown_state()), which has no GpsUart. The port must
// be set to GPS_BAUD_RATE and not receiving: this receives in
// GpsRxWakeWatch for the wait and stops before returning. Returns true if
// the module answered.
#define GPS_WAKE_TIMEOUT_MS 1500

static bool ubx_wake(const GpsPlatform* p) {
    p->rx_start(p->ctx, GpsRxWakeWatch);

    uint32_t start = p->now_ms(p->ctx);
    uint8_t dummy = 0xFF;
    p->tx(p->ctx, &dummy, 1);

    uint32_t first_ms = 0;
    for(uint32_t i = 0; i < GPS_WAKE_TIMEOUT_MS && !p->rx_wake_seen(p->ctx, &first_ms) &&
                        (p->now_ms(p->ctx) - start) < GPS_WAKE_TIMEOUT_MS;
        i++) {
        p->delay_ms(p->ctx, 1);
    }
    p->rx_stop(p->ctx);

    // Hardware diagnostic: when the module was asleep, this is its restart
    // time (near 0 when it was already awake). Asked again after rx_stop(),
    // so a byte that came in during the last wait still counts.
    bool answered = p->rx_wake_seen(p->ctx, &first_ms);
    if(answered) {
        gps_log(p, false, "Wake: first byte after %lu ms", (unsigned long)(first_ms - start));
    } else {
        gps_log(p, true, "Wake: no reply within %d ms", GPS_WAKE_TIMEOUT_MS);
    }
    return answered;
}

// ── UBX Fletcher-8 checksum (spec §3.4) — shared by outgoing packet
// construction (ubx_send_valset) and incoming ACK/NAK and UNIQID
// verification below.
static void ubx_calc_checksum(const uint8_t* buf, size_t len, uint8_t* ck_a, uint8_t* ck_b) {
    uint8_t a = 0, b = 0;
    for(size_t i = 0; i < len; i++) {
        a = (uint8_t)(a + buf[i]);
        b = (uint8_t)(b + a);
    }
    *ck_a = a;
    *ck_b = b;
}

// ── UBX-ACK-ACK/NAK confirmation ────────────────────────────────────────
// u-blox M10 SPG 5.10 Interface Description §3.5.1/§3.9: every UBX-CFG
// message sent to the receiver gets a binary UBX-ACK-ACK or UBX-ACK-NAK
// reply — unconditional protocol behaviour, confirmed against the official
// doc that there's no CFG-MSGOUT key to disable it. Reading it back,
// rather than firing packets blind behind a fixed delay, is what actually
// catches a rejected packet: CFG-MSG/CFG-RATE/CFG-NAV5 (used below) are
// legacy messages absent from the SPG 5.10 message reference entirely, so
// nothing guarantees a given firmware revision still accepts them.
//
// This reads straight from the received bytes (rx_read), ahead of
// gps_uart_handle_rx()'s '\n'-based NMEA line splitter — required, not just
// tidier. ACK/NAK frames never contain a literal 0x0A byte for any packet
// we send below (checked), so left alone they'd silently glue onto the
// front of whichever real NMEA sentence follows, corrupting it into one
// line that fails minmea_check()'s leading-'$' test and gets dropped. Safe
// to consume here because gps_uart_configure() runs synchronously on the
// same thread as gps_uart_handle_rx() — the two never interleave.
//
// Sized for the one call pattern this app actually has: gps_uart_configure()
// sends one CFG packet, then waits for exactly that packet's reply before
// sending the next — never more than one outstanding, and this app never
// itself enables any periodic binary UBX output, so the only binary
// traffic that can appear here is this app's own ACK/NAK. That's why
// ubx_wait_ack() below parses a single frame rather than looping to scan
// past "foreign" ones.
#define UBX_ACK_BYTE_POLLS      250  // ~250 ms worst case per byte
// Bytes tolerated while hunting for 0xB5 0x62. Sized against a real
// reconfigure log, not a cold-boot guess: on a reconfigure (module already
// running, not freshly powered on), it can still be streaming GGA+GLL+
// GSA+GSV(x several)+RMC+VTG at up to 10 Hz from whatever a previous
// session left it at — the exact set this VALSET call is trying to pare
// down — which is ~400-500 bytes/epoch, ~4-5 KB/s. A budget of 256 ran out
// on real NMEA in well under 100 ms, before the ACK arrived, and logged a
// false "no ACK/NAK received" for every packet. Real bytes cost near-zero
// incremental time when
// they're actually flowing (each read returns instantly, no per-byte
// delay incurred) so this only matters for genuine noise volume, not the
// happy-path latency.
#define UBX_ACK_MAX_SYNC_BYTES  8192

// Bounded by iteration count, not the clock: the host test harness
// (tests/shims/furi.h) makes the clock a caller-controlled fake that never
// advances on its own, so a wall-clock deadline would spin forever there.
// The 1 ms wait paces real-hardware polling between empty polls; under
// test the wait is a no-op, so this still terminates promptly when no data
// is available.
static bool ubx_read_byte(GpsUart* g, uint8_t* out) {
    for(int i = 0; i < UBX_ACK_BYTE_POLLS; i++) {
        if(g->platform.rx_read(g->platform.ctx, out, 1) == 1) return true;
        g->platform.delay_ms(g->platform.ctx, 1);
    }
    return false;
}

// Hunts for the UBX sync sequence 0xB5 0x62, tolerating up to
// UBX_ACK_MAX_SYNC_BYTES of anything else along the way (NMEA text — 0xB5
// never appears in printable NMEA, so it can't false-sync). Every byte
// gets the full ubx_read_byte() wait — u-blox only guarantees an ACK
// within one second of the triggering message (spec §3.9.1), so a real
// gap between the buffered noise draining and the ACK's own bytes
// actually arriving over the wire is normal and must not be mistaken for
// a dead link.
static bool ubx_find_sync(GpsUart* g) {
    bool have_first = false;
    for(int i = 0; i < UBX_ACK_MAX_SYNC_BYTES; i++) {
        uint8_t b;
        if(!ubx_read_byte(g, &b)) return false;
        if(have_first && b == 0x62) return true;
        have_first = (b == 0xB5);
    }
    return false;
}

typedef enum {
    UbxAckAck,
    UbxAckNak,
    UbxAckTimeout,
} UbxAckOutcome;

// Reads exactly one UBX frame after locating sync and checks it's an
// ACK/NAK for (want_cls, want_id) — the packet gps_uart_configure() just
// sent. Anything else (wrong class/length, bad checksum, ACK/NAK for a
// different message) is reported as a failure rather than scanned past:
// per the comment above, no other binary UBX traffic legitimately
// appears on this link, so a mismatch here is itself the problem being
// reported, not noise to search past.
static UbxAckOutcome ubx_wait_ack(GpsUart* g, uint8_t want_cls, uint8_t want_id) {
    if(!ubx_find_sync(g)) return UbxAckTimeout;

    uint8_t hdr[4]; // class, id, len_lo, len_hi
    if(!ubx_read_byte(g, &hdr[0]) || !ubx_read_byte(g, &hdr[1]) ||
       !ubx_read_byte(g, &hdr[2]) || !ubx_read_byte(g, &hdr[3])) {
        return UbxAckTimeout;
    }
    uint16_t len = (uint16_t)hdr[2] | ((uint16_t)hdr[3] << 8);

    uint8_t payload[2];
    if(!ubx_read_byte(g, &payload[0]) || !ubx_read_byte(g, &payload[1])) {
        return UbxAckTimeout;
    }
    uint8_t ck_a, ck_b;
    if(!ubx_read_byte(g, &ck_a) || !ubx_read_byte(g, &ck_b)) return UbxAckTimeout;

    if(hdr[0] != 0x05 || len != 2) return UbxAckTimeout; // not an ACK/NAK frame

    uint8_t ck_buf[6] = {hdr[0], hdr[1], hdr[2], hdr[3], payload[0], payload[1]};
    uint8_t calc_a, calc_b;
    ubx_calc_checksum(ck_buf, sizeof(ck_buf), &calc_a, &calc_b);
    if(calc_a != ck_a || calc_b != ck_b) return UbxAckTimeout; // corrupted frame

    if(payload[0] != want_cls || payload[1] != want_id) return UbxAckTimeout; // for a different message

    return (hdr[1] == 0x01) ? UbxAckAck : UbxAckNak;
}

// Sends a UBX packet and waits for its ACK/NAK, logging anything other
// than a clean ACK. class/id are read back out of the packet itself
// (bytes[2],[3]) — every call site already has one, no need to pass them
// separately.
//
// Drops any bytes already received but unread immediately before
// transmitting. Every M10Q packet sent by gps_uart_configure() is
// UBX-CFG-VALSET (class 0x06, id 0x8A) regardless of which keys it
// carries, so ubx_wait_ack()'s (class, id) check can't tell two VALSET
// replies apart by content — only by timing. If a previous packet's ACK
// arrived late (after that wait had already given up) it would otherwise
// still be waiting and get misread as this packet's reply. Dropping
// right before the send — not just before the wait — shrinks that race
// to the gap between the drop and the transmit instead of the whole gap
// since the last timeout; the protocol doesn't expose enough information
// (no per-message sequence number) to close it further than that.
//
// Retries once, immediately, on a timeout (not on a NAK — that's a
// definitive rejection, retrying it wastes time for nothing). This isn't
// speculative: real M10Q hardware logs across multiple runs consistently
// show the FIRST VALSET packet after the baud switch going unanswered for
// ~2.2 s (most likely the module still settling its own baud/protocol
// transition) while every packet after it gets a clean ACK immediately —
// and lengthening the pre-send delay up to 3x had no effect on that ~2.2s
// figure, so it isn't a "didn't wait long enough before sending" issue.
// A resend right after the first wait naturally times out lands after
// that same settling period has already elapsed, same as packets 2+ do.
static void ubx_send_and_confirm(GpsUart* g, const uint8_t* data, size_t len, const char* label) {
    for(int attempt = 0; attempt < 2; attempt++) {
        g->platform.rx_clear(g->platform.ctx);
        g->platform.tx(g->platform.ctx, data, len);
        UbxAckOutcome outcome = ubx_wait_ack(g, data[2], data[3]);
        if(outcome == UbxAckAck) return;
        if(outcome == UbxAckNak) {
            gps_log(&g->platform, true, "%s: rejected (UBX-ACK-NAK)", label);
            return;
        }
        // UbxAckTimeout: loop around for the one retry, or fall through
        // to the log below once attempts are exhausted.
    }
    gps_log(&g->platform, true, "%s: no ACK/NAK received", label);
}

// ── UBX-SEC-UNIQID (class 0x27, id 0x03) — unique chip ID poll ──────────
// u-blox M10 SPG 5.10 Interface Description §3.17.1: a 0-length poll
// request to this class/id gets back a 10-byte payload — version(1) +
// reserved(3) + uniqueId(6, the 48-bit chip ID) — per §3.5.2's generic UBX
// polling mechanism (send the message with no payload, receive it back
// with the payload populated).
static const uint8_t ubx_poll_uniqid[] = {0xB5, 0x62, 0x27, 0x03, 0x00, 0x00, 0x2A, 0xA5};

// One attempt: send the poll, read back exactly one frame, accept it only
// if it's actually UBX-SEC-UNIQID with a valid checksum. Anything else
// (wrong class/id/length, corrupted frame, timeout) is a failure.
static bool ubx_poll_chip_id_once(GpsUart* g) {
    g->platform.rx_clear(g->platform.ctx); // drop stale bytes first — see ubx_send_and_confirm()'s doc comment
    g->platform.tx(g->platform.ctx, ubx_poll_uniqid, sizeof(ubx_poll_uniqid));

    if(!ubx_find_sync(g)) return false;

    uint8_t hdr[4]; // class, id, len_lo, len_hi
    if(!ubx_read_byte(g, &hdr[0]) || !ubx_read_byte(g, &hdr[1]) ||
       !ubx_read_byte(g, &hdr[2]) || !ubx_read_byte(g, &hdr[3])) {
        return false;
    }
    uint16_t len = (uint16_t)hdr[2] | ((uint16_t)hdr[3] << 8);
    if(hdr[0] != 0x27 || hdr[1] != 0x03 || len != 10) return false; // not our response

    uint8_t payload[10];
    for(int i = 0; i < 10; i++) {
        if(!ubx_read_byte(g, &payload[i])) return false;
    }
    uint8_t ck_a, ck_b;
    if(!ubx_read_byte(g, &ck_a) || !ubx_read_byte(g, &ck_b)) return false;

    uint8_t ck_buf[14] = {
        hdr[0], hdr[1], hdr[2], hdr[3],
        payload[0], payload[1], payload[2], payload[3], payload[4],
        payload[5], payload[6], payload[7], payload[8], payload[9]};
    uint8_t calc_a, calc_b;
    ubx_calc_checksum(ck_buf, sizeof(ck_buf), &calc_a, &calc_b);
    if(calc_a != ck_a || calc_b != ck_b) return false; // corrupted frame

    // payload[4..9] is the 6-byte (48-bit) uniqueId (spec offset 4, U1[6]).
    // Rendered as a 5-word phrase (EFF short wordlist, see
    // eff_short_wordlist.h) rather than 12 hex digits, for a CSV header a
    // human can actually glance at and recognise. 1296^5 == 6^20 ==
    // 3,656,158,440,062,976, comfortably >= 2^48 (281,474,976,710,656), so
    // — unlike a 4-word phrase, which would only cover ~41.4 of the 48
    // bits — this is a genuinely lossless, collision-free encoding: every
    // 48-bit chip ID maps to a unique 5-word phrase, not just a
    // recognisable label.
    uint64_t id = 0;
    for(int i = 0; i < 6; i++) {
        id = (id << 8) | payload[4 + i];
    }
    int digit[5];
    for(int i = 0; i < 5; i++) {
        digit[i] = (int)(id % EFF_SHORT_WORDLIST_COUNT);
        id /= EFF_SHORT_WORDLIST_COUNT;
    }
    // Most-significant word first (digit[4]..digit[0]) so the phrase reads
    // in the same order the underlying bits do.
    snprintf(g_gps_chip_id, sizeof(g_gps_chip_id), "%s %s %s %s %s",
             eff_short_wordlist[digit[4]], eff_short_wordlist[digit[3]],
             eff_short_wordlist[digit[2]], eff_short_wordlist[digit[1]],
             eff_short_wordlist[digit[0]]);
    return true;
}

// Retries once on failure, mirroring ubx_send_and_confirm()'s one-retry
// convention (see its doc comment) — a poll going unanswered on the very
// first attempt right after the baud switch is the same known settling
// behaviour that motivated that retry, not speculative.
// Attempted at most ONCE per GpsUart session (g->chip_id_poll_attempted),
// and skipped altogether once g_gps_chip_id has been captured by an earlier
// session in the same app run.
// gps_uart_configure() runs on every RX-buffer-full and NMEA-watchdog
// reinit, not just the initial create, and has no way to tell "first call
// in this session" apart from "mid-recovery retry". Without the per-session
// gate, a module that never answers this poll cleanly would pay up to ~3.6s
// of main-thread blocking (2 attempts x ubx_find_sync() hunting its full
// UBX_ACK_MAX_SYNC_BYTES budget through live NMEA) on every single reinit
// for the rest of the session, discarding real GPS fixes the whole time
// it's scanning. Keeping the gate on the GpsUart session rather than a
// process-lifetime global ensures that if the first session was opened while
// the GPS was unpowered, a later session opened after powering it on still
// gets its one shot at create().
static void ubx_poll_chip_id(GpsUart* g) {
    if(g_gps_chip_id[0] != '\0' || g->chip_id_poll_attempted) return;
    g->chip_id_poll_attempted = true;
    for(int attempt = 0; attempt < 2; attempt++) {
        if(ubx_poll_chip_id_once(g)) {
            gps_log(&g->platform, false, "GPS chip ID: %s", g_gps_chip_id);
            return;
        }
    }
    gps_log(&g->platform, true, "UBX-SEC-UNIQID poll: no valid response");
}

// ── CFG-VALSET packet builder ───────────────────────────────────────────
// u-blox M10 SPG 5.10 Interface Description §1.3: "Users are strongly
// advised to only use the Configuration interface [VALSET/VALGET]." The
// legacy CFG-MSG/CFG-RATE/CFG-NAV5 messages this replaces are absent from
// the SPG 5.10 message reference entirely (§3.10 lists only CFG-CFG,
// CFG-RST, CFG-VALDEL, CFG-VALGET, CFG-VALSET) — they may still work via
// a backward-compat shim, but nothing guarantees that on every firmware
// revision, which is the whole reason ubx_send_and_confirm() checks
// ACK/NAK in the first place.
//
// Key IDs self-describe their value size (bits 28-30 of the key), so the
// caller supplies value_len explicitly per pair rather than this code
// trying to infer it. Always writes to the RAM layer only — this app
// never persists GPS config to BBR/Flash, matching the rest of
// gps_uart_configure() (AssistNow's VALSET below does the same).
typedef struct {
    uint32_t key;
    const uint8_t* value;
    uint8_t value_len;
} UbxValsetPair;

static void ubx_send_valset(GpsUart* g, const UbxValsetPair* pairs, size_t count, const char* label) {
    uint8_t pkt[40];
    size_t n = 0;
    pkt[n++] = 0xB5; pkt[n++] = 0x62;
    pkt[n++] = 0x06; pkt[n++] = 0x8A; // CFG-VALSET
    size_t len_offset = n;
    n += 2; // length filled in below, once the payload size is known
    pkt[n++] = 0x00; // version
    pkt[n++] = 0x01; // layers: RAM only
    pkt[n++] = 0x00; pkt[n++] = 0x00; // reserved
    for(size_t i = 0; i < count; i++) {
        CORE_CHECK(n + 4 + pairs[i].value_len + 2 <= sizeof(pkt), "GpsUart: VALSET packet too large");
        pkt[n++] = (uint8_t)(pairs[i].key);
        pkt[n++] = (uint8_t)(pairs[i].key >> 8);
        pkt[n++] = (uint8_t)(pairs[i].key >> 16);
        pkt[n++] = (uint8_t)(pairs[i].key >> 24);
        memcpy(&pkt[n], pairs[i].value, pairs[i].value_len);
        n += pairs[i].value_len;
    }
    uint16_t payload_len = (uint16_t)(n - (len_offset + 2));
    pkt[len_offset] = (uint8_t)payload_len;
    pkt[len_offset + 1] = (uint8_t)(payload_len >> 8);

    uint8_t ck_a, ck_b;
    ubx_calc_checksum(&pkt[2], n - 2, &ck_a, &ck_b);
    pkt[n++] = ck_a;
    pkt[n++] = ck_b;

    ubx_send_and_confirm(g, pkt, n, label);
}

// ── M10Q configuration values ───────────────────────────────────────────
static void ubx_send_rate(GpsUart* g) {
    // 100 ms measRate = 10 Hz.  SAM-M10Q datasheet Table 1: 10 Hz is the
    // high-performance-mode maximum for the default 4-constellation config.
    // No separate HP-mode enable packet is required — setting the rate is
    // sufficient on M10 SPG 5.10 firmware.
    static const uint8_t meas_val[] = {0x64, 0x00}; // 100 (x 0.001s = 100ms = 10Hz)
    static const uint8_t nav_val[]  = {0x01, 0x00}; // 1 measurement per nav solution
    const UbxValsetPair pairs[] = {
        {0x30210001, meas_val, sizeof(meas_val)}, // CFG-RATE-MEAS
        {0x30210002, nav_val,  sizeof(nav_val)},  // CFG-RATE-NAV
    };
    ubx_send_valset(g, pairs, GPS_COUNT_OF(pairs), "CFG-VALSET rate 10Hz");
}

static void ubx_send_nmea_output_rates(GpsUart* g) {
    static const uint8_t off_val[] = {0x00};
    const UbxValsetPair pairs[] = {
        {0x209100ca, off_val, sizeof(off_val)}, // CFG-MSGOUT-NMEA_ID_GLL_UART1
        {0x209100b1, off_val, sizeof(off_val)}, // CFG-MSGOUT-NMEA_ID_VTG_UART1
        {0x209100c5, off_val, sizeof(off_val)}, // CFG-MSGOUT-NMEA_ID_GSV_UART1
    };
    ubx_send_valset(g, pairs, GPS_COUNT_OF(pairs), "CFG-VALSET NMEA output rates");
}

static void ubx_send_nav5(GpsUart* g, GpsNavModel nav_model) {
    // CFG-NAVSPG-DYNMODEL constants (spec Table 22) are numerically
    // identical to the legacy UBX-CFG-NAV5.dynModel byte values — same
    // enum, same wire values, just addressed as a VALSET key now.
    uint8_t dyn_model = 3; // Pedestrian default
    if(nav_model == GpsNavModelWrist) {
        dyn_model = 9; // Wrist-worn
    } else if(nav_model == GpsNavModelVehicle) {
        dyn_model = 4; // Vehicle / Automotive
    } else if(nav_model == GpsNavModelStationary) {
        dyn_model = 2; // Stationary / Seated
    } else if(nav_model == GpsNavModelSea) {
        dyn_model = 5; // Sea / Boating
    } else if(nav_model == GpsNavModelBike) {
        // No bicycle model exists: 10 (BIKE) is Motorbike, "not available
        // in all products", and absent from the MIA-M10Q's list (integration
        // manual Table 9). Portable is u-blox's general low-acceleration model.
        dyn_model = 0; // Portable
    } else if(nav_model == GpsNavModelFlight) {
        dyn_model = 7; // Airborne <2g / Commercial Flight
    }

    const UbxValsetPair pair = {0x20110021, &dyn_model, 1}; // CFG-NAVSPG-DYNMODEL
    ubx_send_valset(g, &pair, 1, "CFG-VALSET dynamic model");
}

// Super-S (integration manual §2.2.7): the receiver normally trusts weak
// signals less, since weakness usually means multipath; Super-S compensates
// for weakness that has another cause (small antenna, body nearby). The
// MIA-M10Q manual warns that where the weakness IS multipath "the receiver
// may overtrust distorted signals". CFG-NAVSPG-SIGATTCOMP (interface
// description Table 24): 0 = disabled, 255 = automatic (the default).
// Sent in both states, so switching back to automatic doesn't need a
// power cycle.
static void ubx_send_super_s(GpsUart* g, bool enabled) {
    const uint8_t mode = enabled ? 255 : 0;
    const UbxValsetPair pair = {0x201100d6, &mode, 1}; // CFG-NAVSPG-SIGATTCOMP
    ubx_send_valset(g, &pair, 1, enabled ? "CFG-VALSET Super-S auto" : "CFG-VALSET Super-S off");
}

static const uint8_t ubx_cfg_assistnow_autonomous[] = {
    // VALSET packet enabling CFG-ANA-USE_ANA = 1 (true) for offline orbit predictions
    0xB5, 0x62, 0x06, 0x8A, 0x09, 0x00, 0x00, 0x01, 0x00, 0x00, 0x01, 0x00, 0x23, 0x10, 0x01, 0xCF, 0xC0
};
static const uint8_t ubx_rxm_pmreq_standby[] = {
    // UBX-RXM-PMREQ software standby (Interface Description §3.16.6):
    // duration=0 (until woken), flags=0x06 (backup + force — force is
    // required on M10, integration manual §3.5.3.3), wakeupSources=0x08
    // (uartrx — see ubx_wake()). Must be the last byte sent: any later TX
    // edge wakes the module again.
    // tests/test_gps_uart.c checks every field against the spec.
    0xB5, 0x62, 0x02, 0x41, 0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00, 0x61, 0x6B
};
static const uint8_t ubx_cfg_rst_cold[] = {
    // UBX-CFG-RST (Interface Description §3.10.2): navBbrMask=0xFFFF (cold
    // start: clears every backup-RAM section — orbits, position, time,
    // AssistNow Autonomous predictions, weak-signal compensation estimates),
    // resetMode=0x02 (controlled software reset, GNSS only).
    // tests/test_gps_uart.c checks every field against the spec.
    0xB5, 0x62, 0x06, 0x04, 0x04, 0x00, 0xFF, 0xFF, 0x02, 0x00, 0x0E, 0x61
};
// Switch the module to 115200 (sent at 9600). outProto=0002 → NMEA only
// (0001=UBX would disable ASCII output).
static const char pubx_baud_115200[] = "$PUBX,41,1,0007,0002,115200,0*19\r\n";

static void gps_uart_configure(GpsUart* g);

// Put the module to sleep from whatever state it is in at app start: asleep,
// awake at its 9600 default, or awake at 115200 (left configured). Always
// sleeps it from 115200 — the path that held on hardware — never from 9600
// straight after a restart, which failed every time.
void gps_uart_sleep_from_unknown_state(const GpsPlatform* p) {
    CORE_CHECK(p && p->set_baud && p->tx && p->rx_start && p->rx_stop && p->rx_wake_seen &&
                   p->now_ms && p->delay_ms,
               "GpsUart: incomplete platform");
    p->set_baud(p->ctx, GPS_BAUD_RATE);
    // Wake it (a no-op if already awake), move it to 115200 and follow it
    // there. A module already at 115200 ignores the 9600 command and
    // simply stays there.
    ubx_wake(p);
    p->tx(p->ctx, (const uint8_t*)pubx_baud_115200, strlen(pubx_baud_115200));
    p->delay_ms(p->ctx, 200);
    p->set_baud(p->ctx, GPS_BAUD_RATE_FAST);
    p->delay_ms(p->ctx, 50);
    p->tx(p->ctx, ubx_rxm_pmreq_standby, sizeof(ubx_rxm_pmreq_standby));
    p->delay_ms(p->ctx, 100); // let it finish shifting out, and any NMEA already in flight
}

// ── Serial baud-switch helper — stop/re-set/restart at a new baud,
// resetting the RX line-framing state (rx_offset, received bytes) since
// bytes framed under the old baud are meaningless at the new one. Used by
// gps_uart_configure() right after the module is told to switch to 115200,
// and by gps_uart_reinit(). The delay that follows differs by call site
// (50 ms there vs. 100 ms below), so that stays at each call site.
static void gps_uart_switch_baud(GpsUart* g, uint32_t baud) {
    const GpsPlatform* p = &g->platform;
    p->rx_stop(p->ctx);
    p->set_baud(p->ctx, baud);
    g->rx_offset = 0;
    p->rx_clear(p->ctx);
    p->rx_start(p->ctx, GpsRxStream);
}

// ── Serial reinit helper — switch baud, then re-run the full module
// configure sequence. Used by both the RX-buffer-full handler and the NMEA
// watchdog so that any future change to the reinit sequence only needs to
// be made in one place.
static void gps_uart_reinit(GpsUart* g, uint32_t baud) {
    gps_uart_switch_baud(g, baud);
    g->platform.delay_ms(g->platform.ctx, 100);
    gps_uart_configure(g);
    g->last_valid_nmea_ms = 0;
    g->reinit_count++;
}

GpsUart* gps_uart_create(const GpsPlatform* platform, bool have_port,
                         GpsNavModel nav_model, bool super_s) {
    CORE_CHECK(platform, "GpsUart: NULL platform");
    CORE_CHECK(platform->set_baud && platform->tx && platform->rx_start && platform->rx_stop &&
                   platform->rx_read && platform->rx_clear && platform->rx_wake_seen &&
                   platform->rx_drop_count && platform->rx_again && platform->now_ms && platform->delay_ms &&
                   platform->lock && platform->unlock,
               "GpsUart: incomplete platform");
    // Zeroed, so only the fields that don't start at 0 / false are set here.
    GpsUart* g = calloc(1, sizeof(GpsUart));
    CORE_CHECK(g, "GpsUart: NULL struct alloc");
    g->platform  = *platform;
    g->nav_model = nav_model;
    g->super_s   = super_s;
    g->status = (GpsStatus){
        .latitude  = NAN,
        .longitude = NAN,
        .speed     = NAN,
        .course    = NAN,
        .hdop      = 99.9f,
        .hacc      = 99.9f,
        .fix_type  = 1,
        .pdop      = 99.9f,
    };
    // Arm watchdog at create so a botched initial baud-rate switch
    // triggers a one-shot recovery after 5 s instead of silently
    // leaving the host at 115200 while the module stays at 9600.
    g->last_valid_nmea_ms = g->platform.now_ms(g->platform.ctx);

    if(have_port) {
        const GpsPlatform* p = &g->platform;
        // The port idles at 115200 after a sleep; a woken module talks at 9600.
        p->set_baud(p->ctx, GPS_BAUD_RATE);
        // Wake the module from software standby and wait until it is
        // listening before gps_uart_configure() sends $PUBX,41 at 9600.
        ubx_wake(p);
        p->rx_start(p->ctx, GpsRxStream);
        g->ready = true;
        gps_uart_configure(g);
    }

    return g;
}

// ---------------------------------------------------------------------------
// Destroy — sleep the module; the device keeps its port open
// ---------------------------------------------------------------------------
void gps_uart_destroy(GpsUart* g) {
    CORE_CHECK(g, "GpsUart: NULL in destroy()");
    if(g->ready) {
        // Sent at the session's 115200, the last byte before the line idles.
        ubx_tx(g, ubx_rxm_pmreq_standby, sizeof(ubx_rxm_pmreq_standby));
        g->platform.rx_stop(g->platform.ctx);
    }
    free(g);
}

void* gps_uart_platform_ctx(const GpsUart* g) {
    CORE_CHECK(g, "GpsUart: NULL in platform_ctx()");
    return g->platform.ctx;
}

// ---------------------------------------------------------------------------
// Status accessors
// ---------------------------------------------------------------------------
GpsStatus gps_uart_get_status(const GpsUart* g) {
    CORE_CHECK(g, "GpsUart: NULL in get_status()");
    g->platform.lock(g->platform.ctx);
    GpsStatus s = g->status;
    g->platform.unlock(g->platform.ctx);
    return s;
}

bool gps_uart_is_ready(const GpsUart* g) {
    CORE_CHECK(g, "GpsUart: NULL in is_ready()");
    return g->ready;
}

uint32_t gps_uart_get_rx_drop_count(const GpsUart* g) {
    CORE_CHECK(g, "GpsUart: NULL in get_rx_drop_count()");
    if(!g->ready) return 0;
    return g->platform.rx_drop_count(g->platform.ctx);
}

uint32_t gps_uart_get_nmea_fail_count(const GpsUart* g) {
    CORE_CHECK(g, "GpsUart: NULL in get_nmea_fail_count()");
    return g->nmea_fail_count;
}

uint32_t gps_uart_get_reinit_count(const GpsUart* g) {
    CORE_CHECK(g, "GpsUart: NULL in get_reinit_count()");
    return g->reinit_count;
}

const char* gps_uart_get_chip_id(const GpsUart* g) {
    CORE_CHECK(g, "GpsUart: NULL in get_chip_id()");
    return g_gps_chip_id;
}

// ---------------------------------------------------------------------------
// Drain received bytes, parse complete NMEA lines; run NMEA watchdog
// ---------------------------------------------------------------------------
void gps_uart_handle_rx(GpsUart* g) {
    CORE_CHECK(g, "GpsUart: NULL in handle_rx()");
    if(!g->ready) return;
    const GpsPlatform* p = &g->platform;

    size_t len = 0;
    size_t drained_bytes = 0;
    size_t parsed_lines = 0;
    bool budget_hit = false;
    bool may_have_more_stream = false;
    bool has_more_complete_lines = false;
    do {
        if(sizeof(g->rx_buf) - 1 - g->rx_offset == 0) {
            gps_log(p, true, "RX buffer full — reconfiguring");
            // Full reconfiguration (same as watchdog): switch host back to
            // 9600, then re-run the module init sequence.  A plain hot-start
            // would leave the module at default baud while the host is at
            // 115200.
            gps_uart_reinit(g, GPS_BAUD_RATE);
        }

        size_t remaining_budget = GPS_RX_MAX_DRAIN_BYTES_PER_CALL - drained_bytes;
        if(remaining_budget == 0) {
            budget_hit = true;
            break;
        }

        size_t recv_cap = sizeof(g->rx_buf) - 1 - g->rx_offset;
        if(recv_cap > remaining_budget) recv_cap = remaining_budget;

        len = p->rx_read(p->ctx, g->rx_buf + g->rx_offset, recv_cap);

        if(len > 0) {
            g->rx_offset += len;
            drained_bytes += len;
            if(len == recv_cap) may_have_more_stream = true;
        }

        if(g->rx_offset > 0) {
            char* line = (char*)g->rx_buf;
            char* end  = (char*)g->rx_buf + g->rx_offset;

            // Parse each complete line, holding the lock only for the
            // brief status update — not for the entire drain.
            p->lock(p->ctx);
            while(line < end) {
                if(parsed_lines >= GPS_RX_MAX_LINES_PER_CALL) {
                    budget_hit = true;
                    break;
                }
                char* nl = memchr(line, '\n', end - line);
                if(nl) {
                    *nl = '\0';
                    gps_uart_parse_line(g, line);
                    parsed_lines++;
                    line = nl + 1;
                } else {
                    break;
                }
            }
            p->unlock(p->ctx);

            if(g->gsa_talker_log_pending) {
                g->gsa_talker_log_pending = false;
                gps_log(p, false, "First GSA talker: %c%c SystemID=%d",
                        g->gsa_talker[0], g->gsa_talker[1], g->gsa_system_id);
            }

            if(budget_hit && line < end) {
                // Another complete line already sits in the current buffer.
                // Schedule a continuation rather than consuming it now.
                has_more_complete_lines = memchr(line, '\n', end - line) != NULL;
            }

            if(line > (char*)g->rx_buf) {
                size_t remaining = end - line;
                memmove(g->rx_buf, line, remaining);
                g->rx_offset = remaining;
            }

            if(budget_hit) break;
        }
    } while(len > 0);

    if(budget_hit && (len > 0 || may_have_more_stream || has_more_complete_lines)) {
        p->rx_again(p->ctx);
    }

    // ── NMEA watchdog: bytes are arriving but no valid sentence has ────
    // parsed in 5 seconds — most likely a baud mismatch after the module
    // reset itself (it reverts to 9600). Switch the host back to 9600 and re-run the full configure
    // sequence to restore 115200 + settings.
    //
    // Only evaluated here, i.e. when bytes arrive: a module that has gone
    // completely silent (unplugged) never triggers it. Deliberate — a
    // reconfigure can't revive a missing module, and each attempt blocks
    // the main thread for seconds waiting on ACKs that never come.
    if(g->last_valid_nmea_ms > 0) {
        uint32_t elapsed = p->now_ms(p->ctx) - g->last_valid_nmea_ms;
        if(elapsed > 5000) {
            gps_log(p, true, "NMEA watchdog: no valid sentence in 5 s — reconfiguring");
            gps_uart_reinit(g, GPS_BAUD_RATE);
        }
    }
}

// ---------------------------------------------------------------------------
// Send init sequence: switch to 115200 baud and apply the M10Q config.
// ---------------------------------------------------------------------------
static void gps_uart_configure(GpsUart* g) {
    CORE_CHECK(g, "GpsUart: NULL in configure()");
    if(!g->ready) return;
    const GpsPlatform* p = &g->platform;

    // ── u-blox SAM-M10Q ───────────────────────────────────────────────
    // Each binary UBX packet below is sent and then confirmed via
    // ubx_send_and_confirm() (UBX-ACK-ACK/NAK, see its doc comment) rather
    // than fired blind behind a fixed delay — ACK typically arrives within
    // a few ms at 115200 baud, and a rejected packet is caught.
    gps_log(p, false, "Configuring u-blox SAM-M10Q");

    gps_log(p, false, "Switching GPS to 115200 baud");
    p->tx(p->ctx, (const uint8_t*)pubx_baud_115200, strlen(pubx_baud_115200));
    p->delay_ms(p->ctx, 200);

    // Switch host UART to match
    gps_uart_switch_baud(g, GPS_BAUD_RATE_FAST);
    p->delay_ms(p->ctx, 50);

    // Send configuration via CFG-VALSET, confirming each packet's ACK/NAK.
    ubx_send_rate(g);
    ubx_send_nmea_output_rates(g);
    ubx_send_nav5(g, g->nav_model);
    ubx_send_super_s(g, g->super_s);
    ubx_send_and_confirm(g, ubx_cfg_assistnow_autonomous, sizeof(ubx_cfg_assistnow_autonomous), "CFG-VALSET AssistNow");
    // Enable $PUBX,00 for live hAcc in metres, on UART1 once per navigation
    // solution (the rate field counts solutions, not seconds) — so 10 Hz,
    // with every fix: the logs show hAcc changing within 0.1–0.9 s. Proprietary
    // NMEA-PUBX-RATE (spec §2.8.3) — still current in SPG 5.10 (unlike
    // CFG-MSG), and there's no VALSET key for a proprietary PUBX sentence,
    // so this ASCII command is the only mechanism for it.
    const char* pubx_00_rate = "$PUBX,40,00,1,1,0,0*1B\r\n";
    ubx_tx(g, (const uint8_t*)pubx_00_rate, strlen(pubx_00_rate));

    // Best-effort, and attempted at most once ever regardless of outcome
    // — see ubx_poll_chip_id()'s doc comment for why "only until found"
    // alone isn't enough. Runs after everything else above has already
    // established the link is working (clean ACKs).
    ubx_poll_chip_id(g);

    gps_log(p, false, "M10Q running at 115200 baud, 10 Hz");
}

// ---------------------------------------------------------------------------
// Cold Start reset.
// ---------------------------------------------------------------------------
void gps_uart_send_cold_start(GpsUart* g) {
    CORE_CHECK(g, "GpsUart: NULL in send_cold_start()");
    if(!g->ready) return;
    gps_log(&g->platform, false, "Cold Start reset");
    ubx_tx(g, ubx_cfg_rst_cold, sizeof(ubx_cfg_rst_cold));
}
