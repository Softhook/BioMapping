#pragma once

// Reading the recordings over the USB serial link, so a computer can fetch
// them without taking the (built-in) SD card out. Read-only.
//
// Commands, one per line:
//   ls          lists biomapping/ with each file's size
//   cat NAME    sends one file: "BEGIN NAME SIZE", the file's bytes, "END"
// Refused while recording, so a long transfer can't hold up the session.

// Call every pass of the main loop.
void serial_files_poll(bool recording);
