#pragma once

// The Cardputer's recording number: one more for every recording it starts,
// put at the front of the file name ("biomap_0042_2026-11-21_14-32-05.csv",
// or "biomap_0043_nodate.csv" before GPS time), so recordings list in the
// order they were made even when some have no date.
//
// The last number used is kept in the Cardputer's own flash, so it carries
// on after the card is emptied or swapped. The card is also checked for its
// highest number, so a card that has been in another Cardputer never gets a
// number twice.

#include <stdint.h>

// The number the next recording should use.
uint32_t recording_number_next(void);

// Remembers `n` as used, once its file has really been created.
void recording_number_used(uint32_t n);
