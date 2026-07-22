#pragma once

// furi.h — host-test shim.
//
// gps_uart.c calls the real Flipper SDK directly (furi_hal_serial_*,
// furi_mutex_*, furi_stream_buffer_*, furi_message_queue_put,
// furi_get_tick, FURI_LOG_*, ...) — unmodified from what ships in the
// Flipper build. This shim (plus furi_hal.h and expansion/expansion.h in
// this directory) fakes just enough of that surface to let it run for
// real on a host compiler in tests/test_gps_uart.c. Not a general Furi
// replacement — only what gps_uart.c currently calls.
//
// Included via -I tests/shims placed ahead of the real SDK on the include
// path; never linked into the Flipper build (application.fam doesn't see
// this directory).

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <assert.h>

#define UNUSED(x) ((void)(x))

#define furi_assert(x) assert(x)

#define FURI_LOG_D(tag, fmt, ...) ((void)0)
#define FURI_LOG_I(tag, fmt, ...) ((void)0)
#define FURI_LOG_W(tag, fmt, ...) ((void)0)
#define FURI_LOG_E(tag, fmt, ...) ((void)0)

#define FuriWaitForever 0xFFFFFFFFu

// Real values from furi/core/base.h — several furi_* calls below return
// this and gps_uart.c always discards it, but keep the type real rather
// than substituting int/void, in case future code ever does check it.
typedef enum {
    FuriStatusOk = 0,
    FuriStatusError = -1,
    FuriStatusErrorTimeout = -2,
    FuriStatusErrorResource = -3,
    FuriStatusErrorParameter = -4,
    FuriStatusErrorNoMemory = -5,
    FuriStatusErrorISR = -6,
} FuriStatus;

static inline void furi_delay_ms(uint32_t ms) { (void)ms; }

// ── Record registry — gps_uart.c opens/closes RECORD_EXPANSION around
// USART1 ownership. The mechanism has no effect on NMEA parsing.
#define RECORD_EXPANSION "expansion"
static inline void* furi_record_open(const char* name) { (void)name; return (void*)1; }
static inline void furi_record_close(const char* name) { (void)name; }

// ── Tick ─────────────────────────────────────────────────────────────
// Test-controllable so watchdog/timeout logic can be exercised without
// wall-clock sleeps. Starts at 1 (0 has watchdog-disarmed meaning in
// gps_uart.c) and advances only via furi_test_advance_tick().
extern uint32_t furi_test_tick;
static inline uint32_t furi_get_tick(void) { return furi_test_tick; }
static inline uint32_t furi_kernel_get_tick_frequency(void) { return 1000; }
static inline void furi_test_advance_tick(uint32_t delta) { furi_test_tick += delta; }

// ── Mutex — single-threaded host tests, so a real lock isn't needed ────
typedef struct FuriMutex { int locked; } FuriMutex;
typedef enum { FuriMutexTypeNormal } FuriMutexType;

static inline FuriMutex* furi_mutex_alloc(FuriMutexType type) {
    (void)type;
    FuriMutex* m = malloc(sizeof(FuriMutex));
    assert(m);
    m->locked = 0;
    return m;
}
static inline void furi_mutex_free(FuriMutex* m) { free(m); }
static inline FuriStatus furi_mutex_acquire(FuriMutex* m, uint32_t timeout) {
    (void)timeout;
    m->locked = 1;
    return FuriStatusOk;
}
static inline FuriStatus furi_mutex_release(FuriMutex* m) {
    m->locked = 0;
    return FuriStatusOk;
}

// ── Stream buffer — real ring buffer; gps_uart.c's RX drain logic       ──
// depends on genuine partial-read/write semantics, not just a stub.
typedef struct FuriStreamBuffer {
    uint8_t* buf;
    size_t   capacity;
    size_t   head;   // next write position
    size_t   tail;   // next read position
    size_t   count;  // bytes currently buffered
} FuriStreamBuffer;

static inline FuriStreamBuffer* furi_stream_buffer_alloc(size_t size, size_t trigger_level) {
    (void)trigger_level;
    FuriStreamBuffer* sb = malloc(sizeof(FuriStreamBuffer));
    assert(sb);
    sb->buf = malloc(size);
    assert(sb->buf);
    sb->capacity = size;
    sb->head = sb->tail = sb->count = 0;
    return sb;
}
static inline void furi_stream_buffer_free(FuriStreamBuffer* sb) {
    free(sb->buf);
    free(sb);
}
static inline FuriStatus furi_stream_buffer_reset(FuriStreamBuffer* sb) {
    sb->head = sb->tail = sb->count = 0;
    return FuriStatusOk;
}
static inline size_t furi_stream_buffer_send(
    FuriStreamBuffer* sb, const void* data, size_t len, uint32_t timeout) {
    (void)timeout;
    const uint8_t* p = data;
    size_t written = 0;
    while(written < len && sb->count < sb->capacity) {
        sb->buf[sb->head] = p[written];
        sb->head = (sb->head + 1) % sb->capacity;
        sb->count++;
        written++;
    }
    return written;
}
static inline size_t furi_stream_buffer_receive(
    FuriStreamBuffer* sb, void* data, size_t len, uint32_t timeout) {
    (void)timeout;
    uint8_t* p = data;
    size_t read = 0;
    while(read < len && sb->count > 0) {
        p[read] = sb->buf[sb->tail];
        sb->tail = (sb->tail + 1) % sb->capacity;
        sb->count--;
        read++;
    }
    return read;
}

// ── Message queue — gps_uart.c only ever posts and discards the result ─
typedef struct FuriMessageQueue { int put_count; } FuriMessageQueue;

static inline FuriStatus furi_message_queue_put(FuriMessageQueue* q, const void* msg, uint32_t timeout) {
    (void)msg;
    (void)timeout;
    if(q) q->put_count++;
    return FuriStatusOk;
}
