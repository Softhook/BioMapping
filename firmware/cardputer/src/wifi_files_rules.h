#pragma once

// Plain-C rules for the Cardputer's Wi-Fi Files screen (host-tested in
// firmware/tests/test_cardputer_rules.c):
//   - newest-first ordering of recording names
//   - strict .csv filename validation (blocks path traversal and non-CSV files
//     such as biomap.settings, biomap.cal, and macOS ._ AppleDouble files)
//   - hotspot SSID and Wi-Fi QR code formatting
//   - human-readable byte sizes and JSON string escaping
//   - parsing MS-DOS date/time from biomap_NNNN_YYYY-MM-DD_HH-MM-SS.csv filenames

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// Maximum CSV filename length (including NUL terminator). Recording names like
// "biomap_0042_2026-11-21_14-32-05_2.csv" are ~37 bytes; 64 gives ample headroom.
#define WIFI_FILES_MAX_NAME 64

// True only for a safe, plain ".csv" (or ".CSV") filename inside
// /sd/biomapping/. Rejects empty strings, names starting with '.' (hidden or
// macOS "._*" files), "..", slashes, control characters, quotes, and anything
// that does not end in ".csv".
bool wifi_files_name_valid(const char* name);

// The recording number at the front of a Cardputer name
// ("biomap_0042_2026-11-21_14-32-05.csv" or "biomap_0043_nodate.csv" -> 42 or
// 43), or 0 when the name has none (files from before the numbers).
uint32_t wifi_files_name_number(const char* name);

// Orders two recording names by when they were recorded: < 0 when `a` is
// older than `b`, > 0 when newer, 0 when equal. Numbered names go by their
// recording number and always count as newer than names without one. The
// rest is compared with runs of digits as numbers, so a same-second "_10"
// sorts after "_9" (plain strcmp puts "_10" first).
int wifi_files_name_compare(const char* a, const char* b);

// Formats the open hotspot name "BioMapping-XXXX" from the last two bytes of
// the 6-byte hardware MAC address.
void wifi_files_format_ssid(const uint8_t mac[6], char* out, size_t out_sz);

// Formats a Wi-Fi QR payload. With a non-empty `password` this is
// "WIFI:T:WPA;S:<ssid>;P:<password>;;"; with NULL or "" it is an open network
// "WIFI:T:nopass;S:<ssid>;;". Escapes \, ;, , and : as the Wi-Fi QR format
// requires.
void wifi_files_format_wifi_qr(const char* ssid, const char* password,
                               char* out, size_t out_sz);

// Formats a byte count for display (e.g. "512 B", "12.4 KB", "1.8 MB").
void wifi_files_format_size(uint64_t bytes, char* out, size_t out_sz);

// Escapes `src` for placement inside a JSON double-quoted string. Always
// NUL-terminates when out_sz > 0 and returns the number of characters written
// (excluding the NUL).
size_t wifi_files_json_escape(const char* src, char* out, size_t out_sz);

// Extracts MS-DOS date and time bitfields (for ZIP headers) from a recording
// filename like "biomap_2026-11-21_14-32-05.csv". Falls back to 1980-01-01
// 00:00:00 (the minimum valid DOS timestamp) if the filename has no valid
// post-1980 timestamp (e.g. 1970-01-01 when GPS time was not set).
void wifi_files_dos_datetime_from_name(const char* name,
                                       uint16_t* dos_date,
                                       uint16_t* dos_time);

#ifdef __cplusplus
}
#endif
