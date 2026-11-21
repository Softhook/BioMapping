#include "serial_files.h"

#include <Arduino.h>
#include <dirent.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>

#include "sd_cardputer.h"

#define DIR_PATH_LITERAL "/sd/biomapping"
static const char* const DIR_PATH = DIR_PATH_LITERAL;

static char   line[96];
static size_t line_len = 0;
static bool   line_too_long = false;  // the current line didn't fit: refused at its end

static void list_files(void) {
    DIR* d = opendir(DIR_PATH);
    if(!d) {
        Serial.println("ERR no biomapping folder");
        return;
    }
    Serial.println("BEGIN ls");
    while(struct dirent* e = readdir(d)) {
        char path[sizeof(DIR_PATH_LITERAL) + sizeof(e->d_name) + 1];
        snprintf(path, sizeof(path), "%s/%s", DIR_PATH, e->d_name);
        struct stat st;
        if(stat(path, &st) == 0 && S_ISREG(st.st_mode)) {
            Serial.printf("%s %ld\n", e->d_name, (long)st.st_size);
        }
    }
    closedir(d);
    Serial.println("END");
}

static void send_file(const char* name) {
    // A plain name only: no folders, so nothing outside biomapping/.
    if(!name[0] || strchr(name, '/') || strstr(name, "..")) {
        Serial.println("ERR bad name");
        return;
    }
    char path[160];
    snprintf(path, sizeof(path), "%s/%s", DIR_PATH, name);
    FILE* f = fopen(path, "rb");
    if(!f) {
        Serial.println("ERR not found");
        return;
    }
    struct stat st;
    fstat(fileno(f), &st);
    Serial.printf("BEGIN %s %ld\n", name, (long)st.st_size);
    // Waits for the computer to take each piece: a lost byte would spoil
    // the file's CRC check.
    Serial.setTxTimeoutMs(1000);
    uint8_t buf[512];
    size_t n;
    uint8_t last = '\n';
    while((n = fread(buf, 1, sizeof(buf), f)) > 0) {
        Serial.write(buf, n);
        last = buf[n - 1];
    }
    Serial.setTxTimeoutMs(0);
    fclose(f);
    // END on a line of its own. A finished recording already ends with a
    // newline; one cut short (power lost mid-row) may not.
    if(last != '\n') Serial.println();
    Serial.println("END");
}

void serial_files_poll(bool recording) {
    while(Serial.available()) {
        int c = Serial.read();
        if(c == '\r') continue;
        if(c != '\n') {
            if(line_len < sizeof(line) - 1) line[line_len++] = (char)c;
            else line_too_long = true;
            continue;
        }
        line[line_len] = '\0';
        line_len = 0;
        bool too_long = line_too_long;
        line_too_long = false;
        if(too_long) {
            Serial.println("ERR line too long");
            continue;
        }
        if(!line[0]) continue;
        if(recording) {
            Serial.println("ERR recording: stop it first");
        } else if(!sd_card_ready()) {
            Serial.println("ERR no SD card");
        } else if(strcmp(line, "ls") == 0) {
            list_files();
        } else if(strncmp(line, "cat ", 4) == 0) {
            send_file(line + 4);
        } else {
            Serial.println("ERR commands: ls, cat NAME");
        }
    }
}
