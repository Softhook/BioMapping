#!/bin/sh
# run_tests.sh — build and run the host-side unit test binaries.
# These compile firmware source files against a host C compiler (not the
# Flipper Zero ARM toolchain). test_gps_uart.c compiles the real,
# unmodified modules/gps_uart.c against tests/shims/ — a set of headers
# that fake just enough of the Flipper SDK (furi.h, furi_hal.h,
# expansion/expansion.h) for it to run on a host compiler, plus
# furi_hal_mock.c which simulates USART1 so the test can inject bytes.
set -eu
cd "$(dirname "$0")"

mkdir -p build

echo "== test_firmware (pipeline / CSV / calibration) =="
gcc -Wall -Wextra -I . -o build/test_firmware biomap_pipeline.c tests/test_firmware.c -lm
./build/test_firmware

echo
echo "== test_gps_uart (NMEA dispatch / RX framing) =="
gcc -Wall -Wextra -I . -I modules -I tests/shims -o build/test_gps_uart \
    tests/test_gps_uart.c modules/gps_uart.c \
    tests/shims/furi_hal_mock.c -lm
./build/test_gps_uart

echo
echo "== test_gsr_sensor (autoranging / TIA / disconnect debounce) =="
gcc -Wall -Wextra -I . -I modules -I tests/shims -o build/test_gsr_sensor \
    tests/test_gsr_sensor.c modules/gsr_sensor.c \
    tests/shims/furi_hal_mock.c -lm -lpthread
./build/test_gsr_sensor
