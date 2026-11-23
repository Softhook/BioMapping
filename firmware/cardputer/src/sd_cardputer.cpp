#include "sd_cardputer.h"

#include <M5Cardputer.h>
#include <SD.h>
#include <SPI.h>
#include <USB.h>
#include <USBMSC.h>
#include <errno.h>
#include <esp_heap_caps.h>
#include <fcntl.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include "core_check.h"
#include "tusb.h"
#include "write_queue.h"

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
// If the USB cable is unplugged while the card is lent to a computer, take
// the card back after 3 seconds.
static const uint32_t USB_UNPLUG_TIMEOUT_MS = 3000;

static bool mounted = false;
static SemaphoreHandle_t g_sd_mutex = nullptr;
static volatile bool g_lent = false;
static volatile bool g_ejected = false;
static uint32_t g_unplugged_since_ms = 0;
static int g_open_files = 0;
static uint8_t g_sector_scratch[BLOCK_BYTES];

static void sd_lock(void) {
    if(!g_sd_mutex) g_sd_mutex = xSemaphoreCreateMutex();
    xSemaphoreTake(g_sd_mutex, portMAX_DELAY);
}

static void sd_unlock(void) {
    xSemaphoreGive(g_sd_mutex);
}

// ── USB thumb drive mode (modeled on pocket-wui's src/usb.cpp) ─────────
//
// While the Cardputer owns the card, mediaPresent(false) tells the computer
// the drive slot is empty. When the user presses U (outside a recording),
// mediaPresent(true) hands raw 512-byte sector reads and writes to the
// computer via SD.readRAW / SD.writeRAW. When the computer ejects the drive
// (or the user presses U again), mediaPresent(false) takes it back and
// remounts /sd so FatFs sees any files the computer deleted or changed.

static int32_t on_usb_read(uint32_t lba, uint32_t offset, void* buffer, uint32_t bufsize) {
    sd_lock();
    if(!g_lent || offset >= BLOCK_BYTES) {
        sd_unlock();
        return -1;
    }
    uint8_t* dst = static_cast<uint8_t*>(buffer);
    uint32_t remaining = bufsize;
    uint32_t cur_lba = lba;
    uint32_t cur_off = offset;
    while(remaining > 0) {
        uint32_t chunk = BLOCK_BYTES - cur_off;
        if(chunk > remaining) chunk = remaining;
        if(cur_off == 0 && chunk == BLOCK_BYTES) {
            if(!SD.readRAW(dst, cur_lba)) {
                sd_unlock();
                return -1;
            }
        } else {
            if(!SD.readRAW(g_sector_scratch, cur_lba)) {
                sd_unlock();
                return -1;
            }
            memcpy(dst, g_sector_scratch + cur_off, chunk);
        }
        dst += chunk;
        remaining -= chunk;
        cur_lba++;
        cur_off = 0;
    }
    sd_unlock();
    return (int32_t)bufsize;
}

static int32_t on_usb_write(uint32_t lba, uint32_t offset, uint8_t* buffer, uint32_t bufsize) {
    sd_lock();
    if(!g_lent || offset >= BLOCK_BYTES) {
        sd_unlock();
        return -1;
    }
    const uint8_t* src = buffer;
    uint32_t remaining = bufsize;
    uint32_t cur_lba = lba;
    uint32_t cur_off = offset;
    while(remaining > 0) {
        uint32_t chunk = BLOCK_BYTES - cur_off;
        if(chunk > remaining) chunk = remaining;
        if(cur_off == 0 && chunk == BLOCK_BYTES) {
            if(!SD.writeRAW(const_cast<uint8_t*>(src), cur_lba)) {
                sd_unlock();
                return -1;
            }
        } else {
            if(!SD.readRAW(g_sector_scratch, cur_lba)) {
                sd_unlock();
                return -1;
            }
            memcpy(g_sector_scratch + cur_off, src, chunk);
            if(!SD.writeRAW(g_sector_scratch, cur_lba)) {
                sd_unlock();
                return -1;
            }
        }
        src += chunk;
        remaining -= chunk;
        cur_lba++;
        cur_off = 0;
    }
    sd_unlock();
    return (int32_t)bufsize;
}

static bool on_usb_start_stop(uint8_t power_condition, bool start, bool load_eject) {
    (void)power_condition;
    // Only treat an explicit host Eject (start=false, load_eject=true) as
    // handing the card back; ignore idle power-state stops.
    if(!start && load_eject) {
        g_ejected = true;
    }
    return true;
}

// In Arduino-ESP32 with ARDUINO_USB_CDC_ON_BOOT=1, app_main() calls
// USB.begin() before setup(). Constructing g_msc and setting its callbacks
// at file scope registers the USB mass-storage interface before USB.begin()
// starts the bus.
static USBMSC g_msc;
static bool   g_msc_started = false;

