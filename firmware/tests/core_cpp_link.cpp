// core_cpp_link.cpp — the Cardputer's Arduino code is C++, so every core/
// header must be readable as C++ and its functions linkable from it (the
// extern "C" wrapper). run_tests.sh builds this against the C-compiled
// core/ files; it only has to link, not run anything.

#include "core/biomap_config.h"
#include "core/biomap_types.h"
#include "core/biomap_pipeline.h"
#include "core/biomap_format.h"
#include "core/gsr_sensor.h"
#include "core/gps_uart.h"
#include "core/biomap_cues.h"
#include "core/core_check.h"
#include "core/biomap_session.h"

#include <cstdio>
#include <cstdlib>

void core_fatal(const char* msg) {
    std::fprintf(stderr, "core_fatal: %s\n", msg);
    std::abort();
}

int main() {
    // One function from each header, called for real so the linker must
    // find it under its C name.
    char stamp[32];
    int n = biomap_format_file_stamp(stamp, sizeof(stamp), 2026, 11, 20, 12, 0, 0);
    CalDwell d;
    cal_dwell_init(&d);
    cal_dwell_add(&d, 1.0f, 0.0f, 2.0f);
    Pipeline p = {};
    pipeline_rescale_graph(&p, true);
    volatile bool keep = gsr_sensor_available(nullptr);
    void (*sleep_fn)(const GpsPlatform*) = gps_uart_sleep_from_unknown_state;
    keep = keep || sleep_fn == nullptr;
    keep = keep || BioMapCueCount == 0;
    bool (*tick_fn)(SessionCore*) = session_core_tick;
    keep = keep || tick_fn == nullptr || session_mode_records(BioMapModeLiveStream);
    std::printf("C++ link ok (%d, %d, %d)\n", n, d.in_gate, (int)keep);
    return 0;
}
