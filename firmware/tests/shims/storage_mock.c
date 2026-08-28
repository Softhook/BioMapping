// storage_mock.c — in-memory virtual filesystem backing tests/shims/storage/storage.h.
//
// Just enough of a real filesystem for modules/sd_logger.c to run
// unmodified against: storage_file_open/write/close persist real bytes
// keyed by full path, and storage_dir_open/read enumerates them by
// prefix, so find_next_index()'s directory scan is exercised for real
// rather than stubbed out.

#include "storage/storage.h"
#include <stdlib.h>
#include <string.h>
#include <assert.h>

#define MOCK_MAX_FILES 64
#define MOCK_PATH_LEN  128

typedef struct {
    char     path[MOCK_PATH_LEN];
    uint8_t* data;
    size_t   size;
    size_t   capacity;
    size_t   pos;      // current read/write pointer, distinct from size —
                        // needed so storage_file_seek() past EOF can grow
                        // `size` ahead of `pos` (pre-allocation) without
                        // every existing append-only test noticing: as long
                        // as nothing seeks, pos tracks size exactly like
                        // before.
    bool     used;
} MockFile;

struct Storage {
    MockFile files[MOCK_MAX_FILES];
    bool     fail_next_dir_open;
    bool     fail_next_open;
    bool     fail_writes;
    uint32_t next_write_delay_ticks;
    uint32_t next_seek_extend_delay_ticks;
    size_t   capacity_limit; // 0 = unlimited
};

struct File {
    Storage*  storage;
    bool      open;
    bool      is_dir;
    MockFile* vfile;                  // regular-file case
    char      dir_prefix[MOCK_PATH_LEN]; // directory case
    int       dir_index;              // next storage->files[] slot to scan
};

Storage* storage_mock_alloc(void) {
    Storage* s = malloc(sizeof(Storage));
    assert(s);
    memset(s, 0, sizeof(Storage));
    return s;
}

void storage_mock_free(Storage* storage) {
    if(!storage) return;
    for(int i = 0; i < MOCK_MAX_FILES; i++) {
        free(storage->files[i].data);
    }
    free(storage);
}

static MockFile* find_file(Storage* s, const char* path) {
    for(int i = 0; i < MOCK_MAX_FILES; i++) {
        if(s->files[i].used && strcmp(s->files[i].path, path) == 0) return &s->files[i];
    }
    return NULL;
}

static MockFile* alloc_file_slot(Storage* s, const char* path) {
    MockFile* existing = find_file(s, path);
    if(existing) return existing;
    for(int i = 0; i < MOCK_MAX_FILES; i++) {
        if(!s->files[i].used) {
            s->files[i].used = true;
            strncpy(s->files[i].path, path, MOCK_PATH_LEN - 1);
            s->files[i].path[MOCK_PATH_LEN - 1] = '\0';
            return &s->files[i];
        }
    }
    return NULL;
}

void storage_mock_touch_file(Storage* storage, const char* path) {
    alloc_file_slot(storage, path);
}

const uint8_t* storage_mock_get_file_contents(Storage* storage, const char* path, size_t* out_len) {
    MockFile* f = find_file(storage, path);
    if(!f) {
        if(out_len) *out_len = 0;
        return NULL;
    }
    if(out_len) *out_len = f->size;
    return f->data;
}

bool storage_mock_file_exists(Storage* storage, const char* path) {
    return find_file(storage, path) != NULL;
}

void storage_mock_fail_next_dir_open(Storage* storage, bool fail) { storage->fail_next_dir_open = fail; }
void storage_mock_fail_next_open(Storage* storage, bool fail) { storage->fail_next_open = fail; }
void storage_mock_fail_writes(Storage* storage, bool fail) { storage->fail_writes = fail; }

void storage_mock_set_next_write_delay_ticks(Storage* storage, uint32_t ticks) {
    storage->next_write_delay_ticks = ticks;
}

void storage_mock_set_next_seek_extend_delay_ticks(Storage* storage, uint32_t ticks) {
    storage->next_seek_extend_delay_ticks = ticks;
}