namespace {
struct UsbMscSetup {
    UsbMscSetup() {
        g_msc.vendorID("BioMap");
        g_msc.productID("Cardputer SD");
        g_msc.productRevision("1.0");
        g_msc.onStartStop(on_usb_start_stop);
        g_msc.onRead(on_usb_read);
        g_msc.onWrite(on_usb_write);
        g_msc.isWritable(true);
        g_msc.mediaPresent(false);
    }
} g_usb_msc_setup;
}  // namespace

// The card sits inside the Cardputer and can't come out while it runs, so
// once mounted it stays mounted until lent over USB. A failed mount (no
// card at start-up) is tried again at the next session.
bool sd_card_mount(void) {
    if(g_lent) return false;
    if(mounted) return true;
    if(!g_sd_mutex) g_sd_mutex = xSemaphoreCreateMutex();
    int cs = M5.getPin(m5::pin_name_t::sd_spi_ss);
    SPI.begin(M5.getPin(m5::pin_name_t::sd_spi_sclk), M5.getPin(m5::pin_name_t::sd_spi_miso),
              M5.getPin(m5::pin_name_t::sd_spi_mosi), cs);
    if(!SD.begin(cs, SPI, SD_HZ, MOUNT)) return false;
    if(mkdir(DIR_PATH, 0777) != 0 && errno != EEXIST) return false;
    mounted = true;
    if(!g_msc_started && SD.sectorSize() == BLOCK_BYTES && SD.numSectors() > 0) {
        g_msc.begin(SD.numSectors(), BLOCK_BYTES);
        g_msc_started = true;
    }
    return true;
}

bool sd_card_ready(void) {
    return mounted && !g_lent;
}

bool sd_usb_drive_active(void) {
    return g_lent;
}

SdUsbResult sd_usb_drive_set(bool on) {
    if(on == g_lent) return SdUsbOk;
    if(on) {
        if(g_open_files > 0) return SdUsbFileOpen;
        if(!sd_card_mount()) return SdUsbNoCard;
        if(SD.sectorSize() != BLOCK_BYTES || SD.numSectors() == 0) return SdUsbNoCard;
        if(!tud_ready()) return SdUsbNoComputer;
        sd_lock();
        g_ejected = false;
        g_unplugged_since_ms = 0;
        g_lent = true;
        g_msc.mediaPresent(true);
        sd_unlock();
        Serial.println("[SD] USB drive on: card lent to computer");
        return SdUsbOk;
    }

    // Hide the medium first, then wait under the lock for any in-flight USB
    // sector read or write to finish before remounting FatFs.
    g_msc.mediaPresent(false);
    sd_lock();
    g_lent = false;
    g_ejected = false;
    g_unplugged_since_ms = 0;
    sd_unlock();

    SD.end();
    mounted = false;
    sd_card_mount();
    Serial.println("[SD] USB drive off: card back with Cardputer");
    return SdUsbOk;
}

bool sd_usb_drive_poll(void) {
    if(!g_lent) return false;
    if(g_ejected) {
        g_ejected = false;
        sd_usb_drive_set(false);
        return true;
    }
    if(!tud_ready()) {
        uint32_t now = millis();
        if(g_unplugged_since_ms == 0) {
            g_unplugged_since_ms = now ? now : 1;
        } else if(now - g_unplugged_since_ms >= USB_UNPLUG_TIMEOUT_MS) {
            sd_usb_drive_set(false);
            return true;
        }
    } else {
        g_unplugged_since_ms = 0;
    }
    return false;
}

size_t sd_write_all(int fd, const void* data, size_t len) {
    const uint8_t* p = static_cast<const uint8_t*>(data);
    size_t done = 0;
    // write() may take less than asked; carry on until it stops taking any.
    while(done < len) {
        ssize_t n = write(fd, p + done, len - done);
        if(n <= 0) break;
        done += (size_t)n;
    }
    return done;
}

// ── Recording writes in the background ─────────────────────────────────
//
// A card write and sync usually takes about 15 ms, but now and then the
// first one of a recording takes most of a second (877 ms measured). Done
// on the main loop, that froze the GSR reading for as long. So the
// logger's writes only copy into a queue, and a task of its own puts the
// queue on the card and syncs it. The shared logger doesn't change: to it,
// every write and sync just takes no time.
//
// A failure comes back one call late. When the task can't write, the
// stuck bytes stay at the front of the queue, new writes are refused and
// the next sync fails, so the logger keeps its rows and counts a failed
// flush, as it would have when writing directly. The task tries the stuck
// bytes again every second; once they're on the card, writes are taken
// again and the logger's own retry lands after them, in order.
//
// Seek, truncate and close only happen at the start and end of a
// recording. They wait for the queue to empty first, so they find the file
// where the logger left it.
//
// The task and its queue exist only while a recording session is open,
// like the GSR reader's task, so Wi-Fi Files and Live Stream find memory
// as it was without them: Bluetooth after a few Wi-Fi visits needs all of
// it. If either can't be had, the logger writes directly, as it used to.
// The task runs on core 0, away from the main loop and the GSR reader on
// core 1. Core 0 also carries Bluetooth and Wi-Fi, but neither runs during
// a recording.

