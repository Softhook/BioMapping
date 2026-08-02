#pragma once

// furi.h — host-test shim.
//
// gps_uart.c and gsr_sensor.c call the real Flipper SDK directly
// (furi_hal_serial_*, furi_hal_i2c_*, furi_mutex_*, furi_thread_*,
// furi_stream_buffer_*, furi_message_queue_put, furi_get_tick, FURI_LOG_*,
// ...) — unmodified from what ships in the Flipper build. This shim (plus
// furi_hal.h and expansion/expansion.h in this directory) fakes just
// enough of that surface to let them run for real on a host compiler.
// Not a general Furi replacement — only what these drivers currently
// call.
//
// FuriMutex and FuriThread are backed by real pthreads: gsr_sensor.c runs
// its ADC-polling loop on a genuine background FuriThread, and
// tests/test_gsr_sensor.c drives it concurrently with the main test
// thread — a single-threaded fake mutex would be an actual data race in
// the test itself, not just an inaccurate simulation.
//
// Included via -I tests/shims placed ahead of the real SDK on the include
// path; never linked into the Flipper build (application.fam doesn't see
// this directory).

#include <sched.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <assert.h>
#include <pthread.h>

#define UNUSED(x) ((void)(x))

#ifndef COUNT_OF
#define COUNT_OF(x) (sizeof(x) / sizeof((x)[0]))
#endif

#define furi_assert(x) assert(x)

// furi_check() is variadic in the real SDK: furi_check(cond) or
// furi_check(cond, "message"). Unlike furi_assert, it's unconditional in
// every build (no FURI_NDEBUG gating) — the host shim just maps both call
// forms to a real assert() so a failed check still aborts the test binary.
#define FURI_CHECK_GET_MACRO(_1, _2, NAME, ...) NAME
#define furi_check(...) \
    FURI_CHECK_GET_MACRO(__VA_ARGS__, furi_check2, furi_check1)(__VA_ARGS__)
#define furi_check1(cond)      assert(cond)
#define furi_check2(cond, msg) assert(cond)

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

// A complete no-op (not even a thread yield) let gsr_sensor_set_rf_enabled()'s
// disable-path poll loop (a while(rf_spi_busy && ...) { furi_delay_ms(1); })
// turn into a genuine CPU-hogging tight spin under this harness: the fake
// tick this loop bounds its timeout against never advances on its own, so
// with no real yield, one thread can spin flat-out checking a flag the
// OTHER thread needs CPU time to clear — a real, ThreadSanitizer-run-
// observed slow/stuck case (2026-07-30), not just a theoretical concern.
// sched_yield() fixes that by actually giving the scheduler a chance to
// run the other thread, while still completing far faster than any real
// `ms` duration — every other test's "the worker spins as fast as the CPU
// allows" assumption is unaffected, since this returns almost immediately
// regardless of `ms`. On real hardware furi_delay_ms() already properly
// yields via the RTOS, so this only brings the shim in line with it.
static inline void furi_delay_ms(uint32_t ms) { (void)ms; sched_yield(); }

// ── Record registry — gps_uart.c opens/closes RECORD_EXPANSION around
// USART1 ownership. The mechanism has no effect on NMEA parsing.
#define RECORD_EXPANSION "expansion"
static inline void* furi_record_open(const char* name) { (void)name; return (void*)1; }
static inline void furi_record_close(const char* name) { (void)name; }

// ── Tick ─────────────────────────────────────────────────────────────
// Test-controllable so watchdog/timeout logic can be exercised without
// wall-clock sleeps. Starts at 1 (0 has watchdog-disarmed meaning in
// gps_uart.c) and advances only via furi_test_advance_tick().
//
// _Atomic, not plain uint32_t: gsr_sensor.c's worker thread calls
// furi_get_tick() (reading this) concurrently with the test's own thread
// calling furi_test_advance_tick() (writing it) — a real, ThreadSanitizer-
// confirmed data race as a plain global (found during the 2026-07-30
// mutex work's TSAN run, alongside the same fix applied to gsr_sensor.c's
// own volatile flags). On real hardware furi_get_tick() reads an
// RTOS-maintained counter with its own defined atomicity; this shim's
// plain-global stand-in needs to be explicitly atomic to match that.
extern _Atomic uint32_t furi_test_tick;
static inline uint32_t furi_get_tick(void) { return furi_test_tick; }
static inline uint32_t furi_kernel_get_tick_frequency(void) { return 1000; }
static inline void furi_test_advance_tick(uint32_t delta) { furi_test_tick += delta; }

