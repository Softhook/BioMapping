// SD logger on the Flipper: the file functions the shared code in
// core/sd_logger.c works through, written with the Flipper's storage
// service. Recordings go in /ext/biomapping/.

#include "sd_logger_flipper.h"
#include <furi.h>
#include <stdio.h>
#include <stdlib.h>

#define TAG "SdLogger"

typedef struct {
    Storage* storage;
    File*    file;  // NULL when no file is open
} SdFlipper;

static SdOpenResult sd_flipper_open_new(void* ctx, const char* name) {
    SdFlipper* f = ctx;
    char full_path[96];
    snprintf(full_path, sizeof(full_path), EXT_PATH(BIOMAP_DIR_NAME "/%s"), name);
    f->file = storage_file_alloc(f->storage);
    if(!f->file) return SdOpenFailed;
    // FSOM_CREATE_NEW: the card refuses a name that already exists.
    if(storage_file_open(f->file, full_path, FSAM_WRITE, FSOM_CREATE_NEW)) return SdOpenOk;
    storage_file_free(f->file);
    f->file = NULL;
    return storage_file_exists(f->storage, full_path) ? SdOpenNameTaken : SdOpenFailed;
}

static size_t sd_flipper_write(void* ctx, const void* data, size_t len) {
    SdFlipper* f = ctx;
    return storage_file_write(f->file, data, len);
}

static bool sd_flipper_sync(void* ctx) {
    SdFlipper* f = ctx;
    return storage_file_sync(f->file);
}

static bool sd_flipper_seek(void* ctx, uint32_t pos) {
    SdFlipper* f = ctx;
    return storage_file_seek(f->file, pos, true);
}

static bool sd_flipper_truncate(void* ctx) {
    SdFlipper* f = ctx;
    return storage_file_truncate(f->file);
}

static void sd_flipper_close(void* ctx) {
    SdFlipper* f = ctx;
    storage_file_close(f->file);
    storage_file_free(f->file);
    f->file = NULL;
}

static uint32_t sd_flipper_now_ms(void* ctx) {
    (void)ctx;
    return furi_get_tick();
}

// Always real FURI_LOG_* calls — debug CSV *fields* are a runtime
// Options-menu toggle, unrelated to whether these serial logs exist; the
// Flipper's own runtime log level controls what is visible.
static void sd_flipper_log(void* ctx, SdLogLevel level, const char* line) {
    (void)ctx;
    switch(level) {
    case SdLogInfo:    FURI_LOG_I(TAG, "%s", line); break;
    case SdLogWarning: FURI_LOG_W(TAG, "%s", line); break;
    case SdLogError:   FURI_LOG_E(TAG, "%s", line); break;
    }
}

SdLogger* sd_logger_alloc(Storage* storage) {
    furi_check(storage, "SdLogger: NULL storage in alloc()");
    SdFlipper* f = malloc(sizeof(SdFlipper));
    furi_check(f, "SdLogger: NULL alloc");
    *f = (SdFlipper){.storage = storage};
    SdPlatform platform = {
        .ctx      = f,
        .open_new = sd_flipper_open_new,
        .write    = sd_flipper_write,
        .sync     = sd_flipper_sync,
        .seek     = sd_flipper_seek,
        .truncate = sd_flipper_truncate,
        .close    = sd_flipper_close,
        .now_ms   = sd_flipper_now_ms,
        .log      = sd_flipper_log,
    };
    // Every row at each flush: the Flipper doesn't need whole blocks.
    return sd_logger_create(&platform, 0);
}

void sd_logger_free(SdLogger* logger) {
    SdFlipper* f = sd_logger_platform_ctx(logger); // stops on NULL
    sd_logger_destroy(logger);
    free(f);
}