// ~13 s of the widest rows (GPS + GSR with Debug Fields), more than one
// 10 s flush. No bigger: with it, a recording leaves about 54 KB free.
static const size_t   QUEUE_BYTES = 16 * 1024;
static const uint32_t RETRY_MS = 1000;
static const uint32_t WRITER_STACK = 4096;
static const UBaseType_t WRITER_PRIORITY = 1;

// All guarded by g_q_mutex, which is made once and never freed (its
// memory is static).
static StaticSemaphore_t g_q_mutex_mem;
static SemaphoreHandle_t g_q_mutex = nullptr;
static WriteQueue g_q;
static int  g_q_fd = -1;             // the recording file, -1 when none
static bool g_writer_busy = false;   // a write or sync is under way
static bool g_write_failed = false;  // bytes are stuck at the front of the queue
static bool g_sync_failed = false;   // a sync failed; the next plat_sync() says so
static uint32_t g_write_peak_ms = 0; // slowest write + sync this recording
static bool g_writer_stop = false;   // asks the task to end
static TaskHandle_t g_writer = nullptr;  // nullptr once the task has ended

static void q_lock(void) {
    xSemaphoreTake(g_q_mutex, portMAX_DELAY);
}

static void q_unlock(void) {
    xSemaphoreGive(g_q_mutex);
}

static void writer_task(void* arg) {
    (void)arg;
    for(;;) {
        q_lock();
        bool retry = g_write_failed;
        bool stop = g_writer_stop;
        q_unlock();
        if(stop) break;
        ulTaskNotifyTake(pdTRUE, retry ? pdMS_TO_TICKS(RETRY_MS) : portMAX_DELAY);

        q_lock();
        int fd = g_q_fd;
        if(fd < 0 || g_q.count == 0) {
            q_unlock();
            continue;
        }
        g_writer_busy = true;
        q_unlock();

        // Everything waiting, including whatever is added meanwhile, then
        // one sync.
        uint32_t start = millis();
        bool ok = true;
        for(;;) {
            const uint8_t* p;
            q_lock();
            size_t n = write_queue_peek(&g_q, &p);
            q_unlock();
            if(n == 0) break;
            size_t w = sd_write_all(fd, p, n);
            q_lock();
            write_queue_drop(&g_q, w);
            q_unlock();
            if(w < n) {
                ok = false;
                break;
            }
        }
        bool synced = ok && fsync(fd) == 0;
        uint32_t took = millis() - start;

        q_lock();
        if(took > g_write_peak_ms) g_write_peak_ms = took;
        g_write_failed = !ok;
        if(ok && !synced) g_sync_failed = true;
        g_writer_busy = false;
        q_unlock();
    }
    q_lock();
    g_writer = nullptr;
    q_unlock();
    vTaskDelete(nullptr);
}

// Waits until the queue is on the card. If the card has failed, drops what
// is stuck instead: only the start or end of a recording waits here, and
// a recording whose card failed has already counted the failure.
static void drain(void) {
    for(;;) {
        q_lock();
        bool idle = !g_writer_busy && (g_q.count == 0 || g_write_failed);
        if(idle) write_queue_clear(&g_q);
        q_unlock();
        if(idle) return;
        vTaskDelay(1);
    }
}

uint32_t sd_cardputer_write_peak_ms(void) {
    if(!g_q_mutex) return 0;  // no recording session yet
    q_lock();
    uint32_t peak = g_write_peak_ms;
    q_unlock();
    return peak;
}

struct SdCardputer {
    int fd = -1;  // -1 when no file is open
    // No memory for the queue: writes go straight to the card, holding up
    // the main loop as they used to.
    bool direct = false;
    uint32_t direct_write_ms = 0;  // time in write() since the last sync
};

static SdOpenResult plat_open_new(void* ctx, const char* name) {
    auto* c = static_cast<SdCardputer*>(ctx);
    if(g_lent || !sd_card_mount()) return SdOpenFailed;
    char path[96];
    snprintf(path, sizeof(path), "%s/%s", DIR_PATH, name);
    // O_EXCL: the card refuses a name that already exists.
    c->fd = open(path, O_WRONLY | O_CREAT | O_EXCL, 0666);
    if(c->fd >= 0) {
        g_open_files++;
        q_lock();
        g_q_fd = c->fd;
        g_write_failed = false;
        g_sync_failed = false;
        g_write_peak_ms = 0;
        q_unlock();
        return SdOpenOk;
    }
    return errno == EEXIST ? SdOpenNameTaken : SdOpenFailed;
}

