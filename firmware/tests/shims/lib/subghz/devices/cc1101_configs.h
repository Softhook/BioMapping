#pragma once

// lib/subghz/devices/cc1101_configs.h — host-test shim.
//
// modules/em_scan_rf.c loads exactly one preset,
// subghz_device_cc1101_preset_ook_650khz_async_regs, by pointer — it never
// reads the register bytes themselves, so the fake array's contents don't
// matter, only that the symbol exists and its address is stable (see
// furi_hal_subghz_mock_last_preset() in furi_hal_subghz.h).

#include <stdint.h>

extern const uint8_t subghz_device_cc1101_preset_ook_650khz_async_regs[];
