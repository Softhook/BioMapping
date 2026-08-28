#!/bin/sh
# run_tests.sh — build and run the host-side unit test binaries.
# These compile firmware source files against a host C compiler (not the
# Flipper Zero ARM toolchain). test_gps_uart.c and test_sd_logger.c compile
# the real, unmodified modules/gps_uart.c and modules/sd_logger.c against
# tests/shims/ — a set of headers that fake just enough of the Flipper SDK
# (furi.h, furi_hal.h, expansion/expansion.h, storage/storage.h) for them to
# run on a host compiler, plus the _mock.c files that simulate USART1, I2C,
# and an in-memory filesystem so each test can inject bytes/values/files.
set -eu
cd "$(dirname "$0")"

mkdir -p build

MODE="${RUN_TESTS_MODE:-full}"
RUN_TSAN="${RUN_TESTS_TSAN:-auto}"

while [ "$#" -gt 0 ]; do
    case "$1" in
        --quick)
            MODE="quick"
            ;;
        --full)
            MODE="full"
            ;;
        --tsan)
            RUN_TSAN="yes"
            ;;
        --no-tsan)
            RUN_TSAN="no"
            ;;
        -h|--help)
            cat <<'EOF'
Usage: ./run_tests.sh [--quick|--full] [--tsan|--no-tsan]

Modes:
  --quick   Run fast suite (skips ThreadSanitizer pass)
  --full    Run full suite (default)

TSAN override:
  --tsan    Force TSAN pass on
  --no-tsan Force TSAN pass off

Env alternatives:
  RUN_TESTS_MODE=quick|full
  RUN_TESTS_TSAN=auto|yes|no
EOF
            exit 0
            ;;
        *)
            echo "Unknown option: $1" >&2
            echo "Run ./run_tests.sh --help" >&2
            exit 2
            ;;
    esac
    shift
done

if [ "$RUN_TSAN" = "auto" ]; then
    if [ "$MODE" = "quick" ]; then
        RUN_TSAN="no"
    else
        RUN_TSAN="yes"
    fi
fi

if [ "$MODE" != "quick" ] && [ "$MODE" != "full" ]; then
    echo "Invalid RUN_TESTS_MODE: $MODE (expected quick or full)" >&2
    exit 2
fi

if [ "$RUN_TSAN" != "yes" ] && [ "$RUN_TSAN" != "no" ]; then
    echo "Invalid RUN_TESTS_TSAN: $RUN_TSAN (expected auto, yes, or no)" >&2
    exit 2
fi

echo "== test_firmware (pipeline / CSV / calibration) =="
gcc -Wall -Wextra -I . -I vendor/minmea -o build/test_firmware biomap_pipeline.c tests/test_firmware.c -lm
./build/test_firmware

echo
echo "== test_gps_uart (NMEA dispatch / RX framing) =="
gcc -Wall -Wextra -I . -I modules -I vendor/minmea -I tests/shims -o build/test_gps_uart \
    tests/test_gps_uart.c modules/gps_uart.c \
    tests/shims/furi_hal_mock.c -lm
./build/test_gps_uart

echo
echo "== test_gsr_sensor (autoranging / TIA / disconnect debounce) =="
gcc -Wall -Wextra -I . -I modules -I tests/shims -o build/test_gsr_sensor \
    tests/test_gsr_sensor.c modules/gsr_sensor.c \
    tests/shims/furi_hal_mock.c -lm -lpthread
./build/test_gsr_sensor

echo
if [ "$RUN_TSAN" = "yes" ]; then
    echo "== test_gsr_sensor, ThreadSanitizer pass (mutex/race verification) =="
    # The only test binary with genuine cross-thread concurrency (a real
    # background pthread running gsr_sensor_worker() against the main test
    # thread) — gps_uart.c and sd_logger.c's tests are single-threaded by
    # design (see their own file banners), so a TSAN pass adds nothing there.
    # This isn't a stand-in for the functional assertions above: TSAN doesn't
    # check VALUES are correct, only that no two threads touch the same memory
    # without a synchronization edge between them — exactly the property a
    # passing functional test can satisfy while still hiding a race (as
    # gsr_sensor.c's `running`/`rf_enabled`/`rf_spi_busy` flags did, and as
    # this file's own `furi_test_tick` global did, both found by this exact
    # pass during the 2026-07-30 mutex review and fixed by making them
    # _Atomic). Keep this passing whenever gsr_sensor.c's threading changes.
    gcc -fsanitize=thread -g -O1 -I . -I modules -I tests/shims -o build/test_gsr_sensor_tsan \
        tests/test_gsr_sensor.c modules/gsr_sensor.c \
        tests/shims/furi_hal_mock.c -lm -lpthread
    ./build/test_gsr_sensor_tsan
else
    echo "== skipping ThreadSanitizer pass (RUN_TESTS_TSAN=no) =="
fi

echo
echo "== test_sd_logger (auto-index / header / batch write) =="
gcc -Wall -Wextra -I . -I modules -I tests/shims -o build/test_sd_logger \
    tests/test_sd_logger.c modules/sd_logger.c \
    tests/shims/storage_mock.c -lm
./build/test_sd_logger

echo
echo "== test_sd_logger_prealloc (experimental: rolling chunk pre-allocation, docs/gps_rf_mutex_status.md option E) =="
gcc -Wall -Wextra -I . -I tests/shims -o build/test_sd_logger_prealloc \
    tests/test_sd_logger_prealloc.c \
    tests/shims/storage_mock.c -lm
./build/test_sd_logger_prealloc

echo
echo "== test_em_scan_cal (EM Scanner RF noise calibration & persistence) =="
gcc -Wall -Wextra -I . -I modules -I tests/shims -o build/test_em_scan_cal \
    tests/test_em_scan_cal.c modules/em_scan_cal.c \
    tests/shims/storage_mock.c -lm
./build/test_em_scan_cal

echo
echo "== test_bt_stream (BLE serial profile lifecycle / send-or-drop logic) =="
gcc -Wall -Wextra -I . -I modules -I tests/shims -o build/test_bt_stream \
    tests/test_bt_stream.c modules/bt_stream.c \
    tests/shims/bt_ble_mock.c -lm
./build/test_bt_stream

