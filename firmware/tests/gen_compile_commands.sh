#!/bin/sh
# gen_compile_commands.sh — regenerate tests/compile_commands.json for IDE
# IntelliSense on the host test files.
#
# ufbt's own .vscode/compile_commands.json only covers the FAP sources (ARM
# toolchain), so without this file every #include in tests/*.c and tests/shims/*.c
# resolves against the real SDK instead of tests/shims/ and the whole file lights
# up red. The list below has every file run_tests.sh builds, grouped by the
# test that builds it, with that build's -I flags, plus the benchmarks in
# tests/benchmarks/.
#
# The output is machine-specific (absolute paths) and git-ignored — run this once
# after cloning, and again whenever run_tests.sh starts building another file
# (add it to the list below first) or its -I flags change. In VSCode
# afterwards: "C/C++: Reset IntelliSense Database".
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/tests/compile_commands.json"

# each row: <source path relative to firmware/>|<extra flags beyond -I.>
ENTRIES="
tests/test_firmware.c|-Ivendor/minmea
core/biomap_pipeline.c|
core/biomap_format.c|

tests/test_session.c|-Ivendor/minmea
core/biomap_session.c|
core/cal_wizard.c|
core/biomap_screen.c|
core/gsr_sensor.c|
core/gps_uart.c|
tests/minmea_host.c|-Ivendor/minmea

tests/core_cpp_link.cpp|

tests/test_gps_uart.c|-Iflipper -Ivendor/minmea -Itests/shims
flipper/gps_uart_flipper.c|-Itests/shims
flipper/core_fatal.c|-Itests/shims
tests/shims/furi_hal_mock.c|-pthread -Iflipper -Itests/shims

tests/test_gsr_sensor.c|-pthread -Iflipper -Itests/shims
flipper/gsr_sensor_flipper.c|-pthread -Itests/shims
flipper/em_scan_sampler.c|-pthread -Iflipper -Itests/shims

tests/test_sd_logger.c|-Iflipper -Itests/shims
core/sd_logger.c|
flipper/sd_logger_flipper.c|-Itests/shims
tests/shims/storage_mock.c|-Iflipper -Itests/shims

tests/test_sd_blocks.c|-Itests/shims

tests/test_em_scan_cal.c|-Iflipper -Itests/shims
flipper/em_scan_cal.c|-Iflipper -Itests/shims

tests/test_em_scan_rf.c|-Iflipper -Itests/shims
flipper/em_scan_rf.c|-Iflipper -Itests/shims
tests/shims/furi_hal_subghz_mock.c|-Iflipper -Itests/shims

tests/test_cues.c|-Itests/shims
flipper/biomap_cues_flipper.c|-Itests/shims
tests/shims/cue_mock.c|-Itests/shims

tests/test_cardputer_rules.c|-Icore -Ivendor/minmea
cardputer/src/clock_rule.c|
cardputer/src/wake_watch.c|
cardputer/src/tick_schedule.c|-Icore
cardputer/src/clock_local.c|-Icore -Ivendor/minmea
cardputer/src/wifi_files_rules.c|
cardputer/src/zip_stream.c|
cardputer/src/splash_anim.c|

tests/test_bt_stream.c|-Iflipper -Itests/shims
flipper/bt_stream.c|-Iflipper -Itests/shims
tests/shims/bt_ble_mock.c|-Iflipper -Itests/shims

tests/benchmarks/analyze_gsr_filtering.c|
tests/benchmarks/benchmark_graph.c|
tests/benchmarks/gsr_hum_sim.c|-Icore
"

{
    printf '[\n'
    first=1
    echo "$ENTRIES" | while IFS='|' read -r src extra; do
        [ -z "$src" ] && continue
        [ "$first" = 1 ] && first=0 || printf ',\n'
        case "$src" in
            *.cpp) args='"/usr/bin/clang++", "-std=c++17", "-Wall", "-Wextra", "-I."' ;;
            *)     args='"/usr/bin/clang", "-std=gnu11", "-D_GNU_SOURCE", "-Wall", "-Wextra", "-I."' ;;
        esac
        for f in $extra; do args="$args, \"$f\""; done
        args="$args, \"-c\", \"$src\""
        printf '  {\n    "directory": "%s",\n    "arguments": [%s],\n    "file": "%s/%s"\n  }' \
            "$ROOT" "$args" "$ROOT" "$src"
    done
    printf '\n]\n'
} > "$OUT"

echo "wrote $OUT"
