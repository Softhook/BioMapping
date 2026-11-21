#pragma once

// Plain-C rules for the Cardputer's Wi-Fi Files screen (host-tested in
// firmware/tests/test_cardputer_rules.c):
//   - strict .csv filename validation (blocks path traversal and non-CSV files
//     such as biomap.settings, biomap.cal, and macOS ._ AppleDouble files)
//   - hotspot SSID, password, and Wi-Fi QR code formatting
//   - human-readable byte sizes and JSON string escaping
//   - parsing MS-DOS date/time from biomap_YYYY-MM-DD_HH-MM-SS.csv filenames

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// Maximum CSV filename length (including NUL terminator). Recording names like
// "biomap_2026-11-21_14-32-05_2.csv" are ~32 bytes; 64 gives ample headroom.
#define WIFI_FILES_MAX_NAME 64

// True only for a safe, plain ".csv" (or ".CSV") filename inside
// /sd/biomapping/. Rejects empty strings, names starting with '.' (hidden or
// macOS "._*" files), "..", slashes, control characters, quotes, and anything
// that does not end in ".csv".
bool wifi_files_name_valid(const char* name);

// Formats the open hotspot name "BioMapping-XXXX" from the last two bytes of
// the 6-byte hardware MAC address.
void wifi_files_format_ssid(const uint8_t mac[6], char* out, size_t out_sz);

// Length of the hotspot password (WPA2 needs at least 8 characters).
#define WIFI_FILES_PASS_LEN 10

// Turns WIFI_FILES_PASS_LEN random bytes into an easy-to-type password made of
// lowercase letters and digits 2-9, leaving out look-alikes (0/o, 1/l). The
// alphabet has exactly 32 characters so every byte maps without bias.
// `out_sz` must be at least WIFI_FILES_PASS_LEN + 1.
void wifi_files_format_password(const uint8_t rand_bytes[WIFI_FILES_PASS_LEN],
                                char* out, size_t out_sz);

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
