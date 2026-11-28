#pragma once

// SD logger on the Flipper: the shared logger (core/sd_logger.h) writing
// to /ext/biomapping/ through the Flipper's storage service.

#include <storage/storage.h>

#include "core/sd_logger.h"

SdLogger* sd_logger_alloc(Storage* storage);
void      sd_logger_free(SdLogger* logger);
