#pragma once

// SD card on the Cardputer: mounting the card, and the file functions the
// shared logger (core/sd_logger.c) works through. Recordings go in
// /biomapping/ on the card, as on the Flipper.

#include "sd_logger.h"

// Mounts the card if it isn't mounted yet, and makes /biomapping/. True
// once the card is ready. Safe to call again.
bool sd_card_mount(void);

// Whether the last mount worked. Quick: doesn't touch the card.
bool sd_card_ready(void);

// A logger writing in whole 512-byte blocks (see "SD card pauses" in
// docs/cardputer_port.md, section 5).
SdLogger* sd_cardputer_alloc(void);
void      sd_cardputer_free(SdLogger* logger);
