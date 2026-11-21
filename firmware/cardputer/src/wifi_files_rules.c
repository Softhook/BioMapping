#include "wifi_files_rules.h"

#include <stdio.h>
#include <string.h>

static char ascii_lower(char c) {
    return (c >= 'A' && c <= 'Z') ? (char)(c + ('a' - 'A')) : c;
}

bool wifi_files_name_valid(const char* name) {
    if(!name || name[0] == '\0' || name[0] == '.') return false;

    size_t len = 0;
    for(; name[len] != '\0'; len++) {
        if(len >= WIFI_FILES_MAX_NAME - 1) return false;
        unsigned char c = (unsigned char)name[len];
        if(c < 0x20 || c >= 0x7F) return false;
        if(c == '/' || c == '\\' || c == '"' || c == '<' || c == '>') return false;
        if(c == '.' && len > 0 && name[len - 1] == '.') return false;
    }

    if(len < 5) return false;  // at least "a.csv"
    return name[len - 4] == '.' &&
           ascii_lower(name[len - 3]) == 'c' &&
           ascii_lower(name[len - 2]) == 's' &&
           ascii_lower(name[len - 1]) == 'v';
}

void wifi_files_format_ssid(const uint8_t mac[6], char* out, size_t out_sz) {
    if(!out || out_sz == 0) return;
    if(!mac) {
        snprintf(out, out_sz, "BioMapping-0000");
        return;
    }
    snprintf(out, out_sz, "BioMapping-%02X%02X", (unsigned)mac[4], (unsigned)mac[5]);
}

void wifi_files_format_password(const uint8_t rand_bytes[WIFI_FILES_PASS_LEN],
                                char* out, size_t out_sz) {
    static const char ALPHABET[] = "abcdefghijkmnpqrstuvwxyz23456789";
    _Static_assert(sizeof(ALPHABET) - 1 == 32, "alphabet must have 32 characters");
    if(!out || out_sz == 0) return;
    size_t n = 0;
    if(rand_bytes) {
        for(; n < WIFI_FILES_PASS_LEN && n + 1 < out_sz; n++) {
            out[n] = ALPHABET[rand_bytes[n] & 0x1Fu];
        }
    }
    out[n] = '\0';
}

// Appends `src` to out[*pos], escaping Wi-Fi QR special characters. Stops
// early rather than splitting an escape pair, always leaving `reserve` bytes.
static void qr_append(char* out, size_t out_sz, size_t* pos, const char* src,
                      bool escape, size_t reserve) {
    if(!src) return;
    for(size_t i = 0; src[i] != '\0'; i++) {
        char c = src[i];
        bool esc = escape && (c == '\\' || c == ';' || c == ',' || c == ':');
        size_t need = esc ? 2 : 1;
        if(*pos + need + reserve > out_sz) return;
        if(esc) out[(*pos)++] = '\\';
        out[(*pos)++] = c;
    }
}

void wifi_files_format_wifi_qr(const char* ssid, const char* password,
                               char* out, size_t out_sz) {
    if(!out || out_sz == 0) return;
    bool secured = password && password[0] != '\0';
    size_t pos = 0;
    out[0] = '\0';
    qr_append(out, out_sz, &pos, secured ? "WIFI:T:WPA;S:" : "WIFI:T:nopass;S:", false, 1);
    qr_append(out, out_sz, &pos, ssid, true, 3);  // reserve ";;\0"
    if(secured) {
        qr_append(out, out_sz, &pos, ";P:", false, 3);
        qr_append(out, out_sz, &pos, password, true, 3);
    }
    qr_append(out, out_sz, &pos, ";;", false, 1);
    out[pos] = '\0';
}