void storage_mock_set_capacity_limit(Storage* storage, size_t max_bytes) {
    storage->capacity_limit = max_bytes;
}

File* storage_file_alloc(Storage* storage) {
    File* f = malloc(sizeof(File));
    assert(f);
    memset(f, 0, sizeof(File));
    f->storage = storage;
    return f;
}

void storage_file_free(File* file) {
    if(!file) return;
    if(file->open) {
        if(file->is_dir) {
            storage_dir_close(file);
        } else {
            storage_file_close(file);
        }
    }
    free(file);
}

bool storage_file_open(File* file, const char* path, FS_AccessMode access_mode, FS_OpenMode open_mode) {
    (void)access_mode;
    Storage* s = file->storage;

    if(s->fail_next_open) {
        s->fail_next_open = false;
        return false;
    }

    if(open_mode == FSOM_CREATE_ALWAYS && (access_mode & FSAM_WRITE)) {
        MockFile* existing = find_file(s, path);
        if(existing) {
            existing->size = 0;   // truncate to zero, matching FSOM_CREATE_ALWAYS
        } else {
            existing = alloc_file_slot(s, path);
            if(!existing) return false;   // out of mock file slots
        }
        existing->pos = 0;
        file->vfile = existing;
        file->is_dir = false;
        file->open = true;
        return true;
    }

    if(open_mode == FSOM_OPEN_EXISTING) {
        MockFile* existing = find_file(s, path);
        if(!existing) return false;
        existing->pos = 0;
        file->vfile = existing;
        file->is_dir = false;
        file->open = true;
        return true;
    }

    return false;
}

bool storage_file_close(File* file) {
    file->open = false;
    return true;
}

// The mock's "storage" is just process memory — storage_file_write()
// already wrote directly into it, so there's no separate cache to commit.
// Always succeeds; no fail-injection hook exists for this yet since no
// test currently needs to exercise a sync failure.
bool storage_file_sync(File* file) {
    (void)file;
    return true;
}

size_t storage_file_write(File* file, const void* buff, size_t bytes_to_write) {
    Storage* s = file->storage;
    if(s->next_write_delay_ticks > 0) {
        furi_test_advance_tick(s->next_write_delay_ticks);
        s->next_write_delay_ticks = 0;
    }
    if(s->fail_writes) return 0;

    // Writes at the current position, not always at size's end -- matters
    // once storage_file_seek() has been used (pre-allocation). Every
    // existing caller never seeks, so pos == size always here for them,
    // identical to the old always-append behaviour.
    MockFile* f = file->vfile;
    size_t needed = f->pos + bytes_to_write;
    if(needed > f->capacity) {
        size_t new_cap = f->capacity ? f->capacity * 2 : 256;
        while(new_cap < needed) new_cap *= 2;
        uint8_t* grown = realloc(f->data, new_cap);
        assert(grown);
        f->data = grown;
        f->capacity = new_cap;
    }
    memcpy(f->data + f->pos, buff, bytes_to_write);
    f->pos += bytes_to_write;
    if(f->pos > f->size) f->size = f->pos;
    return bytes_to_write;
}

// Matches real f_lseek()'s write-mode expand-on-seek-past-EOF behaviour
// (elm-chan.org/fsw/ff/doc/lseek.html): the file size grows immediately, in
// this call, to the new position -- the gap's content is undefined (NOT
// zero-filled, unlike POSIX), so callers/tests must never assert on it.
// Real FatFs pays its cluster-allocation cost here too, which is why the
// seek-extend delay hook fires from this function rather than the next
// write.
bool storage_file_seek(File* file, uint32_t offset, bool from_start) {
    if(!file || !file->vfile) return false;
    MockFile* f = file->vfile;
    size_t new_pos = from_start ? (size_t)offset : f->pos + (size_t)offset;

    if(new_pos > f->size) {
        Storage* s = file->storage;
        // Real FatFs's f_lseek() can fail to expand as far as requested on
        // a full card -- see storage_mock_set_capacity_limit()'s doc
        // comment. The position/size are left untouched on this path (no
        // partial expand modeled), matching a plain seek failure.
        if(s->capacity_limit > 0 && new_pos > s->capacity_limit) return false;
        if(new_pos > f->capacity) {
            size_t new_cap = f->capacity ? f->capacity * 2 : 256;
            while(new_cap < new_pos) new_cap *= 2;
            uint8_t* grown = realloc(f->data, new_cap);
            assert(grown);
            f->data = grown;
            f->capacity = new_cap;
        }
        f->size = new_pos;
        if(s->next_seek_extend_delay_ticks > 0) {
            furi_test_advance_tick(s->next_seek_extend_delay_ticks);
            s->next_seek_extend_delay_ticks = 0;
        }
    }
    f->pos = new_pos;
    return true;
}