// Queues the bytes for the writing task. Waits only if the queue is full,
// and takes nothing while bytes are stuck (see above).
static size_t plat_write(void* ctx, const void* data, size_t len) {
    auto* c = static_cast<SdCardputer*>(ctx);
    if(c->direct) {
        uint32_t start = millis();
        size_t w = sd_write_all(c->fd, data, len);
        c->direct_write_ms += millis() - start;
        return w;
    }
    const uint8_t* p = static_cast<const uint8_t*>(data);
    size_t done = 0;
    while(done < len) {
        q_lock();
        bool failed = g_write_failed;
        size_t n = failed ? 0 : write_queue_put(&g_q, p + done, len - done);
        q_unlock();
        if(failed) break;
        done += n;
        xTaskNotifyGive(g_writer);
        if(done < len) vTaskDelay(1);  // full: wait for the card
    }
    return done;
}

static bool plat_sync(void* ctx) {
    auto* c = static_cast<SdCardputer*>(ctx);
    if(c->direct) {
        uint32_t start = millis();
        bool ok = fsync(c->fd) == 0;
        uint32_t took = c->direct_write_ms + (millis() - start);
        c->direct_write_ms = 0;
        q_lock();
        if(took > g_write_peak_ms) g_write_peak_ms = took;
        q_unlock();
        return ok;
    }
    q_lock();
    bool ok = !g_write_failed && !g_sync_failed;
    g_sync_failed = false;
    q_unlock();
    return ok;
}

// FatFs grows the file when asked to move past its end.
static bool plat_seek(void* ctx, uint32_t pos) {
    drain();
    return lseek(static_cast<SdCardputer*>(ctx)->fd, (off_t)pos, SEEK_SET) == (off_t)pos;
}

static bool plat_truncate(void* ctx) {
    drain();
    int fd = static_cast<SdCardputer*>(ctx)->fd;
    off_t pos = lseek(fd, 0, SEEK_CUR);
    return pos >= 0 && ftruncate(fd, pos) == 0;
}

static void plat_close(void* ctx) {
    auto* c = static_cast<SdCardputer*>(ctx);
    if(c->fd >= 0) {
        drain();
        q_lock();
        g_q_fd = -1;
        q_unlock();
        close(c->fd);
        c->fd = -1;
        if(g_open_files > 0) g_open_files--;
    }
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
    if(!g_q_mutex) g_q_mutex = xSemaphoreCreateMutexStatic(&g_q_mutex_mem);
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
    // The logger's own buffer first: it can't do without it. After Wi-Fi
    // the free memory can be in pieces too small for the queue.
    SdLogger* logger = sd_logger_create(&platform, BLOCK_BYTES);
    auto* buf = static_cast<uint8_t*>(malloc(QUEUE_BYTES));
    q_lock();
    write_queue_init(&g_q, buf, buf ? QUEUE_BYTES : 0);
    g_writer_stop = false;
    q_unlock();
    TaskHandle_t task = nullptr;
    if(buf && xTaskCreatePinnedToCore(writer_task, "sd_write", WRITER_STACK, nullptr,
                                      WRITER_PRIORITY, &task, 0) == pdPASS) {
        q_lock();
        g_writer = task;
        q_unlock();
    } else {
        Serial.printf("[SD] warning: no memory for the card-writing task (largest free piece "
                      "%u bytes); writing directly\n",
                      (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_8BIT));
        q_lock();
        write_queue_init(&g_q, nullptr, 0);
        q_unlock();
        free(buf);
        c->direct = true;
    }
    return logger;
}

void sd_cardputer_free(SdLogger* logger) {
    auto* c = static_cast<SdCardputer*>(sd_logger_platform_ctx(logger));  // stops on NULL
    sd_logger_destroy(logger);  // closes the file: the queue is empty after
    delete c;
    // End the task, and wait until it has.
    q_lock();
    bool running = g_writer != nullptr;
    if(running) {
        g_writer_stop = true;
        xTaskNotifyGive(g_writer);
    }
    q_unlock();
    while(running) {
        vTaskDelay(1);
        q_lock();
        running = g_writer != nullptr;
        q_unlock();
    }
    q_lock();
    uint8_t* buf = g_q.buf;
    write_queue_init(&g_q, nullptr, 0);
    q_unlock();
    free(buf);  // nothing when writing directly
}