void wifi_files_format_size(uint64_t bytes, char* out, size_t out_sz) {
    if(!out || out_sz == 0) return;
    if(bytes < 1024ULL) {
        snprintf(out, out_sz, "%llu B", (unsigned long long)bytes);
    } else if(bytes < 1024ULL * 1024ULL) {
        uint64_t tenths = (bytes * 10ULL + 512ULL) / 1024ULL;
        snprintf(out, out_sz, "%llu.%llu KB",
                 (unsigned long long)(tenths / 10ULL),
                 (unsigned long long)(tenths % 10ULL));
    } else if(bytes < 1024ULL * 1024ULL * 1024ULL) {
        uint64_t tenths = (bytes * 10ULL + 524288ULL) / (1024ULL * 1024ULL);
        snprintf(out, out_sz, "%llu.%llu MB",
                 (unsigned long long)(tenths / 10ULL),
                 (unsigned long long)(tenths % 10ULL));
    } else {
        uint64_t tenths = (bytes * 10ULL + 536870912ULL) / (1024ULL * 1024ULL * 1024ULL);
        snprintf(out, out_sz, "%llu.%llu GB",
                 (unsigned long long)(tenths / 10ULL),
                 (unsigned long long)(tenths % 10ULL));
    }
}

size_t wifi_files_json_escape(const char* src, char* out, size_t out_sz) {
    if(!out || out_sz == 0) return 0;
    size_t pos = 0;
    if(!src) {
        out[0] = '\0';
        return 0;
    }
    for(size_t i = 0; src[i] != '\0'; i++) {
        unsigned char c = (unsigned char)src[i];
        if(c == '"' || c == '\\') {
            if(pos + 2 >= out_sz) break;
            out[pos++] = '\\';
            out[pos++] = (char)c;
        } else if(c < 0x20) {
            if(pos + 6 >= out_sz) break;
            int n = snprintf(out + pos, out_sz - pos, "\\u%04x", (unsigned)c);
            if(n <= 0) break;
            pos += (size_t)n;
        } else {
            if(pos + 1 >= out_sz) break;
            out[pos++] = (char)c;
        }
    }
    out[pos] = '\0';
    return pos;
}

static bool parse_digits(const char* s, size_t count, uint32_t* out) {
    uint32_t v = 0;
    for(size_t i = 0; i < count; i++) {
        if(s[i] < '0' || s[i] > '9') return false;
        v = v * 10u + (uint32_t)(s[i] - '0');
    }
    *out = v;
    return true;
}

static uint32_t days_in_month(uint32_t yr, uint32_t mo) {
    static const uint8_t DAYS[12] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
    if(mo == 2 && ((yr % 4u == 0 && yr % 100u != 0) || (yr % 400u == 0))) return 29;
    return DAYS[mo - 1];
}

void wifi_files_dos_datetime_from_name(const char* name,
                                       uint16_t* dos_date,
                                       uint16_t* dos_time) {
    // Default: 1980-01-01 00:00:00 (minimum valid MS-DOS timestamp).
    uint16_t def_date = (uint16_t)((1u << 5) | 1u);
    uint16_t def_time = 0u;
    if(dos_date) *dos_date = def_date;
    if(dos_time) *dos_time = def_time;
    if(!name) return;

    // Look for "YYYY-MM-DD_HH-MM-SS" anywhere after an optional prefix (e.g. "biomap_").
    size_t len = strlen(name);
    if(len < 19) return;
    for(size_t i = 0; i + 19 <= len; i++) {
        const char* p = name + i;
        if(p[4] != '-' || p[7] != '-' || p[10] != '_' || p[13] != '-' || p[16] != '-') {
            continue;
        }
        uint32_t yr = 0, mo = 0, dy = 0, hr = 0, mi = 0, sc = 0;
        if(!parse_digits(p, 4, &yr) || !parse_digits(p + 5, 2, &mo) ||
           !parse_digits(p + 8, 2, &dy) || !parse_digits(p + 11, 2, &hr) ||
           !parse_digits(p + 14, 2, &mi) || !parse_digits(p + 17, 2, &sc)) {
            continue;
        }
        if(yr < 1980 || yr > 2107 || mo < 1 || mo > 12 || dy < 1 || dy > days_in_month(yr, mo) ||
           hr > 23 || mi > 59 || sc > 59) {
            return;
        }
        if(dos_date) {
            *dos_date = (uint16_t)(((yr - 1980u) << 9) | (mo << 5) | dy);
        }
        if(dos_time) {
            *dos_time = (uint16_t)((hr << 11) | (mi << 5) | (sc >> 1));
        }
        return;
    }
}
