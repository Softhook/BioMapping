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
gcc -Wall -Wextra -I . -I modules -I em_scan -I tests/shims -o build/test_gsr_sensor \
    tests/test_gsr_sensor.c modules/gsr_sensor.c \
    tests/shims/furi_hal_mock.c -lm -lpthread
./build/test_gsr_sensor

echo
echo "== test_sd_logger (auto-index / header / batch write) =="
gcc -Wall -Wextra -I . -I modules -I tests/shims -o build/test_sd_logger \
    tests/test_sd_logger.c modules/sd_logger.c \
    tests/shims/storage_mock.c -lm
./build/test_sd_logger

echo
echo "== test_em_scan_cal (EM Scanner RF noise calibration & persistence) =="
gcc -Wall -Wextra -I . -I modules -I tests/shims -o build/test_em_scan_cal \
    tests/test_em_scan_cal.c modules/em_scan_cal.c \
    tests/shims/storage_mock.c -lm
./build/test_em_scan_cal

