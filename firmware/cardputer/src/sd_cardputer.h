#pragma once

// SD card on the Cardputer: mounting the card, and the file functions the
// shared logger (core/sd_logger.c) works through. Recordings go in
// /biomapping/ on the card, as on the Flipper.

#include "sd_logger.h"

// Mounts the card if it isn't mounted yet, and makes /biomapping/. True
// once the card is ready. Safe to call again.
bool sd_card_mount(void);

// Whether the Cardputer has the card mounted and isn't lending it to a
// computer over USB. Quick: doesn't touch the card.
bool sd_card_ready(void);

// USB thumb drive mode: lends the SD card to a plugged-in computer as a
// drive, and takes it back (remounting so the Cardputer sees any changes)
// when the computer ejects it, the cable is unplugged, or sd_usb_drive_set(false)
// is called. Refused while a recording file is open or when USB isn't
// plugged into a computer.
bool sd_usb_drive_active(void);
bool sd_usb_drive_set(bool on);
// Call from loop(): returns true if the computer ejected the drive or the
// USB cable was unplugged and the card was taken back.
bool sd_usb_drive_poll(void);

// A logger writing in whole 512-byte blocks (see "SD card pauses" in
// docs/cardputer_port.md, section 5).
SdLogger* sd_cardputer_alloc(void);
void      sd_cardputer_free(SdLogger* logger);
