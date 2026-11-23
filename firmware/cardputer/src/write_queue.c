#include "write_queue.h"

#include <string.h>

void write_queue_init(WriteQueue* q, uint8_t* buf, size_t size) {
    q->buf = buf;
    q->size = size;
    q->head = 0;
    q->count = 0;
}

size_t write_queue_put(WriteQueue* q, const void* data, size_t len) {
    size_t space = q->size - q->count;
    if(len > space) len = space;
    const uint8_t* src = (const uint8_t*)data;
    size_t tail = (q->head + q->count) % q->size;
    size_t first = q->size - tail;  // room before the end of the memory
    if(first > len) first = len;
    memcpy(q->buf + tail, src, first);
    memcpy(q->buf, src + first, len - first);
    q->count += len;
    return len;
}

size_t write_queue_peek(const WriteQueue* q, const uint8_t** out) {
    size_t n = q->size - q->head;
    if(n > q->count) n = q->count;
    *out = q->buf + q->head;
    return n;
}

void write_queue_drop(WriteQueue* q, size_t n) {
    if(n > q->count) n = q->count;
    q->head = (q->head + n) % q->size;
    q->count -= n;
}

void write_queue_clear(WriteQueue* q) {
    q->head = 0;
    q->count = 0;
}
