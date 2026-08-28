#pragma once

// furi_ble/profile_interface.h — host-test shim. Real path:
// lib/furi_ble/profile_interface.h. Fakes just the two opaque profile types
// bt.h and serial_profile.h reference — the real gap.h/GapConfig surface
// isn't touched by anything modules/bt_stream.c calls, so GapConfig stays a
// forward-declared opaque type here rather than a real definition.

#include <stdbool.h>
#include <stdint.h>

typedef struct GapConfig GapConfig;

typedef struct FuriHalBleProfileTemplate FuriHalBleProfileTemplate;

/* Actual profiles must inherit (include this structure) as their first field */
typedef struct {
    const FuriHalBleProfileTemplate* config;
} FuriHalBleProfileBase;

typedef void* FuriHalBleProfileParams;

typedef FuriHalBleProfileBase* (*FuriHalBleProfileStart)(FuriHalBleProfileParams profile_params);
typedef void (*FuriHalBleProfileStop)(FuriHalBleProfileBase* profile);
typedef void (*FuriHalBleProfileGetGapConfig)(
    GapConfig* target_config,
    FuriHalBleProfileParams profile_params);

struct FuriHalBleProfileTemplate {
    FuriHalBleProfileStart start;
    FuriHalBleProfileStop stop;
    FuriHalBleProfileGetGapConfig get_gap_config;
};
