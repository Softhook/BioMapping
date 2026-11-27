#include "recording_number.h"

#include <Preferences.h>
#include <dirent.h>

#include "sd_cardputer.h"
#include "wifi_files_rules.h"

static const char* const NVS_SPACE = "biomap";
static const char* const NVS_KEY = "rec_no";

static uint32_t stored_last(void) {
    Preferences prefs;
    if(!prefs.begin(NVS_SPACE, true)) return 0;  // nothing saved yet
    uint32_t n = prefs.getUInt(NVS_KEY, 0);
    prefs.end();
    return n;
}

static uint32_t highest_on_card(void) {
    if(!sd_card_ready()) return 0;
    DIR* dir = opendir(SD_BIOMAP_DIR);
    if(!dir) return 0;
    uint32_t best = 0;
    for(struct dirent* ent; (ent = readdir(dir)) != nullptr;) {
        uint32_t n = wifi_files_name_number(ent->d_name);
        if(n > best) best = n;
    }
    closedir(dir);
    return best;
}

uint32_t recording_number_next(void) {
    uint32_t a = stored_last();
    uint32_t b = highest_on_card();
    return (a > b ? a : b) + 1;
}

void recording_number_used(uint32_t n) {
    Preferences prefs;
    if(!prefs.begin(NVS_SPACE, false)) {
        Serial.println("[Session] warning: could not save recording number");
        return;
    }
    prefs.putUInt(NVS_KEY, n);
    prefs.end();
}
