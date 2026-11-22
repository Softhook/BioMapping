#!/bin/sh
# gen_compile_commands.sh — regenerate tests/compile_commands.json for IDE
# IntelliSense on the host test files.
#
# ufbt's own .vscode/compile_commands.json only covers the FAP sources (ARM
# toolchain), so without this file every #include in tests/*.c and tests/shims/*.c
# resolves against the real SDK instead of tests/shims/ and the whole file lights
# up red. The compile flags below mirror run_tests.sh exactly.
#
# The output is machine-specific (absolute paths) and git-ignored — run this once
# after cloning, and again if test/shim files are added or run_tests.sh's -I flags
# change. In VSCode afterwards: "C/C++: Reset IntelliSense Database".
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/tests/compile_commands.json"

# each row: <source path relative to firmware/>|<extra flags beyond -I.>
ENTRIES="
tests/test_firmware.c|-Ivendor/minmea
core/biomap_format.c|
tests/test_gps_uart.c|-Iflipper -Ivendor/minmea -Itests/shims
tests/test_gsr_sensor.c|-pthread -Iflipper -Itests/shims
core/gsr_sensor.c|
core/gps_uart.c|
core/biomap_session.c|
core/cal_wizard.c|
tests/test_session.c|-Ivendor/minmea
flipper/gps_uart_flipper.c|-Itests/shims
flipper/gsr_sensor_flipper.c|-pthread -Itests/shims
tests/test_sd_logger.c|-Iflipper -Itests/shims
core/sd_logger.c|
tests/test_sd_blocks.c|-Itests/shims
flipper/sd_logger_flipper.c|-Itests/shims
tests/test_em_scan_cal.c|-Iflipper -Itests/shims
tests/test_em_scan_rf.c|-Iflipper -Itests/shims
tests/test_bt_stream.c|-Iflipper -Itests/shims
tests/test_cues.c|-Itests/shims
flipper/biomap_cues_flipper.c|-Itests/shims
tests/shims/cue_mock.c|-Itests/shims
tests/benchmarks/analyze_gsr_filtering.c|
tests/shims/furi_hal_mock.c|-pthread -Iflipper -Itests/shims
tests/shims/furi_hal_subghz_mock.c|-Iflipper -Itests/shims
tests/shims/storage_mock.c|-Iflipper -Itests/shims
tests/shims/bt_ble_mock.c|-Iflipper -Itests/shims
tests/test_cardputer_rules.c|-Icore -Ivendor/minmea
cardputer/src/clock_rule.c|
cardputer/src/wake_watch.c|
cardputer/src/tick_schedule.c|-Icore
cardputer/src/clock_local.c|-Icore -Ivendor/minmea
"

{
    printf '[\n'
    first=1
    echo "$ENTRIES" | while IFS='|' read -r src extra; do
        [ -z "$src" ] && continue
        [ "$first" = 1 ] && first=0 || printf ',\n'
        args='"/usr/bin/clang", "-std=gnu11", "-D_GNU_SOURCE", "-Wall", "-Wextra", "-I."'
        for f in $extra; do args="$args, \"$f\""; done
        args="$args, \"-c\", \"$src\""
        printf '  {\n    "directory": "%s",\n    "arguments": [%s],\n    "file": "%s/%s"\n  }' \
            "$ROOT" "$args" "$ROOT" "$src"
    done
    printf '\n]\n'
} > "$OUT"

echo "wrote $OUT"
