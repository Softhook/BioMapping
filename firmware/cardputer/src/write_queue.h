#pragma once

// A first-in, first-out queue of bytes on the way to the SD card
// (sd_cardputer.cpp). The main loop puts bytes in; the card-writing task
// takes them out in the same order. Plain C, host-tested; the caller does
// the locking.
//
// The writing task writes straight from the queue's memory: write_queue_peek()
// gives it the oldest bytes that sit in one piece, and write_queue_drop()
// frees them once they're on the card. write_queue_put() only ever copies
// into free space, so it never touches bytes still being written.

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    uint8_t* buf;
    size_t   size;
    size_t   head;   // where the oldest byte is
    size_t   count;  // how many bytes are waiting
} WriteQueue;

void write_queue_init(WriteQueue* q, uint8_t* buf, size_t size);

// Copies as much of `data` as fits; returns how many bytes it took.
size_t write_queue_put(WriteQueue* q, const void* data, size_t len);

// The oldest waiting bytes that sit in one piece: sets *out to them and
// returns how many (0 when the queue is empty). Past the end of the
// memory the rest comes from the start, on the next peek.
size_t write_queue_peek(const WriteQueue* q, const uint8_t** out);

// Frees the oldest `n` bytes (no more than are waiting).
void write_queue_drop(WriteQueue* q, size_t n);

void write_queue_clear(WriteQueue* q);

#ifdef __cplusplus
}
#endif