uint64_t storage_file_tell(File* file) {
    if(!file || !file->vfile) return 0;
    return file->vfile->pos;
}

// Matches the real API: truncates to the CURRENT position, not to any
// caller-supplied length.
bool storage_file_truncate(File* file) {
    if(!file || !file->vfile) return false;
    file->vfile->size = file->vfile->pos;
    return true;
}

uint64_t storage_file_size(File* file) {
    if(!file || !file->vfile) return 0;
    return file->vfile->size;
}

bool storage_dir_open(File* file, const char* path) {
    Storage* s = file->storage;
    if(s->fail_next_dir_open) {
        s->fail_next_dir_open = false;
        return false;
    }
    strncpy(file->dir_prefix, path, MOCK_PATH_LEN - 1);
    file->dir_prefix[MOCK_PATH_LEN - 1] = '\0';
    file->dir_index = 0;
    file->is_dir = true;
    file->open = true;
    return true;
}

bool storage_dir_close(File* file) {
    file->open = false;
    return true;
}

bool storage_dir_read(File* file, FileInfo* fileinfo, char* name, uint16_t name_length) {
    Storage* s = file->storage;
    size_t prefix_len = strlen(file->dir_prefix);

    for(int i = file->dir_index; i < MOCK_MAX_FILES; i++) {
        MockFile* f = &s->files[i];
        if(!f->used) continue;
        if(strncmp(f->path, file->dir_prefix, prefix_len) != 0) continue;
        if(f->path[prefix_len] != '/') continue;

        const char* basename = f->path + prefix_len + 1;
        // Only direct children — no further '/' after the basename.
        if(strchr(basename, '/') != NULL) continue;

        if(fileinfo) {
            fileinfo->flags = 0;
            fileinfo->size = f->size;
        }
        if(name) {
            strncpy(name, basename, name_length - 1);
            name[name_length - 1] = '\0';
        }
        file->dir_index = i + 1;
        return true;
    }
    return false;
}

size_t storage_file_read(File* file, void* buff, size_t bytes_to_read) {
    if(!file || !file->vfile || !buff) return 0;
    MockFile* f = file->vfile;
    size_t to_copy = (bytes_to_read > f->size) ? f->size : bytes_to_read;
    memcpy(buff, f->data, to_copy);
    return to_copy;
}

bool storage_simply_remove(Storage* storage, const char* path) {
    return storage_common_remove(storage, path);
}

bool storage_common_remove(Storage* storage, const char* path) {
    MockFile* f = find_file(storage, path);
    if(f) {
        free(f->data);
        memset(f, 0, sizeof(MockFile));
        return true;
    }
    return false;
}

bool storage_common_mkdir(Storage* storage, const char* path) {
    (void)storage;
    (void)path;
    return true;
}

FS_Error storage_common_rename(Storage* storage, const char* old_path, const char* new_path) {
    MockFile* f = find_file(storage, old_path);
    if(!f) return FSE_NOT_EXIST;
    storage_common_remove(storage, new_path);
    strncpy(f->path, new_path, MOCK_PATH_LEN - 1);
    f->path[MOCK_PATH_LEN - 1] = '\0';
    return FSE_OK;
}

