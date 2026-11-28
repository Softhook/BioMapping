#pragma once

// SD card on the Cardputer: mounting the card, and the file functions the
// shared logger (core/sd_logger.c) works through. Recordings go in
// /biomapping/ on the card, as on the Flipper.

#include "sd_logger.h"

// Mounted folder on the SD card where recordings, settings and calibration live.
#define SD_BIOMAP_DIR "/sd/" BIOMAP_DIR_NAME

// Mounts the card if it isn't mounted yet, and makes /biomapping/. True
// once the card is ready. Safe to call again.
bool sd_card_mount(void);

// Whether the card is mounted. Quick: doesn't touch the card.
bool sd_card_ready(void);

// Writes all `len` bytes to `fd`, carrying on while write() takes only part
// of them. Returns how many were written: `len`, or fewer if it failed.
size_t sd_write_all(int fd, const void* data, size_t len);

// A logger writing in whole 512-byte blocks (see "SD card pauses" in
// docs/cardputer_port.md, section 5). Its writes go to the card from a
// task of their own, started here and ended by sd_cardputer_free(), so a
// slow card never holds up the main loop; if there is no memory left for
// that task and its queue, it writes directly, as it used to.
SdLogger* sd_cardputer_alloc(void);
void      sd_cardputer_free(SdLogger* logger);

// The slowest card write and sync of the current recording, in ms, as
// timed by that task (the logger's own flush peak only times the copy
// into its queue).
uint32_t sd_cardputer_write_peak_ms(void);
