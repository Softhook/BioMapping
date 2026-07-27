#pragma once

// storage/storage.h — host-test shim.
//
// modules/sd_logger.c calls the real Flipper Storage API directly
// (storage_file_alloc/open/close/write/free, storage_dir_open/read/close)
// — unmodified from what ships in the Flipper build. This shim fakes the
// subset of that surface sd_logger.c actually calls, backed by a genuine
// in-memory virtual filesystem (storage_mock.c) so find_next_index()'s
// directory scan and the batch-write path both exercise real logic, not
// stubs that always succeed.
//
// Real storage_sd_api.h pulls in <furi.h> transitively — that's the only
// reason sd_logger.c's furi_assert()/FURI_LOG_*() calls resolve in
// production despite the file never including <furi.h> itself (same
// "hidden transitive include" shape already noted for gsr_sensor.c in
// docs/host_testing.md). Mirrored here so the shim matches real behaviour
// rather than requiring sd_logger.c to change.
#include <furi.h>

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define STORAGE_EXT_PATH_PREFIX "/ext"
#define EXT_PATH(path) STORAGE_EXT_PATH_PREFIX "/" path

typedef struct Storage Storage;
typedef struct File File;

typedef enum {
    FSAM_READ = (1 << 0),
    FSAM_WRITE = (1 << 1),
    FSAM_READ_WRITE = FSAM_READ | FSAM_WRITE,
} FS_AccessMode;

typedef enum {
    FSOM_OPEN_EXISTING = 1,
    FSOM_OPEN_ALWAYS = 2,
    FSOM_OPEN_APPEND = 4,
    FSOM_CREATE_NEW = 8,
    FSOM_CREATE_ALWAYS = 16,
} FS_OpenMode;

typedef enum {
    FSF_DIRECTORY = (1 << 0),
} FS_Flags;

typedef struct {
    uint8_t  flags;
    uint64_t size;
} FileInfo;

typedef enum {
    FSE_OK = 0,
    FSE_NOT_READY = 1,
    FSE_EXIST = 2,
    FSE_NOT_EXIST = 3,
    FSE_INVALID_PARAMETER = 4,
    FSE_DENIED = 5,
    FSE_INVALID_OBJECT = 6,
    FSE_WRITE_PROTECTED = 7,
    FSE_ENABLED_DRIVE = 8,
    FSE_NOT_ENABLED = 9,
    FSE_NO_FILESYSTEM = 10,
    FSE_ALREADY_EXISTS = 11,
    FSE_INTERNAL = 12,
} FS_Error;

File* storage_file_alloc(Storage* storage);
void  storage_file_free(File* file);

bool   storage_file_open(File* file, const char* path, FS_AccessMode access_mode, FS_OpenMode open_mode);
bool   storage_file_close(File* file);
size_t storage_file_write(File* file, const void* buff, size_t bytes_to_write);
size_t storage_file_read(File* file, void* buff, size_t bytes_to_read);

bool storage_simply_remove(Storage* storage, const char* path);
bool storage_common_remove(Storage* storage, const char* path);
bool storage_common_mkdir(Storage* storage, const char* path);
FS_Error storage_common_rename(Storage* storage, const char* old_path, const char* new_path);

bool storage_dir_open(File* file, const char* path);
bool storage_dir_close(File* file);
bool storage_dir_read(File* file, FileInfo* fileinfo, char* name, uint16_t name_length);

// ── Mock control / test-injection API ──────────────────────────────────
// Not part of the real SDK — only used by tests/test_sd_logger.c.

Storage* storage_mock_alloc(void);
void     storage_mock_free(Storage* storage);

// Pre-seed an existing zero-length file at `path`, as if a previous
// session had already created it — lets tests exercise find_next_index()'s
// directory scan without a full write.
void storage_mock_touch_file(Storage* storage, const char* path);

// Full accumulated contents written to `path` so far. Returns NULL (and
// sets *out_len = 0) if the path was never opened for write. The pointer
// is owned by the mock and only valid until the next mutating call.
const uint8_t* storage_mock_get_file_contents(Storage* storage, const char* path, size_t* out_len);

bool storage_mock_file_exists(Storage* storage, const char* path);

// Next storage_dir_open() call returns false (simulates the "biomapping"
// directory not existing yet — e.g. first-ever recording). Auto-clears
// after one use.
void storage_mock_fail_next_dir_open(Storage* storage, bool fail);

// Next storage_file_open() call for a write returns false (simulates an
// unmounted/full SD card). Auto-clears after one use.
void storage_mock_fail_next_open(Storage* storage, bool fail);

// While true, storage_file_write() writes 0 bytes regardless of the
// requested length (simulates a failed/full SD write).
void storage_mock_fail_writes(Storage* storage, bool fail);
