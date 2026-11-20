#include "sd_cardputer.h"

#include <M5Cardputer.h>
#include <SD.h>
#include <SPI.h>
#include <errno.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

#include "core_check.h"

// Arduino's SD library mounts the card's FAT file system at /sd. The file
// itself is written with the plain POSIX calls underneath it (open, write,
// fsync, lseek, ftruncate): Arduino's File has no truncate, and its own
// buffering would split the whole-block writes back up.
static const char* const MOUNT = "/sd";
static const char* const DIR_PATH = "/sd/biomapping";
// 25 MHz, the SD card's standard speed. The bench measured whole-block
// writes at 15 ms typical, 57 ms worst at this speed; 40 MHz was faster
// but not needed (docs/cardputer_port.md, section 5).
static const uint32_t SD_HZ = 25000000;
static const uint32_t BLOCK_BYTES = 512;

static bool mounted = false;

// Checks the card is still there: SD.cardType() only says what was found
// at mount time, so it can't tell a card that has been taken out.
static bool card_present(void) {
    struct stat st;
    return stat(DIR_PATH, &st) == 0;
}

static void unmount(void) {
    if(mounted) SD.end();
    mounted = false;
}

bool sd_card_mount(void) {
    if(mounted && card_present()) return true;
    unmount();
    int cs = M5.getPin(m5::pin_name_t::sd_spi_ss);
    SPI.begin(M5.getPin(m5::pin_name_t::sd_spi_sclk), M5.getPin(m5::pin_name_t::sd_spi_miso),
              M5.getPin(m5::pin_name_t::sd_spi_mosi), cs);
    if(!SD.begin(cs, SPI, SD_HZ, MOUNT)) return false;
    if(mkdir(DIR_PATH, 0777) != 0 && errno != EEXIST) return false;
    mounted = true;
    return true;
}

bool sd_card_ready(void) {
    return mounted;
}

struct SdCardputer {
    int fd = -1;  // -1 when no file is open
};

static SdOpenResult plat_open_new(void* ctx, const char* name) {
    auto* c = static_cast<SdCardputer*>(ctx);
    if(!sd_card_mount()) return SdOpenFailed;
    char path[96];
    snprintf(path, sizeof(path), "%s/%s", DIR_PATH, name);
    // O_EXCL: the card refuses a name that already exists.
    c->fd = open(path, O_WRONLY | O_CREAT | O_EXCL, 0666);
    if(c->fd >= 0) return SdOpenOk;
    if(errno == EEXIST) return SdOpenNameTaken;
    // Any other failure may be a card swapped since it was mounted (the
    // file system still describes the old one): mount again and retry once.
    unmount();
    if(!sd_card_mount()) return SdOpenFailed;
    c->fd = open(path, O_WRONLY | O_CREAT | O_EXCL, 0666);
    if(c->fd >= 0) return SdOpenOk;
    return errno == EEXIST ? SdOpenNameTaken : SdOpenFailed;
}

static size_t plat_write(void* ctx, const void* data, size_t len) {
    auto* c = static_cast<SdCardputer*>(ctx);
    const uint8_t* p = static_cast<const uint8_t*>(data);
    size_t done = 0;
    // write() may take less than asked; carry on until it stops taking any.
    while(done < len) {
        ssize_t n = write(c->fd, p + done, len - done);
        if(n <= 0) break;
        done += (size_t)n;
    }
    return done;
}

static bool plat_sync(void* ctx) {
    return fsync(static_cast<SdCardputer*>(ctx)->fd) == 0;
}

// FatFs grows the file when asked to move past its end.
static bool plat_seek(void* ctx, uint32_t pos) {
    return lseek(static_cast<SdCardputer*>(ctx)->fd, (off_t)pos, SEEK_SET) == (off_t)pos;
}

static bool plat_truncate(void* ctx) {
    int fd = static_cast<SdCardputer*>(ctx)->fd;
    off_t pos = lseek(fd, 0, SEEK_CUR);
    return pos >= 0 && ftruncate(fd, pos) == 0;
}

static void plat_close(void* ctx) {
    auto* c = static_cast<SdCardputer*>(ctx);
    close(c->fd);
    c->fd = -1;
}

static uint32_t plat_now_ms(void* ctx) {
    (void)ctx;
    return millis();
}

static void plat_log(void* ctx, SdLogLevel level, const char* line) {
    (void)ctx;
    static const char* const LEVEL[] = {"", " warning:", " error:"};
    Serial.printf("[SD]%s %s\n", LEVEL[level], line);
}

SdLogger* sd_cardputer_alloc(void) {
    auto* c = new SdCardputer();
    SdPlatform platform = {};
    platform.ctx = c;
    platform.open_new = plat_open_new;
    platform.write = plat_write;
    platform.sync = plat_sync;
    platform.seek = plat_seek;
    platform.truncate = plat_truncate;
    platform.close = plat_close;
    platform.now_ms = plat_now_ms;
    platform.log = plat_log;
    return sd_logger_create(&platform, BLOCK_BYTES);
}

void sd_cardputer_free(SdLogger* logger) {
    auto* c = static_cast<SdCardputer*>(sd_logger_platform_ctx(logger));  // stops on NULL
    sd_logger_destroy(logger);
    delete c;
}