// ── Mutex — real pthread mutex. gps_uart.c's tests are single-threaded so
// this is just uncontended overhead there; gsr_sensor.c's worker thread
// makes it load-bearing. Timeout is ignored — every real caller passes
// FuriWaitForever, and a real pthread mutex can't deadlock a host test
// the way a stuck ISR could hang real hardware.
typedef struct FuriMutex { pthread_mutex_t m; } FuriMutex;
typedef enum { FuriMutexTypeNormal } FuriMutexType;

static inline FuriMutex* furi_mutex_alloc(FuriMutexType type) {
    (void)type;
    FuriMutex* m = malloc(sizeof(FuriMutex));
    assert(m);
    pthread_mutex_init(&m->m, NULL);
    return m;
}
static inline void furi_mutex_free(FuriMutex* m) {
    pthread_mutex_destroy(&m->m);
    free(m);
}
static inline FuriStatus furi_mutex_acquire(FuriMutex* m, uint32_t timeout) {
    (void)timeout;
    pthread_mutex_lock(&m->m);
    return FuriStatusOk;
}
static inline FuriStatus furi_mutex_release(FuriMutex* m) {
    pthread_mutex_unlock(&m->m);
    return FuriStatusOk;
}

// ── Thread — real pthread. gsr_sensor.c owns a background FuriThread that
// polls I2C continuously; faking it as a no-op would mean the "worker"
// never runs and gsr_sensor_tick() would only ever see the initial
// warm-up buffer contents, testing nothing.
typedef int32_t (*FuriThreadCallback)(void* context);

typedef struct FuriThread {
    pthread_t          pthread;
    FuriThreadCallback callback;
    void*              context;
    bool                started;
} FuriThread;

static inline void* furi_thread_pthread_trampoline(void* arg) {
    FuriThread* t = arg;
    t->callback(t->context);
    return NULL;
}

static inline FuriThread* furi_thread_alloc(void) {
    FuriThread* t = malloc(sizeof(FuriThread));
    assert(t);
    t->callback = NULL;
    t->context  = NULL;
    t->started  = false;
    return t;
}
static inline void furi_thread_set_name(FuriThread* t, const char* name) { (void)t; (void)name; }
static inline void furi_thread_set_stack_size(FuriThread* t, size_t size) { (void)t; (void)size; }
static inline void furi_thread_set_context(FuriThread* t, void* context) { t->context = context; }
static inline void furi_thread_set_callback(FuriThread* t, FuriThreadCallback cb) { t->callback = cb; }
static inline void furi_thread_start(FuriThread* t) {
    t->started = true;
    int rc = pthread_create(&t->pthread, NULL, furi_thread_pthread_trampoline, t);
    assert(rc == 0);
}
static inline bool furi_thread_join(FuriThread* t) {
    if(t->started) pthread_join(t->pthread, NULL);
    return true;
}
static inline void furi_thread_free(FuriThread* t) { free(t); }
// Real Furi distinguishes FuriThread* (the wrapper struct) from
// FuriThreadId (the underlying RTOS handle, obtained via
// furi_thread_get_id()) — gsr_sensor.c calls both, so the shim needs both
// names to exist even though this host stub doesn't model two distinct
// handles.
typedef void* FuriThreadId;
static inline FuriThreadId furi_thread_get_id(FuriThread* t) { return (FuriThreadId)t; }
// Stub only: host pthreads aren't watermarked like FreeRTOS task stacks, so
// this can't return a meaningful value — it exists purely so gsr_sensor.c's
// (real, unmodified) stack-space getter still links on the host.
static inline size_t furi_thread_get_stack_space(FuriThreadId id) { (void)id; return 0; }

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
