"""PlatformIO build step (extra_scripts in platformio.ini).

Passes the Cardputer firmware's version (custom_firmware_version in
platformio.ini) and the exact build (../build_rev.py) to this project's
own code, for the "# Firmware" line at the top of every recording. Only
our code gets them (projenv), so a new commit doesn't rebuild the M5Stack
and Arduino libraries.
"""

import os
import sys

Import("env", "projenv")  # noqa: F821  (provided by PlatformIO)

sys.path.insert(0, os.path.join(env["PROJECT_DIR"], ".."))  # noqa: F821
import build_rev  # noqa: E402

version = env.GetProjectOption("custom_firmware_version")  # noqa: F821
rev = build_rev.git_rev(["core", "vendor", "cardputer/src", "cardputer/platformio.ini"])

projenv.Append(  # noqa: F821
    CPPDEFINES=[
        ("CARDPUTER_FIRMWARE_VERSION", env.StringifyMacro(version)),  # noqa: F821
        ("BIOMAP_GIT_REV", env.StringifyMacro(rev)),  # noqa: F821
    ]
)
print("Cardputer firmware %s (%s)" % (version, rev))
