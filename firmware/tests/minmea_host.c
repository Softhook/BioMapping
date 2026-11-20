// minmea built on its own for the host checks in run_tests.sh. minmea.c
// defines its own static timegm() (the Flipper's C library has none), which
// clashes with the host's declaration of it, so it is renamed after the
// system headers are in — the same workaround test_firmware.c and
// test_gps_uart.c use.
#include "minmea.h"
#define timegm minmea_timegm
#include "minmea.c"
